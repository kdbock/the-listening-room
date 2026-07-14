import http from "node:http";
import { Buffer } from "node:buffer";
import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

const port = Number(process.env.PORT || 8080);
const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || "";
const bucketName = process.env.FIREBASE_STORAGE_BUCKET || process.env.STORAGE_BUCKET || "";
const adminClientEmail = process.env.FIREBASE_CLIENT_EMAIL || "";
const adminPrivateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n") || "";
const openAiApiKey = process.env.OPENAI_API_KEY || "";
const openAiSpeechModel = process.env.OPENAI_SPEECH_MODEL || "gpt-4o-mini-tts";

function nowIso() {
  return new Date().toISOString();
}

function json(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body, null, 2));
}

function initFirebaseAdmin() {
  if (adminClientEmail && adminPrivateKey && projectId) {
    return initializeApp({
      credential: cert({
        projectId,
        clientEmail: adminClientEmail,
        privateKey: adminPrivateKey,
      }),
      storageBucket: bucketName || undefined,
    });
  }

  return initializeApp({
    credential: applicationDefault(),
    storageBucket: bucketName || undefined,
  });
}

initFirebaseAdmin();

const db = getFirestore();
const storage = getStorage();

async function reserveNextQueuedJob() {
  let snapshot;
  try {
    snapshot = await db
      .collection("render_jobs")
      .where("status", "==", "queued")
      .limit(5)
      .get();
  } catch (error) {
    throw new Error(`Could not read queued render jobs: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const doc of snapshot.docs) {
    const claimed = await db.runTransaction(async (transaction) => {
      const fresh = await transaction.get(doc.ref);
      if (!fresh.exists) return null;
      const data = fresh.data();
      if (!data || data.status !== "queued") return null;
      if (data.render_target !== "cloud_run") return null;

      transaction.update(doc.ref, {
        status: "processing",
        started_at: nowIso(),
        updated_at: nowIso(),
      });

      return {
        id: fresh.id,
        ...data,
        status: "processing",
      };
    });

    if (claimed) return claimed;
  }

  return null;
}

async function loadSceneBundle(job) {
  let sceneDoc;
  let bookDoc;

  try {
    [sceneDoc, bookDoc] = await Promise.all([
      db.collection("scenes").doc(job.scene_id).get(),
      db.collection("books").doc(job.book_id).get(),
    ]);
  } catch (error) {
    throw new Error(`Could not load Firestore scene/book records: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!sceneDoc.exists) {
    throw new Error(`Scene ${job.scene_id} was not found.`);
  }

  if (!bookDoc.exists) {
    throw new Error(`Book ${job.book_id} was not found.`);
  }

  return {
    scene: { id: sceneDoc.id, ...sceneDoc.data() },
    book: { id: bookDoc.id, ...bookDoc.data() },
  };
}

async function renderScenePackage({ job, scene, book }) {
  if (!bucketName) {
    throw new Error("FIREBASE_STORAGE_BUCKET or STORAGE_BUCKET is required.");
  }

  const artifactBase = `renders/${book.id}/${scene.id}/${job.id}`;
  const artifact = {
    generated_at: nowIso(),
    worker: "cloud-run-render-worker",
    status: openAiApiKey ? "narration_preview_audio" : "placeholder_render_package",
    note: openAiApiKey
      ? "This is the first playable render milestone: narration-only scene audio from the approved narration choice. Character-by-character dialogue rendering comes next."
      : "This package proves the render queue and worker wiring. Add OPENAI_API_KEY to Cloud Run to generate a playable narration preview next.",
    book: {
      id: book.id,
      title: book.title,
    },
    scene: {
      id: scene.id,
      title: scene.title,
      estimated_minutes: scene.estimated_minutes,
      narrator: scene.narrator || "",
      narrator_voice_id: scene.narrator_voice_id || "",
      voice_notes: scene.voice_notes || "",
      speakers: scene.speakers || [],
      sfx_cues: scene.sfx_cues || [],
      ambience_cues: scene.ambience_cues || [],
      text: scene.text || "",
    },
    render_job: {
      id: job.id,
      requested_at: job.requested_at,
    },
  };

  let outputPath = `${artifactBase}/render-plan.json`;

  if (openAiApiKey) {
    const narrationText = String(scene.text || "").trim();
    if (!narrationText) {
      throw new Error("The scene text is empty, so no narration audio can be generated.");
    }

    const audioPath = `${artifactBase}/narration-preview.wav`;
    const chunks = chunkNarrationText(narrationText);
    const wavBuffers = [];
    for (const chunk of chunks) {
      wavBuffers.push(await synthesizeNarrationChunk(chunk, scene));
    }
    const mergedWav = mergeWavBuffers(wavBuffers);
    try {
      await storage.bucket(bucketName).file(audioPath).save(mergedWav, {
        contentType: "audio/wav",
      });
    } catch (error) {
      throw new Error(`Could not write narration preview to Storage: ${error instanceof Error ? error.message : String(error)}`);
    }
    artifact.audio_preview_path = audioPath;
    artifact.audio_preview_chunks = chunks.length;
    outputPath = audioPath;
  }

  try {
    await storage.bucket(bucketName).file(`${artifactBase}/render-plan.json`).save(
      JSON.stringify(artifact, null, 2),
      { contentType: "application/json; charset=utf-8" },
    );
  } catch (error) {
    throw new Error(`Could not write render artifact to Storage: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { outputPath };
}

function chunkNarrationText(text) {
  const paragraphs = text
    .split(/\n\s*\n+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const chunks = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > 3800 && current) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [text.slice(0, 3800)];
}

function chooseNarrationVoice(scene) {
  const voiceDirections = {
    marin: "Warm, intimate, steady, emotionally intelligent, and restrained.",
    cedar: "Grounded, warm, measured, trustworthy, and never theatrical.",
    coral: "Clear, expressive, conversational, and emotionally present.",
    sage: "Calm, thoughtful, balanced, and quietly confident.",
    ballad: "Reflective, resonant, lyrical, and grounded.",
    onyx: "Deep, assured, restrained, and emotionally grounded.",
    shimmer: "Bright, gentle, emotionally open, and natural.",
    verse: "Direct, present, versatile, and natural.",
    alloy: "Neutral, polished, adaptable, and unhurried.",
    ash: "Steady, clear, understated, and intimate.",
    echo: "Smooth, measured, focused, and restrained.",
    fable: "Animated, warm, story-forward, but never exaggerated.",
    nova: "Energetic, crisp, contemporary, and emotionally aware.",
  };
  const selectedVoice = String(scene.narrator_voice_id || "").toLowerCase();
  if (voiceDirections[selectedVoice]) {
    return { voice: selectedVoice, instructions: voiceDirections[selectedVoice] };
  }

  // Preserve older scenes that stored a demographic label instead of a voice ID.
  const label = String(scene.narrator || "").toLowerCase();
  if (label.includes("older woman")) return { voice: "ballad", instructions: "Older adult feminine narrator. Warm, reflective, steady, emotionally grounded." };
  if (label.includes("older man")) return { voice: "onyx", instructions: "Older adult masculine narrator. Calm, grounded, reflective, never theatrical." };
  if (label.includes("younger woman")) return { voice: "shimmer", instructions: "Younger adult feminine narrator. Clear, warm, emotionally present, not childish." };
  if (label.includes("younger man")) return { voice: "verse", instructions: "Younger adult masculine narrator. Clear, natural, emotionally present, not boyish." };
  if (label.includes("warm adult man")) return { voice: "cedar", instructions: "Adult masculine narrator. Warm, intimate, steady, trustworthy, restrained." };
  return { voice: "marin", instructions: "Adult feminine narrator. Warm, intimate, steady, emotionally intelligent, restrained." };
}

async function synthesizeNarrationChunk(text, scene) {
  const voiceChoice = chooseNarrationVoice(scene);
  const instructionParts = [voiceChoice.instructions];
  if (scene.voice_notes) {
    instructionParts.push(String(scene.voice_notes));
  }

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openAiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: openAiSpeechModel,
      input: text,
      voice: voiceChoice.voice,
      instructions: instructionParts.join(" ").trim(),
      response_format: "wav",
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI speech generation failed: ${response.status} ${body}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function parseWav(buffer) {
  const riff = buffer.toString("ascii", 0, 4);
  const wave = buffer.toString("ascii", 8, 12);
  if (riff !== "RIFF" || wave !== "WAVE") {
    throw new Error("OpenAI did not return a WAV file in the expected format.");
  }

  let offset = 12;
  let fmt;
  let data;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkId === "fmt ") {
      fmt = buffer.subarray(chunkStart, chunkEnd);
    }
    if (chunkId === "data") {
      data = buffer.subarray(chunkStart, chunkEnd);
    }
    offset = chunkEnd + (chunkSize % 2);
  }

  if (!fmt || !data) {
    throw new Error("The WAV response is missing fmt or data chunks.");
  }

  return { fmt, data };
}

function mergeWavBuffers(buffers) {
  const parsed = buffers.map(parseWav);
  const fmtHex = parsed[0].fmt.toString("hex");
  for (const entry of parsed.slice(1)) {
    if (entry.fmt.toString("hex") !== fmtHex) {
      throw new Error("Narration chunks returned incompatible WAV formats.");
    }
  }

  const dataBuffer = Buffer.concat(parsed.map((entry) => entry.data));
  const riffSize = 4 + (8 + parsed[0].fmt.length) + (8 + dataBuffer.length);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(riffSize, 4);
  header.write("WAVE", 8, "ascii");

  const fmtHeader = Buffer.alloc(8);
  fmtHeader.write("fmt ", 0, "ascii");
  fmtHeader.writeUInt32LE(parsed[0].fmt.length, 4);

  const dataHeader = Buffer.alloc(8);
  dataHeader.write("data", 0, "ascii");
  dataHeader.writeUInt32LE(dataBuffer.length, 4);

  return Buffer.concat([header, fmtHeader, parsed[0].fmt, dataHeader, dataBuffer]);
}

async function completeJob(jobId, outputPath) {
  const completedAt = nowIso();
  const jobRef = db.collection("render_jobs").doc(jobId);
  const jobSnap = await jobRef.get();
  const job = jobSnap.data();
  if (!job) return;

  try {
    await jobRef.update({
      status: "completed",
      output_path: outputPath,
      error_message: "",
      completed_at: completedAt,
      updated_at: completedAt,
    });
  } catch (error) {
    throw new Error(`Could not update render job completion: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (job.scene_id) {
    try {
      await db.collection("scenes").doc(job.scene_id).update({
        final_mix_status: "ready_to_render",
        render_job_status: "completed",
        render_output_path: outputPath,
        render_error_message: "",
        updated_at: completedAt,
      });
    } catch (error) {
      throw new Error(`Could not update scene render status: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function failJob(jobId, error) {
  const failedAt = nowIso();
  const message = error instanceof Error ? error.message : String(error);
  const jobRef = db.collection("render_jobs").doc(jobId);
  const jobSnap = await jobRef.get();
  const job = jobSnap.data();

  await jobRef.update({
    status: "failed",
    error_message: message,
    completed_at: failedAt,
    updated_at: failedAt,
  });

  if (job?.scene_id) {
    await db.collection("scenes").doc(job.scene_id).update({
      render_job_status: "failed",
      render_error_message: message,
      updated_at: failedAt,
    });
  }
}

async function processNextJob() {
  const job = await reserveNextQueuedJob();
  if (!job) {
    return { ok: true, message: "No queued render jobs were available.", processed: false };
  }

  try {
    const bundle = await loadSceneBundle(job);
    const result = await renderScenePackage({ job, ...bundle });
    await completeJob(job.id, result.outputPath);
    return {
      ok: true,
      processed: true,
      job_id: job.id,
      scene_id: job.scene_id,
      output_path: result.outputPath,
    };
  } catch (error) {
    await failJob(job.id, error);
    return {
      ok: false,
      processed: true,
      job_id: job.id,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const server = http.createServer(async (request, response) => {
  if (!request.url) {
    return json(response, 400, { ok: false, error: "Missing request URL." });
  }

  if (request.method === "GET" && (request.url === "/" || request.url === "/healthz")) {
    return json(response, 200, {
      ok: true,
      service: "the-listening-room-render-worker",
      project_id: projectId,
      storage_bucket: bucketName,
      now: nowIso(),
    });
  }

  if (request.method === "POST" && request.url === "/process-next") {
    try {
      const result = await processNextJob();
      return json(response, result.ok ? 200 : 500, result);
    } catch (error) {
      return json(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (request.method === "POST" && request.url === "/process-batch") {
    try {
      const results = [];
      const batchSize = Math.max(1, Math.min(5, Number(process.env.RENDER_BATCH_SIZE || 3)));
      for (let index = 0; index < batchSize; index += 1) {
        const result = await processNextJob();
        results.push(result);
        if (!result.processed) break;
      }
      return json(response, 200, { ok: true, results });
    } catch (error) {
      return json(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return json(response, 404, { ok: false, error: "Not found." });
});

server.listen(port, () => {
  console.log(`Listening on ${port}`);
});
