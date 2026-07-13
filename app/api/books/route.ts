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

const titles = [
  "Finding Forgiveness",
  "A Touch Divine",
  "A Touch Dead",
  "A Touch Powerful",
  "Touched by Darkness",
  "Ascension Descension",
  "Defiance in Death",
  "Pangea",
];

const columns = [
  "title", "stage", "progress", "is_active", "narrator_status",
  "manuscript_ready", "voice_approved", "test_approved", "settings_locked",
  "rendering_complete", "qa_passed", "master_approved", "episodes_complete",
  "episodes_total", "corrections_open", "next_action", "target_date",
  "project_path", "notes",
] as const;

function database(): Database {
  const db = (env as unknown as { DB?: Database }).DB;
  if (!db) throw new Error("The private book database is unavailable.");
  return db;
}

async function initialize(db: Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT 'Not started',
      progress INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 0,
      narrator_status TEXT NOT NULL DEFAULT 'Not designed',
      manuscript_ready INTEGER NOT NULL DEFAULT 0,
      voice_approved INTEGER NOT NULL DEFAULT 0,
      test_approved INTEGER NOT NULL DEFAULT 0,
      settings_locked INTEGER NOT NULL DEFAULT 0,
      rendering_complete INTEGER NOT NULL DEFAULT 0,
      qa_passed INTEGER NOT NULL DEFAULT 0,
      master_approved INTEGER NOT NULL DEFAULT 0,
      episodes_complete INTEGER NOT NULL DEFAULT 0,
      episodes_total INTEGER NOT NULL DEFAULT 0,
      corrections_open INTEGER NOT NULL DEFAULT 0,
      next_action TEXT NOT NULL DEFAULT 'Choose the next production step',
      target_date TEXT NOT NULL DEFAULT '',
      project_path TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS books_active_idx ON books(is_active, updated_at)"),
  ]);

  const count = await db.prepare("SELECT COUNT(*) AS count FROM books").first<{ count: number }>();
  if ((count?.count ?? 0) === 0) {
    const timestamp = new Date().toISOString();
    await db.batch(titles.map((title, index) => {
      const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const active = title === "Pangea" ? 1 : 0;
      const stage = active ? "Manuscript prep" : "Not started";
      const progress = active ? 10 : 0;
      const next = active ? "Prepare the manuscript for audiobook production" : "Review the book and choose its production order";
      return db.prepare(`INSERT INTO books
        (id, title, stage, progress, is_active, next_action, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id || `book-${index + 1}`, title, stage, progress, active, next, timestamp, timestamp);
    }));
  }
}

export async function GET() {
  const db = database();
  await initialize(db);
  const result = await db.prepare(
    "SELECT * FROM books ORDER BY is_active DESC, updated_at DESC, title ASC"
  ).all();
  return Response.json(result.results ?? []);
}

export async function POST(request: Request) {
  const db = database();
  await initialize(db);
  const body = await request.json() as { title?: string };
  const title = body.title?.trim();
  if (!title) return Response.json({ error: "A title is required." }, { status: 400 });
  const id = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${Date.now()}`;
  const timestamp = new Date().toISOString();
  await db.prepare(`INSERT INTO books
    (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`)
    .bind(id, title, timestamp, timestamp).run();
  return Response.json({ id }, { status: 201 });
}

export async function PATCH(request: Request) {
  const db = database();
  await initialize(db);
  const body = await request.json() as Record<string, unknown> & { id?: string };
  if (!body.id) return Response.json({ error: "A book id is required." }, { status: 400 });
  const updates: string[] = [];
  const values: unknown[] = [];
  for (const column of columns) {
    const camel = column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    if (Object.prototype.hasOwnProperty.call(body, camel)) {
      updates.push(`${column} = ?`);
      const value = body[camel];
      values.push(typeof value === "boolean" ? Number(value) : value);
    }
  }
  if (!updates.length) return Response.json({ error: "Nothing to update." }, { status: 400 });
  updates.push("updated_at = ?");
  values.push(new Date().toISOString(), body.id);
  await db.prepare(`UPDATE books SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
  return Response.json({ ok: true });
}
