#!/usr/bin/env python3
"""Export energy price history from Databricks to a static JSON file.

The dashboard on GitHub Pages is a static site, so it cannot hold a Databricks
token. This script runs inside GitHub Actions, queries the Databricks SQL
Statement Execution API with the repository secret token, and writes a compact
snapshot that the browser can read safely.

Usage:
    python scripts/export_dashboard_data.py
    python scripts/export_dashboard_data.py --wait-new-data 300
    python scripts/export_dashboard_data.py --out docs/data/energy.json --window-days 7

Required environment variables:
    DATABRICKS_HOST           Workspace URL, with or without https://
    DATABRICKS_TOKEN          Personal access token (never commit this)
    DATABRICKS_WAREHOUSE_ID   SQL warehouse id

Optional environment variables:
    ENERGY_TABLE              Fully qualified table name
    ENERGY_WINDOW_DAYS        History window, default 30
    ENERGY_MAX_ROWS           Hard row cap, default 20000
    DASHBOARD_OUT             Output path, default docs/data/energy.json
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "docs" / "data" / "energy.json"
DEFAULT_TABLE = "workspace.default.energy_prices_realtime"
SCHEMA_VERSION = 1
USER_AGENT = "energy-realtime-dashboard-export/1.0"

TERMINAL_OK = "SUCCEEDED"
TERMINAL_BAD = {"FAILED", "CANCELED", "CLOSED"}


class ExportError(RuntimeError):
    """Raised when the export cannot produce trustworthy data."""


def log(message: str) -> None:
    stamp = datetime.now(timezone.utc).strftime("%H:%M:%S")
    print(f"[{stamp}] {message}", flush=True)


def env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    if value is None or not value.strip():
        return default
    return value.strip()


def normalize_host(raw: str) -> str:
    host = raw.strip().rstrip("/")
    if not re.match(r"^https?://", host):
        host = "https://" + host
    return host


def quote_identifier(name: str) -> str:
    """Validate and backtick-quote a Unity Catalog table name."""
    if not re.fullmatch(r"[A-Za-z0-9_.\-]+", name):
        raise ExportError(f"Refusing unsafe table identifier: {name!r}")
    return ".".join(f"`{part}`" for part in name.split("."))


def iso_utc(ms: int | None) -> str | None:
    if ms is None:
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class SqlClient:
    """Tiny client for the Databricks SQL Statement Execution API."""

    def __init__(self, host: str, token: str, warehouse_id: str, max_wait: int = 240) -> None:
        self.base = normalize_host(host)
        self.warehouse_id = warehouse_id
        self.max_wait = max_wait
        self.session = requests.Session()
        self.session.headers.update(
            {
                "Authorization": f"Bearer {token}",
                "User-Agent": USER_AGENT,
                "Content-Type": "application/json",
            }
        )

    def query(self, sql: str, label: str = "query") -> tuple[list[dict[str, Any]], dict[str, Any]]:
        started = time.monotonic()
        payload = {
            "statement": sql,
            "warehouse_id": self.warehouse_id,
            "wait_timeout": "50s",
            "on_wait_timeout": "CONTINUE",
            "format": "JSON_ARRAY",
            "disposition": "INLINE",
        }
        body = self._request("POST", "/api/2.0/sql/statements", json=payload, attempts=4)

        statement_id = body.get("statement_id")
        status = (body.get("status") or {}).get("state", "")
        polls = 0
        while status in {"PENDING", "RUNNING"}:
            if time.monotonic() - started > self.max_wait:
                raise ExportError(f"{label} timed out after {self.max_wait}s (state={status})")
            polls += 1
            time.sleep(min(2 + polls, 6))
            body = self._request("GET", f"/api/2.0/sql/statements/{statement_id}", attempts=3)
            status = (body.get("status") or {}).get("state", "")

        if status != TERMINAL_OK:
            error = (body.get("status") or {}).get("error") or {}
            detail = error.get("message") or f"state={status}"
            raise ExportError(f"{label} failed: {detail}")

        manifest = body.get("manifest") or {}
        columns = [col.get("name") for col in (manifest.get("schema") or {}).get("columns", [])]
        result = body.get("result") or {}
        rows = result.get("data_array") or []

        # Large results can be split into external links even with INLINE.
        chunk_error = False
        for chunk in (manifest.get("chunks") or []):
            if chunk.get("chunk_index") == result.get("chunk_index"):
                continue
            link = chunk.get("external_link")
            if not link:
                chunk_error = True
                continue
            extra = self._request("GET", link, attempts=3, absolute=True)
            payload_rows = extra.get("data_array") if isinstance(extra, dict) else extra
            if isinstance(payload_rows, list):
                rows.extend(payload_rows)
            else:
                chunk_error = True

        if chunk_error:
            log(f"warning: {label} returned chunks without links; using partial result")

        records = [dict(zip(columns, row)) for row in rows]
        stats = {
            "rows": len(records),
            "elapsed_ms": int((time.monotonic() - started) * 1000),
            "truncated": bool(manifest.get("truncated")),
            "polls": polls,
        }
        return records, stats

    def _request(
        self,
        method: str,
        path: str,
        *,
        json: Any | None = None,
        attempts: int = 3,
        absolute: bool = False,
    ) -> Any:
        url = path if absolute else self.base + path
        last_error: Exception | None = None
        for attempt in range(1, attempts + 1):
            try:
                response = self.session.request(method, url, json=json, timeout=120)
                if response.status_code in {429, 500, 502, 503, 504}:
                    raise requests.HTTPError(f"HTTP {response.status_code}", response=response)
                if response.status_code >= 400:
                    snippet = response.text[:500].replace("\n", " ")
                    raise ExportError(f"{method} {path} -> HTTP {response.status_code}: {snippet}")
                return response.json()
            except (requests.RequestException, ValueError) as exc:
                last_error = exc
                if attempt == attempts:
                    break
                wait = min(2 ** attempt, 20)
                log(f"retry {attempt}/{attempts - 1} in {wait}s ({exc})")
                time.sleep(wait)
        raise ExportError(f"{method} {path} failed: {last_error}")


def build_history_sql(table: str, window_days: int, limit: int, *, fallback: bool = False) -> str:
    order = "DESC" if fallback else "ASC"
    where = "" if fallback else f"WHERE CAST(timestamp AS TIMESTAMP) >= current_timestamp() - INTERVAL {int(window_days)} DAYS"
    return f"""
SELECT unix_millis(CAST(timestamp AS TIMESTAMP)) AS t_ms,
       zone,
       price,
       source
FROM {table}
{where}
ORDER BY t_ms {order}
LIMIT {int(limit)}
""".strip()


def build_max_sql(table: str) -> str:
    return f"SELECT max(unix_millis(CAST(timestamp AS TIMESTAMP))) AS latest_ms FROM {table}"


def normalize_points(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Cast rows to compact points, drop junk, and dedupe by source + zone + timestamp."""
    by_key: dict[tuple[str, str, int], dict[str, Any]] = {}
    for row in rows:
        try:
            ms = int(row["t_ms"])
            price = float(row["price"])
        except (KeyError, TypeError, ValueError):
            continue
        if not math.isfinite(price):
            continue
        source = str(row.get("source") or "unknown").strip() or "unknown"
        zone = str(row.get("zone") or "unknown").strip() or "unknown"
        by_key[(source, zone, ms)] = {"t": ms, "z": zone, "p": round(price, 4), "s": source}

    points = sorted(by_key.values(), key=lambda point: (point["t"], point["s"], point["z"]))
    return points


def read_existing(path: Path) -> dict[str, Any] | None:
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def latest_from(data: dict[str, Any] | None) -> int:
    if not data:
        return 0
    try:
        return int((data.get("meta") or {}).get("latest_timestamp_ms") or 0)
    except (TypeError, ValueError):
        return 0


def wait_for_new_rows(client: SqlClient, table: str, floor_ms: int, seconds: int) -> int:
    """Wait until the table holds a row newer than the published snapshot."""
    if seconds <= 0 or floor_ms <= 0:
        return 0
    deadline = time.monotonic() + seconds
    attempt = 0
    while time.monotonic() < deadline:
        attempt += 1
        try:
            rows, _ = client.query(build_max_sql(table), label="freshness probe")
            value = rows[0].get("latest_ms") if rows else None
            latest = int(value) if value is not None else 0
            if latest > floor_ms:
                log(f"fresh data detected after {attempt} probe(s): {iso_utc(latest)}")
                return latest
            log(f"waiting for ingest ({attempt}): latest={iso_utc(latest or None)} published={iso_utc(floor_ms)}")
        except ExportError as exc:
            log(f"freshness probe failed: {exc}")
        time.sleep(min(15 + attempt * 5, 45))
    log("warning: no fresh rows before timeout; publishing the latest available snapshot")
    return 0


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    text = json.dumps(data, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    with tmp.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
        handle.write("\n")
    tmp.replace(path)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export Databricks energy prices for the 3D dashboard")
    parser.add_argument("--out", default=env("DASHBOARD_OUT", str(DEFAULT_OUT)))
    parser.add_argument("--table", default=env("ENERGY_TABLE", DEFAULT_TABLE))
    parser.add_argument("--window-days", type=int, default=int(env("ENERGY_WINDOW_DAYS", "30")))
    parser.add_argument("--max-rows", type=int, default=int(env("ENERGY_MAX_ROWS", "20000")))
    parser.add_argument("--host", default=env("DATABRICKS_HOST"))
    parser.add_argument("--token", default=env("DATABRICKS_TOKEN"))
    parser.add_argument("--warehouse-id", default=env("DATABRICKS_WAREHOUSE_ID"))
    parser.add_argument("--max-wait", type=int, default=int(env("ENERGY_MAX_WAIT", "240")))
    parser.add_argument(
        "--wait-new-data",
        type=int,
        default=int(env("ENERGY_WAIT_NEW_DATA", "0")),
        help="Seconds to wait for a row newer than the last published snapshot",
    )
    parser.add_argument("--dry-run", action="store_true", help="Print the snapshot summary without writing")
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

    table = quote_identifier(args.table)
    client = SqlClient(args.host, args.token, args.warehouse_id, max_wait=args.max_wait)

    previous = read_existing(out_path)
    previous_latest = latest_from(previous)
    started_at = time.monotonic()

    try:
        wait_for_new_rows(client, table, previous_latest, args.wait_new_data)

        rows, stats = client.query(
            build_history_sql(table, args.window_days, args.max_rows),
            label="history",
        )
        points = normalize_points(rows)
        fallback_used = False
        if not points:
            log("window returned no rows; falling back to the newest rows in the table")
            rows, stats = client.query(
                build_history_sql(table, args.window_days, args.max_rows, fallback=True),
                label="history fallback",
            )
            points = normalize_points(rows)
            fallback_used = True

        if not points:
            raise ExportError("table returned no usable price rows")

        now = datetime.now(timezone.utc)
        latest_ms = max(point["t"] for point in points)
        first_ms = min(point["t"] for point in points)
        sources = sorted({point["s"] for point in points})
        zones = sorted({point["z"] for point in points})

        snapshot = {
            "schema_version": SCHEMA_VERSION,
            "generated_at": now.isoformat(timespec="seconds").replace("+00:00", "Z"),
            "mode": "live",
            "meta": {
                "table": args.table,
                "warehouse_id": args.warehouse_id,
                "window_days": args.window_days,
                "row_count": len(points),
                "raw_row_count": stats["rows"],
                "max_rows": args.max_rows,
                "truncated": stats["truncated"],
                "fallback": fallback_used,
                "sources": sources,
                "zones": zones,
                "currency": "EUR/MWh",
                "first_timestamp": iso_utc(first_ms),
                "first_timestamp_ms": first_ms,
                "latest_timestamp": iso_utc(latest_ms),
                "latest_timestamp_ms": latest_ms,
                "query_ms": stats["elapsed_ms"],
                "publish_ms": int((time.monotonic() - started_at) * 1000),
            },
            "points": points,
        }

        if args.dry_run:
            log("dry run: snapshot built but not written")
        else:
            write_json(out_path, snapshot)
            log(f"wrote {out_path} ({out_path.stat().st_size / 1024:.1f} KiB)")

        log(
            "rows={rows} sources={sources} zones={zones} latest={latest} window={days}d fallback={fallback}".format(
                rows=len(points),
                sources=",".join(sources),
                zones=",".join(zones),
                latest=snapshot["meta"]["latest_timestamp"],
                days=args.window_days,
                fallback=fallback_used,
            )
        )
        if stats["truncated"]:
            log(f"warning: query hit the {args.max_rows} row cap; narrow the window for full history")
        age_min = (now.timestamp() * 1000 - latest_ms) / 60000
        if age_min > 120:
            log(f"warning: newest row is {age_min:.0f} min old; check the ingest job")
        return 0
    except ExportError as exc:
        log(f"error: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
