#!/usr/bin/env python3
"""Bridge the ``flights-positions`` Kafka topic into MotherDuck.

Step 3 of the flights pipeline. MotherDuck is an analytical warehouse, not a
message bus, so it cannot subscribe to Kafka. This script is the free-compatible
bridge: a small Python consumer polls Aiven Kafka with ``confluent-kafka``,
batches the messages, and upserts them into a MotherDuck table with ``duckdb``.

The consumer group commits offsets only after a successful warehouse write, so
a crash re-delivers the batch instead of dropping it. Re-delivery is safe
because the upsert is keyed on ``(icao24, observed_at)``.

Usage:
    python scripts/bridge_flights_to_motherduck.py --dry-run
    python scripts/bridge_flights_to_motherduck.py
    python scripts/bridge_flights_to_motherduck.py --max-messages 20000

Environment:
    KAFKA_BOOTSTRAP            Kafka bootstrap servers
    KAFKA_USERNAME             SASL username, default avnadmin
    KAFKA_PASSWORD             SASL password
    KAFKA_CA_LOCATION          CA certificate path, default aiven_ca.pem
    FLIGHTS_TOPIC              Topic name, default flights-positions
    motherduck_token           MotherDuck access token (or MOTHERDUCK_TOKEN)
    MOTHERDUCK_DATABASE        Database name, default flights
    MOTHERDUCK_TABLE           Table name, default flights_positions
    MOTHERDUCK_CONSUMER_GROUP  Consumer group, default flights-motherduck-bridge
"""

from __future__ import annotations

import argparse
import json
import os
import re
import time
from datetime import UTC, datetime
from typing import Any

IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

TABLE_DDL = """
CREATE TABLE IF NOT EXISTS {table} (
    icao24 VARCHAR NOT NULL,
    callsign VARCHAR,
    country VARCHAR,
    lat DOUBLE,
    lon DOUBLE,
    observed_at TIMESTAMP NOT NULL,
    last_update_ms BIGINT,
    snapshot_id TIMESTAMP,
    fetched_at TIMESTAMP,
    source VARCHAR,
    ingested_at TIMESTAMP
)
"""


def env_str(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    if value and value.strip():
        return value.strip()
    return default


def parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip())
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    # DuckDB TIMESTAMP is timezone-naive; keep the value in UTC.
    return parsed.astimezone(UTC).replace(tzinfo=None)


def parse_message(raw: bytes | None) -> dict[str, Any] | None:
    """Normalize one Kafka JSON value to a warehouse row."""
    if not raw:
        return None
    try:
        message = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(message, dict):
        return None

    icao24 = str(message.get("icao24") or "").strip().lower()
    observed_at = parse_timestamp(message.get("timestamp"))
    if not icao24 or observed_at is None:
        return None
    lat = message.get("lat")
    lon = message.get("lon")
    if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
        return None
    if abs(lat) > 90 or abs(lon) > 180:
        return None

    last_update_ms = message.get("last_update_ms")
    if isinstance(last_update_ms, bool) or not isinstance(last_update_ms, (int, float)):
        last_update_ms = None

    return {
        "icao24": icao24,
        "callsign": str(message.get("callsign") or "")[:10],
        "country": str(message.get("country") or "Unknown"),
        "lat": float(lat),
        "lon": float(lon),
        "observed_at": observed_at,
        "last_update_ms": int(last_update_ms) if last_update_ms is not None else None,
        "snapshot_id": parse_timestamp(message.get("snapshot_id")),
        "fetched_at": parse_timestamp(message.get("fetched_at")),
        "source": str(message.get("source") or "adsb.lol"),
    }


def build_consumer(group: str):
    from confluent_kafka import Consumer

    return Consumer(
        {
            "bootstrap.servers": os.environ["KAFKA_BOOTSTRAP"],
            "security.protocol": "SASL_SSL",
            "sasl.mechanism": "SCRAM-SHA-256",
            "sasl.username": env_str("KAFKA_USERNAME", "avnadmin"),
            "sasl.password": os.environ["KAFKA_PASSWORD"],
            "ssl.ca.location": env_str("KAFKA_CA_LOCATION", "aiven_ca.pem"),
            "group.id": group,
            "client.id": "voltscope-flights-bridge",
            "enable.auto.commit": False,
            "auto.offset.reset": "earliest",
            "enable.partition.eof": False,
        }
    )


def connect_motherduck(token: str, database: str):
    import duckdb

    connection = duckdb.connect("md:", config={"motherduck_token": token})
    connection.execute(f'CREATE DATABASE IF NOT EXISTS "{database}"')
    connection.execute(f'USE "{database}"')
    return connection


def ensure_table(connection: Any, table: str) -> None:
    connection.execute(TABLE_DDL.format(table=table))


def upsert_rows(connection: Any, table: str, rows: list[dict[str, Any]]) -> int:
    """Delete the matching keys, then insert, in one transaction."""
    if not rows:
        return 0

    import pandas as pd

    frame = pd.DataFrame(rows)
    connection.register("incoming_flights", frame)
    try:
        connection.execute("CREATE OR REPLACE TEMP TABLE staging_flights AS SELECT * FROM incoming_flights")
        connection.execute("BEGIN TRANSACTION")
        connection.execute(
            f"""
            DELETE FROM {table}
            WHERE EXISTS (
                SELECT 1 FROM staging_flights s
                WHERE s.icao24 = {table}.icao24
                  AND s.observed_at = {table}.observed_at
            )
            """
        )
        connection.execute(
            f"""
            INSERT INTO {table}
                (icao24, callsign, country, lat, lon, observed_at,
                 last_update_ms, snapshot_id, fetched_at, source, ingested_at)
            SELECT icao24, callsign, country, lat, lon, observed_at,
                   last_update_ms, snapshot_id, fetched_at, source, now()
            FROM staging_flights
            """
        )
        connection.execute("COMMIT")
    except Exception:
        connection.execute("ROLLBACK")
        raise
    finally:
        connection.unregister("incoming_flights")
    return len(rows)


def consume_batch(consumer: Any, batch_size: int, idle_timeout: float) -> tuple[list[dict[str, Any]], int]:
    from confluent_kafka import KafkaError

    rows: list[dict[str, Any]] = []
    skipped = 0
    deadline = time.monotonic() + idle_timeout
    while len(rows) < batch_size:
        message = consumer.poll(1.0)
        if message is None:
            if time.monotonic() >= deadline:
                break
            continue
        deadline = time.monotonic() + idle_timeout
        error = message.error()
        if error is not None:
            if error.code() == KafkaError._PARTITION_EOF:
                continue
            raise RuntimeError(f"Kafka consume error: {error}")
        row = parse_message(message.value())
        if row is None:
            skipped += 1
            continue
        rows.append(row)
    return rows, skipped


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Bridge flights-positions from Kafka into MotherDuck")
    parser.add_argument("--topic", default=env_str("FLIGHTS_TOPIC", "flights-positions"))
    parser.add_argument("--database", default=env_str("MOTHERDUCK_DATABASE", "flights"))
    parser.add_argument("--table", default=env_str("MOTHERDUCK_TABLE", "flights_positions"))
    parser.add_argument("--group", default=env_str("MOTHERDUCK_CONSUMER_GROUP", "flights-motherduck-bridge"))
    parser.add_argument("--batch-size", type=int, default=5000)
    parser.add_argument("--max-messages", type=int, default=200000)
    parser.add_argument("--idle-timeout", type=float, default=20.0, help="Seconds without a message before stopping")
    parser.add_argument("--dry-run", action="store_true", help="Read Kafka but do not write to MotherDuck")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    for label, value in (("database", args.database), ("table", args.table)):
        if not IDENTIFIER.match(value):
            print(f"error: invalid {label} name {value!r}")
            return 2
    if args.batch_size <= 0 or args.max_messages <= 0:
        print("error: --batch-size and --max-messages must be positive")
        return 2

    token = env_str("motherduck_token") or env_str("MOTHERDUCK_TOKEN")
    if not args.dry_run and not token:
        print("error: motherduck_token is not set")
        return 2

    try:
        consumer = build_consumer(args.group)
    except KeyError as exc:
        print(f"Kafka configuration is incomplete: missing {exc}")
        return 2

    connection = None
    if not args.dry_run:
        try:
            connection = connect_motherduck(token, args.database)
            ensure_table(connection, args.table)
        except Exception as exc:  # noqa: BLE001 - reported to the workflow log
            print(f"MotherDuck connection failed: {exc}")
            return 1

    consumed = 0
    written = 0
    skipped = 0
    batches = 0
    consumer.subscribe([args.topic])
    print(f"Bridging {args.topic} -> {args.database}.{args.table} (group {args.group}).")

    try:
        while consumed < args.max_messages:
            rows, batch_skipped = consume_batch(consumer, args.batch_size, args.idle_timeout)
            skipped += batch_skipped
            if not rows:
                break
            if not args.dry_run:
                written += upsert_rows(connection, args.table, rows)
                consumer.commit(asynchronous=False)
            else:
                written += len(rows)
            consumed += len(rows)
            batches += 1
            print(f"batch {batches}: {len(rows)} rows (total {consumed})")
    except Exception as exc:  # noqa: BLE001 - surfaced as a non-zero exit
        print(f"Bridge failed after {consumed} message(s): {exc}")
        return 1
    finally:
        consumer.close()

    action = "read" if args.dry_run else "upserted"
    print(f"Done: {action} {written} row(s), skipped {skipped} invalid message(s), {batches} batch(es).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
