"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { listBooks, saveBook, type FirestoreBook } from "@/lib/firebase/books";
import { getClientStorage } from "@/lib/firebase/client";
import { listAllMaterials, listMaterials, readMaterialText, type MaterialRecord } from "@/lib/firebase/materials";
import { getLatestRenderJob, queueRenderJob, type RenderJobRecord } from "@/lib/firebase/renderJobs";
import { buildScenesFromManuscript, recommendAmbienceCues, recommendSfxCues, recommendSpeakersForEpisode } from "@/lib/studio/workflow";
import { listScenes, replaceScenes, saveScene, type SceneRecord, type StudioSpeaker } from "@/lib/firebase/scenes";
import { getDownloadURL, ref } from "firebase/storage";

type TabKey = "script" | "voice" | "characters" | "sfx" | "music" | "render";

const tabs: Array<{ key: TabKey; label: string }> = [
  { key: "script", label: "Text" },
  { key: "voice", label: "Narrator" },
  { key: "characters", label: "Speakers" },
  { key: "sfx", label: "Sound effects" },
  { key: "music", label: "Ambience" },
  { key: "render", label: "Render" },
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

  function speakersApproved(scene: SceneRecord | null) {
    if (!scene) return false;
    return (
      scene.final_mix_status === "voices_approved"
      || scene.final_mix_status === "sfx_approved"
      || scene.final_mix_status === "ambience_approved"
      || scene.final_mix_status === "ready_to_render"
      || (Boolean(scene.speakers.length) && scene.speakers.every((speaker) => speaker.status === "approved"))
    );
  }

  function canOpenTab(scene: SceneRecord | null, key: TabKey) {
    if (!scene) return false;
    if (key === "script") return true;
    if (key === "voice") return approval(scene, "script");
    if (key === "characters") return approval(scene, "voice");
    if (key === "sfx") return speakersApproved(scene);
    if (key === "music") return approval(scene, "sfx");
    return approval(scene, "music");
  }

  function nextOpenTab(scene: SceneRecord | null): TabKey {
    if (!scene || !approval(scene, "script")) return "script";
    if (!approval(scene, "voice")) return "voice";
    if (!speakersApproved(scene)) return "characters";
    if (!approval(scene, "sfx")) return "sfx";
    if (!approval(scene, "music")) return "music";
    return "render";
  }

  function stepState(scene: SceneRecord, key: TabKey) {
    if (key === "script") return approval(scene, "script") ? "Approved" : "Current";
    if (key === "voice") return approval(scene, "voice") ? "Approved" : approval(scene, "script") ? "Current" : "Locked";
    if (key === "characters") return speakersApproved(scene) ? "Approved" : approval(scene, "voice") ? "Current" : "Locked";
    if (key === "sfx") return approval(scene, "sfx") ? "Approved" : speakersApproved(scene) ? "Current" : "Locked";
    if (key === "music") return approval(scene, "music") ? "Approved" : approval(scene, "sfx") ? "Current" : "Locked";
    return approval(scene, "music") ? "Ready" : "Locked";
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
      next_action: "Review episode text and approve the first narrator recommendation.",
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
        setError(err instanceof Error ? err.message : "Could not turn the uploaded manuscript into episodes.");
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
      setError(err instanceof Error ? err.message : "Could not build episodes from this manuscript.");
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
      setError(err instanceof Error ? err.message : "Could not build episodes from the uploaded manuscript.");
    } finally {
      setImporting(false);
    }
  }

  async function updateScene(scene: SceneRecord, nextTab?: TabKey) {
    if (scene.id.startsWith("preview-")) {
      setSceneStatus("Your episodes are still finishing their first save. Give it a moment, then try again.");
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
      setSceneStatus(err instanceof Error ? err.message : "Could not save this episode yet.");
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

  async function identifySpeakers() {
    if (!activeScene) return;
    const speakers = recommendSpeakersForEpisode(activeScene.text);
    await updateScene({
      ...activeScene,
      speakers,
      approvals: { ...activeScene.approvals, voice: true },
      final_mix_status: "draft",
    });
    setSceneStatus(speakers.length
      ? `Identified ${speakers.length} likely speaker${speakers.length === 1 ? "" : "s"} for this episode.`
      : "No named speakers were found in this episode. You can still approve narration and continue.");
  }

  async function toggleCue(kind: "sfx_cues" | "ambience_cues", cueId: string) {
    if (!activeScene) return;
    const cues = activeScene[kind].map((cue) => (cue.id === cueId ? { ...cue, approved: !cue.approved } : cue));
    await updateScene({
      ...activeScene,
      [kind]: cues,
      approvals: {
        ...activeScene.approvals,
        ...(kind === "sfx_cues" ? { sfx: false } : { music: false }),
      },
      final_mix_status:
        kind === "sfx_cues"
          ? "voices_approved"
          : "sfx_approved",
    });
  }

  async function markReadyToRender() {
    if (!activeScene) return;
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
    setActiveSceneId(activeScene.id);
    setTab("render");
    setSceneStatus("Episode queued for the local Qwen renderer. Keep this episode open; the finished audio will appear here when the worker writes it.");
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
    setSceneStatus(`Prepared ${recommendations.length} episode-specific sound suggestion${recommendations.length === 1 ? "" : "s"}. Nothing was approved automatically.`);
  }

  async function refreshAmbienceSuggestions() {
    if (!activeScene) return;
    const existingChoices = activeScene.ambience_cues.filter((cue) => cue.approved || cue.reason === "Added manually in the studio.");
    const existingLabels = new Set(existingChoices.map((cue) => cue.label.toLowerCase()));
    const recommendations = recommendAmbienceCues(activeScene.text).filter((cue) => !existingLabels.has(cue.label.toLowerCase()));
    await updateScene({
      ...activeScene,
      ambience_cues: [...existingChoices, ...recommendations],
      approvals: { ...activeScene.approvals, music: false },
    });
    setSceneStatus(`Prepared ${recommendations.length} episode-specific ambience suggestion${recommendations.length === 1 ? "" : "s"}. Nothing was approved automatically.`);
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
          <p className="studio-subtitle">Create episodes from the manuscript, approve the text, choose voices, place sound, and render the final audio from one screen.</p>
        </div>
        <div className="studio-top-actions">
          <Link className="button ghost" href="/">Back to shelf</Link>
        </div>
      </header>

      {error && <p className="error" role="alert">{error}</p>}

      <section className="studio-summary-bar">
        <div><span>Episodes</span><strong>{scenes.length || "—"}</strong></div>
        <div><span>Speakers</span><strong>{activeScene?.speakers.length || "—"}</strong></div>
        <div><span>Sound effects</span><strong>{activeScene?.sfx_cues.length || "—"}</strong></div>
        <div><span>Ambience</span><strong>{activeScene?.ambience_cues.length || "—"}</strong></div>
      </section>

      {activeScene && (
        <section className="studio-summary-bar">
          <div><span>Text</span><strong>{approval(activeScene, "script") ? "Approved" : "Working"}</strong></div>
          <div><span>Narrator</span><strong>{approval(activeScene, "voice") ? "Approved" : "Needs review"}</strong></div>
          <div><span>Speakers</span><strong>{speakersApproved(activeScene) ? "Approved" : "Needs review"}</strong></div>
          <div><span>Final mix</span><strong>{approval(activeScene, "music") ? "Approved" : activeScene.final_mix_status.replaceAll("_", " ")}</strong></div>
        </section>
      )}

      <section className="unified-studio-grid">
        <aside className="studio-sidebar">
          <div className="card">
            <h2>Project setup</h2>
            <p className="muted">Upload or paste a manuscript, then The Listening Room splits it into 3 to 5 minute episodes.</p>
            {manuscriptSourceName && (
              <p className="muted">Linked manuscript file: <strong>{manuscriptSourceName}</strong></p>
            )}
            {manuscriptSourceHint && (
              <p className="muted">{manuscriptSourceHint}</p>
            )}
            <details className="studio-details" open={!scenes.length}>
              <summary>{scenes.length ? "Rebuild episodes from manuscript" : "Add manuscript"}</summary>
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
                  {importing ? "Building episodes…" : "Build episodes from manuscript"}
                </button>
              </div>
            </details>
          </div>

          <div className="card">
            <h2>Episodes</h2>
            {scenes.length ? (
              <div className="scene-stack">
                {scenes.map((scene) => (
                  <button
                    key={scene.id}
                    className={`scene-pill ${activeScene?.id === scene.id ? "active" : ""}`}
                    onClick={() => {
                      setActiveSceneId(scene.id);
                      setTab(nextOpenTab(scene));
                    }}
                  >
                    <strong>{scene.scene_order}. {scene.title}</strong>
                    <small>{scene.estimated_minutes} min · {scene.final_mix_status.replaceAll("_", " ")}</small>
                  </button>
                ))}
              </div>
            ) : (
              <p className="materials-empty">No episodes yet. Import the manuscript to create the first episode workflow here.</p>
            )}
          </div>
        </aside>

        <section className="studio-main-panel">
          {activeScene ? (
            <>
              <div className="tabs studio-tabs">
                {tabs.map((entry) => (
                  <button
                    key={entry.key}
                    className={tab === entry.key ? "active" : ""}
                    disabled={!canOpenTab(activeScene, entry.key)}
                    onClick={() => setTab(entry.key)}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>

              <div className="card studio-scene-card">
                <div className="episode-step-rail">
                  {tabs.map((entry) => (
                    <button
                      key={`step-${entry.key}`}
                      className={`episode-step ${tab === entry.key ? "active" : ""} ${canOpenTab(activeScene, entry.key) ? "" : "locked"}`}
                      disabled={!canOpenTab(activeScene, entry.key)}
                      onClick={() => setTab(entry.key)}
                    >
                      <span>{entry.label}</span>
                      <strong>{stepState(activeScene, entry.key)}</strong>
                    </button>
                  ))}
                </div>

                <div className="studio-scene-head">
                  <div>
                    <p className="eyebrow">Episode {activeScene.scene_order}</p>
                    <h2>{activeScene.title}</h2>
                  </div>
                  <span className="studio-status">{activeScene.final_mix_status.replaceAll("_", " ")}</span>
                </div>

                {tab === "script" && (
                  <>
                    <p className="muted">The original manuscript stays intact. This is the working episode text the rest of the studio builds from.</p>
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
                        {savingSceneId === activeScene.id ? "Saving episode…" : "Save episode text"}
                      </button>
                      <button className="button" disabled={savingSceneId === activeScene.id} onClick={approveScriptAndMoveOn}>Approve text → narrator</button>
                    </div>
                    {sceneStatus && <p className="muted">{sceneStatus}</p>}
                  </>
                )}

                {tab === "voice" && (
                  <>
                    <p className="muted">Narration uses the local Qwen voice system from yesterday. This page stores the approved direction; your Mac renders the audio later, so there is no OpenAI voice charge from this screen.</p>
                    <div className="studio-render-card">
                      <strong>{activeScene.narrator || "Local Qwen narrator"}</strong>
                      <small>Recommended narrator for this episode. The Mac render worker creates the audio later.</small>
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
                      <button className="button" onClick={approveNarratorStage}>Approve narrator → identify speakers</button>
                    </div>
                    {sceneStatus && <p className="muted">{sceneStatus}</p>}
                  </>
                )}

                {tab === "characters" && (
                  <>
                    <p className="muted">Identify the speaking parts in this episode, then approve or adjust each recommended voice.</p>
                    <div className="actions">
                      <button className="button" onClick={identifySpeakers}>Identify speakers in this episode</button>
                    </div>
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
                      )) : <p className="materials-empty">No speakers have been identified for this episode yet.</p>}
                    </div>
                    <div className="actions">
                      <button className="button primary" onClick={approveVoices}>Approve voices → sound effects</button>
                    </div>
                    {sceneStatus && <p className="muted">{sceneStatus}</p>}
                  </>
                )}

                {tab === "sfx" && (
                  <>
                    <p className="muted">Review several possible moments, approve only the ones that help, and add your own where needed. Refreshing suggestions never auto-approves them.</p>
                    <div className="actions">
                      <button className="button" onClick={refreshSfxSuggestions}>Suggest sound effects for this episode</button>
                    </div>
                    <div className="studio-list">
                      {activeScene.sfx_cues.length ? activeScene.sfx_cues.map((cue) => (
                        <label className="studio-cue" key={cue.id}>
                          <input type="checkbox" checked={cue.approved} onChange={() => toggleCue("sfx_cues", cue.id)} />
                          <span><strong>{cue.time ? `${cue.time} · ` : ""}{cue.label}</strong><small>{cue.source || cue.reason}{cue.license ? ` · ${cue.license}` : ""}</small></span>
                        </label>
                      )) : <p className="materials-empty">No sound-effect moments were suggested for this episode yet.</p>}
                    </div>
                    <div className="studio-list">
                      <input value={sfxDraft.time} onChange={(event) => setSfxDraft((current) => ({ ...current, time: event.target.value }))} placeholder="Timestamp" />
                      <input value={sfxDraft.label} onChange={(event) => setSfxDraft((current) => ({ ...current, label: event.target.value }))} placeholder="Effect" />
                      <input value={sfxDraft.source} onChange={(event) => setSfxDraft((current) => ({ ...current, source: event.target.value }))} placeholder="Source / library" />
                      <input value={sfxDraft.license} onChange={(event) => setSfxDraft((current) => ({ ...current, license: event.target.value }))} placeholder="License note" />
                    </div>
                    <div className="actions">
                      <button className="button" onClick={async () => { await saveCue("sfx_cues", sfxDraft); setSfxDraft({ time: "", label: "", source: "", license: "" }); }}>Add sound effect</button>
                      <button className="button primary" onClick={() => approveStageWithoutToggling("sfx")}>Approve sound effects → ambience</button>
                    </div>
                    {sceneStatus && <p className="muted">{sceneStatus}</p>}
                  </>
                )}

                {tab === "music" && (
                  <>
                    <p className="muted">Add ambience only where it supports what is happening in this episode. Silence is allowed.</p>
                    <div className="actions">
                      <button className="button" onClick={refreshAmbienceSuggestions}>Suggest ambience for this episode</button>
                    </div>
                    <div className="studio-list">
                      {activeScene.ambience_cues.length ? activeScene.ambience_cues.map((cue) => (
                        <label className="studio-cue" key={cue.id}>
                          <input type="checkbox" checked={cue.approved} onChange={() => toggleCue("ambience_cues", cue.id)} />
                          <span><strong>{cue.time ? `${cue.time} · ` : ""}{cue.label}</strong><small>{cue.source || cue.reason}{cue.license ? ` · ${cue.license}` : ""}</small></span>
                        </label>
                      )) : <p className="materials-empty">No ambience suggestions were generated for this episode yet.</p>}
                    </div>
                    <div className="studio-list">
                      <input value={musicDraft.time} onChange={(event) => setMusicDraft((current) => ({ ...current, time: event.target.value }))} placeholder="Timestamp / range" />
                      <input value={musicDraft.label} onChange={(event) => setMusicDraft((current) => ({ ...current, label: event.target.value }))} placeholder="Ambience direction" />
                      <input value={musicDraft.source} onChange={(event) => setMusicDraft((current) => ({ ...current, source: event.target.value }))} placeholder="Source / library" />
                      <input value={musicDraft.license} onChange={(event) => setMusicDraft((current) => ({ ...current, license: event.target.value }))} placeholder="License note" />
                    </div>
                    <div className="actions">
                      <button className="button" onClick={async () => { await saveCue("ambience_cues", musicDraft); setMusicDraft({ time: "", label: "", source: "", license: "" }); }}>Add ambience</button>
                      <button className="button primary" onClick={() => approveStageWithoutToggling("music")}>Approve ambience → render</button>
                    </div>
                    {sceneStatus && <p className="muted">{sceneStatus}</p>}
                  </>
                )}

                {tab === "render" && (
                  <>
                    <p className="muted">Once text, narrator, speakers, sound effects, and ambience are approved, send this episode into the local render queue. Stay here to play the finished audio when it appears.</p>
                    <div className="studio-list">
                      <div className="studio-render-card"><strong>Episode text</strong><small>{approval(activeScene, "script") ? "Approved" : "Pending"}</small></div>
                      <div className="studio-render-card"><strong>Narrator</strong><small>{approval(activeScene, "voice") ? "Approved" : "Pending"}</small></div>
                      <div className="studio-render-card"><strong>Speakers</strong><small>{speakersApproved(activeScene) ? "Approved" : "Pending"}</small></div>
                      <div className="studio-render-card"><strong>Sound effects</strong><small>{approval(activeScene, "sfx") ? "Approved" : "Pending"}</small></div>
                      <div className="studio-render-card"><strong>Ambience</strong><small>{approval(activeScene, "music") ? "Approved" : "Pending"}</small></div>
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
                          {isLegacyCloudRenderPath(activeScene.render_output_path) && !soundDesignPlan && (
                            <small>Legacy cloud narration preview. New renders use the local Qwen worker and write final mixes on the Mac.</small>
                          )}
                          {isLocalRenderPath(activeScene.render_output_path) && (
                            <small>Rendered on the Mac. Upload or share the file to play it inside this browser.</small>
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
                        <small>No render output has been written for this episode yet. The local Mac worker writes this after it picks up the queued job.</small>
                      )}
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
                    <details className="studio-details advanced-render-details">
                      <summary>Advanced render details</summary>
                      <div className="studio-list">
                        <div className="studio-render-card">
                          <strong>Job details</strong>
                          <small>{renderJob ? `Status: ${renderJob.status}` : "No job record loaded."}</small>
                          {renderJob && <small>Target: {renderJob.render_target.replaceAll("_", " ")}</small>}
                          {renderJob && <small>Requested: {new Date(renderJob.requested_at).toLocaleString()}</small>}
                        </div>
                        <div className="studio-render-card">
                          <strong>Files</strong>
                          {activeScene.render_output_path && <small>Output: {activeScene.render_output_path}</small>}
                          {activeScene.render_sound_design_plan_path && <small>Sound design plan: {activeScene.render_sound_design_plan_path}</small>}
                          {renderJob?.local_output_path && <small>Local file: {renderJob.local_output_path}</small>}
                          {soundDesignItems.some((item) => item.asset_path) && (
                            <small>Matched assets are stored in the sound design plan.</small>
                          )}
                        </div>
                        {activeScene.render_error_message && (
                          <div className="studio-render-card">
                            <strong>Last render error</strong>
                            <small>{activeScene.render_error_message}</small>
                          </div>
                        )}
                      </div>
                    </details>
                    <div className="actions">
                      <button className="button primary" onClick={markReadyToRender}>Render this episode</button>
                    </div>
                    {sceneStatus && <p className="muted">{sceneStatus}</p>}
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="card">
              <h2>Start with the manuscript</h2>
              <p className="muted">Once the manuscript is imported, the episode workflow will appear here inside the same app.</p>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
