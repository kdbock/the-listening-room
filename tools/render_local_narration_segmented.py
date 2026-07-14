#!/usr/bin/env python3
"""Render Pangea narration sentence by sentence with deliberate pauses."""

from __future__ import annotations

import argparse
import contextlib
import io
import os
from pathlib import Path
import re
import wave

import numpy as np
from mlx_audio.tts.generate import generate_audio
from mlx_audio.tts.utils import load_model


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "tts-google-ready"
DEFAULT_OUTPUT_DIR = ROOT / "local-narrator" / "parts-wav-segmented"
REFERENCE_AUDIO = ROOT / "local-narrator" / "nix-voice-reference.wav"
REFERENCE_TEXT = ROOT / "local-narrator" / "nix-voice-reference.txt"
MODEL_ID = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit"
ABBREVIATIONS = {"mr.", "mrs.", "ms.", "dr.", "st.", "capt.", "lt.", "no."}


def split_sentences(paragraph: str) -> list[str]:
    paragraph = re.sub(r"\s+", " ", paragraph.strip())
    if not paragraph:
        return []
    parts: list[str] = []
    start = 0
    i = 0
    closers = '.?!"\'”’*'
    while i < len(paragraph):
        if paragraph[i] not in ".?!":
            i += 1
            continue
        j = i + 1
        while j < len(paragraph) and paragraph[j] in closers:
            j += 1
        is_boundary = j == len(paragraph) or paragraph[j].isspace()
        candidate = paragraph[start:j].strip()
        final_word = candidate.lower().split()[-1] if candidate else ""
        if is_boundary and final_word not in ABBREVIATIONS:
            if candidate:
                parts.append(candidate)
            while j < len(paragraph) and paragraph[j].isspace():
                j += 1
            start = j
            i = j
        else:
            i += 1
    tail = paragraph[start:].strip()
    if tail:
        parts.append(tail)
    return parts or [paragraph]


def read_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2:
            raise ValueError(f"Unexpected WAV format: {path}")
        rate = audio.getframerate()
        samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype=np.int16).copy()
    return samples, rate


def trim_edges(samples: np.ndarray, rate: int) -> np.ndarray:
    """Trim excessive model silence while retaining natural sentence edges."""
    if samples.size == 0:
        return samples
    window = max(1, int(rate * 0.02))
    usable = samples[: samples.size - (samples.size % window)]
    if usable.size == 0:
        return samples
    blocks = usable.reshape(-1, window).astype(np.float32)
    rms = np.sqrt(np.mean((blocks / 32768.0) ** 2, axis=1))
    active = np.flatnonzero(rms > 0.004)
    if active.size == 0:
        return samples
    lead = int(rate * 0.08)
    tail = int(rate * 0.14)
    start = max(0, int(active[0] * window) - lead)
    end = min(samples.size, int((active[-1] + 1) * window) + tail)
    return samples[start:end]


def write_wav(path: Path, samples: np.ndarray, rate: int) -> None:
    temp = path.with_suffix(".wav.tmp")
    with wave.open(str(temp), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(samples.astype(np.int16).tobytes())
    os.replace(temp, path)


def render_part(model, source: Path, output_dir: Path, reference_text: str) -> Path:
    paragraphs = [p.strip() for p in source.read_text(encoding="utf-8").split("\n\n") if p.strip()]
    units: list[tuple[str, bool]] = []
    for paragraph in paragraphs:
        sentences = split_sentences(paragraph)
        for index, sentence in enumerate(sentences):
            units.append((sentence, index == len(sentences) - 1))

    scratch = output_dir / ".segments" / source.stem
    scratch.mkdir(parents=True, exist_ok=True)
    assembled: list[np.ndarray] = []
    sample_rate = 24000
    for index, (sentence, ends_paragraph) in enumerate(units, start=1):
        prefix = f"{index:03d}"
        generated = scratch / f"{prefix}_000.wav"
        print(f"  sentence {index}/{len(units)}", flush=True)
        with contextlib.redirect_stdout(io.StringIO()):
            generate_audio(
                text=sentence,
                model=model,
                max_tokens=1024,
                voice=None,
                lang_code="en",
                ref_audio=str(REFERENCE_AUDIO),
                ref_text=reference_text,
                output_path=str(scratch),
                file_prefix=prefix,
                audio_format="wav",
                temperature=0.65,
                verbose=False,
            )
        samples, sample_rate = read_wav(generated)
        assembled.append(trim_edges(samples, sample_rate))
        pause_seconds = 0.72 if ends_paragraph else 0.32
        if index == 1:
            pause_seconds = 0.95
        assembled.append(np.zeros(round(sample_rate * pause_seconds), dtype=np.int16))

    output = output_dir / f"{source.stem}.wav"
    write_wav(output, np.concatenate(assembled), sample_rate)
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    args = parser.parse_args()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    sources = sorted(SOURCE_DIR.glob("??-??-part-??.txt"))
    pending = [s for s in sources if args.force or not (output_dir / f"{s.stem}.wav").exists()]
    if args.limit is not None:
        pending = pending[: args.limit]
    if not pending:
        print("All requested parts already exist.")
        return
    print(f"Loading locked narrator for {len(pending)} part(s)...", flush=True)
    model = load_model(MODEL_ID)
    reference_text = REFERENCE_TEXT.read_text(encoding="utf-8").strip()
    for index, source in enumerate(pending, start=1):
        print(f"[{index}/{len(pending)}] {source.stem}", flush=True)
        output = render_part(model, source, output_dir, reference_text)
        samples, rate = read_wav(output)
        print(f"Finished {output.name}: {samples.size / rate / 60:.2f} minutes", flush=True)


if __name__ == "__main__":
    main()
