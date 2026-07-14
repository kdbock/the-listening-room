from __future__ import annotations

import html.parser
import re
import shutil
import subprocess
from pathlib import Path

from docx import Document
from pypdf import PdfReader, PdfWriter


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "text-reference"
QL_OUT = ROOT / "quicklook-preview"
PDF_OUT = OUT / "pdf-previews"


LIGATURES = {
    "\ufb00": "ff",
    "\ufb01": "fi",
    "\ufb02": "fl",
    "\ufb03": "ffi",
    "\ufb04": "ffl",
}


def normalize_text(text: str) -> str:
    for source, replacement in LIGATURES.items():
        text = text.replace(source, replacement)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def slug(path: Path) -> str:
    base = path.stem.lower()
    base = re.sub(r"[^a-z0-9]+", "-", base)
    return base.strip("-")


def markdown_table(rows: list[list[str]]) -> str:
    if not rows:
        return ""
    width = max(len(row) for row in rows)
    padded = [row + [""] * (width - len(row)) for row in rows]
    lines = ["| " + " | ".join(cell.strip().replace("\n", "<br>") for cell in padded[0]) + " |"]
    lines.append("| " + " | ".join("---" for _ in range(width)) + " |")
    for row in padded[1:]:
        lines.append("| " + " | ".join(cell.strip().replace("\n", "<br>") for cell in row) + " |")
    return "\n".join(lines)


def convert_docx(path: Path) -> tuple[str, str]:
    doc = Document(path)
    lines: list[str] = []
    title_written = False

    for block in iter_doc_blocks(doc):
        if isinstance(block, str):
            text = normalize_text(block)
            if not text:
                continue
            lines.append(text)
            continue

        kind, payload = block
        if kind == "paragraph":
            text, style_name = payload
            text = normalize_text(text)
            if not text:
                continue
            style_name = style_name or ""
            if style_name == "Title" or not title_written:
                lines.append(f"# {text}")
                title_written = True
            elif style_name.startswith("Heading "):
                try:
                    level = min(6, max(2, int(style_name.split()[-1]) + 1))
                except ValueError:
                    level = 2
                lines.append(f"{'#' * level} {text}")
            else:
                lines.append(text)
        elif kind == "table":
            table_md = markdown_table(payload)
            if table_md:
                lines.append(table_md)

    markdown = normalize_text("\n\n".join(lines))
    plain = re.sub(r"^#{1,6} ", "", markdown, flags=re.MULTILINE)
    plain = re.sub(r"\| ---.*\n", "", plain)
    return markdown, normalize_text(plain)


def iter_doc_blocks(doc: Document):
    from docx.oxml.table import CT_Tbl
    from docx.oxml.text.paragraph import CT_P
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    body = doc.element.body
    for child in body.iterchildren():
        if isinstance(child, CT_P):
            paragraph = Paragraph(child, doc)
            yield ("paragraph", (paragraph.text, paragraph.style.name if paragraph.style else ""))
        elif isinstance(child, CT_Tbl):
            table = Table(child, doc)
            rows = [[cell.text for cell in row.cells] for row in table.rows]
            yield ("table", rows)


class PreviewParser(html.parser.HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.sources: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag.lower() != "img":
            return
        data = dict(attrs)
        source = data.get("src")
        if source:
            self.sources.append(source)


def run_quicklook(path: Path) -> Path:
    QL_OUT.mkdir(exist_ok=True)
    preview_dir = QL_OUT / f"{path.name}.qlpreview"
    if preview_dir.exists():
        shutil.rmtree(preview_dir)
    subprocess.run(["qlmanage", "-p", "-o", str(QL_OUT), str(path)], cwd=ROOT, check=True)
    if not preview_dir.exists():
        raise RuntimeError(f"QuickLook did not create {preview_dir}")
    return preview_dir


def convert_pages(path: Path) -> tuple[str, str]:
    preview_dir = run_quicklook(path)
    preview_html = preview_dir / "Preview.html"
    parser = PreviewParser()
    parser.feed(preview_html.read_text(encoding="utf-8", errors="ignore"))

    page_texts: list[str] = []
    writer = PdfWriter()
    for source in parser.sources:
        pdf_path = preview_dir / source
        if not pdf_path.exists():
            continue
        reader = PdfReader(str(pdf_path))
        for page in reader.pages:
            text = page.extract_text() or ""
            if text.strip():
                page_texts.append(text)
            writer.add_page(page)

    PDF_OUT.mkdir(exist_ok=True)
    with (PDF_OUT / f"{slug(path)}.pdf").open("wb") as handle:
        writer.write(handle)

    body = normalize_text("\n\n".join(page_texts))
    title = path.stem
    markdown = normalize_text(
        f"# {title}\n\n"
        f"_Source: {path.name}. Converted from the system QuickLook preview because Pages is not installed._\n\n"
        f"{body}"
    )
    plain = normalize_text(body)
    return markdown, plain


def write_pair(path: Path, markdown: str, plain: str) -> None:
    md_path = OUT / f"{slug(path)}.md"
    txt_path = OUT / f"{slug(path)}.txt"
    md_path.write_text(markdown + "\n", encoding="utf-8")
    txt_path.write_text(plain + "\n", encoding="utf-8")


def main() -> None:
    OUT.mkdir(exist_ok=True)
    PDF_OUT.mkdir(exist_ok=True)
    converted: list[Path] = []

    for path in sorted(ROOT.glob("*.docx")):
        markdown, plain = convert_docx(path)
        write_pair(path, markdown, plain)
        converted.append(path)

    for path in sorted(ROOT.glob("*.pages")):
        markdown, plain = convert_pages(path)
        write_pair(path, markdown, plain)
        converted.append(path)

    index_lines = [
        "# Pangea Text Reference",
        "",
        "Markdown and plain-text conversions of the source documents in the parent folder.",
        "",
        "Original files are unchanged. Pages files were converted through macOS QuickLook previews because Pages is not installed on this machine.",
        "",
        "## Files",
        "",
    ]
    for path in converted:
        name = slug(path)
        index_lines.append(f"- [{path.name}](./{name}.md) / `{name}.txt`")
    index_lines.extend(
        [
            "",
            "Pages files also have merged visual PDF previews in `pdf-previews/`.",
        ]
    )
    (OUT / "README.md").write_text("\n".join(index_lines) + "\n", encoding="utf-8")

    if QL_OUT.exists():
        shutil.rmtree(QL_OUT)


if __name__ == "__main__":
    main()
