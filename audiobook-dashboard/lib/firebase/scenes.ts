import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  query,
  updateDoc,
  where,
} from "firebase/firestore";
import { firestoreCollections } from "./collections";
import { getClientFirestore } from "./client";

export type StudioSpeaker = {
  name: string;
  line_count: number;
  recommended_voice: string;
  approved_voice: string;
  status: "recommended" | "approved" | "rejected";
};

export type StudioCue = {
  id: string;
  label: string;
  reason: string;
  approved: boolean;
  time?: string;
  source?: string;
  license?: string;
};

export type SceneRecord = {
  id: string;
  book_id: string;
  title: string;
  scene_order: number;
  text: string;
  estimated_minutes: number;
  speakers: StudioSpeaker[];
  sfx_cues: StudioCue[];
  ambience_cues: StudioCue[];
  final_mix_status: "draft" | "voices_approved" | "sfx_approved" | "ambience_approved" | "ready_to_render";
  narrator?: string;
  voice_notes?: string;
  intro?: string;
  outro?: string;
  approvals?: {
    script?: boolean;
    voice?: boolean;
    draft?: boolean;
    sfx?: boolean;
    music?: boolean;
  };
  updated_at: string;
  created_at: string;
};

function nowIso() {
  return new Date().toISOString();
}

export async function listScenes(bookId: string): Promise<SceneRecord[]> {
  const db = getClientFirestore();
  const snapshot = await getDocs(query(
    collection(db, firestoreCollections.scenes),
    where("book_id", "==", bookId),
  ));
  return snapshot.docs
    .map((entry) => ({ id: entry.id, ...(entry.data() as Omit<SceneRecord, "id">) }))
    .sort((left, right) => left.scene_order - right.scene_order);
}

export async function replaceScenes(bookId: string, scenes: Omit<SceneRecord, "id" | "created_at" | "updated_at">[]): Promise<SceneRecord[]> {
  const existing = await listScenes(bookId);
  const db = getClientFirestore();

  for (const scene of existing) {
    await deleteDoc(doc(db, firestoreCollections.scenes, scene.id));
  }

  const savedScenes: SceneRecord[] = [];
  for (const scene of scenes) {
    const timestamp = nowIso();
    const created = await addDoc(collection(db, firestoreCollections.scenes), {
      ...scene,
      created_at: timestamp,
      updated_at: timestamp,
    });
    savedScenes.push({
      id: created.id,
      ...scene,
      created_at: timestamp,
      updated_at: timestamp,
    });
  }

  return savedScenes.sort((left, right) => left.scene_order - right.scene_order);
}

export async function saveScene(scene: SceneRecord) {
  const db = getClientFirestore();
  await updateDoc(doc(db, firestoreCollections.scenes, scene.id), {
    ...scene,
    updated_at: nowIso(),
  });
}
