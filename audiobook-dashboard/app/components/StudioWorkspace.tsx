"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { listBooks, saveBook, type FirestoreBook } from "@/lib/firebase/books";
import { listAllMaterials, listMaterials, readMaterialText, type MaterialRecord } from "@/lib/firebase/materials";
import { buildScenesFromManuscript } from "@/lib/studio/workflow";
import { listScenes, replaceScenes, saveScene, type SceneRecord, type StudioSpeaker } from "@/lib/firebase/scenes";

type TabKey = "text" | "voices" | "sfx" | "ambience" | "render";

const tabs: Array<{ key: TabKey; label: string }> = [
  { key: "text", label: "Scene text" },
  { key: "voices", label: "Voices" },
  { key: "sfx", label: "Sound effects" },
  { key: "ambience", label: "Ambience / music" },
  { key: "render", label: "Final mix" },
];

function isLikelyManuscript(material: MaterialRecord) {
  const lowerName = material.name.toLowerCase();
  return material.category === "Manuscript"
    || material.content_type.startsWith("text/")
    || lowerName.endsWith(".txt")
    || lowerName.endsWith(".md");
}

export default function StudioWorkspace({ bookId }: { bookId: string }) {
  const [book, setBook] = useState<FirestoreBook | null>(null);
  const [scenes, setScenes] = useState<SceneRecord[]>([]);
  const [activeSceneId, setActiveSceneId] = useState("");
  const [tab, setTab] = useState<TabKey>("text");
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [savingSceneId, setSavingSceneId] = useState("");
  const [sceneStatus, setSceneStatus] = useState("");
  const [error, setError] = useState("");
  const [manuscriptText, setManuscriptText] = useState("");
  const [manuscriptSourceName, setManuscriptSourceName] = useState("");
  const [manuscriptSourceHint, setManuscriptSourceHint] = useState("");
  const attemptedAutoImport = useRef(false);

  async function findUploadedManuscript(targetBookId: string, targetBookTitle?: string | null) {
    const directMaterials = await listMaterials(targetBookId);
    const directManuscript = directMaterials.find(isLikelyManuscript);
    if (directManuscript) {
      return {
        material: directManuscript,
        sourceBookId: targetBookId,
        sourceBookTitle: targetBookTitle ?? "",
        text: await readMaterialText(directManuscript),
      };
    }

    if (!targetBookTitle) return null;

    const [books, allMaterials] = await Promise.all([listBooks(), listAllMaterials()]);
    const matchingBookIds = new Set(
      books
        .filter((entry) => entry.title.trim().toLowerCase() === targetBookTitle.trim().toLowerCase())
        .map((entry) => entry.id),
    );

    const fallbackMaterial = allMaterials.find((material) => matchingBookIds.has(material.book_id) && isLikelyManuscript(material));
    if (!fallbackMaterial) return null;

    const sourceBook = books.find((entry) => entry.id === fallbackMaterial.book_id);
    return {
      material: fallbackMaterial,
      sourceBookId: fallbackMaterial.book_id,
      sourceBookTitle: sourceBook?.title ?? targetBookTitle,
      text: await readMaterialText(fallbackMaterial),
    };
  }

  async function buildScenes(text: string, sourceName?: string) {
    if (!book || !text.trim()) return;
    const built = buildScenesFromManuscript(book.id, text);
    const previewScenes: SceneRecord[] = built.map((scene, index) => ({
      id: `preview-${index + 1}`,
      ...scene,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));
    setScenes(previewScenes);
    setActiveSceneId(previewScenes[0]?.id || "");
    setManuscriptText(text);
    if (sourceName) setManuscriptSourceName(sourceName);
    setSceneStatus("");
    setTab("text");
    const savedScenes = await replaceScenes(book.id, built);
    setScenes(savedScenes);
    setActiveSceneId(savedScenes[0]?.id || "");
    const updatedBook = {
      ...book,
      stage: "Manuscript prep",
      progress: 15,
      manuscript_ready: 1,
      notes: `MANUSCRIPT::${text}`,
      next_action: "Review scene text and approve the first voice recommendations.",
    };
    await saveBook(updatedBook);
    setBook(updatedBook);
  }

  async function loadWorkspace() {
    setLoading(true);
    try {
      const [books, studioScenes] = await Promise.all([listBooks(), listScenes(bookId)]);
      const currentBook = books.find((entry) => entry.id === bookId) ?? null;
      setBook(currentBook);
      setScenes(studioScenes);
      setActiveSceneId((current) => current || studioScenes[0]?.id || "");
      setManuscriptSourceHint("");
      if (currentBook?.notes?.startsWith("MANUSCRIPT::")) {
        setManuscriptText(currentBook.notes.slice("MANUSCRIPT::".length));
      }
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open this studio.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadWorkspace();
  }, [bookId]);

  useEffect(() => {
    if (loading || importing || attemptedAutoImport.current || scenes.length || !book) return;
    if (manuscriptText.trim()) return;

    attemptedAutoImport.current = true;
    (async () => {
      try {
        const uploaded = await findUploadedManuscript(book.id, book.title);
      if (!uploaded?.text.trim()) return;
      setManuscriptText(uploaded.text);
      setManuscriptSourceName(uploaded.material.name);
      setManuscriptSourceHint(uploaded.sourceBookId !== book.id ? `Recovered from another "${uploaded.sourceBookTitle}" record.` : "");
      await buildScenes(uploaded.text, uploaded.material.name);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not turn the uploaded manuscript into scenes.");
      }
    })();
  }, [book, scenes, loading, importing, manuscriptText]);

  const activeScene = useMemo(
    () => scenes.find((scene) => scene.id === activeSceneId) ?? scenes[0] ?? null,
    [activeSceneId, scenes],
  );

  async function importManuscript() {
    if (!book || !manuscriptText.trim()) return;
    setImporting(true);
    try {
      await buildScenes(manuscriptText, manuscriptSourceName);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not build scenes from this manuscript.");
    } finally {
      setImporting(false);
    }
  }

  async function importUploadedManuscript() {
    if (!book) return;
    setImporting(true);
    try {
      const uploaded = await findUploadedManuscript(book.id, book.title);
      if (!uploaded?.text.trim()) throw new Error("No uploaded manuscript text file was found for this book yet.");
      setManuscriptText(uploaded.text);
      setManuscriptSourceName(uploaded.material.name);
      setManuscriptSourceHint(uploaded.sourceBookId !== book.id ? `Recovered from another "${uploaded.sourceBookTitle}" record.` : "");
      await buildScenes(uploaded.text, uploaded.material.name);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not build scenes from the uploaded manuscript.");
    } finally {
      setImporting(false);
    }
  }

  async function updateScene(scene: SceneRecord) {
    if (scene.id.startsWith("preview-")) {
      setSceneStatus("Your scenes are still finishing their first save. Give it a moment, then try again.");
      return;
    }
    setScenes((current) => current.map((entry) => (entry.id === scene.id ? scene : entry)));
    setSavingSceneId(scene.id);
    setSceneStatus("");
    try {
      await saveScene(scene);
      setSceneStatus(`Saved ${scene.title}.`);
    } catch (err) {
      setSceneStatus(err instanceof Error ? err.message : "Could not save this scene yet.");
    } finally {
      setSavingSceneId("");
    }
  }

  async function approveVoices() {
    if (!activeScene) return;
    await updateScene({
      ...activeScene,
      speakers: activeScene.speakers.map((speaker) => ({ ...speaker, status: "approved" })),
      final_mix_status: "voices_approved",
    });
  }

  async function toggleCue(kind: "sfx_cues" | "ambience_cues", cueId: string) {
    if (!activeScene) return;
    const cues = activeScene[kind].map((cue) => (cue.id === cueId ? { ...cue, approved: !cue.approved } : cue));
    await updateScene({
      ...activeScene,
      [kind]: cues,
      final_mix_status:
        kind === "sfx_cues"
          ? "sfx_approved"
          : "ambience_approved",
    });
  }

  async function markReadyToRender() {
    if (!activeScene) return;
    await updateScene({ ...activeScene, final_mix_status: "ready_to_render" });
  }

  if (loading) {
    return <main className="studio-shell"><div className="loading">Opening your unified studio…</div></main>;
  }

  return (
    <main className="studio-shell">
      <header className="studio-topbar">
        <div>
          <p className="eyebrow">One Listening Room</p>
          <h1>{book?.title ?? "Studio"}</h1>
          <p className="studio-subtitle">Manuscript, scenes, voices, effects, ambience, and final mix now live in one app space.</p>
        </div>
        <div className="studio-top-actions">
          <Link className="button ghost" href="/">Back to shelf</Link>
        </div>
      </header>

      {error && <p className="error" role="alert">{error}</p>}

      <section className="studio-summary-bar">
        <div><span>Scenes</span><strong>{scenes.length || "—"}</strong></div>
        <div><span>Voices</span><strong>{activeScene?.speakers.length || "—"}</strong></div>
        <div><span>Effects</span><strong>{activeScene?.sfx_cues.length || "—"}</strong></div>
        <div><span>Ambience</span><strong>{activeScene?.ambience_cues.length || "—"}</strong></div>
      </section>

      <section className="unified-studio-grid">
        <aside className="studio-sidebar">
          <div className="card">
            <h2>Manuscript import</h2>
            <p className="muted">Paste text here, or pull from the uploaded manuscript file for this book. The Listening Room will split it into 3 to 5 minute production scenes inside this same app.</p>
            {manuscriptSourceName && (
              <p className="muted">Linked manuscript file: <strong>{manuscriptSourceName}</strong></p>
            )}
            {manuscriptSourceHint && (
              <p className="muted">{manuscriptSourceHint}</p>
            )}
            <textarea
              className="studio-manuscript"
              value={manuscriptText}
              onChange={(event) => setManuscriptText(event.target.value)}
              placeholder="Paste the manuscript text here…"
            />
            <div className="actions">
              <button className="button ghost" disabled={importing} onClick={importUploadedManuscript}>
                {importing ? "Reading manuscript…" : "Use uploaded manuscript file"}
              </button>
              <button className="button primary" disabled={importing || !manuscriptText.trim()} onClick={importManuscript}>
                {importing ? "Building scenes…" : "Build scenes from manuscript"}
              </button>
            </div>
          </div>

          <div className="card">
            <h2>Scene list</h2>
            {scenes.length ? (
              <div className="scene-stack">
                {scenes.map((scene) => (
                  <button
                    key={scene.id}
                    className={`scene-pill ${activeScene?.id === scene.id ? "active" : ""}`}
                    onClick={() => setActiveSceneId(scene.id)}
                  >
                    <strong>{scene.scene_order}. {scene.title}</strong>
                    <small>{scene.estimated_minutes} min · {scene.final_mix_status.replaceAll("_", " ")}</small>
                  </button>
                ))}
              </div>
            ) : (
              <p className="materials-empty">No scenes yet. Import the manuscript to create the first scene-by-scene workflow here.</p>
            )}
          </div>
        </aside>

        <section className="studio-main-panel">
          {activeScene ? (
            <>
              <div className="tabs studio-tabs">
                {tabs.map((entry) => (
                  <button key={entry.key} className={tab === entry.key ? "active" : ""} onClick={() => setTab(entry.key)}>
                    {entry.label}
                  </button>
                ))}
              </div>

              <div className="card studio-scene-card">
                <div className="studio-scene-head">
                  <div>
                    <p className="eyebrow">Scene {activeScene.scene_order}</p>
                    <h2>{activeScene.title}</h2>
                  </div>
                  <span className="studio-status">{activeScene.final_mix_status.replaceAll("_", " ")}</span>
                </div>

                {tab === "text" && (
                  <>
                    <p className="muted">This is the working scene text that the rest of the approvals flow builds from.</p>
                    <textarea
                      className="studio-scene-text"
                      value={activeScene.text}
                      onChange={(event) => {
                        setSceneStatus("");
                        setScenes((current) => current.map((scene) => scene.id === activeScene.id ? { ...scene, text: event.target.value } : scene));
                      }}
                    />
                    <div className="actions">
                      <button className="button primary" disabled={savingSceneId === activeScene.id || activeScene.id.startsWith("preview-")} onClick={() => updateScene({ ...activeScene, text: activeScene.text })}>
                        {savingSceneId === activeScene.id ? "Saving scene…" : "Save scene text"}
                      </button>
                    </div>
                    {sceneStatus && <p className="muted">{sceneStatus}</p>}
                  </>
                )}

                {tab === "voices" && (
                  <>
                    <p className="muted">The Listening Room has identified likely speaking characters in this scene and assigned starter voice recommendations.</p>
                    <div className="studio-list">
                      {activeScene.speakers.length ? activeScene.speakers.map((speaker, index) => (
                        <div className="studio-row" key={`${speaker.name}-${index}`}>
                          <div>
                            <strong>{speaker.name}</strong>
                            <small>{speaker.line_count} lines</small>
                          </div>
                          <input
                            value={speaker.approved_voice}
                            onChange={(event) => {
                              const speakers: StudioSpeaker[] = activeScene.speakers.map((entry) => entry.name === speaker.name ? { ...entry, approved_voice: event.target.value, status: "rejected" as const } : entry);
                              setScenes((current) => current.map((scene) => scene.id === activeScene.id ? { ...scene, speakers } : scene));
                            }}
                          />
                        </div>
                      )) : <p className="materials-empty">No named speakers were found in this scene yet.</p>}
                    </div>
                    <div className="actions">
                      <button className="button primary" onClick={approveVoices}>Approve voice recommendations</button>
                    </div>
                  </>
                )}

                {tab === "sfx" && (
                  <>
                    <p className="muted">Suggested sound effects are based on scene language and can be approved or denied here.</p>
                    <div className="studio-list">
                      {activeScene.sfx_cues.length ? activeScene.sfx_cues.map((cue) => (
                        <label className="studio-cue" key={cue.id}>
                          <input type="checkbox" checked={cue.approved} onChange={() => toggleCue("sfx_cues", cue.id)} />
                          <span><strong>{cue.label}</strong><small>{cue.reason}</small></span>
                        </label>
                      )) : <p className="materials-empty">No obvious sound-effect moments were suggested for this scene yet.</p>}
                    </div>
                  </>
                )}

                {tab === "ambience" && (
                  <>
                    <p className="muted">Ambient beds and music suggestions live here so you can approve what should sit underneath the voice.</p>
                    <div className="studio-list">
                      {activeScene.ambience_cues.length ? activeScene.ambience_cues.map((cue) => (
                        <label className="studio-cue" key={cue.id}>
                          <input type="checkbox" checked={cue.approved} onChange={() => toggleCue("ambience_cues", cue.id)} />
                          <span><strong>{cue.label}</strong><small>{cue.reason}</small></span>
                        </label>
                      )) : <p className="materials-empty">No ambience or music suggestions were generated for this scene yet.</p>}
                    </div>
                  </>
                )}

                {tab === "render" && (
                  <>
                    <p className="muted">This is the final approval gate before a future render worker creates the layered WAV.</p>
                    <div className="studio-render-card">
                      <strong>Current state</strong>
                      <small>{activeScene.final_mix_status.replaceAll("_", " ")}</small>
                    </div>
                    <div className="actions">
                      <button className="button primary" onClick={markReadyToRender}>Mark scene ready to render</button>
                    </div>
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="card">
              <h2>Start with the manuscript</h2>
              <p className="muted">Once the manuscript is imported, the scene workflow will appear here inside the same app.</p>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
