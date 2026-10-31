"""Produce public cryptocurrency market data from CoinGecko to Kafka.

CoinGecko's public API needs no key for the endpoints used here. Every run
collects the top coins by market cap plus the current trending list, merges
them into one flat message per coin, and produces the messages to the
``crypto-market`` topic. Databricks consumes the topic with
``src/crypto_ingest.ipynb`` and the 3D crypto dashboard reads the exported
snapshot from GitHub Pages.

Usage:
    python producer_crypto.py --dry-run
    python producer_crypto.py --coins 25 --trending 10
    python producer_crypto.py --interval 300          # loop every 5 minutes
    python producer_crypto.py --interval 60 --once    # single run, exit

Environment:
    KAFKA_BOOTSTRAP   Kafka bootstrap servers (required unless --dry-run)
    KAFKA_USERNAME    SASL username, default avnadmin
    KAFKA_PASSWORD    SASL password
    KAFKA_CA_LOCATION CA certificate path, default aiven_ca.pem
    CRYPTO_TOPIC      Topic name, default crypto-market
    CRYPTO_COINS      Coins per run, default 25
    CRYPTO_INTERVAL   Loop interval seconds, default 300
"""

from __future__ import annotations

import argparse
import json
import math
import os
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

import requests

API_BASE = "https://api.coingecko.com/api/v3"
TOPIC = "crypto-market"
USER_AGENT = "voltscope-crypto-producer/1.0 (+https://github.com/mdsarfarazalam840/Energy-realtime)"
MAX_COINS = 100
MAX_TRENDING = 20


def env_str(name: str) -> str | None:
    """GitHub Actions exposes unset repository variables as an empty string."""
    value = os.environ.get(name)
    return value if value and value.strip() else None


def env_int(name: str, default: int) -> int:
    raw = env_str(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        print(f"warning: {name}={raw!r} is not an integer; using {default}")
        return default


def retry_call(label: str, func: Callable[[], Any], attempts: int = 3, base_delay: float = 3.0) -> Any:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return func()
        except Exception as exc:  # noqa: BLE001 - retried below and re-raised
            last_error = exc
            if attempt < attempts:
                delay = base_delay * attempt
                print(f"{label} attempt {attempt}/{attempts} failed: {exc}. Retrying in {delay:.0f}s")
                time.sleep(delay)
    raise last_error  # type: ignore[misc]


class CoinGeckoClient:
    """Small client for the keyless CoinGecko public API."""

    def __init__(self, timeout: float = 25.0) -> None:
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({"Accept": "application/json", "User-Agent": USER_AGENT})

    def _get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        response = self.session.get(f"{API_BASE}{path}", params=params, timeout=self.timeout)
        if response.status_code == 429:
            raise RuntimeError("CoinGecko rate limit reached (HTTP 429)")
        response.raise_for_status()
        return response.json()

    def markets(self, coins: int) -> list[dict[str, Any]]:
        payload = retry_call(
            "CoinGecko markets",
            lambda: self._get(
                "/coins/markets",
                {
                    "vs_currency": "usd",
                    "order": "market_cap_desc",
                    "per_page": coins,
                    "page": 1,
                    "sparkline": "false",
                    "price_change_percentage": "24h",
                },
            ),
        )
        if not isinstance(payload, list):
            raise TypeError("CoinGecko markets returned a non-list payload")
        return [row for row in payload if isinstance(row, dict) and row.get("id")]

    def trending(self) -> list[dict[str, Any]]:
        payload = retry_call("CoinGecko trending", lambda: self._get("/search/trending"))
        coins = payload.get("coins") if isinstance(payload, dict) else None
        if not isinstance(coins, list):
            return []
        rows = []
        for entry in coins:
            item = entry.get("item") if isinstance(entry, dict) else None
            if isinstance(item, dict) and item.get("id"):
                rows.append(item)
        return rows


def finite(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def market_message(row: dict[str, Any], timestamp: str, trending_rank: int = 0) -> dict[str, Any]:
    """Normalize one CoinGecko market row to the shared Kafka contract."""
    return {
        "timestamp": timestamp,
        "coin_id": str(row.get("id") or row.get("symbol") or "unknown"),
        "symbol": str(row.get("symbol") or "").upper(),
        "name": str(row.get("name") or row.get("symbol") or "Unknown"),
        "price": round(finite(row.get("current_price")), 10),
        "market_cap": round(finite(row.get("market_cap")), 2),
        "volume_24h": round(finite(row.get("total_volume")), 2),
        "change_24h": round(finite(row.get("price_change_percentage_24h")), 6),
        "market_rank": int(finite(row.get("market_cap_rank"), 0)),
        "trending": 1 if trending_rank else 0,
        "trending_rank": int(trending_rank),
        "source": "coingecko",
    }


def trending_message(item: dict[str, Any], timestamp: str, rank: int) -> dict[str, Any]:
    """Normalize a trending entry that does not appear in the market list."""
    data = item.get("data") if isinstance(item.get("data"), dict) else {}
    change = data.get("price_change_percentage_24h")
    if isinstance(change, dict):
        change = change.get("usd")
    return {
        "timestamp": timestamp,
        "coin_id": str(item.get("id") or item.get("symbol") or "unknown"),
        "symbol": str(item.get("symbol") or "").upper(),
        "name": str(item.get("name") or item.get("symbol") or "Unknown"),
        "price": round(finite(data.get("price")), 10),
        "market_cap": round(finite(data.get("market_cap")), 2),
        "volume_24h": round(finite(data.get("total_volume")), 2),
        "change_24h": round(finite(change), 6),
        "market_rank": int(finite(item.get("market_cap_rank"), 0)),
        "trending": 1,
        "trending_rank": int(rank),
        "source": "coingecko",
    }


def build_messages(client: CoinGeckoClient, coins: int, trending: int) -> list[dict[str, Any]]:
    timestamp = datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
    market_rows = client.markets(coins)
    trending_rows = client.trending()[:trending]

    trending_rank = {
        str(item.get("id")).lower(): index
        for index, item in enumerate(trending_rows, start=1)
        if item.get("id")
    }

    messages: dict[str, dict[str, Any]] = {}
    for row in market_rows:
        coin_id = str(row["id"]).lower()
        messages[coin_id] = market_message(row, timestamp, trending_rank.get(coin_id, 0))

    for item in trending_rows:
        coin_id = str(item.get("id")).lower()
        if coin_id not in messages:
            messages[coin_id] = trending_message(item, timestamp, trending_rank.get(coin_id, 0))

    return sorted(
        messages.values(),
        key=lambda message: (
            message["trending_rank"] or 10**6,
            message["market_rank"] or 10**6,
            message["symbol"],
        ),
    )


def build_producer(topic: str):
    from confluent_kafka import Producer

    return Producer(
        {
            "bootstrap.servers": os.environ["KAFKA_BOOTSTRAP"],
            "security.protocol": "SASL_SSL",
            "sasl.mechanism": "SCRAM-SHA-256",
            "sasl.username": env_str("KAFKA_USERNAME") or "avnadmin",
            "sasl.password": env_str("KAFKA_PASSWORD"),
            "ssl.ca.location": os.environ.get("KAFKA_CA_LOCATION", "aiven_ca.pem"),
            "client.id": "voltscope-crypto-producer",
            "message.timeout.ms": 30000,
        }
    )


def produce(messages: list[dict[str, Any]], topic: str, dry_run: bool) -> int:
    if dry_run:
        for message in messages:
            print(f"Dry: {json.dumps(message)}")
        print(f"Dry run: {len(messages)} crypto message(s); nothing produced to Kafka.")
        return 0

    producer = build_producer(topic)
    for message in messages:
        key = str(message.get("coin_id") or "").encode("utf-8")
        producer.produce(topic, value=json.dumps(message).encode("utf-8"), key=key)
        producer.poll(0)
    undelivered = producer.flush(30)
    if undelivered:
        print(f"Kafka flush ended with {undelivered} message(s) undelivered.")
        return 1
    print(f"Produced {len(messages)} crypto message(s) to {topic}.")
    return 0


def env_int(name: str, default: int) -> int:
    raw = env_str(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        print(f"warning: {name}={raw!r} is not an integer; using {default}")
        return default


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fetch keyless CoinGecko market data and produce it to Kafka")
    parser.add_argument("--coins", type=int, default=env_int("CRYPTO_COINS", 100), help="Top coins by market cap, 1-100")
    parser.add_argument("--trending", type=int, default=env_int("CRYPTO_TRENDING", 10), help="Trending coins, 0-20")
    parser.add_argument("--topic", default=env_str("CRYPTO_TOPIC") or TOPIC)
    parser.add_argument("--timeout", type=float, default=25.0)
    parser.add_argument("--interval", type=int, default=env_int("CRYPTO_INTERVAL", 300), help="Loop interval seconds; 0 means run once and exit")
    parser.add_argument("--once", action="store_true", help="Run a single fetch and exit (overrides --interval)")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and print without Kafka credentials")
    return parser.parse_args(argv)


def run_once(client: CoinGeckoClient, args: argparse.Namespace) -> int:
    coins = max(1, min(args.coins, MAX_COINS))
    trending = max(0, min(args.trending, MAX_TRENDING))
    if coins != args.coins or trending != args.trending:
        print(f"Clamped request to coins={coins} trending={trending}")

    try:
        messages = build_messages(client, coins, trending)
    except Exception as exc:  # noqa: BLE001 - the workflow reports the message
        print(f"CoinGecko fetch failed: {exc}")
        return 1

    if not messages:
        print("CoinGecko returned no usable coin rows.")
        return 1

    try:
        return produce(messages, args.topic, args.dry_run)
    except KeyError as exc:
        print(f"Kafka configuration is incomplete: missing {exc}")
        return 2


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    once = args.once or args.interval <= 0
    coins = max(1, min(args.coins, MAX_COINS))
    trending = max(0, min(args.trending, MAX_TRENDING))
    if coins != args.coins or trending != args.trending:
        print(f"Clamped request to coins={coins} trending={trending}")

    try:
        client = CoinGeckoClient(timeout=args.timeout)
    except Exception as exc:
        print(f"CoinGecko client failed: {exc}")
        return 1

    if once:
        return run_once(client, args)

    print(f"Crypto producer looping every {args.interval}s (Ctrl-C to stop).")
    while True:
        code = run_once(client, args)
        if code != 0:
            print(f"Producer run exited with code {code}; retrying in {args.interval}s")
        time.sleep(args.interval)


if __name__ == "__main__":
    raise SystemExit(main())
