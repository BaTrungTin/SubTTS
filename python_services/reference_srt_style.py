"""Chỉ số SRT chuẩn từ 0531 (2).srt — dùng làm mục tiêu format, không sửa file gốc."""
from __future__ import annotations

import re
import statistics
from pathlib import Path
from typing import Any

# Đường dẫn mặc định (có thể override bằng env REFERENCE_SRT_PATH)
DEFAULT_REFERENCE_SRT = Path(r"d:\video\audio\0531 (2).srt")

# Ngưỡng rút gọn từ phân tích file chuẩn (~334 dòng / ~8 phút)
TARGET_MEDIAN_DURATION_SEC = 2.1
TARGET_MEDIAN_CHARS = 13
TARGET_MAX_CHARS_PER_CUE = 30
TARGET_MIN_CUE_DURATION_SEC = 1.05
TARGET_MAX_CUE_DURATION_SEC = 5.5
TARGET_MAX_MERGE_GAP_SEC = 0.10


def _ts_sec(ts: str) -> float:
    h, m, rest = ts.split(":")
    s, ms = rest.split(",")
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0


def parse_srt_path(path: Path) -> list[dict[str, Any]]:
    blocks = re.split(r"\n\s*\n", path.read_text(encoding="utf-8").strip())
    cues: list[dict[str, Any]] = []
    for b in blocks:
        lines = [ln.strip() for ln in b.splitlines() if ln.strip()]
        if len(lines) < 3:
            continue
        m = re.match(r"(\d+:\d+:\d+,\d+)\s*-->\s*(\d+:\d+:\d+,\d+)", lines[1])
        if not m:
            continue
        text = "".join(lines[2:])
        cues.append({
            "start": _ts_sec(m.group(1)),
            "end": _ts_sec(m.group(2)),
            "text": text,
        })
    return cues


def analyze_reference(path: Path | None = None) -> dict[str, float]:
    p = path or DEFAULT_REFERENCE_SRT
    if not p.is_file():
        return {}
    cues = parse_srt_path(p)
    if not cues:
        return {}
    durs = [c["end"] - c["start"] for c in cues]
    chars = [len(c["text"]) for c in cues]
    gaps = [cues[i]["start"] - cues[i - 1]["end"] for i in range(1, len(cues))]
    return {
        "line_count": len(cues),
        "median_duration_sec": statistics.median(durs),
        "mean_duration_sec": statistics.mean(durs),
        "median_chars": statistics.median(chars),
        "mean_chars": statistics.mean(chars),
        "p90_chars": sorted(chars)[int(len(chars) * 0.9)],
        "median_gap_sec": statistics.median(gaps) if gaps else 0.0,
    }


def is_hand_tuned_srt(cues: list[dict[str, Any]]) -> bool:
    """SRT đã chỉnh tay (~0531): không chạy gộp mạnh."""
    if len(cues) < 10:
        return False
    durs = [float(c["end"]) - float(c["start"]) for c in cues]
    return statistics.median(durs) >= TARGET_MEDIAN_DURATION_SEC - 0.35


def texts_continuation_merge(prev: str, nxt: str) -> bool:
    """Hai đoạn liền kề có thể gộp thành một cue kiểu SRT tay."""
    if not prev or not nxt:
        return False
    if len(prev) + len(nxt) > TARGET_MAX_CHARS_PER_CUE:
        return False
    if prev.endswith(("？", "?", "！", "!", "。")) and len(prev) >= 8:
        return False
    if nxt.startswith(("但是", "可是", "于是", "然后", "接着")):
        return False
    return True


def consolidate_cues_to_reference_style(cues: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Gộp cue OCR tách mịn → ~2s / ~9–13 chữ như 0531 (2).srt (~330 dòng).
    Không chạy khi file đã là SRT tay (median dur >= ~1.75s).
    """
    if not cues or is_hand_tuned_srt(cues):
        return cues

    out: list[dict[str, Any]] = [dict(cues[0])]
    for cue in cues[1:]:
        prev = out[-1]
        gap = float(cue["start"]) - float(prev["end"])
        pa, pb = str(prev["text"]), str(cue["text"])
        prev_dur = float(prev["end"]) - float(prev["start"])
        combined_dur = float(cue["end"]) - float(prev["start"])

        if gap > TARGET_MAX_MERGE_GAP_SEC:
            out.append(dict(cue))
            continue
        if len(pa) + len(pb) > TARGET_MAX_CHARS_PER_CUE or combined_dur > TARGET_MAX_CUE_DURATION_SEC:
            out.append(dict(cue))
            continue

        micro_gap = gap <= 0.05
        attach_tiny = len(pb) <= 4

        if micro_gap and attach_tiny and len(pa) + len(pb) <= 22:
            prev["end"] = max(float(prev["end"]), float(cue["end"]))
            prev["text"] = pa + pb
            continue
        out.append(dict(cue))
    return out


def consolidate_until_reference_stable(
    cues: list[dict[str, Any]],
    max_passes: int = 1,
) -> list[dict[str, Any]]:
    current = cues
    for _ in range(max_passes):
        merged = consolidate_cues_to_reference_style(current)
        if len(merged) == len(current):
            return merged
        current = merged
    return current
