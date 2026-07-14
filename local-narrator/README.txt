PANGEA LOCAL NARRATOR

Purpose
Create scene-level Pangea narration locally on Apple Silicon without subscriptions or per-character charges.

Selected engine
Qwen3-TTS 1.7B VoiceDesign, optimized for Apple MLX at 8-bit precision.

Locked narrator
Audition 06: a mature American woman in her mid-to-late forties, with open chest-and-mouth resonance, a smoky mezzo-contralto register, clean grain, dry intelligence, and an unhurried literary cadence. The approved short reference is nix-voice-reference.wav with its exact transcript in nix-voice-reference.txt.

Locked production method
Render each sentence independently from the short reference, trim only excess edge silence, then join with a short pause after sentences and a longer pause after paragraphs. Do not time-stretch. Do not use the rejected long reference, which leaked calibration text into rendered clips. The approved benchmark is Part 01 created by tools/render_local_narration_segmented.py.

The model runtime and weights are stored outside this iCloud folder. Finished auditions and scene audio belong in the audio subfolder.

Pronunciation correction
Chapter 1, Part 1 received a timing-preserving correction at 00:18.89 so “Nix had” is spoken cleanly. The pre-correction master is preserved in backups-before-pronunciation-fixes.
