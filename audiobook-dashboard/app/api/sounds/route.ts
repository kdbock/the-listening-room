import { env } from "cloudflare:workers";

export const dynamic = "force-dynamic";

type D1Result<T = Record<string, unknown>> = { results?: T[] };
type Statement = {
  bind: (...values: unknown[]) => Statement;
  first: <T = Record<string, unknown>>() => Promise<T | null>;
  all: <T = Record<string, unknown>>() => Promise<D1Result<T>>;
  run: () => Promise<unknown>;
};
type Database = { prepare: (sql: string) => Statement; batch: (statements: Statement[]) => Promise<unknown> };
type StoredObject = { body: ReadableStream; httpEtag: string; writeHttpMetadata: (headers: Headers) => void };
type Bucket = {
  get: (key: string) => Promise<StoredObject | null>;
  put: (key: string, value: ReadableStream, options?: { httpMetadata?: { contentType?: string } }) => Promise<unknown>;
  delete: (key: string) => Promise<void>;
};
type Sound = {
  id: string;
  name: string;
  category: string;
  content_type: string;
  size: number;
  storage_key: string;
  source_url: string;
  license: string;
  attribution: string;
  notes: string;
  created_at: string;
};

function bindings() {
  const runtime = env as unknown as { DB?: Database; FILES?: Bucket };
  if (!runtime.DB || !runtime.FILES) throw new Error("Private sound storage is unavailable.");
  return { db: runtime.DB, files: runtime.FILES };
}

async function initialize(db: Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS sounds (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Sound effect',
      content_type TEXT NOT NULL DEFAULT 'audio/mpeg',
      size INTEGER NOT NULL DEFAULT 0,
      storage_key TEXT NOT NULL UNIQUE,
      source_url TEXT NOT NULL DEFAULT '',
      license TEXT NOT NULL DEFAULT '',
      attribution TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS sounds_category_idx ON sounds(category, created_at)"),
  ]);
}

function safeName(name: string) {
  return name.replace(/[\r\n"\\]/g, "_");
}

function safeSourceUrl(value: string) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export async function GET(request: Request) {
  const { db, files } = bindings();
  await initialize(db);
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) {
    const result = await db.prepare(
      "SELECT id, name, category, content_type, size, source_url, license, attribution, notes, created_at FROM sounds ORDER BY created_at DESC"
    ).all<Omit<Sound, "storage_key">>();
    return Response.json(result.results ?? []);
  }

  const sound = await db.prepare("SELECT * FROM sounds WHERE id = ?").bind(id).first<Sound>();
  if (!sound) return Response.json({ error: "Sound not found." }, { status: 404 });
  const object = await files.get(sound.storage_key);
  if (!object) return Response.json({ error: "Stored sound not found." }, { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", sound.content_type);
  headers.set("content-disposition", `${url.searchParams.has("download") ? "attachment" : "inline"}; filename="${safeName(sound.name)}"`);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=3600");
  return new Response(object.body, { headers });
}

export async function POST(request: Request) {
  const { db, files } = bindings();
  await initialize(db);
  if (!request.body) return Response.json({ error: "Audio data is required." }, { status: 400 });
  const url = new URL(request.url);
  const encodedName = request.headers.get("x-file-name");
  const name = encodedName ? decodeURIComponent(encodedName).trim() : "";
  if (!name) return Response.json({ error: "A filename is required." }, { status: 400 });
  const category = url.searchParams.get("category")?.trim() || "Sound effect";
  const sourceUrl = safeSourceUrl(url.searchParams.get("sourceUrl")?.trim() || "");
  const license = url.searchParams.get("license")?.trim() || "";
  const attribution = url.searchParams.get("attribution")?.trim() || "";
  const notes = url.searchParams.get("notes")?.trim() || "";
  const size = Number(request.headers.get("x-file-size") || 0);
  const contentType = request.headers.get("content-type") || "audio/mpeg";
  const id = crypto.randomUUID();
  const storageKey = `sound-library/${id}`;
  const createdAt = new Date().toISOString();

  await files.put(storageKey, request.body, { httpMetadata: { contentType } });
  try {
    await db.prepare(`INSERT INTO sounds
      (id, name, category, content_type, size, storage_key, source_url, license, attribution, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, name, category, contentType, Number.isFinite(size) ? size : 0, storageKey, sourceUrl, license, attribution, notes, createdAt).run();
  } catch (error) {
    await files.delete(storageKey);
    throw error;
  }
  return Response.json({ id }, { status: 201 });
}

export async function DELETE(request: Request) {
  const { db, files } = bindings();
  await initialize(db);
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "A sound id is required." }, { status: 400 });
  const sound = await db.prepare("SELECT storage_key FROM sounds WHERE id = ?").bind(id).first<{ storage_key: string }>();
  if (!sound) return Response.json({ error: "Sound not found." }, { status: 404 });
  await files.delete(sound.storage_key);
  await db.prepare("DELETE FROM sounds WHERE id = ?").bind(id).run();
  return Response.json({ ok: true });
}
