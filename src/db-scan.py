#!/usr/bin/env python3
"""Read-only aggregate concurrency scan for Codex thread_history SQLite files."""
import argparse
import json
import os
import sqlite3
import sys
from urllib.parse import quote


def fail(message):
    sys.stderr.write("db-scan: " + message + "\n")
    raise SystemExit(1)


def merge_by_thread(rows, since_ms, until_ms):
    grouped = {}
    complete = 0
    for thread_id, started_s, completed_s in rows:
        if started_s is None or completed_s is None:
            continue
        start = int(float(started_s) * 1000)
        end = int(float(completed_s) * 1000)
        if end < start:
            continue
        complete += 1
        start, end = max(start, since_ms), min(end, until_ms)
        if end < start:
            continue
        grouped.setdefault(thread_id, []).append((start, end))
    merged = []
    for intervals in grouped.values():
        intervals.sort()
        current_start, current_end = intervals[0]
        for start, end in intervals[1:]:
            if start <= current_end:
                current_end = max(current_end, end)
            else:
                merged.append((current_start, current_end))
                current_start, current_end = start, end
        merged.append((current_start, current_end))
    return complete, grouped, merged


def scan(db_path, since_ms, until_ms):
    if since_ms > until_ms:
        fail("--since-ms must be no later than --until-ms")
    absolute = os.path.abspath(db_path)
    if not os.path.isfile(absolute):
        fail("database file does not exist: " + absolute)
    uri = "file:" + quote(absolute) + "?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True)
    except sqlite3.Error as exc:
        fail("cannot open database read-only: " + str(exc))
    try:
        conn.execute("BEGIN")
        found = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread_turns'").fetchone()
        if not found:
            fail("required table thread_turns is missing")
        cols = {row[1] for row in conn.execute("PRAGMA table_info(thread_turns)")}
        needed = {"thread_id", "turn_id", "started_at", "completed_at"}
        if not needed.issubset(cols):
            fail("thread_turns is missing required columns: " + ", ".join(sorted(needed - cols)))
        # SQLite stores timestamps as epoch seconds. Bind seconds to let its index remain usable.
        rows = conn.execute(
            "SELECT thread_id, started_at, completed_at FROM thread_turns "
            "WHERE started_at IS NOT NULL AND completed_at IS NOT NULL "
            "AND started_at <= ? AND completed_at >= ?",
            (until_ms / 1000, since_ms / 1000),
        ).fetchall()
        complete, grouped, merged = merge_by_thread(rows, since_ms, until_ms)
    except sqlite3.Error as exc:
        fail("read failed: " + str(exc))
    finally:
        conn.close()
    points = []
    for start, end in merged:
        points.append((start, 1))
        points.append((end, -1))
    # End events sort first at the same millisecond, so touching threads do not overlap.
    points.sort(key=lambda point: (point[0], point[1]))
    active = peak = 0
    peak_at = None
    for when, delta in points:
        active += delta
        if active > peak:
            peak = active
            peak_at = when
    return {
        "source": "sqlite-projection",
        "range": {"sinceMs": since_ms, "untilMs": until_ms},
        "completeIntervals": complete,
        "sessions": len(grouped),
        "peak": peak,
        "peakAt": peak_at,
        "coverage": "Projection from completed thread_turns only; it is not a complete reconstruction of all Codex history or shell activity.",
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="Read-only Codex SQLite concurrency projection")
    parser.add_argument("--path", required=True)
    parser.add_argument("--since-ms", required=True, type=int)
    parser.add_argument("--until-ms", required=True, type=int)
    args = parser.parse_args(argv)
    print(json.dumps(scan(args.path, args.since_ms, args.until_ms), separators=(",", ":")))


if __name__ == "__main__":
    main()
