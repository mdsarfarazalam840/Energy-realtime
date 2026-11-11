"""Produce adsb.lol flight positions to Kafka.

Step 1 of the flights pipeline. The fetch step stays in
``scripts/cache_flights.mjs``: one polite grid pass over the keyless public
adsb.lol API writes ``docs/data/flights.json``, which the static globe also
serves. This script reads that snapshot and produces one message per aircraft
to the ``flights-positions`` topic, so ingestion is decoupled from processing.

Keeping fetch and produce separate matters for the adsb.lol quota: the public
API allows roughly 500 requests per day per IP, and one grid pass already
spends about 64. A second fetcher would double that spend for no new data.

Usage:
    python producer_flights.py --dry-run
    python producer_flights.py
    python producer_flights.py --snapshot docs/data/flights.json --limit 50

Environment:
    KAFKA_BOOTSTRAP   Kafka bootstrap servers (required unless --dry-run)
    KAFKA_USERNAME    SASL username, default avnadmin
    KAFKA_PASSWORD    SASL password
    KAFKA_CA_LOCATION CA certificate path, default aiven_ca.pem
    FLIGHTS_TOPIC     Topic name, default flights-positions
    FLIGHTS_SNAPSHOT  Snapshot path, default docs/data/flights.json
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

TOPIC = "flights-positions"
SOURCE = "adsb.lol"
DEFAULT_SNAPSHOT = "docs/data/flights.json"
ICAO24 = re.compile(r"^[0-9a-f]{6}$")


def env_str(name: str) -> str | None:
    """GitHub Actions exposes unset repository variables as an empty string."""
    value = os.environ.get(name)
    return value if value and value.strip() else None


def finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def utc_iso(value: Any) -> str | None:
    """Normalize an ISO-8601 value to UTC with a ``Z`` suffix."""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip())
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def normalize_plane(plane: Any, snapshot: dict[str, Any]) -> dict[str, Any] | None:
    """Turn one snapshot plane into the shared Kafka message contract."""
    if not isinstance(plane, dict):
        return None

    icao24 = str(plane.get("icao24") or "").strip().lower()
    if not ICAO24.match(icao24):
        return None

    lat = finite(plane.get("lat"))
    lon = finite(plane.get("lon"))
    if lat is None or lon is None or abs(lat) > 90 or abs(lon) > 180:
        return None

    fetched_at = utc_iso(snapshot.get("fetched_at")) or datetime.now(UTC).isoformat(
        timespec="seconds"
    ).replace("+00:00", "Z")
    observed_at = utc_iso(plane.get("lastUpdate")) or fetched_at
    last_update_ms = plane.get("lastUpdateMs")
    if isinstance(last_update_ms, bool) or not isinstance(last_update_ms, (int, float)):
        last_update_ms = None

    return {
        "timestamp": observed_at,
        "icao24": icao24,
        "callsign": str(plane.get("callsign") or "").strip()[:10],
        "country": str(plane.get("country") or "Unknown").strip().rstrip(",").strip(),
        "lat": round(lat, 4),
        "lon": round(lon, 4),
        "last_update_ms": int(last_update_ms) if last_update_ms is not None else None,
        "snapshot_id": fetched_at,
        "fetched_at": fetched_at,
        "source": str(snapshot.get("source") or SOURCE),
    }


def build_messages(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    """Normalize and deduplicate one snapshot by ICAO address."""
    planes = snapshot.get("planes")
    if not isinstance(planes, list):
        raise TypeError("snapshot has no planes array")

    by_icao: dict[str, dict[str, Any]] = {}
    for plane in planes:
        message = normalize_plane(plane, snapshot)
        if message is None:
            continue
        existing = by_icao.get(message["icao24"])
        if existing is None or (message["last_update_ms"] or 0) >= (existing["last_update_ms"] or 0):
            by_icao[message["icao24"]] = message

    return [by_icao[icao24] for icao24 in sorted(by_icao)]


def load_snapshot(path: str) -> dict[str, Any]:
    snapshot = json.loads(Path(path).read_text(encoding="utf8"))
    if not isinstance(snapshot, dict):
        raise TypeError(f"{path} is not a flights snapshot object")
    return snapshot


def build_producer():
    from confluent_kafka import Producer

    return Producer(
        {
            "bootstrap.servers": os.environ["KAFKA_BOOTSTRAP"],
            "security.protocol": "SASL_SSL",
            "sasl.mechanism": "SCRAM-SHA-256",
            "sasl.username": env_str("KAFKA_USERNAME") or "avnadmin",
            "sasl.password": os.environ["KAFKA_PASSWORD"],
            "ssl.ca.location": env_str("KAFKA_CA_LOCATION") or "aiven_ca.pem",
            "client.id": "voltscope-flights-producer",
            "message.timeout.ms": 30000,
        }
    )


def produce(messages: list[dict[str, Any]], topic: str, dry_run: bool) -> int:
    if dry_run:
        for message in messages:
            print(f"Dry: {json.dumps(message)}")
        print(f"Dry run: {len(messages)} flight message(s); nothing produced to Kafka.")
        return 0

    producer = build_producer()
    for message in messages:
        producer.produce(
            topic,
            value=json.dumps(message, separators=(",", ":")).encode("utf-8"),
            key=message["icao24"].encode("utf-8"),
        )
        producer.poll(0)
    undelivered = producer.flush(30)
    if undelivered:
        print(f"Kafka flush ended with {undelivered} message(s) undelivered.")
        return 1
    print(f"Produced {len(messages)} flight message(s) to {topic}.")
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Produce an adsb.lol snapshot to Kafka")
    parser.add_argument("--snapshot", default=env_str("FLIGHTS_SNAPSHOT") or DEFAULT_SNAPSHOT)
    parser.add_argument("--topic", default=env_str("FLIGHTS_TOPIC") or TOPIC)
    parser.add_argument("--limit", type=int, default=0, help="Produce at most N aircraft (0 = all)")
    parser.add_argument("--dry-run", action="store_true", help="Print messages without Kafka credentials")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        snapshot = load_snapshot(args.snapshot)
        messages = build_messages(snapshot)
    except (OSError, ValueError, TypeError) as exc:
        print(f"error: {exc}")
        return 2

    if args.limit > 0:
        messages = messages[: args.limit]
    if not messages:
        print(f"No usable aircraft in {args.snapshot}; nothing produced.")
        return 1

    fetched_at = snapshot.get("fetched_at") or "unknown"
    print(f"Snapshot {fetched_at}: {len(messages)} aircraft to {args.topic}.")
    try:
        return produce(messages, args.topic, args.dry_run)
    except KeyError as exc:
        print(f"Kafka configuration is incomplete: missing {exc}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
