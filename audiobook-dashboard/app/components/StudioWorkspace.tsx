"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { listBooks, saveBook, type FirestoreBook } from "@/lib/firebase/books";
import { getClientStorage } from "@/lib/firebase/client";
import { listAllMaterials, listMaterials, readMaterialText, type MaterialRecord } from "@/lib/firebase/materials";
import { getLatestRenderJob, queueRenderJob, type RenderJobRecord } from "@/lib/firebase/renderJobs";
import { buildScenesFromManuscript, recommendSfxCues } from "@/lib/studio/workflow";
import { listScenes, replaceScenes, saveScene, type SceneRecord, type StudioSpeaker } from "@/lib/firebase/scenes";
import { getDownloadURL, ref } from "firebase/storage";

type TabKey = "script" | "voice" | "characters" | "sfx" | "music" | "render";

const tabs: Array<{ key: TabKey; label: string }> = [
  { key: "script", label: "1 · Text" },
  { key: "voice", label: "2 · Narration" },
  { key: "characters", label: "3 · Characters" },
  { key: "sfx", label: "4 · Sound effects" },
  { key: "music", label: "5 · Ambience / music" },
  { key: "render", label: "6 · Render" },
];

function isLikelyManuscript(material: MaterialRecord) {
  const lowerName = material.name.toLowerCase();
  return material.category === "Manuscript"
    || material.content_type.startsWith("text/")
    || lowerName.endsWith(".txt")
    || lowerName.endsWith(".md");
}

function isLocalRenderPath(path: string) {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function isLegacyCloudRenderPath(path: string) {
  return path.startsWith("renders/");
}

export default function StudioWorkspace({ bookId }: { bookId: string }) {
  const [book, setBook] = useState<FirestoreBook | null>(null);
  const [scenes, setScenes] = useState<SceneRecord[]>([]);
  const [activeSceneId, setActiveSceneId] = useState("");
  const [tab, setTab] = useState<TabKey>("script");
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [savingSceneId, setSavingSceneId] = useState("");
  const [sceneStatus, setSceneStatus] = useState("");
  const [renderJob, setRenderJob] = useState<RenderJobRecord | null>(null);
  const [renderArtifactUrl, setRenderArtifactUrl] = useState("");
  const [error, setError] = useState("");
  const [manuscriptText, setManuscriptText] = useState("");
  const [manuscriptSourceName, setManuscriptSourceName] = useState("");
  const [manuscriptSourceHint, setManuscriptSourceHint] = useState("");
  const attemptedAutoImport = useRef(false);

  function approval(scene: SceneRecord | null, key: "script" | "voice" | "draft" | "sfx" | "music") {
    return Boolean(scene?.approvals?.[key]);
  }

  function nextSceneId(currentId: string) {
    const currentIndex = scenes.findIndex((scene) => scene.id === currentId);
    return scenes[currentIndex + 1]?.id ?? "";
  }

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
    setTab("script");
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
  const soundDesignPlan = activeScene?.render_sound_design_plan ?? renderJob?.sound_design_plan;
  const soundDesignItems = soundDesignPlan?.items ?? [];
  const soundDesignUnmatched = soundDesignPlan?.unmatched ?? [];

  useEffect(() => {
    if (!activeScene?.id || activeScene.id.startsWith("preview-")) {
      setRenderJob(null);
      setRenderArtifactUrl("");
      return;
    }

    (async () => {
      try {
        setRenderJob(await getLatestRenderJob(activeScene.id));
      } catch {
        setRenderJob(null);
      }

      if (activeScene.render_output_path && !isLocalRenderPath(activeScene.render_output_path)) {
        try {
          setRenderArtifactUrl(await getDownloadURL(ref(getClientStorage(), activeScene.render_output_path)));
        } catch {
          setRenderArtifactUrl("");
        }
      } else {
        setRenderArtifactUrl("");
      }
    })();
  }, [activeScene?.id, activeScene?.render_output_path]);

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

  async function updateScene(scene: SceneRecord, nextTab?: TabKey) {
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
      if (nextTab) setTab(nextTab);
    } catch (err) {
      setSceneStatus(err instanceof Error ? err.message : "Could not save this scene yet.");
    } finally {
      setSavingSceneId("");
    }
  }

  async function approveNarratorStage() {
    if (!activeScene) return;
    await updateScene({
      ...activeScene,
      approvals: { ...activeScene.approvals, voice: true },
    }, "characters");
  }

  async function approveVoices() {
    if (!activeScene) return;
    await updateScene({
      ...activeScene,
      speakers: activeScene.speakers.map((speaker) => ({ ...speaker, status: "approved" })),
      approvals: { ...activeScene.approvals, voice: true },
      final_mix_status: "voices_approved",
    }, "sfx");
  }

  async function toggleCue(kind: "sfx_cues" | "ambience_cues", cueId: string) {
    if (!activeScene) return;
    const cues = activeScene[kind].map((cue) => (cue.id === cueId ? { ...cue, approved: !cue.approved } : cue));
    await updateScene({
      ...activeScene,
      [kind]: cues,
      approvals: {
        ...activeScene.approvals,
        ...(kind === "sfx_cues" ? { sfx: true } : { music: true }),
      },
      final_mix_status:
        kind === "sfx_cues"
          ? "sfx_approved"
          : "ambience_approved",
    }, kind === "sfx_cues" ? "music" : "render");
  }

  async function markReadyToRender() {
    if (!activeScene) return;
    const nextId = nextSceneId(activeScene.id);
    await updateScene({
      ...activeScene,
      approvals: { ...activeScene.approvals, draft: true, sfx: true, music: true },
      final_mix_status: "ready_to_render",
    });
    const job = await queueRenderJob({
      bookId: activeScene.book_id,
      sceneId: activeScene.id,
      sceneTitle: activeScene.title,
    });
    setRenderJob(job);
    await loadWorkspace();
    setSceneStatus(nextId ? "Scene queued for the local Qwen renderer. Moving to the next scene." : "Scene queued for the local Qwen renderer.");
    if (nextId) {
      setActiveSceneId(nextId);
      setTab("script");
    }
  }

  async function approveScriptAndMoveOn() {
    if (!activeScene) return;
    await updateScene({
      ...activeScene,
      approvals: { ...activeScene.approvals, script: true },
    }, "voice");
  }

  async function saveNarratorNotes() {
    if (!activeScene) return;
    await updateScene({
      ...activeScene,
      approvals: { ...activeScene.approvals, voice: false },
    });
  }

  async function refreshSfxSuggestions() {
    if (!activeScene) return;
    const existingChoices = activeScene.sfx_cues.filter((cue) => cue.approved || cue.reason === "Added manually in the studio.");
    const existingLabels = new Set(existingChoices.map((cue) => cue.label.toLowerCase()));
    const recommendations = recommendSfxCues(activeScene.text).filter((cue) => !existingLabels.has(cue.label.toLowerCase()));
    await updateScene({
      ...activeScene,
      sfx_cues: [...existingChoices, ...recommendations],
      approvals: { ...activeScene.approvals, sfx: false },
    });
    setSceneStatus(`Prepared ${recommendations.length} scene-specific sound suggestions. Nothing was approved automatically.`);
  }

  async function saveCue(kind: "sfx_cues" | "ambience_cues", values: { time: string; label: string; source: string; license: string }) {
    if (!activeScene || !values.label.trim()) return;
    const cue = {
      id: `${kind}-${Date.now()}`,
      label: values.label.trim(),
      reason: "Added manually in the studio.",
      approved: false,
      time: values.time.trim(),
      source: values.source.trim(),
      license: values.license.trim(),
    };
    await updateScene({
      ...activeScene,
      [kind]: [...activeScene[kind], cue],
    } as SceneRecord);
  }

  async function approveStageWithoutToggling(kind: "sfx" | "music") {
    if (!activeScene) return;
    await updateScene({
      ...activeScene,
      approvals: {
        ...activeScene.approvals,
        ...(kind === "sfx" ? { sfx: true } : { music: true }),
      },
      final_mix_status: kind === "sfx" ? "sfx_approved" : "ambience_approved",
    }, kind === "sfx" ? "music" : "render");
  }

  const [sfxDraft, setSfxDraft] = useState({ time: "", label: "", source: "", license: "" });
  const [musicDraft, setMusicDraft] = useState({ time: "", label: "", source: "", license: "" });

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

      {activeScene && (
        <section className="studio-summary-bar">
          <div><span>Text</span><strong>{approval(activeScene, "script") ? "Approved" : "Working"}</strong></div>
          <div><span>Voice</span><strong>{approval(activeScene, "voice") ? "Locked" : "Needs review"}</strong></div>
          <div><span>Characters</span><strong>{activeScene.speakers.every((speaker) => speaker.status === "approved") ? "Approved" : "Needs review"}</strong></div>
          <div><span>Final mix</span><strong>{approval(activeScene, "music") ? "Approved" : activeScene.final_mix_status.replaceAll("_", " ")}</strong></div>
        </section>
      )}

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

                {tab === "script" && (
                  <>
                    <p className="muted">The original manuscript stays intact. This is the working scene text the rest of the studio builds from.</p>
                    <textarea
                      className="studio-scene-text"
                      value={activeScene.text}
                      onChange={(event) => {
                        setSceneStatus("");
                        setScenes((current) => current.map((scene) => scene.id === activeScene.id ? { ...scene, text: event.target.value } : scene));
                      }}
                    />
                    <div className="actions">
                      <button className="button primary" disabled={savingSceneId === activeScene.id || activeScene.id.startsWith("preview-")} onClick={() => updateScene({ ...activeScene, text: activeScene.text }, "voice")}>
                        {savingSceneId === activeScene.id ? "Saving scene…" : "Save scene text"}
                      </button>
                      <button className="button" disabled={savingSceneId === activeScene.id} onClick={approveScriptAndMoveOn}>Approve scene text</button>
                    </div>
                    {sceneStatus && <p className="muted">{sceneStatus}</p>}
                  </>
                )}

                {tab === "voice" && (
                  <>
                    <p className="muted">Narration uses the local Qwen voice system from yesterday. This page stores the approved direction; your Mac renders the audio later, so there is no OpenAI voice charge from this screen.</p>
                    <div className="studio-render-card">
                      <strong>{activeScene.narrator || "Local Qwen narrator"}</strong>
                      <small>Render target: local Qwen worker on your Mac. Output saves to the local render folder first.</small>
                    </div>
                    <textarea
                      className="studio-scene-text"
                      style={{ minHeight: 140 }}
                      value={activeScene.voice_notes ?? ""}
                      onChange={(event) => setScenes((current) => current.map((scene) => scene.id === activeScene.id ? { ...scene, voice_notes: event.target.value } : scene))}
                      placeholder="Add narration notes: cadence, warmth, age feel, formality, intimacy, restraint…"
                    />
                    <div className="actions">
                      <button className="button primary" onClick={saveNarratorNotes}>Save narration choice</button>
                      <button className="button" onClick={approveNarratorStage}>Approve narration and continue</button>
                    </div>
                    {sceneStatus && <p className="muted">{sceneStatus}</p>}
                  </>
                )}

                {tab === "characters" && (
                  <>
                    <p className="muted">The Studio identified likely speaking parts in this scene. Approve the recommendation or replace it with something better.</p>
                    <div className="studio-list">
                      {activeScene.speakers.length ? activeScene.speakers.map((speaker, index) => (
                        <div className="studio-row" key={`${speaker.name}-${index}`}>
                          <div>
                            <strong>{speaker.name}</strong>
                            <small>{speaker.line_count} lines · {speaker.status}</small>
                          </div>
                          <div className="studio-list">
                            <input
                              value={speaker.approved_voice}
                              onChange={(event) => {
                                const speakers: StudioSpeaker[] = activeScene.speakers.map((entry) => entry.name === speaker.name ? { ...entry, approved_voice: event.target.value, status: "rejected" as const } : entry);
                                setScenes((current) => current.map((scene) => scene.id === activeScene.id ? { ...scene, speakers } : scene));
                              }}
                            />
                            <div className="actions">
                              {["Warm woman", "Warm man", "Young woman", "Young man", "Older woman", "Older man"].map((option) => (
                                <button
                                  key={`${speaker.name}-${option}`}
                                  className="button ghost"
                                  onClick={() => {
                                    const speakers: StudioSpeaker[] = activeScene.speakers.map((entry) => entry.name === speaker.name ? { ...entry, approved_voice: option, status: "rejected" as const } : entry);
                                    setScenes((current) => current.map((scene) => scene.id === activeScene.id ? { ...scene, speakers } : scene));
                                  }}
                                >
                                  {option}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      )) : <p className="materials-empty">No named speakers were found in this scene yet.</p>}
                    </div>
                    <div className="actions">
                      <button className="button primary" onClick={approveVoices}>Approve character voices and continue</button>
                    </div>
                  </>
                )}

                {tab === "sfx" && (
                  <>
                    <p className="muted">Review several possible moments, approve only the ones that help, and add your own where needed. Refreshing suggestions never auto-approves them.</p>
                    <div className="actions">
                      <button className="button" onClick={refreshSfxSuggestions}>Refresh scene-specific suggestions</button>
                    </div>
                    <div className="studio-list">
                      {activeScene.sfx_cues.length ? activeScene.sfx_cues.map((cue) => (
                        <label className="studio-cue" key={cue.id}>
                          <input type="checkbox" checked={cue.approved} onChange={() => toggleCue("sfx_cues", cue.id)} />
                          <span><strong>{cue.time ? `${cue.time} · ` : ""}{cue.label}</strong><small>{cue.source || cue.reason}{cue.license ? ` · ${cue.license}` : ""}</small></span>
                        </label>
                      )) : <p className="materials-empty">No sound-effect moments were suggested for this scene yet.</p>}
                    </div>
                    <div className="studio-list">
                      <input value={sfxDraft.time} onChange={(event) => setSfxDraft((current) => ({ ...current, time: event.target.value }))} placeholder="Timestamp" />
                      <input value={sfxDraft.label} onChange={(event) => setSfxDraft((current) => ({ ...current, label: event.target.value }))} placeholder="Effect" />
                      <input value={sfxDraft.source} onChange={(event) => setSfxDraft((current) => ({ ...current, source: event.target.value }))} placeholder="Source / library" />
                      <input value={sfxDraft.license} onChange={(event) => setSfxDraft((current) => ({ ...current, license: event.target.value }))} placeholder="License note" />
                    </div>
                    <div className="actions">
                      <button className="button" onClick={async () => { await saveCue("sfx_cues", sfxDraft); setSfxDraft({ time: "", label: "", source: "", license: "" }); }}>Add sound cue</button>
                      <button className="button primary" onClick={() => approveStageWithoutToggling("sfx")}>Approve sound effects and continue</button>
                    </div>
                  </>
                )}

                {tab === "music" && (
                  <>
                    <p className="muted">Add ambience and music only where it truly supports the scene. Silence is allowed.</p>
                    <div className="studio-list">
                      {activeScene.ambience_cues.length ? activeScene.ambience_cues.map((cue) => (
                        <label className="studio-cue" key={cue.id}>
                          <input type="checkbox" checked={cue.approved} onChange={() => toggleCue("ambience_cues", cue.id)} />
                          <span><strong>{cue.time ? `${cue.time} · ` : ""}{cue.label}</strong><small>{cue.source || cue.reason}{cue.license ? ` · ${cue.license}` : ""}</small></span>
                        </label>
                      )) : <p className="materials-empty">No ambience or music suggestions were generated for this scene yet.</p>}
                    </div>
                    <div className="studio-list">
                      <input value={musicDraft.time} onChange={(event) => setMusicDraft((current) => ({ ...current, time: event.target.value }))} placeholder="Timestamp / range" />
                      <input value={musicDraft.label} onChange={(event) => setMusicDraft((current) => ({ ...current, label: event.target.value }))} placeholder="Music direction" />
                      <input value={musicDraft.source} onChange={(event) => setMusicDraft((current) => ({ ...current, source: event.target.value }))} placeholder="Source / library" />
                      <input value={musicDraft.license} onChange={(event) => setMusicDraft((current) => ({ ...current, license: event.target.value }))} placeholder="License note" />
                    </div>
                    <div className="actions">
                      <button className="button" onClick={async () => { await saveCue("ambience_cues", musicDraft); setMusicDraft({ time: "", label: "", source: "", license: "" }); }}>Add music cue</button>
                      <button className="button primary" onClick={() => approveStageWithoutToggling("music")}>Approve music and continue</button>
                    </div>
                  </>
                )}

                {tab === "render" && (
                  <>
                    <p className="muted">Once text, narration, characters, sound effects, and ambience/music are approved, send the scene into the render queue here.</p>
                    <div className="studio-list">
                      <div className="studio-render-card"><strong>Scene text</strong><small>{approval(activeScene, "script") ? "Approved" : "Pending"}</small></div>
                      <div className="studio-render-card"><strong>Narration</strong><small>{approval(activeScene, "voice") ? "Approved" : "Pending"}</small></div>
                      <div className="studio-render-card"><strong>Characters</strong><small>{activeScene.speakers.every((speaker) => speaker.status === "approved") ? "Approved" : "Pending"}</small></div>
                      <div className="studio-render-card"><strong>With sound effects</strong><small>{approval(activeScene, "sfx") ? "Approved" : "Pending"}</small></div>
                      <div className="studio-render-card"><strong>With music background</strong><small>{approval(activeScene, "music") ? "Approved" : "Pending"}</small></div>
                    </div>
                    <div className="studio-render-card">
                      <strong>Render job</strong>
                      <small>
                        {renderJob
                          ? `${renderJob.status} · ${renderJob.render_target.replaceAll("_", " ")} · requested ${new Date(renderJob.requested_at).toLocaleString()}`
                          : "No render job queued yet."}
                      </small>
                    </div>
                    <div className="studio-render-card">
                      <strong>Render result</strong>
                      {activeScene.render_output_path ? (
                        <>
                          <small>{activeScene.render_output_path}</small>
                          {isLegacyCloudRenderPath(activeScene.render_output_path) && !soundDesignPlan && (
                            <small>Legacy cloud narration preview. New renders use the local Qwen worker and write final mixes to the Mac.</small>
                          )}
                          {renderArtifactUrl && (
                            activeScene.render_output_path.endsWith(".wav") ? (
                              <div className="render-audio-result">
                                <audio controls src={renderArtifactUrl} />
                                <a className="button ghost" href={renderArtifactUrl} target="_blank" rel="noreferrer">Open audio file</a>
                              </div>
                            ) : (
                              <div className="actions">
                                <a className="button ghost" href={renderArtifactUrl} target="_blank" rel="noreferrer">Open render artifact</a>
                              </div>
                            )
                          )}
                        </>
                      ) : (
                        <small>No render output has been written for this scene yet. The local Mac worker writes this after it picks up the queued job.</small>
                      )}
                      {activeScene.render_sound_design_plan_path && (
                        <small>Sound design plan: {activeScene.render_sound_design_plan_path}</small>
                      )}
                      {renderJob?.local_output_path && <small>Local file: {renderJob.local_output_path}</small>}
                      {activeScene.render_error_message && !activeScene.render_output_path && (
                        <small>{activeScene.render_error_message}</small>
                      )}
                    </div>
                    {soundDesignPlan && (
                      <div className="studio-render-card sound-plan-review">
                        <strong>Sound design plan</strong>
                        <small>{soundDesignPlan.planner} · {soundDesignPlan.tone || "tone pending"}</small>
                        {soundDesignPlan.scene_summary && <p className="muted">{soundDesignPlan.scene_summary}</p>}
                        {soundDesignPlan.sound_strategy && <p className="muted">{soundDesignPlan.sound_strategy}</p>}
                        {soundDesignItems.length ? (
                          <div className="sound-plan-list">
                            {soundDesignItems.map((item, index) => (
                              <div className={`sound-plan-item ${item.matched ? "" : "unmatched"}`} key={`${item.kind}-${item.label}-${index}`}>
                                <div>
                                  <strong>{item.time ? `${item.time} · ` : ""}{item.label}</strong>
                                  <small>{item.kind} · {item.matched ? item.asset_name : "No matching asset yet"}</small>
                                </div>
                                <div>
                                  {item.description && <small>{item.description}</small>}
                                  {item.reason && <small>Reason: {item.reason}</small>}
                                  {item.asset_path && <small>Asset: {item.asset_path}</small>}
                                  <small>Gain {item.gain_db} dB · fade {item.fade_in}s in / {item.fade_out}s out</small>
                                  {item.avoid && <small>Avoid: {item.avoid}</small>}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <small>No approved sound cues were included in this render.</small>
                        )}
                        {soundDesignUnmatched.length > 0 && (
                          <div className="sound-plan-unmatched">
                            <strong>Needs attention</strong>
                            {soundDesignUnmatched.map((item, index) => (
                              <small key={`${item.label}-${index}`}>{item.time ? `${item.time} · ` : ""}{item.label}: {item.reason || "No matching local asset found."}</small>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    <div className="actions">
                      <button className="button primary" onClick={markReadyToRender}>Mark scene ready for render queue</button>
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
