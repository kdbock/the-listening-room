#!/usr/bin/env python3
"""Contextual, fully local speaker identification using MLX Qwen3 Instruct."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


MODEL_PATH = Path.home() / ".local/share/local-narration-studio/models/qwen3-4b-instruct-2507-4bit"
MAX_CHUNK_CHARS = 14_000
_MODEL = None
_TOKENIZER = None


def model_and_tokenizer():
    global _MODEL, _TOKENIZER
    if _MODEL is None:
        if not (MODEL_PATH / "config.json").exists():
            raise RuntimeError("The local speaker-identification model is not installed.")
        from mlx_lm import load
        _MODEL, _TOKENIZER = load(str(MODEL_PATH))
    return _MODEL, _TOKENIZER


def chunks(text: str) -> list[str]:
    paragraphs = re.split(r"\n\s*\n", text.strip())
    output: list[str] = []
    current: list[str] = []
    size = 0
    for paragraph in paragraphs:
        if current and size + len(paragraph) > MAX_CHUNK_CHARS:
            output.append("\n\n".join(current))
            current, size = [], 0
        current.append(paragraph)
        size += len(paragraph) + 2
    if current:
        output.append("\n\n".join(current))
    return output


def quoted_lines(text: str, start: int = 1) -> list[dict[str, str]]:
    matches = re.finditer(r'[“"]([^”"]+)[”"]', text)
    return [{"id": f"line-{index:04d}", "text": match.group(1).strip()}
            for index, match in enumerate(matches, start)]


def parse_json_array(response: str) -> list[dict[str, Any]]:
    response = re.sub(r"<think>[\s\S]*?</think>", "", response).strip()
    start, end = response.find("["), response.rfind("]")
    if start < 0 or end < start:
        raise RuntimeError("The local AI did not return speaker assignments in the expected format.")
    value = json.loads(response[start:end + 1])
    if not isinstance(value, list):
        raise RuntimeError("The local AI returned an invalid speaker-assignment list.")
    return value


def analyze_scene(text: str, characters: list[dict]) -> list[dict]:
    model, tokenizer = model_and_tokenizer()
    from mlx_lm import generate

    character_names = [item.get("name", "") for item in characters if item.get("name") and item.get("name") != "Narrator"]
    assignments: list[dict] = []
    next_line = 1
    recent: list[dict] = []
    for passage in chunks(text):
        lines = quoted_lines(passage, next_line)
        next_line += len(lines)
        if not lines:
            continue
        system = (
            "You are a literary dialogue editor. Identify who speaks every quoted line in a fiction passage. "
            "Use dialogue tags, action beats, pronouns, conversational turn-taking, character knowledge, and continuity. "
            "Do not default every untagged line to the previous speaker. Use 'Unknown' only when the passage truly lacks enough evidence. "
            "Return JSON only: an array of objects with id, speaker, confidence, and reason. "
            "confidence must be high, medium, or low. Keep reason under twelve words. Never omit an id."
        )
        user = (
            f"Known characters: {json.dumps(character_names, ensure_ascii=False)}\n"
            f"Recent dialogue assignments from the preceding passage: {json.dumps(recent[-6:], ensure_ascii=False)}\n\n"
            f"PASSAGE:\n{passage}\n\n"
            f"LINES TO ASSIGN:\n{json.dumps(lines, ensure_ascii=False)}"
        )
        prompt = tokenizer.apply_chat_template(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            tokenize=False, add_generation_prompt=True,
        )
        response = generate(model, tokenizer, prompt=prompt, max_tokens=max(1800, len(lines) * 45), verbose=False)
        batch = parse_json_array(response)
        by_id = {str(item.get("id")): item for item in batch if isinstance(item, dict)}
        for line in lines:
            suggestion = by_id.get(line["id"], {})
            speaker = str(suggestion.get("speaker", "Unknown")).strip() or "Unknown"
            confidence = str(suggestion.get("confidence", "low")).lower()
            if confidence not in {"high", "medium", "low"}:
                confidence = "low"
            record = {
                **line,
                "speaker": "Unassigned" if speaker.lower() == "unknown" else speaker,
                "confidence": confidence,
                "reason": str(suggestion.get("reason", "AI inference; review if uncertain."))[:160],
                "approved": confidence == "high",
                "delivery": "",
                "identified_by": "local-qwen3-4b-instruct",
            }
            assignments.append(record)
            recent.append({"text": line["text"], "speaker": record["speaker"]})
    return assignments

