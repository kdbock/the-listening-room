#!/usr/bin/env python3
"""Build clean, scene-level text files for text-to-speech services."""

from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "third-person-revised"
DEST = ROOT / "tts-ready"

SCENES = [
    ("01-01", "Chapter One — Mercy's Wake", "Chapter One - Mercy's Wake.md"),
    ("02-01", "Chapter Two, Scene One — Black Lantern Gate", "Chapter Two Scene One - Black Lantern Gate.md"),
    ("02-02", "Chapter Two, Scene Two — The Choice Belowdeck", "Chapter Two Scene Two - The Choice Belowdeck.md"),
    ("03-01", "Chapter Three, Scene One — No Nets, No Hooks", "Chapter Three Scene One - No Nets No Hooks.md"),
    ("03-02", "Chapter Three, Scene Two — Plague Flags at Brinecross", "Chapter Three Scene Two - Plague Flags at Brinecross.md"),
    ("04-01", "Chapter Four — The City That Knew Her Name", "Chapter Four - The City That Knew Her Name.md"),
    ("05-01", "Chapter Five — The Floor Opened", "Chapter Five - The Floor Opened.md"),
]


def clean_markdown(text: str) -> str:
    lines = text.splitlines()
    while lines and (not lines[0].strip() or lines[0].lstrip().startswith("#")):
        lines.pop(0)
    text = "\n".join(lines)
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    text = re.sub(r"(?<!\*)\*([^*\n]+?)\*(?!\*)", r"\1", text)
    text = re.sub(r"_([^_\n]+?)_", r"\1", text)
    text = re.sub(r"`([^`]+?)`", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^\)]+\)", r"\1", text)
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def safe_name(title: str) -> str:
    name = title.replace("—", "-").replace("’", "'")
    name = re.sub(r"[^A-Za-z0-9' -]+", "", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name


def main() -> None:
    DEST.mkdir(parents=True, exist_ok=True)
    manifest = ["Pangea TTS-ready scene files", ""]

    for number, spoken_title, filename in SCENES:
        body = clean_markdown((SOURCE / filename).read_text(encoding="utf-8"))
        output_name = f"{number} {safe_name(spoken_title)}.txt"
        output = f"{spoken_title}\n\n{body}\n"
        (DEST / output_name).write_text(output, encoding="utf-8")
        words = len(re.findall(r"\b[\w’'-]+\b", body))
        minutes_low = round(words / 160, 1)
        minutes_high = round(words / 145, 1)
        manifest.append(f"{output_name} | {words} words | approximately {minutes_low}–{minutes_high} minutes")

    manuscript = clean_markdown(
        (SOURCE / "Pangea Third Person Revised - Chapters 1-5.md").read_text(encoding="utf-8")
    )
    manuscript_name = "Pangea - Complete Chapters 1-5.txt"
    (DEST / manuscript_name).write_text(
        "Pangea — Complete Chapters One through Five\n\n"
        "Chapter One: Mercy's Wake\n\n"
        + manuscript
        + "\n",
        encoding="utf-8",
    )
    manuscript_words = len(re.findall(r"\b[\w’'-]+\b", "Chapter One Mercy's Wake " + manuscript))
    manifest.extend([
        "",
        f"{manuscript_name} | {manuscript_words} words | approximately "
        f"{round(manuscript_words / 160, 1)}–{round(manuscript_words / 145, 1)} minutes",
    ])

    (DEST / "README.txt").write_text("\n".join(manifest) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
