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
export type VoicePatternReferenceStatus = "needed" | "candidate" | "approved";

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
  reference_status: VoicePatternReferenceStatus;
  sort_order: number;
  updated_at: string;
  created_at: string;
};

const starterPatterns: Array<Omit<VoicePattern, "id" | "updated_at" | "created_at">> = [
  {
    value: "older_woman",
    label: "Older woman",
    detail: "Mature, lower, controlled",
    gender: "feminine",
    voice: "ressa_voice",
    age_feel: "Older adult / mature adult",
    accent: "Neutral unless the book calls for subtle regional color.",
    personality: "Calm, dry, observant, controlled, rarely overexplains.",
    delivery: "Measured and economical; firmness without volume.",
    avoid: "Fragile caricature, mystical whispering, melodrama.",
    reference_audio_path: "local-narrator/voice-approved/PG2026/ressa/ressa-reference.v001.wav",
    reference_text: "",
    reference_status: "approved",
    sort_order: 10,
  },
  {
    value: "middle_aged_woman",
    label: "Middle-aged woman",
    detail: "Warm, grounded, practical",
    gender: "feminine",
    voice: "tamsin_voice",
    age_feel: "Middle-aged adult",
    accent: "Neutral American unless casting notes specify otherwise.",
    personality: "Practical warmth, moral steadiness, protective but not sentimental.",
    delivery: "Grounded pace, clear diction, complete thoughts, softens only when reassurance matters.",
    avoid: "Maternal caricature, fragile breathiness, melodrama.",
    reference_audio_path: "local-narrator/voice-approved/PG2026/tamsin/tamsin-reference.v001.wav",
    reference_text: "",
    reference_status: "approved",
    sort_order: 20,
  },
  {
    value: "young_woman",
    label: "Young woman",
    detail: "Clear, bright, direct",
    gender: "feminine",
    voice: "orra_voice",
    age_feel: "Young adult",
    accent: "Neutral American, light and direct.",
    personality: "Alert, sincere, decisive, emotionally readable.",
    delivery: "Moderate pace, forward placement, questions seek real answers.",
    avoid: "Childlike pitch, panic as default, sing-song questions.",
    reference_audio_path: "local-narrator/voice-approved/PG2026/orra/orra-reference.v001.wav",
    reference_text: "",
    reference_status: "approved",
    sort_order: 30,
  },
  {
    value: "teenage_woman",
    label: "Teenage woman",
    detail: "Quick, bright, emotionally immediate",
    gender: "feminine",
    voice: "orra_voice",
    age_feel: "Teen / late teen",
    accent: "Neutral, contemporary, light touch only.",
    personality: "Immediate, reactive, sincere, quick to cover vulnerability.",
    delivery: "Faster pace, brighter reactions, emotion closer to the surface.",
    avoid: "Cartoon teen voice, whining, childish exaggeration.",
    reference_audio_path: "local-narrator/voice-approved/PG2026/orra/orra-reference.v001.wav",
    reference_text: "",
    reference_status: "approved",
    sort_order: 40,
  },
  {
    value: "snarky_woman",
    label: "Snarky woman",
    detail: "Fast, guarded, witty",
    gender: "feminine",
    voice: "nix_voice",
    age_feel: "Adult / young adult",
    accent: "Neutral with informal edge.",
    personality: "Tactical, sarcastic, guarded, loyal under the armor.",
    delivery: "Quick timing, crisp consonants, deadpan turns, quieter and more exact under threat.",
    avoid: "Constant rasp, broad comedy, breathless speed.",
    reference_audio_path: "local-narrator/voice-approved/PG2026/nix/nix-reference.v001.wav",
    reference_text: "",
    reference_status: "approved",
    sort_order: 50,
  },
  {
    value: "deep_woman",
    label: "Deep woman",
    detail: "Very low, forceful contralto",
    gender: "feminine",
    voice: "flint_voice",
    age_feel: "Adult / mature adult",
    accent: "Neutral or invented fantasy coloring; not a real-world caricature.",
    personality: "Sparse, protective, physically certain, dry humor.",
    delivery: "Deliberate and spare; force comes by dropping lower and firmer.",
    avoid: "Monster growl, slow stupidity, constant aggression.",
    reference_audio_path: "local-narrator/voice-approved/PG2026/flint/flint-reference.v001.wav",
    reference_text: "",
    reference_status: "approved",
    sort_order: 60,
  },
  {
    value: "older_man",
    label: "Older man",
    detail: "Approved masculine reference WAV",
    gender: "masculine",
    voice: "",
    age_feel: "Older adult",
    accent: "Neutral, subtle Southern softness, or light formal polish depending on casting.",
    personality: "Protective, patient, controlled, regret or authority under the surface.",
    delivery: "Low warm baritone target, unhurried, emotionally restrained until it matters.",
    avoid: "Booming announcer, cartoon dad, forced gruffness.",
    reference_audio_path: "local-narrator/voice-approved/PG2026/older_man/older-man-reference.v001.wav",
    reference_text: "The lantern burned low beside the door. He had learned, after enough hard years, that patience could sound stronger than command.",
    reference_status: "approved",
    sort_order: 70,
  },
  {
    value: "middle_aged_man",
    label: "Middle-aged man",
    detail: "Approved masculine reference WAV",
    gender: "masculine",
    voice: "",
    age_feel: "Middle-aged adult",
    accent: "Neutral American unless casting notes specify otherwise.",
    personality: "Steady, direct, emotionally available or restrained depending on tone.",
    delivery: "Medium-low target, conversational, relaxed, sincere.",
    avoid: "Salesman polish, melodrama, excessive breath.",
    reference_audio_path: "local-narrator/voice-approved/PG2026/middle_aged_man/middle-aged-man-reference.v001.wav",
    reference_text: "The tide turned before dawn, and every promise came due. He kept his voice low, steady, and careful, because panic never solved anything worth surviving.",
    reference_status: "approved",
    sort_order: 80,
  },
  {
    value: "young_man",
    label: "Young man",
    detail: "Approved masculine reference WAV",
    gender: "masculine",
    voice: "",
    age_feel: "Young adult",
    accent: "Neutral, contemporary, light touch only.",
    personality: "Open, impulsive, charming, anxious, or guarded depending on tone.",
    delivery: "Quicker than older profiles, less weight, more immediate reactions.",
    avoid: "Cartoon frat voice, false bravado, monotone mumbling.",
    reference_audio_path: "local-narrator/voice-approved/PG2026/young_man/young-man-reference.v001.wav",
    reference_text: "He looked at the road ahead and tried to sound braver than he felt. The joke came first, because honesty needed a running start.",
    reference_status: "approved",
    sort_order: 90,
  },
  {
    value: "teenage_man",
    label: "Teenage man",
    detail: "Approved masculine reference WAV",
    gender: "masculine",
    voice: "",
    age_feel: "Teen / late teen",
    accent: "Neutral, contemporary, light touch only.",
    personality: "Reactive, vulnerable, cocky, funny, or scared depending on tone.",
    delivery: "Fast shifts, lighter placement, emotion close to the surface.",
    avoid: "Cartoon teen, cracking-voice gimmick, childish exaggeration.",
    reference_audio_path: "local-narrator/voice-approved/PG2026/teenage_man/teenage-man-reference.v001.wav",
    reference_text: "He shoved his hands in his pockets and pretended none of it mattered. It mattered, obviously, but saying that out loud felt like losing.",
    reference_status: "approved",
    sort_order: 100,
  },
  {
    value: "neutral_narrator",
    label: "Neutral narrator",
    detail: "Use narrator voice",
    gender: "neutral",
    voice: "narrator_voice",
    age_feel: "Adult",
    accent: "Neutral American.",
    personality: "Observant, literary, restrained, emotionally intelligent.",
    delivery: "Unhurried cadence, clean diction, narrator remains foreground but not theatrical.",
    avoid: "Character impersonation, melodrama, sing-song cadence.",
    reference_audio_path: "local-narrator/nix-voice-reference.wav",
    reference_text: "",
    reference_status: "approved",
    sort_order: 110,
  },
  {
    value: "neutral_androgynous",
    label: "Neutral / androgynous",
    detail: "Approved neutral reference WAV",
    gender: "neutral",
    voice: "",
    age_feel: "Adult",
    accent: "Neutral or lightly stylized depending on book world.",
    personality: "Flexible neutral profile for nonbinary, ambiguous, supernatural, or utility voices.",
    delivery: "Clear, restrained, adaptable to line tone.",
    avoid: "Robotic delivery unless explicitly desired.",
    reference_audio_path: "local-narrator/voice-approved/PG2026/neutral_androgynous/neutral-androgynous-reference.v001.wav",
    reference_text: "The room changed before anyone spoke. Some truths arrive quietly, and this one waited in the silence like a held breath.",
    reference_status: "approved",
    sort_order: 120,
  },
];

const legacyStarterUpdates: Array<Partial<VoicePattern> & { value: string }> = [
  { value: "weathered_low_feminine", label: "Older woman", detail: "Mature, lower, controlled", age_feel: "Older adult / mature adult", sort_order: 10 },
  { value: "warm_grounded_feminine", label: "Middle-aged woman", detail: "Warm, grounded, practical", age_feel: "Middle-aged adult", sort_order: 20 },
  { value: "bright_direct_feminine", label: "Young woman", detail: "Clear, bright, direct", age_feel: "Young adult", sort_order: 30 },
  { value: "guarded_quick_feminine", label: "Snarky woman", detail: "Fast, guarded, witty", age_feel: "Adult / young adult", sort_order: 50 },
  { value: "very_low_feminine", label: "Deep woman", detail: "Very low, forceful contralto", age_feel: "Adult / mature adult", sort_order: 60 },
  {
    value: "protective_older_masculine",
    label: "Older man",
    detail: "Approved masculine reference WAV",
    age_feel: "Older adult",
    reference_audio_path: "local-narrator/voice-approved/PG2026/older_man/older-man-reference.v001.wav",
    reference_text: "The lantern burned low beside the door. He had learned, after enough hard years, that patience could sound stronger than command.",
    reference_status: "approved",
    sort_order: 70,
  },
  {
    value: "older_man",
    label: "Older man",
    detail: "Approved masculine reference WAV",
    age_feel: "Older adult",
    reference_audio_path: "local-narrator/voice-approved/PG2026/older_man/older-man-reference.v001.wav",
    reference_text: "The lantern burned low beside the door. He had learned, after enough hard years, that patience could sound stronger than command.",
    reference_status: "approved",
    sort_order: 70,
  },
  {
    value: "middle_aged_man",
    label: "Middle-aged man",
    detail: "Approved masculine reference WAV",
    age_feel: "Middle-aged adult",
    reference_audio_path: "local-narrator/voice-approved/PG2026/middle_aged_man/middle-aged-man-reference.v001.wav",
    reference_text: "The tide turned before dawn, and every promise came due. He kept his voice low, steady, and careful, because panic never solved anything worth surviving.",
    reference_status: "approved",
    sort_order: 80,
  },
  {
    value: "warm_adult_masculine",
    label: "Middle-aged man",
    detail: "Approved masculine reference WAV",
    age_feel: "Middle-aged adult",
    reference_audio_path: "local-narrator/voice-approved/PG2026/middle_aged_man/middle-aged-man-reference.v001.wav",
    reference_text: "The tide turned before dawn, and every promise came due. He kept his voice low, steady, and careful, because panic never solved anything worth surviving.",
    reference_status: "approved",
    sort_order: 80,
  },
  {
    value: "young_man",
    label: "Young man",
    detail: "Approved masculine reference WAV",
    age_feel: "Young adult",
    reference_audio_path: "local-narrator/voice-approved/PG2026/young_man/young-man-reference.v001.wav",
    reference_text: "He looked at the road ahead and tried to sound braver than he felt. The joke came first, because honesty needed a running start.",
    reference_status: "approved",
    sort_order: 90,
  },
  {
    value: "polished_dangerous_masculine",
    label: "Polished man",
    detail: "Approved masculine reference WAV",
    age_feel: "Adult / older adult",
    reference_audio_path: "local-narrator/voice-approved/PG2026/polished_man/polished-man-reference.v001.wav",
    reference_text: "He smiled as if the answer had always belonged to him. Courtesy was useful, especially when it hid the blade underneath.",
    reference_status: "approved",
    sort_order: 90,
  },
  {
    value: "teenage_man",
    label: "Teenage man",
    detail: "Approved masculine reference WAV",
    age_feel: "Teen / late teen",
    reference_audio_path: "local-narrator/voice-approved/PG2026/teenage_man/teenage-man-reference.v001.wav",
    reference_text: "He shoved his hands in his pockets and pretended none of it mattered. It mattered, obviously, but saying that out loud felt like losing.",
    reference_status: "approved",
    sort_order: 100,
  },
  {
    value: "neutral_androgynous",
    label: "Neutral / androgynous",
    detail: "Approved neutral reference WAV",
    age_feel: "Adult",
    reference_audio_path: "local-narrator/voice-approved/PG2026/neutral_androgynous/neutral-androgynous-reference.v001.wav",
    reference_text: "The room changed before anyone spoke. Some truths arrive quietly, and this one waited in the silence like a held breath.",
    reference_status: "approved",
    sort_order: 120,
  },
  { value: "narrator_neutral", label: "Neutral narrator", detail: "Use narrator voice", age_feel: "Adult", sort_order: 110 },
];

const starterSupersededByLegacy: Record<string, string> = {
  older_woman: "weathered_low_feminine",
  middle_aged_woman: "warm_grounded_feminine",
  young_woman: "bright_direct_feminine",
  snarky_woman: "guarded_quick_feminine",
  deep_woman: "very_low_feminine",
  older_man: "protective_older_masculine",
  middle_aged_man: "warm_adult_masculine",
  neutral_narrator: "narrator_neutral",
};

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
    reference_status: data.reference_status ?? (data.reference_audio_path ? "approved" : "needed"),
    sort_order: Number(data.sort_order ?? 999),
    updated_at: data.updated_at ?? timestamp,
    created_at: data.created_at ?? timestamp,
  };
}

export async function ensureStarterVoicePatterns() {
  const db = getClientFirestore();
  const patternsCollection = collection(db, firestoreCollections.voicePatterns);
  const snapshot = await getDocs(patternsCollection);
  const timestamp = nowIso();
  const existingIds = new Set(snapshot.docs.map((entry) => entry.id));
  const creates = starterPatterns
    .filter((pattern) => !existingIds.has(pattern.value) && !existingIds.has(starterSupersededByLegacy[pattern.value]))
    .map((pattern) => setDoc(doc(db, firestoreCollections.voicePatterns, pattern.value), {
      ...pattern,
      created_at: timestamp,
      updated_at: timestamp,
    }));
  const legacyUpdates = legacyStarterUpdates
    .filter((pattern) => existingIds.has(pattern.value))
    .map((pattern) => setDoc(doc(db, firestoreCollections.voicePatterns, pattern.value), {
      ...pattern,
      updated_at: timestamp,
    }, { merge: true }));
  await Promise.all([...creates, ...legacyUpdates]);
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
