#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { initializeApp } from "firebase/app";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  query,
  runTransaction,
  terminate,
  updateDoc,
  where,
} from "firebase/firestore";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const dashboardDir = path.resolve(scriptDir, "..");
const projectDir = path.resolve(dashboardDir, "..");
const localNarratorDir = path.join(projectDir, "local-narrator");
const sceneStudioDir = path.join(localNarratorDir, "scene-studio");
const rendererPath = path.join(sceneStudioDir, "scene_tts_renderer.py");
const soundDesignerPath = path.join(sceneStudioDir, "sound_designer_ai.py");
const soundLibraryRoot = path.join(projectDir, "Sound Library Downloads");
const soundArchiveIndexPath = path.join(dashboardDir, "public", "sound-archive-index.json");
const defaultPython = "/Users/kristykelly/.local/share/local-narration-studio/venv/bin/python";
const defaultFfmpeg = "/Users/kristykelly/.local/share/local-narration-studio/bin/ffmpeg";

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals < 1) continue;
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Add it to audiobook-dashboard/.env.local.`);
  return value;
}

function nowIso() {
  return new Date().toISOString();
}

function slug(value) {
  return String(value || "untitled").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "untitled";
}

function cueTokens(value) {
  const synonyms = {
    door: ["door", "threshold", "knock", "hinge", "handle", "open", "close"],
    threshold: ["door", "threshold", "entry", "enter", "exit"],
    footsteps: ["footstep", "footsteps", "walk", "running", "crawl", "movement"],
    character: ["human", "cloth", "foley", "movement"],
    vehicle: ["car", "truck", "vehicle", "traffic", "engine"],
    boxes: ["box", "crate", "luggage", "case", "rummaging"],
    luggage: ["luggage", "case", "bag", "foley"],
    phone: ["phone", "telephone", "ring"],
    cloth: ["cloth", "fabric", "foley", "movement"],
    breath: ["breath", "breathing", "pant", "sigh"],
    weather: ["weather", "rain", "storm", "wind", "thunder"],
    water: ["water", "wave", "waves", "sea", "ocean", "shore", "harbor"],
    vessel: ["ship", "boat", "deck", "wood", "creak", "water"],
    bell: ["bell", "bells", "church"],
    music: ["music", "tonal", "drone"],
    night: ["night", "ambience", "room", "quiet"],
    room: ["room", "roomtone", "ambience", "interior"],
    urban: ["urban", "city", "street", "traffic", "crowd"],
    forest: ["forest", "woods", "birds", "wind", "nature"],
    interior: ["interior", "room", "hall", "ambience"],
  };

  const raw = String(value || "").toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2);
  return Array.from(new Set(raw.flatMap((token) => [token, ...(synonyms[token] || [])])));
}

function parseCueTime(value, fallbackIndex) {
  const text = String(value || "").trim();
  const match = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return Math.max(0, fallbackIndex * 8);
  const first = Number(match[1]);
  const second = Number(match[2]);
  const third = match[3] ? Number(match[3]) : 0;
  return match[3] ? first * 3600 + second * 60 + third : first * 60 + second;
}

function dbToLinear(db) {
  return Math.pow(10, Number(db || 0) / 20);
}

function inferTone(text) {
  const lower = String(text || "").toLowerCase();
  const tones = [];
  if (/\b(whisper|quiet|still|dark|night|alone|soft)\b/.test(lower)) tones.push("intimate");
  if (/\b(run|blood|knife|fight|shout|scream|panic|angry|fear)\b/.test(lower)) tones.push("tense");
  if (/\b(cry|tears|grief|sorry|trembl|ache)\b/.test(lower)) tones.push("emotional");
  if (/\b(ship|sea|harbor|deck|water|shore|rain|wind)\b/.test(lower)) tones.push("environmental");
  return tones.length ? tones.join(", ") : "restrained";
}

function summarizeScene(text) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.length > 320 ? `${cleaned.slice(0, 317)}...` : cleaned;
}

function cueSearchTerms(cue) {
  return cueTokens(`${cue.label || ""} ${cue.reason || ""} ${cue.source || ""}`).slice(0, 8);
}

function deterministicDesignerPlan(scene, cues) {
  const tone = inferTone(scene.text);
  return {
    scene_summary: summarizeScene(scene.text),
    tone,
    sound_strategy: tone.includes("tense")
      ? "Keep narration in front. Use brief, low effects for action beats and avoid constant background unless the setting requires it."
      : "Keep narration in front. Use sparse supportive details and low ambience only where it clarifies place or mood.",
    cue_plan: cues.map((cue, index) => ({
      id: cue.id || `cue-${index + 1}`,
      kind: cue.kind || "effect",
      time: cue.time || "",
      description: cue.label || "Approved sound cue",
      search_terms: cueSearchTerms(cue),
      gain_db: cue.kind === "ambience" ? -28 : -18,
      fade_in: cue.kind === "ambience" ? 1.5 : 0.03,
      fade_out: cue.kind === "ambience" ? 2.0 : 0.2,
      reason: cue.reason || "Approved cue supports the scene.",
      avoid: "Do not distract from narration.",
    })),
    planner: "deterministic-local-fallback",
  };
}

function loadSoundIndex() {
  if (!fs.existsSync(soundArchiveIndexPath)) return [];
  const parsed = JSON.parse(fs.readFileSync(soundArchiveIndexPath, "utf8"));
  return Array.isArray(parsed.items) ? parsed.items : [];
}

function scoreSoundItem(item, tokens, preferredKinds) {
  const haystack = [
    item.name,
    item.kind,
    item.pack,
    item.bundle,
    item.relativePath,
    ...(Array.isArray(item.tags) ? item.tags : []),
  ].join(" ").toLowerCase();
  let score = preferredKinds.includes(item.kind) ? 4 : 0;
  for (const token of tokens) {
    if (!token) continue;
    if (haystack.includes(token)) score += token.length > 5 ? 3 : 2;
  }
  if (/\b(test|dtmf|white noise|channel test)\b/i.test(haystack)) score -= 8;
  if (/\b(voice|say|male|female|pirate|yell|scream)\b/i.test(haystack) && !tokens.some((token) => ["human", "breath", "crowd", "laugh", "cry"].includes(token))) score -= 5;
  return score;
}

function matchCueToSound(cuePlan, soundIndex, preferredKinds) {
  const tokens = Array.from(new Set([
    ...cueTokens(`${cuePlan.description || ""} ${cuePlan.reason || ""}`),
    ...(Array.isArray(cuePlan.search_terms) ? cuePlan.search_terms.map((term) => String(term).toLowerCase()) : []),
  ]));
  const ranked = soundIndex
    .map((item) => ({ item, score: scoreSoundItem(item, tokens, preferredKinds) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.item.name.localeCompare(right.item.name));

  const best = ranked[0]?.item;
  if (!best) return null;
  const absolutePath = path.join(soundLibraryRoot, best.relativePath);
  if (!fs.existsSync(absolutePath)) return null;
  return { ...best, absolutePath, score: ranked[0].score };
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf8");
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`Command exited ${code}.\n${output.slice(-4000)}`));
    });
  });
}

function renderOverlayStem({ ffmpeg, items, outputPath, gain }) {
  if (!items.length) return Promise.resolve(false);
  const args = ["-y", "-hide_banner", "-loglevel", "warning"];
  for (const item of items) args.push("-i", item.asset.absolutePath);
  const filters = items.map((item, index) => {
    const delay = Math.max(0, Math.round(item.start_seconds * 1000));
    const itemGain = item.gain_linear || gain;
    const fadeIn = Math.max(0, Number(item.fade_in || 0));
    const fadeOut = Math.max(0, Number(item.fade_out || 0));
    const fades = [
      fadeIn ? `afade=t=in:st=0:d=${fadeIn}` : "",
      fadeOut ? `afade=t=out:st=3:d=${fadeOut}` : "",
    ].filter(Boolean).join(",");
    const fadeFilter = fades ? `,${fades}` : "";
    return `[${index}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${itemGain}${fadeFilter},adelay=${delay}|${delay}[a${index}]`;
  });
  filters.push(`${items.map((_, index) => `[a${index}]`).join("")}amix=inputs=${items.length}:duration=longest:normalize=0,volume=1.0[out]`);
  args.push("-filter_complex", filters.join(";"), "-map", "[out]", "-ac", "2", "-ar", "48000", outputPath);
  return runCommand(ffmpeg, args).then(() => true);
}

function renderNarrationPlusStem({ ffmpeg, narrationPath, stemPath, outputPath }) {
  if (!fs.existsSync(stemPath)) {
    fs.copyFileSync(narrationPath, outputPath);
    return Promise.resolve(false);
  }
  return runCommand(ffmpeg, [
    "-y",
    "-hide_banner",
    "-loglevel", "warning",
    "-i", narrationPath,
    "-i", stemPath,
    "-filter_complex", "[0:a]aformat=sample_rates=48000:channel_layouts=stereo[n];[1:a]aformat=sample_rates=48000:channel_layouts=stereo[s];[n][s]amix=inputs=2:duration=first:normalize=0[out]",
    "-map", "[out]",
    "-ac", "2",
    "-ar", "48000",
    outputPath,
  ]).then(() => true);
}

function renderFinalMix({ ffmpeg, narrationPath, effectsPath, ambiencePath, outputPath }) {
  const inputs = [narrationPath, effectsPath, ambiencePath].filter((item) => item && fs.existsSync(item));
  if (inputs.length <= 1) {
    fs.copyFileSync(narrationPath, outputPath);
    return Promise.resolve(false);
  }
  const args = ["-y", "-hide_banner", "-loglevel", "warning"];
  for (const input of inputs) args.push("-i", input);
  const filters = inputs.map((_, index) => `[${index}:a]aformat=sample_rates=48000:channel_layouts=stereo[a${index}]`);
  filters.push(`${inputs.map((_, index) => `[a${index}]`).join("")}amix=inputs=${inputs.length}:duration=first:normalize=0[out]`);
  args.push("-filter_complex", filters.join(";"), "-map", "[out]", "-ac", "2", "-ar", "48000", outputPath);
  return runCommand(ffmpeg, args).then(() => true);
}

async function buildDesignerPlanWithLocalAi({ scene, cues, paths, python }) {
  const inputPath = path.join(paths.outputRoot, "sound-designer-input.json");
  const outputPath = path.join(paths.outputRoot, "sound-designer-ai.json");
  writeJson(inputPath, {
    title: scene.title || "",
    text: scene.text || "",
    cues,
  });

  if (!fs.existsSync(soundDesignerPath)) return deterministicDesignerPlan(scene, cues);

  try {
    await runCommand(python, [
      soundDesignerPath,
      "--input", inputPath,
      "--output", outputPath,
    ], { cwd: projectDir });
    return JSON.parse(fs.readFileSync(outputPath, "utf8"));
  } catch (error) {
    console.warn(`Local AI sound designer unavailable; using deterministic plan. ${error instanceof Error ? error.message : String(error)}`);
    return deterministicDesignerPlan(scene, cues);
  }
}

loadEnvFile(path.join(dashboardDir, ".env.local"));

const app = initializeApp({
  apiKey: requireEnv("NEXT_PUBLIC_FIREBASE_API_KEY"),
  authDomain: requireEnv("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN"),
  projectId: requireEnv("NEXT_PUBLIC_FIREBASE_PROJECT_ID"),
  storageBucket: requireEnv("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET"),
  messagingSenderId: requireEnv("NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID"),
  appId: requireEnv("NEXT_PUBLIC_FIREBASE_APP_ID"),
});

const db = getFirestore(app);

async function reserveNextJob() {
  const snapshot = await getDocs(query(
    collection(db, "render_jobs"),
    where("status", "==", "queued"),
    limit(10),
  ));

  for (const queued of snapshot.docs) {
    const claimed = await runTransaction(db, async (transaction) => {
      const fresh = await transaction.get(queued.ref);
      if (!fresh.exists()) return null;
      const data = fresh.data();
      if (data.status !== "queued") return null;
      if (data.render_target !== "local_qwen") return null;

      const next = {
        id: fresh.id,
        ...data,
        status: "processing",
        started_at: nowIso(),
        updated_at: nowIso(),
      };

      transaction.update(queued.ref, {
        status: next.status,
        started_at: next.started_at,
        updated_at: next.updated_at,
        worker_name: "local-qwen-render-worker",
      });

      return next;
    });

    if (claimed) return claimed;
  }

  return null;
}

async function loadBundle(job) {
  const [sceneSnap, bookSnap] = await Promise.all([
    getDoc(doc(db, "scenes", job.scene_id)),
    getDoc(doc(db, "books", job.book_id)),
  ]);

  if (!sceneSnap.exists()) throw new Error(`Scene ${job.scene_id} was not found.`);
  if (!bookSnap.exists()) throw new Error(`Book ${job.book_id} was not found.`);

  return {
    scene: { id: sceneSnap.id, ...sceneSnap.data() },
    book: { id: bookSnap.id, ...bookSnap.data() },
  };
}

function buildNarratorPlan({ job, scene, book }) {
  const text = String(scene.text || "").trim();
  if (!text) throw new Error("Scene text is empty.");

  const narratorReference = path.join(localNarratorDir, "nix-voice-reference.wav");
  const narratorReferenceTextPath = path.join(localNarratorDir, "nix-voice-reference.txt");
  if (!fs.existsSync(narratorReference)) throw new Error(`Missing local narrator reference: ${narratorReference}`);
  if (!fs.existsSync(narratorReferenceTextPath)) throw new Error(`Missing local narrator reference text: ${narratorReferenceTextPath}`);

  const outputRoot = path.join(localNarratorDir, "cloud-renders", slug(book.title || book.id), `scene-${String(scene.scene_order || "0").padStart(2, "0")}-${slug(scene.title || scene.id)}`, job.id);
  const sourcePath = path.join(outputRoot, "scene-text.txt");
  const planPath = path.join(outputRoot, "render-plan.json");
  const outputPath = path.join(outputRoot, "narration-preview.wav");
  const segmentsDir = path.join(outputRoot, "segments");
  const soundPlanPath = path.join(outputRoot, "sound-design-plan.json");
  const effectsStemPath = path.join(outputRoot, "02-effects.wav");
  const ambienceStemPath = path.join(outputRoot, "03-ambience.wav");
  const withSfxPath = path.join(outputRoot, "with-sfx.wav");
  const finalMixPath = path.join(outputRoot, "final-mix.wav");

  writeText(sourcePath, `${text}\n`);
  writeJson(planPath, {
    scene_id: scene.id,
    source_text: sourcePath,
    source_snapshot: sourcePath,
    render_job_id: job.id,
    render_target: "local_qwen",
    book: { id: book.id, title: book.title || "" },
    scene: { id: scene.id, title: scene.title || "", scene_order: scene.scene_order || 0 },
    units: [{
      text,
      speaker: "Narrator",
      reference_audio: narratorReference,
      reference_text: fs.readFileSync(narratorReferenceTextPath, "utf8").trim(),
    }],
  });

  return { outputRoot, sourcePath, planPath, outputPath, segmentsDir, soundPlanPath, effectsStemPath, ambienceStemPath, withSfxPath, finalMixPath };
}

async function buildSoundDesignPlan({ scene, paths, python }) {
  const soundIndex = loadSoundIndex();
  const approvedSfx = (Array.isArray(scene.sfx_cues) ? scene.sfx_cues : []).filter((cue) => cue.approved).map((cue) => ({ ...cue, kind: "effect" }));
  const approvedAmbience = (Array.isArray(scene.ambience_cues) ? scene.ambience_cues : []).filter((cue) => cue.approved).map((cue) => ({ ...cue, kind: "ambience" }));
  const approvedCues = [...approvedSfx.slice(0, 12), ...approvedAmbience.slice(0, 4)];
  const designer = await buildDesignerPlanWithLocalAi({ scene, cues: approvedCues, paths, python });
  const plannedById = new Map((Array.isArray(designer.cue_plan) ? designer.cue_plan : []).map((cuePlan, index) => [String(cuePlan.id || `cue-${index + 1}`), cuePlan]));

  const effects = approvedSfx.slice(0, 12).map((cue, index) => {
    const cuePlan = plannedById.get(String(cue.id || `cue-${index + 1}`)) || deterministicDesignerPlan(scene, [cue]).cue_plan[0];
    return {
      kind: "effect",
      cue,
      description: cuePlan.description || cue.label || "",
      search_terms: cuePlan.search_terms || cueSearchTerms(cue),
      start_seconds: parseCueTime(cue.time, index),
      gain_db_intent: Number(cuePlan.gain_db ?? -18),
      gain_linear: dbToLinear(cuePlan.gain_db ?? -18),
      fade_in: Number(cuePlan.fade_in ?? 0.03),
      fade_out: Number(cuePlan.fade_out ?? 0.2),
      reason: cuePlan.reason || cue.reason || "",
      avoid: cuePlan.avoid || "Do not distract from narration.",
      asset: matchCueToSound(cuePlan, soundIndex, ["Foley", "Water", "Weather", "Transportation", "Transitions", "People"]),
    };
  });

  const ambience = approvedAmbience.slice(0, 4).map((cue, index) => {
    const cuePlan = plannedById.get(String(cue.id || `cue-${index + 1}`)) || deterministicDesignerPlan(scene, [cue]).cue_plan[0];
    return {
      kind: "ambience",
      cue,
      description: cuePlan.description || cue.label || "",
      search_terms: cuePlan.search_terms || cueSearchTerms(cue),
      start_seconds: parseCueTime(cue.time, index),
      gain_db_intent: Number(cuePlan.gain_db ?? -28),
      gain_linear: dbToLinear(cuePlan.gain_db ?? -28),
      fade_in: Number(cuePlan.fade_in ?? 1.5),
      fade_out: Number(cuePlan.fade_out ?? 2.0),
      reason: cuePlan.reason || cue.reason || "",
      avoid: cuePlan.avoid || "Do not distract from narration.",
      asset: matchCueToSound(cuePlan, soundIndex, ["Ambience", "Weather", "Water", "Music / Tonal"]),
    };
  });

  const plan = {
    created_at: nowIso(),
    status: "local_sound_designer_plan",
    note: "Generated locally from approved scene cues. Review asset choices and timing before treating this as a final production mix.",
    scene_summary: designer.scene_summary || summarizeScene(scene.text),
    tone: designer.tone || inferTone(scene.text),
    sound_strategy: designer.sound_strategy || "Keep narration foreground; use sparse supportive sound.",
    planner: designer.planner || "unknown-local-planner",
    sound_library_root: soundLibraryRoot,
    narration_stem: paths.outputPath,
    effects_stem: paths.effectsStemPath,
    ambience_stem: paths.ambienceStemPath,
    with_sfx_mix: paths.withSfxPath,
    final_mix: paths.finalMixPath,
    effects,
    ambience,
    unmatched: [...effects, ...ambience].filter((entry) => !entry.asset).map((entry) => ({
      kind: entry.kind,
      label: entry.cue.label || "",
      time: entry.cue.time || "",
      reason: entry.cue.reason || "",
    })),
  };

  writeJson(paths.soundPlanPath, plan);
  return plan;
}

async function renderSoundDesign(paths, soundPlan) {
  const ffmpeg = process.env.FFMPEG_PATH || (fs.existsSync(defaultFfmpeg) ? defaultFfmpeg : "ffmpeg");
  const effectItems = soundPlan.effects.filter((entry) => entry.asset);
  const ambienceItems = soundPlan.ambience.filter((entry) => entry.asset);

  if (effectItems.length) await renderOverlayStem({ ffmpeg, items: effectItems, outputPath: paths.effectsStemPath, gain: 0.13 });
  if (ambienceItems.length) await renderOverlayStem({ ffmpeg, items: ambienceItems, outputPath: paths.ambienceStemPath, gain: 0.04 });
  await renderNarrationPlusStem({ ffmpeg, narrationPath: paths.outputPath, stemPath: paths.effectsStemPath, outputPath: paths.withSfxPath });
  await renderFinalMix({ ffmpeg, narrationPath: paths.outputPath, effectsPath: paths.effectsStemPath, ambiencePath: paths.ambienceStemPath, outputPath: paths.finalMixPath });
}

function compactSoundPlan(soundPlan, paths) {
  const items = [...soundPlan.effects, ...soundPlan.ambience].map((entry) => ({
    kind: entry.kind,
    label: entry.cue?.label || entry.description || "Sound cue",
    time: entry.cue?.time || "",
    description: entry.description || "",
    asset_name: entry.asset?.name || "",
    asset_path: entry.asset?.absolutePath || "",
    gain_db: Number(entry.gain_db_intent ?? 0),
    fade_in: Number(entry.fade_in ?? 0),
    fade_out: Number(entry.fade_out ?? 0),
    reason: entry.reason || "",
    avoid: entry.avoid || "",
    matched: Boolean(entry.asset),
  }));

  return {
    created_at: soundPlan.created_at || nowIso(),
    status: soundPlan.status || "",
    planner: soundPlan.planner || "",
    scene_summary: soundPlan.scene_summary || "",
    tone: soundPlan.tone || "",
    sound_strategy: soundPlan.sound_strategy || "",
    plan_path: paths.soundPlanPath,
    final_mix: paths.finalMixPath,
    with_sfx_mix: paths.withSfxPath,
    effects_stem: paths.effectsStemPath,
    ambience_stem: paths.ambienceStemPath,
    items,
    unmatched: Array.isArray(soundPlan.unmatched) ? soundPlan.unmatched : [],
  };
}

async function completeJob(job, paths, soundPlan) {
  const timestamp = nowIso();
  const localOutputPath = fs.existsSync(paths.finalMixPath) ? paths.finalMixPath : paths.outputPath;
  const soundPlanSummary = compactSoundPlan(soundPlan, paths);
  await Promise.all([
    updateDoc(doc(db, "render_jobs", job.id), {
      status: "completed",
      completed_at: timestamp,
      updated_at: timestamp,
      output_path: localOutputPath,
      local_output_path: localOutputPath,
      narration_output_path: paths.outputPath,
      sound_design_plan_path: paths.soundPlanPath,
      sound_design_plan: soundPlanSummary,
      with_sfx_output_path: paths.withSfxPath,
      final_mix_output_path: paths.finalMixPath,
      error_message: "",
    }),
    updateDoc(doc(db, "scenes", job.scene_id), {
      final_mix_status: "ready_to_render",
      render_job_status: "completed",
      render_output_path: localOutputPath,
      render_sound_design_plan_path: paths.soundPlanPath,
      render_sound_design_plan: soundPlanSummary,
      render_error_message: "",
      updated_at: timestamp,
    }),
  ]);
}

async function failJob(job, error) {
  const timestamp = nowIso();
  const message = error instanceof Error ? error.message : String(error);
  await Promise.all([
    updateDoc(doc(db, "render_jobs", job.id), {
      status: "failed",
      error_message: message,
      completed_at: timestamp,
      updated_at: timestamp,
    }),
    updateDoc(doc(db, "scenes", job.scene_id), {
      render_job_status: "failed",
      render_error_message: message,
      updated_at: timestamp,
    }),
  ]);
}

async function processOne() {
  console.log("Checking Firestore for local_qwen render jobs...");
  const job = await reserveNextJob();
  if (!job) {
    console.log("No local_qwen render jobs are queued.");
    return false;
  }

  console.log(`Rendering local Qwen job ${job.id} for scene ${job.scene_title || job.scene_id}`);
  try {
    const bundle = await loadBundle(job);
    const paths = buildNarratorPlan({ job, ...bundle });
    const python = process.env.LOCAL_QWEN_PYTHON || (fs.existsSync(defaultPython) ? defaultPython : "python3");
    if (!fs.existsSync(paths.outputPath)) {
      await runCommand(python, [
        rendererPath,
        "--plan", paths.planPath,
        "--output", paths.outputPath,
        "--segments-dir", paths.segmentsDir,
      ], { cwd: projectDir });
    }
    const soundPlan = await buildSoundDesignPlan({ scene: bundle.scene, paths, python });
    await renderSoundDesign(paths, soundPlan);
    await completeJob(job, paths, soundPlan);
    console.log(`Completed ${paths.outputPath}`);
    return true;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    await failJob(job, error);
    return true;
  }
}

async function main() {
  const watch = process.argv.includes("--watch");
  const intervalArg = process.argv.find((arg) => arg.startsWith("--interval="));
  const intervalMs = Math.max(5000, Number(intervalArg?.split("=")[1] || 15000));

  if (!fs.existsSync(rendererPath)) throw new Error(`Missing renderer: ${rendererPath}`);

  do {
    await processOne();
    if (watch) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (watch);

  await terminate(db);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
