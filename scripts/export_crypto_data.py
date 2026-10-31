#!/usr/bin/env python3
"""Export CoinGecko crypto market data from Databricks to a static JSON file.

The 3D crypto dashboard on GitHub Pages cannot hold a Databricks token. This
script runs inside GitHub Actions, queries the Delta table written by
``src/crypto_ingest.ipynb`` through the Databricks SQL Statement API, and writes
one compact snapshot that the browser can read safely.

Output (`docs/data/crypto.json`):

    {
      "schema_version": 1,
      "generated_at": "2026-10-31T06:00:00Z",
      "mode": "live",
      "meta": {...},
      "coins": [{"id": "bitcoin", "symbol": "BTC", "price": 109000.0, ...}],
      "history": {"bitcoin": [[t_ms, price, market_cap, volume_24h, change_24h], ...]}
    }

Usage:
    python scripts/export_crypto_data.py
    python scripts/export_crypto_data.py --window-days 7 --max-rows 20000
    python scripts/export_crypto_data.py --dry-run

Required environment variables:
    DATABRICKS_HOST
    DATABRICKS_TOKEN
    DATABRICKS_WAREHOUSE_ID

Optional environment variables:
    CRYPTO_TABLE              Fully qualified Delta table name
    CRYPTO_WINDOW_DAYS        History window, default 7
    CRYPTO_MAX_ROWS           History row cap, default 20000
    CRYPTO_OUT                Output path, default docs/data/crypto.json
"""

from __future__ import annotations

import argparse
import math
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

try:
    from export_dashboard_data import (  # type: ignore[import-not-found]
        ExportError,
        SqlClient,
        env,
        iso_utc,
        log,
        quote_identifier,
        write_json,
    )
except ModuleNotFoundError:  # Running from the repository root.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from export_dashboard_data import (  # type: ignore[no-redef]
        ExportError,
        SqlClient,
        env,
        iso_utc,
        log,
        quote_identifier,
        write_json,
    )

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "docs" / "data" / "crypto.json"
DEFAULT_TABLE = "workspace.default.crypto_market_realtime"
DEFAULT_TOPIC = "crypto-market"
SCHEMA_VERSION = 1


def build_latest_sql(table: str, window_days: int, *, fallback: bool = False) -> str:
    where = (
        ""
        if fallback
        else f"WHERE CAST(timestamp AS TIMESTAMP) >= current_timestamp() - INTERVAL {int(window_days)} DAYS"
    )
    return f"""
WITH ranked AS (
  SELECT *, row_number() OVER (PARTITION BY coin_id ORDER BY CAST(timestamp AS TIMESTAMP) DESC) AS rn
  FROM {table}
  {where}
)
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
FROM ranked
WHERE rn = 1
ORDER BY market_rank ASC NULLS LAST, market_cap DESC
LIMIT 200
""".strip()


def build_history_sql(table: str, window_days: int, limit: int) -> str:
    return f"""
SELECT unix_millis(CAST(timestamp AS TIMESTAMP)) AS t_ms,
       coin_id,
       price,
       market_cap,
       volume_24h,
       change_24h
FROM {table}
WHERE CAST(timestamp AS TIMESTAMP) >= current_timestamp() - INTERVAL {int(window_days)} DAYS
ORDER BY t_ms ASC
LIMIT {int(limit)}
""".strip()


def number(value: Any, default: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if math.isfinite(parsed) else default


def integer(value: Any, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def normalize_coins(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Cast latest-per-coin rows to compact, finite dashboard records."""
    coins: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        coin_id = str(row.get("coin_id") or "").strip().lower()
        if not coin_id or coin_id in seen:
            continue
        seen.add(coin_id)
        timestamp = row.get("t_ms")
        coins.append(
            {
                "id": coin_id,
                "symbol": str(row.get("symbol") or "").upper(),
                "name": str(row.get("name") or coin_id.title()),
                "price": round(number(row.get("price")), 10),
                "market_cap": round(number(row.get("market_cap")), 2),
                "volume_24h": round(number(row.get("volume_24h")), 2),
                "change_24h": round(number(row.get("change_24h")), 6),
                "market_rank": integer(row.get("market_rank")),
                "trending": integer(row.get("trending")),
                "trending_rank": integer(row.get("trending_rank")),
                "t": integer(timestamp, 0),
            }
        )
    return coins


def normalize_history(rows: list[dict[str, Any]]) -> dict[str, list[list[Any]]]:
    """Group history into compact `[t, price, market_cap, volume, change]` rows."""
    by_coin: dict[str, dict[int, list[Any]]] = {}
    for row in rows:
        coin_id = str(row.get("coin_id") or "").strip().lower()
        timestamp = integer(row.get("t_ms"), 0)
        if not coin_id or timestamp <= 0:
            continue
        by_coin.setdefault(coin_id, {})[timestamp] = [
            timestamp,
            round(number(row.get("price")), 10),
            round(number(row.get("market_cap")), 2),
            round(number(row.get("volume_24h")), 2),
            round(number(row.get("change_24h")), 6),
        ]
    return {coin_id: [points[ts] for ts in sorted(points)] for coin_id, points in sorted(by_coin.items())}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export Databricks crypto market data for the 3D dashboard")
    parser.add_argument("--out", default=env("CRYPTO_OUT", str(DEFAULT_OUT)))
    parser.add_argument("--table", default=env("CRYPTO_TABLE", DEFAULT_TABLE))
    parser.add_argument("--window-days", type=int, default=int(env("CRYPTO_WINDOW_DAYS", "7")))
    parser.add_argument("--max-rows", type=int, default=int(env("CRYPTO_MAX_ROWS", "20000")))
    parser.add_argument("--host", default=env("DATABRICKS_HOST"))
    parser.add_argument("--token", default=env("DATABRICKS_TOKEN"))
    parser.add_argument("--warehouse-id", default=env("DATABRICKS_WAREHOUSE_ID"))
    parser.add_argument("--max-wait", type=int, default=int(env("CRYPTO_MAX_WAIT", "240")))
    parser.add_argument("--dry-run", action="store_true", help="Build the snapshot without writing")
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
    if args.window_days <= 0 or args.max_rows <= 0:
        log("error: window-days and max-rows must be positive")
        return 2

    out_path = Path(args.out)
    if not out_path.is_absolute():
        out_path = ROOT / out_path

    started_at = datetime.now(UTC)
    try:
        table = quote_identifier(args.table)
        client = SqlClient(args.host, args.token, args.warehouse_id, max_wait=args.max_wait)

        latest_rows, latest_stats = client.query(build_latest_sql(table, args.window_days), label="crypto latest")
        fallback = False
        if not latest_rows:
            log("crypto window returned no rows; falling back to the newest rows in the table")
            latest_rows, latest_stats = client.query(
                build_latest_sql(table, args.window_days, fallback=True),
                label="crypto latest fallback",
            )
            fallback = True
        coins = normalize_coins(latest_rows)
        if not coins:
            raise ExportError("crypto table returned no usable coin rows")

        history_rows, history_stats = client.query(
            build_history_sql(table, args.window_days, args.max_rows),
            label="crypto history",
        )
        history = normalize_history(history_rows)
        if not history:
            latest_ms = max(coin["t"] for coin in coins)
            history = {
                coin["id"]: [[latest_ms, coin["price"], coin["market_cap"], coin["volume_24h"], coin["change_24h"]]]
                for coin in coins
            }

        latest_ms = max(
            [coin["t"] for coin in coins if coin["t"] > 0]
            + [points[-1][0] for points in history.values() if points]
        )
        first_ms = min(
            [point[0] for points in history.values() for point in points[:1]]
            + [latest_ms]
        )
        tracked = [coin for coin in coins if coin["id"] in history]
        total_market_cap = sum(coin["market_cap"] for coin in coins)
        total_volume = sum(coin["volume_24h"] for coin in coins)

        snapshot: dict[str, Any] = {
            "schema_version": SCHEMA_VERSION,
            "generated_at": datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "mode": "live",
            "meta": {
                "source": "coingecko",
                "topic": DEFAULT_TOPIC,
                "table": args.table,
                "warehouse_id": args.warehouse_id,
                "window_days": args.window_days,
                "coin_count": len(coins),
                "tracked_coin_count": len(tracked),
                "row_count": sum(len(points) for points in history.values()),
                "raw_row_count": latest_stats["rows"] + history_stats["rows"],
                "max_rows": args.max_rows,
                "truncated": history_stats["truncated"],
                "fallback": fallback,
                "currency": "USD",
                "total_market_cap": round(total_market_cap, 2),
                "total_volume_24h": round(total_volume, 2),
                "first_timestamp": iso_utc(first_ms),
                "first_timestamp_ms": first_ms,
                "latest_timestamp": iso_utc(latest_ms),
                "latest_timestamp_ms": latest_ms,
                "query_ms": latest_stats["elapsed_ms"] + history_stats["elapsed_ms"],
                "publish_ms": int((datetime.now(UTC) - started_at).total_seconds() * 1000),
            },
            "coins": coins,
            "history": history,
        }

        if args.dry_run:
            log("dry run: crypto snapshot built but not written")
        else:
            write_json(out_path, snapshot)
            log(f"wrote {out_path} ({out_path.stat().st_size / 1024:.1f} KiB)")

        age_min = (datetime.now(UTC).timestamp() * 1000 - latest_ms) / 60000
        log(
            f"coins={len(coins)} history_rows={snapshot['meta']['row_count']} "
            f"latest={iso_utc(latest_ms)} age={age_min:.0f}m fallback={fallback}"
        )
        if history_stats["truncated"]:
            log(f"warning: history hit the {args.max_rows} row cap")
        return 0
    except ExportError as exc:
        log(f"error: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
