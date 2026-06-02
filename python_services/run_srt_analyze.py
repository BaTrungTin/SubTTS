"""CLI: analyze SRT duplicates without modifying file."""
from __future__ import annotations

import io
import json
import sys
from pathlib import Path

if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

from srt_cleanup import _parse_srt, _ts_to_sec, find_duplicate_pairs


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: run_srt_analyze.py <srt_path>"}))
        sys.exit(1)
    entries = _parse_srt(Path(sys.argv[1]).read_text(encoding="utf-8"))
    cues = [
        {"start": _ts_to_sec(e["start"]), "end": _ts_to_sec(e["end"]), "text": e["text"]}
        for e in entries
    ]
    pairs = find_duplicate_pairs(cues)
    print(
        json.dumps(
            {
                "lineCount": len(cues),
                "duplicatePairs": pairs[:250],
                "duplicateCount": len(pairs),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
