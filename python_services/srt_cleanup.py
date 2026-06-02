"""Post-process SRT: merge duplicates, drop garbage lines."""
from __future__ import annotations

import re
from difflib import SequenceMatcher
from pathlib import Path


def _parse_srt(content: str) -> list[dict]:
    blocks = re.split(r"\n\s*\n", content.strip(), flags=re.MULTILINE)
    entries: list[dict] = []
    for block in blocks:
        lines = [ln for ln in block.strip().splitlines() if ln.strip()]
        if len(lines) < 3:
            continue
        if not lines[0].isdigit():
            continue
        m = re.match(
            r"(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})",
            lines[1],
        )
        if not m:
            continue
        text = "\n".join(lines[2:]).strip()
        entries.append({
            "start": m.group(1),
            "end": m.group(2),
            "text": re.sub(r"\s+", "", text),
            "raw_text": text,
        })
    return entries


def _ts_to_sec(ts: str) -> float:
    h, m, rest = ts.split(":")
    s, ms = rest.split(",")
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0


def _sec_to_ts(sec: float) -> str:
    if sec < 0:
        sec = 0
    h = int(sec // 3600)
    sec %= 3600
    m = int(sec // 60)
    sec %= 60
    s = int(sec)
    ms = int(round((sec - s) * 1000))
    if ms >= 1000:
        ms = 0
        s += 1
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _similar(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def _is_garbage(text: str) -> bool:
    if len(text) < 2:
        return True
    cjk = sum(1 for c in text if "\u4e00" <= c <= "\u9fff")
    if len(text) >= 3 and cjk == 0:
        return True
    return False


def cleanup_srt_file(path: str, merge_sim: float = 0.9) -> tuple[int, int]:
    """
    Returns (before_count, after_count).
    Merges consecutive cues with near-identical Chinese text.
    """
    p = Path(path)
    entries = _parse_srt(p.read_text(encoding="utf-8"))
    before = len(entries)
    if not entries:
        return 0, 0

    merged: list[dict] = []
    for ent in entries:
        if _is_garbage(ent["text"]):
            continue
        if not merged:
            merged.append(ent)
            continue
        prev = merged[-1]
        if _similar(prev["text"], ent["text"]) >= merge_sim:
            prev["end"] = ent["end"]
            if len(ent["text"]) > len(prev["text"]):
                prev["text"] = ent["text"]
                prev["raw_text"] = ent["raw_text"]
            continue
        merged.append(ent)

    # snap overlaps
    for i in range(len(merged) - 1):
        end_sec = _ts_to_sec(merged[i]["end"])
        start_next = _ts_to_sec(merged[i + 1]["start"])
        if end_sec > start_next - 0.03:
            merged[i]["end"] = _sec_to_ts(max(_ts_to_sec(merged[i]["start"]) + 0.2, start_next - 0.05))

    lines: list[str] = []
    for i, ent in enumerate(merged, start=1):
        lines.append(str(i))
        lines.append(f"{ent['start']} --> {ent['end']}")
        lines.append(ent["raw_text"] if ent.get("raw_text") else ent["text"])
        lines.append("")

    p.write_text("\n".join(lines), encoding="utf-8")
    return before, len(merged)
