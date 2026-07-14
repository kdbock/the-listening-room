import {
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  setDoc,
} from "firebase/firestore";
import { firestoreCollections } from "./collections";
import { getClientFirestore } from "./client";

export type VoicePatternGender = "feminine" | "masculine" | "neutral";

export type VoicePattern = {
  id: string;
  value: string;
  label: string;
  detail: string;
  gender: VoicePatternGender;
  voice: string;
  age_feel: string;
  accent: string;
  personality: string;
  delivery: string;
  avoid: string;
  reference_audio_path: string;
  reference_text: string;
  sort_order: number;
  updated_at: string;
  created_at: string;
};

const starterPatterns: Array<Omit<VoicePattern, "id" | "updated_at" | "created_at">> = [
  {
    value: "warm_grounded_feminine",
    label: "Warm grounded feminine",
    detail: "Steady, practical, emotionally present",
    gender: "feminine",
    voice: "tamsin_voice",
    age_feel: "Adult",
    accent: "Neutral American unless the book calls for subtle regional color.",
    personality: "Practical warmth, moral steadiness, protective but not sentimental.",
    delivery: "Grounded pace, clear diction, complete thoughts, softens only when reassurance matters.",
    avoid: "Maternal caricature, fragile breathiness, melodrama.",
    reference_audio_path: "local-narrator/voice-approved/PG2026/tamsin/tamsin-reference.v001.wav",
    reference_text: "",
    sort_order: 10,
  },
  {
    value: "bright_direct_feminine",
    label: "Bright direct feminine",
    detail: "Clear, alert, forward, sincere",
    gender: "feminine",
    voice: "orra_voice",
    age_feel: "Adult / young adult",
    accent: "Neutral American, light and direct.",
    personality: "Alert, sincere, decisive, emotionally readable.",
    delivery: "Moderate pace, forward placement, questions seek real answers, urgency brightens rather than shrieks.",
    avoid: "Childlike pitch, panic as default, sing-song questions.",
    reference_audio_path: "local-narrator/voice-approved/PG2026/orra/orra-reference.v001.wav",
    reference_text: "",
    sort_order: 20,
  },
  {
    value: "weathered_low_feminine",
    label: "Weathered low feminine",
    detail: "Calm, dry, mature, controlled",
    gender: "feminine",
    voice: "ressa_voice",
    age_feel: "Adult / mature adult",
    accent: "Neutral with possible subtle coastal/plainspoken color.",
    personality: "Capable, observant, dry private amusement, rarely overexplains.",
    delivery: "Measured, economical, controlled; firmness without volume.",
    avoid: "Smug caricature, mystical whispering, copying another character's bite.",
    reference_audio_path: "local-narrator/voice-approved/PG2026/ressa/ressa-reference.v001.wav",
    reference_text: "",
    sort_order: 30,
  },
  {
    value: "guarded_quick_feminine",
    label: "Guarded quick feminine",
    detail: "Wiry, defensive, fast, witty",
    gender: "feminine",
    voice: "nix_voice",
    age_feel: "Adult / young adult",
    accent: "Neutral with informal edge.",
    personality: "Tactical, sarcastic, guarded, loyal under the armor.",
    delivery: "Quick timing, crisp consonants, deadpan turns, quieter and more exact under threat.",
    avoid: "Constant rasp, broad comedy, breathless speed.",
    reference_audio_path: "local-narrator/voice-approved/PG2026/nix/nix-reference.v001.wav",
    reference_text: "",
    sort_order: 40,
  },
  {
    value: "very_low_feminine",
    label: "Very low feminine",
    detail: "Sparse, grounded, forceful contralto",
    gender: "feminine",
    voice: "flint_voice",
    age_feel: "Adult / mature adult",
    accent: "Neutral or invented fantasy coloring; not a real-world caricature.",
    personality: "Sparse, protective, physically certain, dry humor.",
    delivery: "Deliberate and spare; force comes by dropping lower and firmer.",
    avoid: "Monster growl, slow stupidity, constant aggression.",
    reference_audio_path: "local-narrator/voice-approved/PG2026/flint/flint-reference.v001.wav",
    reference_text: "",
    sort_order: 50,
  },
  {
    value: "protective_older_masculine",
    label: "Protective older masculine",
    detail: "Needs masculine reference WAV",
    gender: "masculine",
    voice: "",
    age_feel: "Older adult",
    accent: "Optional subtle Southern softness or neutral American.",
    personality: "Protective, regret under the surface, patient, controlled.",
    delivery: "Low warm baritone target, unhurried, emotionally restrained until it matters.",
    avoid: "Booming announcer, cartoon dad, forced gruffness.",
    reference_audio_path: "",
    reference_text: "",
    sort_order: 60,
  },
  {
    value: "warm_adult_masculine",
    label: "Warm adult masculine",
    detail: "Needs masculine reference WAV",
    gender: "masculine",
    voice: "",
    age_feel: "Adult",
    accent: "Neutral American unless casting notes specify otherwise.",
    personality: "Open, trustworthy, steady, emotionally available.",
    delivery: "Medium-low target, conversational, relaxed, sincere.",
    avoid: "Salesman polish, melodrama, excessive breath.",
    reference_audio_path: "",
    reference_text: "",
    sort_order: 70,
  },
  {
    value: "polished_dangerous_masculine",
    label: "Polished dangerous masculine",
    detail: "Needs masculine reference WAV",
    gender: "masculine",
    voice: "",
    age_feel: "Adult / older adult",
    accent: "Light British formality or cultivated neutral; subtle only.",
    personality: "Civilized, strategic, amused, dangerous because he stays calm.",
    delivery: "Precise diction, balanced sentences, strategic silence, quiet menace.",
    avoid: "Villain purr, theatrical sneer, booming authority.",
    reference_audio_path: "",
    reference_text: "",
    sort_order: 80,
  },
  {
    value: "narrator_neutral",
    label: "Narrator / neutral",
    detail: "Use the narrator voice for this type",
    gender: "neutral",
    voice: "narrator_voice",
    age_feel: "Adult",
    accent: "Neutral American.",
    personality: "Observant, literary, restrained, emotionally intelligent.",
    delivery: "Unhurried cadence, clean diction, narrator remains foreground but not theatrical.",
    avoid: "Character impersonation, melodrama, sing-song cadence.",
    reference_audio_path: "local-narrator/nix-voice-reference.wav",
    reference_text: "",
    sort_order: 90,
  },
];

function nowIso() {
  return new Date().toISOString();
}

function normalizeVoicePattern(id: string, data: Partial<VoicePattern>): VoicePattern {
  const timestamp = nowIso();
  return {
    id,
    value: data.value ?? id,
    label: data.label ?? id,
    detail: data.detail ?? "",
    gender: data.gender ?? "neutral",
    voice: data.voice ?? "",
    age_feel: data.age_feel ?? "",
    accent: data.accent ?? "",
    personality: data.personality ?? "",
    delivery: data.delivery ?? "",
    avoid: data.avoid ?? "",
    reference_audio_path: data.reference_audio_path ?? "",
    reference_text: data.reference_text ?? "",
    sort_order: Number(data.sort_order ?? 999),
    updated_at: data.updated_at ?? timestamp,
    created_at: data.created_at ?? timestamp,
  };
}

export async function ensureStarterVoicePatterns() {
  const db = getClientFirestore();
  const patternsCollection = collection(db, firestoreCollections.voicePatterns);
  const snapshot = await getDocs(patternsCollection);
  if (!snapshot.empty) return;
  const timestamp = nowIso();
  await Promise.all(starterPatterns.map((pattern) => setDoc(doc(db, firestoreCollections.voicePatterns, pattern.value), {
    ...pattern,
    created_at: timestamp,
    updated_at: timestamp,
  })));
}

export async function listVoicePatterns(): Promise<VoicePattern[]> {
  await ensureStarterVoicePatterns();
  const db = getClientFirestore();
  const snapshot = await getDocs(query(collection(db, firestoreCollections.voicePatterns), orderBy("sort_order", "asc")));
  return snapshot.docs.map((entry) => normalizeVoicePattern(entry.id, entry.data() as Partial<VoicePattern>));
}

export async function saveVoicePattern(pattern: VoicePattern): Promise<VoicePattern> {
  const db = getClientFirestore();
  const timestamp = nowIso();
  const saved = {
    ...pattern,
    value: pattern.value || pattern.id,
    updated_at: timestamp,
    created_at: pattern.created_at || timestamp,
  };
  await setDoc(doc(db, firestoreCollections.voicePatterns, saved.value), saved, { merge: true });
  return normalizeVoicePattern(saved.value, saved);
}
