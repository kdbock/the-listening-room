#!/usr/bin/env python3
"""Render one approved scene with the locked narrator, sentence by sentence."""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import re
import wave

import numpy as np
from mlx_audio.tts.generate import generate_audio
from mlx_audio.tts.utils import load_model


APP_DIR = Path(__file__).resolve().parent
PROJECT = APP_DIR.parents[1]
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
        candidate = paragraph[start:j].strip()
        final_word = candidate.lower().split()[-1] if candidate else ""
        if (j == len(paragraph) or paragraph[j].isspace()) and final_word not in ABBREVIATIONS:
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


def split_long_sentence(sentence: str, maximum: int = 180) -> list[str]:
    sentence = sentence.strip()
    if len(sentence) <= maximum:
        return [sentence]
    pieces = re.split(r"(?<=[,;:—–-])\s+", sentence)
    chunks: list[str] = []
    current = ""
    for piece in pieces:
        candidate = f"{current} {piece}".strip()
        if current and len(candidate) > maximum:
            chunks.append(current)
            current = piece
        else:
            current = candidate
    if current:
        chunks.append(current)
    if all(len(chunk) <= maximum * 1.25 for chunk in chunks):
        return chunks
    forced: list[str] = []
    for chunk in chunks:
        words = chunk.split()
        current_words: list[str] = []
        for word in words:
            candidate = " ".join([*current_words, word])
            if current_words and len(candidate) > maximum:
                forced.append(" ".join(current_words))
                current_words = [word]
            else:
                current_words.append(word)
        if current_words:
            forced.append(" ".join(current_words))
    return forced or [sentence]


def is_renderable_text(text: str) -> bool:
    return bool(re.search(r"[A-Za-z0-9]", text))


def read_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2:
            raise ValueError(f"Unexpected WAV format: {path}")
        return np.frombuffer(audio.readframes(audio.getnframes()), dtype=np.int16).copy(), audio.getframerate()


def trim_edges(samples: np.ndarray, rate: int) -> np.ndarray:
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
    start = max(0, int(active[0] * window) - int(rate * 0.08))
    end = min(samples.size, int((active[-1] + 1) * window) + int(rate * 0.14))
    return samples[start:end]


def write_wav(path: Path, samples: np.ndarray, rate: int) -> None:
    if path.exists():
        raise FileExistsError(f"Refusing to overwrite {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".wav.tmp")
    with wave.open(str(temporary), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(samples.astype(np.int16).tobytes())
    os.replace(temporary, path)


def find_generated_wav(segments_dir: Path, prefix: str) -> Path | None:
    expected = segments_dir / f"{prefix}_000.wav"
    if expected.exists():
        return expected
    matches = sorted(segments_dir.glob(f"{prefix}*.wav"))
    return matches[0] if matches else None


def performance_instruction(speaker: str, tone: str, urgency: str) -> str:
    tone_key = tone.strip().casefold()
    urgency_key = urgency.strip().casefold()
    tone_rules = {
        "dry": "Use a dry, restrained delivery with minimal sentiment and clean, matter-of-fact timing.",
        "warm": "Use a warmer delivery with gentle phrasing, softened attack, and natural emotional openness.",
        "snarky": "Use crisp comic timing, guarded wit, and a slight edge without becoming broad or cartoonish.",
        "scared": "Use controlled fear: quicker breath, tighter phrasing, and vulnerability without screaming.",
        "angry": "Use restrained anger: clipped pacing, firmer consonants, lower emotional temperature, and tension under control.",
        "tender": "Use a tender intimate delivery: quieter energy, slower phrasing, softer attack, and emotional care.",
        "teasing": "Use light teasing warmth with playful timing and a small smile in the voice.",
        "deadpan": "Use flat, dry understatement with very little overt emotion and precise timing.",
        "urgent": "Use urgency with forward momentum, tighter pauses, and focused intensity without shouting.",
    }
    urgency_rules = {
        "low": "Keep the pace relaxed and unhurried.",
        "medium": "Keep the pace natural and conversational.",
        "high": "Increase momentum and shorten pauses while staying intelligible.",
    }
    rules = [
        f"Perform this line as {speaker}. Keep the approved reference voice identity consistent.",
        tone_rules.get(tone_key, "Use the approved reference voice with natural audiobook delivery."),
        urgency_rules.get(urgency_key, urgency_rules["medium"]),
        "Do not change the words. Do not overact. Keep the performance believable for fiction dialogue.",
    ]
    return " ".join(rules)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--segments-dir", type=Path, required=True)
    args = parser.parse_args()
    plan_path, output, segments_dir = args.plan.resolve(), args.output.resolve(), args.segments_dir.resolve()
    if output.exists():
        raise FileExistsError(f"Refusing to overwrite {output}")
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    units: list[tuple[str, bool, str, str, str, str, str, str]] = []
    for planned in plan.get("units", []):
        paragraphs = [p.strip() for p in str(planned.get("text", "")).split("\n\n") if p.strip()]
        tone = str(planned.get("tone", "")).strip()
        urgency = str(planned.get("urgency", "")).strip()
        for paragraph in paragraphs:
            sentences = split_sentences(paragraph)
            render_sentences: list[tuple[str, bool]] = []
            for sentence_index, sentence in enumerate(sentences):
                if not is_renderable_text(sentence):
                    continue
                chunks = split_long_sentence(sentence)
                for chunk_index, chunk in enumerate(chunks):
                    if not is_renderable_text(chunk):
                        continue
                    render_sentences.append((chunk, sentence_index == len(sentences) - 1 and chunk_index == len(chunks) - 1))
            units.extend((
                sentence, ends_paragraph, str(planned["speaker"]),
                str(planned["reference_audio"]), str(planned["reference_text"]), tone, urgency,
                str(planned.get("performance_instruction") or "").strip(),
            ) for sentence, ends_paragraph in render_sentences)
    if not units:
        raise ValueError("No sentences were found in the approved scene text.")
    segments_dir.mkdir(parents=True, exist_ok=True)
    print(f"Loading approved voices for {len(units)} sentence(s)…", flush=True)
    model = load_model(MODEL_ID)
    assembled: list[np.ndarray] = []
    sample_rate = 24000
    manifest_units = []
    for index, (sentence, ends_paragraph, speaker, reference_audio, reference_text, tone, urgency, planned_instruction) in enumerate(units, start=1):
        instruction = planned_instruction or performance_instruction(speaker, tone, urgency)
        digest = hashlib.sha256(f"{speaker}\n{sentence}\n{tone}\n{urgency}\n{instruction}".encode("utf-8")).hexdigest()[:10]
        speaker_slug = re.sub(r"[^a-z0-9]+", "-", speaker.casefold()).strip("-")
        prefix = f"{index:04d}-{speaker_slug}-{digest}"
        generated = segments_dir / f"{prefix}_000.wav"
        reused = generated.exists()
        print(f"sentence {index}/{len(units)} {speaker} {'reused' if reused else 'rendering'}", flush=True)
        if not reused:
            with contextlib.redirect_stdout(io.StringIO()):
                generate_audio(
                    text=sentence, model=model, max_tokens=1024, voice=None, lang_code="en",
                    ref_audio=reference_audio, ref_text=reference_text,
                    instruct=instruction,
                    output_path=str(segments_dir), file_prefix=prefix, audio_format="wav",
                    temperature=0.65, verbose=False,
                )
            generated = find_generated_wav(segments_dir, prefix) or generated
        if not generated.exists():
            raise RuntimeError(f"Qwen did not produce audio for sentence {index}/{len(units)} ({speaker}): {sentence[:220]}")
        samples, sample_rate = read_wav(generated)
        assembled.append(trim_edges(samples, sample_rate))
        pause_seconds = 0.72 if ends_paragraph else 0.32
        if index == 1:
            pause_seconds = 0.95
        assembled.append(np.zeros(round(sample_rate * pause_seconds), dtype=np.int16))
        manifest_units.append({"index": index, "speaker": speaker, "text": sentence, "tone": tone, "urgency": urgency, "performance_instruction": instruction, "asset": generated.name, "reused": reused, "ends_paragraph": ends_paragraph, "reference_audio": reference_audio})
    write_wav(output, np.concatenate(assembled), sample_rate)
    manifest = {
        "plan": str(plan_path), "source": plan.get("source_snapshot"), "output": str(output), "model": MODEL_ID,
        "sample_rate": sample_rate,
        "sentence_count": len(units), "sentences": manifest_units,
    }
    output.with_suffix(".json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Finished {output}", flush=True)


if __name__ == "__main__":
    main()
