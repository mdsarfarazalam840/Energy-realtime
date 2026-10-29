"""Produce public electricity-market prices to Kafka.

The default run collects five-minute AEMO NEM dispatch prices from the public
NEMWeb ZIP/CSV feed (no API key), converts AUD/MWh to EUR/MWh using Frankfurter,
and also keeps the existing optional ENTSO-E and Elecz feeds. Messages use the
shared timestamp/zone/price/source contract consumed by Databricks and VoltScope.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import os
import re
import time
import zipfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable
from urllib.parse import urljoin

import requests

TOPIC = "energy-prices"
AEMO_CURRENT_URL = "https://www.nemweb.com.au/Reports/CURRENT/DispatchIS_Reports/"
AEMO_REGIONS = {"NSW1", "QLD1", "VIC1", "SA1", "TAS1"}
DEFAULT_AEMO_REGIONS = ("NSW1", "QLD1", "VIC1", "SA1", "TAS1")
FX_CACHE: dict[str, float] = {}


@dataclass(frozen=True)
class ZoneConfig:
    zone: str
    country: str
    market: str
    entsoe: str | None = None
    elecz: str | None = None
    aemo: bool = False


# Australian regions use the AEMO region codes verbatim as dashboard zones.
ZONE_REGISTRY: dict[str, ZoneConfig] = {
    "NSW1": ZoneConfig("NSW1", "AU", "dispatch", aemo=True),
    "QLD1": ZoneConfig("QLD1", "AU", "dispatch", aemo=True),
    "VIC1": ZoneConfig("VIC1", "AU", "dispatch", aemo=True),
    "SA1": ZoneConfig("SA1", "AU", "dispatch", aemo=True),
    "TAS1": ZoneConfig("TAS1", "AU", "dispatch", aemo=True),
    "DE_LU": ZoneConfig("DE_LU", "DE", "day-ahead", "DE_LU", "DE"),
    "NL": ZoneConfig("NL", "NL", "day-ahead", "NL", "NL"),
    "BE": ZoneConfig("BE", "BE", "day-ahead", "BE", "BE"),
    "AT": ZoneConfig("AT", "AT", "day-ahead", "AT", "AT"),
    "FR": ZoneConfig("FR", "FR", "day-ahead", "FR", "FR"),
    "PL": ZoneConfig("PL", "PL", "day-ahead", "PL", "PL"),
    "CH": ZoneConfig("CH", "CH", "day-ahead", "CH"),
    "CZ": ZoneConfig("CZ", "CZ", "day-ahead", "CZ"),
    "SK": ZoneConfig("SK", "SK", "day-ahead", "SK"),
    "HU": ZoneConfig("HU", "HU", "day-ahead", "HU"),
    "SI": ZoneConfig("SI", "SI", "day-ahead", "SI"),
    "ES": ZoneConfig("ES", "ES", "day-ahead", "ES", "ES"),
    "PT": ZoneConfig("PT", "PT", "day-ahead", "PT"),
    "SE1": ZoneConfig("SE1", "SE", "day-ahead", "SE_1", "SE1"),
    "SE2": ZoneConfig("SE2", "SE", "day-ahead", "SE_2", "SE2"),
    "SE3": ZoneConfig("SE3", "SE", "day-ahead", "SE_3", "SE3"),
    "SE4": ZoneConfig("SE4", "SE", "day-ahead", "SE_4", "SE4"),
    "NO1": ZoneConfig("NO1", "NO", "day-ahead", "NO_1", "NO1"),
    "NO2": ZoneConfig("NO2", "NO", "day-ahead", "NO_2", "NO2"),
    "NO3": ZoneConfig("NO3", "NO", "day-ahead", "NO_3", "NO3"),
    "NO4": ZoneConfig("NO4", "NO", "day-ahead", "NO_4", "NO4"),
    "NO5": ZoneConfig("NO5", "NO", "day-ahead", "NO_5", "NO5"),
    "DK1": ZoneConfig("DK1", "DK", "day-ahead", "DK_1", "DK1"),
    "DK2": ZoneConfig("DK2", "DK", "day-ahead", "DK_2", "DK2"),
    "FI": ZoneConfig("FI", "FI", "day-ahead", "FI"),
    "EE": ZoneConfig("EE", "EE", "day-ahead", "EE"),
    "LV": ZoneConfig("LV", "LV", "day-ahead", "LV"),
    "LT": ZoneConfig("LT", "LT", "day-ahead", "LT"),
    "HR": ZoneConfig("HR", "HR", "day-ahead", "HR"),
    "RO": ZoneConfig("RO", "RO", "day-ahead", "RO"),
    "BG": ZoneConfig("BG", "BG", "day-ahead", "BG"),
    "GR": ZoneConfig("GR", "GR", "day-ahead", "GR"),
    "RS": ZoneConfig("RS", "RS", "day-ahead", "RS"),
    "BA": ZoneConfig("BA", "BA", "day-ahead", "BA"),
    "ME": ZoneConfig("ME", "ME", "day-ahead", "ME"),
    "MK": ZoneConfig("MK", "MK", "day-ahead", "MK"),
    "AL": ZoneConfig("AL", "AL", "day-ahead", "AL"),
    "XK": ZoneConfig("XK", "XK", "day-ahead", "XK"),
    "MD": ZoneConfig("MD", "MD", "day-ahead", "MD"),
    "UA": ZoneConfig("UA", "UA", "day-ahead", "UA"),
    "IE_SEM": ZoneConfig("IE_SEM", "IE", "day-ahead", "IE_SEM"),
    "IT_NORD": ZoneConfig("IT_NORD", "IT", "day-ahead", "IT_NORD"),
    "IT_CNOR": ZoneConfig("IT_CNOR", "IT", "day-ahead", "IT_CNOR"),
    "IT_CSUD": ZoneConfig("IT_CSUD", "IT", "day-ahead", "IT_CSUD"),
    "IT_SUD": ZoneConfig("IT_SUD", "IT", "day-ahead", "IT_SUD"),
    "IT_SICI": ZoneConfig("IT_SICI", "IT", "day-ahead", "IT_SICI"),
    "IT_SARD": ZoneConfig("IT_SARD", "IT", "day-ahead", "IT_SARD"),
    "IT_CALA": ZoneConfig("IT_CALA", "IT", "day-ahead", "IT_CALA"),
}

ZONE_ALIASES = {
    "DE": "DE_LU", "DE-LU": "DE_LU",
    "SE_1": "SE1", "SE_2": "SE2", "SE_3": "SE3", "SE_4": "SE4",
    "NO_1": "NO1", "NO_2": "NO2", "NO_3": "NO3", "NO_4": "NO4", "NO_5": "NO5",
    "DK_1": "DK1", "DK_2": "DK2",
}
DEFAULT_ENTSOE_ZONES = tuple(zone for zone, config in ZONE_REGISTRY.items() if config.entsoe)
DEFAULT_ELECZ_ZONES = ("DE_LU",)


def retry_call(label: str, func: Callable[[], Any], attempts: int = 3, base_delay: float = 2.0) -> Any:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return func()
        except Exception as exc:
            last_error = exc
            if attempt < attempts:
                delay = base_delay * attempt
                print(f"{label} attempt {attempt}/{attempts} failed: {exc}. Retrying in {delay:.0f}s")
                time.sleep(delay)
    raise last_error  # type: ignore[misc]


def parse_zones(raw: str | None, defaults: tuple[str, ...], *, all_zones: tuple[str, ...] | None = None) -> list[str]:
    values = defaults if raw is None or not raw.strip() else all_zones if raw.strip().lower() == "all" else raw.split(",")
    zones = []
    for value in values:
        zone = ZONE_ALIASES.get(value.strip().upper().replace(" ", ""), value.strip().upper().replace(" ", ""))
        if zone not in ZONE_REGISTRY:
            raise ValueError(f"Unknown zone {value!r}. Known zones: {', '.join(sorted(ZONE_REGISTRY))}")
        if zone not in zones:
            zones.append(zone)
    return zones


def fetch_aud_per_eur() -> float:
    if "aud" not in FX_CACHE:
        response = requests.get("https://api.frankfurter.app/latest", params={"from": "EUR", "to": "AUD"}, timeout=20)
        response.raise_for_status()
        rate = float(response.json()["rates"]["AUD"])
        if not math.isfinite(rate) or rate <= 0:
            raise RuntimeError(f"Invalid AUD/EUR rate: {rate!r}")
        FX_CACHE["aud"] = rate
        print(f"FX: 1 EUR = {rate:.4f} AUD (Frankfurter)")
    return FX_CACHE["aud"]


def parse_aemo_csv(content: bytes) -> list[dict[str, Any]]:
    """Parse the C/I/D/F dispatch CSV, preserving the file's named columns."""
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            names = [name for name in archive.namelist() if name.lower().endswith(".csv")]
            if not names:
                raise ValueError("ZIP contains no CSV report")
            text = archive.read(names[0]).decode("utf-8-sig", errors="replace")
    except (zipfile.BadZipFile, OSError) as exc:
        raise ValueError(f"invalid AEMO dispatch ZIP: {exc}") from exc

    headers: dict[tuple[str, str], list[str]] = {}
    latest: dict[str, dict[str, Any]] = {}
    for cells in csv.reader(io.StringIO(text)):
        if len(cells) < 4:
            continue
        kind, report, table = cells[:3]
        key = (report, table)
        if kind == "I":
            headers[key] = cells[4:]
            continue
        if kind != "D" or table != "PRICE" or key not in headers:
            continue
        values = dict(zip(headers[key], cells[4:]))
        region = values.get("REGIONID", "").strip().upper()
        if region not in AEMO_REGIONS or values.get("INTERVENTION") != "0":
            continue
        try:
            price = float(values["RRP"])
            local_timestamp = datetime.strptime(values["SETTLEMENTDATE"], "%Y/%m/%d %H:%M:%S")
            timestamp = local_timestamp.replace(tzinfo=timezone(timedelta(hours=10)))
        except (KeyError, TypeError, ValueError):
            continue
        if math.isfinite(price) and (region not in latest or timestamp > latest[region]["timestamp"]):
            latest[region] = {"timestamp": timestamp, "price_aud_mwh": price}

    if not latest:
        raise ValueError("no valid regional DISPATCH PRICE rows found")
    return [{"zone": region, **row} for region, row in sorted(latest.items())]


def fetch_aemo_prices() -> list[dict[str, Any]]:
    """Fetch and parse the newest public AEMO five-minute dispatch ZIP."""
    def fetch() -> list[dict[str, Any]]:
        response = requests.get(AEMO_CURRENT_URL, timeout=30)
        response.raise_for_status()
        links = re.findall(r'href=["\']([^"\']*PUBLIC_DISPATCHIS_[^"\']+\.zip)["\']', response.text, re.IGNORECASE)
        if not links:
            links = re.findall(r"(PUBLIC_DISPATCHIS_[A-Za-z0-9_]+\.zip)", response.text, re.IGNORECASE)
        if not links:
            raise RuntimeError("AEMO NEMWeb current directory has no dispatch ZIP files")
        latest = max(links, key=lambda name: re.search(r"DISPATCHIS_(\d{12})", name, re.IGNORECASE).group(1))
        report = requests.get(urljoin(AEMO_CURRENT_URL, latest), timeout=45)
        report.raise_for_status()
        return parse_aemo_csv(report.content)

    return retry_call("AEMO NEMWeb", fetch)


def fetch_aemo_messages(regions: list[str]) -> list[dict[str, Any]]:
    if not regions:
        return []
    aud_per_eur = fetch_aud_per_eur()
    rows = fetch_aemo_prices()
    messages = []
    for row in rows:
        if row["zone"] not in regions:
            continue
        messages.append({
            "timestamp": row["timestamp"].astimezone(timezone.utc).isoformat(),
            "zone": row["zone"],
            "price": round(row["price_aud_mwh"] / aud_per_eur, 6),
            "source": "aemo",
            "country": "AU",
            "market": "five-minute dispatch",
            "price_local": round(row["price_aud_mwh"], 6),
            "unit_local": "AUD/MWh",
            "fx_rate": round(aud_per_eur, 6),
        })
    return messages


def fetch_elecz_zone(zone: str) -> dict[str, Any] | None:
    config = ZONE_REGISTRY[zone]
    if not config.elecz:
        return None
    response = requests.get(f"https://elecz.com/signal/spot?zone={config.elecz}", timeout=30)
    response.raise_for_status()
    data = response.json()
    raw_price = data.get("price", data.get("spot_price"))
    if raw_price is None:
        return None
    price = float(raw_price)
    if not math.isfinite(price):
        return None
    currency = str(data.get("currency") or "EUR").upper()
    if currency != "EUR":
        print(f"Elecz {zone} returned {currency}; skipping because no FX conversion is configured.")
        return None
    unit = str(data.get("unit") or "").strip().lower()
    factors = {"c/kwh": 10, "ct/kwh": 10, "cent/kwh": 10, "eur/mwh": 1, "€/mwh": 1, "eur/kwh": 1000, "€/kwh": 1000}
    if unit not in factors:
        print(f"Elecz {zone} returned unknown unit {data.get('unit')!r}; skipping.")
        return None
    return {
        "timestamp": str(data.get("timestamp") or datetime.now(timezone.utc).isoformat()),
        "zone": config.elecz,
        "price": round(price * factors[unit], 6),
        "source": "elecz",
        "country": config.country,
        "market": "spot",
    }


def fetch_entsoe_zone(client: Any, zone: str, lookback_hours: int) -> dict[str, Any] | None:
    import pandas as pd

    config = ZONE_REGISTRY[zone]
    end = pd.Timestamp(datetime.now(timezone.utc))
    start = end - pd.Timedelta(hours=lookback_hours)
    prices = retry_call(
        f"ENTSO-E {zone}", lambda: client.query_day_ahead_prices(config.entsoe, start=start, end=end)
    ).dropna()
    if prices.empty:
        return None
    price = float(prices.iloc[-1])
    if not math.isfinite(price):
        return None
    timestamp = prices.index[-1]
    if timestamp.tzinfo is None:
        timestamp = timestamp.tz_localize("UTC")
    else:
        timestamp = timestamp.tz_convert("UTC")
    return {
        "timestamp": timestamp.isoformat(), "zone": zone, "price": price,
        "source": "entsoe", "country": config.country, "market": config.market,
    }


def build_producer():
    from confluent_kafka import Producer

    return Producer({
        "bootstrap.servers": os.environ["KAFKA_BOOTSTRAP"],
        "security.protocol": "SASL_SSL",
        "sasl.mechanism": "SCRAM-SHA-256",
        "sasl.username": os.environ.get("KAFKA_USERNAME", "avnadmin"),
        "sasl.password": os.environ["KAFKA_PASSWORD"],
        "ssl.ca.location": os.environ.get("KAFKA_CA_LOCATION", "aiven_ca.pem"),
    })


def send_to_kafka(producer: Any, message: dict[str, Any]) -> None:
    producer.produce(TOPIC, json.dumps(message).encode("utf-8"))
    producer.poll(0)


def run(zones_elecz: list[str], zones_entsoe: list[str], zones_aemo: list[str], lookback_hours: int, dry_run: bool) -> int:
    messages: list[dict[str, Any]] = []
    failures = 0
    try:
        messages.extend(fetch_aemo_messages(zones_aemo))
    except Exception as exc:
        failures += 1
        print(f"AEMO fetch failed: {exc}")

    for zone in zones_elecz:
        try:
            message = fetch_elecz_zone(zone)
            if message:
                messages.append(message)
        except Exception as exc:
            failures += 1
            print(f"Elecz fetch failed for {zone}: {exc}")

    api_key = env_str("ENTSOE_API_KEY")
    if zones_entsoe and api_key:
        from entsoe import EntsoePandasClient

        client = EntsoePandasClient(api_key=api_key)
        for zone in zones_entsoe:
            try:
                message = fetch_entsoe_zone(client, zone, lookback_hours)
                if message:
                    messages.append(message)
            except Exception as exc:
                failures += 1
                print(f"ENTSO-E fetch failed for {zone}: {exc}")
    elif zones_entsoe:
        print("ENTSOE_API_KEY not set, skipping ENTSO-E zones.")

    if not messages:
        print(f"No messages produced; {failures} feed failure(s).")
        return 1

    if dry_run:
        for message in messages:
            print(f"Dry: {json.dumps(message)}")
        print(f"Dry run: {len(messages)} message(s); nothing produced to Kafka.")
        return 0

    producer = build_producer()
    for message in messages:
        send_to_kafka(producer, message)
    undelivered = producer.flush(30)
    if undelivered:
        print(f"Kafka flush ended with {undelivered} message(s) undelivered.")
        return 1
    print(f"Produced {len(messages)} message(s) to {TOPIC}; {failures} feed failure(s).")
    return 0


def list_zones() -> None:
    print(f"{'ZONE':<8} {'COUNTRY':<8} {'MARKET':<24} {'ENTSO-E':<8} {'ELECZ':<6} {'AEMO':<6}")
    for zone, config in ZONE_REGISTRY.items():
        print(f"{zone:<8} {config.country:<8} {config.market:<24} {config.entsoe or '-':<8} {config.elecz or '-':<6} {'yes' if config.aemo else '-':<6}")


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


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fetch public electricity prices and optionally produce them to Kafka")
    parser.add_argument("--list-zones", action="store_true", help="Print supported regions and exit")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and print without Kafka credentials")
    parser.add_argument("--zone", help="Comma-separated zones for all feeds, e.g. NSW1,SA1 or DE_LU")
    parser.add_argument("--aemo-regions", default=env_str("AEMO_REGIONS"), help="AEMO regions, comma-separated or all")
    parser.add_argument("--entsoe-zones", default=env_str("ENTSOE_ZONES"), help="ENTSO-E zones, comma-separated or all")
    parser.add_argument("--elecz-zones", default=env_str("ELECZ_ZONES"), help="Elecz zones, comma-separated or all")
    parser.add_argument("--lookback-hours", type=int, default=env_int("ENTSOE_LOOKBACK_HOURS", 48))
    parser.add_argument(
        "--live",
        action="store_true",
        help="High-cadence mode: fetch AEMO dispatch and Elecz spot, skip day-ahead ENTSO-E",
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
            selected = parse_zones(args.zone, DEFAULT_AEMO_REGIONS, all_zones=tuple(ZONE_REGISTRY))
            zones_aemo = [zone for zone in selected if ZONE_REGISTRY[zone].aemo]
            zones_entsoe = [zone for zone in selected if ZONE_REGISTRY[zone].entsoe]
            zones_elecz = [zone for zone in selected if ZONE_REGISTRY[zone].elecz]
        else:
            zones_aemo = parse_zones(args.aemo_regions, DEFAULT_AEMO_REGIONS, all_zones=DEFAULT_AEMO_REGIONS)
            zones_entsoe = parse_zones(args.entsoe_zones, DEFAULT_ENTSOE_ZONES, all_zones=DEFAULT_ENTSOE_ZONES)
            zones_elecz = parse_zones(args.elecz_zones, DEFAULT_ELECZ_ZONES, all_zones=DEFAULT_ELECZ_ZONES)
    except ValueError as exc:
        print(f"error: {exc}")
        return 2
    zones_aemo = [zone for zone in zones_aemo if ZONE_REGISTRY[zone].aemo]
    zones_entsoe = [zone for zone in zones_entsoe if ZONE_REGISTRY[zone].entsoe]
    zones_elecz = [zone for zone in zones_elecz if ZONE_REGISTRY[zone].elecz]
    if args.live:
        # Day-ahead feeds publish once a day. Polling them every five minutes
        # wastes API quota and adds no freshness, so the live lane skips them
        # and the full scheduled run keeps them current.
        zones_entsoe = []
        print("Live mode: day-ahead ENTSO-E zones are skipped; the 30-minute run covers them.")
    print(f"Zones: AEMO={','.join(zones_aemo) or '-'} ENTSO-E={','.join(zones_entsoe) or '-'} Elecz={','.join(zones_elecz) or '-'}")
    return run(zones_elecz, zones_entsoe, zones_aemo, args.lookback_hours, args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())
