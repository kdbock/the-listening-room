import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  orderBy,
  query,
  type DocumentData,
} from "firebase/firestore";
import {
  deleteObject,
  getDownloadURL,
  ref,
  uploadBytes,
} from "firebase/storage";
import { firestoreCollections } from "./collections";
import { getClientFirestore, getClientStorage } from "./client";

export type SoundRecord = {
  id: string;
  name: string;
  category: string;
  content_type: string;
  size: number;
  storage_path: string;
  source_url: string;
  license: string;
  attribution: string;
  notes: string;
  created_at: string;
};

export type SoundDraft = {
  category: string;
  sourceUrl: string;
  license: string;
  attribution: string;
  notes: string;
};

function nowIso() {
  return new Date().toISOString();
}

function normalizeSound(id: string, data: DocumentData): SoundRecord {
  return {
    id,
    name: String(data.name ?? "Untitled sound"),
    category: String(data.category ?? "Sound effect"),
    content_type: String(data.content_type ?? "audio/mpeg"),
    size: Number(data.size ?? 0),
    storage_path: String(data.storage_path ?? ""),
    source_url: String(data.source_url ?? ""),
    license: String(data.license ?? ""),
    attribution: String(data.attribution ?? ""),
    notes: String(data.notes ?? ""),
    created_at: String(data.created_at ?? nowIso()),
  };
}

export async function listSounds(): Promise<SoundRecord[]> {
  const db = getClientFirestore();
  const snapshot = await getDocs(query(
    collection(db, firestoreCollections.sounds),
    orderBy("created_at", "desc"),
  ));

  return snapshot.docs.map((entry) => normalizeSound(entry.id, entry.data()));
}

export async function uploadSoundFile(file: File, draft: SoundDraft) {
  const storage = getClientStorage();
  const db = getClientFirestore();
  const id = crypto.randomUUID();
  const storagePath = `sounds/${id}/${file.name}`;
  const createdAt = nowIso();

  await uploadBytes(ref(storage, storagePath), file, {
    contentType: file.type || "audio/mpeg",
  });

  await addDoc(collection(db, firestoreCollections.sounds), {
    name: file.name,
    category: draft.category,
    content_type: file.type || "audio/mpeg",
    size: file.size,
    storage_path: storagePath,
    source_url: draft.sourceUrl.trim(),
    license: draft.license.trim(),
    attribution: draft.attribution.trim(),
    notes: draft.notes.trim(),
    created_at: createdAt,
  });
}

export async function deleteSoundFile(sound: SoundRecord) {
  const storage = getClientStorage();
  const db = getClientFirestore();
  await deleteObject(ref(storage, sound.storage_path));
  await deleteDoc(doc(db, firestoreCollections.sounds, sound.id));
}

export async function downloadSoundUrl(sound: SoundRecord) {
  return getDownloadURL(ref(getClientStorage(), sound.storage_path));
}
