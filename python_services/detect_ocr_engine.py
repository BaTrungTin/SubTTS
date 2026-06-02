"""In JSON trạng thái engine OCR (dùng bởi server /api/health)."""
from __future__ import annotations

import io
import json
import sys


def _configure_stdio_utf8() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def main() -> None:
    _configure_stdio_utf8()
    info: dict = {
        "pythonVersion": sys.version.split()[0],
        "pythonExecutable": sys.executable,
        "paddleOk": False,
        "easyocrOk": False,
        "engine": "none",
        "message": "",
    }

    try:
        import importlib.util

        if importlib.util.find_spec("paddle") and importlib.util.find_spec("paddleocr"):
            info["paddleOk"] = True
            info["engine"] = "paddle"
            info["message"] = "PaddleOCR + paddlepaddle — độ chính xác cao (khuyên dùng)."
        else:
            raise ImportError("Thiếu paddle hoặc paddleocr")
    except Exception as e:
        info["paddleError"] = str(e)

    try:
        import easyocr  # noqa: F401

        info["easyocrOk"] = True
        if info["engine"] == "none":
            info["engine"] = "easyocr"
            info["message"] = (
                "EasyOCR (fallback). Để gần file chuẩn hơn: cài Python 3.12 + PaddleOCR "
                "(scripts\\setup-paddleocr.ps1)."
            )
    except Exception as e:
        info["easyocrError"] = str(e)

    if info["engine"] == "none":
        info["message"] = "Chưa cài OCR. Chạy scripts\\setup-ocr.ps1 hoặc setup-paddleocr.ps1."

    print(json.dumps(info, ensure_ascii=False))


if __name__ == "__main__":
    main()
