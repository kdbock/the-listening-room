#!/usr/bin/env python3
"""Local Qwen sound-design planning for approved scene cues."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

from speaker_ai import MODEL_PATH, model_and_tokenizer


def parse_json_object(response: str) -> dict[str, Any]:
    response = re.sub(r"<think>[\s\S]*?</think>", "", response).strip()
    start, end = response.find("{"), response.rfind("}")
    if start < 0 or end < start:
        raise RuntimeError("The local AI did not return a sound-design JSON object.")
    value = json.loads(response[start:end + 1])
    if not isinstance(value, dict):
        raise RuntimeError("The local AI returned an invalid sound-design plan.")
    return value


def normalize_plan(plan: dict[str, Any], cues: list[dict[str, Any]]) -> dict[str, Any]:
    cue_plan = plan.get("cue_plan")
    if not isinstance(cue_plan, list):
        cue_plan = []

    by_id = {str(item.get("id", "")): item for item in cue_plan if isinstance(item, dict)}
    normalized = []
    for index, cue in enumerate(cues):
        cue_id = str(cue.get("id") or f"cue-{index + 1:03d}")
        item = by_id.get(cue_id, {})
        search_terms = item.get("search_terms")
        if not isinstance(search_terms, list):
            search_terms = []
        normalized.append({
            "id": cue_id,
            "kind": str(cue.get("kind") or item.get("kind") or "effect"),
            "time": str(cue.get("time") or item.get("time") or ""),
            "description": str(item.get("description") or cue.get("label") or "Approved sound cue")[:240],
            "search_terms": [str(term).lower() for term in search_terms[:8] if str(term).strip()],
            "gain_db": float(item.get("gain_db", -24 if cue.get("kind") == "ambience" else -18)),
            "fade_in": float(item.get("fade_in", 0.05)),
            "fade_out": float(item.get("fade_out", 0.25)),
            "reason": str(item.get("reason") or cue.get("reason") or "Approved cue supports the scene.")[:240],
            "avoid": str(item.get("avoid") or "Do not distract from narration.")[:180],
        })

    return {
        "scene_summary": str(plan.get("scene_summary") or "")[:400],
        "tone": str(plan.get("tone") or "restrained")[:160],
        "sound_strategy": str(plan.get("sound_strategy") or "Keep narration foreground; use sparse supportive sound.")[:400],
        "cue_plan": normalized,
        "planner": "local-qwen3-4b-instruct",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    if not (MODEL_PATH / "config.json").exists():
        raise RuntimeError("The local sound-design model is not installed.")

    payload = json.loads(args.input.read_text(encoding="utf-8"))
    cues = payload.get("cues", [])
    if not isinstance(cues, list):
        cues = []

    model, tokenizer = model_and_tokenizer()
    from mlx_lm import generate

    system = (
        "You are an audiobook sound designer. Build a restrained, narrator-first sound plan. "
        "Use only approved cues. Do not add unapproved events. Keep effects sparse, literal, and practical. "
        "Do not create cinematic hits, whooshes, risers, drones, horror beds, emotional sweeteners, or symbolic sounds. "
        "For effects, search for the exact physical source named by the cue. For ambience, use one quiet real-world location bed only. "
        "If a cue is vague, keep search_terms narrow and gain low instead of inventing a new event. "
        "Return JSON only with scene_summary, tone, sound_strategy, and cue_plan. "
        "Each cue_plan item must include id, kind, time, description, search_terms, gain_db, fade_in, fade_out, reason, and avoid."
    )
    user = (
        f"SCENE TITLE: {payload.get('title', '')}\n"
        f"SCENE TEXT:\n{payload.get('text', '')[:9000]}\n\n"
        f"APPROVED CUES:\n{json.dumps(cues, ensure_ascii=False)}"
    )
    prompt = tokenizer.apply_chat_template(
        [{"role": "system", "content": system}, {"role": "user", "content": user}],
        tokenize=False, add_generation_prompt=True,
    )
    response = generate(model, tokenizer, prompt=prompt, max_tokens=1800, verbose=False)
    plan = normalize_plan(parse_json_object(response), cues)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(plan, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
