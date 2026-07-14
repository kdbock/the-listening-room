import type { SceneRecord, StudioCue, StudioSpeaker } from "@/lib/firebase/scenes";

const speakerColors = ["#f4c7c3", "#c8dfc8", "#c8d8f0", "#f1d29b", "#d6c5ee", "#bfe3df", "#efc7dc"];

const sfxRules: Array<{ terms: string[]; label: string; reason: string }> = [
  { terms: ["door", "knock", "entered", "emerged", "left", "leaving"], label: "Door and threshold movement", reason: "A character enters, exits, or crosses a threshold here." },
  { terms: ["footstep", "walk", "paced", "crossed", "stairs", "towards"], label: "Character footsteps", reason: "Physical movement can give this beat shape without overpowering the narration." },
  { terms: ["car", "truck", "drive", "engine", "parking"], label: "Vehicle movement", reason: "A vehicle action or nearby vehicle is part of the scene." },
  { terms: ["box", "boxes", "suitcase", "bag", "packed"], label: "Boxes and luggage handling", reason: "Handled objects can make the physical business of the scene audible." },
  { terms: ["phone", "called", "calling", "text me"], label: "Phone handling or ring", reason: "A phone action creates a clear, optional sound-design beat." },
  { terms: ["cry", "tears", "sob", "scream"], label: "Subtle cloth and breath detail", reason: "A restrained close detail could support the emotional action without literalizing it." },
  { terms: ["rain", "storm", "wind", "thunder"], label: "Weather accent", reason: "The environment includes weather detail worth testing." },
  { terms: ["ship", "boat", "deck", "harbor", "sea", "shore"], label: "Water or vessel detail", reason: "The language points to a nautical environment cue." },
  { terms: ["bell", "church", "clock", "christmas music"], label: "Bell or music-source detail", reason: "The text includes a specific audible source that can locate the listener." },
  { terms: ["kiss", "hug", "arms around"], label: "Clothing movement", reason: "Very light fabric movement could make this intimate action feel present." },
];

const ambienceRules: Array<{ terms: string[]; label: string; reason: string }> = [
  { terms: ["night", "dark", "quiet"], label: "Low night room tone", reason: "The scene reads like a restrained low-light environment." },
  { terms: ["street", "city", "market", "crowd"], label: "Urban background bed", reason: "The setting suggests distant public activity." },
  { terms: ["sea", "shore", "harbor", "dock", "ship"], label: "Harbor / sea ambience", reason: "The setting points to coastal or ship atmosphere." },
  { terms: ["forest", "woods", "birds", "wind"], label: "Natural exterior ambience", reason: "The text suggests an outdoor organic bed." },
  { terms: ["church", "cathedral", "hall"], label: "Large interior room tone", reason: "The scene feels like it belongs in a resonant interior space." },
];

function cleanLine(line: string) {
  return line.replace(/[“”"]/g, "").trim();
}

function sceneTitle(index: number, text: string) {
  const firstLine = text.split(/\n+/).map((line) => cleanLine(line)).find(Boolean) ?? `Scene ${index + 1}`;
  return firstLine.length > 48 ? `${firstLine.slice(0, 45)}…` : firstLine;
}

function estimateMinutes(wordCount: number) {
  return Math.max(3, Math.min(5, Math.round(wordCount / 150)));
}

function splitIntoScenes(text: string) {
  const paragraphs = text
    .split(/\n\s*\n+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const scenes: string[] = [];
  let current = "";
  let currentWords = 0;

  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).length;
    if (current && currentWords + words > 650) {
      scenes.push(current.trim());
      current = paragraph;
      currentWords = words;
    } else {
      current = `${current}\n\n${paragraph}`.trim();
      currentWords += words;
    }
  }

  if (current) scenes.push(current.trim());
  return scenes;
}

function extractSpeakers(text: string): StudioSpeaker[] {
  const matches = Array.from(text.matchAll(/[“"]([^”"]+)[”"](?:\s*,?\s*(?:said|asked|replied|whispered|murmured|snapped)\s+([A-Z][a-zA-Z'-]+)|\s*,?\s*([A-Z][a-zA-Z'-]+)\s+(?:said|asked|replied|whispered|murmured|snapped))?/g));
  const counts = new Map<string, number>();

  for (const match of matches) {
    const speaker = match[2] || match[3] || "Unassigned";
    counts.set(speaker, (counts.get(speaker) ?? 0) + 1);
  }

  return Array.from(counts.entries()).map(([name, line_count], index) => ({
    name,
    line_count,
    recommended_voice: "",
    approved_voice: "",
    color: speakerColors[index % speakerColors.length],
    status: "recommended",
  }));
}

function cueTime(text: string, terms: string[]) {
  const lower = text.toLowerCase();
  const positions = terms.map((term) => lower.indexOf(term)).filter((position) => position >= 0);
  const position = positions.length ? Math.min(...positions) : 0;
  const wordsBefore = text.slice(0, position).trim().split(/\s+/).filter(Boolean).length;
  const seconds = Math.max(0, Math.round(wordsBefore / 2.5));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function buildCues(text: string, rules: Array<{ terms: string[]; label: string; reason: string }>, limit = 6): StudioCue[] {
  const lower = text.toLowerCase();
  return rules
    .filter((rule) => rule.terms.some((term) => lower.includes(term)))
    .slice(0, limit)
    .map((rule, index) => ({
      id: `${rule.label}-${index}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      label: rule.label,
      reason: rule.reason,
      approved: false,
      time: cueTime(text, rule.terms),
    }));
}

export function recommendSfxCues(text: string) {
  return buildCues(text, sfxRules, 6);
}

export function recommendAmbienceCues(text: string) {
  return buildCues(text, ambienceRules, 4);
}

export function recommendSpeakersForEpisode(text: string) {
  return extractSpeakers(text);
}

export function buildScenesFromManuscript(bookId: string, manuscriptText: string): Omit<SceneRecord, "id" | "created_at" | "updated_at">[] {
  return splitIntoScenes(manuscriptText).map((text, index) => {
    const words = text.split(/\s+/).length;
    return {
      book_id: bookId,
      title: sceneTitle(index, text),
      scene_order: index + 1,
      text,
      estimated_minutes: estimateMinutes(words),
      speakers: extractSpeakers(text),
      sfx_cues: recommendSfxCues(text),
      ambience_cues: recommendAmbienceCues(text),
      narrator: "Local Qwen narrator",
      narrator_voice_id: "local-qwen",
      voice_notes: "",
      intro: "none",
      outro: "none",
      approvals: {
        script: false,
        voice: false,
        draft: false,
        sfx: false,
        music: false,
      },
      final_mix_status: "draft",
    };
  });
}
