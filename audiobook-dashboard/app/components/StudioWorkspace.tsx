"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { listBooks, saveBook, type FirestoreBook } from "@/lib/firebase/books";
import { getClientStorage } from "@/lib/firebase/client";
import { listAllMaterials, listMaterials, readMaterialText, type MaterialRecord } from "@/lib/firebase/materials";
import { deleteRenderJob, getLatestRenderJob, queueRenderJob, type RenderJobRecord } from "@/lib/firebase/renderJobs";
import { buildScenesFromManuscript, recommendAmbienceCues, recommendSfxCues, recommendSpeakersForEpisode } from "@/lib/studio/workflow";
import { deleteScene, listScenes, replaceScenes, saveScene, type SceneRecord, type StudioDialogueAssignment, type StudioSpeaker } from "@/lib/firebase/scenes";
import { listVoicePatterns, saveVoicePattern, type VoicePattern } from "@/lib/firebase/voicePatterns";
import { getDownloadURL, ref } from "firebase/storage";

type TabKey = "script" | "voice" | "characters" | "sfx" | "music" | "render";

type SoundArchiveItem = {
  id: string;
  name: string;
  source?: string;
  bundle?: string;
  pack?: string;
  kind?: string;
  relativePath: string;
  tags?: string[];
};

type MatchedSound = SoundArchiveItem & { score: number };

const tabs: Array<{ key: TabKey; label: string }> = [
  { key: "script", label: "Text" },
  { key: "voice", label: "Narrator" },
  { key: "characters", label: "Speakers" },
  { key: "sfx", label: "Sound effects" },
  { key: "music", label: "Ambience" },
  { key: "render", label: "Render" },
];

const masculineNameHints = ["gregory", "greg", "john", "michael", "david", "daniel", "james", "robert", "william", "the ferryman"];
const feminineNameHints = ["kimberly", "megan", "meg", "kristy", "sarah", "nix", "orra", "ressa", "tamsin", "lio", "vessa"];

const speakerVoiceTypes: Array<{ value: string; label: string; detail: string; gender: "feminine" | "masculine" | "neutral" }> = [
  { value: "orra_voice", label: "Young woman", detail: "Clear, bright, direct", gender: "feminine" },
  { value: "tamsin_voice", label: "Middle-aged woman", detail: "Warm, grounded, practical", gender: "feminine" },
  { value: "ressa_voice", label: "Older woman", detail: "Lower, dry, controlled", gender: "feminine" },
  { value: "flint_voice", label: "Deep woman", detail: "Very low, forceful contralto", gender: "feminine" },
  { value: "nix_voice", label: "Snarky woman", detail: "Quick, guarded, witty", gender: "feminine" },
  { value: "narrator_voice", label: "Narrator voice", detail: "Use narrator for this speaker", gender: "neutral" },
];

const starterCharacterTypes: Array<{
  value: string;
  label: string;
  detail: string;
  gender: "feminine" | "masculine" | "neutral";
  voice: string;
  reference_audio_path?: string;
  reference_text?: string;
  reference_status?: VoicePattern["reference_status"];
}> = [
  { value: "older_woman", label: "Older woman", detail: "Mature, lower, controlled", gender: "feminine", voice: "ressa_voice" },
  { value: "middle_aged_woman", label: "Middle-aged woman", detail: "Warm, grounded, practical", gender: "feminine", voice: "tamsin_voice" },
  { value: "young_woman", label: "Young woman", detail: "Clear, bright, direct", gender: "feminine", voice: "orra_voice" },
  { value: "teenage_woman", label: "Teenage woman", detail: "Quick, bright, emotionally immediate", gender: "feminine", voice: "orra_voice" },
  { value: "snarky_woman", label: "Snarky woman", detail: "Fast, guarded, witty", gender: "feminine", voice: "nix_voice" },
  { value: "deep_woman", label: "Deep woman", detail: "Very low, forceful contralto", gender: "feminine", voice: "flint_voice" },
  { value: "older_man", label: "Older man", detail: "Needs masculine reference WAV", gender: "masculine", voice: "" },
  { value: "middle_aged_man", label: "Middle-aged man", detail: "Needs masculine reference WAV", gender: "masculine", voice: "" },
  { value: "young_man", label: "Young man", detail: "Needs masculine reference WAV", gender: "masculine", voice: "" },
  { value: "teenage_man", label: "Teenage man", detail: "Needs masculine reference WAV", gender: "masculine", voice: "" },
  { value: "neutral_narrator", label: "Neutral narrator", detail: "Use narrator voice", gender: "neutral", voice: "narrator_voice" },
  { value: "neutral_androgynous", label: "Neutral / androgynous", detail: "Needs neutral reference WAV", gender: "neutral", voice: "" },
];

const speakerColors = ["#f4c7c3", "#c8dfc8", "#c8d8f0", "#f1d29b", "#d6c5ee", "#bfe3df", "#efc7dc"];

function voiceTypeLabel(value: string) {
  if (value === "female_voice_1") return "Young woman";
  if (value === "female_voice_2") return "Middle-aged woman";
  if (value === "female_voice_3") return "Older woman";
  if (value === "male_voice_1") return "Deep woman";
  if (value.startsWith("profile:")) return "Approved profile reference";
  return speakerVoiceTypes.find((option) => option.value === value)?.label || value || "No voice selected";
}

function canonicalVoiceValue(value: string) {
  if (value === "female_voice_1") return "orra_voice";
  if (value === "female_voice_2") return "tamsin_voice";
  if (value === "female_voice_3") return "ressa_voice";
  if (value === "male_voice_1") return "flint_voice";
  return value;
}

function voiceCompatibleWithGender(voiceValue: string, gender: StudioSpeaker["gender"]) {
  const normalizedVoice = voiceValue || "";
  if (normalizedVoice.startsWith("profile:")) return true;
  const voice = speakerVoiceTypes.find((option) => option.value === canonicalVoiceValue(normalizedVoice));
  if (!normalizedVoice || !voice) return true;
  if (gender === "masculine") return voice.gender === "masculine" || voice.gender === "neutral";
  return true;
}

function profileVoiceValue(patternValue: string) {
  return patternValue ? `profile:${patternValue}` : "";
}

function patternHasApprovedReference(pattern?: { reference_audio_path?: string; reference_status?: VoicePattern["reference_status"] }) {
  return Boolean(pattern?.reference_audio_path?.trim() && pattern.reference_status === "approved");
}

function speakerHasApprovedReference(speaker: StudioSpeaker) {
  return Boolean(speaker.reference_audio_path?.trim() && speaker.approved_voice?.startsWith("profile:"));
}

function speakerNeedsMasculineReference(speaker: StudioSpeaker) {
  return speaker.gender === "masculine" && !speakerHasApprovedReference(speaker) && !speaker.approved_voice;
}

function referenceFileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || "No reference WAV";
}

function soundLibraryPreviewUrl(path: string) {
  return path ? `/sound-library/${path.split("/").map(encodeURIComponent).join("/")}` : "";
}

function soundCueTokens(value: string) {
  return Array.from(new Set(value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []))
    .filter((token) => !["the", "and", "for", "with", "from", "that", "this", "sound", "effect", "cue"].includes(token));
}

function scoreSoundMatch(item: SoundArchiveItem, tokens: string[]) {
  const haystack = [
    item.name,
    item.kind,
    item.pack,
    item.bundle,
    item.relativePath,
    ...(Array.isArray(item.tags) ? item.tags : []),
  ].join(" ").toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += token.length > 5 ? 4 : 2;
  }
  if (/\b(test|dtmf|white noise|channel test|designed|whoosh|sweep|impact|magic|spell|ghost|horror|music|drone|riser)\b/i.test(haystack)) score -= 8;
  if (/\b(voice|male|female|yell|scream|monster|creature)\b/i.test(haystack)) score -= 5;
  return score;
}

function speakerColor(speaker: StudioSpeaker, index: number) {
  return speaker.color || speakerColors[index % speakerColors.length];
}

function stripDialogueQuotes(value: string) {
  return value.trim().replace(/^[“”"]+/, "").replace(/[“”"]+$/, "").trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  const [voicePatterns, setVoicePatterns] = useState<VoicePattern[]>([]);
  const [referenceAuditionUrls, setReferenceAuditionUrls] = useState<Record<string, string>>({});
  const [soundArchiveItems, setSoundArchiveItems] = useState<SoundArchiveItem[]>([]);
  const [selectedSpeakerName, setSelectedSpeakerName] = useState("");
  const [selectedCharacterType, setSelectedCharacterType] = useState("");
  const [selectedDialogueTone, setSelectedDialogueTone] = useState("");
  const [selectedDialogueUrgency, setSelectedDialogueUrgency] = useState<StudioDialogueAssignment["urgency"]>("medium");
  const [selectedDialogueText, setSelectedDialogueText] = useState("");
  const [selectedDialogueRange, setSelectedDialogueRange] = useState<{ start: number; end: number } | null>(null);
  const attemptedAutoImport = useRef(false);

  const characterTypes = voicePatterns.length ? voicePatterns : starterCharacterTypes;

  function matchCueToArchive(cue: { label: string; reason?: string; anchor_text?: string; search_terms?: string[] }): MatchedSound | null {
    if (!soundArchiveItems.length) return null;
    const tokens = Array.from(new Set([
      ...soundCueTokens(`${cue.label} ${cue.reason || ""} ${cue.anchor_text || ""}`),
      ...(cue.search_terms ?? []).flatMap((term) => soundCueTokens(term)),
    ]));
    const ranked = soundArchiveItems
      .map((item) => ({ ...item, score: scoreSoundMatch(item, tokens) }))
      .filter((item) => item.score >= 8)
      .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
    return ranked[0] ?? null;
  }

  function cueWithAssetMatch(cue: SceneRecord["sfx_cues"][number]) {
    if (cue.suggested_asset_path) return cue;
    const match = matchCueToArchive(cue);
    if (!match) return cue;
    return {
      ...cue,
      suggested_asset_name: match.name,
      suggested_asset_path: match.relativePath,
      source: cue.source || `${match.source || "Sound library"} · ${match.pack || match.kind || "matched asset"}`,
    };
  }

  function characterTypeLabel(value?: string) {
    return characterTypes.find((option) => option.value === value)?.label || "No character type";
  }

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

  function inferSpeakerGender(scene: SceneRecord, speakerName: string): StudioSpeaker["gender"] {
    const lowerName = speakerName.toLowerCase();
    if (masculineNameHints.some((name) => lowerName.includes(name))) return "masculine";
    if (feminineNameHints.some((name) => lowerName.includes(name))) return "feminine";
    const firstName = speakerName.split(/\s+/)[0];
    if (!firstName || speakerName === "Unassigned") return "unknown";
    const escapedName = escapeRegExp(firstName);
    const contextPattern = new RegExp(`(?:\\b(?:he|him|his|she|her|hers)\\b.{0,80}\\b${escapedName}\\b|\\b${escapedName}\\b.{0,80}\\b(?:he|him|his|she|her|hers)\\b)`, "gi");
    const contexts = Array.from(scene.text.matchAll(contextPattern)).map((match) => match[0].toLowerCase());
    const masculineHits = contexts.filter((context) => /\b(he|him|his)\b/.test(context)).length;
    const feminineHits = contexts.filter((context) => /\b(she|her|hers)\b/.test(context)).length;
    if (masculineHits > feminineHits) return "masculine";
    if (feminineHits > masculineHits) return "feminine";
    return "unknown";
  }

  function bookSpeakerMemory(speakerName: string) {
    const lowerName = speakerName.toLowerCase();
    for (const scene of scenes) {
      const speaker = scene.speakers.find((entry) => entry.name.toLowerCase() === lowerName && entry.approved_voice);
      if (speaker) {
        const gender = speaker.gender || inferSpeakerGender(scene, speaker.name);
        return {
          approved_voice: voiceCompatibleWithGender(speaker.approved_voice, gender) ? canonicalVoiceValue(speaker.approved_voice) : "",
          reference_audio_path: speaker.reference_audio_path || "",
          reference_text: speaker.reference_text || "",
          character_type: speaker.character_type,
          gender,
          color: speaker.color,
        };
      }
    }
    return null;
  }

  function bookTypeMemory(typeValue?: string) {
    if (!typeValue) return null;
    for (const scene of scenes) {
      const speaker = scene.speakers.find((entry) => entry.character_type === typeValue && entry.approved_voice);
      if (speaker) return {
        approved_voice: canonicalVoiceValue(speaker.approved_voice),
        reference_audio_path: speaker.reference_audio_path || "",
        reference_text: speaker.reference_text || "",
        gender: speaker.gender || inferSpeakerGender(scene, speaker.name),
      };
    }
    return null;
  }

  function characterTypeOptionsForSpeaker(speaker: StudioSpeaker) {
    const gender = speaker.gender || "unknown";
    return characterTypes.filter((option) => gender === "unknown" || option.gender === gender || option.gender === "neutral");
  }

  function voiceOptionsForSpeaker(speaker: StudioSpeaker) {
    const gender = speaker.gender || "unknown";
    if (gender === "masculine") {
      return speakerVoiceTypes.filter((option) => option.gender === "neutral");
    }
    return speakerVoiceTypes;
  }

  function nearestKnownSpeaker(scene: SceneRecord, text: string, pronoun?: string) {
    const speakers = scene.speakers.filter((speaker) => speaker.name !== "Unassigned");
    const lowerPronoun = pronoun?.toLowerCase() || "";
    const candidates = speakers
      .filter((speaker) => {
        const name = speaker.name.toLowerCase();
        const voice = canonicalVoiceValue(speaker.approved_voice).toLowerCase();
        const gender = speaker.gender || inferSpeakerGender(scene, speaker.name);
        if (lowerPronoun === "he" || lowerPronoun === "his") {
          return gender === "masculine" || masculineNameHints.some((known) => name.includes(known));
        }
        if (lowerPronoun === "she" || lowerPronoun === "her") {
          return gender === "feminine" || feminineNameHints.some((known) => name.includes(known)) || voice.includes("voice");
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

  function uniqueSpeakerMention(scene: SceneRecord, context: string) {
    const matches = scene.speakers
      .filter((speaker) => speaker.name !== "Unassigned")
      .filter((speaker) => {
        const aliases = Array.from(new Set([
          speaker.name.trim(),
          speaker.name.trim().split(/\s+/)[0],
        ].filter(Boolean)));
        return aliases.some((alias) => new RegExp(`\\b${escapeRegExp(alias)}\\b`, "i").test(context));
      });
    return matches.length === 1 ? matches[0].name : "";
  }

  function paragraphContextSpeaker(scene: SceneRecord, quoteStart: number, quoteEnd: number) {
    const text = scene.text;
    const beforeText = text.slice(0, quoteStart);
    const afterText = text.slice(quoteEnd);
    const beforeBreaks = Array.from(beforeText.matchAll(/\n\s*\n/g));
    const paragraphStartBreak = beforeBreaks[beforeBreaks.length - 1];
    const paragraphStart = paragraphStartBreak?.index !== undefined
      ? paragraphStartBreak.index + paragraphStartBreak[0].length
      : 0;
    const paragraphEndMatch = afterText.match(/\n\s*\n/);
    const paragraphEnd = paragraphEndMatch?.index !== undefined
      ? quoteEnd + paragraphEndMatch.index
      : text.length;
    const previousText = text.slice(0, paragraphStart).trimEnd();
    const previousBreaks = Array.from(previousText.matchAll(/\n\s*\n/g));
    const previousBreak = previousBreaks[previousBreaks.length - 1];
    const previousParagraph = previousBreak?.index !== undefined ? previousText.slice(previousBreak.index + previousBreak[0].length).trim() : previousText;
    const nextText = text.slice(paragraphEnd).trimStart();
    const nextBreak = nextText.search(/\n\s*\n/);
    const nextParagraph = nextBreak >= 0 ? nextText.slice(0, nextBreak).trim() : nextText;
    const currentBefore = text.slice(paragraphStart, quoteStart);
    const currentAfter = text.slice(quoteEnd, paragraphEnd);

    return uniqueSpeakerMention(scene, currentBefore)
      || uniqueSpeakerMention(scene, currentAfter)
      || uniqueSpeakerMention(scene, previousParagraph)
      || uniqueSpeakerMention(scene, nextParagraph);
  }

  function inferQuoteSpeaker(scene: SceneRecord, quoteStart: number, quoteEnd: number) {
    const text = scene.text;
    const before = text.slice(Math.max(0, quoteStart - 140), quoteStart);
    const after = text.slice(quoteEnd, quoteEnd + 140);
    const namePattern = "([A-Z][a-zA-Z'’-]+(?:\\s+[A-Z][a-zA-Z'’-]+)?)";
    const verbs = "said|asked|replied|whispered|murmured|snapped|told|called|cried|shouted|answered|added";
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
    const contextSpeaker = paragraphContextSpeaker(scene, quoteStart, quoteEnd);
    if (contextSpeaker) return contextSpeaker;
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

  function renderPreviewRows(scene: SceneRecord) {
    return dialogueLineSegments(scene)
      .filter((segment) => segment.speaker)
      .map((segment) => {
        const assignment = assignmentForSegment(scene, segment);
        const speaker = scene.speakers.find((entry) => entry.name === segment.speaker);
        return {
          key: `${segment.start}-${segment.end}-${segment.speaker}`,
          speakerName: segment.speaker || "Unassigned",
          text: segment.text.trim(),
          tone: assignment?.tone || "default",
          urgency: assignment?.urgency || "medium",
          profile: characterTypeLabel(speaker?.character_type),
          reference: speaker?.reference_audio_path || "",
          missing: segment.missed || segment.speaker === "Unassigned" || !speaker || !speaker.reference_audio_path,
        };
      });
  }

  function assignmentForSegment(scene: SceneRecord, segment: { start: number; end: number; text: string; speaker?: string }) {
    return (scene.dialogue_assignments ?? []).find((assignment) => {
      if (typeof assignment.start === "number" && typeof assignment.end === "number") {
        return assignment.start === segment.start && assignment.end === segment.end;
      }
      return assignment.speaker === segment.speaker && assignment.text.trim() === stripDialogueQuotes(segment.text);
    });
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
      const [books, studioScenes, patterns] = await Promise.all([listBooks(), listScenes(bookId), listVoicePatterns()]);
      const currentBook = books.find((entry) => entry.id === bookId) ?? null;
      setBook(currentBook);
      setScenes(studioScenes);
      setVoicePatterns(patterns);
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
    let cancelled = false;
    fetch("/sound-archive-index.json")
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        if (!cancelled && Array.isArray(data?.items)) setSoundArchiveItems(data.items);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

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
    const missing = activeScene.speakers.filter((speaker) => {
      if (speaker.name === "Unassigned") return false;
      if (speaker.approved_voice?.startsWith("profile:")) return !speaker.reference_audio_path;
      return !speaker.approved_voice && !speaker.reference_audio_path;
    });
    if (missing.length) {
      setSceneStatus(`Choose a voice type or approved profile reference for ${missing.map((speaker) => speaker.name).join(", ")} before approving.`);
      return;
    }
    const incompatible = activeScene.speakers.filter((speaker) => speaker.name !== "Unassigned" && !voiceCompatibleWithGender(speaker.approved_voice, speaker.gender || inferSpeakerGender(activeScene, speaker.name)));
    if (incompatible.length) {
      setSceneStatus(`${incompatible.map((speaker) => speaker.name).join(", ")} needs a compatible voice. No masculine local reference voice is installed yet.`);
      return;
    }
    await updateScene({
      ...activeScene,
      speakers: activeScene.speakers.map((speaker) => ({ ...speaker, approved_voice: canonicalVoiceValue(speaker.approved_voice), status: "approved" })),
      approvals: { ...activeScene.approvals, voice: true },
      final_mix_status: "voices_approved",
    }, "sfx");
  }

  async function updateSpeakerVoiceForBook(speakerName: string, voiceValue: string) {
    if (!activeScene) return;
    const approvedVoice = canonicalVoiceValue(voiceValue);
    const lowerName = speakerName.toLowerCase();
    const nextScenes = scenes.map((scene) => {
      const hasSpeaker = scene.speakers.some((speaker) => speaker.name.toLowerCase() === lowerName);
      if (!hasSpeaker) return scene;
      return {
        ...scene,
        speakers: scene.speakers.map((speaker) => {
          if (speaker.name.toLowerCase() !== lowerName) return speaker;
          return {
            ...speaker,
            approved_voice: approvedVoice,
            recommended_voice: "",
            reference_audio_path: "",
            reference_text: "",
            gender: speaker.gender || inferSpeakerGender(scene, speaker.name),
            status: "recommended" as const,
          };
        }),
        approvals: { ...scene.approvals, voice: true },
        final_mix_status: scene.final_mix_status === "voices_approved" ? "draft" as const : scene.final_mix_status,
      };
    });
    setScenes(nextScenes);
    setSceneStatus(`Saved ${speakerName}'s voice for this book.`);
    const changedScenes = nextScenes.filter((scene, index) => scene !== scenes[index] && !scene.id.startsWith("preview-"));
    await Promise.all(changedScenes.map((scene) => saveScene(scene)));
  }

  async function updateSpeakerCharacterTypeForBook(speakerName: string, typeValue: string) {
    if (!activeScene) return;
    const lowerName = speakerName.toLowerCase();
    const type = characterTypes.find((option) => option.value === typeValue);
    const remembered = bookTypeMemory(typeValue);
    const nextScenes = scenes.map((scene) => {
      const hasSpeaker = scene.speakers.some((speaker) => speaker.name.toLowerCase() === lowerName);
      if (!hasSpeaker) return scene;
      return {
        ...scene,
        speakers: scene.speakers.map((speaker) => {
          if (speaker.name.toLowerCase() !== lowerName) return speaker;
          const gender = speaker.gender || inferSpeakerGender(scene, speaker.name);
          const approvedProfileReference = patternHasApprovedReference(type);
          const typeVoice = approvedProfileReference ? profileVoiceValue(typeValue) : type?.voice || remembered?.approved_voice || "";
          const approvedVoice = voiceCompatibleWithGender(typeVoice, gender) ? canonicalVoiceValue(typeVoice) : "";
          return {
            ...speaker,
            character_type: typeValue || "",
            approved_voice: approvedVoice,
            recommended_voice: "",
            reference_audio_path: approvedProfileReference ? type?.reference_audio_path || "" : remembered?.reference_audio_path || "",
            reference_text: approvedProfileReference ? type?.reference_text || "" : remembered?.reference_text || "",
            gender,
            status: "recommended" as const,
          };
        }),
        approvals: { ...scene.approvals, voice: true },
        final_mix_status: scene.final_mix_status === "voices_approved" ? "draft" as const : scene.final_mix_status,
      };
    });
    setScenes(nextScenes);
    setSceneStatus(typeValue ? `Saved ${speakerName} as ${characterTypeLabel(typeValue)} for this book.` : `Cleared ${speakerName}'s character type.`);
    const changedScenes = nextScenes.filter((scene, index) => scene !== scenes[index] && !scene.id.startsWith("preview-"));
    await Promise.all(changedScenes.map((scene) => saveScene(scene)));
  }

  async function identifySpeakers() {
    if (!activeScene) return;
    const existingByName = new Map(activeScene.speakers.map((speaker) => [speaker.name.toLowerCase(), speaker]));
    const detectedSpeakers = recommendSpeakersForEpisode(activeScene.text).map((speaker, index) => {
      const existing = existingByName.get(speaker.name.toLowerCase());
      const speakerMemory = bookSpeakerMemory(speaker.name);
      const characterType = existing?.character_type || speakerMemory?.character_type || "";
      const typeMemory = bookTypeMemory(characterType);
      return {
        ...speaker,
        character_type: characterType,
        gender: existing?.gender || speaker.gender || inferSpeakerGender(activeScene, speaker.name),
        approved_voice: canonicalVoiceValue(existing?.approved_voice || speakerMemory?.approved_voice || typeMemory?.approved_voice || ""),
        reference_audio_path: existing?.reference_audio_path || speakerMemory?.reference_audio_path || typeMemory?.reference_audio_path || "",
        reference_text: existing?.reference_text || speakerMemory?.reference_text || typeMemory?.reference_text || "",
        color: existing?.color || speaker.color || speakerColors[index % speakerColors.length],
      };
    });
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
      character_type: "",
      recommended_voice: "",
      approved_voice: bookSpeakerMemory(name)?.approved_voice || "",
      reference_audio_path: bookSpeakerMemory(name)?.reference_audio_path || "",
      reference_text: bookSpeakerMemory(name)?.reference_text || "",
      gender: inferSpeakerGender(activeScene, name),
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
    setSelectedCharacterType(nextSpeaker.character_type || "");
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

  function chooseSpeakerForAssignment(speakerName: string) {
    setSelectedSpeakerName(speakerName);
    const speaker = activeScene?.speakers.find((entry) => entry.name === speakerName);
    setSelectedCharacterType(speaker?.character_type || "");
  }

  async function assignSelectedTextToSpeaker(speakerName = selectedSpeakerName, typeValue = selectedCharacterType) {
    if (!activeScene) return;
    const selected = selectedDialogueText.trim() || window.getSelection()?.toString().trim() || "";
    if (!speakerName || !selected) {
      setSceneStatus("Select the text first, then click the speaker.");
      return;
    }
    const speaker = activeScene.speakers.find((entry) => entry.name === speakerName);
    if (!speaker) return;
    if (typeValue && speaker.character_type !== typeValue) {
      await updateSpeakerCharacterTypeForBook(speaker.name, typeValue);
    }
    const type = characterTypes.find((option) => option.value === typeValue);
    const remembered = bookTypeMemory(typeValue);
    const speakerGender = speaker.gender || inferSpeakerGender(activeScene, speaker.name);
    const typeVoice = type?.voice || remembered?.approved_voice || speaker.approved_voice;
    const approvedVoice = typeValue && voiceCompatibleWithGender(typeVoice, speakerGender)
      ? canonicalVoiceValue(typeVoice)
      : canonicalVoiceValue(speaker.approved_voice);
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
      tone: selectedDialogueTone,
      urgency: selectedDialogueUrgency,
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
      speakers: activeScene.speakers.map((entry) => entry.name === speaker.name ? {
        ...entry,
        character_type: typeValue || entry.character_type,
        approved_voice: approvedVoice,
        gender: speakerGender,
        line_count: entry.line_count + 1,
        color,
      } : entry),
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
    setSelectedCharacterType(typeValue || speaker.character_type || "");
    setSelectedDialogueTone("");
    setSelectedDialogueUrgency("medium");
    window.getSelection()?.removeAllRanges();
    setSceneStatus(rangeIsValid ? `Updated episode text and assigned it to ${speaker.name}.` : `Assigned selected text to ${speaker.name}.`);
  }

  async function saveDialogueLine(
    segment: { start: number; end: number; text: string; speaker?: string; color?: string },
    speakerName: string,
    nextLineText: string,
    performance: Pick<StudioDialogueAssignment, "tone" | "urgency"> = {},
  ) {
    if (!activeScene || !speakerName || !nextLineText.trim()) return;
    const speaker = activeScene.speakers.find((entry) => entry.name === speakerName);
    if (!speaker) return;
    const color = speaker.color || speakerColors[activeScene.speakers.findIndex((entry) => entry.name === speaker.name) % speakerColors.length];
    const safeStart = Math.max(0, Math.min(segment.start, activeScene.text.length));
    const safeEnd = Math.max(safeStart, Math.min(segment.end, activeScene.text.length));
    const replacement = nextLineText.trim();
    const existingAssignment = assignmentForSegment(activeScene, segment);
    const nextText = `${activeScene.text.slice(0, safeStart)}${replacement}${activeScene.text.slice(safeEnd)}`;
    const delta = replacement.length - (safeEnd - safeStart);
    const assignment: StudioDialogueAssignment = {
      id: `dialogue-${safeStart}-${Date.now()}`,
      speaker: speaker.name,
      text: replacement,
      color,
      start: safeStart,
      end: safeStart + replacement.length,
      tone: performance.tone ?? existingAssignment?.tone,
      urgency: performance.urgency ?? existingAssignment?.urgency,
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
    const cues = activeScene[kind].map((cue) => {
      if (cue.id !== cueId) return cue;
      const enrichedCue = kind === "sfx_cues" ? cueWithAssetMatch(cue) : cue;
      return { ...enrichedCue, approved: !cue.approved };
    });
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
    const previewRows = renderPreviewRows(activeScene);
    const blockedRows = previewRows.filter((row) => row.missing);
    if (!previewRows.length) {
      setSceneStatus("No dialogue assignments are ready for character rendering. Return to Speakers and assign quoted lines before rendering.");
      return;
    }
    if (blockedRows.length) {
      setSceneStatus(`Fix ${blockedRows.length} voice render preview row${blockedRows.length === 1 ? "" : "s"} before rendering.`);
      return;
    }
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

  function updateVoicePatternDraft(patternValue: string, updates: Partial<VoicePattern>) {
    setVoicePatterns((current) => current.map((pattern) => (
      pattern.value === patternValue ? { ...pattern, ...updates } : pattern
    )));
  }

  async function persistVoicePattern(pattern: VoicePattern) {
    const saved = await saveVoicePattern(pattern);
    setVoicePatterns((current) => current.map((entry) => entry.value === saved.value ? saved : entry));
    setSceneStatus(`Saved voice pattern: ${saved.label}.`);
  }

  async function approveReferenceForSpeakerProfile(speaker: StudioSpeaker) {
    if (!activeScene || !speaker.character_type) return;
    const pattern = voicePatterns.find((entry) => entry.value === speaker.character_type);
    if (!pattern) {
      setSceneStatus(`No reusable profile found for ${speaker.name}.`);
      return;
    }
    if (!pattern.reference_audio_path.trim()) {
      setSceneStatus(`Paste a renderable WAV path before approving ${pattern.label}.`);
      return;
    }
    const saved = await saveVoicePattern({ ...pattern, reference_status: "approved" });
    setVoicePatterns((current) => current.map((entry) => entry.value === saved.value ? saved : entry));
    const nextScenes = scenes.map((scene) => {
      const hasProfile = scene.speakers.some((entry) => entry.character_type === saved.value);
      if (!hasProfile) return scene;
      return {
        ...scene,
        speakers: scene.speakers.map((entry) => {
          if (entry.character_type !== saved.value) return entry;
          return {
            ...entry,
            approved_voice: profileVoiceValue(saved.value),
            recommended_voice: "",
            reference_audio_path: saved.reference_audio_path,
            reference_text: saved.reference_text,
            status: "recommended" as const,
          };
        }),
        approvals: { ...scene.approvals, voice: true },
        final_mix_status: scene.final_mix_status === "voices_approved" ? "draft" as const : scene.final_mix_status,
      };
    });
    setScenes(nextScenes);
    const changedScenes = nextScenes.filter((scene, index) => scene !== scenes[index] && !scene.id.startsWith("preview-"));
    await Promise.all(changedScenes.map((scene) => saveScene(scene)));
    setSceneStatus(`Approved ${saved.label} reference WAV and attached it to matching speakers in this book.`);
  }

  async function refreshSfxSuggestions() {
    if (!activeScene) return;
    const existingChoices = activeScene.sfx_cues.filter((cue) => cue.approved || cue.reason === "Added manually in the studio.");
    const existingKeys = new Set(existingChoices.map((cue) => `${cue.label.toLowerCase()}-${cue.start ?? cue.time ?? ""}`));
    const recommendations = recommendSfxCues(activeScene.text)
      .map(cueWithAssetMatch)
      .filter((cue) => !existingKeys.has(`${cue.label.toLowerCase()}-${cue.start ?? cue.time ?? ""}`));
    await updateScene({
      ...activeScene,
      sfx_cues: [...existingChoices, ...recommendations],
      approvals: { ...activeScene.approvals, sfx: false },
    });
    setSceneStatus(`Prepared ${recommendations.length} text-anchored sound suggestion${recommendations.length === 1 ? "" : "s"} from the local library index. Nothing was approved automatically.`);
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
                    <div className="dialogue-line-editor">
                      <div className="speaker-text-head">
                        <div>
                          <strong>Reusable voice pattern library</strong>
                          <small>Design character types once, then assign names to these types across books. Reference WAVs can be added later.</small>
                        </div>
                      </div>
                      {voicePatterns.map((pattern) => (
                        <details className="studio-details" key={pattern.value}>
                          <summary>{pattern.label} · {pattern.gender} · {pattern.reference_status === "approved" ? "reference approved" : pattern.reference_status === "candidate" ? "candidate reference" : "needs reference"}</summary>
                          <div className="dialogue-line-row">
                            <label>
                              Pattern name
                              <input
                                value={pattern.label}
                                onChange={(event) => updateVoicePatternDraft(pattern.value, { label: event.target.value })}
                              />
                            </label>
                            <label>
                              Gender / presentation
                              <select
                                value={pattern.gender}
                                onChange={(event) => updateVoicePatternDraft(pattern.value, { gender: event.target.value as VoicePattern["gender"] })}
                              >
                                <option value="feminine">Feminine</option>
                                <option value="masculine">Masculine</option>
                                <option value="neutral">Neutral</option>
                              </select>
                            </label>
                            <label>
                              Installed reference voice
                              <select
                                value={pattern.voice}
                                onChange={(event) => updateVoicePatternDraft(pattern.value, { voice: event.target.value })}
                              >
                                <option value="">No usable reference yet</option>
                                {speakerVoiceTypes.map((option) => (
                                  <option key={`${pattern.value}-${option.value}`} value={option.value}>
                                    {option.label} — {option.detail}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label>
                              Age feel
                              <input
                                value={pattern.age_feel}
                                onChange={(event) => updateVoicePatternDraft(pattern.value, { age_feel: event.target.value })}
                                placeholder="Adult, older adult, young adult…"
                              />
                            </label>
                            <label>
                              Accent / dialect flavor
                              <textarea
                                value={pattern.accent}
                                onChange={(event) => updateVoicePatternDraft(pattern.value, { accent: event.target.value })}
                                placeholder="Neutral American, subtle Southern softness, light British formality…"
                              />
                            </label>
                            <label>
                              Personality
                              <textarea
                                value={pattern.personality}
                                onChange={(event) => updateVoicePatternDraft(pattern.value, { personality: event.target.value })}
                                placeholder="Guarded, warm, dangerous, anxious, playful, formal…"
                              />
                            </label>
                            <label>
                              Delivery rules
                              <textarea
                                value={pattern.delivery}
                                onChange={(event) => updateVoicePatternDraft(pattern.value, { delivery: event.target.value })}
                                placeholder="Pace, pauses, diction, how anger/questions/tenderness sound…"
                              />
                            </label>
                            <label>
                              Avoid
                              <textarea
                                value={pattern.avoid}
                                onChange={(event) => updateVoicePatternDraft(pattern.value, { avoid: event.target.value })}
                                placeholder="No cartoon accents, no melodrama, no breathless speed…"
                              />
                            </label>
                            <label>
                              Reference audio path
                              <input
                                value={pattern.reference_audio_path}
                                onChange={(event) => updateVoicePatternDraft(pattern.value, { reference_audio_path: event.target.value })}
                                placeholder="/Users/kristykelly/.../voice.wav or local-narrator/voice-approved/..."
                              />
                            </label>
                            <label>
                              Audition WAV
                              <input
                                accept="audio/wav,audio/x-wav,audio/*"
                                type="file"
                                onChange={(event) => {
                                  const file = event.target.files?.[0];
                                  if (!file) return;
                                  const previousUrl = referenceAuditionUrls[pattern.value];
                                  if (previousUrl) URL.revokeObjectURL(previousUrl);
                                  const auditionUrl = URL.createObjectURL(file);
                                  setReferenceAuditionUrls((current) => ({ ...current, [pattern.value]: auditionUrl }));
                                  updateVoicePatternDraft(pattern.value, { reference_status: "candidate" });
                                }}
                              />
                              <small>Use this to listen before approving. Because browsers cannot expose the Mac file path, also paste the renderable path above.</small>
                            </label>
                            {referenceAuditionUrls[pattern.value] && (
                              <audio controls src={referenceAuditionUrls[pattern.value]} />
                            )}
                            <label>
                              Reference status
                              <select
                                value={pattern.reference_status}
                                onChange={(event) => updateVoicePatternDraft(pattern.value, { reference_status: event.target.value as VoicePattern["reference_status"] })}
                              >
                                <option value="needed">Needs reference</option>
                                <option value="candidate">Candidate — auditioning</option>
                                <option value="approved">Approved for casting</option>
                              </select>
                            </label>
                            <label>
                              Reference text
                              <textarea
                                value={pattern.reference_text}
                                onChange={(event) => updateVoicePatternDraft(pattern.value, { reference_text: event.target.value })}
                                placeholder="Text spoken in the reference WAV"
                              />
                            </label>
                          </div>
                          <div className="actions">
                            <button
                              className="button"
                              disabled={!pattern.reference_audio_path.trim()}
                              onClick={() => persistVoicePattern({ ...pattern, reference_status: "approved", voice: pattern.voice || "" })}
                            >
                              Approve reference WAV
                            </button>
                            <button className="button primary" onClick={() => persistVoicePattern(pattern)}>Save voice pattern</button>
                          </div>
                        </details>
                      ))}
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
                          <label>
                            Character
                            <select
                              value={selectedSpeakerName}
                              onChange={(event) => chooseSpeakerForAssignment(event.target.value)}
                            >
                              <option value="">Choose character…</option>
                              {activeScene.speakers.map((speaker) => (
                                <option key={`assign-${speaker.name}`} value={speaker.name}>{speaker.name}</option>
                              ))}
                            </select>
                          </label>
                          <label>
                            Character type / trope
                            <select
                              value={selectedCharacterType}
                              onChange={(event) => setSelectedCharacterType(event.target.value)}
                            >
                              <option value="">Choose type…</option>
                              {characterTypes.map((option) => (
                                <option key={`assign-type-${option.value}`} value={option.value}>
                                  {option.label} — {option.detail}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            Tone
                            <select
                              value={selectedDialogueTone}
                              onChange={(event) => setSelectedDialogueTone(event.target.value)}
                            >
                              <option value="">Default</option>
                              <option value="dry">Dry</option>
                              <option value="warm">Warm</option>
                              <option value="snarky">Snarky</option>
                              <option value="scared">Scared</option>
                              <option value="angry">Angry</option>
                              <option value="tender">Tender</option>
                              <option value="teasing">Teasing</option>
                              <option value="deadpan">Deadpan</option>
                              <option value="urgent">Urgent</option>
                            </select>
                          </label>
                          <label>
                            Urgency
                            <select
                              value={selectedDialogueUrgency}
                              onChange={(event) => setSelectedDialogueUrgency(event.target.value as StudioDialogueAssignment["urgency"])}
                            >
                              <option value="low">Low</option>
                              <option value="medium">Medium</option>
                              <option value="high">High</option>
                            </select>
                          </label>
                          <div className="actions">
                            <button className="button primary" onClick={() => assignSelectedTextToSpeaker()}>
                              Assign selected dialogue
                            </button>
                          </div>
                          <small>{selectedDialogueRange ? `Selected characters ${selectedDialogueRange.start}–${selectedDialogueRange.end}. ` : ""}Pick character, trope/type, optional tone, then assign.</small>
                        </div>
                      </div>
                      <div className="speaker-side-card">
                        <strong>Cast</strong>
                        <small className="muted">Select a character, set their reusable profile, then assign highlighted dialogue.</small>
                        <div className="cast-roster">
                          {activeScene.speakers.length ? activeScene.speakers.map((speaker, index) => (
                            <div
                              className={`cast-card ${selectedSpeakerName === speaker.name ? "active" : ""}`}
                              key={`cast-${speaker.name}`}
                              onClick={() => chooseSpeakerForAssignment(speaker.name)}
                            >
                              <button
                                type="button"
                                className="cast-card-main"
                                onClick={() => chooseSpeakerForAssignment(speaker.name)}
                              >
                                <span><i style={{ backgroundColor: speakerColor(speaker, index) }} />{speaker.name}</span>
                                <small>{speaker.line_count} lines · {characterTypeLabel(speaker.character_type)}</small>
                              </button>
                              <select
                                aria-label={`Profile for ${speaker.name}`}
                                value={speaker.character_type || ""}
                                onChange={(event) => {
                                  event.stopPropagation();
                                  updateSpeakerCharacterTypeForBook(speaker.name, event.target.value);
                                  if (selectedSpeakerName === speaker.name) setSelectedCharacterType(event.target.value);
                                }}
                                onClick={(event) => event.stopPropagation()}
                              >
                                <option value="">Profile…</option>
                                {characterTypeOptionsForSpeaker(speaker).map((option) => (
                                  <option key={`cast-${speaker.name}-${option.value}`} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                              {speakerNeedsMasculineReference(speaker) && (
                                <small className="studio-warning">Needs approved masculine reference WAV</small>
                              )}
                              {speakerNeedsMasculineReference(speaker) && speaker.character_type && (() => {
                                const pattern = voicePatterns.find((entry) => entry.value === speaker.character_type);
                                if (!pattern) return null;
                                return (
                                  <details className="speaker-reference-editor" onClick={(event) => event.stopPropagation()} open>
                                    <summary>Add reference to {pattern.label}</summary>
                                    <label>
                                      Audition WAV
                                      <input
                                        accept="audio/wav,audio/x-wav,audio/*"
                                        type="file"
                                        onChange={(event) => {
                                          const file = event.target.files?.[0];
                                          if (!file) return;
                                          const previousUrl = referenceAuditionUrls[pattern.value];
                                          if (previousUrl) URL.revokeObjectURL(previousUrl);
                                          const auditionUrl = URL.createObjectURL(file);
                                          setReferenceAuditionUrls((current) => ({ ...current, [pattern.value]: auditionUrl }));
                                          updateVoicePatternDraft(pattern.value, { reference_status: "candidate" });
                                        }}
                                      />
                                      <small>Audition here, then paste the real Mac path below for rendering.</small>
                                    </label>
                                    {referenceAuditionUrls[pattern.value] && (
                                      <audio controls src={referenceAuditionUrls[pattern.value]} />
                                    )}
                                    <label>
                                      Renderable WAV path
                                      <input
                                        value={pattern.reference_audio_path}
                                        onChange={(event) => updateVoicePatternDraft(pattern.value, {
                                          reference_audio_path: event.target.value,
                                          reference_status: event.target.value.trim() ? "candidate" : "needed",
                                        })}
                                        placeholder="/Users/kristykelly/.../middle-aged-man.wav"
                                      />
                                    </label>
                                    <label>
                                      Reference text
                                      <textarea
                                        value={pattern.reference_text}
                                        onChange={(event) => updateVoicePatternDraft(pattern.value, { reference_text: event.target.value })}
                                        placeholder="Text spoken in the reference WAV"
                                      />
                                    </label>
                                    <button
                                      className="button primary"
                                      disabled={!pattern.reference_audio_path.trim()}
                                      onClick={() => approveReferenceForSpeakerProfile(speaker)}
                                    >
                                      Approve for {pattern.label}
                                    </button>
                                  </details>
                                );
                              })()}
                              {speakerHasApprovedReference(speaker) && (
                                <small className="muted">Using approved profile WAV</small>
                              )}
                              <details onClick={(event) => event.stopPropagation()}>
                                <summary>Voice override</summary>
                                <select
                                  aria-label={`Voice for ${speaker.name}`}
                                  value={canonicalVoiceValue(speaker.approved_voice)}
                                  onChange={(event) => updateSpeakerVoiceForBook(speaker.name, event.target.value)}
                                >
                                  <option value="">Choose voice…</option>
                                  {voiceOptionsForSpeaker(speaker).map((option) => (
                                    <option key={`voice-${speaker.name}-${option.value}`} value={option.value}>
                                      {option.label}
                                    </option>
                                  ))}
                                </select>
                              </details>
                            </div>
                          )) : <p className="materials-empty">No speakers identified yet.</p>}
                          <span className="unassigned-note"><i className="missed-swatch" /> Unassigned quote</span>
                        </div>
                        <strong className="side-section-title">Add missed speaker</strong>
                        <div className="actions">
                          <input value={manualSpeakerName} onChange={(event) => setManualSpeakerName(event.target.value)} placeholder="Speaker name" />
                          <button className="button" onClick={addManualSpeaker}>Add speaker</button>
                        </div>
                        {(activeScene.dialogue_assignments ?? []).length > 0 && (
                          <details className="manual-assignment-list">
                            <summary>Assignments</summary>
                            {(activeScene.dialogue_assignments ?? []).map((assignment) => (
                              <div key={assignment.id} className="manual-assignment">
                                <span><i style={{ backgroundColor: assignment.color }} />{assignment.speaker}</span>
                                <small>{assignment.text}</small>
                                <button className="button ghost" onClick={() => removeDialogueAssignment(assignment.id)}>Remove</button>
                              </div>
                            ))}
                          </details>
                        )}
                      </div>
                    </div>
                    <details className="dialogue-line-editor">
                      <summary>Advanced dialogue rows</summary>
                      <div className="speaker-text-head">
                        <div>
                          <strong>Dialogue lines to render</strong>
                          <small>These rows are the render source for character voices. Fix the speaker or wording here before approving voices.</small>
                        </div>
                      </div>
                      {dialogueLineSegments(activeScene).length ? dialogueLineSegments(activeScene).map((segment, index) => {
                        const assignment = assignmentForSegment(activeScene, segment);
                        const currentSpeaker = segment.speaker === "Unassigned" ? "" : segment.speaker || "";
                        const currentTone = assignment?.tone || "";
                        const currentUrgency = assignment?.urgency || "medium";
                        return (
                          <div className={`dialogue-line-row ${segment.missed || segment.speaker === "Unassigned" ? "needs-speaker" : ""}`} key={`${segment.start}-${segment.end}-${index}`}>
                            <label>
                              Speaker
                              <select
                                defaultValue={currentSpeaker}
                                onChange={(event) => saveDialogueLine(segment, event.target.value, segment.text, { tone: currentTone, urgency: currentUrgency })}
                              >
                                <option value="">Choose speaker…</option>
                                {activeScene.speakers.map((speaker) => (
                                  <option key={`line-${index}-${speaker.name}`} value={speaker.name}>{speaker.name}</option>
                                ))}
                              </select>
                            </label>
                            <label>
                              Tone
                              <select
                                defaultValue={currentTone}
                                onChange={(event) => {
                                  if (currentSpeaker) saveDialogueLine(segment, currentSpeaker, segment.text, { tone: event.target.value, urgency: currentUrgency });
                                }}
                              >
                                <option value="">Default</option>
                                <option value="dry">Dry</option>
                                <option value="warm">Warm</option>
                                <option value="snarky">Snarky</option>
                                <option value="scared">Scared</option>
                                <option value="angry">Angry</option>
                                <option value="tender">Tender</option>
                                <option value="teasing">Teasing</option>
                                <option value="deadpan">Deadpan</option>
                                <option value="urgent">Urgent</option>
                              </select>
                            </label>
                            <label>
                              Urgency
                              <select
                                defaultValue={currentUrgency}
                                onChange={(event) => {
                                  if (currentSpeaker) saveDialogueLine(segment, currentSpeaker, segment.text, { tone: currentTone, urgency: event.target.value as StudioDialogueAssignment["urgency"] });
                                }}
                              >
                                <option value="low">Low</option>
                                <option value="medium">Medium</option>
                                <option value="high">High</option>
                              </select>
                            </label>
                            <label>
                              Line text
                              <textarea
                                defaultValue={segment.text}
                                onBlur={(event) => {
                                  if (currentSpeaker && event.target.value.trim() !== segment.text.trim()) {
                                    saveDialogueLine(segment, currentSpeaker, event.target.value, { tone: currentTone, urgency: currentUrgency });
                                  }
                                }}
                              />
                            </label>
                          </div>
                        );
                      }) : (
                        <p className="materials-empty">No quoted dialogue was found in this episode yet.</p>
                      )}
                    </details>
                    <div className="actions">
                      <button className="button primary" disabled={unassignedDialogueCount(activeScene) > 0} onClick={approveVoices}>Approve voices → sound effects</button>
                    </div>
                    {sceneStatus && <p className="muted">{sceneStatus}</p>}
                  </>
                )}

                {tab === "sfx" && (
                  <>
                    <p className="muted">Let the app find physical sound moments from the episode text, match likely assets from the local sound library, then approve only the suggestions that actually help the scene.</p>
                    <div className="actions">
                      <button className="button" onClick={refreshSfxSuggestions}>Analyze text for sound moments</button>
                      <span className="muted">{soundArchiveItems.length ? `${soundArchiveItems.length.toLocaleString()} local sounds indexed` : "Sound library index loading…"}</span>
                    </div>
                    <div className="studio-render-card sound-plan-review">
                      <strong>Sound layers</strong>
                      <small>Preview the matched file, check where it lands in the text, then approve the layer if it belongs in the scene.</small>
                      {activeScene.sfx_cues.length ? (
                        <div className="sound-layer-list">
                          {activeScene.sfx_cues.map((rawCue) => {
                            const cue = cueWithAssetMatch(rawCue);
                            return (
                              <div className={`sound-layer ${cue.suggested_asset_path ? "" : "unmatched"}`} key={cue.id}>
                                <div className="sound-layer-track">
                                  <label>
                                    <input type="checkbox" checked={cue.approved} onChange={() => toggleCue("sfx_cues", cue.id)} />
                                    <span>{cue.approved ? "Approved" : "Approve"}</span>
                                  </label>
                                  <strong>{cue.time || "0:00"}</strong>
                                </div>
                                <div className="sound-layer-main">
                                  <strong>{cue.label}</strong>
                                  <small>{cue.reason}</small>
                                  {cue.anchor_text && <small>Text: “{cue.anchor_text}”</small>}
                                  {cue.search_terms?.length ? <small>Search: {cue.search_terms.join(", ")}</small> : null}
                                </div>
                                <div className="sound-layer-audition">
                                  <small>{cue.suggested_asset_name || "No strong library match yet"}</small>
                                  {cue.suggested_asset_path && <small>{cue.suggested_asset_path}</small>}
                                  {cue.suggested_asset_path && (
                                    <audio controls preload="none" src={soundLibraryPreviewUrl(cue.suggested_asset_path)} />
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : <p className="materials-empty">No sound-effect moments were suggested for this episode yet.</p>}
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
                    <div className="studio-render-card sound-plan-review">
                      <strong>Voice render preview</strong>
                      <small>Check this before rendering: every dialogue line should show the correct speaker, profile, tone, urgency, and reference WAV.</small>
                      {renderPreviewRows(activeScene).length ? (
                        <div className="sound-plan-list">
                          {renderPreviewRows(activeScene).map((row) => (
                            <div className={`sound-plan-item ${row.missing ? "unmatched" : ""}`} key={row.key}>
                              <div>
                                <strong>{row.speakerName}</strong>
                                <small>{row.profile} · {row.tone} · urgency {row.urgency}</small>
                              </div>
                              <div>
                                <small>{row.text}</small>
                                <small>Reference: {referenceFileName(row.reference)}</small>
                                {row.missing && <small>Needs attention before render.</small>}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <small>No dialogue assignments are ready for character rendering. Return to Speakers and assign quoted lines before rendering.</small>
                      )}
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
                          {(activeScene.render_logic_export_dir || renderJob?.logic_export_dir) && <small>Logic export: {activeScene.render_logic_export_dir || renderJob?.logic_export_dir}</small>}
                          {(activeScene.render_logic_export_manifest || renderJob?.logic_export_manifest) && <small>Logic manifest: {activeScene.render_logic_export_manifest || renderJob?.logic_export_manifest}</small>}
                          {(activeScene.render_logic_markers_csv || renderJob?.logic_markers_csv) && <small>Logic markers: {activeScene.render_logic_markers_csv || renderJob?.logic_markers_csv}</small>}
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
