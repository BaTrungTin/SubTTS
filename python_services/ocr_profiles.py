"""Tham số trích xuất — theo hướng timminator/VideOCR (README), không nhúng repo."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class OcrProfile:
    name: str
    ssim_threshold: int
    sim_threshold: int
    conf_threshold: float
    frames_to_skip: int
    max_merge_gap: float
    ocr_max_width: int
    min_subtitle_sec: float


PROFILES: dict[str, OcrProfile] = {
    "accurate": OcrProfile(
        name="Chính xác (khuyên dùng)",
        ssim_threshold=85,
        sim_threshold=72,
        conf_threshold=0.68,
        frames_to_skip=0,
        max_merge_gap=0.18,
        ocr_max_width=960,
        min_subtitle_sec=0.15,
    ),
    "balanced": OcrProfile(
        name="Cân bằng",
        ssim_threshold=88,
        sim_threshold=78,
        conf_threshold=0.72,
        frames_to_skip=1,
        max_merge_gap=0.14,
        ocr_max_width=720,
        min_subtitle_sec=0.2,
    ),
    "fast": OcrProfile(
        name="Nhanh",
        ssim_threshold=92,
        sim_threshold=80,
        conf_threshold=0.75,
        frames_to_skip=2,
        max_merge_gap=0.1,
        ocr_max_width=640,
        min_subtitle_sec=0.25,
    ),
}


def get_profile(key: str | None) -> OcrProfile:
    if key and key in PROFILES:
        return PROFILES[key]
    return PROFILES["accurate"]
