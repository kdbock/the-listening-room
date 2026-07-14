import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  query,
  where,
  type DocumentData,
} from "firebase/firestore";
import {
  deleteObject,
  getBytes,
  getDownloadURL,
  ref,
  uploadBytes,
} from "firebase/storage";
import { firestoreCollections } from "./collections";
import { getClientFirestore, getClientStorage } from "./client";

export type MaterialRecord = {
  id: string;
  book_id: string;
  name: string;
  category: string;
  content_type: string;
  size: number;
  storage_path: string;
  created_at: string;
  text_content?: string;
};

function nowIso() {
  return new Date().toISOString();
}

function normalizeMaterial(id: string, data: DocumentData): MaterialRecord {
  return {
    id,
    book_id: String(data.book_id ?? ""),
    name: String(data.name ?? "Untitled file"),
    category: String(data.category ?? "Other"),
    content_type: String(data.content_type ?? "application/octet-stream"),
    size: Number(data.size ?? 0),
    storage_path: String(data.storage_path ?? ""),
    created_at: String(data.created_at ?? nowIso()),
    text_content: typeof data.text_content === "string" ? data.text_content : undefined,
  };
}

export async function listMaterials(bookId: string): Promise<MaterialRecord[]> {
  const db = getClientFirestore();
  const snapshot = await getDocs(query(
    collection(db, firestoreCollections.materials),
    where("book_id", "==", bookId),
  ));

  return snapshot.docs
    .map((entry) => normalizeMaterial(entry.id, entry.data()))
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
}

export async function listAllMaterials(): Promise<MaterialRecord[]> {
  const db = getClientFirestore();
  const snapshot = await getDocs(collection(db, firestoreCollections.materials));

  return snapshot.docs
    .map((entry) => normalizeMaterial(entry.id, entry.data()))
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
}

export async function uploadMaterialFile(bookId: string, category: string, file: File) {
  const storage = getClientStorage();
  const db = getClientFirestore();
  const id = crypto.randomUUID();
  const storagePath = `materials/${bookId}/${id}/${file.name}`;
  const createdAt = nowIso();
  const isTextManuscript = category === "Manuscript" && (file.type.startsWith("text/") || file.name.toLowerCase().endsWith(".txt") || file.name.toLowerCase().endsWith(".md"));
  const textContent = isTextManuscript ? await file.text() : undefined;

  await uploadBytes(ref(storage, storagePath), file, {
    contentType: file.type || "application/octet-stream",
  });

  await addDoc(collection(db, firestoreCollections.materials), {
    book_id: bookId,
    name: file.name,
    category,
    content_type: file.type || "application/octet-stream",
    size: file.size,
    storage_path: storagePath,
    created_at: createdAt,
    text_content: textContent,
  });
}

export async function deleteMaterialFile(material: MaterialRecord) {
  const storage = getClientStorage();
  const db = getClientFirestore();
  await deleteObject(ref(storage, material.storage_path));
  await deleteDoc(doc(db, firestoreCollections.materials, material.id));
}

export async function downloadMaterialUrl(material: MaterialRecord) {
  return getDownloadURL(ref(getClientStorage(), material.storage_path));
}

export async function readMaterialText(material: MaterialRecord) {
  if (material.text_content?.trim()) {
    return material.text_content;
  }
  const bytes = await getBytes(ref(getClientStorage(), material.storage_path), 10 * 1024 * 1024);
  return new TextDecoder("utf-8").decode(bytes);
}
