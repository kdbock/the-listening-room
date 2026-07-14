import type { SceneRecord, StudioCue, StudioSpeaker } from "@/lib/firebase/scenes";

const voicePalette = [
  "Warm grounded narrator",
  "Smoky contralto lead",
  "Clear reflective mezzo",
  "Measured low alto",
  "Weathered intimate tenor",
  "Bright alert supporting voice",
];

const sfxRules: Array<{ terms: string[]; label: string; reason: string }> = [
  { terms: ["door", "knock", "open", "close"], label: "Door / room movement", reason: "The scene text suggests a physical entry or exit." },
  { terms: ["footstep", "walk", "crossed", "stairs"], label: "Footsteps / movement", reason: "There is body movement that could be lightly reinforced." },
  { terms: ["rain", "storm", "wind", "thunder"], label: "Weather accent", reason: "The environment includes weather detail worth testing." },
  { terms: ["ship", "boat", "deck", "harbor", "sea"], label: "Water / vessel texture", reason: "The language points to nautical environment cues." },
  { terms: ["bell", "church", "clock"], label: "Bell or chime accent", reason: "The scene includes a bell-like story moment." },
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

function recommendVoice(index: number) {
  return voicePalette[index % voicePalette.length];
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
    recommended_voice: recommendVoice(index),
    approved_voice: recommendVoice(index),
    status: "recommended",
  }));
}

function buildCues(text: string, rules: Array<{ terms: string[]; label: string; reason: string }>): StudioCue[] {
  const lower = text.toLowerCase();
  return rules
    .filter((rule) => rule.terms.some((term) => lower.includes(term)))
    .slice(0, 4)
    .map((rule, index) => ({
      id: `${rule.label}-${index}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      label: rule.label,
      reason: rule.reason,
      approved: false,
    }));
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
      sfx_cues: buildCues(text, sfxRules),
      ambience_cues: buildCues(text, ambienceRules),
      narrator: "Listening Room narrator",
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
