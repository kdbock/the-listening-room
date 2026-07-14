import { promises as fs } from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd(), "..", "Sound Library Downloads");
const output = path.resolve(process.cwd(), "public", "sound-archive-index.json");
const audioExtensions = new Set([".wav", ".mp3", ".aif", ".aiff", ".m4a", ".flac", ".ogg"]);

const typeRules = [
  { kind: "Ambience", terms: ["ambience", "ambience_", "ambi", "roomtone", "room tone", "atmos", "background", "storm", "rain", "wind", "coast", "ocean", "night", "cafe", "restaurant", "bar", "station", "hotel", "urban life", "public spaces"] },
  { kind: "People", terms: ["human", "voice", "vocal", "walla", "crowd", "cheer", "laugh", "cry", "pant", "breath", "male", "female", "people"] },
  { kind: "Foley", terms: ["foley", "cloth", "footstep", "footsteps", "paper", "book", "card", "handle", "switch", "button", "case", "velcro", "basket", "luggage", "telephone", "typewriter"] },
  { kind: "Transportation", terms: ["train", "tram", "car", "truck", "motorcycle", "vehicle", "driving", "traffic", "quadcopter", "transportation", "commute"] },
  { kind: "Water", terms: ["water", "liquid", "wave", "waves", "pool", "campfire", "bonfire", "underwater"] },
  { kind: "Weather", terms: ["weather", "rain", "storm", "wind", "hail", "thunder", "chimney wind", "fireworks ambience"] },
  { kind: "Transitions", terms: ["transition", "impact", "impacts", "boom", "braam", "whoosh", "swoosh", "glitch", "interface", "ui", "imaging", "production elements"] },
  { kind: "Music / Tonal", terms: ["music", "saxophone", "music box", "drone", "drones", "tonal", "horn", "braams"] },
  { kind: "Creatures / Fantasy", terms: ["creature", "monster", "magic", "fantasy", "horror", "sci-fi", "science fiction", "death whistle", "ghostly", "dinosaurs"] },
];

function titleCase(text) {
  return text
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function cleanName(filename) {
  return titleCase(path.basename(filename, path.extname(filename)));
}

function findKind(haystack) {
  const lower = haystack.toLowerCase();
  for (const rule of typeRules) {
    if (rule.terms.some((term) => lower.includes(term))) return rule.kind;
  }
  return "General";
}

function makeTags(parts) {
  const words = parts
    .flatMap((part) => part.split(/[^a-zA-Z0-9]+/))
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word.length > 2 && !/^\d+$/.test(word));
  return Array.from(new Set(words)).slice(0, 18);
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(fullPath));
      continue;
    }
    if (audioExtensions.has(path.extname(entry.name).toLowerCase())) files.push(fullPath);
  }
  return files;
}

const files = await walk(root);
const createdAt = new Date().toISOString();

const index = files.map((fullPath) => {
  const relativePath = path.relative(root, fullPath).split(path.sep).join("/");
  const parts = relativePath.split("/");
  const source = parts[0] ?? "Unknown";
  const bundle = parts[1] ?? "";
  const pack = parts.length > 2 ? parts[2] : bundle;
  const filename = parts.at(-1) ?? "";
  const searchText = `${relativePath} ${filename}`;

  return {
    id: relativePath,
    name: cleanName(filename),
    source,
    bundle,
    pack,
    kind: findKind(searchText),
    relativePath,
    tags: makeTags(parts),
  };
}).sort((a, b) => a.name.localeCompare(b.name));

await fs.writeFile(output, JSON.stringify({ createdAt, total: index.length, items: index }));
console.log(`Indexed ${index.length} sounds into ${output}`);
