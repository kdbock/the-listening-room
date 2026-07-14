#!/usr/bin/env python3
"""Assemble the cadence-revised Pangea chapter and manuscript files."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REV = ROOT / "third-person-revised"


def body(filename: str) -> str:
    text = (REV / filename).read_text(encoding="utf-8").strip()
    lines = text.splitlines()
    if lines and lines[0].startswith("#"):
        lines = lines[1:]
    return "\n".join(lines).strip()


chapter_two = (
    "# Chapter Two: Black Lantern Gate\n\n"
    + body("Chapter Two Scene One - Black Lantern Gate.md")
    + "\n\n## The Choice Belowdeck\n\n"
    + body("Chapter Two Scene Two - The Choice Belowdeck.md")
    + "\n"
)
(REV / "Chapter Two - Black Lantern Gate.md").write_text(chapter_two, encoding="utf-8")

chapter_three = (
    "# Chapter Three: No Nets, No Hooks\n\n"
    + body("Chapter Three Scene One - No Nets No Hooks.md")
    + "\n\n## Plague Flags at Brinecross\n\n"
    + body("Chapter Three Scene Two - Plague Flags at Brinecross.md")
    + "\n"
)
(REV / "Chapter Three - No Nets No Hooks.md").write_text(chapter_three, encoding="utf-8")

chapters = [
    ("Chapter One: Mercy's Wake", "Chapter One - Mercy's Wake.md"),
    ("Chapter Two: Black Lantern Gate", "Chapter Two - Black Lantern Gate.md"),
    ("Chapter Three: No Nets, No Hooks", "Chapter Three - No Nets No Hooks.md"),
    ("Chapter Four: The City That Knew Her Name", "Chapter Four - The City That Knew Her Name.md"),
    ("Chapter Five: The Floor Opened", "Chapter Five - The Floor Opened.md"),
]

parts = ["# Pangea — Third-Person Revised Manuscript"]
for title, filename in chapters:
    parts.append(f"## {title}\n\n{body(filename)}")

(REV / "Pangea Third Person Revised - Chapters 1-5.md").write_text(
    "\n\n".join(parts).rstrip() + "\n", encoding="utf-8"
)
