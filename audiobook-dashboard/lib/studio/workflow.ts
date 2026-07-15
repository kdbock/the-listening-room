import type { SceneRecord, StudioCue, StudioSpeaker } from "@/lib/firebase/scenes";

const speakerColors = ["#f4c7c3", "#c8dfc8", "#c8d8f0", "#f1d29b", "#d6c5ee", "#bfe3df", "#efc7dc"];

const masculineNames = ["gregory", "greg", "john", "michael", "david", "daniel", "james", "robert", "william", "the ferryman"];
const feminineNames = ["kimberly", "megan", "meg", "kristy", "sarah", "nix", "orra", "ressa", "tamsin", "lio", "vessa"];

const sfxRules: Array<{ terms: string[]; required?: string[]; label: string; reason: string; search_terms: string[] }> = [
  { terms: ["knock", "knocked", "knocking"], label: "Door knock", reason: "A specific knock is written into the action.", search_terms: ["door", "knock", "wood", "tap"] },
  { terms: ["door opened", "door closed", "door slammed", "opened the door", "closed the door", "slammed the door"], label: "Door open / close", reason: "A specific door action is written into the scene.", search_terms: ["door", "open", "close", "slam", "creak"] },
  { terms: ["footsteps", "heels clicked", "boots thudded", "stairs creaked", "walked straight", "followed her"], label: "Footsteps / movement", reason: "The text calls out audible movement that could support staging.", search_terms: ["footsteps", "steps", "walk", "heels", "boots", "floor"] },
  { terms: ["engine started", "engine idled", "car door", "truck door", "storage truck", "waiting storage truck", "drive away", "drove away", "tires screeched"], label: "Vehicle / truck movement", reason: "A concrete vehicle or truck action is present in the scene.", search_terms: ["truck", "vehicle", "car", "engine", "drive", "door"] },
  { terms: ["phone rang", "phone buzzed", "text alert", "text me", "voicemail beep"], label: "Phone / text cue", reason: "The text references a phone/text moment that can be supported if desired.", search_terms: ["phone", "text", "notification", "alert", "buzz"] },
  { terms: ["glass shattered", "glass broke", "plate shattered", "cup shattered"], label: "Breaking glass", reason: "The scene contains a sharp break event.", search_terms: ["glass", "break", "shatter", "smash"] },
  { terms: ["thunder cracked", "thunder rumbled", "rain hit", "rain hammered"], label: "Weather accent", reason: "The weather is doing something audible at this moment.", search_terms: ["thunder", "rain", "storm", "weather"] },
  { terms: ["bell rang", "bells rang", "clock chimed", "alarm sounded"], label: "Bell / alarm", reason: "A clear source sound is named in the text.", search_terms: ["bell", "chime", "alarm", "clock"] },
  { terms: ["keys", "set the keys", "key turned", "lock clicked"], label: "Keys / lock detail", reason: "Small key or lock action appears in the text.", search_terms: ["keys", "key", "lock", "jingle", "metal"] },
  { terms: ["boxes", "box", "arms laden with boxes", "packed", "packing"], label: "Boxes / packing movement", reason: "The scene includes moving or handling boxes.", search_terms: ["box", "cardboard", "packing", "movement", "foley"] },
];

const ambienceRules: Array<{ terms: string[]; label: string; reason: string }> = [
  { terms: ["kitchen", "refrigerator", "stove", "sink"], label: "Quiet kitchen room tone", reason: "The setting appears to be a kitchen or domestic work area." },
  { terms: ["bedroom", "bed", "dresser", "closet"], label: "Soft bedroom room tone", reason: "The setting appears to be a private bedroom." },
  { terms: ["street", "sidewalk", "traffic", "city"], label: "Distant street ambience", reason: "The setting includes an urban exterior." },
  { terms: ["sea", "shore", "harbor", "dock", "ship"], label: "Harbor / sea ambience", reason: "The setting points to coastal or ship atmosphere." },
  { terms: ["forest", "woods", "birds"], label: "Light natural exterior ambience", reason: "The setting is outdoors in a natural environment." },
  { terms: ["church", "cathedral"], label: "Large interior room tone", reason: "The setting is a resonant religious interior." },
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
    character_type: "",
    recommended_voice: "",
    approved_voice: "",
    gender: inferSpeakerGender(text, name),
    color: speakerColors[index % speakerColors.length],
    status: "recommended",
  }));
}

function inferSpeakerGender(text: string, name: string): StudioSpeaker["gender"] {
  const lowerName = name.toLowerCase();
  if (masculineNames.some((entry) => lowerName.includes(entry))) return "masculine";
  if (feminineNames.some((entry) => lowerName.includes(entry))) return "feminine";
  const firstName = name.split(/\s+/)[0];
  if (!firstName || name === "Unassigned") return "unknown";
  const escapedName = firstName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const contextPattern = new RegExp(`(?:\\b(?:he|him|his|she|her|hers)\\b.{0,80}\\b${escapedName}\\b|\\b${escapedName}\\b.{0,80}\\b(?:he|him|his|she|her|hers)\\b)`, "gi");
  const contexts = Array.from(text.matchAll(contextPattern)).map((match) => match[0].toLowerCase());
  const masculineHits = contexts.filter((context) => /\b(he|him|his)\b/.test(context)).length;
  const feminineHits = contexts.filter((context) => /\b(she|her|hers)\b/.test(context)).length;
  if (masculineHits > feminineHits) return "masculine";
  if (feminineHits > masculineHits) return "feminine";
  return "unknown";
}

function cuePositions(text: string, terms: string[]) {
  const lower = text.toLowerCase();
  const positions: Array<{ position: number; term: string }> = [];
  for (const term of terms) {
    const lowerTerm = term.toLowerCase();
    let position = lower.indexOf(lowerTerm);
    while (position >= 0) {
      positions.push({ position, term });
      position = lower.indexOf(lowerTerm, position + lowerTerm.length);
    }
  }
  return positions.sort((left, right) => left.position - right.position);
}

function cueTime(text: string, position: number) {
  const wordsBefore = text.slice(0, position).trim().split(/\s+/).filter(Boolean).length;
  const seconds = Math.max(0, Math.round(wordsBefore / 2.5));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function cueAnchor(text: string, position: number) {
  const sentenceStart = Math.max(text.lastIndexOf(".", position), text.lastIndexOf("\n", position), 0);
  const sentenceEndCandidates = [text.indexOf(".", position + 1), text.indexOf("\n", position + 1)].filter((entry) => entry > position);
  const sentenceEnd = sentenceEndCandidates.length ? Math.min(...sentenceEndCandidates) + 1 : Math.min(text.length, position + 220);
  return text.slice(sentenceStart === 0 ? 0 : sentenceStart + 1, sentenceEnd).replace(/\s+/g, " ").trim();
}

function buildCues(text: string, rules: Array<{ terms: string[]; required?: string[]; label: string; reason: string; search_terms?: string[] }>): StudioCue[] {
  const lower = text.toLowerCase();
  const cues: StudioCue[] = [];
  for (const rule of rules) {
    if (!rule.terms.some((term) => lower.includes(term)) || (rule.required && !rule.required.some((term) => lower.includes(term)))) continue;
    const positions = cuePositions(text, rule.terms);
    const acceptedPositions: number[] = [];
    for (const match of positions) {
      if (acceptedPositions.some((position) => Math.abs(position - match.position) < 80)) continue;
      acceptedPositions.push(match.position);
      const start = match.position;
      const matchedTerm = match.term;
      const end = Math.min(text.length, start + matchedTerm.length);
      cues.push({
        id: `${rule.label}-${cues.length}-${start}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        label: rule.label,
        reason: rule.reason,
        approved: false,
        time: cueTime(text, start),
        anchor_text: cueAnchor(text, start),
        start,
        end,
        search_terms: rule.search_terms ?? rule.terms,
        source: "Suggested from episode text.",
      });
    }
  }
  return cues.sort((left, right) => (left.start ?? 0) - (right.start ?? 0));
}

export function recommendSfxCues(text: string) {
  return buildCues(text, sfxRules);
}

export function recommendAmbienceCues(text: string) {
  return buildCues(text, ambienceRules);
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
