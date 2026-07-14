"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { listBooks, saveBook, type FirestoreBook } from "@/lib/firebase/books";
import { getClientStorage } from "@/lib/firebase/client";
import { listAllMaterials, listMaterials, readMaterialText, type MaterialRecord } from "@/lib/firebase/materials";
import { deleteRenderJob, getLatestRenderJob, queueRenderJob, type RenderJobRecord } from "@/lib/firebase/renderJobs";
import { buildScenesFromManuscript, recommendAmbienceCues, recommendSfxCues, recommendSpeakersForEpisode } from "@/lib/studio/workflow";
import { deleteScene, listScenes, replaceScenes, saveScene, type SceneRecord, type StudioDialogueAssignment, type StudioSpeaker } from "@/lib/firebase/scenes";
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

const speakerVoiceTypes = [
  { value: "female_voice_1", label: "Female voice 1", detail: "Lower / grounded" },
  { value: "female_voice_2", label: "Female voice 2", detail: "Clear / direct" },
  { value: "female_voice_3", label: "Female voice 3", detail: "Warm / expressive" },
  { value: "male_voice_1", label: "Male voice 1", detail: "Low / weathered" },
  { value: "narrator_voice", label: "Narrator voice", detail: "Use narrator for this speaker" },
];

const speakerColors = ["#f4c7c3", "#c8dfc8", "#c8d8f0", "#f1d29b", "#d6c5ee", "#bfe3df", "#efc7dc"];

function voiceTypeLabel(value: string) {
  return speakerVoiceTypes.find((option) => option.value === value)?.label || value || "No voice selected";
}

function speakerColor(speaker: StudioSpeaker, index: number) {
  return speaker.color || speakerColors[index % speakerColors.length];
}

function stripDialogueQuotes(value: string) {
  return value.trim().replace(/^[“”"]+/, "").replace(/[“”"]+$/, "").trim();
}

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
  const [manualSpeakerName, setManualSpeakerName] = useState("");
  const [selectedSpeakerName, setSelectedSpeakerName] = useState("");
  const [selectedDialogueText, setSelectedDialogueText] = useState("");
  const [selectedDialogueRange, setSelectedDialogueRange] = useState<{ start: number; end: number } | null>(null);
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

  function speakerByName(scene: SceneRecord) {
    return new Map(scene.speakers.map((speaker, index) => [
      speaker.name.toLowerCase(),
      { ...speaker, color: speakerColor(speaker, index) },
    ]));
  }

  function knownSpeaker(scene: SceneRecord, rawName: string) {
    const speakers = speakerByName(scene);
    const direct = speakers.get(rawName.trim().toLowerCase());
    if (direct) return direct.name;
    const first = rawName.trim().split(/\s+/)[0]?.toLowerCase();
    return first ? speakers.get(first)?.name || "" : "";
  }

  function nearestKnownSpeaker(scene: SceneRecord, text: string, pronoun?: string) {
    const speakers = scene.speakers.filter((speaker) => speaker.name !== "Unassigned");
    const lowerPronoun = pronoun?.toLowerCase() || "";
    const candidates = speakers
      .filter((speaker) => {
        const name = speaker.name.toLowerCase();
        const voice = speaker.approved_voice.toLowerCase();
        if (lowerPronoun === "he" || lowerPronoun === "his") {
          return voice.includes("male") || ["gregory", "greg", "john", "michael", "david"].some((known) => name.includes(known));
        }
        if (lowerPronoun === "she" || lowerPronoun === "her") {
          return voice.includes("female") || ["kimberly", "megan", "meg", "kristy", "sarah"].some((known) => name.includes(known));
        }
        return true;
      })
      .map((speaker) => {
        const firstName = speaker.name.split(/\s+/)[0] || speaker.name;
        return { speaker, position: text.toLowerCase().lastIndexOf(firstName.toLowerCase()) };
      })
      .filter((entry) => entry.position >= 0)
      .sort((left, right) => right.position - left.position);
    return candidates[0]?.speaker.name || "";
  }

  function inferQuoteSpeaker(scene: SceneRecord, quoteStart: number, quoteEnd: number) {
    const text = scene.text;
    const before = text.slice(Math.max(0, quoteStart - 140), quoteStart);
    const after = text.slice(quoteEnd, quoteEnd + 140);
    const namePattern = "([A-Z][a-zA-Z'’-]+(?:\\s+[A-Z][a-zA-Z'’-]+)?)";
    const verbs = "said|asked|replied|whispered|murmured|snapped|told|called|cried|shouted|answered";
    const afterVerbName = new RegExp(`^\\s*[,.!?—–-]*\\s*(?:${verbs})\\s+${namePattern}\\b`, "i").exec(after);
    if (afterVerbName) return knownSpeaker(scene, afterVerbName[1]);
    const afterNameVerb = new RegExp(`^\\s*[,.!?—–-]*\\s*${namePattern}\\s+(?:${verbs})\\b`, "i").exec(after);
    if (afterNameVerb) return knownSpeaker(scene, afterNameVerb[1]);
    const beforeNameVerb = new RegExp(`${namePattern}\\s+(?:${verbs})\\s*[,;:—–-]?\\s*$`, "i").exec(before);
    if (beforeNameVerb) return knownSpeaker(scene, beforeNameVerb[1]);
    const afterPronounVerb = new RegExp(`^\\s*[,.!?—–-]*\\s*(he|she)\\s+(?:${verbs})\\b`, "i").exec(after);
    if (afterPronounVerb) return nearestKnownSpeaker(scene, before, afterPronounVerb[1]);
    const beforePronounVerb = new RegExp(`\\b(he|she)\\s+(?:${verbs})\\s*[,;:—–-]?\\s*$`, "i").exec(before);
    if (beforePronounVerb) return nearestKnownSpeaker(scene, before, beforePronounVerb[1]);
    return "";
  }

  function buildDetectedDialogueAssignments(scene: SceneRecord, speakers: StudioSpeaker[]) {
    const sceneWithSpeakers = { ...scene, speakers };
    return Array.from(scene.text.matchAll(/[“"]([^”"]+)[”"]/g)).map((match, index) => {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      const speakerName = inferQuoteSpeaker(sceneWithSpeakers, start, end);
      const speakerIndex = speakers.findIndex((speaker) => speaker.name === speakerName);
      const speaker = speakerIndex >= 0 ? speakers[speakerIndex] : null;
      return {
        id: `quote-${index + 1}-${start}`,
        speaker: speaker?.name || "Unassigned",
        text: stripDialogueQuotes(match[1]),
        color: speaker ? speakerColor(speaker, speakerIndex) : "#fff3bd",
        start,
        end,
        source: "detected" as const,
        confidence: speaker ? "high" as const : "low" as const,
      };
    });
  }

  function assignmentsOverlap(left: StudioDialogueAssignment, right: StudioDialogueAssignment) {
    if (typeof left.start !== "number" || typeof left.end !== "number" || typeof right.start !== "number" || typeof right.end !== "number") {
      return false;
    }
    return left.start < right.end && right.start < left.end;
  }

  function highlightedDialogueSegments(scene: SceneRecord) {
    const text = scene.text;
    const speakers = speakerByName(scene);
    const assignments = scene.dialogue_assignments ?? [];
    const ranges: Array<{ start: number; end: number; speaker: string; color: string; missed?: boolean }> = [];

    for (const assignment of assignments) {
      if (!assignment.text.trim()) continue;
      if (typeof assignment.start === "number" && typeof assignment.end === "number" && assignment.end > assignment.start) {
        ranges.push({ start: assignment.start, end: assignment.end, speaker: assignment.speaker, color: assignment.color });
      } else {
        let start = text.indexOf(assignment.text);
        while (start >= 0) {
          ranges.push({ start, end: start + assignment.text.length, speaker: assignment.speaker, color: assignment.color });
          start = text.indexOf(assignment.text, start + assignment.text.length);
        }
      }
    }

    for (const match of text.matchAll(/[“"]([^”"]+)[”"]/g)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (ranges.some((range) => start < range.end && end > range.start)) continue;
      const speakerName = inferQuoteSpeaker(scene, start, end);
      const speaker = speakerName ? speakers.get(speakerName.toLowerCase()) : null;
      ranges.push({
        start,
        end,
        speaker: speaker?.name || "Unassigned",
        color: speaker?.color || "#fff3bd",
        missed: !speaker,
      });
    }

    ranges.sort((left, right) => left.start - right.start || right.end - left.end);
    const nonOverlapping: typeof ranges = [];
    for (const range of ranges) {
      if (nonOverlapping.some((entry) => range.start < entry.end && range.end > entry.start)) continue;
      nonOverlapping.push(range);
    }

    const segments: Array<{ text: string; start: number; end: number; speaker?: string; color?: string; missed?: boolean }> = [];
    let cursor = 0;
    for (const range of nonOverlapping) {
      if (range.start > cursor) segments.push({ text: text.slice(cursor, range.start), start: cursor, end: range.start });
      segments.push({ text: text.slice(range.start, range.end), start: range.start, end: range.end, speaker: range.speaker, color: range.color, missed: range.missed });
      cursor = range.end;
    }
    if (cursor < text.length) segments.push({ text: text.slice(cursor), start: cursor, end: text.length });
    return segments;
  }

  function unassignedDialogueCount(scene: SceneRecord | null) {
    if (!scene) return 0;
    return highlightedDialogueSegments(scene).filter((segment) => segment.missed || segment.speaker === "Unassigned").length;
  }

  function dialogueLineSegments(scene: SceneRecord) {
    return highlightedDialogueSegments(scene).filter((segment) => segment.speaker);
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

  async function deleteActiveEpisode() {
    if (!activeScene || activeScene.id.startsWith("preview-")) return;
    const confirmed = window.confirm(`Delete episode ${activeScene.scene_order}: "${activeScene.title}"? This removes the episode from the app, but it does not delete local WAV files on your Mac.`);
    if (!confirmed) return;
    const remaining = scenes.filter((scene) => scene.id !== activeScene.id);
    setSavingSceneId(activeScene.id);
    try {
      await deleteScene(activeScene.id);
      if (renderJob?.id) await deleteRenderJob(renderJob.id).catch(() => undefined);
      setScenes(remaining);
      setActiveSceneId(remaining[0]?.id || "");
      setTab("script");
      setRenderJob(null);
      setRenderArtifactUrl("");
      setSceneStatus("Episode deleted.");
    } catch (err) {
      setSceneStatus(err instanceof Error ? err.message : "Could not delete this episode.");
    } finally {
      setSavingSceneId("");
    }
  }

  async function resetActiveDraft() {
    if (!activeScene) return;
    const confirmed = window.confirm(`Reset draft approvals and production choices for "${activeScene.title}"? The episode text stays.`);
    if (!confirmed) return;
    await updateScene({
      ...activeScene,
      speakers: [],
      dialogue_assignments: [],
      sfx_cues: [],
      ambience_cues: [],
      voice_notes: "",
      approvals: { script: false, voice: false, draft: false, sfx: false, music: false },
      final_mix_status: "draft",
    }, "script");
    setSelectedSpeakerName("");
    setSelectedDialogueText("");
    setManualSpeakerName("");
    setSceneStatus("Draft reset. Episode text was kept.");
  }

  async function clearActiveRender() {
    if (!activeScene) return;
    const confirmed = window.confirm(`Clear render records for "${activeScene.title}"? This removes the app's render result reference. It does not delete local WAV files on your Mac.`);
    if (!confirmed) return;
    if (renderJob?.id) await deleteRenderJob(renderJob.id).catch(() => undefined);
    await updateScene({
      ...activeScene,
      render_job_status: "",
      render_output_path: "",
      render_sound_design_plan_path: "",
      render_sound_design_plan: {
        created_at: "",
        status: "",
        planner: "",
        scene_summary: "",
        tone: "",
        sound_strategy: "",
        plan_path: "",
        final_mix: "",
        with_sfx_mix: "",
        effects_stem: "",
        ambience_stem: "",
        items: [],
        unmatched: [],
      },
      render_error_message: "",
      final_mix_status: activeScene.approvals?.music ? "ambience_approved" : activeScene.final_mix_status === "ready_to_render" ? "ambience_approved" : activeScene.final_mix_status,
    }, "render");
    setRenderJob(null);
    setRenderArtifactUrl("");
    setSceneStatus("Render cleared from the app. Local files on the Mac were left alone.");
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
    const unassigned = unassignedDialogueCount(activeScene);
    if (unassigned) {
      setSceneStatus(`Assign ${unassigned} unassigned highlighted quote${unassigned === 1 ? "" : "s"} before approving voices.`);
      return;
    }
    const missing = activeScene.speakers.filter((speaker) => speaker.name !== "Unassigned" && !speaker.approved_voice);
    if (missing.length) {
      setSceneStatus(`Choose a voice type for ${missing.map((speaker) => speaker.name).join(", ")} before approving.`);
      return;
    }
    await updateScene({
      ...activeScene,
      speakers: activeScene.speakers.map((speaker) => ({ ...speaker, status: "approved" })),
      approvals: { ...activeScene.approvals, voice: true },
      final_mix_status: "voices_approved",
    }, "sfx");
  }

  async function identifySpeakers() {
    if (!activeScene) return;
    const existingByName = new Map(activeScene.speakers.map((speaker) => [speaker.name.toLowerCase(), speaker]));
    const detectedSpeakers = recommendSpeakersForEpisode(activeScene.text).map((speaker, index) => ({
      ...speaker,
      approved_voice: existingByName.get(speaker.name.toLowerCase())?.approved_voice || "",
      color: existingByName.get(speaker.name.toLowerCase())?.color || speaker.color || speakerColors[index % speakerColors.length],
    }));
    const speakers = [
      ...detectedSpeakers,
      ...activeScene.speakers
        .filter((speaker) => speaker.name !== "Unassigned" && !detectedSpeakers.some((detected) => detected.name.toLowerCase() === speaker.name.toLowerCase()))
        .map((speaker, index) => ({ ...speaker, color: speaker.color || speakerColors[(detectedSpeakers.length + index) % speakerColors.length] })),
    ];
    const preservedAssignments = (activeScene.dialogue_assignments ?? []).filter((assignment) => assignment.source === "manual" || assignment.id.startsWith("dialogue-"));
    const detectedAssignments = buildDetectedDialogueAssignments(activeScene, speakers)
      .filter((assignment) => !preservedAssignments.some((preserved) => assignmentsOverlap(assignment, preserved)));
    await updateScene({
      ...activeScene,
      speakers,
      dialogue_assignments: [...detectedAssignments, ...preservedAssignments],
      approvals: { ...activeScene.approvals, voice: true },
      final_mix_status: "draft",
    });
    setSceneStatus(speakers.length
      ? `Identified ${speakers.length} speaker${speakers.length === 1 ? "" : "s"} and prepared ${detectedAssignments.length} dialogue row${detectedAssignments.length === 1 ? "" : "s"}.`
      : "No named speakers were found in this episode. You can still approve narration and continue.");
  }

  async function addManualSpeaker() {
    if (!activeScene || !manualSpeakerName.trim()) return;
    const name = manualSpeakerName.trim();
    if (activeScene.speakers.some((speaker) => speaker.name.toLowerCase() === name.toLowerCase())) {
      setSceneStatus(`${name} is already in the speaker list.`);
      return;
    }
    const nextSpeaker: StudioSpeaker = {
      name,
      line_count: 0,
      recommended_voice: "",
      approved_voice: "",
      color: speakerColors[activeScene.speakers.length % speakerColors.length],
      status: "recommended",
    };
    await updateScene({
      ...activeScene,
      speakers: [...activeScene.speakers, nextSpeaker],
      approvals: { ...activeScene.approvals, voice: true },
      final_mix_status: "draft",
    });
    setManualSpeakerName("");
    setSelectedSpeakerName(name);
    setSceneStatus(`Added ${name}. Select their text below and assign it.`);
  }

  function captureSelectedDialogueText() {
    const selection = window.getSelection();
    const selected = selection?.toString().trim() || "";
    if (!selected || !activeScene) return;
    setSelectedDialogueText(selected);

    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (!range) {
      setSelectedDialogueRange(null);
      return;
    }
    const container = document.querySelector("[data-speaker-text-preview='true']");
    if (!container || !container.contains(range.commonAncestorContainer)) {
      setSelectedDialogueRange(null);
      return;
    }
    const segmentElements = Array.from(container.querySelectorAll<HTMLElement>("[data-start][data-end]"));
    let start: number | null = null;
    let end: number | null = null;
    for (const element of segmentElements) {
      if (!range.intersectsNode(element)) continue;
      const segmentStart = Number(element.dataset.start || 0);
      const textLength = element.textContent?.length || 0;
      let localStart = 0;
      let localEnd = textLength;
      if (element.contains(range.startContainer)) {
        const beforeRange = document.createRange();
        beforeRange.selectNodeContents(element);
        beforeRange.setEnd(range.startContainer, range.startOffset);
        localStart = beforeRange.toString().length;
      }
      if (element.contains(range.endContainer)) {
        const beforeEndRange = document.createRange();
        beforeEndRange.selectNodeContents(element);
        beforeEndRange.setEnd(range.endContainer, range.endOffset);
        localEnd = beforeEndRange.toString().length;
      }
      start = start === null ? segmentStart + localStart : Math.min(start, segmentStart + localStart);
      end = end === null ? segmentStart + localEnd : Math.max(end, segmentStart + localEnd);
    }
    setSelectedDialogueRange(start !== null && end !== null && end > start ? { start, end } : null);
  }

  async function assignSelectedTextToSpeaker(speakerName = selectedSpeakerName) {
    if (!activeScene) return;
    const selected = selectedDialogueText.trim() || window.getSelection()?.toString().trim() || "";
    if (!speakerName || !selected) {
      setSceneStatus("Select the text first, then click the speaker.");
      return;
    }
    const speaker = activeScene.speakers.find((entry) => entry.name === speakerName);
    if (!speaker) return;
    const color = speaker.color || speakerColors[activeScene.speakers.findIndex((entry) => entry.name === speaker.name) % speakerColors.length];
    const range = selectedDialogueRange;
    const originalText = activeScene.text;
    const rangeIsValid = Boolean(range && range.start >= 0 && range.end > range.start && range.end <= originalText.length);
    const nextText = rangeIsValid
      ? `${originalText.slice(0, range!.start)}${selected}${originalText.slice(range!.end)}`
      : originalText;
    const delta = rangeIsValid ? selected.length - (range!.end - range!.start) : 0;
    const assignmentStart = rangeIsValid ? range!.start : undefined;
    const assignmentEnd = rangeIsValid ? range!.start + selected.length : undefined;
    const assignment: StudioDialogueAssignment = {
      id: `dialogue-${Date.now()}`,
      speaker: speaker.name,
      text: selected,
      color,
      start: assignmentStart,
      end: assignmentEnd,
      source: "manual",
      confidence: "high",
    };
    const existingAssignments = activeScene.dialogue_assignments ?? [];
    const adjustedAssignments = existingAssignments
      .filter((entry) => {
        if (!rangeIsValid || typeof entry.start !== "number" || typeof entry.end !== "number") return true;
        return !(entry.start < range!.end && entry.end > range!.start);
      })
      .map((entry) => {
        if (!rangeIsValid || !delta || typeof entry.start !== "number" || typeof entry.end !== "number" || entry.start < range!.end) {
          return entry;
        }
        return { ...entry, start: entry.start + delta, end: entry.end + delta };
      });
    await updateScene({
      ...activeScene,
      text: nextText,
      dialogue_assignments: [...adjustedAssignments.filter((entry) => !(entry.speaker === assignment.speaker && entry.text === assignment.text)), assignment],
      speakers: activeScene.speakers.map((entry) => entry.name === speaker.name ? { ...entry, line_count: entry.line_count + 1, color } : entry),
      approvals: { ...activeScene.approvals, voice: true },
      final_mix_status: "draft",
      render_job_status: "",
      render_output_path: "",
      render_sound_design_plan_path: "",
      render_error_message: "",
    });
    setSelectedDialogueText("");
    setSelectedDialogueRange(null);
    setSelectedSpeakerName(speaker.name);
    window.getSelection()?.removeAllRanges();
    setSceneStatus(rangeIsValid ? `Updated episode text and assigned it to ${speaker.name}.` : `Assigned selected text to ${speaker.name}.`);
  }

  async function saveDialogueLine(segment: { start: number; end: number; text: string; speaker?: string; color?: string }, speakerName: string, nextLineText: string) {
    if (!activeScene || !speakerName || !nextLineText.trim()) return;
    const speaker = activeScene.speakers.find((entry) => entry.name === speakerName);
    if (!speaker) return;
    const color = speaker.color || speakerColors[activeScene.speakers.findIndex((entry) => entry.name === speaker.name) % speakerColors.length];
    const safeStart = Math.max(0, Math.min(segment.start, activeScene.text.length));
    const safeEnd = Math.max(safeStart, Math.min(segment.end, activeScene.text.length));
    const replacement = nextLineText.trim();
    const nextText = `${activeScene.text.slice(0, safeStart)}${replacement}${activeScene.text.slice(safeEnd)}`;
    const delta = replacement.length - (safeEnd - safeStart);
    const assignment: StudioDialogueAssignment = {
      id: `dialogue-${safeStart}-${Date.now()}`,
      speaker: speaker.name,
      text: replacement,
      color,
      start: safeStart,
      end: safeStart + replacement.length,
      source: "manual",
      confidence: "high",
    };
    const adjustedAssignments = (activeScene.dialogue_assignments ?? [])
      .filter((entry) => {
        if (typeof entry.start !== "number" || typeof entry.end !== "number") return !(entry.speaker === speaker.name && entry.text === replacement);
        return !(entry.start < safeEnd && entry.end > safeStart);
      })
      .map((entry) => {
        if (!delta || typeof entry.start !== "number" || typeof entry.end !== "number" || entry.start < safeEnd) return entry;
        return { ...entry, start: entry.start + delta, end: entry.end + delta };
      });
    await updateScene({
      ...activeScene,
      text: nextText,
      dialogue_assignments: [...adjustedAssignments, assignment],
      speakers: activeScene.speakers.map((entry) => entry.name === speaker.name ? { ...entry, color } : entry),
      approvals: { ...activeScene.approvals, voice: true },
      final_mix_status: "draft",
      render_job_status: "",
      render_output_path: "",
      render_sound_design_plan_path: "",
      render_error_message: "",
    });
    setSceneStatus(`Saved dialogue line for ${speaker.name}.`);
  }

  async function removeDialogueAssignment(assignmentId: string) {
    if (!activeScene) return;
    await updateScene({
      ...activeScene,
      dialogue_assignments: (activeScene.dialogue_assignments ?? []).filter((assignment) => assignment.id !== assignmentId),
      final_mix_status: "draft",
    });
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
                  <div className="episode-header-actions">
                    <span className="studio-status">{activeScene.final_mix_status.replaceAll("_", " ")}</span>
                    <button className="button ghost danger" disabled={savingSceneId === activeScene.id} onClick={resetActiveDraft}>Reset draft</button>
                    <button className="button ghost danger" disabled={savingSceneId === activeScene.id} onClick={deleteActiveEpisode}>Delete episode</button>
                  </div>
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
                    <p className="muted">Identify speakers, select any missed or incorrect dialogue in the text, then click the speaker to assign it. You cannot move forward while yellow unassigned quotes remain.</p>
                    <div className="actions">
                      <button className="button" onClick={identifySpeakers}>Identify speakers in this episode</button>
                      {unassignedDialogueCount(activeScene) > 0 && (
                        <span className="studio-warning">{unassignedDialogueCount(activeScene)} unassigned quote{unassignedDialogueCount(activeScene) === 1 ? "" : "s"}</span>
                      )}
                    </div>
                    <div className="speaker-review-layout">
                      <div className="speaker-text-card">
                        <div className="speaker-text-head">
                          <div>
                            <strong>Episode text</strong>
                            <small>Select text here, then click a speaker chip or speaker card.</small>
                          </div>
                          <button className="button ghost" onClick={captureSelectedDialogueText}>Use selected text</button>
                        </div>
                        <div className="speaker-highlight-text" data-speaker-text-preview="true" onMouseUp={captureSelectedDialogueText}>
                          {highlightedDialogueSegments(activeScene).map((segment, index) => (
                            segment.speaker ? (
                              <mark
                                key={`${segment.speaker}-${index}`}
                                className={`speaker-mark ${segment.missed ? "missed" : ""}`}
                                style={{ backgroundColor: segment.color }}
                                title={`${segment.speaker}${segment.missed ? " — needs assignment" : ""}`}
                                data-start={segment.start}
                                data-end={segment.end}
                              >
                                {segment.text}
                              </mark>
                            ) : (
                              <span key={`plain-${index}`} data-start={segment.start} data-end={segment.end}>{segment.text}</span>
                            )
                          ))}
                        </div>
                        <div className="speaker-assignment-tools">
                          <label>
                            Selected text
                            <textarea
                              value={selectedDialogueText}
                              onChange={(event) => setSelectedDialogueText(event.target.value)}
                              placeholder="Select dialogue above, or paste missed text here."
                            />
                          </label>
                          <small>{selectedDialogueRange ? `Selected characters ${selectedDialogueRange.start}–${selectedDialogueRange.end}. ` : ""}Click a speaker below to assign this text.</small>
                        </div>
                      </div>
                      <div className="speaker-side-card">
                        <strong>Add missed speaker</strong>
                        <div className="actions">
                          <input value={manualSpeakerName} onChange={(event) => setManualSpeakerName(event.target.value)} placeholder="Speaker name" />
                          <button className="button" onClick={addManualSpeaker}>Add speaker</button>
                        </div>
                        <div className="speaker-legend">
                          {activeScene.speakers.map((speaker, index) => (
                            <button
                              type="button"
                              className={`speaker-chip ${selectedSpeakerName === speaker.name ? "active" : ""}`}
                              key={`legend-${speaker.name}`}
                              onClick={() => assignSelectedTextToSpeaker(speaker.name)}
                            >
                              <i style={{ backgroundColor: speakerColor(speaker, index) }} />
                              {speaker.name}
                            </button>
                          ))}
                          <span><i className="missed-swatch" /> Unassigned quote</span>
                        </div>
                        {(activeScene.dialogue_assignments ?? []).length > 0 && (
                          <div className="manual-assignment-list">
                            <strong>Manual assignments</strong>
                            {(activeScene.dialogue_assignments ?? []).map((assignment) => (
                              <div key={assignment.id} className="manual-assignment">
                                <span><i style={{ backgroundColor: assignment.color }} />{assignment.speaker}</span>
                                <small>{assignment.text}</small>
                                <button className="button ghost" onClick={() => removeDialogueAssignment(assignment.id)}>Remove</button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="dialogue-line-editor">
                      <div className="speaker-text-head">
                        <div>
                          <strong>Dialogue lines to render</strong>
                          <small>These rows are the render source for character voices. Fix the speaker or wording here before approving voices.</small>
                        </div>
                      </div>
                      {dialogueLineSegments(activeScene).length ? dialogueLineSegments(activeScene).map((segment, index) => (
                        <div className={`dialogue-line-row ${segment.missed || segment.speaker === "Unassigned" ? "needs-speaker" : ""}`} key={`${segment.start}-${segment.end}-${index}`}>
                          <label>
                            Speaker
                            <select
                              defaultValue={segment.speaker === "Unassigned" ? "" : segment.speaker}
                              onChange={(event) => saveDialogueLine(segment, event.target.value, segment.text)}
                            >
                              <option value="">Choose speaker…</option>
                              {activeScene.speakers.map((speaker) => (
                                <option key={`line-${index}-${speaker.name}`} value={speaker.name}>{speaker.name}</option>
                              ))}
                            </select>
                          </label>
                          <label>
                            Line text
                            <textarea
                              defaultValue={segment.text}
                              onBlur={(event) => {
                                const speakerName = segment.speaker === "Unassigned" ? "" : segment.speaker || "";
                                if (speakerName && event.target.value.trim() !== segment.text.trim()) {
                                  saveDialogueLine(segment, speakerName, event.target.value);
                                }
                              }}
                            />
                          </label>
                        </div>
                      )) : (
                        <p className="materials-empty">No quoted dialogue was found in this episode yet.</p>
                      )}
                    </div>
                    <div className="studio-list">
                      {activeScene.speakers.length ? activeScene.speakers.map((speaker, index) => (
                        <div className="studio-row speaker-pick-row" key={`${speaker.name}-${index}`} onClick={() => assignSelectedTextToSpeaker(speaker.name)}>
                          <div>
                            <strong><span className="speaker-dot" style={{ backgroundColor: speakerColor(speaker, index) }} />{speaker.name}</strong>
                            <small>{speaker.line_count} lines · {voiceTypeLabel(speaker.approved_voice)} · click card to assign selected text</small>
                          </div>
                          <div className="studio-list">
                            <select
                              aria-label={`Voice type for ${speaker.name}`}
                              value={speaker.approved_voice}
                              onChange={(event) => {
                                event.stopPropagation();
                                const speakers: StudioSpeaker[] = activeScene.speakers.map((entry) => entry.name === speaker.name ? { ...entry, approved_voice: event.target.value, recommended_voice: "", status: "recommended" as const } : entry);
                                setScenes((current) => current.map((scene) => scene.id === activeScene.id ? { ...scene, speakers } : scene));
                              }}
                              onClick={(event) => event.stopPropagation()}
                            >
                              <option value="">Choose voice type…</option>
                              {speakerVoiceTypes.map((option) => (
                                <option key={`${speaker.name}-${option.value}`} value={option.value}>
                                  {option.label} — {option.detail}
                                </option>
                              ))}
                            </select>
                            <div className="actions">
                              {speakerVoiceTypes.map((option) => (
                                <button
                                  key={`${speaker.name}-${option.value}`}
                                  className={`button ghost ${speaker.approved_voice === option.value ? "selected" : ""}`}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    const speakers: StudioSpeaker[] = activeScene.speakers.map((entry) => entry.name === speaker.name ? { ...entry, approved_voice: option.value, recommended_voice: "", status: "recommended" as const } : entry);
                                    setScenes((current) => current.map((scene) => scene.id === activeScene.id ? { ...scene, speakers } : scene));
                                  }}
                                >
                                  {option.label}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      )) : <p className="materials-empty">No speakers have been identified for this episode yet.</p>}
                    </div>
                    <div className="actions">
                      <button className="button primary" disabled={unassignedDialogueCount(activeScene) > 0} onClick={approveVoices}>Approve voices → sound effects</button>
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
                      <button className="button ghost danger" onClick={clearActiveRender}>Clear render</button>
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
