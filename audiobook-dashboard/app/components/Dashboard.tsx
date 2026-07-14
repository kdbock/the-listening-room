"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { createBook, listBooks, saveBook as persistBook, type FirestoreBook } from "@/lib/firebase/books";
import {
  deleteMaterialFile,
  downloadMaterialUrl,
  listMaterials,
  uploadMaterialFile,
  type MaterialRecord,
} from "@/lib/firebase/materials";
import {
  deleteSoundFile,
  downloadSoundUrl,
  listSounds,
  uploadSoundFile,
  type SoundDraft,
  type SoundRecord,
} from "@/lib/firebase/sounds";

type Book = FirestoreBook;

type Material = MaterialRecord;
type Sound = SoundRecord;

type ArchiveSound = {
  id: string;
  name: string;
  source: string;
  bundle: string;
  pack: string;
  kind: string;
  relativePath: string;
  tags: string[];
};

type ArchiveIndex = {
  createdAt: string;
  total: number;
  items: ArchiveSound[];
};

const archiveQueueKey = "listening-room-archive-queue";

const stages = ["Not started", "Manuscript prep", "Voice design", "Test scene", "Production", "Corrections", "QA", "Mastered", "Distributed"];
const narratorStates = ["Not designed", "Auditions ready", "Approved", "Locked"];
const materialCategories = ["Manuscript", "Audio", "Voice reference", "Artwork", "Production notes", "Export", "Other"];
const soundCategories = ["Sound effect", "Ambience", "Music", "Foley", "Transition", "Texture", "Other"];
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

function formatBytes(bytes: number) {
  if (!bytes) return "Size unavailable";
  const units = ["B", "KB", "MB", "GB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

export default function Dashboard() {
  const router = useRouter();
  const [books, setBooks] = useState<Book[]>([]);
  const [selected, setSelected] = useState<Book | null>(null);
  const [filter, setFilter] = useState("All books");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [error, setError] = useState("");
  const [materials, setMaterials] = useState<Material[]>([]);
  const [materialUrls, setMaterialUrls] = useState<Record<string, string>>({});
  const [materialsLoading, setMaterialsLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [materialCategory, setMaterialCategory] = useState("Manuscript");
  const [fileInputKey, setFileInputKey] = useState(0);
  const [showSounds, setShowSounds] = useState(false);
  const [sounds, setSounds] = useState<Sound[]>([]);
  const [soundUrls, setSoundUrls] = useState<Record<string, string>>({});
  const [soundsLoading, setSoundsLoading] = useState(false);
  const [soundUploading, setSoundUploading] = useState(false);
  const [soundInputKey, setSoundInputKey] = useState(0);
  const [soundDraft, setSoundDraft] = useState<SoundDraft>({ category: "Sound effect", sourceUrl: "", license: "", attribution: "", notes: "" });
  const [archiveIndex, setArchiveIndex] = useState<ArchiveIndex | null>(null);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveSearch, setArchiveSearch] = useState("");
  const [archiveKind, setArchiveKind] = useState("All types");
  const [archiveQueue, setArchiveQueue] = useState<ArchiveSound[]>([]);

  async function loadBooks() {
    try {
      setBooks(await listBooks());
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your library.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadBooks(); }, []);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(archiveQueueKey);
      if (!saved) return;
      const parsed = JSON.parse(saved) as ArchiveSound[];
      if (Array.isArray(parsed)) setArchiveQueue(parsed);
    } catch {
      window.localStorage.removeItem(archiveQueueKey);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(archiveQueueKey, JSON.stringify(archiveQueue));
  }, [archiveQueue]);

  async function loadMaterials(bookId: string) {
    setMaterialsLoading(true);
    try {
      setMaterials(await listMaterials(bookId));
      setMaterialUrls({});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open this book's files.");
    } finally {
      setMaterialsLoading(false);
    }
  }

  function openBook(book: Book) {
    if (book.is_active) {
      router.push(`/studio/${book.id}`);
      return;
    }
    setSelected({ ...book });
    setMaterials([]);
    loadMaterials(book.id);
  }

  async function uploadMaterial(file: File) {
    const currentBook = selected;
    if (!currentBook) return;
    setUploading(true);
    try {
      await uploadMaterialFile(currentBook.id, materialCategory, file);
      await loadMaterials(currentBook.id);
      setFileInputKey((key) => key + 1);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "That file could not be stored.");
    } finally {
      setUploading(false);
    }
  }

  async function deleteMaterial(material: Material) {
    const currentBook = selected;
    if (!currentBook || !window.confirm(`Remove “${material.name}” from this book?`)) return;
    try {
      await deleteMaterialFile(material);
    } catch {
      setError("That file could not be removed.");
      return;
    }
    await loadMaterials(currentBook.id);
  }

  async function loadSounds() {
    setSoundsLoading(true);
    try {
      setSounds(await listSounds());
      setSoundUrls({});
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open the sound library.");
    } finally {
      setSoundsLoading(false);
    }
  }

  async function loadArchiveIndex() {
    setArchiveLoading(true);
    try {
      const response = await fetch("/sound-archive-index.json", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not open your sound archive index.");
      setArchiveIndex(await response.json());
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open your sound archive index.");
    } finally {
      setArchiveLoading(false);
    }
  }

  function openSoundLibrary() {
    setShowSounds(true);
    loadSounds();
    if (!archiveIndex && !archiveLoading) loadArchiveIndex();
  }

  async function uploadSound(file: File) {
    setSoundUploading(true);
    try {
      await uploadSoundFile(file, soundDraft);
      await loadSounds();
      setSoundInputKey((key) => key + 1);
      setSoundDraft({ ...soundDraft, sourceUrl: "", license: "", attribution: "", notes: "" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "That sound could not be stored.");
    } finally {
      setSoundUploading(false);
    }
  }

  async function deleteSound(sound: Sound) {
    if (!window.confirm(`Remove “${sound.name}” from the sound library?`)) return;
    try {
      await deleteSoundFile(sound);
    } catch {
      setError("That sound could not be removed.");
      return;
    }
    await loadSounds();
  }

  useEffect(() => {
    let active = true;
    if (!materials.length) return;
    (async () => {
      const entries = await Promise.all(materials.map(async (material) => {
        try {
          return [material.id, await downloadMaterialUrl(material)] as const;
        } catch {
          return [material.id, ""] as const;
        }
      }));
      if (active) setMaterialUrls(Object.fromEntries(entries.filter(([, url]) => url)));
    })();
    return () => { active = false; };
  }, [materials]);

  useEffect(() => {
    let active = true;
    if (!sounds.length) return;
    (async () => {
      const entries = await Promise.all(sounds.map(async (sound) => {
        try {
          return [sound.id, await downloadSoundUrl(sound)] as const;
        } catch {
          return [sound.id, ""] as const;
        }
      }));
      if (active) setSoundUrls(Object.fromEntries(entries.filter(([, url]) => url)));
    })();
    return () => { active = false; };
  }, [sounds]);

  function queueArchiveSound(sound: ArchiveSound) {
    setArchiveQueue((current) => current.some((item) => item.id === sound.id) ? current : [sound, ...current]);
  }

  function removeQueuedArchiveSound(id: string) {
    setArchiveQueue((current) => current.filter((item) => item.id !== id));
  }

  function clearArchiveQueue() {
    setArchiveQueue([]);
  }

  const visible = useMemo(() => books.filter((book) => {
    const matchesSearch = book.title.toLowerCase().includes(search.toLowerCase());
    const matchesFilter = filter === "All books" ||
      (filter === "Active" && Boolean(book.is_active)) ||
      (filter === "In production" && ["Voice design", "Test scene", "Production", "Corrections", "QA"].includes(book.stage)) ||
      (filter === "Complete" && ["Mastered", "Distributed"].includes(book.stage));
    return matchesSearch && matchesFilter;
  }), [books, filter, search]);

  const archiveKinds = useMemo(() => {
    const kinds = new Set<string>();
    archiveIndex?.items.forEach((item) => kinds.add(item.kind));
    return ["All types", ...Array.from(kinds).sort((a, b) => a.localeCompare(b))];
  }, [archiveIndex]);

  const archiveMatches = useMemo(() => {
    const query = archiveSearch.trim().toLowerCase();
    const items = archiveIndex?.items ?? [];
    return items.filter((item) => {
      const matchesKind = archiveKind === "All types" || item.kind === archiveKind;
      if (!matchesKind) return false;
      if (!query) return true;
      const haystack = [
        item.name,
        item.source,
        item.bundle,
        item.pack,
        item.kind,
        item.relativePath,
        item.tags.join(" "),
      ].join(" ").toLowerCase();
      return haystack.includes(query);
    }).slice(0, 60);
  }, [archiveIndex, archiveKind, archiveSearch]);

  const complete = books.filter((book) => ["Mastered", "Distributed"].includes(book.stage)).length;
  const active = books.filter((book) => book.is_active).length;
  const totalEpisodes = books.reduce((sum, book) => sum + book.episodes_total, 0);
  const doneEpisodes = books.reduce((sum, book) => sum + book.episodes_complete, 0);

  async function saveBook(book: Book) {
    setSaving(true);
    try {
      await persistBook(book);
      setSelected(null);
      await loadBooks();
      setError("");
    } catch {
      setError("That update could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function addBook(event: React.FormEvent) {
    event.preventDefault();
    if (!newTitle.trim()) return;
    try {
      await createBook(newTitle.trim());
      setNewTitle("");
      setShowAdd(false);
      await loadBooks();
      setError("");
    } catch {
      setError("That title could not be added.");
    }
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
          <button className="button ghost sound-button" onClick={openSoundLibrary}>♫ Sound library</button>
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
              <button className={`book-card ${book.is_active ? "current" : ""}`} key={book.id} onClick={() => openBook(book)}>
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
          <section className="materials" aria-labelledby="materials-title">
            <div className="materials-head">
              <div><p className="eyebrow">Stored online</p><h3 id="materials-title">Project materials</h3></div>
              <span>{materials.length} {materials.length === 1 ? "file" : "files"}</span>
            </div>
            <div className="upload-row">
              <label>File type<select value={materialCategory} onChange={(e) => setMaterialCategory(e.target.value)}>{materialCategories.map((category) => <option key={category}>{category}</option>)}</select></label>
              <label className={`upload-button ${uploading ? "disabled" : ""}`}>
                <input key={fileInputKey} type="file" disabled={uploading} onChange={(e) => { const file = e.target.files?.[0]; if (file) uploadMaterial(file); }} />
                {uploading ? "Storing file…" : "＋ Choose a file"}
              </label>
            </div>
            {materialsLoading ? <p className="materials-empty">Opening stored materials…</p> : materials.length ? (
              <ul className="material-list">{materials.map((material) => <li key={material.id}>
                <span className="file-badge">{material.category.slice(0, 1)}</span>
                <span className="file-details"><strong>{material.name}</strong><small>{material.category} · {formatBytes(material.size)} · {new Date(material.created_at).toLocaleDateString()}</small></span>
                {materialUrls[material.id] ? <a href={materialUrls[material.id]} target="_blank" rel="noreferrer" aria-label={`Download ${material.name}`}>Download</a> : <span>Preparing…</span>}
                <button type="button" onClick={() => deleteMaterial(material)} aria-label={`Remove ${material.name}`}>Remove</button>
              </li>)}</ul>
            ) : <p className="materials-empty">No files stored yet. Add the manuscript, a voice reference, audio, or any other material you want kept with this book.</p>}
          </section>
          <div className="modal-foot"><label className="active-toggle"><input type="checkbox" checked={Boolean(selected.is_active)} onChange={(e) => setSelected({ ...selected, is_active: Number(e.target.checked) })} /> Mark as currently working</label><div><button className="button ghost" onClick={() => setSelected(null)}>Cancel</button><button className="button primary" disabled={saving} onClick={() => saveBook(selected)}>{saving ? "Saving…" : "Save book"}</button></div></div>
        </section>
      </div>}

      {showSounds && <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowSounds(false); }}>
        <section className="modal sound-modal" role="dialog" aria-modal="true" aria-labelledby="sound-library-title">
          <div className="modal-head"><div><p className="eyebrow">Reusable across every book</p><h2 id="sound-library-title">Sound Library</h2></div><button className="close" onClick={() => setShowSounds(false)} aria-label="Close">×</button></div>
          <p className="sound-intro">Keep free effects, ambience, and music in one private collection. Save the source and license with every sound so attribution is ready when you publish.</p>
          <div className="sound-upload-grid">
            <label>Kind<select value={soundDraft.category} onChange={(e) => setSoundDraft({ ...soundDraft, category: e.target.value })}>{soundCategories.map((category) => <option key={category}>{category}</option>)}</select></label>
            <label>License<input value={soundDraft.license} onChange={(e) => setSoundDraft({ ...soundDraft, license: e.target.value })} placeholder="CC0, CC BY 4.0, site license…" /></label>
            <label className="wide">Source link<input type="url" value={soundDraft.sourceUrl} onChange={(e) => setSoundDraft({ ...soundDraft, sourceUrl: e.target.value })} placeholder="https://where-you-found-it.example/sound" /></label>
            <label>Creator / attribution<input value={soundDraft.attribution} onChange={(e) => setSoundDraft({ ...soundDraft, attribution: e.target.value })} placeholder="Creator name or required credit" /></label>
            <label>Notes<input value={soundDraft.notes} onChange={(e) => setSoundDraft({ ...soundDraft, notes: e.target.value })} placeholder="Dark forest, loopable, episode ideas…" /></label>
            <label className={`upload-button wide ${soundUploading ? "disabled" : ""}`}>
              <input key={soundInputKey} type="file" accept="audio/*,.wav,.mp3,.m4a,.aiff,.flac,.ogg" disabled={soundUploading} onChange={(e) => { const file = e.target.files?.[0]; if (file) uploadSound(file); }} />
              {soundUploading ? "Adding to your library…" : "＋ Choose an audio file and add it"}
            </label>
          </div>
          <div className="sound-shelf-head archive-head"><h3>Archive search</h3><span>{archiveIndex ? `${archiveIndex.total} sounds indexed` : "search your raw library"}</span></div>
          <p className="sound-intro archive-intro">Search your full Adobe and Sonniss download folders here first. When you find a likely match, you can go straight to the right pack instead of hunting around.</p>
          <div className="archive-tools">
            <label className="search archive-search"><span>⌕</span><input value={archiveSearch} onChange={(e) => setArchiveSearch(e.target.value)} placeholder="Try rain, hotel, crowd, footsteps, radio…" aria-label="Search your sound archive" /></label>
            <label className="archive-filter">Type<select value={archiveKind} onChange={(e) => setArchiveKind(e.target.value)}>{archiveKinds.map((kind) => <option key={kind}>{kind}</option>)}</select></label>
          </div>
          {archiveQueue.length ? <>
            <div className="sound-shelf-head queue-head"><h3>Import next</h3><span>{archiveQueue.length} saved</span></div>
            <ul className="archive-list queue-list">{archiveQueue.map((item) => <li key={item.id}>
              <div className="archive-title"><span className="file-badge">★</span><span><strong>{item.name}</strong><small>{item.kind} · {item.source}{item.pack ? ` · ${item.pack}` : ""}</small></span></div>
              <div className="archive-path"><span>{item.relativePath}</span></div>
              <div className="archive-actions"><button type="button" onClick={() => removeQueuedArchiveSound(item.id)}>Remove</button></div>
            </li>)}</ul>
            <div className="queue-tools"><button type="button" className="button ghost" onClick={clearArchiveQueue}>Clear shortlist</button></div>
          </> : null}
          {archiveLoading ? <p className="materials-empty">Opening your raw sound archive…</p> : archiveIndex ? (
            archiveMatches.length ? <ul className="archive-list">{archiveMatches.map((item) => <li key={item.id}>
              <div className="archive-title"><span className="file-badge">♪</span><span><strong>{item.name}</strong><small>{item.kind} · {item.source}{item.pack ? ` · ${item.pack}` : ""}</small></span></div>
              <div className="archive-path"><span>{item.relativePath}</span></div>
              <div className="archive-actions">{archiveQueue.some((queued) => queued.id === item.id) ? <span>Saved</span> : <button type="button" onClick={() => queueArchiveSound(item)}>Import next</button>}</div>
            </li>)}</ul> : <p className="materials-empty">No archive sounds matched that search yet. Try a simpler word like rain, wind, city, crowd, bell, door, train, or radio.</p>
          ) : <p className="materials-empty">The archive index is not ready yet.</p>}
          <div className="sound-shelf-head"><h3>Your collection</h3><span>{sounds.length} {sounds.length === 1 ? "sound" : "sounds"}</span></div>
          {soundsLoading ? <p className="materials-empty">Opening your sound library…</p> : sounds.length ? <ul className="sound-list">{sounds.map((sound) => <li key={sound.id}>
            <div className="sound-title"><span className="file-badge">♫</span><span><strong>{sound.name}</strong><small>{sound.category} · {formatBytes(sound.size)}{sound.license ? ` · ${sound.license}` : " · License not recorded"}</small></span></div>
            <audio controls preload="none" src={soundUrls[sound.id] || undefined} />
            <div className="sound-meta">{sound.attribution && <span>Credit: {sound.attribution}</span>}{sound.notes && <span>{sound.notes}</span>}{sound.source_url && <a href={sound.source_url} target="_blank" rel="noreferrer">View original source</a>}</div>
            <div className="sound-actions">{soundUrls[sound.id] ? <a href={soundUrls[sound.id]} target="_blank" rel="noreferrer">Download</a> : <span>Preparing…</span>}<button type="button" onClick={() => deleteSound(sound)}>Remove</button></div>
          </li>)}</ul> : <p className="materials-empty">Your sound library is empty. Add a free sound you have permission to use, along with its source and license.</p>}
        </section>
      </div>}

      {showAdd && <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowAdd(false); }}><form className="add-modal" onSubmit={addBook}><div className="modal-head"><div><p className="eyebrow">Grow the shelf</p><h2>Add another book</h2></div><button type="button" className="close" onClick={() => setShowAdd(false)} aria-label="Close">×</button></div><label>Book title<input autoFocus value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Enter the title" /></label><div className="modal-foot"><button type="button" className="button ghost" onClick={() => setShowAdd(false)}>Cancel</button><button className="button primary" type="submit">Add to library</button></div></form></div>}
    </main>
  );
}
