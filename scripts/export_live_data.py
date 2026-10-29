#!/usr/bin/env python3
"""Export a small, fast-moving slice of the Databricks table for the live lane.

The full snapshot exporter (`export_dashboard_data.py`) publishes a 30-day
window twice an hour, which is the right shape for history and the date picker.
This script is the other half: a few hundred recent readings, written every few
minutes by `.github/workflows/live_feed.yml` and polled by the dashboard.

The output is deliberately tiny so the page can refresh it often:

    {
      "schema_version": 1,
      "generated_at": "2026-10-29T04:55:12Z",
      "mode": "live",
      "transport": "github-actions",
      "window_minutes": 360,
      "points": [{"t": 1793207700000, "z": "NSW1", "p": 78.326, "s": "aemo"}],
      "meta": {"row_count": 215, "latest_timestamp_ms": 1793207700000}
    }

Usage:
    python scripts/export_live_data.py
    python scripts/export_live_data.py --window-minutes 120 --max-rows 600
    python scripts/export_live_data.py --dry-run

Required environment variables:
    DATABRICKS_HOST
    DATABRICKS_TOKEN
    DATABRICKS_WAREHOUSE_ID
"""

from __future__ import annotations

import argparse
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

try:
    from export_dashboard_data import (  # type: ignore[import-not-found]
        DEFAULT_TABLE,
        ExportError,
        SqlClient,
        env,
        iso_utc,
        log,
        normalize_points,
        quote_identifier,
        write_json,
    )
except ModuleNotFoundError:  # Running from the repository root.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from export_dashboard_data import (  # type: ignore[no-redef]
        DEFAULT_TABLE,
        ExportError,
        SqlClient,
        env,
        iso_utc,
        log,
        normalize_points,
        quote_identifier,
        write_json,
    )

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "docs" / "data" / "live.json"
SCHEMA_VERSION = 1


def build_live_sql(table: str, window_minutes: int, limit: int) -> str:
    return f"""
SELECT unix_millis(CAST(timestamp AS TIMESTAMP)) AS t_ms,
       zone,
       price,
       source
FROM {table}
WHERE CAST(timestamp AS TIMESTAMP) >= current_timestamp() - INTERVAL {int(window_minutes)} MINUTES
ORDER BY t_ms ASC
LIMIT {int(limit)}
""".strip()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export the newest Databricks readings for the live lane")
    parser.add_argument("--out", default=env("LIVE_OUT", str(DEFAULT_OUT)))
    parser.add_argument("--table", default=env("ENERGY_TABLE", DEFAULT_TABLE))
    parser.add_argument("--window-minutes", type=int, default=int(env("LIVE_WINDOW_MINUTES", "360")))
    parser.add_argument("--max-rows", type=int, default=int(env("LIVE_MAX_ROWS", "2000")))
    parser.add_argument("--host", default=env("DATABRICKS_HOST"))
    parser.add_argument("--token", default=env("DATABRICKS_TOKEN"))
    parser.add_argument("--warehouse-id", default=env("DATABRICKS_WAREHOUSE_ID"))
    parser.add_argument("--max-wait", type=int, default=int(env("LIVE_MAX_WAIT", "60")))
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    missing = [
        name
        for name, value in (
            ("DATABRICKS_HOST", args.host),
            ("DATABRICKS_TOKEN", args.token),
            ("DATABRICKS_WAREHOUSE_ID", args.warehouse_id),
        )
        if not value
    ]
    if missing:
        log(f"error: missing required configuration: {', '.join(missing)}")
        return 2
    if args.window_minutes <= 0 or args.max_rows <= 0:
        log("error: window-minutes and max-rows must be positive")
        return 2

    out_path = Path(args.out)
    if not out_path.is_absolute():
        out_path = ROOT / out_path

    try:
        table = quote_identifier(args.table)
        client = SqlClient(args.host, args.token, args.warehouse_id, max_wait=args.max_wait)
        rows, stats = client.query(
            build_live_sql(table, args.window_minutes, args.max_rows),
            label="live",
        )
        points = normalize_points(rows)
        if not points:
            raise ExportError("live window returned no usable price rows")

        latest_ms = max(point["t"] for point in points)
        first_ms = min(point["t"] for point in points)
        now = datetime.now(UTC)
        payload: dict[str, Any] = {
            "schema_version": SCHEMA_VERSION,
            "generated_at": now.isoformat(timespec="seconds").replace("+00:00", "Z"),
            "mode": "live",
            "transport": "github-actions",
            "window_minutes": args.window_minutes,
            "points": points,
            "meta": {
                "source": "databricks",
                "table": args.table,
                "warehouse_id": args.warehouse_id,
                "row_count": len(points),
                "raw_row_count": stats["rows"],
                "max_rows": args.max_rows,
                "truncated": stats["truncated"],
                "first_timestamp": iso_utc(first_ms),
                "first_timestamp_ms": first_ms,
                "latest_timestamp": iso_utc(latest_ms),
                "latest_timestamp_ms": latest_ms,
                "query_ms": stats["elapsed_ms"],
            },
        }

        if args.dry_run:
            log("dry run: live payload built but not written")
        else:
            write_json(out_path, payload)
            log(f"wrote {out_path} ({out_path.stat().st_size / 1024:.1f} KiB)")

        age_min = (now.timestamp() * 1000 - latest_ms) / 60000
        log(
            f"rows={len(points)} latest={iso_utc(latest_ms)} "
            f"age={age_min:.0f}m window={args.window_minutes}m"
        )
        if stats["truncated"]:
            log(f"warning: query hit the {args.max_rows} row cap")
        return 0
    except ExportError as exc:
        log(f"error: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
