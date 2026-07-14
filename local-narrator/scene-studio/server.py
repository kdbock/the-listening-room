#!/usr/bin/env python3
"""Small, fully local scene-production workspace for Pangea."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import wave
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse


APP_DIR = Path(__file__).resolve().parent
CHARACTER_PROFILES_FILE = APP_DIR / "character_profiles.json"
PROJECT = APP_DIR.parents[1]
LOCAL_NARRATOR = PROJECT / "local-narrator"
WORKSPACE_DIR = LOCAL_NARRATOR / "production-workspace"
STATE_FILE = WORKSPACE_DIR / "workspace.json"
SCRIPT_VERSIONS = WORKSPACE_DIR / "script-versions"
ASSET_ROOT = PROJECT / "sound-design" / "assets"
BOOKS_ROOT = PROJECT.parent / "Books"
BOOK_WORKSPACES = WORKSPACE_DIR / "book-workspaces"
RENDER_SOURCES = WORKSPACE_DIR / "render-sources"
GENERATED_DRAFTS = LOCAL_NARRATOR / "parts-wav" / "generated"
ARCHIVED_DRAFTS = LOCAL_NARRATOR / "rejected-tests" / "archived-drafts"
RENDERER = APP_DIR / "scene_tts_renderer.py"
AUDITION_RENDERER = APP_DIR / "voice_audition_renderer.py"
VOICE_AUDITIONS = LOCAL_NARRATOR / "voice-auditions"
VOICE_APPROVED = LOCAL_NARRATOR / "voice-approved"
CALIBRATION_TEXT = "The tide turned before dawn, and every promise came due."
RENDER_JOBS: dict[str, dict] = {}
VOICE_JOBS: dict[str, dict] = {}
BOOK_NAMES = {
    "PG2026": "Pangea", "FF2026": "Finding Forgiveness",
    "ATDi2026": "A Touch Divine", "ATDe2026": "A Touch Dead",
    "ATP2026": "A Touch Powerful", "AD2026": "Ascension Descension",
    "TBD2026": "Touched by Darkness", "DiD2026": "Defiance in Death",
}

SCENES = [
    ("01-01", 1, 1, "Mercy's Wake"),
    ("02-01", 2, 1, "Black Lantern Gate"),
    ("02-02", 2, 2, "The Choice Belowdeck"),
    ("03-01", 3, 1, "No Nets No Hooks"),
    ("03-02", 3, 2, "Plague Flags at Brinecross"),
    ("04-01", 4, 1, "The City That Knew Her Name"),
    ("05-01", 5, 1, "The Floor Opened"),
]

SCENE_TITLES = {scene_id: title for scene_id, _, _, title in SCENES}


def default_characters() -> list[dict]:
    return json.loads(CHARACTER_PROFILES_FILE.read_text(encoding="utf-8"))


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def relative(path: Path | str | None) -> str:
    if not path:
        return ""
    try:
        return str(Path(path).resolve().relative_to(PROJECT.resolve()))
    except (ValueError, OSError):
        return str(path)


def media_url(path: str) -> str:
    return f"/media/{path}" if path else ""


def next_version(directory: Path, stem: str, suffix: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    versions = []
    for item in directory.glob(f"{stem}.v*{suffix}"):
        match = re.search(r"\.v(\d+)", item.name)
        if match:
            versions.append(int(match.group(1)))
    return directory / f"{stem}.v{max(versions, default=0) + 1:03d}{suffix}"


def atomic_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    temp.replace(path)


def source_for(scene_id: str) -> Path | None:
    matches = sorted((PROJECT / "tts-ready").glob(f"{scene_id} *.txt"))
    return matches[0] if matches else None


def initial_state() -> dict:
    scenes = []
    sources = sorted((PROJECT / "tts-google-ready").glob("??-??-part-??.txt"))
    for source in sources:
        match = re.fullmatch(r"(\d{2})-(\d{2})-part-(\d{2})", source.stem)
        if not match:
            continue
        chapter, scene, part = map(int, match.groups())
        group_id = f"{chapter:02d}-{scene:02d}"
        scene_id = source.stem
        title = SCENE_TITLES.get(group_id, f"Scene {chapter}.{scene}")
        text = source.read_text(encoding="utf-8") if source else ""
        audio = LOCAL_NARRATOR / "parts-wav" / f"{scene_id}.wav"
        draft_files = [relative(audio)] if audio.exists() else []
        sentence_count = len(list((LOCAL_NARRATOR / "parts-wav" / ".segments" / scene_id).glob("*.wav")))
        pilot = LOCAL_NARRATOR / "sound-designed" / "01-01-part-01"
        scenes.append({
            "id": scene_id,
            "chapter": chapter,
            "scene": scene,
            "part": part,
            "group_id": group_id,
            "title": title,
            "original_script": relative(source),
            "working_script": relative(source),
            "script_text": text,
            "script_versions": [],
            "narrator": "Pangea Narrator — locked approved voice",
            "voice_notes": "Mature smoky mezzo-contralto; dry intelligence; unhurried literary cadence. Separate from the character Nix.",
            "draft_files": draft_files,
            "draft_stale": False,
            "sentence_assets": sentence_count,
            "sfx_mix": relative(pilot / "01-01-part-01-with-sfx.wav") if scene_id == "01-01-part-01" and (pilot / "01-01-part-01-with-sfx.wav").exists() else "",
            "music_mix": relative(pilot / "01-01-part-01-sound-designed-pilot-v7-voice-priority.wav") if scene_id == "01-01-part-01" else "",
            "sfx_cues": [],
            "music_cues": [],
            "dialogue_lines": [],
            "intro": "none",
            "outro": "none",
            "notes": "",
            "approvals": {"script": False, "voice": True, "draft": False, "sfx": False, "music": False},
            "updated_at": now(),
        })
    return {
        "book": "Pangea",
        "workspace_version": 2,
        "project_root": str(PROJECT),
        "workflow": ["Draft", "With Sound Effects", "With Music Background"],
        "created_at": now(),
        "updated_at": now(),
        "characters": default_characters(),
        "scenes": scenes,
    }


def load_state() -> dict:
    if not STATE_FILE.exists():
        state = initial_state()
        atomic_json(STATE_FILE, state)
        return state
    state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    if state.get("workspace_version", 1) < 2:
        prior = state
        state = initial_state()
        state["created_at"] = prior.get("created_at", state["created_at"])
        state["characters"] = prior.get("characters", state["characters"])
        old_by_group = {scene.get("group_id", scene["id"]): scene for scene in prior.get("scenes", [])}
        for scene in state["scenes"]:
            old = old_by_group.get(scene["group_id"])
            if not old:
                continue
            for key in ("narrator", "voice_notes", "intro", "outro", "notes"):
                if old.get(key):
                    scene[key] = old[key]
            if old.get("approvals", {}).get("voice"):
                scene["approvals"]["voice"] = True
        state.setdefault("migration_log", []).append({"at": now(), "from": "7 grouped scenes", "to": "36 production parts"})
        save_state(state)
    if not state.get("book_code"):
        state["book_code"] = "PG2026"
        state["book"] = "Pangea"
        save_state(state)
    return state


def save_state(state: dict) -> None:
    state["updated_at"] = now()
    atomic_json(STATE_FILE, state)
    book_code = state.get("book_code")
    if book_code:
        atomic_json(BOOK_WORKSPACES / f"{book_code}.json", state)


def find_scene(state: dict, scene_id: str) -> dict:
    for scene in state["scenes"]:
        if scene["id"] == scene_id:
            return scene
    raise KeyError(scene_id)


def archive_scene_record(state: dict, scene: dict, reason: str) -> Path:
    directory = BOOK_WORKSPACES / "archived-scenes" / state.get("book_code", "UNASSIGNED") / scene["id"]
    destination = next_version(directory, "scene", ".json")
    atomic_json(destination, {
        "archived_at": now(), "reason": reason, "book": state.get("book"),
        "book_code": state.get("book_code"), "scene": scene,
    })
    state.setdefault("scene_archive_log", []).append({
        "at": now(), "scene_id": scene["id"], "title": scene.get("title"),
        "archive": str(destination), "reason": reason,
    })
    return destination


def public_state(state: dict) -> dict:
    copy = json.loads(json.dumps(state))
    copy["available_books"] = [
        {
            "code": code, "name": BOOK_NAMES.get(code, code),
            "has_workspace": (BOOK_WORKSPACES / f"{code}.json").exists() or code == state.get("book_code"),
        }
        for code in sorted((path.name for path in BOOKS_ROOT.iterdir() if path.is_dir()))
    ] if BOOKS_ROOT.exists() else []
    for character in copy.get("characters", []):
        character["audition_urls"] = [media_url(path) for path in character.get("auditions", [])]
        character["approved_reference_url"] = media_url(character.get("approved_reference", ""))
    for scene in copy["scenes"]:
        scene["draft_urls"] = [media_url(x) for x in scene.get("draft_files", [])]
        scene["sfx_url"] = media_url(scene.get("sfx_mix", ""))
        scene["music_url"] = media_url(scene.get("music_mix", ""))
        last_render = scene.get("render_log", [])[-1] if scene.get("render_log") else {}
        scene["voice_mismatch_warning"] = bool(
            scene.get("dialogue_lines") and last_render.get("mode") == "locked-narrator-sentence-render"
        )
    return copy


def generic_characters() -> list[dict]:
    return [{
        "id": "narrator", "name": "Narrator", "voice": "Narrator voice not yet designed",
        "status": "design", "notes": "Create and approve this book's narrator before production.",
        "presentation": "to be designed", "voice_design_prompt": "",
        "profile": {"avoid": "Do not imitate a real person without documented authorization."},
    }]


def switch_book(book_code: str) -> dict:
    if book_code not in BOOK_NAMES or not (BOOKS_ROOT / book_code).is_dir():
        raise ValueError("Unknown book folder.")
    current = load_state()
    save_state(current)
    workspace = BOOK_WORKSPACES / f"{book_code}.json"
    if not workspace.exists():
        raise ValueError("This book has no Scene Studio workspace yet. Import its TXT manuscript first.")
    state = json.loads(workspace.read_text(encoding="utf-8"))
    atomic_json(STATE_FILE, state)
    return state


def import_manuscript(source: Path, book_code: str) -> tuple[dict, dict]:
    from manuscript_importer import analyze

    if book_code not in BOOK_NAMES or not (BOOKS_ROOT / book_code).is_dir():
        raise ValueError("Choose a valid book folder.")
    source = source.expanduser().resolve()
    if not source.is_file() or source.suffix.lower() not in {".txt", ".text"}:
        raise ValueError("Choose a plain TXT manuscript.")
    text = source.read_text(encoding="utf-8-sig")
    analysis = analyze(text)
    if not analysis["parts"]:
        raise ValueError("No readable manuscript text was found.")

    manuscript_root = BOOKS_ROOT / book_code / "Manuscript"
    original_dir = manuscript_root / "Original"
    original_dir.mkdir(parents=True, exist_ok=True)
    original = original_dir / (source.stem + ".txt")
    if original.exists():
        original = next_version(original_dir, source.stem, ".txt")
    shutil.copy2(source, original)

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    parts_dir = manuscript_root / "Working" / "Imports" / stamp / "text-parts"
    parts_dir.mkdir(parents=True, exist_ok=True)

    current = load_state()
    save_state(current)
    existing_path = BOOK_WORKSPACES / f"{book_code}.json"
    existing = json.loads(existing_path.read_text(encoding="utf-8")) if existing_path.exists() else None
    if existing:
        history = BOOK_WORKSPACES / "history" / book_code
        backup = next_version(history, "workspace", ".json")
        atomic_json(backup, existing)
    characters = existing.get("characters", []) if existing else (current.get("characters", []) if book_code == current.get("book_code") else generic_characters())
    narrator_locked = any(c.get("id") == "narrator" and c.get("status") == "locked" for c in characters)

    scenes = []
    for item in analysis["parts"]:
        destination = parts_dir / f"{item['id']}.txt"
        destination.write_text(item["text"], encoding="utf-8")
        scenes.append({
            "id": item["id"], "chapter": item["chapter"], "scene": item["scene"],
            "part": item["part"], "group_id": f"{item['chapter']:02d}-{item['scene']:02d}",
            "title": item["title"], "original_script": str(original),
            "working_script": str(destination), "script_text": item["text"],
            "script_versions": [], "estimated_minutes": item["estimated_minutes"], "word_count": item["words"],
            "narrator": next((c.get("voice") for c in characters if c.get("id") == "narrator"), "Narrator not selected"),
            "voice_notes": "", "draft_files": [], "draft_stale": False, "sentence_assets": 0,
            "sfx_mix": "", "music_mix": "", "sfx_cues": [], "music_cues": [],
            "dialogue_lines": [], "intro": "none", "outro": "none", "notes": "",
            "approvals": {"script": False, "voice": narrator_locked, "draft": False, "sfx": False, "music": False},
            "updated_at": now(),
        })
    state = {
        "book": BOOK_NAMES[book_code], "book_code": book_code, "workspace_version": 3,
        "project_root": str(PROJECT), "workflow": ["Draft", "With Sound Effects", "With Music Background"],
        "created_at": existing.get("created_at", now()) if existing else now(), "updated_at": now(),
        "characters": characters, "scenes": scenes,
        "imports": (existing.get("imports", []) if existing else []) + [{
            "at": now(), "source_original": str(original), "parts_directory": str(parts_dir),
            "chapters": analysis["chapter_count"], "scenes": analysis["scene_count"],
            "parts": analysis["part_count"], "words": analysis["words"],
        }],
    }
    save_state(state)
    summary = {key: value for key, value in analysis.items() if key != "parts"}
    summary.update({"book": state["book"], "book_code": book_code, "original": str(original), "parts_directory": str(parts_dir)})
    return state, summary


def suggest_speakers(text: str, characters: list[dict]) -> list[dict]:
    """Conservative dialogue-tag pass; uncertain lines remain explicitly unconfirmed."""
    known = {item["name"].lower(): item["name"] for item in characters}
    known.update({"ferryman": "The Ferryman"})
    quote_re = re.compile(r'[“"]([^”"]+)[”"]')
    tag_after = re.compile(r"^\s*(?:,|\.)?\s*(?:said|asked|replied|whispered|called|murmured|snapped)\s+([A-Z][\w'-]+)", re.I)
    tag_after_name = re.compile(r"^\s*(?:,|\.)?\s*([A-Z][\w'-]+)\s+(?:said|asked|replied|whispered|called|murmured|snapped)", re.I)
    tag_before = re.compile(r"([A-Z][\w'-]+)\s+(?:said|asked|replied|whispered|called|murmured|snapped)[^“\"]*$", re.I)
    results = []
    for number, match in enumerate(quote_re.finditer(text), 1):
        before = text[max(0, match.start() - 120):match.start()]
        after = text[match.end():match.end() + 100]
        candidate = None
        reason = "No explicit dialogue tag; review required."
        confidence = "low"
        tagged = tag_after.search(after) or tag_after_name.search(after) or tag_before.search(before)
        if tagged:
            raw = tagged.group(1).lower()
            candidate = known.get(raw, tagged.group(1).title())
            reason = "Suggested from the nearby dialogue tag."
            confidence = "high"
        results.append({
            "id": f"line-{number:04d}", "text": match.group(1).strip(),
            "speaker": candidate or "Unassigned", "confidence": confidence,
            "reason": reason, "approved": False, "delivery": "",
        })
    return results


def finish_render(scene_id: str, process: subprocess.Popen, output: Path, segment_dir: Path) -> None:
    stdout, _ = process.communicate()
    job = RENDER_JOBS[scene_id]
    job["log"] = stdout[-8000:]
    job["finished_at"] = now()
    if process.returncode or not output.exists():
        job["status"] = "failed"
        job["error"] = f"Renderer exited with status {process.returncode}."
        return
    state = load_state()
    scene = find_scene(state, scene_id)
    path = relative(output)
    if path not in scene.setdefault("draft_files", []):
        scene["draft_files"].append(path)
    scene["sentence_assets"] = len(list(segment_dir.glob("*.wav")))
    scene["draft_stale"] = False
    scene["approvals"]["draft"] = False
    scene.setdefault("render_log", []).append({
        "at": now(), "output": path, "sentence_assets": scene["sentence_assets"],
        "mode": "multi-voice-sentence-render",
    })
    save_state(state)
    job["status"] = "complete"
    job["output"] = path


def find_character(state: dict, character_id: str) -> dict:
    for character in state.get("characters", []):
        if character.get("id") == character_id:
            return character
    raise KeyError(character_id)


def finish_audition(character_id: str, process: subprocess.Popen, output: Path) -> None:
    stdout, _ = process.communicate()
    job = VOICE_JOBS[character_id]
    job["log"] = stdout[-8000:]
    job["finished_at"] = now()
    if process.returncode or not output.exists():
        job["status"] = "failed"
        job["error"] = f"Audition renderer exited with status {process.returncode}."
        return
    state = load_state()
    character = find_character(state, character_id)
    path = relative(output)
    if path not in character.setdefault("auditions", []):
        character["auditions"].append(path)
    character["status"] = "auditions"
    save_state(state)
    job["status"] = "complete"
    job["output"] = path


def start_audition(state: dict, character_id: str) -> dict:
    character = find_character(state, character_id)
    if character_id in {"narrator", "minor-unnamed-roles"}:
        raise ValueError("This profile does not use an individual character audition.")
    prompt = str(character.get("voice_design_prompt", "")).strip()
    if not prompt:
        raise ValueError("This character needs a Qwen VoiceDesign prompt first.")
    running = next((job for job in VOICE_JOBS.values() if job.get("status") == "running"), None)
    if running:
        raise ValueError(f"A voice audition is already generating for {running['character_id']}.")
    directory = VOICE_AUDITIONS / state.get("book_code", "UNASSIGNED") / character_id
    output = next_version(directory, character_id, ".wav")
    command = [
        sys.executable, str(AUDITION_RENDERER), "--text", CALIBRATION_TEXT,
        "--instruct", prompt, "--output", str(output),
    ]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    job = {
        "character_id": character_id, "status": "running", "started_at": now(),
        "output": relative(output), "pid": process.pid,
        "message": f"Designing a local audition for {character['name']}…",
    }
    VOICE_JOBS[character_id] = job
    threading.Thread(target=finish_audition, args=(character_id, process, output), daemon=True).start()
    return job


def extract_short_reference(source: Path, destination: Path, maximum_seconds: float = 4.5) -> float:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(source), "rb") as incoming:
        parameters = incoming.getparams()
        frames = incoming.readframes(min(incoming.getnframes(), int(incoming.getframerate() * maximum_seconds)))
    temporary = destination.with_suffix(".wav.tmp")
    with wave.open(str(temporary), "wb") as outgoing:
        outgoing.setparams(parameters)
        outgoing.writeframes(frames)
    os.replace(temporary, destination)
    with wave.open(str(destination), "rb") as approved:
        return approved.getnframes() / approved.getframerate()


def build_speaker_plan(scene: dict, state: dict) -> dict:
    text = str(scene.get("script_text", "")).strip()
    dialogue = scene.get("dialogue_lines", [])
    quotes = list(re.finditer(r'[“"]([^”"]+)[”"]', text))
    if quotes and len(dialogue) != len(quotes):
        raise ValueError("Run AI speaker identification again after the latest text edit.")
    by_name = {character["name"].casefold(): character for character in state.get("characters", [])}
    missing: set[str] = set()
    for line in dialogue:
        speaker = str(line.get("speaker", "")).strip()
        if not line.get("approved") or speaker in {"", "Unassigned"}:
            missing.add(speaker or "an unassigned dialogue line")
            continue
        character = by_name.get(speaker.casefold())
        if not character or character.get("status") != "locked" or not character.get("approved_reference"):
            missing.add(speaker)
    if missing:
        raise ValueError("Approve and lock character auditions before rendering: " + ", ".join(sorted(missing)))
    narrator_reference = LOCAL_NARRATOR / "nix-voice-reference.wav"
    narrator_text = (LOCAL_NARRATOR / "nix-voice-reference.txt").read_text(encoding="utf-8").strip()
    units = []
    cursor = 0
    for index, match in enumerate(quotes):
        narration = text[cursor:match.start()].strip()
        if narration:
            units.append({"text": narration, "speaker": "Narrator", "reference_audio": str(narrator_reference), "reference_text": narrator_text})
        line = dialogue[index]
        character = by_name[line["speaker"].casefold()]
        units.append({
            "text": match.group(1).strip(), "speaker": character["name"],
            "reference_audio": str((PROJECT / character["approved_reference"]).resolve()),
            "reference_text": character.get("approved_reference_text", CALIBRATION_TEXT),
        })
        cursor = match.end()
    narration = text[cursor:].strip()
    if narration:
        units.append({"text": narration, "speaker": "Narrator", "reference_audio": str(narrator_reference), "reference_text": narrator_text})
    if not quotes:
        units = [{"text": text, "speaker": "Narrator", "reference_audio": str(narrator_reference), "reference_text": narrator_text}]
    return {"scene_id": scene["id"], "source_text": scene.get("working_script"), "units": units}


def start_render(scene: dict, state: dict) -> dict:
    if not scene.get("approvals", {}).get("script"):
        raise ValueError("Approve the current scene text before generating narration.")
    if not scene.get("approvals", {}).get("voice"):
        raise ValueError("Lock the narrator voice before generating narration.")
    running = next((job for job in RENDER_JOBS.values() if job.get("status") == "running"), None)
    if running:
        raise ValueError(f"A local render is already running for {running['scene_id']}.")
    text = str(scene.get("script_text", "")).strip()
    if not text:
        raise ValueError("The current scene has no text to render.")
    book_code = state.get("book_code", "UNASSIGNED")
    render_sources = RENDER_SOURCES / book_code
    generated_drafts = GENERATED_DRAFTS / book_code
    render_sources.mkdir(parents=True, exist_ok=True)
    generated_drafts.mkdir(parents=True, exist_ok=True)
    source = next_version(render_sources, scene["id"], ".txt")
    source.write_text(text + "\n", encoding="utf-8")
    plan = build_speaker_plan(scene, state)
    plan["source_snapshot"] = relative(source)
    plan_path = source.with_suffix(".plan.json")
    atomic_json(plan_path, plan)
    output = generated_drafts / f"{source.stem}.wav"
    segment_dir = generated_drafts / ".segments" / scene["id"]
    command = [
        sys.executable, str(RENDERER), "--plan", str(plan_path),
        "--output", str(output), "--segments-dir", str(segment_dir),
    ]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    job = {
        "scene_id": scene["id"], "status": "running", "started_at": now(),
        "source": relative(source), "output": relative(output), "pid": process.pid,
        "message": "Loading approved voices and rendering sentence assets…",
    }
    RENDER_JOBS[scene["id"]] = job
    threading.Thread(target=finish_render, args=(scene["id"], process, output, segment_dir), daemon=True).start()
    return job


class Handler(SimpleHTTPRequestHandler):
    server_version = "PangeaSceneStudio/1.0"

    def log_message(self, fmt: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def json_response(self, data: object, status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict:
        size = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(size) or b"{}")

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path == "/api/workspace":
            self.json_response(public_state(load_state()))
            return
        if path == "/api/render-status":
            scene_id = parse_qs(parsed.query).get("scene_id", [""])[0]
            self.json_response(RENDER_JOBS.get(scene_id, {"scene_id": scene_id, "status": "idle"}))
            return
        if path == "/api/audition-status":
            character_id = parse_qs(parsed.query).get("character_id", [""])[0]
            self.json_response(VOICE_JOBS.get(character_id, {"character_id": character_id, "status": "idle"}))
            return
        if path.startswith("/media/"):
            requested = (PROJECT / path.removeprefix("/media/")).resolve()
            if PROJECT.resolve() not in requested.parents or not requested.is_file():
                self.send_error(404)
                return
            content_type = mimetypes.guess_type(requested.name)[0] or "application/octet-stream"
            size = requested.stat().st_size
            start, end = 0, size - 1
            range_header = self.headers.get("Range", "")
            if range_header.startswith("bytes="):
                match = re.match(r"bytes=(\d*)-(\d*)", range_header)
                if match:
                    if match.group(1):
                        start = int(match.group(1))
                    if match.group(2):
                        end = min(int(match.group(2)), size - 1)
            partial = bool(range_header) and start <= end < size
            length = max(0, end - start + 1)
            self.send_response(206 if partial else 200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(length if partial else size))
            self.send_header("Accept-Ranges", "bytes")
            if partial:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            try:
                with requested.open("rb") as stream:
                    if partial:
                        stream.seek(start)
                        remaining = length
                        while remaining:
                            chunk = stream.read(min(64 * 1024, remaining))
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                            remaining -= len(chunk)
                    else:
                        shutil.copyfileobj(stream, self.wfile)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        if path in {"/", "/index.html"}:
            requested = APP_DIR / "index.html"
        else:
            requested = (APP_DIR / path.lstrip("/")).resolve()
        if APP_DIR.resolve() not in requested.parents and requested != APP_DIR.resolve():
            self.send_error(404)
            return
        if not requested.is_file():
            self.send_error(404)
            return
        data = requested.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(requested.name)[0] or "text/plain")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            body = self.read_json()
            state = load_state()
            no_scene = {"/api/characters", "/api/switch-book", "/api/import-manuscript", "/api/archive-all-scenes"}
            scene = None if path in no_scene else find_scene(state, body.get("scene_id", ""))
            if path == "/api/script":
                text = str(body.get("text", "")).strip() + "\n"
                if not text.strip():
                    raise ValueError("Scene text cannot be empty.")
                destination = next_version(SCRIPT_VERSIONS, scene["id"], ".txt")
                destination.write_text(text, encoding="utf-8")
                scene["working_script"] = relative(destination)
                scene["script_text"] = text
                scene.setdefault("script_versions", []).append(relative(destination))
                scene["approvals"]["script"] = False
                scene["approvals"]["draft"] = False
                if scene.get("draft_files"):
                    scene["draft_stale"] = True
            elif path == "/api/update":
                allowed = {"title", "narrator", "voice_notes", "intro", "outro", "notes", "sfx_mix", "music_mix"}
                for key, value in body.get("fields", {}).items():
                    if key in allowed:
                        scene[key] = value
            elif path == "/api/approve":
                stage = body.get("stage")
                if stage not in scene["approvals"]:
                    raise ValueError("Unknown approval stage.")
                scene["approvals"][stage] = bool(body.get("approved"))
                scene.setdefault("approval_log", []).append({"stage": stage, "approved": bool(body.get("approved")), "at": now()})
            elif path == "/api/cue":
                kind = body.get("kind")
                if kind not in {"sfx", "music"}:
                    raise ValueError("Cue must be sound or music.")
                cue = body.get("cue", {})
                cue["id"] = f"{kind}-{len(scene[f'{kind}_cues']) + 1:03d}"
                cue["created_at"] = now()
                scene[f"{kind}_cues"].append(cue)
                scene["approvals"][kind] = False
            elif path == "/api/analyze-speakers":
                from speaker_ai import analyze_scene
                scene["dialogue_lines"] = analyze_scene(scene.get("script_text", ""), state.get("characters", []))
            elif path == "/api/speakers":
                incoming = body.get("lines", [])
                if not isinstance(incoming, list):
                    raise ValueError("Dialogue assignments must be a list.")
                scene["dialogue_lines"] = incoming
            elif path == "/api/character":
                character = body.get("character", {})
                name = str(character.get("name", "")).strip()
                if not name:
                    raise ValueError("Character name is required.")
                character["id"] = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
                existing = next((x for x in state.setdefault("characters", []) if x["id"] == character["id"]), None)
                if existing:
                    existing.update(character)
                else:
                    state["characters"].append(character)
            elif path == "/api/characters":
                characters = body.get("characters")
                if not isinstance(characters, list) or not characters:
                    self.json_response({"error": "A non-empty character list is required."}, 400)
                    return
                state["characters"] = characters
            elif path == "/api/switch-book":
                state = switch_book(str(body.get("book_code", "")))
                self.json_response({"ok": True, "workspace": public_state(state)})
                return
            elif path == "/api/import-manuscript":
                chosen_path = str(body.get("path", "")).strip()
                if chosen_path:
                    source = Path(chosen_path)
                else:
                    script = 'POSIX path of (choose file with prompt "Choose a TXT manuscript" of type {"public.plain-text"})'
                    chosen_path = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, check=True).stdout.strip()
                    source = Path(chosen_path)
                state, summary = import_manuscript(source, str(body.get("book_code", "")))
                self.json_response({"ok": True, "summary": summary, "workspace": public_state(state)})
                return
            elif path == "/api/archive-scene":
                archive_scene_record(state, scene, "Removed from the active Scene Studio workspace")
                state["scenes"] = [item for item in state["scenes"] if item["id"] != scene["id"]]
                save_state(state)
                self.json_response({"ok": True, "workspace": public_state(state)})
                return
            elif path == "/api/archive-all-scenes":
                if not state.get("scenes"):
                    raise ValueError("This book has no active scenes to archive.")
                history = BOOK_WORKSPACES / "history" / state.get("book_code", "UNASSIGNED")
                backup = next_version(history, "workspace-before-scene-overhaul", ".json")
                atomic_json(backup, state)
                for archived_scene in state["scenes"]:
                    archive_scene_record(state, archived_scene, "Full scene-list overhaul")
                count = len(state["scenes"])
                state["scenes"] = []
                state.setdefault("scene_overhaul_log", []).append({"at": now(), "archived_scenes": count, "workspace_backup": str(backup)})
                save_state(state)
                self.json_response({"ok": True, "archived_scenes": count, "workspace": public_state(state)})
                return
            elif path == "/api/render":
                job = start_render(scene, state)
                self.json_response({"ok": True, "job": job, "workspace": public_state(state)}, 202)
                return
            elif path == "/api/audition":
                job = start_audition(state, str(body.get("character_id", "")))
                self.json_response({"ok": True, "job": job, "workspace": public_state(state)}, 202)
                return
            elif path == "/api/lock-character-voice":
                character = find_character(state, str(body.get("character_id", "")))
                index = int(body.get("audition_index", -1))
                auditions = character.get("auditions", [])
                if index < 0 or index >= len(auditions):
                    raise ValueError("That audition no longer exists.")
                source = (PROJECT / auditions[index]).resolve()
                if not source.is_file() or PROJECT.resolve() not in source.parents:
                    raise ValueError("The audition WAV could not be found.")
                directory = VOICE_APPROVED / state.get("book_code", "UNASSIGNED") / character["id"]
                destination = next_version(directory, f"{character['id']}-reference", ".wav")
                duration = extract_short_reference(source, destination)
                character["approved_reference"] = relative(destination)
                character["approved_reference_text"] = CALIBRATION_TEXT
                character["approved_reference_duration"] = round(duration, 3)
                character["approved_at"] = now()
                character["status"] = "locked"
            elif path == "/api/archive-draft":
                index = int(body.get("draft_index", -1))
                drafts = scene.setdefault("draft_files", [])
                if index < 0 or index >= len(drafts):
                    raise ValueError("That draft no longer exists.")
                if scene.get("approvals", {}).get("draft"):
                    raise ValueError("Unapprove the narration draft before removing it.")
                source = (PROJECT / drafts[index]).resolve()
                if PROJECT.resolve() not in source.parents:
                    raise ValueError("Draft path is outside this project.")
                stamp = now().replace(":", "-")
                archive_dir = ARCHIVED_DRAFTS / state.get("book_code", "UNASSIGNED") / scene["id"] / stamp
                archive_dir.mkdir(parents=True, exist_ok=True)
                archived = archive_dir / source.name
                if source.exists():
                    shutil.move(str(source), str(archived))
                sidecar = source.with_suffix(".json")
                if sidecar.exists():
                    shutil.move(str(sidecar), str(archive_dir / sidecar.name))
                removed = drafts.pop(index)
                scene["draft_stale"] = bool(drafts)
                scene.setdefault("archived_drafts", []).append({
                    "at": now(), "from": removed, "to": relative(archived),
                    "reason": "Removed from active drafts after a scene edit",
                })
            elif path == "/api/choose-asset":
                kind = body.get("kind")
                if kind not in {"sfx", "music", "intro", "outro"}:
                    raise ValueError("Unknown asset type.")
                script = 'POSIX path of (choose file with prompt "Choose a royalty-free audio file")'
                chosen = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, check=True).stdout.strip()
                source = Path(chosen)
                destination_dir = ASSET_ROOT / kind
                destination_dir.mkdir(parents=True, exist_ok=True)
                destination = destination_dir / source.name
                if destination.exists():
                    destination = next_version(destination_dir, destination.stem, destination.suffix)
                shutil.copy2(source, destination)
                self.json_response({"ok": True, "path": relative(destination), "url": media_url(relative(destination))})
                return
            else:
                self.send_error(404)
                return
            if scene is not None:
                scene["updated_at"] = now()
            save_state(state)
            self.json_response({"ok": True, "workspace": public_state(state)})
        except subprocess.CalledProcessError:
            self.json_response({"error": "No file was selected."}, 400)
        except (KeyError, ValueError, json.JSONDecodeError) as exc:
            self.json_response({"error": str(exc)}, 400)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
    ASSET_ROOT.mkdir(parents=True, exist_ok=True)
    load_state()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Pangea Scene Studio: http://127.0.0.1:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
