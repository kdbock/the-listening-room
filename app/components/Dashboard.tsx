"use client";

import { useEffect, useMemo, useState } from "react";

type Book = {
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
};

const stages = ["Not started", "Manuscript prep", "Voice design", "Test scene", "Production", "Corrections", "QA", "Mastered", "Distributed"];
const narratorStates = ["Not designed", "Auditions ready", "Approved", "Locked"];
const checklist: Array<[keyof Book, string]> = [
  ["manuscript_ready", "Manuscript ready"],
  ["voice_approved", "Narrator approved"],
  ["test_approved", "Test scene approved"],
  ["settings_locked", "Settings locked"],
  ["rendering_complete", "Rendering complete"],
  ["qa_passed", "Opening QA passed"],
  ["master_approved", "WAV master approved"],
];

function toCamel(key: string) {
  return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function formatDate(value: string) {
  if (!value) return "No target date";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

export default function Dashboard() {
  const [books, setBooks] = useState<Book[]>([]);
  const [selected, setSelected] = useState<Book | null>(null);
  const [filter, setFilter] = useState("All books");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [error, setError] = useState("");

  async function loadBooks() {
    try {
      const response = await fetch("/api/books", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load your library.");
      setBooks(await response.json());
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your library.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadBooks(); }, []);

  const visible = useMemo(() => books.filter((book) => {
    const matchesSearch = book.title.toLowerCase().includes(search.toLowerCase());
    const matchesFilter = filter === "All books" ||
      (filter === "Active" && Boolean(book.is_active)) ||
      (filter === "In production" && ["Voice design", "Test scene", "Production", "Corrections", "QA"].includes(book.stage)) ||
      (filter === "Complete" && ["Mastered", "Distributed"].includes(book.stage));
    return matchesSearch && matchesFilter;
  }), [books, filter, search]);

  const complete = books.filter((book) => ["Mastered", "Distributed"].includes(book.stage)).length;
  const active = books.filter((book) => book.is_active).length;
  const totalEpisodes = books.reduce((sum, book) => sum + book.episodes_total, 0);
  const doneEpisodes = books.reduce((sum, book) => sum + book.episodes_complete, 0);

  async function saveBook(book: Book) {
    setSaving(true);
    const payload: Record<string, unknown> = { id: book.id };
    for (const [key] of checklist) payload[toCamel(key)] = Boolean(book[key]);
    Object.assign(payload, {
      title: book.title, stage: book.stage, progress: Number(book.progress),
      isActive: Boolean(book.is_active), narratorStatus: book.narrator_status,
      episodesComplete: Number(book.episodes_complete), episodesTotal: Number(book.episodes_total),
      correctionsOpen: Number(book.corrections_open), nextAction: book.next_action,
      targetDate: book.target_date, projectPath: book.project_path, notes: book.notes,
    });
    const response = await fetch("/api/books", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    setSaving(false);
    if (!response.ok) { setError("That update could not be saved."); return; }
    setSelected(null);
    await loadBooks();
  }

  async function addBook(event: React.FormEvent) {
    event.preventDefault();
    if (!newTitle.trim()) return;
    const response = await fetch("/api/books", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: newTitle }) });
    if (!response.ok) { setError("That title could not be added."); return; }
    setNewTitle(""); setShowAdd(false); await loadBooks();
  }

  function exportLibrary() {
    const fields: Array<keyof Book> = ["title", "stage", "progress", "narrator_status", "episodes_complete", "episodes_total", "corrections_open", "next_action", "target_date", "project_path", "notes"];
    const csv = [fields.join(","), ...books.map((book) => fields.map((field) => `"${String(book[field] ?? "").replaceAll('"', '""')}"`).join(","))].join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    link.download = "audiobook-production-library.csv";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#library" aria-label="The Listening Room home">
          <span className="brand-mark">LR</span>
          <span><strong>The Listening Room</strong><small>Audiobook production shelf</small></span>
        </a>
        <div className="header-actions">
          <button className="button ghost" onClick={exportLibrary}>Export library</button>
          <button className="button primary" onClick={() => setShowAdd(true)}>＋ Add a book</button>
        </div>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">Your production library</p>
          <h1>Eight stories.<br/><em>One clear path forward.</em></h1>
          <p className="hero-copy">Keep every narrator decision, production milestone, and correction in view—without losing the story behind the work.</p>
        </div>
        <div className="hero-ornament" aria-hidden="true"><span>8</span><small>books on the shelf</small></div>
      </section>

      <section className="summary" aria-label="Library summary">
        <div><span>Library</span><strong>{books.length}</strong><small>total books</small></div>
        <div><span>Now working</span><strong>{active}</strong><small>active production</small></div>
        <div><span>Finished</span><strong>{complete}</strong><small>approved masters</small></div>
        <div><span>Episodes</span><strong>{doneEpisodes}<i>/{totalEpisodes || "—"}</i></strong><small>complete</small></div>
      </section>

      <section className="library" id="library">
        <div className="section-head">
          <div><p className="eyebrow">The shelf</p><h2>Production overview</h2></div>
          <div className="tools">
            <label className="search"><span>⌕</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a title" aria-label="Find a title" /></label>
            <div className="filters" aria-label="Filter books">{["All books", "Active", "In production", "Complete"].map((item) => <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item}</button>)}</div>
          </div>
        </div>

        {error && <p className="error" role="alert">{error}</p>}
        {loading ? <div className="loading">Opening your library…</div> : (
          <div className="book-grid">
            {visible.map((book, index) => (
              <button className={`book-card ${book.is_active ? "current" : ""}`} key={book.id} onClick={() => setSelected({ ...book })}>
                <span className="card-number">{String(index + 1).padStart(2, "0")}</span>
                <span className="book-spine" aria-hidden="true" />
                <span className="card-top"><span className={`stage stage-${book.stage.toLowerCase().replaceAll(" ", "-")}`}>{book.stage}</span>{book.is_active ? <span className="active-label">Now working</span> : null}</span>
                <strong>{book.title}</strong>
                <span className="next-label">Next</span>
                <span className="next-action">{book.next_action}</span>
                <span className="progress-line"><span style={{ width: `${book.progress}%` }} /></span>
                <span className="card-foot"><span>{book.progress}% complete</span><span>{book.target_date ? formatDate(book.target_date) : "Open schedule"} →</span></span>
              </button>
            ))}
          </div>
        )}
      </section>

      <footer><span>The Listening Room</span><p>Made for a library worth hearing.</p><span>Private production record</span></footer>

      {selected && <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setSelected(null); }}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-title">
          <div className="modal-head"><div><p className="eyebrow">Book record</p><h2 id="edit-title">{selected.title}</h2></div><button className="close" onClick={() => setSelected(null)} aria-label="Close">×</button></div>
          <div className="form-grid">
            <label>Production stage<select value={selected.stage} onChange={(e) => setSelected({ ...selected, stage: e.target.value })}>{stages.map((stage) => <option key={stage}>{stage}</option>)}</select></label>
            <label>Narrator status<select value={selected.narrator_status} onChange={(e) => setSelected({ ...selected, narrator_status: e.target.value })}>{narratorStates.map((status) => <option key={status}>{status}</option>)}</select></label>
            <label className="wide">Overall progress <span className="range-value">{selected.progress}%</span><input type="range" min="0" max="100" value={selected.progress} onChange={(e) => setSelected({ ...selected, progress: Number(e.target.value) })} /></label>
            <label>Episodes complete<input type="number" min="0" value={selected.episodes_complete} onChange={(e) => setSelected({ ...selected, episodes_complete: Number(e.target.value) })} /></label>
            <label>Total episodes<input type="number" min="0" value={selected.episodes_total} onChange={(e) => setSelected({ ...selected, episodes_total: Number(e.target.value) })} /></label>
            <label>Open corrections<input type="number" min="0" value={selected.corrections_open} onChange={(e) => setSelected({ ...selected, corrections_open: Number(e.target.value) })} /></label>
            <label>Target date<input type="date" value={selected.target_date} onChange={(e) => setSelected({ ...selected, target_date: e.target.value })} /></label>
            <label className="wide">Next action<input value={selected.next_action} onChange={(e) => setSelected({ ...selected, next_action: e.target.value })} /></label>
            <label className="wide">Project folder<input value={selected.project_path} onChange={(e) => setSelected({ ...selected, project_path: e.target.value })} placeholder="/Volumes/ExternalDrive/Audiobook Projects/…" /></label>
            <label className="wide">Notes<textarea rows={4} value={selected.notes} onChange={(e) => setSelected({ ...selected, notes: e.target.value })} placeholder="Pronunciations, pacing notes, release plans…" /></label>
          </div>
          <div className="checklist"><h3>Production gates</h3>{checklist.map(([key, label]) => <label key={key}><input type="checkbox" checked={Boolean(selected[key])} onChange={(e) => setSelected({ ...selected, [key]: Number(e.target.checked) })} /><span>{label}</span></label>)}</div>
          <div className="modal-foot"><label className="active-toggle"><input type="checkbox" checked={Boolean(selected.is_active)} onChange={(e) => setSelected({ ...selected, is_active: Number(e.target.checked) })} /> Mark as currently working</label><div><button className="button ghost" onClick={() => setSelected(null)}>Cancel</button><button className="button primary" disabled={saving} onClick={() => saveBook(selected)}>{saving ? "Saving…" : "Save book"}</button></div></div>
        </section>
      </div>}

      {showAdd && <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowAdd(false); }}><form className="add-modal" onSubmit={addBook}><div className="modal-head"><div><p className="eyebrow">Grow the shelf</p><h2>Add another book</h2></div><button type="button" className="close" onClick={() => setShowAdd(false)} aria-label="Close">×</button></div><label>Book title<input autoFocus value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Enter the title" /></label><div className="modal-foot"><button type="button" className="button ghost" onClick={() => setShowAdd(false)}>Cancel</button><button className="button primary" type="submit">Add to library</button></div></form></div>}
    </main>
  );
}
