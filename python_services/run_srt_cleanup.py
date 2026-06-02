"""CLI: cleanup SRT in-place. Prints JSON with stats and duplicate pairs."""
from __future__ import annotations

import io
import json
import sys

if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

from srt_cleanup import cleanup_srt_file


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: run_srt_cleanup.py <srt_path> [merge_sim] [max_gap]"}))
        sys.exit(1)
    path = sys.argv[1]
    merge_sim = float(sys.argv[2]) if len(sys.argv) > 2 else 0.78
    max_gap = float(sys.argv[3]) if len(sys.argv) > 3 else 1.2
    before, after, dup_before, dup_after = cleanup_srt_file(
        path, merge_sim=merge_sim, max_merge_gap_sec=max_gap
    )
    print(
        json.dumps(
            {
                "before": before,
                "after": after,
                "merged": before - after,
                "duplicatePairs": dup_before[:250],
                "duplicateCount": len(dup_before),
                "remainingDuplicates": len(dup_after),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
