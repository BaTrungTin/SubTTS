"""Tham số trích xuất — cân bằng tốc độ / số dòng / độ chính xác."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class OcrProfile:
    name: str
    scan_fps: float
    ssim_threshold: int
    sim_threshold: int
    conf_threshold: float
    frames_to_skip: int
    ocr_max_width: int
    min_subtitle_sec: float
    force_ocr_interval_sec: float
    min_ocr_interval_sec: float
    max_cue_duration_sec: float
    empty_flush_count: int
    merge_sim: float
    merge_gap_sec: float
    max_video_height: int


PROFILES: dict[str, OcrProfile] = {
    "accurate": OcrProfile(
        name="Chính xác (khuyên dùng)",
        scan_fps=6.0,
        ssim_threshold=88,
        sim_threshold=85,
        conf_threshold=0.32,
        frames_to_skip=1,
        ocr_max_width=800,
        min_subtitle_sec=0.35,
        force_ocr_interval_sec=0.65,
        min_ocr_interval_sec=0.42,
        max_cue_duration_sec=5.5,
        empty_flush_count=2,
        merge_sim=0.82,
        merge_gap_sec=1.2,
        max_video_height=720,
    ),
    "balanced": OcrProfile(
        name="Cân bằng",
        scan_fps=5.0,
        ssim_threshold=90,
        sim_threshold=90,
        conf_threshold=0.38,
        frames_to_skip=1,
        ocr_max_width=720,
        min_subtitle_sec=0.12,
        force_ocr_interval_sec=0.85,
        min_ocr_interval_sec=0.55,
        max_cue_duration_sec=7.0,
        empty_flush_count=2,
        merge_sim=0.88,
        merge_gap_sec=0.8,
        max_video_height=720,
    ),
    "fast": OcrProfile(
        name="Nhanh",
        scan_fps=4.0,
        ssim_threshold=92,
        sim_threshold=88,
        conf_threshold=0.45,
        frames_to_skip=2,
        ocr_max_width=640,
        min_subtitle_sec=0.15,
        force_ocr_interval_sec=1.1,
        min_ocr_interval_sec=0.7,
        max_cue_duration_sec=8.0,
        empty_flush_count=3,
        merge_sim=0.86,
        merge_gap_sec=0.6,
        max_video_height=720,
    ),
}


def get_profile(key: str | None) -> OcrProfile:
    if key and key in PROFILES:
        return PROFILES[key]
    return PROFILES["accurate"]
