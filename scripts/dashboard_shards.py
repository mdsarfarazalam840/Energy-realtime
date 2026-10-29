#!/usr/bin/env python3
"""Split a VoltScope snapshot into UTC-day shards plus a small index.

The dashboard used to download the whole snapshot on every visit. At production
volume (80k rows, 30 days) that is a slow first paint and wasted egress for the
majority of visitors, who look at one or two days. This module publishes:

    data/index.json          small manifest: days, row counts, time bounds
    data/days/YYYY-MM-DD.json  one immutable file per UTC day

The browser reads the index, then fetches only the day files for the selected
date range. Past day files never change, so the CDN can cache them for a long
time; only the newest day is revalidated.

Day files use a compact representation to keep the payload small: zone and
source names are interned once, and each row is `[t, zone_index, price,
source_index]`.

Usage:
    python scripts/dashboard_shards.py docs/data/energy.json --out docs/data
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

SHARD_SCHEMA_VERSION = 1


class ShardError(RuntimeError):
    """Raised when a snapshot cannot be sharded safely."""


def day_key(ms: int) -> str:
    """UTC calendar day for an epoch-millisecond timestamp."""
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


def _compact_json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def _iso_utc(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def build_shards(snapshot: dict[str, Any]) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    """Return `(index, day_documents)` for a snapshot document."""
    points = snapshot.get("points")
    if not isinstance(points, list):
        raise ShardError("snapshot has no points array")

    sources: set[str] = set()
    zones: set[str] = set()
    for point in points:
        if not isinstance(point, dict):
            continue
        sources.add(str(point.get("s") or "unknown"))
        zones.add(str(point.get("z") or "unknown"))

    source_ids = sorted(sources)
    zone_ids = sorted(zones)
    source_index = {value: index for index, value in enumerate(source_ids)}
    zone_index = {value: index for index, value in enumerate(zone_ids)}

    grouped: dict[str, list[list[Any]]] = {}
    for point in points:
        if not isinstance(point, dict):
            continue
        try:
            t = int(point["t"])
            price = float(point["p"])
        except (KeyError, TypeError, ValueError):
            continue
        source = str(point.get("s") or "unknown")
        zone = str(point.get("z") or "unknown")
        grouped.setdefault(day_key(t), []).append([t, zone_index[zone], round(price, 4), source_index[source]])

    days: list[dict[str, Any]] = []
    documents: dict[str, dict[str, Any]] = {}
    for date in sorted(grouped):
        rows = sorted(grouped[date], key=lambda row: (row[0], row[3], row[1]))
        document = {
            "date": date,
            "schema_version": SHARD_SCHEMA_VERSION,
            "sources": source_ids,
            "zones": zone_ids,
            "rows": rows,
        }
        documents[date] = document
        days.append(
            {
                "date": date,
                "file": f"days/{date}.json",
                "rows": len(rows),
                "first_ms": rows[0][0],
                "last_ms": rows[-1][0],
                "bytes": len(_compact_json(document).encode("utf-8")),
            }
        )

    if not days:
        raise ShardError("snapshot produced no usable days")

    meta = dict(snapshot.get("meta") or {})
    meta["row_count"] = sum(day["rows"] for day in days)
    meta["day_count"] = len(days)
    meta["sharded"] = True
    meta["first_timestamp_ms"] = days[0]["first_ms"]
    meta["latest_timestamp_ms"] = days[-1]["last_ms"]

    index = {
        "schema_version": 2,
        "generated_at": snapshot.get("generated_at") or datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "mode": snapshot.get("mode") or "live",
        "meta": meta,
        "days": days,
    }
    return index, documents


def write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = _compact_json(value)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
        handle.write("\n")
    os.replace(tmp, path)


def write_shards(
    data_dir: Path,
    snapshot: dict[str, Any],
    *,
    keep_days: Iterable[str] | None = None,
) -> dict[str, Any]:
    """Write `index.json` and `days/*.json` under `data_dir`.

    `keep_days` limits the published history (default: every day in the
    snapshot). Day files no longer referenced by the index are removed so the
    repository does not grow forever as the window rolls forward.
    """
    index, documents = build_shards(snapshot)
    if keep_days is not None:
        keep = set(keep_days)
        index["days"] = [day for day in index["days"] if day["date"] in keep]
        documents = {date: doc for date, doc in documents.items() if date in keep}
        if not index["days"]:
            raise ShardError("keep_days removed every day")
        index["meta"]["row_count"] = sum(day["rows"] for day in index["days"])
        index["meta"]["day_count"] = len(index["days"])
        index["meta"]["first_timestamp_ms"] = index["days"][0]["first_ms"]
        index["meta"]["latest_timestamp_ms"] = index["days"][-1]["last_ms"]
        index["meta"]["first_timestamp"] = _iso_utc(index["days"][0]["first_ms"])
        index["meta"]["latest_timestamp"] = _iso_utc(index["days"][-1]["last_ms"])

    days_dir = data_dir / "days"
    for date, document in documents.items():
        write_json_atomic(days_dir / f"{date}.json", document)

    wanted = {f"{date}.json" for date in documents}
    if days_dir.is_dir():
        for existing in days_dir.glob("*.json"):
            if existing.name not in wanted:
                existing.unlink()

    write_json_atomic(data_dir / "index.json", index)
    return index


def load_snapshot(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ShardError(f"{path} is not a JSON object")
    return data


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Split a VoltScope snapshot into UTC-day shards")
    parser.add_argument("snapshot", type=Path, help="snapshot JSON file (energy.json format)")
    parser.add_argument("--out", type=Path, default=None, help="data directory (default: snapshot folder)")
    parser.add_argument("--keep-days", type=int, default=0, help="publish only the newest N days (0 = all)")
    args = parser.parse_args(argv)

    try:
        snapshot = load_snapshot(args.snapshot)
        data_dir = args.out or args.snapshot.parent
        keep: Iterable[str] | None = None
        if args.keep_days > 0:
            by_day = sorted({day_key(int(point["t"])) for point in snapshot.get("points", []) if "t" in point})
            keep = by_day[-args.keep_days :]
        index = write_shards(data_dir, snapshot, keep_days=keep)
    except (OSError, ValueError, ShardError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    total = sum(day["bytes"] for day in index["days"])
    print(
        f"{data_dir}: {index['meta']['row_count']} rows in {len(index['days'])} day shards "
        f"({total / 1024:.1f} KiB)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
