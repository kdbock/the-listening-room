import http from "node:http";
import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

const port = Number(process.env.PORT || 8080);
const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || "";
const bucketName = process.env.FIREBASE_STORAGE_BUCKET || process.env.STORAGE_BUCKET || "";
const adminClientEmail = process.env.FIREBASE_CLIENT_EMAIL || "";
const adminPrivateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n") || "";

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

  const artifactPath = `renders/${book.id}/${scene.id}/${job.id}/render-plan.json`;
  const artifact = {
    generated_at: nowIso(),
    worker: "cloud-run-render-worker",
    status: "placeholder_render_package",
    note: "This package proves the render queue and worker wiring. Replace this with true WAV generation next.",
    book: {
      id: book.id,
      title: book.title,
    },
    scene: {
      id: scene.id,
      title: scene.title,
      estimated_minutes: scene.estimated_minutes,
      narrator: scene.narrator || "",
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

  try {
    await storage.bucket(bucketName).file(artifactPath).save(
      JSON.stringify(artifact, null, 2),
      { contentType: "application/json; charset=utf-8" },
    );
  } catch (error) {
    throw new Error(`Could not write render artifact to Storage: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { outputPath: artifactPath };
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
