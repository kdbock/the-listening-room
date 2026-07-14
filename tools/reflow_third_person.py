#!/usr/bin/env python3
"""Create cadence-pass drafts from the existing Pangea structural scenes.

This preserves every sentence while recomposing paragraph units. It is deliberately
conservative around dialogue: different speakers remain in separate paragraphs.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path


WORD_RE = re.compile(r"\b[\w’'-]+\b")


def word_count(text: str) -> int:
    return len(WORD_RE.findall(text))


def is_dialogue(text: str) -> bool:
    return text.lstrip().startswith(('"', '“'))


def split_long_narration(block: str, target: int = 34, maximum: int = 50) -> list[str]:
    """Split an overlong narration block at sentence boundaries."""
    # Do not split a paragraph containing direct speech; a sentence boundary inside
    # a multi-sentence quotation is not a valid paragraph boundary.
    if is_dialogue(block) or '"' in block or '“' in block or word_count(block) <= maximum:
        return [block]

    sentences = [m.group(0).strip() for m in re.finditer(
        r'.+?(?:[.!?](?:["”’])?(?=\s|$)|$)', block
    ) if m.group(0).strip()]
    if len(sentences) < 2:
        return [block]

    chunks: list[str] = []
    current: list[str] = []
    for sentence in sentences:
        proposed = " ".join(current + [sentence])
        if current and word_count(proposed) > maximum and word_count(" ".join(current)) >= target:
            chunks.append(" ".join(current))
            current = [sentence]
        else:
            current.append(sentence)
    if current:
        chunks.append(" ".join(current))
    return chunks


def split_document(text: str) -> tuple[list[str], list[str]]:
    blocks = [re.sub(r"\s+", " ", p.strip()) for p in re.split(r"\n\s*\n", text) if p.strip()]
    headers: list[str] = []
    while blocks and blocks[0].startswith("#"):
        headers.append(blocks.pop(0))
    return headers, blocks


def merge_narration(blocks: list[str], minimum: int = 24, maximum: int = 48) -> list[str]:
    first_pass: list[str] = []
    buffer: list[str] = []

    def flush() -> None:
        if buffer:
            first_pass.append(" ".join(buffer))
            buffer.clear()

    for block in blocks:
        if is_dialogue(block):
            flush()
            first_pass.append(block)
            continue

        if not buffer:
            buffer.append(block)
            continue

        combined = word_count(" ".join(buffer)) + word_count(block)
        current = word_count(" ".join(buffer))
        if current < minimum or combined <= maximum:
            buffer.append(block)
        else:
            flush()
            buffer.append(block)
    flush()

    split_pass: list[str] = []
    for block in first_pass:
        split_pass.extend(split_long_narration(block))

    # A short line of dialogue followed by narration usually benefits from carrying
    # its immediate physical or interior consequence in the same paragraph. This
    # does not join exchanges between different speakers.
    result: list[str] = []
    i = 0
    while i < len(split_pass):
        block = split_pass[i]
        if (
            is_dialogue(block)
            and i + 1 < len(split_pass)
            and not is_dialogue(split_pass[i + 1])
            and word_count(block) + word_count(split_pass[i + 1]) <= maximum
        ):
            result.append(f"{block} {split_pass[i + 1]}")
            i += 2
        else:
            result.append(block)
            i += 1
    return result


def transform(source: Path, destination: Path, title: str) -> None:
    _, blocks = split_document(source.read_text(encoding="utf-8"))
    revised = merge_narration(blocks)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(f"# {title}\n\n" + "\n\n".join(revised).rstrip() + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("title")
    args = parser.parse_args()
    transform(args.source, args.destination, args.title)


if __name__ == "__main__":
    main()
