"""
Subtitle OCR extractor (rewritten clean implementation).

Pipeline:
1) Decode video and sample frames by profile.
2) Crop user ROI and skip similar frames by visual similarity.
3) OCR Chinese text (EasyOCR; PaddleOCR if paddlepaddle is available).
4) Build SRT cues and cleanup duplicates.
"""
from __future__ import annotations

import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import warnings
from collections import Counter
from datetime import timedelta
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from ocr_profiles import OcrProfile, get_profile
from srt_cleanup import cleanup_srt_file
from reference_srt_style import consolidate_until_reference_stable, texts_continuation_merge
from subtitle_merge import (
    collapse_ocr_stutter_clusters,
    dedupe_near_repeats,
    extend_cue_gaps_for_playback,
    merge_cues_until_stable,
    texts_same_subtitle,
)

DEFAULT_MAX_VIDEO_HEIGHT = 720


def _configure_stdio_utf8() -> None:
    for stream in (sys.stdout, sys.stderr):
        if stream is None:
            continue
        try:
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(encoding="utf-8", errors="replace")
            elif hasattr(stream, "buffer"):
                wrapper = io.TextIOWrapper(stream.buffer, encoding="utf-8", errors="replace", line_buffering=True)
                if stream is sys.stdout:
                    sys.stdout = wrapper
                else:
                    sys.stderr = wrapper
        except Exception:
            pass


_configure_stdio_utf8()


def emit(payload: dict[str, Any]) -> None:
    line = json.dumps(payload, ensure_ascii=False) + "\n"
    try:
        sys.stdout.write(line)
    except UnicodeEncodeError:
        sys.stdout.buffer.write(line.encode("utf-8", errors="replace"))
    sys.stdout.flush()


def format_ts(td: timedelta) -> str:
    total = max(0.0, td.total_seconds())
    h = int(total // 3600)
    m = int((total % 3600) // 60)
    s = int(total % 60)
    ms = int(round((total - int(total)) * 1000))
    if ms >= 1000:
        ms = 0
        s += 1
    if s >= 60:
        s = 0
        m += 1
    if m >= 60:
        m = 0
        h += 1
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", "", text.strip())


def similarity_ratio(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio() * 100.0


def _find_ffmpeg() -> str | None:
    for candidate in (
        os.environ.get("FFMPEG_PATH"),
        shutil.which("ffmpeg"),
        shutil.which("ffmpeg.exe"),
    ):
        if candidate and Path(candidate).exists():
            return candidate
    root = Path(__file__).resolve().parent.parent
    name = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    bundled = root / "node_modules" / "ffmpeg-static" / name
    if bundled.exists():
        return str(bundled)
    return None


def _video_size(path: str) -> tuple[int, int]:
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        return 0, 0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 0
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 0
    cap.release()
    return w, h


def prepare_video_for_ocr(video_path: str, max_height: int, enabled: bool) -> tuple[str, str | None]:
    """
    Video > max_height: tạo bản tạm 720p bằng ffmpeg (nhanh hơn decode 4K từng frame).
    Trả về (đường_dẫn_dùng_ocr, file_tạm_cần_xóa hoặc None).
    """
    w, h = _video_size(video_path)
    if not enabled or h <= max_height or h == 0:
        if h > max_height:
            emit({
                "type": "info",
                "message": f"Video {w}×{h} — giảm từng khung tối đa {max_height}p (bật ffmpeg trong PATH để tạo bản 720p nhanh hơn).",
            })
        return video_path, None

    ffmpeg = _find_ffmpeg()
    if not ffmpeg:
        emit({
            "type": "info",
            "message": f"Video {w}×{h} — giảm từng khung {max_height}p (không tìm thấy ffmpeg).",
        })
        return video_path, None

    temp_path = os.path.join(
        tempfile.gettempdir(),
        f"ocr-{max_height}p-{os.getpid()}-{int(time.time() * 1000)}.mp4",
    )
    emit({
        "type": "progress",
        "phase": "prep",
        "progress": 4,
        "status": f"Đang tạo bản {max_height}p để OCR nhanh hơn ({w}×{h})...",
    })
    cmd = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        video_path,
        "-vf",
        f"scale=-2:{max_height}",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "23",
        "-an",
        "-movflags",
        "+faststart",
        temp_path,
    ]
    subprocess.run(cmd, check=True)
    nw, nh = _video_size(temp_path)
    emit({
        "type": "info",
        "message": f"Đã giảm video {w}×{h} → {nw}×{nh} (tối đa {max_height}p) để quét nhanh hơn.",
    })
    return temp_path, temp_path


def scale_frame(frame: np.ndarray, max_h: int = DEFAULT_MAX_VIDEO_HEIGHT) -> np.ndarray:
    h, w = frame.shape[:2]
    if h <= max_h:
        return frame
    scale = max_h / h
    return cv2.resize(frame, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA)


def crop_roi(frame: np.ndarray, x_min: float, y_min: float, x_max: float, y_max: float) -> np.ndarray:
    h, w = frame.shape[:2]
    x1 = max(0, min(int(x_min * w), w - 1))
    x2 = max(x1 + 1, min(int(x_max * w), w))
    y1 = max(0, min(int(y_min * h), h - 1))
    y2 = max(y1 + 1, min(int(y_max * h), h))
    return frame[y1:y2, x1:x2]


def _resize_crop(crop: np.ndarray, max_w: int) -> np.ndarray:
    if crop.size == 0:
        return crop
    h, w = crop.shape[:2]
    if w > max_w:
        scale = max_w / max(1, w)
        crop = cv2.resize(crop, (max_w, max(24, int(h * scale))), interpolation=cv2.INTER_CUBIC)
    return crop


def preprocess_for_ocr(crop: np.ndarray, max_w: int) -> np.ndarray:
    """Ảnh màu tương phản cao — EasyOCR đọc tốt hơn ảnh xám mờ."""
    crop = _resize_crop(crop, max_w)
    if crop.size == 0:
        return crop
    h, w = crop.shape[:2]
    if h < 36:
        scale = 36 / max(1, h)
        crop = cv2.resize(crop, (max(1, int(w * scale)), max(36, int(h * scale))), interpolation=cv2.INTER_CUBIC)
    if len(crop.shape) == 2:
        crop = cv2.cvtColor(crop, cv2.COLOR_GRAY2BGR)
    lab = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB)
    l_ch, a_ch, b_ch = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.8, tileGridSize=(8, 8))
    l_ch = clahe.apply(l_ch)
    out = cv2.cvtColor(cv2.merge([l_ch, a_ch, b_ch]), cv2.COLOR_LAB2BGR)
    kernel = np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]], dtype=np.float32)
    return cv2.filter2D(out, -1, kernel)


def change_detection_thumb(crop: np.ndarray, width: int = 200) -> np.ndarray:
    """Cạnh chữ — nhạy hơn khi chỉ đổi phụ đề, nền video gần như không đổi."""
    if crop.size == 0:
        return np.zeros((8, width), dtype=np.uint8)
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if len(crop.shape) == 3 else crop
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    edges = cv2.Canny(gray, 40, 120)
    h, w = edges.shape[:2]
    thumb_h = max(8, int(h * width / max(1, w)))
    return cv2.resize(edges, (width, thumb_h), interpolation=cv2.INTER_AREA)


def frame_similarity_pct(prev_thumb: np.ndarray | None, curr_thumb: np.ndarray) -> float:
    if prev_thumb is None:
        return 0.0
    if prev_thumb.shape != curr_thumb.shape:
        curr_thumb = cv2.resize(curr_thumb, (prev_thumb.shape[1], prev_thumb.shape[0]), interpolation=cv2.INTER_AREA)
    mae = float(np.mean(cv2.absdiff(prev_thumb, curr_thumb)))
    return max(0.0, 100.0 - mae / 2.55)


def detect_gpu() -> bool:
    try:
        import torch
        return bool(torch.cuda.is_available())
    except Exception:
        pass
    try:
        import paddle
        return bool(paddle.device.is_compiled_with_cuda() and paddle.device.cuda.device_count() > 0)
    except Exception:
        return False


def _disable_paddle_onednn() -> None:
    """Tránh lỗi OneDNN/MKLDNN trên Windows CPU (fused_conv2d Filter not found)."""
    for key, val in (
        ("FLAGS_use_mkldnn", "0"),
        ("FLAGS_use_dnnl", "0"),
        ("FLAGS_enable_onednn", "0"),
        ("FLAGS_use_onednn", "0"),
        ("CPU_NUM_THREADS", "1"),
        ("OMP_NUM_THREADS", "1"),
    ):
        os.environ.setdefault(key, val)


def _try_create_paddle_reader(use_gpu: bool) -> Any | None:
    """PaddleOCR only works when paddlepaddle is installed (not on Python 3.14)."""
    _disable_paddle_onednn()
    try:
        import paddle

        try:
            paddle.set_flags({"FLAGS_use_mkldnn": False})
        except Exception:
            pass
        from paddleocr import PaddleOCR
    except Exception:
        return None

    warnings.simplefilter("ignore", DeprecationWarning)
    warnings.simplefilter("ignore", FutureWarning)

    base: dict[str, Any] = {
        "lang": "ch",
        "use_angle_cls": False,
        "use_gpu": use_gpu,
        "show_log": False,
        "enable_mkldnn": False,
        "det_limit_side_len": 736,
        "rec_batch_num": 8,
    }
    attempts: list[dict[str, Any]] = [
        dict(base),
        {"lang": "ch", "use_angle_cls": False, "use_gpu": use_gpu, "enable_mkldnn": False},
        {"lang": "ch", "use_gpu": use_gpu, "enable_mkldnn": False},
        {"lang": "ch", "enable_mkldnn": False},
        {"lang": "ch"},
    ]
    last_err: Exception | None = None
    for kwargs in attempts:
        try:
            return ("paddle", PaddleOCR(**kwargs))
        except Exception as e:
            last_err = e
            continue
    if last_err is not None:
        print(f"[ocr] PaddleOCR init failed: {last_err}", file=sys.stderr)
    return None


def create_ocr_reader(use_gpu: bool) -> tuple[str, Any]:
    import sys as _sys

    paddle_reader = _try_create_paddle_reader(use_gpu)
    if paddle_reader is not None:
        return paddle_reader

    prefer_paddle = _sys.version_info[:2] in ((3, 11), (3, 12))
    if prefer_paddle:
        raise RuntimeError(
            "PaddleOCR không khởi tạo được trên Python này.\n"
            f"Python: {_sys.executable} ({_sys.version.split()[0]})\n"
            "Chạy: powershell -File scripts\\setup-paddleocr.ps1\n"
            "Rồi restart npm.cmd run dev"
        )

    try:
        import easyocr
    except Exception as e:
        raise RuntimeError(
            "Không thể khởi tạo OCR. Trên Python 3.14 chỉ có EasyOCR;\n"
            "để dùng PaddleOCR hãy cài Python 3.12: scripts\\setup-paddleocr.ps1\n"
            f"(Chi tiết: {e})"
        ) from e

    print(
        f"[ocr] Cảnh báo: đang dùng EasyOCR (Python {_sys.version.split()[0]}). "
        "Cài Python 3.12 + PaddleOCR để chính xác hơn.",
        file=sys.stderr,
    )
    reader = easyocr.Reader(["ch_sim", "en"], gpu=use_gpu, verbose=False)
    return ("easyocr", reader)


def run_ocr_on_image(engine: str, reader: Any, image: np.ndarray, min_conf: float) -> str:
    if image.size == 0:
        return ""

    if engine == "easyocr":
        if len(image.shape) == 2:
            ocr_input = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
        else:
            ocr_input = image
        results = reader.readtext(ocr_input)
        lines: list[tuple[float, float, str]] = []
        for item in results:
            if not item or len(item) < 2:
                continue
            box, text, conf = item[0], (item[1] or "").strip(), float(item[2]) if len(item) > 2 else 1.0
            if not text or conf < min_conf:
                continue
            cx = sum(p[0] for p in box) / len(box)
            cy = sum(p[1] for p in box) / len(box)
            lines.append((cy, cx, text))
        lines.sort(key=lambda x: (x[0], x[1]))
        return normalize_text("".join(t[2] for t in lines))

    # PaddleOCR — ảnh BGR uint8 liên tục
    ocr_input = image
    if len(ocr_input.shape) == 2:
        ocr_input = cv2.cvtColor(ocr_input, cv2.COLOR_GRAY2BGR)
    if ocr_input.dtype != np.uint8:
        ocr_input = np.clip(ocr_input, 0, 255).astype(np.uint8)
    ocr_input = np.ascontiguousarray(ocr_input)

    try:
        result = reader.ocr(ocr_input, cls=False)
    except TypeError:
        result = reader.ocr(ocr_input)
    except RuntimeError as e:
        if "OneDnn" in str(e) or "onednn" in str(e).lower() or "mkldnn" in str(e).lower():
            raise RuntimeError(
                "PaddleOCR lỗi OneDNN trên Windows. Đã tắt MKLDNN — hãy restart OCR; "
                "nếu vẫn lỗi: py -3.12 -m pip install paddlepaddle==2.6.2"
            ) from e
        raise
    if not result or result[0] is None:
        return ""
    lines = []
    for item in result[0]:
        if not item or len(item) < 2:
            continue
        text = (item[1][0] or "").strip()
        conf = float(item[1][1]) if len(item[1]) > 1 else 1.0
        if not text or conf < min_conf:
            continue
        box = item[0]
        cx = sum(p[0] for p in box) / len(box)
        cy = sum(p[1] for p in box) / len(box)
        lines.append((cy, cx, text))
    lines.sort(key=lambda x: (x[0], x[1]))
    return normalize_text("".join(t[2] for t in lines))


def _pick_best_text(votes: Counter[str]) -> str:
    if not votes:
        return ""
    ranked = sorted(votes.items(), key=lambda x: (x[1], len(x[0])), reverse=True)
    return ranked[0][0]


def _is_meaningful_cue_text(text: str) -> bool:
    if not text:
        return False
    cjk = sum(1 for c in text if "\u4e00" <= c <= "\u9fff")
    if cjk >= 1:
        return len(text) >= 1
    return len(text) >= 3


def build_srt(samples: list[tuple[float, str]], duration_sec: float, profile: OcrProfile) -> str:
    """
    Mỗi lần chữ phụ đề đổi (OCR khác đáng kể so với dòng đang hiển thị) → một cue SRT.
    Chỉ gộp nhiều lần đọc khi cùng một dòng đang hiện trên màn hình (sim >= ngưỡng).
    """
    same_line_threshold = profile.sim_threshold
    min_dur = profile.min_subtitle_sec
    max_cue_dur = profile.max_cue_duration_sec
    flush_empty = profile.empty_flush_count

    cues: list[dict[str, Any]] = []
    active: dict[str, Any] | None = None
    empty_streak = 0

    def flush(end_sec: float) -> None:
        nonlocal active
        if active is None:
            return
        text = _pick_best_text(active["votes"])
        if _is_meaningful_cue_text(text):
            cues.append({
                "start": active["start"],
                "end": max(end_sec, active["last_t"], active["start"] + min_dur),
                "text": text,
            })
        active = None

    for t, raw_text in samples:
        text = normalize_text(raw_text)
        if not text:
            empty_streak += 1
            if empty_streak >= flush_empty:
                flush(t)
            continue

        empty_streak = 0
        if active is None:
            active = {"start": t, "last": text, "last_t": t, "votes": Counter([text])}
            continue

        same_line = texts_same_subtitle(
            active["last"], text, threshold=same_line_threshold / 100.0
        )
        cue_too_long = (t - active["start"]) > max_cue_dur
        micro_gap = (t - active["last_t"]) <= 0.12
        can_extend = (
            not cue_too_long
            and micro_gap
            and len(active["last"]) + len(text) <= 28
            and (
                same_line
                or texts_continuation_merge(active["last"], text)
            )
        )

        if can_extend:
            active["votes"][text] += 1
            if not same_line and text not in active["last"]:
                active["last"] = active["last"] + text
            else:
                active["last"] = text
            active["last_t"] = t
        else:
            flush(t)
            active = {"start": t, "last": text, "last_t": t, "votes": Counter([text])}

    flush(duration_sec)

    cues = collapse_ocr_stutter_clusters(cues, cluster_window_sec=4.5)
    cues = merge_cues_until_stable(
        cues,
        threshold=profile.merge_sim,
        max_gap_sec=profile.merge_gap_sec,
    )
    cues = dedupe_near_repeats(cues, max_gap_sec=0.5, threshold=profile.merge_sim)
    cues = merge_cues_until_stable(
        cues,
        threshold=profile.merge_sim,
        max_gap_sec=profile.merge_gap_sec,
    )
    cues = collapse_ocr_stutter_clusters(cues, cluster_window_sec=3.5)
    cues = consolidate_until_reference_stable(cues)
    cues = extend_cue_gaps_for_playback(cues, fill_gap_sec=0.10)

    for i in range(len(cues) - 1):
        next_start = cues[i + 1]["start"]
        if cues[i]["end"] > next_start - 0.02:
            cues[i]["end"] = max(cues[i]["start"] + min_dur, next_start - 0.03)

    lines: list[str] = []
    for idx, seg in enumerate(cues, start=1):
        lines.append(str(idx))
        lines.append(f"{format_ts(timedelta(seconds=seg['start']))} --> {format_ts(timedelta(seconds=seg['end']))}")
        lines.append(seg["text"])
        lines.append("")
    return "\n".join(lines)


def _emit_ocr_progress(
    sampled: int,
    est_samples: int,
    ocr_count: int,
    text_changes: int,
    current_sec: float,
    duration_sec: float,
) -> None:
    scan_pct = 8 + int((sampled / max(est_samples, 1)) * 84)
    emit({
        "type": "progress",
        "phase": "ocr",
        "progress": min(93, scan_pct),
        "current": text_changes,
        "status": (
            f"Quét {sampled}/{est_samples} khung — OCR {ocr_count} ảnh — "
            f"{text_changes} đổi chữ ({int(current_sec)}s/{int(duration_sec)}s)"
        ),
    })


def check_ocr_ready() -> bool:
    try:
        import easyocr  # noqa: F401
        return True
    except Exception:
        pass
    try:
        import paddle  # noqa: F401
        from paddleocr import PaddleOCR  # noqa: F401
        return True
    except Exception:
        return False


def extract(
    video_path: str,
    x_min: float,
    y_min: float,
    x_max: float,
    y_max: float,
    output_path: str,
    profile_key: str,
    downscale_720: bool = True,
) -> int:
    profile = get_profile(profile_key)
    max_h = profile.max_video_height
    work_path, temp_video = prepare_video_for_ocr(video_path, max_h, downscale_720)

    cap = cv2.VideoCapture(work_path)
    if not cap.isOpened():
        if temp_video and os.path.exists(temp_video):
            os.remove(temp_video)
        raise RuntimeError("Không mở được video.")

    fps = float(cap.get(cv2.CAP_PROP_FPS)) or 25.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total_frames / fps if total_frames > 0 else 0.0

    step = max(1, int(round(fps / profile.scan_fps))) * (profile.frames_to_skip + 1)
    est_samples = max(1, total_frames // step)

    use_gpu = detect_gpu()
    emit({"type": "progress", "phase": "init", "progress": 5, "status": "Đang tải engine OCR..."})
    engine, reader = create_ocr_reader(use_gpu)
    engine_label = "PaddleOCR" if engine == "paddle" else "EasyOCR"
    emit({"type": "info", "message": f"{engine_label} — {profile.name} | GPU={'có' if use_gpu else 'không'}"})

    samples: list[tuple[float, str]] = []
    last_ocr_thumb: np.ndarray | None = None
    last_ocr_sec = -1.0
    last_stable_text = ""
    frame_idx = 0
    sampled = 0
    ocr_count = 0
    text_change_count = 0
    skipped_similar = 0

    def report_progress() -> None:
        _emit_ocr_progress(sampled, est_samples, ocr_count, text_change_count, current_sec, duration)

    while frame_idx < total_frames:
        for _ in range(step - 1):
            if frame_idx >= total_frames:
                break
            cap.grab()
            frame_idx += 1
        if frame_idx >= total_frames:
            break

        ok, frame = cap.read()
        if not ok:
            break

        current_sec = frame_idx / fps
        frame_idx += 1
        sampled += 1

        frame_scaled = scale_frame(frame, max_h)
        crop = crop_roi(frame_scaled, x_min, y_min, x_max, y_max)
        if crop.size == 0:
            continue

        curr_thumb = change_detection_thumb(crop)
        vis_sim = frame_similarity_pct(last_ocr_thumb, curr_thumb)
        visual_changed = last_ocr_thumb is None or vis_sim < profile.ssim_threshold
        time_for_safety = (
            last_ocr_sec < 0
            or (current_sec - last_ocr_sec) >= profile.force_ocr_interval_sec
        )
        too_soon = (
            last_ocr_sec >= 0
            and (current_sec - last_ocr_sec) < profile.min_ocr_interval_sec
        )

        if not visual_changed and not time_for_safety:
            skipped_similar += 1
            if sampled % 8 == 0:
                report_progress()
            continue

        if too_soon and not visual_changed:
            skipped_similar += 1
            if sampled % 8 == 0:
                report_progress()
            continue

        ocr_img = preprocess_for_ocr(crop, profile.ocr_max_width)
        text = run_ocr_on_image(engine, reader, ocr_img, profile.conf_threshold)
        ocr_count += 1
        last_ocr_sec = current_sec
        last_ocr_thumb = curr_thumb.copy()

        if not text:
            if last_stable_text:
                samples.append((current_sec, ""))
                last_stable_text = ""
            if sampled % 6 == 0:
                report_progress()
            continue

        same_as_stable = last_stable_text and texts_same_subtitle(
            last_stable_text, text, threshold=profile.sim_threshold / 100.0
        )
        if same_as_stable:
            if samples and len(text) > len(samples[-1][1]):
                samples[-1] = (samples[-1][0], text)
                last_stable_text = text
            if sampled % 6 == 0:
                report_progress()
            continue

        text_change_count += 1
        last_stable_text = text
        samples.append((current_sec, text))

        if sampled % 4 == 0:
            report_progress()

    cap.release()
    if temp_video and os.path.exists(temp_video):
        try:
            os.remove(temp_video)
        except OSError:
            pass

    if not any(t for _, t in samples):
        raise RuntimeError("Không đọc được chữ trong vùng quét. Hãy kéo khung cyan sát phụ đề.")

    emit({
        "type": "info",
        "message": (
            f"Quét {sampled} khung, OCR {ocr_count} lần (bỏ qua {skipped_similar} khung giống), "
            f"{text_change_count} lần đổi chữ → tạo SRT."
        ),
    })

    emit({"type": "progress", "phase": "merge", "progress": 95, "status": "Đang gộp câu trùng OCR..."})
    srt = build_srt(samples, duration, profile)
    Path(output_path).write_text(srt, encoding="utf-8")
    before_clean, after_clean, _, dup_after = cleanup_srt_file(
        output_path,
        merge_sim=profile.merge_sim,
        max_merge_gap_sec=profile.merge_gap_sec,
    )
    merged_away = max(0, before_clean - after_clean)
    emit({
        "type": "info",
        "message": (
            f"Gộp trùng: {before_clean} → {after_clean} dòng "
            f"(đã gộp {merged_away} dòng; còn {len(dup_after)} cặp trùng nhẹ)."
        ),
    })

    fixed = Path(output_path).read_text(encoding="utf-8")
    return len(re.findall(r"^\d+\s*$", fixed, re.MULTILINE))


def run_ocr(
    video_path: str,
    x_min: float,
    y_min: float,
    x_max: float,
    y_max: float,
    output_srt_path: str,
    profile_key: str = "accurate",
    downscale_720: bool = True,
) -> None:
    if not check_ocr_ready():
        emit({
            "type": "error",
            "message": (
                "Chưa cài OCR. Trong terminal chạy:\n"
                "pip install -r python_services/requirements.txt"
            ),
        })
        sys.exit(1)

    try:
        count = extract(
            video_path, x_min, y_min, x_max, y_max, output_srt_path, profile_key, downscale_720
        )
    except Exception as e:
        emit({"type": "error", "message": f"{type(e).__name__}: {e}"})
        raise

    emit({"type": "progress", "phase": "done", "progress": 100, "status": f"Hoàn tất — {count} dòng phụ đề."})
    emit({"type": "done", "srt_path": output_srt_path, "subtitles_count": count, "ocr_engine": "ocr"})


if __name__ == "__main__":
    try:
        if len(sys.argv) < 7:
            emit({"type": "error", "message": "Usage: ocr_processor.py video xMin yMin xMax yMax out.srt [profile]"})
            sys.exit(1)
        profile = sys.argv[7] if len(sys.argv) > 7 else "accurate"
        downscale = sys.argv[8].strip() not in ("0", "false", "no") if len(sys.argv) > 8 else True
        run_ocr(
            sys.argv[1],
            float(sys.argv[2]),
            float(sys.argv[3]),
            float(sys.argv[4]),
            float(sys.argv[5]),
            sys.argv[6],
            profile,
            downscale,
        )
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        sys.exit(1)
