#!/usr/bin/env python3
"""Split Pangea TTS scenes into Google Gemini TTS-safe text chunks."""

from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "tts-ready"
DEST = ROOT / "tts-google-ready"
MAX_BYTES = 3500


SCENES = [
    ("01-01", "Chapter One — Mercy's Wake", "01-01 Chapter One - Mercy's Wake.txt"),
    ("02-01", "Chapter Two, Scene One — Black Lantern Gate", "02-01 Chapter Two Scene One - Black Lantern Gate.txt"),
    ("02-02", "Chapter Two, Scene Two — The Choice Belowdeck", "02-02 Chapter Two Scene Two - The Choice Belowdeck.txt"),
    ("03-01", "Chapter Three, Scene One — No Nets, No Hooks", "03-01 Chapter Three Scene One - No Nets No Hooks.txt"),
    ("03-02", "Chapter Three, Scene Two — Plague Flags at Brinecross", "03-02 Chapter Three Scene Two - Plague Flags at Brinecross.txt"),
    ("04-01", "Chapter Four — The City That Knew Her Name", "04-01 Chapter Four - The City That Knew Her Name.txt"),
    ("05-01", "Chapter Five — The Floor Opened", "05-01 Chapter Five - The Floor Opened.txt"),
]


STYLE_PROMPT = """Perform this as a professionally narrated adult speculative-fiction audiobook. Use the selected female voice as a close third-person narrator aligned with Nix: observant, controlled, dryly amused, and emotionally guarded. Keep the delivery natural and conversational rather than theatrical. Let danger remain serious. Preserve understated humor without punching every joke. Differentiate dialogue subtly through timing and attitude, not exaggerated character voices. Maintain an even audiobook pace and read the supplied text exactly as written."""


def byte_len(text: str) -> int:
    return len(text.encode("utf-8"))


def split_sentences(text: str) -> list[str]:
    return [m.group(0).strip() for m in re.finditer(
        r'.+?(?:[.!?](?:["”’])?(?=\s|$)|$)', text
    ) if m.group(0).strip()]


def atomic_blocks(text: str) -> list[str]:
    blocks: list[str] = []
    for paragraph in [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]:
        if byte_len(paragraph) <= MAX_BYTES:
            blocks.append(paragraph)
            continue
        current: list[str] = []
        for sentence in split_sentences(paragraph):
            proposed = " ".join(current + [sentence])
            if current and byte_len(proposed) > MAX_BYTES:
                blocks.append(" ".join(current))
                current = [sentence]
            else:
                current.append(sentence)
        if current:
            blocks.append(" ".join(current))
    return blocks


def make_chunks(text: str) -> list[str]:
    chunks: list[str] = []
    current: list[str] = []
    for block in atomic_blocks(text):
        proposed = "\n\n".join(current + [block])
        if current and byte_len(proposed) > MAX_BYTES:
            chunks.append("\n\n".join(current))
            current = [block]
        else:
            current.append(block)
    if current:
        chunks.append("\n\n".join(current))

    # Avoid leaving a very short final audio fragment. Move complete paragraphs
    # from the preceding chunk until the ending has useful listening length.
    if len(chunks) > 1 and byte_len(chunks[-1]) < 1200:
        previous = chunks[-2].split("\n\n")
        final = chunks[-1].split("\n\n")
        while len(previous) > 1 and byte_len("\n\n".join(final)) < 1200:
            candidate = previous[-1]
            proposed = "\n\n".join([candidate] + final)
            if byte_len(proposed) > MAX_BYTES:
                break
            final.insert(0, previous.pop())
        chunks[-2] = "\n\n".join(previous)
        chunks[-1] = "\n\n".join(final)
    return chunks


def main() -> None:
    DEST.mkdir(parents=True, exist_ok=True)
    for old in DEST.glob("*.txt"):
        old.unlink()

    readme = [
        "Pangea — Google Gemini TTS-ready chunks",
        "",
        f"Each manuscript chunk is no larger than {MAX_BYTES} UTF-8 bytes.",
        "Paste the style prompt into the Style Instructions field and one numbered chunk into the text field.",
        "Use the same model, voice, pace, and style prompt for every part.",
        "",
        "STYLE PROMPT",
        STYLE_PROMPT,
        "",
        "FILES",
    ]

    for scene_id, title, filename in SCENES:
        text = (SOURCE / filename).read_text(encoding="utf-8").strip()
        chunks = make_chunks(text)
        for index, chunk in enumerate(chunks, 1):
            name = f"{scene_id}-part-{index:02d}.txt"
            (DEST / name).write_text(chunk + "\n", encoding="utf-8")
            words = len(re.findall(r"\b[\w’'-]+\b", chunk))
            readme.append(f"{name} | {byte_len(chunk)} bytes | {words} words | {title}")

    (DEST / "README.txt").write_text("\n".join(readme) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
