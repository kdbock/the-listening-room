#!/usr/bin/env python3
"""Render the established Pangea TTS parts with the locked Nix narrator voice."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import time
import wave

from mlx_audio.tts.generate import generate_audio
from mlx_audio.tts.utils import load_model


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "tts-google-ready"
OUTPUT_DIR = ROOT / "local-narrator" / "parts-wav"
REFERENCE_AUDIO = ROOT / "local-narrator" / "nix-voice-reference.wav"
REFERENCE_TEXT_FILE = ROOT / "local-narrator" / "nix-voice-reference.txt"
MODEL_ID = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit"
MANIFEST = OUTPUT_DIR / "render-manifest.json"


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as audio:
        return audio.getnframes() / audio.getframerate()


def load_manifest() -> dict:
    if not MANIFEST.exists():
        return {"model": MODEL_ID, "voice_reference": REFERENCE_AUDIO.name, "files": {}}
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def save_manifest(manifest: dict) -> None:
    temp = MANIFEST.with_suffix(".json.tmp")
    temp.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    os.replace(temp, MANIFEST)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, help="Render only this many pending parts")
    parser.add_argument("--force", action="store_true", help="Replace existing renders")
    args = parser.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    reference_text = REFERENCE_TEXT_FILE.read_text(encoding="utf-8").strip()
    sources = sorted(SOURCE_DIR.glob("??-??-part-??.txt"))
    pending = [p for p in sources if args.force or not (OUTPUT_DIR / f"{p.stem}.wav").exists()]
    if args.limit is not None:
        pending = pending[: args.limit]
    if not pending:
        print("All requested parts already exist.", flush=True)
        return

    print(f"Loading locked Nix voice model for {len(pending)} part(s)...", flush=True)
    model = load_model(MODEL_ID)
    manifest = load_manifest()

    for number, source in enumerate(pending, start=1):
        target = OUTPUT_DIR / f"{source.stem}.wav"
        generated = OUTPUT_DIR / f".{source.stem}-render_000.wav"
        if generated.exists():
            generated.unlink()
        text = source.read_text(encoding="utf-8").strip()
        started = time.time()
        print(f"[{number}/{len(pending)}] Rendering {source.stem}...", flush=True)
        generate_audio(
            text=text,
            model=model,
            max_tokens=4096,
            voice=None,
            lang_code="en",
            ref_audio=str(REFERENCE_AUDIO),
            ref_text=reference_text,
            output_path=str(OUTPUT_DIR),
            file_prefix=f".{source.stem}-render",
            audio_format="wav",
            temperature=0.7,
            verbose=False,
        )
        if not generated.exists():
            raise RuntimeError(f"No audio was produced for {source.name}")
        os.replace(generated, target)
        duration = wav_duration(target)
        elapsed = time.time() - started
        manifest["files"][source.stem] = {
            "source": source.name,
            "output": target.name,
            "words": len(text.split()),
            "duration_seconds": round(duration, 3),
            "render_seconds": round(elapsed, 3),
        }
        save_manifest(manifest)
        print(f"[{number}/{len(pending)}] Finished {target.name}: {duration / 60:.2f} minutes", flush=True)


if __name__ == "__main__":
    main()
