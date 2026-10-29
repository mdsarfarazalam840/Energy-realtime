"""Generate synthetic VoltScope snapshots at production scale.

Used by the load and UI tests so the dashboard is measured against a full
80k-row, 48-zone snapshot rather than the small published contract sample.

    python tests/load/generate_snapshot.py --zones 49 --points 80000 --out tests/load/data/energy-80k.json
"""

from __future__ import annotations

import argparse
import json
import math
import random
import time
from pathlib import Path

ZONES = [
    "DE_LU", "NL", "BE", "AT", "FR", "PL", "CH", "CZ", "SK", "HU", "SI", "ES", "PT",
    "SE1", "SE2", "SE3", "SE4", "NO1", "NO2", "NO3", "NO4", "NO5", "DK1", "DK2", "FI",
    "EE", "LV", "LT", "HR", "RO", "BG", "GR", "RS", "BA", "ME", "MK", "AL", "XK", "MD",
    "UA", "IE_SEM", "IT_NORD", "IT_CNOR", "IT_CSUD", "IT_SUD", "IT_SICI", "IT_SARD", "IT_CALA",
]


def build(zones: int, points: int, window_days: int, seed: int = 77) -> dict:
    """Spread `points` readings across `zones` lanes over the last window."""
    rng = random.Random(seed)
    now = int(time.time() * 1000)
    start = now - window_days * 24 * 3600 * 1000
    lanes = [(z, "entsoe") for z in ZONES[: max(1, zones - 1)]]
    if zones >= 1:
        lanes.append(("DE", "elecz"))
    lanes = lanes[:zones]

    rows = []
    per_lane = max(1, points // len(lanes))
    step = max(60_000, (now - start) // per_lane)
    for zone, source in lanes:
        base = 40 + (rng.random() * 120)
        phase = rng.random() * math.tau
        for index in range(per_lane):
            t = start + index * step + rng.randint(-30_000, 30_000)
            hour = (t / 3_600_000) % 24
            daily = math.sin(((hour - 7) / 24) * math.tau + phase) * 28
            noise = rng.gauss(0, 5)
            spike = (rng.random() - 0.6) * 180 if rng.random() > 0.985 else 0
            price = round(max(-40.0, base + daily + noise + spike), 4)
            rows.append({"t": t, "z": zone, "p": price, "s": source})

    rows.sort(key=lambda row: row["t"])
    latest = rows[-1]["t"]
    first = rows[0]["t"]
    all_zones = sorted({row["z"] for row in rows})
    return {
        "schema_version": 1,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "mode": "live",
        "meta": {
            "table": "workspace.default.energy_prices_realtime",
            "warehouse_id": "synthetic-load-test",
            "window_days": window_days,
            "row_count": len(rows),
            "raw_row_count": len(rows),
            "max_rows": 80000,
            "truncated": len(rows) >= 80000,
            "fallback": False,
            "sources": sorted({row["s"] for row in rows}),
            "zones": all_zones,
            "currency": "EUR/MWh",
            "first_timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(first / 1000)),
            "first_timestamp_ms": first,
            "latest_timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(latest / 1000)),
            "latest_timestamp_ms": latest,
            "query_ms": 2100,
            "publish_ms": 2400,
        },
        "points": rows,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zones", type=int, default=49, help="number of lanes (48 ENTSO-E + Elecz DE)")
    parser.add_argument("--points", type=int, default=80000, help="approximate point count")
    parser.add_argument("--window-days", type=int, default=30)
    parser.add_argument("--seed", type=int, default=77)
    parser.add_argument("--out", type=Path, default=Path("tests/load/data/energy-80k.json"))
    args = parser.parse_args()

    snapshot = build(args.zones, args.points, args.window_days, args.seed)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(snapshot, separators=(",", ":")), encoding="utf-8")
    size = args.out.stat().st_size
    print(f"{args.out}: {len(snapshot['points'])} points, {len(snapshot['meta']['zones'])} zones, {size / 1024:.1f} KiB")


if __name__ == "__main__":
    main()
