import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  query,
  updateDoc,
  where,
  type DocumentData,
} from "firebase/firestore";
import { firestoreCollections } from "./collections";
import { getClientFirestore } from "./client";
import type { SoundDesignPlanSummary } from "./scenes";

export type RenderJobStatus = "queued" | "processing" | "completed" | "failed";
export type RenderTarget = "local_qwen" | "cloud_run" | "legacy_cloud";

export type RenderJobRecord = {
  id: string;
  book_id: string;
  scene_id: string;
  scene_title: string;
  status: RenderJobStatus;
  render_target: RenderTarget;
  output_path: string;
  local_output_path: string;
  sound_design_plan?: SoundDesignPlanSummary;
  error_message: string;
  requested_at: string;
  started_at: string;
  completed_at: string;
  created_at: string;
  updated_at: string;
};

function nowIso() {
  return new Date().toISOString();
}

function normalizeRenderTarget(data: DocumentData): RenderTarget {
  if (data.render_target === "local_qwen" || data.render_target === "cloud_run") {
    return data.render_target;
  }
  return "legacy_cloud";
}

function normalizeRenderJob(id: string, data: DocumentData): RenderJobRecord {
  return {
    id,
    book_id: String(data.book_id ?? ""),
    scene_id: String(data.scene_id ?? ""),
    scene_title: String(data.scene_title ?? "Untitled scene"),
    status: (data.status as RenderJobStatus) ?? "queued",
    render_target: normalizeRenderTarget(data),
    output_path: String(data.output_path ?? ""),
    local_output_path: String(data.local_output_path ?? ""),
    sound_design_plan: data.sound_design_plan as SoundDesignPlanSummary | undefined,
    error_message: String(data.error_message ?? ""),
    requested_at: String(data.requested_at ?? ""),
    started_at: String(data.started_at ?? ""),
    completed_at: String(data.completed_at ?? ""),
    created_at: String(data.created_at ?? nowIso()),
    updated_at: String(data.updated_at ?? nowIso()),
  };
}

export async function listRenderJobsByScene(sceneId: string): Promise<RenderJobRecord[]> {
  const db = getClientFirestore();
  const snapshot = await getDocs(query(
    collection(db, firestoreCollections.renderJobs),
    where("scene_id", "==", sceneId),
  ));

  return snapshot.docs
    .map((entry) => normalizeRenderJob(entry.id, entry.data()))
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
}

export async function getLatestRenderJob(sceneId: string): Promise<RenderJobRecord | null> {
  const jobs = await listRenderJobsByScene(sceneId);
  return jobs[0] ?? null;
}

export async function queueRenderJob(input: { bookId: string; sceneId: string; sceneTitle: string }) {
  const existing = await getLatestRenderJob(input.sceneId);
  if (existing?.render_target === "local_qwen" && (existing.status === "queued" || existing.status === "processing")) {
    return existing;
  }

  const db = getClientFirestore();
  const timestamp = nowIso();
  const created = await addDoc(collection(db, firestoreCollections.renderJobs), {
    book_id: input.bookId,
    scene_id: input.sceneId,
    scene_title: input.sceneTitle,
    status: "queued" as RenderJobStatus,
    render_target: "local_qwen" as RenderTarget,
    output_path: "",
    local_output_path: "",
    error_message: "",
    requested_at: timestamp,
    started_at: "",
    completed_at: "",
    created_at: timestamp,
    updated_at: timestamp,
  });

  return {
    id: created.id,
    book_id: input.bookId,
    scene_id: input.sceneId,
    scene_title: input.sceneTitle,
    status: "queued" as RenderJobStatus,
    render_target: "local_qwen" as RenderTarget,
    output_path: "",
    local_output_path: "",
    error_message: "",
    requested_at: timestamp,
    started_at: "",
    completed_at: "",
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export async function updateRenderJob(job: RenderJobRecord) {
  const db = getClientFirestore();
  await updateDoc(doc(db, firestoreCollections.renderJobs, job.id), {
    ...job,
    updated_at: nowIso(),
  });
}

export async function deleteRenderJob(jobId: string) {
  const db = getClientFirestore();
  await deleteDoc(doc(db, firestoreCollections.renderJobs, jobId));
}
