import { env } from "cloudflare:workers";

export const dynamic = "force-dynamic";

type D1Result<T = Record<string, unknown>> = { results?: T[] };
type Statement = {
  bind: (...values: unknown[]) => Statement;
  first: <T = Record<string, unknown>>() => Promise<T | null>;
  all: <T = Record<string, unknown>>() => Promise<D1Result<T>>;
  run: () => Promise<unknown>;
};
type Database = {
  prepare: (sql: string) => Statement;
  batch: (statements: Statement[]) => Promise<unknown>;
};
type StoredObject = {
  body: ReadableStream;
  httpEtag: string;
  writeHttpMetadata: (headers: Headers) => void;
};
type Bucket = {
  get: (key: string) => Promise<StoredObject | null>;
  put: (key: string, value: ReadableStream, options?: { httpMetadata?: { contentType?: string } }) => Promise<unknown>;
  delete: (key: string) => Promise<void>;
};

type Material = {
  id: string;
  book_id: string;
  name: string;
  category: string;
  content_type: string;
  size: number;
  storage_key: string;
  created_at: string;
};

function bindings() {
  const runtime = env as unknown as { DB?: Database; FILES?: Bucket };
  if (!runtime.DB || !runtime.FILES) throw new Error("Private file storage is unavailable.");
  return { db: runtime.DB, files: runtime.FILES };
}

async function initialize(db: Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS materials (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Other',
      content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      size INTEGER NOT NULL DEFAULT 0,
      storage_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS materials_book_idx ON materials(book_id, created_at)"),
  ]);
}

function safeDispositionName(name: string) {
  return name.replace(/[\r\n"\\]/g, "_");
}

export async function GET(request: Request) {
  const { db, files } = bindings();
  await initialize(db);
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (id) {
    const material = await db.prepare("SELECT * FROM materials WHERE id = ?").bind(id).first<Material>();
    if (!material) return Response.json({ error: "File not found." }, { status: 404 });
    const object = await files.get(material.storage_key);
    if (!object) return Response.json({ error: "Stored file not found." }, { status: 404 });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("content-type", material.content_type);
    headers.set("content-disposition", `attachment; filename="${safeDispositionName(material.name)}"`);
    headers.set("etag", object.httpEtag);
    headers.set("cache-control", "private, no-store");
    return new Response(object.body, { headers });
  }

  const bookId = url.searchParams.get("bookId");
  if (!bookId) return Response.json({ error: "A book id is required." }, { status: 400 });
  const result = await db.prepare(
    "SELECT id, book_id, name, category, content_type, size, created_at FROM materials WHERE book_id = ? ORDER BY created_at DESC"
  ).bind(bookId).all<Omit<Material, "storage_key">>();
  return Response.json(result.results ?? []);
}

export async function POST(request: Request) {
  const { db, files } = bindings();
  await initialize(db);
  const url = new URL(request.url);
  const bookId = url.searchParams.get("bookId")?.trim();
  const category = url.searchParams.get("category")?.trim() || "Other";
  const encodedName = request.headers.get("x-file-name");
  const name = encodedName ? decodeURIComponent(encodedName).trim() : "";
  const size = Number(request.headers.get("x-file-size") || 0);
  const contentType = request.headers.get("content-type") || "application/octet-stream";
  if (!bookId || !name || !request.body) return Response.json({ error: "Book, filename, and file data are required." }, { status: 400 });
  const book = await db.prepare("SELECT id FROM books WHERE id = ?").bind(bookId).first();
  if (!book) return Response.json({ error: "Book not found." }, { status: 404 });

  const id = crypto.randomUUID();
  const storageKey = `${bookId}/${id}`;
  const createdAt = new Date().toISOString();
  await files.put(storageKey, request.body, { httpMetadata: { contentType } });
  try {
    await db.prepare(`INSERT INTO materials
      (id, book_id, name, category, content_type, size, storage_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, bookId, name, category, contentType, Number.isFinite(size) ? size : 0, storageKey, createdAt).run();
  } catch (error) {
    await files.delete(storageKey);
    throw error;
  }
  return Response.json({ id, name, category, content_type: contentType, size, created_at: createdAt }, { status: 201 });
}

export async function DELETE(request: Request) {
  const { db, files } = bindings();
  await initialize(db);
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "A file id is required." }, { status: 400 });
  const material = await db.prepare("SELECT storage_key FROM materials WHERE id = ?").bind(id).first<{ storage_key: string }>();
  if (!material) return Response.json({ error: "File not found." }, { status: 404 });
  await files.delete(material.storage_key);
  await db.prepare("DELETE FROM materials WHERE id = ?").bind(id).run();
  return Response.json({ ok: true });
}
