#!/usr/bin/env python3
"""Split the 36 planned Google TTS episodes into short, stable render parts."""

from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "tts-google-ready"
DEST = ROOT / "tts-google-render-parts"
MAX_BYTES = 1700


def byte_len(text: str) -> int:
    return len(text.encode("utf-8"))


def sentence_blocks(paragraph: str) -> list[str]:
    if byte_len(paragraph) <= MAX_BYTES:
        return [paragraph]
    sentences = [m.group(0).strip() for m in re.finditer(
        r'.+?(?:[.!?](?:["”’])?(?=\s|$)|$)', paragraph
    ) if m.group(0).strip()]
    blocks: list[str] = []
    current: list[str] = []
    for sentence in sentences:
        proposed = " ".join(current + [sentence])
        if current and byte_len(proposed) > MAX_BYTES:
            blocks.append(" ".join(current))
            current = [sentence]
        else:
            current.append(sentence)
    if current:
        blocks.append(" ".join(current))
    return blocks


def split_text(text: str) -> list[str]:
    blocks: list[str] = []
    for paragraph in [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]:
        blocks.extend(sentence_blocks(paragraph))

    chunks: list[list[str]] = []
    current: list[str] = []
    for block in blocks:
        proposed = "\n\n".join(current + [block])
        if current and byte_len(proposed) > MAX_BYTES:
            chunks.append(current)
            current = [block]
        else:
            current.append(block)
    if current:
        chunks.append(current)

    if len(chunks) > 1 and byte_len("\n\n".join(chunks[-1])) < 650:
        while len(chunks[-2]) > 1 and byte_len("\n\n".join(chunks[-1])) < 650:
            candidate = chunks[-2][-1]
            proposed = "\n\n".join([candidate] + chunks[-1])
            if byte_len(proposed) > MAX_BYTES:
                break
            chunks[-1].insert(0, chunks[-2].pop())

    return ["\n\n".join(chunk) for chunk in chunks]


def main() -> None:
    DEST.mkdir(parents=True, exist_ok=True)
    for old in DEST.glob("*.txt"):
        old.unlink()

    episodes = sorted(p for p in SOURCE.glob("*.txt") if p.name != "README.txt")
    readme = [
        "Pangea — short Google TTS production renders",
        "",
        "These are production pieces, not additional public episodes.",
        "Generate every render with the same Gemini model, Gacrux voice, pace, and style instructions.",
        "Join all render files sharing the same episode name, in numeric order, to create the original 36 public episodes.",
        "A short clean pause between render parts is preferable to voice degradation.",
        "",
        "RENDER MAP",
    ]

    for episode in episodes:
        base = episode.stem
        parts = split_text(episode.read_text(encoding="utf-8"))
        names: list[str] = []
        for index, part in enumerate(parts, 1):
            name = f"{base}-render-{index:02d}.txt"
            (DEST / name).write_text(part + "\n", encoding="utf-8")
            names.append(name)
        readme.append(f"{base}: " + ", ".join(names))

    (DEST / "README.txt").write_text("\n".join(readme) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
