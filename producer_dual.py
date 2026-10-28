"""Multi-zone energy price producer.

Pulls day-ahead prices from ENTSO-E for every configured bidding zone and spot
prices from Elecz for every configured Elecz zone, then produces one JSON
message per zone per run to Kafka.

Zone selection is driven by the ZONE_REGISTRY below and can be overridden with
environment variables:

    ENTSOE_ZONES          Comma-separated zones, or "all". Default: DEFAULT_ENTSOE_ZONES
    ELECZ_ZONES           Comma-separated zones, or "all". Default: DEFAULT_ELECZ_ZONES
    ENTSOE_LOOKBACK_HOURS Hours of day-ahead history to read. Default: 48

Run `python producer_dual.py --list-zones` to print the registry, and
`python producer_dual.py --dry-run` to fetch without producing to Kafka.
"""

import argparse
import json
import math
import os
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterable

import requests


# --- Zone registry -----------------------------------------------------------
# One line per market zone. `zone` is the public code written to Kafka and the
# dashboard. `entsoe` is the entsoe-py Area code. `elecz` is the value passed as
# ?zone= to Elecz; set it to None for zones Elecz does not publish.
@dataclass(frozen=True)
class ZoneConfig:
    zone: str
    country: str
    market: str
    entsoe: str | None
    elecz: str | None


ZONE_REGISTRY: dict[str, ZoneConfig] = {
    # Central and western Europe
    "DE_LU": ZoneConfig("DE_LU", "DE", "day-ahead", "DE_LU", "DE"),
    "NL": ZoneConfig("NL", "NL", "day-ahead", "NL", "NL"),
    "BE": ZoneConfig("BE", "BE", "day-ahead", "BE", "BE"),
    "AT": ZoneConfig("AT", "AT", "day-ahead", "AT", "AT"),
    "FR": ZoneConfig("FR", "FR", "day-ahead", "FR", "FR"),
    "PL": ZoneConfig("PL", "PL", "day-ahead", "PL", "PL"),
    "CH": ZoneConfig("CH", "CH", "day-ahead", "CH", None),
    "CZ": ZoneConfig("CZ", "CZ", "day-ahead", "CZ", None),
    "SK": ZoneConfig("SK", "SK", "day-ahead", "SK", None),
    "HU": ZoneConfig("HU", "HU", "day-ahead", "HU", None),
    "SI": ZoneConfig("SI", "SI", "day-ahead", "SI", None),
    # Iberia
    "ES": ZoneConfig("ES", "ES", "day-ahead", "ES", "ES"),
    "PT": ZoneConfig("PT", "PT", "day-ahead", "PT", None),
    # Nordics: Sweden
    "SE1": ZoneConfig("SE1", "SE", "day-ahead", "SE_1", "SE1"),
    "SE2": ZoneConfig("SE2", "SE", "day-ahead", "SE_2", "SE2"),
    "SE3": ZoneConfig("SE3", "SE", "day-ahead", "SE_3", "SE3"),
    "SE4": ZoneConfig("SE4", "SE", "day-ahead", "SE_4", "SE4"),
    # Nordics: Norway
    "NO1": ZoneConfig("NO1", "NO", "day-ahead", "NO_1", "NO1"),
    "NO2": ZoneConfig("NO2", "NO", "day-ahead", "NO_2", "NO2"),
    "NO3": ZoneConfig("NO3", "NO", "day-ahead", "NO_3", "NO3"),
    "NO4": ZoneConfig("NO4", "NO", "day-ahead", "NO_4", "NO4"),
    "NO5": ZoneConfig("NO5", "NO", "day-ahead", "NO_5", "NO5"),
    # Nordics: Denmark and Finland
    "DK1": ZoneConfig("DK1", "DK", "day-ahead", "DK_1", "DK1"),
    "DK2": ZoneConfig("DK2", "DK", "day-ahead", "DK_2", "DK2"),
    "FI": ZoneConfig("FI", "FI", "day-ahead", "FI", None),
    # Baltics
    "EE": ZoneConfig("EE", "EE", "day-ahead", "EE", None),
    "LV": ZoneConfig("LV", "LV", "day-ahead", "LV", None),
    "LT": ZoneConfig("LT", "LT", "day-ahead", "LT", None),
    # South-east Europe
    "HR": ZoneConfig("HR", "HR", "day-ahead", "HR", None),
    "RO": ZoneConfig("RO", "RO", "day-ahead", "RO", None),
    "BG": ZoneConfig("BG", "BG", "day-ahead", "BG", None),
    "GR": ZoneConfig("GR", "GR", "day-ahead", "GR", None),
    "RS": ZoneConfig("RS", "RS", "day-ahead", "RS", None),
    "BA": ZoneConfig("BA", "BA", "day-ahead", "BA", None),
    "ME": ZoneConfig("ME", "ME", "day-ahead", "ME", None),
    "MK": ZoneConfig("MK", "MK", "day-ahead", "MK", None),
    "AL": ZoneConfig("AL", "AL", "day-ahead", "AL", None),
    "XK": ZoneConfig("XK", "XK", "day-ahead", "XK", None),
    # Eastern Europe
    "MD": ZoneConfig("MD", "MD", "day-ahead", "MD", None),
    "UA": ZoneConfig("UA", "UA", "day-ahead", "UA", None),
    # Ireland
    "IE_SEM": ZoneConfig("IE_SEM", "IE", "day-ahead", "IE_SEM", None),
    # Italy: one market, seven price zones
    "IT_NORD": ZoneConfig("IT_NORD", "IT", "day-ahead", "IT_NORD", None),
    "IT_CNOR": ZoneConfig("IT_CNOR", "IT", "day-ahead", "IT_CNOR", None),
    "IT_CSUD": ZoneConfig("IT_CSUD", "IT", "day-ahead", "IT_CSUD", None),
    "IT_SUD": ZoneConfig("IT_SUD", "IT", "day-ahead", "IT_SUD", None),
    "IT_SICI": ZoneConfig("IT_SICI", "IT", "day-ahead", "IT_SICI", None),
    "IT_SARD": ZoneConfig("IT_SARD", "IT", "day-ahead", "IT_SARD", None),
    "IT_CALA": ZoneConfig("IT_CALA", "IT", "day-ahead", "IT_CALA", None),
}

# Zone aliases accepted on the command line and in environment variables.
ZONE_ALIASES = {
    "DE": "DE_LU",
    "DE-LU": "DE_LU",
    "SE_1": "SE1",
    "SE_2": "SE2",
    "SE_3": "SE3",
    "SE_4": "SE4",
    "NO_1": "NO1",
    "NO_2": "NO2",
    "NO_3": "NO3",
    "NO_4": "NO4",
    "NO_5": "NO5",
    "DK_1": "DK1",
    "DK_2": "DK2",
}

DEFAULT_ENTSOE_ZONES = tuple(ZONE_REGISTRY)

# Elecz is an undocumented spot endpoint that has only been verified for DE.
# Add zones here only after confirming their response shape.
DEFAULT_ELECZ_ZONES = ("DE",)

TOPIC = "energy-prices"


def resolve_zone(raw: str) -> str:
    """Map user input such as `se_1` or `de` to a registry key."""
    code = raw.strip().upper().replace(" ", "")
    code = ZONE_ALIASES.get(code, code)
    if code not in ZONE_REGISTRY:
        known = ", ".join(sorted(ZONE_REGISTRY))
        raise ValueError(f"Unknown zone {raw!r}. Known zones: {known}")
    return code


def parse_zones(raw: str | None, default: Iterable[str]) -> list[str]:
    """Parse a comma-separated zone list. Empty returns the default, `all` the registry."""
    if raw is None or not raw.strip():
        candidates: Iterable[str] = default
    elif raw.strip().lower() == "all":
        candidates = list(ZONE_REGISTRY)
    else:
        candidates = raw.split(",")

    zones: list[str] = []
    for part in candidates:
        if not part.strip():
            continue
        zone = resolve_zone(part)
        if zone not in zones:
            zones.append(zone)
    return zones or [resolve_zone(zone) for zone in default]


# --- Kafka -------------------------------------------------------------------
def build_producer():
    """Create the Kafka producer. Imported lazily so --dry-run works offline."""
    from confluent_kafka import Producer

    conf = {
        "bootstrap.servers": os.environ["KAFKA_BOOTSTRAP"],
        "security.protocol": "SASL_SSL",
        "sasl.mechanism": "SCRAM-SHA-256",
        "sasl.username": os.environ.get("KAFKA_USERNAME", "avnadmin"),
        "sasl.password": os.environ["KAFKA_PASSWORD"],
        # 'ssl.ca.pem': os.environ["KAFKA_CA_PEM"],  <-- Remove this line to avoid permission error
        "ssl.ca.location": os.environ.get("KAFKA_CA_LOCATION", "aiven_ca.pem"),
    }
    return Producer(conf)


def send_to_kafka(producer, data: dict[str, Any]) -> None:
    try:
        producer.produce(TOPIC, json.dumps(data).encode("utf-8"))
        producer.poll(0)
        print(f"Sent: {data}")
    except Exception as exc:
        print(f"Kafka send error for {data.get('zone')}: {exc}")


# --- Helpers -----------------------------------------------------------------
def retry_call(label: str, func: Callable[[], Any], attempts: int = 3, base_delay: float = 2.0) -> Any:
    """Run a fetch with bounded exponential backoff. Raises the last error."""
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return func()
        except Exception as exc:
            last_error = exc
            if attempt == attempts:
                break
            delay = base_delay * attempt
            print(f"{label} attempt {attempt}/{attempts} failed: {exc}. Retrying in {delay:.0f}s")
            time.sleep(delay)
    raise last_error  # type: ignore[misc]


def iso_utc(value: Any) -> str:
    """Normalize a pandas Timestamp or datetime to an ISO-8601 UTC string."""
    if hasattr(value, "tzinfo") and value.tzinfo is not None:
        if hasattr(value, "tz_convert"):
            return value.tz_convert("UTC").isoformat()
        return value.astimezone(timezone.utc).isoformat()
    if hasattr(value, "tz_localize"):
        return value.tz_localize("UTC").isoformat()
    return value.replace(tzinfo=timezone.utc).isoformat()


# --- 1. Elecz Data Fetch -----------------------------------------------------
def fetch_elecz_zone(zone: str) -> dict[str, Any] | None:
    cfg = ZONE_REGISTRY[zone]
    if not cfg.elecz:
        print(f"Elecz does not publish zone {zone}; skipping.")
        return None

    print(f"Fetching Elecz data for {zone}...")
    url = f"https://elecz.com/signal/spot?zone={cfg.elecz}"

    def call() -> Any:
        response = requests.get(url, timeout=30)
        response.raise_for_status()
        return response.json()

    data = retry_call(f"Elecz {zone}", call)
    price = data.get("price")
    if price is None:
        price = data.get("spot_price")
    if price is None:
        print(f"Elecz response format unexpected for {zone}: {data}")
        return None

    price_eur_mwh = elecz_price_to_eur_mwh(zone, float(price), data)
    if price_eur_mwh is None:
        return None

    timestamp = data.get("timestamp") or datetime.now(timezone.utc).isoformat()
    return {
        "timestamp": str(timestamp),
        # Elecz keeps its own zone label (DE), which preserves the historical
        # contract while ENTSO-E publishes the bidding zone (DE_LU).
        "zone": cfg.elecz,
        "price": price_eur_mwh,
        "source": "elecz",
        "country": cfg.country,
        "market": "spot",
    }


# Elecz reports national units. Only EUR units are converted; a non-EUR zone
# would need an FX rate before it can join the EUR/MWh contract.
ELECZ_UNIT_FACTORS = {
    "c/kwh": 10.0,  # 1 cent/kWh = 10 EUR/MWh
    "ct/kwh": 10.0,
    "cent/kwh": 10.0,
    "eur/mwh": 1.0,
    "€/mwh": 1.0,
    "eur/kwh": 1000.0,
    "€/kwh": 1000.0,
}


def elecz_price_to_eur_mwh(zone: str, price: float, data: dict[str, Any]) -> float | None:
    """Convert an Elecz price to EUR/MWh, or None when the unit is unsafe."""
    if not math.isfinite(price):
        print(f"Elecz returned a non-finite price for {zone}; skipping.")
        return None

    currency = str(data.get("currency") or "").upper()
    if currency and currency != "EUR":
        # Non-EUR zones (SEK, DKK, NOK) need an FX rate. Set
        # ELECZ_ALLOW_NON_EUR=1 only if you add conversion downstream.
        if os.environ.get("ELECZ_ALLOW_NON_EUR") != "1":
            print(
                f"Elecz {zone} returned {currency} ({data.get('unit')}); "
                "skipping to keep the EUR/MWh contract. Set ELECZ_ALLOW_NON_EUR=1 to override."
            )
            return None
        return price

    unit = str(data.get("unit") or "").strip().lower()
    factor = ELECZ_UNIT_FACTORS.get(unit)
    if factor is None:
        print(f"Elecz {zone} returned unknown unit {data.get('unit')!r}; skipping.")
        return None
    return round(price * factor, 6)


# --- 2. ENTSO-E Data Fetch ---------------------------------------------------
def fetch_entsoe_zone(client, zone: str, lookback_hours: int) -> dict[str, Any] | None:
    import pandas as pd

    cfg = ZONE_REGISTRY[zone]
    if not cfg.entsoe:
        print(f"ENTSO-E has no mapping for {zone}; skipping.")
        return None

    print(f"Fetching ENTSO-E day-ahead data for {zone} ({cfg.entsoe})...")

    end_dt = datetime.now(timezone.utc)
    start_dt = end_dt - timedelta(hours=lookback_hours)

    # Force conversion to pd.Timestamp with timezone
    end = pd.Timestamp(end_dt)
    start = pd.Timestamp(start_dt)
    if start.tzinfo is None:
        start = start.tz_localize("UTC")
    if end.tzinfo is None:
        end = end.tz_localize("UTC")

    prices = retry_call(
        f"ENTSO-E {zone}",
        lambda: client.query_day_ahead_prices(cfg.entsoe, start=start, end=end),
    )
    prices = prices.dropna()
    if prices.empty:
        print(f"ENTSO-E returned no data for {zone} in the last {lookback_hours}h.")
        return None

    latest_ts = prices.index[-1]
    latest_price = float(prices.iloc[-1])
    if not math.isfinite(latest_price):
        print(f"ENTSO-E returned a non-finite price for {zone}; skipping.")
        return None

    return {
        "timestamp": iso_utc(latest_ts),
        "zone": zone,
        "price": latest_price,
        "source": "entsoe",
        "country": cfg.country,
        "market": cfg.market,
        "entsoe_code": cfg.entsoe,
    }


# --- Main Execution ----------------------------------------------------------
def run(zones_elecz: list[str], zones_entsoe: list[str], lookback_hours: int, dry_run: bool) -> int:
    producer = None if dry_run else build_producer()
    messages: list[dict[str, Any]] = []
    failures = 0

    def emit(message: dict[str, Any] | None) -> None:
        if message is None:
            return
        messages.append(message)
        if producer is not None:
            send_to_kafka(producer, message)
        else:
            print(f"Dry: {json.dumps(message)}")

    for zone in zones_elecz:
        try:
            emit(fetch_elecz_zone(zone))
        except Exception as exc:
            failures += 1
            print(f"Elecz fetch failed for {zone}: {exc}")

    api_key = os.environ.get("ENTSOE_API_KEY")
    if not api_key:
        print("ENTSOE_API_KEY not set, skipping ENTSO-E zones.")
    else:
        from entsoe import EntsoePandasClient

        client = EntsoePandasClient(api_key=api_key)
        for zone in zones_entsoe:
            try:
                emit(fetch_entsoe_zone(client, zone, lookback_hours))
            except Exception as exc:
                failures += 1
                print(f"ENTSO-E fetch failed for {zone}: {exc}")

    if producer is not None:
        producer.flush()

    print(
        f"Done: {len(messages)} message(s), {len(zones_elecz)} Elecz zone(s), "
        f"{len(zones_entsoe)} ENTSO-E zone(s), {failures} failure(s)."
    )
    if dry_run:
        print("Dry run: nothing produced to Kafka.")
    return 0 if messages else 1


def list_zones() -> None:
    print(f"{'ZONE':<8} {'COUNTRY':<8} {'MARKET':<10} {'ENTSO-E':<8} {'ELECZ':<6}")
    for zone, cfg in ZONE_REGISTRY.items():
        print(f"{zone:<8} {cfg.country:<8} {cfg.market:<10} {cfg.entsoe or '-':<8} {cfg.elecz or '-':<6}")


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return int(raw)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Produce multi-zone energy prices to Kafka")
    parser.add_argument("--list-zones", action="store_true", help="Print the zone registry and exit")
    parser.add_argument("--dry-run", action="store_true", help="Fetch prices and print them without producing to Kafka")
    parser.add_argument(
        "--zone",
        help="Comma-separated zones for this run, overriding ENTSOE_ZONES and ELECZ_ZONES",
    )
    parser.add_argument(
        "--entsoe-zones",
        default=os.environ.get("ENTSOE_ZONES"),
        help="Comma-separated ENTSO-E zones, or 'all' (default: built-in list)",
    )
    parser.add_argument(
        "--elecz-zones",
        default=os.environ.get("ELECZ_ZONES"),
        help="Comma-separated Elecz zones, or 'all' (default: DE)",
    )
    parser.add_argument(
        "--lookback-hours",
        type=int,
        default=env_int("ENTSOE_LOOKBACK_HOURS", 48),
        help="Hours of day-ahead history to read (default: 48)",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.list_zones:
        list_zones()
        return 0

    if args.lookback_hours <= 0:
        print("error: --lookback-hours must be positive")
        return 2

    try:
        if args.zone:
            zones_entsoe = parse_zones(args.zone, DEFAULT_ENTSOE_ZONES)
            zones_elecz = parse_zones(args.zone, DEFAULT_ELECZ_ZONES)
        else:
            zones_entsoe = parse_zones(args.entsoe_zones, DEFAULT_ENTSOE_ZONES)
            zones_elecz = parse_zones(args.elecz_zones, DEFAULT_ELECZ_ZONES)
    except ValueError as exc:
        print(f"error: {exc}")
        return 2

    # Elecz only publishes a subset; keep only zones the registry maps.
    zones_elecz = [zone for zone in zones_elecz if ZONE_REGISTRY[zone].elecz]
    zones_entsoe = [zone for zone in zones_entsoe if ZONE_REGISTRY[zone].entsoe]

    print(
        f"Zones: ENTSO-E={','.join(zones_entsoe) or '-'} "
        f"Elecz={','.join(zones_elecz) or '-'} lookback={args.lookback_hours}h"
    )
    return run(zones_elecz, zones_entsoe, args.lookback_hours, args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())
