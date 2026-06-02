"""Gộp các câu phụ đề bị OCR tách / đọc trùng."""
from __future__ import annotations

from collections import Counter
from difflib import SequenceMatcher
from typing import Any


def _ratio(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def _char_overlap_ratio(a: str, b: str) -> float:
    ca, cb = Counter(a), Counter(b)
    if not ca or not cb:
        return 0.0
    inter = sum((ca & cb).values())
    return inter / min(sum(ca.values()), sum(cb.values()))


def _bigram_jaccard(a: str, b: str) -> float:
    if len(a) < 2 or len(b) < 2:
        return 0.0
    ba = {a[i : i + 2] for i in range(len(a) - 1)}
    bb = {b[i : i + 2] for i in range(len(b) - 1)}
    if not ba or not bb:
        return 0.0
    return len(ba & bb) / len(ba | bb)


def _lcs_len(a: str, b: str) -> int:
    if not a or not b:
        return 0
    blocks = SequenceMatcher(None, a, b).get_matching_blocks()
    return max((block.size for block in blocks), default=0)


def texts_stutter_similar(a: str, b: str) -> bool:
    """Hai đọc OCR gần nhau bị lặp / cắt cụm cùng một câu."""
    if not a or not b:
        return False
    if a == b:
        return True
    if texts_same_subtitle(a, b, threshold=0.78):
        return True

    r = _ratio(a, b)
    if r >= 0.68:
        return True

    mn = min(len(a), len(b))
    if mn >= 6:
        lcs = _lcs_len(a, b)
        if lcs >= mn * 0.52:
            return True
        short, long = (a, b) if len(a) <= len(b) else (b, a)
        if len(short) >= 8 and short in long:
            return True
        if lcs >= 10 and lcs >= mn * 0.45:
            return True

    if mn >= 10:
        if _char_overlap_ratio(a, b) >= 0.9:
            return True
        if _bigram_jaccard(a, b) >= 0.78:
            return True

    return False


def _pick_best_stutter_text(texts: list[str]) -> str:
    """Chọn bản đọc dài và đầy đủ nhất trong cụm lặp."""
    if not texts:
        return ""
    return max(texts, key=lambda t: (sum(1 for c in t if "\u4e00" <= c <= "\u9fff"), len(t)))


def texts_same_subtitle(a: str, b: str, threshold: float = 0.82) -> bool:
    if not a or not b:
        return False
    if a == b:
        return True

    if _ratio(a, b) >= threshold:
        return True

    short, long = (a, b) if len(a) <= len(b) else (b, a)
    if len(short) >= 2 and short in long:
        return True

    min_len = min(len(a), len(b))
    if min_len == 0:
        return False

    prefix = 0
    for i in range(1, min_len + 1):
        if a[:i] == b[:i]:
            prefix = i
    if prefix >= min_len * 0.55:
        return True

    if min_len <= 8 and _ratio(a, b) >= 0.72:
        return True

    return False


def texts_should_merge(a: str, b: str, gap_sec: float, threshold: float) -> bool:
    """Có nên gộp hai cue liền kề thành một dòng không."""
    if texts_same_subtitle(a, b, threshold):
        return True

    if a == b and gap_sec <= 0.35:
        return True

    if gap_sec <= 0.2:
        if _ratio(a, b) >= max(0.72, threshold - 0.08):
            return True
        if texts_stutter_similar(a, b):
            return True
        short, long = (a, b) if len(a) <= len(b) else (b, a)
        if len(short) >= 2 and short in long:
            return True

    if gap_sec <= 0.55:
        if len(a) >= 2 and len(b) > len(a) and b.startswith(a):
            return True
        if len(b) >= 2 and len(a) > len(b) and a.startswith(b):
            return True
        if len(a) >= 3 and len(b) >= 3:
            if _ratio(a, b[: min(len(b), len(a) + 4)]) >= 0.88:
                return True
            if _ratio(b, a[: min(len(a), len(b) + 4)]) >= 0.88:
                return True

    return False


def _pick_longer_text(a: str, b: str) -> str:
    if len(b) > len(a):
        return b
    if len(a) > len(b):
        return a
    return b if _ratio(a, b) < 1.0 else a


def merge_cue_dicts(
    cues: list[dict[str, Any]],
    threshold: float,
    max_gap_sec: float,
) -> list[dict[str, Any]]:
    if not cues:
        return cues

    out: list[dict[str, Any]] = [dict(cues[0])]
    for cue in cues[1:]:
        prev = out[-1]
        gap = float(cue["start"]) - float(prev["end"])
        pa, pb = str(prev["text"]), str(cue["text"])
        if gap <= max_gap_sec and texts_should_merge(pa, pb, gap, threshold):
            prev["end"] = max(float(prev["end"]), float(cue["end"]))
            prev["text"] = _pick_longer_text(pa, pb)
            continue
        out.append(dict(cue))
    return out


def merge_cues_until_stable(
    cues: list[dict[str, Any]],
    threshold: float,
    max_gap_sec: float,
    max_passes: int = 8,
) -> list[dict[str, Any]]:
    current = cues
    for _ in range(max_passes):
        merged = merge_cue_dicts(current, threshold, max_gap_sec)
        if len(merged) == len(current):
            return merged
        current = merged
    return current


def collapse_ocr_stutter_clusters(
    cues: list[dict[str, Any]],
    cluster_window_sec: float = 4.5,
) -> list[dict[str, Any]]:
    """
    Gộp nhiều cue trong vài giây khi OCR đọc lại cùng một câu (biến thể / cắt cụm).
    """
    if len(cues) < 2:
        return cues

    out: list[dict[str, Any]] = []
    i = 0
    while i < len(cues):
        cluster: list[dict[str, Any]] = [dict(cues[i])]
        j = i + 1
        while j < len(cues):
            if float(cues[j]["start"]) - float(cluster[0]["start"]) > cluster_window_sec:
                break
            if any(
                texts_stutter_similar(str(c["text"]), str(cues[j]["text"]))
                for c in cluster
            ):
                cluster.append(dict(cues[j]))
                j += 1
            else:
                break

        if len(cluster) == 1:
            out.append(cluster[0])
            i += 1
            continue

        merged: dict[str, Any] = {
            "start": float(cluster[0]["start"]),
            "end": max(float(c["end"]) for c in cluster),
            "text": _pick_best_stutter_text([str(c["text"]) for c in cluster]),
        }
        out.append(merged)
        i = j

    return out


def dedupe_near_repeats(
    cues: list[dict[str, Any]],
    max_gap_sec: float = 0.45,
    threshold: float = 0.82,
) -> list[dict[str, Any]]:
    """Gộp hai cue liên tiếp nếu chữ giống hoặc gần giống (OCR đọc lại)."""
    if not cues:
        return cues
    out: list[dict[str, Any]] = [dict(cues[0])]
    for cue in cues[1:]:
        prev = out[-1]
        gap = float(cue["start"]) - float(prev["end"])
        pa, pb = str(prev["text"]), str(cue["text"])
        if gap <= max_gap_sec and (pa == pb or texts_same_subtitle(pa, pb, threshold)):
            prev["end"] = max(float(prev["end"]), float(cue["end"]))
            prev["text"] = _pick_longer_text(pa, pb)
            continue
        out.append(dict(cue))
    return out


def should_merge_narration_fragment(
    prev_text: str,
    next_text: str,
    gap_sec: float,
    max_gap_sec: float = 0.04,
    max_chars: int = 18,
    tiny_len: int = 6,
    micro_pair_len: int = 9,
) -> bool:
    """
    Chỉ gộp mảnh OCR cực ngắn / cùng nhịp (gap ~30ms).
    Không gộp hai câu ngắn khác nghĩa — giữ ~số dòng SRT tay (~330).
    """
    if gap_sec > max_gap_sec or gap_sec < -0.02:
        return False
    if len(prev_text) + len(next_text) > max_chars:
        return False
    if texts_stutter_similar(prev_text, next_text):
        return True
    if texts_should_merge(prev_text, next_text, gap_sec, threshold=0.82):
        return True
    if gap_sec > 0.035:
        return False
    if len(prev_text) <= tiny_len or len(next_text) <= tiny_len:
        return True
    if len(prev_text) <= micro_pair_len and len(next_text) <= micro_pair_len:
        return True
    return False


def merge_adjacent_narration_fragments(
    cues: list[dict[str, Any]],
    max_gap_sec: float = 0.04,
    max_chars: int = 18,
    max_duration_sec: float = 2.2,
    tiny_len: int = 6,
    micro_pair_len: int = 9,
) -> list[dict[str, Any]]:
    """Gộp mảnh OCR gap ~30ms (không gộp hai câu dài khác nhau)."""
    if len(cues) < 2:
        return cues

    out: list[dict[str, Any]] = [dict(cues[0])]
    for cue in cues[1:]:
        prev = out[-1]
        gap = float(cue["start"]) - float(prev["end"])
        pa, pb = str(prev["text"]), str(cue["text"])
        duration = float(cue["end"]) - float(prev["start"])
        if duration <= max_duration_sec and should_merge_narration_fragment(
            pa, pb, gap, max_gap_sec, max_chars, tiny_len, micro_pair_len
        ):
            prev["end"] = max(float(prev["end"]), float(cue["end"]))
            prev["text"] = pa + pb
            continue
        out.append(dict(cue))
    return out


def cues_need_narration_merge(cues: list[dict[str, Any]]) -> bool:
    """SRT đã dài (~2s/dòng) thì không gộp mảnh — tránh 334 → 224."""
    if len(cues) < 2:
        return False
    durs = [float(c["end"]) - float(c["start"]) for c in cues]
    avg_dur = sum(durs) / len(durs)
    if avg_dur >= 1.65:
        return False
    gaps = [float(cues[i + 1]["start"]) - float(cues[i]["end"]) for i in range(len(cues) - 1)]
    micro = sum(1 for g in gaps if 0 <= g <= 0.05)
    return micro >= len(gaps) * 0.85


def merge_narration_until_stable(
    cues: list[dict[str, Any]],
    max_passes: int = 2,
    **kwargs: Any,
) -> list[dict[str, Any]]:
    current = cues
    for _ in range(max_passes):
        merged = merge_adjacent_narration_fragments(current, **kwargs)
        if len(merged) == len(current):
            return merged
        current = merged
    return current


def extend_cue_gaps_for_playback(
    cues: list[dict[str, Any]],
    fill_gap_sec: float = 0.18,
    end_pad_sec: float = 0.02,
) -> list[dict[str, Any]]:
    """Kéo dài end time lấp micro-gap để phụ đề không nhảy sớm hơn video."""
    if len(cues) < 2:
        return cues
    out = [dict(c) for c in cues]
    for i in range(len(out) - 1):
        next_start = float(out[i + 1]["start"])
        gap = next_start - float(out[i]["end"])
        if 0 <= gap < fill_gap_sec:
            out[i]["end"] = next_start - end_pad_sec
        if out[i]["end"] < float(out[i]["start"]) + 0.06:
            out[i]["end"] = float(out[i]["start"]) + 0.06
    return out


def find_duplicate_pairs(cues: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Liệt kê cặp cue trùng / mảnh lặp để UI highlight (trước khi gộp)."""
    pairs: list[dict[str, Any]] = []
    seen: set[tuple[int, int]] = set()

    def add(i: int, j: int, kind: str, score: float) -> None:
        key = (i, j)
        if key in seen:
            return
        seen.add(key)
        pairs.append({
            "indexA": i,
            "indexB": j,
            "kind": kind,
            "score": round(score, 3),
            "textA": str(cues[i]["text"])[:80],
            "textB": str(cues[j]["text"])[:80],
            "gapSec": round(float(cues[j]["start"]) - float(cues[i]["end"]), 3),
        })

    for i in range(len(cues) - 1):
        gap = float(cues[i + 1]["start"]) - float(cues[i]["end"])
        a, b = str(cues[i]["text"]), str(cues[i + 1]["text"])
        if texts_stutter_similar(a, b):
            add(i, i + 1, "stutter", _ratio(a, b))
        elif a == b and gap <= 2.0:
            add(i, i + 1, "exact_repeat", 1.0)
        elif should_merge_narration_fragment(a, b, gap):
            add(i, i + 1, "over_split", _ratio(a, b))

    for j in range(1, len(cues)):
        for i in range(max(0, j - 12), j):
            gap = float(cues[j]["start"]) - float(cues[i]["end"])
            if gap > 8.0 or gap < -0.05:
                continue
            a, b = str(cues[i]["text"]), str(cues[j]["text"])
            if a and a == b:
                add(i, j, "same_text_window", 1.0)

    return pairs


def dedupe_exact_repeats(cues: list[dict[str, Any]], max_gap_sec: float = 0.4) -> list[dict[str, Any]]:
    """Gộp hai cue liên tiếp nếu chữ giống hệt (OCR đọc lại cùng một nhịp)."""
    if not cues:
        return cues
    out: list[dict[str, Any]] = [dict(cues[0])]
    for cue in cues[1:]:
        prev = out[-1]
        gap = float(cue["start"]) - float(prev["end"])
        if str(prev["text"]) == str(cue["text"]) and gap <= max_gap_sec:
            prev["end"] = max(float(prev["end"]), float(cue["end"]))
            continue
        out.append(dict(cue))
    return out
