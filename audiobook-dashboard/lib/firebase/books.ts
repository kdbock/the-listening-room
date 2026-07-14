import {
  addDoc,
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  updateDoc,
} from "firebase/firestore";
import { firestoreCollections } from "./collections";
import { getClientFirestore } from "./client";

export type FirestoreBook = {
  id: string;
  title: string;
  stage: string;
  progress: number;
  is_active: number;
  narrator_status: string;
  manuscript_ready: number;
  voice_approved: number;
  test_approved: number;
  settings_locked: number;
  rendering_complete: number;
  qa_passed: number;
  master_approved: number;
  episodes_complete: number;
  episodes_total: number;
  corrections_open: number;
  next_action: string;
  target_date: string;
  project_path: string;
  notes: string;
  updated_at: string;
  created_at?: string;
};

const starterTitles = [
  "Finding Forgiveness",
  "A Touch Divine",
  "A Touch Dead",
  "A Touch Powerful",
  "Touched by Darkness",
  "Ascension Descension",
  "Defiance in Death",
  "Pangea",
];

function nowIso() {
  return new Date().toISOString();
}

function starterBook(title: string): Omit<FirestoreBook, "id"> {
  const active = title === "Pangea" ? 1 : 0;
  const timestamp = nowIso();
  return {
    title,
    stage: active ? "Manuscript prep" : "Not started",
    progress: active ? 10 : 0,
    is_active: active,
    narrator_status: "Not designed",
    manuscript_ready: 0,
    voice_approved: 0,
    test_approved: 0,
    settings_locked: 0,
    rendering_complete: 0,
    qa_passed: 0,
    master_approved: 0,
    episodes_complete: 0,
    episodes_total: 0,
    corrections_open: 0,
    next_action: active ? "Prepare the manuscript for audiobook production" : "Review the book and choose its production order",
    target_date: "",
    project_path: "",
    notes: "",
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function normalizeBook(id: string, data: Partial<FirestoreBook>): FirestoreBook {
  return {
    id,
    title: data.title ?? "Untitled book",
    stage: data.stage ?? "Not started",
    progress: Number(data.progress ?? 0),
    is_active: Number(data.is_active ?? 0),
    narrator_status: data.narrator_status ?? "Not designed",
    manuscript_ready: Number(data.manuscript_ready ?? 0),
    voice_approved: Number(data.voice_approved ?? 0),
    test_approved: Number(data.test_approved ?? 0),
    settings_locked: Number(data.settings_locked ?? 0),
    rendering_complete: Number(data.rendering_complete ?? 0),
    qa_passed: Number(data.qa_passed ?? 0),
    master_approved: Number(data.master_approved ?? 0),
    episodes_complete: Number(data.episodes_complete ?? 0),
    episodes_total: Number(data.episodes_total ?? 0),
    corrections_open: Number(data.corrections_open ?? 0),
    next_action: data.next_action ?? "Choose the next production step",
    target_date: data.target_date ?? "",
    project_path: data.project_path ?? "",
    notes: data.notes ?? "",
    updated_at: data.updated_at ?? nowIso(),
    created_at: data.created_at,
  };
}

export async function ensureStarterBooks() {
  const db = getClientFirestore();
  const booksCollection = collection(db, firestoreCollections.books);
  const snapshot = await getDocs(booksCollection);
  if (!snapshot.empty) return;

  for (const title of starterTitles) {
    await addDoc(booksCollection, starterBook(title));
  }
}

export async function listBooks(): Promise<FirestoreBook[]> {
  await ensureStarterBooks();
  const db = getClientFirestore();
  const booksCollection = collection(db, firestoreCollections.books);
  const snapshot = await getDocs(query(booksCollection, orderBy("updated_at", "desc")));
  return snapshot.docs
    .map((entry) => normalizeBook(entry.id, entry.data() as Partial<FirestoreBook>))
    .sort((left, right) => {
      if (right.is_active !== left.is_active) return right.is_active - left.is_active;
      if (right.updated_at !== left.updated_at) return right.updated_at.localeCompare(left.updated_at);
      return left.title.localeCompare(right.title);
    });
}

export async function createBook(title: string) {
  const db = getClientFirestore();
  const booksCollection = collection(db, firestoreCollections.books);
  const timestamp = nowIso();
  const record = await addDoc(booksCollection, {
    ...starterBook(title),
    stage: "Not started",
    progress: 0,
    is_active: 0,
    next_action: "Review the book and choose its production order",
    created_at: timestamp,
    updated_at: timestamp,
  });
  return record.id;
}

export async function saveBook(book: FirestoreBook) {
  const db = getClientFirestore();
  await updateDoc(doc(db, firestoreCollections.books, book.id), {
    ...book,
    updated_at: nowIso(),
  });
}
