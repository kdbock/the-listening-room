#!/usr/bin/env python3
"""Generate one book-scoped synthetic character audition with Qwen VoiceDesign."""

from __future__ import annotations

import argparse
import contextlib
import io
import os
from pathlib import Path

from mlx_audio.tts.generate import generate_audio
from mlx_audio.tts.utils import load_model


LOCAL_MODEL = Path("/Volumes/ExternalDrive/LocalNarrationStudio/models/qwen3-tts-1.7b-voicedesign-8bit")
MODEL_ID = str(LOCAL_MODEL) if (LOCAL_MODEL / "config.json").exists() else "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", required=True)
    parser.add_argument("--instruct", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists():
        raise FileExistsError(f"Refusing to overwrite {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    model = load_model(MODEL_ID)
    prefix = f".{output.stem}-render"
    generated = output.parent / f"{prefix}_000.wav"
    with contextlib.redirect_stdout(io.StringIO()):
        generate_audio(
            text=args.text, model=model, max_tokens=1024, voice=None,
            instruct=args.instruct, lang_code="en", output_path=str(output.parent),
            file_prefix=prefix, audio_format="wav", temperature=0.65, verbose=False,
        )
    if not generated.exists():
        raise RuntimeError("VoiceDesign did not produce an audition WAV.")
    os.replace(generated, output)
    print(f"Finished {output}", flush=True)


if __name__ == "__main__":
    main()
