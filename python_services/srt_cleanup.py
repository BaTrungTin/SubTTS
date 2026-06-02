"""Post-process SRT: gộp dòng trùng / gần giống do OCR."""
from __future__ import annotations

import re
from pathlib import Path

from reference_srt_style import consolidate_until_reference_stable, is_hand_tuned_srt
from subtitle_merge import (
    collapse_ocr_stutter_clusters,
    dedupe_near_repeats,
    extend_cue_gaps_for_playback,
    find_duplicate_pairs,
    merge_cues_until_stable,
)


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


def _is_garbage(text: str) -> bool:
    if not text:
        return True
    cjk = sum(1 for c in text if "\u4e00" <= c <= "\u9fff")
    if len(text) >= 5 and cjk == 0:
        return True
    return False


def cleanup_srt_cues(
    cue_dicts: list[dict],
    merge_sim: float = 0.82,
    max_merge_gap_sec: float = 1.2,
) -> tuple[list[dict], list[dict], int]:
    """
    Returns (merged_cues, duplicate_pairs_before, merged_count).
    """
    before = len(cue_dicts)
    duplicates_before = find_duplicate_pairs(cue_dicts)

    hand_tuned = is_hand_tuned_srt(cue_dicts)
    merged = collapse_ocr_stutter_clusters(cue_dicts, cluster_window_sec=4.0)
    if hand_tuned:
        merged = dedupe_near_repeats(merged, max_gap_sec=0.45, threshold=merge_sim)
    else:
        merged = consolidate_until_reference_stable(merged)
        merged = dedupe_near_repeats(merged, max_gap_sec=0.4, threshold=0.85)
        merged = collapse_ocr_stutter_clusters(merged, cluster_window_sec=3.0)
    merged = extend_cue_gaps_for_playback(merged, fill_gap_sec=0.10)

    for i in range(len(merged) - 1):
        if merged[i]["end"] > merged[i + 1]["start"] - 0.02:
            merged[i]["end"] = max(merged[i]["start"] + 0.08, merged[i + 1]["start"] - 0.03)

    return merged, duplicates_before, before - len(merged)


def cleanup_srt_file(
    path: str,
    merge_sim: float = 0.82,
    max_merge_gap_sec: float = 1.2,
) -> tuple[int, int, list[dict], list[dict]]:
    """
    Returns (before_count, after_count, duplicate_pairs_before, duplicate_pairs_after).
    """
    p = Path(path)
    entries = _parse_srt(p.read_text(encoding="utf-8"))
    before = len(entries)
    if not entries:
        return 0, 0, [], []

    filtered: list[dict] = []
    for ent in entries:
        if _is_garbage(ent["text"]):
            continue
        filtered.append(ent)

    cue_dicts: list[dict] = [
        {
            "start": _ts_to_sec(ent["start"]),
            "end": _ts_to_sec(ent["end"]),
            "text": ent["text"],
        }
        for ent in filtered
    ]

    merged, duplicates_before, _ = cleanup_srt_cues(
        cue_dicts, merge_sim=merge_sim, max_merge_gap_sec=max_merge_gap_sec
    )
    duplicates_after = find_duplicate_pairs(merged)

    lines: list[str] = []
    for i, ent in enumerate(merged, start=1):
        lines.append(str(i))
        lines.append(f"{_sec_to_ts(ent['start'])} --> {_sec_to_ts(ent['end'])}")
        lines.append(ent["text"])
        lines.append("")

    p.write_text("\n".join(lines), encoding="utf-8")
    return before, len(merged), duplicates_before, duplicates_after
