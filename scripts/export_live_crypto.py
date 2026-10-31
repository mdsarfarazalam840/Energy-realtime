#!/usr/bin/env python3
"""Export a small, fast-moving slice of the Databricks crypto table for the live lane.

The full crypto snapshot exporter (`export_crypto_data.py`) publishes a 7-day
window, which is the right shape for history. This script is the other half:
the newest crypto readings, written on a fast schedule by
`.github/workflows/crypto_live.yml` and polled by the crypto dashboard.

Output (`docs/data/live-crypto.json`):

    {
      "schema_version": 1,
      "generated_at": "2026-10-31T12:00:00Z",
      "mode": "live",
      "transport": "github-actions",
      "window_minutes": 360,
      "coins": [{"id": "bitcoin", "symbol": "BTC", "price": 109000.0, ...}],
      "meta": {"row_count": 15, "latest_timestamp_ms": 1777675200000}
    }

Usage:
    python scripts/export_live_crypto.py
    python scripts/export_live_crypto.py --window-minutes 120 --max-rows 500
    python scripts/export_live_crypto.py --dry-run

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
    from export_crypto_data import (  # type: ignore[import-not-found]
        ExportError,
        SqlClient,
        env,
        iso_utc,
        log,
        normalize_coins,
        quote_identifier,
        write_json,
    )
except ModuleNotFoundError:  # Running from the repository root.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from export_crypto_data import (  # type: ignore[no-redef]
        ExportError,
        SqlClient,
        env,
        iso_utc,
        log,
        normalize_coins,
        quote_identifier,
        write_json,
    )

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "docs" / "data" / "live-crypto.json"
DEFAULT_TABLE = "workspace.default.crypto_market_realtime"
SCHEMA_VERSION = 1


def build_live_sql(table: str, window_minutes: int, limit: int) -> str:
    return f"""
SELECT coin_id,
       symbol,
       name,
       price,
       market_cap,
       volume_24h,
       change_24h,
       market_rank,
       trending,
       trending_rank,
       unix_millis(CAST(timestamp AS TIMESTAMP)) AS t_ms
FROM {table}
WHERE CAST(timestamp AS TIMESTAMP) >= current_timestamp() - INTERVAL {int(window_minutes)} MINUTES
ORDER BY t_ms DESC
LIMIT {int(limit)}
""".strip()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export the newest Databricks crypto readings for the live lane")
    parser.add_argument("--out", default=env("CRYPTO_LIVE_OUT", str(DEFAULT_OUT)))
    parser.add_argument("--table", default=env("CRYPTO_TABLE", DEFAULT_TABLE))
    parser.add_argument("--window-minutes", type=int, default=int(env("CRYPTO_LIVE_WINDOW_MINUTES", "360")))
    parser.add_argument("--max-rows", type=int, default=int(env("CRYPTO_LIVE_MAX_ROWS", "500")))
    parser.add_argument("--host", default=env("DATABRICKS_HOST"))
    parser.add_argument("--token", default=env("DATABRICKS_TOKEN"))
    parser.add_argument("--warehouse-id", default=env("DATABRICKS_WAREHOUSE_ID"))
    parser.add_argument("--max-wait", type=int, default=int(env("CRYPTO_LIVE_MAX_WAIT", "60")))
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

    started_at = datetime.now(UTC)
    try:
        table = quote_identifier(args.table)
        client = SqlClient(args.host, args.token, args.warehouse_id, max_wait=args.max_wait)
        rows, stats = client.query(
            build_live_sql(table, args.window_minutes, args.max_rows),
            label="crypto live",
        )
        coins = normalize_coins(rows)
        if not coins:
            raise ExportError("crypto live window returned no usable coin rows")

        latest_ms = max(coin["t"] for coin in coins)
        first_ms = min(coin["t"] for coin in coins)
        now = datetime.now(UTC)
        payload: dict[str, Any] = {
            "schema_version": SCHEMA_VERSION,
            "generated_at": now.isoformat(timespec="seconds").replace("+00:00", "Z"),
            "mode": "live",
            "transport": "github-actions",
            "window_minutes": args.window_minutes,
            "coins": coins,
            "meta": {
                "source": "coingecko",
                "table": args.table,
                "warehouse_id": args.warehouse_id,
                "coin_count": len(coins),
                "row_count": len(coins),
                "raw_row_count": stats["rows"],
                "max_rows": args.max_rows,
                "truncated": stats["truncated"],
                "first_timestamp": iso_utc(first_ms),
                "first_timestamp_ms": first_ms,
                "latest_timestamp": iso_utc(latest_ms),
                "latest_timestamp_ms": latest_ms,
                "query_ms": stats["elapsed_ms"],
                "publish_ms": int((now - started_at).total_seconds() * 1000),
            },
        }

        if args.dry_run:
            log("dry run: crypto live payload built but not written")
        else:
            write_json(out_path, payload)
            log(f"wrote {out_path} ({out_path.stat().st_size / 1024:.1f} KiB)")

        age_min = (now.timestamp() * 1000 - latest_ms) / 60000
        log(f"coins={len(coins)} latest={iso_utc(latest_ms)} age={age_min:.0f}m window={args.window_minutes}m")
        if stats["truncated"]:
            log(f"warning: query hit the {args.max_rows} row cap")
        return 0
    except ExportError as exc:
        log(f"error: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
