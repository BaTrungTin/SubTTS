"""
Subtitle OCR extractor (rewritten clean implementation).

Pipeline:
1) Decode video and sample frames by profile.
2) Crop user ROI and skip similar frames by visual similarity.
3) OCR Chinese text with PaddleOCR (new API compatibility).
4) Build SRT cues and cleanup duplicates.
"""
from __future__ import annotations

import io
import json
import re
import sys
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

MAX_FRAME_HEIGHT = 720
SCAN_FPS = 6
EMPTY_TEXT_RUN_LIMIT = 3


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


def scale_frame(frame: np.ndarray, max_h: int = MAX_FRAME_HEIGHT) -> np.ndarray:
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


def preprocess_crop(crop: np.ndarray, max_w: int) -> np.ndarray:
    if crop.size == 0:
        return crop
    h, w = crop.shape[:2]
    if w > max_w:
        scale = max_w / max(1, w)
        crop = cv2.resize(crop, (max_w, max(24, int(h * scale))), interpolation=cv2.INTER_CUBIC)
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if len(crop.shape) == 3 else crop
    clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    return cv2.GaussianBlur(enhanced, (3, 3), 0)


def roi_thumb(gray: np.ndarray, width: int = 160) -> np.ndarray:
    h, w = gray.shape[:2]
    thumb_h = max(8, int(h * width / max(1, w)))
    return cv2.resize(gray, (width, thumb_h), interpolation=cv2.INTER_AREA)


def frame_similarity_pct(prev_thumb: np.ndarray | None, curr_thumb: np.ndarray) -> float:
    if prev_thumb is None:
        return 0.0
    if prev_thumb.shape != curr_thumb.shape:
        curr_thumb = cv2.resize(curr_thumb, (prev_thumb.shape[1], prev_thumb.shape[0]), interpolation=cv2.INTER_AREA)
    mae = float(np.mean(cv2.absdiff(prev_thumb, curr_thumb)))
    return max(0.0, 100.0 - mae / 2.55)


def detect_gpu() -> bool:
    try:
        import paddle
        return bool(paddle.device.is_compiled_with_cuda() and paddle.device.cuda.device_count() > 0)
    except Exception:
        return False


def create_paddle_reader(use_gpu: bool):
    from paddleocr import PaddleOCR

    warnings.simplefilter("ignore", DeprecationWarning)
    warnings.simplefilter("ignore", FutureWarning)

    base_kwargs: dict[str, Any] = {"lang": "ch", "show_log": False}
    attempts: list[dict[str, Any]] = [
        {"use_textline_orientation": False, "device": "gpu" if use_gpu else "cpu"},
        {"use_textline_orientation": False, "use_gpu": use_gpu},
        {"device": "gpu" if use_gpu else "cpu"},
        {"use_gpu": use_gpu},
        {},
    ]
    last_err: Exception | None = None
    for extra in attempts:
        try:
            return PaddleOCR(**base_kwargs, **extra)
        except Exception as e:  # keep broad for version changes
            last_err = e
            continue
    raise RuntimeError(f"Không thể khởi tạo PaddleOCR: {last_err}")


def run_ocr_on_image(reader: Any, image: np.ndarray, min_conf: float) -> str:
    if image.size == 0:
        return ""
    result = None
    try:
        result = reader.ocr(image, cls=False)
    except TypeError:
        result = reader.ocr(image)
    if not result or result[0] is None:
        return ""
    lines: list[tuple[float, float, str]] = []
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
    return normalize_text("".join(item[2] for item in lines))


def build_srt(samples: list[tuple[float, str]], duration_sec: float, profile: OcrProfile) -> str:
    sim_threshold = profile.sim_threshold
    min_dur = profile.min_subtitle_sec

    merged: list[dict[str, Any]] = []
    active: dict[str, Any] | None = None

    def flush(end_sec: float) -> None:
        nonlocal active
        if active is None:
            return
        text = active["votes"].most_common(1)[0][0]
        if len(text) >= 2:
            merged.append({
                "start": active["start"],
                "end": max(end_sec, active["start"] + min_dur),
                "text": text,
            })
        active = None

    for t, raw_text in samples:
        text = normalize_text(raw_text)
        if not text:
            flush(t)
            continue
        if active is None:
            active = {"start": t, "last": text, "votes": Counter([text])}
            continue
        if similarity_ratio(active["last"], text) >= sim_threshold:
            active["votes"][text] += 1
            active["last"] = text
        else:
            flush(t)
            active = {"start": t, "last": text, "votes": Counter([text])}

    flush(duration_sec)

    for i in range(len(merged) - 1):
        next_start = merged[i + 1]["start"]
        if merged[i]["end"] > next_start - 0.03:
            merged[i]["end"] = max(merged[i]["start"] + min_dur, next_start - 0.05)

    lines: list[str] = []
    for idx, seg in enumerate(merged, start=1):
        lines.append(str(idx))
        lines.append(f"{format_ts(timedelta(seconds=seg['start']))} --> {format_ts(timedelta(seconds=seg['end']))}")
        lines.append(seg["text"])
        lines.append("")
    return "\n".join(lines)


def check_paddle_ready() -> bool:
    try:
        from paddleocr import PaddleOCR  # noqa: F401
        return True
    except Exception:
        return False


def extract(video_path: str, x_min: float, y_min: float, x_max: float, y_max: float, output_path: str, profile_key: str) -> int:
    profile = get_profile(profile_key)
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError("Không mở được video.")

    fps = float(cap.get(cv2.CAP_PROP_FPS)) or 25.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total_frames / fps if total_frames > 0 else 0.0

    step = max(1, int(round(fps / SCAN_FPS))) * (profile.frames_to_skip + 1)
    est_samples = max(1, total_frames // step)

    use_gpu = detect_gpu()
    emit({"type": "info", "message": f"PaddleOCR — {profile.name} | GPU={'có' if use_gpu else 'không'}"})
    emit({"type": "progress", "phase": "init", "progress": 5, "status": "Đang tải PaddleOCR..."})
    reader = create_paddle_reader(use_gpu)

    samples: list[tuple[float, str]] = []
    prev_thumb: np.ndarray | None = None
    frame_idx = 0
    sampled = 0
    ocr_count = 0
    empty_runs = 0

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

        frame_scaled = scale_frame(frame)
        crop = crop_roi(frame_scaled, x_min, y_min, x_max, y_max)
        if crop.size == 0:
            continue

        gray = preprocess_crop(crop, profile.ocr_max_width)
        curr_thumb = roi_thumb(gray)
        sim = frame_similarity_pct(prev_thumb, curr_thumb)
        prev_thumb = curr_thumb

        if sim >= profile.ssim_threshold:
            continue

        text = run_ocr_on_image(reader, gray, profile.conf_threshold)
        if text:
            empty_runs = 0
            samples.append((current_sec, text))
            ocr_count += 1
        else:
            empty_runs += 1
            if empty_runs <= EMPTY_TEXT_RUN_LIMIT:
                samples.append((current_sec, ""))

        if sampled % 5 == 0:
            pct = 8 + int((sampled / est_samples) * 84)
            emit({
                "type": "progress",
                "phase": "ocr",
                "progress": min(93, pct),
                "current": ocr_count,
                "status": f"OCR {ocr_count} ảnh — {int(current_sec)}s/{int(duration)}s",
            })

    cap.release()

    if not any(t for _, t in samples):
        raise RuntimeError("Không đọc được chữ trong vùng quét. Hãy kéo khung cyan sát phụ đề.")

    emit({"type": "progress", "phase": "merge", "progress": 95, "status": "Đang gộp và làm sạch SRT..."})
    srt = build_srt(samples, duration, profile)
    Path(output_path).write_text(srt, encoding="utf-8")
    cleanup_srt_file(output_path, merge_sim=0.88)

    fixed = Path(output_path).read_text(encoding="utf-8")
    return len(re.findall(r"^\d+\s*$", fixed, re.MULTILINE))


def run_ocr(video_path: str, x_min: float, y_min: float, x_max: float, y_max: float, output_srt_path: str, profile_key: str = "accurate") -> None:
    if not check_paddle_ready():
        emit({
            "type": "error",
            "message": (
                "Chưa cài PaddleOCR. Trong terminal chạy:\n"
                "pip install -r python_services/requirements.txt\n"
                "(GPU NVIDIA: pip install paddlepaddle-gpu)"
            ),
        })
        sys.exit(1)

    try:
        count = extract(video_path, x_min, y_min, x_max, y_max, output_srt_path, profile_key)
    except Exception as e:
        emit({"type": "error", "message": f"{type(e).__name__}: {e}"})
        raise

    emit({"type": "progress", "phase": "done", "progress": 100, "status": f"Hoàn tất — {count} dòng phụ đề."})
    emit({"type": "done", "srt_path": output_srt_path, "subtitles_count": count, "ocr_engine": "PaddleOCR"})


if __name__ == "__main__":
    try:
        if len(sys.argv) < 7:
            emit({"type": "error", "message": "Usage: ocr_processor.py video xMin yMin xMax yMax out.srt [profile]"})
            sys.exit(1)
        profile = sys.argv[7] if len(sys.argv) > 7 else "accurate"
        run_ocr(
            sys.argv[1],
            float(sys.argv[2]),
            float(sys.argv[3]),
            float(sys.argv[4]),
            float(sys.argv[5]),
            sys.argv[6],
            profile,
        )
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        sys.exit(1)
