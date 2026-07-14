#!/usr/bin/env python3
"""Analyze a plain-text manuscript into chapter/scene/3–5 minute production parts."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re


WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11,
    "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15,
    "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19,
    "twenty": 20,
}
HEADING = re.compile(
    r"^\s*#{0,6}\s*chapter\s+(?P<chapter>[A-Za-z]+|\d+)"
    r"(?:\s+scene\s+(?P<scene>[A-Za-z]+|\d+))?"
    r"(?:\s*[:—-]\s*(?P<title>.+?))?\s*$", re.I,
)
DIVIDER = re.compile(r"^\s*(?:\*{3,}|-{3,}|#{3,})\s*$")


def number(value: str | None, fallback: int) -> int:
    if not value:
        return fallback
    value = value.strip().lower()
    return int(value) if value.isdigit() else WORDS.get(value, fallback)


def word_count(text: str) -> int:
    return len(re.findall(r"\b[\w’'-]+\b", text))


def split_oversized_paragraph(paragraph: str, maximum: int) -> list[str]:
    if word_count(paragraph) <= maximum:
        return [paragraph]
    sentences = re.split(r"(?<=[.!?])\s+|(?<=[.!?][\"'”’])\s+", re.sub(r"\s+", " ", paragraph.strip()))
    output: list[str] = []
    current: list[str] = []
    size = 0
    for sentence in sentences:
        count = word_count(sentence)
        if current and size + count > maximum:
            output.append(" ".join(current))
            current, size = [], 0
        current.append(sentence)
        size += count
    if current:
        output.append(" ".join(current))
    return output


def timed_parts(text: str, minimum: int = 450, target: int = 600, maximum: int = 750) -> list[str]:
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip() and not DIVIDER.match(p)]
    expanded = [piece for paragraph in paragraphs for piece in split_oversized_paragraph(paragraph, maximum)]
    if not expanded:
        return []
    counts = [word_count(paragraph) for paragraph in expanded]
    # Dynamic programming avoids short tail fragments while preserving paragraph boundaries.
    best: list[tuple[int, list[tuple[int, int]]] | None] = [None] * (len(expanded) + 1)
    best[0] = (0, [])
    for start in range(len(expanded)):
        if best[start] is None:
            continue
        total = 0
        for end in range(start, len(expanded)):
            total += counts[end]
            if total > maximum and end > start:
                break
            outside_penalty = 100_000 if total < minimum else 0
            cost = best[start][0] + outside_penalty + (total - target) ** 2
            destination = end + 1
            if best[destination] is None or cost < best[destination][0]:
                best[destination] = (cost, best[start][1] + [(start, destination)])
    if best[-1] is None:
        return ["\n\n".join(expanded)]
    return ["\n\n".join(expanded[start:end]) for start, end in best[-1][1]]


def sections(text: str) -> list[dict]:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").splitlines()
    found: list[dict] = []
    current = None
    inferred_scene: dict[int, int] = {}
    for line in lines:
        match = HEADING.match(line)
        if match:
            if current and "\n".join(current["lines"]).strip():
                found.append(current)
            chapter = number(match.group("chapter"), len(found) + 1)
            inferred_scene[chapter] = inferred_scene.get(chapter, 0) + 1
            scene = number(match.group("scene"), inferred_scene[chapter])
            inferred_scene[chapter] = max(inferred_scene[chapter], scene)
            current = {
                "chapter": chapter, "scene": scene,
                "title": (match.group("title") or f"Chapter {chapter}").strip(), "lines": [],
            }
        elif current is not None:
            current["lines"].append(line)
    if current and "\n".join(current["lines"]).strip():
        found.append(current)
    if not found:
        found = [{"chapter": 1, "scene": 1, "title": "Chapter 1", "lines": lines}]
    return found


def analyze(text: str, words_per_minute: int = 150) -> dict:
    output = []
    for section in sections(text):
        body = "\n".join(section.pop("lines"))
        for part_number, part_text in enumerate(timed_parts(body), 1):
            words = word_count(part_text)
            output.append({
                "id": f"{section['chapter']:02d}-{section['scene']:02d}-part-{part_number:02d}",
                **section, "part": part_number, "text": part_text.strip() + "\n",
                "words": words, "estimated_minutes": round(words / words_per_minute, 2),
            })
    return {
        "parts": output,
        "chapter_count": len({item["chapter"] for item in output}),
        "scene_count": len({(item["chapter"], item["scene"]) for item in output}),
        "part_count": len(output),
        "words": sum(item["words"] for item in output),
        "words_per_minute": words_per_minute,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("manuscript", type=Path)
    args = parser.parse_args()
    result = analyze(args.manuscript.read_text(encoding="utf-8-sig"))
    summary = {key: value for key, value in result.items() if key != "parts"}
    summary["parts"] = [{key: value for key, value in part.items() if key != "text"} for part in result["parts"]]
    print(json.dumps(summary, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
