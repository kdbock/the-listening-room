export const firestoreCollections = {
  books: "books",
  scenes: "scenes",
  materials: "materials",
  sounds: "sounds",
  characters: "characters",
  voiceApprovals: "voice_approvals",
  soundEffectCues: "sfx_cues",
  musicCues: "music_cues",
  renders: "renders",
  renderJobs: "render_jobs",
  soundLibraryIndex: "sound_library_index",
} as const;

export const firestorePlan = {
  sourceOfTruth: [
    "books",
    "scenes",
    "speaker assignments",
    "voice approvals",
    "sound effect approvals",
    "music approvals",
    "render status",
  ],
  iCloudWarehouse: [
    "original manuscripts",
    "raw sound packs",
    "large wav exports",
    "backup masters",
    "archive material",
  ],
} as const;
