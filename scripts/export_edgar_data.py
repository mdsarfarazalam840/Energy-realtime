"""Export SEC EDGAR company facts and filings to a static finance snapshot.

The exporter is standard-library only. It reads the keyless, public EDGAR
endpoints and writes a compact `finance.json` that the static GitHub Pages
dashboard loads, so no SEC credential and no server reach the browser.

Endpoints (all free, no API key):

  https://www.sec.gov/files/company_tickers.json
  https://data.sec.gov/submissions/CIK##########.json
  https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json

SEC asks every automated client to identify itself and to stay below 10
requests per second. Set `SEC_USER_AGENT` to "App name contact@example.com"
before a real run.

Usage:
    python scripts/export_edgar_data.py --out docs/data/finance.json
    python scripts/export_edgar_data.py --tickers AAPL,MSFT,NVDA --dry-run
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik}.json"
FACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json"
ARCHIVE_URL = "https://www.sec.gov/Archives/edgar/data/{cik_int}/{accession_flat}/{document}"

DEFAULT_USER_AGENT = "VoltScope Research voltscope@example.com"
DEFAULT_TICKERS = [
    "AAPL",
    "MSFT",
    "NVDA",
    "GOOGL",
    "AMZN",
    "META",
    "TSLA",
    "JPM",
    "V",
    "JNJ",
    "WMT",
    "XOM",
    "UNH",
    "PG",
    "MA",
    "HD",
    "CVX",
    "ABBV",
    "KO",
    "COST",
    "AVGO",
    "LLY",
    "PEP",
    "MRK",
    "NFLX",
    "AMD",
    "CRM",
]

FILING_FORMS = ("10-K", "10-Q", "8-K", "DEF 14A", "20-F", "40-F", "6-K")
# Ordered by preference: filers use different revenue tags over time.
REVENUE_TAGS = (
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
)
METRIC_TAGS = {
    "revenue": REVENUE_TAGS,
    "net_income": ("NetIncomeLoss", "ProfitLoss"),
    "assets": ("Assets",),
    "liabilities": ("Liabilities",),
    "equity": ("StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"),
    "eps": ("EarningsPerShareDiluted", "EarningsPerShareBasic"),
    "cash": ("CashAndCashEquivalentsAtCarryingValue",),
    "operating_cash_flow": ("NetCashProvidedByUsedInOperatingActivities",),
}
# Balance-sheet facts are instant observations, not periods, so they need a
# different de-duplication rule than revenue or cash flow.
INSTANT_METRICS = {"assets", "liabilities", "equity", "cash"}
MAX_FILINGS_PER_COMPANY = 10
MAX_SERIES_YEARS = 8


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


class EdgarClient:
    """Small throttled JSON client for the public EDGAR endpoints."""

    def __init__(self, user_agent: str = DEFAULT_USER_AGENT, min_interval: float = 0.15, retries: int = 3):
        self.user_agent = user_agent
        self.min_interval = min_interval
        self.retries = retries
        self._last_request = 0.0
        self.request_count = 0

    def _throttle(self) -> None:
        wait = self.min_interval - (time.monotonic() - self._last_request)
        if wait > 0:
            time.sleep(wait)
        self._last_request = time.monotonic()

    def fetch_json(self, url: str):
        last_error: Exception | None = None
        for attempt in range(1, self.retries + 1):
            self._throttle()
            request = urllib.request.Request(
                url,
                headers={
                    "User-Agent": self.user_agent,
                    "Accept": "application/json",
                    "Accept-Encoding": "gzip",
                },
            )
            try:
                with urllib.request.urlopen(request, timeout=45) as response:
                    self.request_count += 1
                    body = response.read()
                    if response.headers.get("Content-Encoding") == "gzip":
                        body = gzip.decompress(body)
                    return json.loads(body.decode("utf-8"))
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as error:
                last_error = error
                if attempt < self.retries:
                    time.sleep(0.6 * attempt)
        raise RuntimeError(f"EDGAR request failed: {url}: {last_error}")


# ---------------------------------------------------------------------------
# Shaping
# ---------------------------------------------------------------------------


def cik10(value) -> str:
    """Normalize a CIK to the zero-padded ten digit form used in EDGAR URLs."""
    digits = str(value or "").strip().lstrip("0") or "0"
    if not digits.isdigit():
        raise ValueError(f"invalid CIK: {value!r}")
    return digits.zfill(10)


def sector_for_sic(sic) -> str:
    """Map an SIC code to a broad sector label for filtering and colour."""
    try:
        code = int(sic)
    except (TypeError, ValueError):
        return "Unclassified"
    if 3570 <= code <= 3579 or 3670 <= code <= 3679 or 7370 <= code <= 7379 or 3826 <= code <= 3829:
        return "Technology"
    if 2830 <= code <= 2836 or 8000 <= code <= 8099 or code == 6324:
        return "Healthcare"
    if 6000 <= code <= 6411:
        return "Financials"
    if 4900 <= code <= 4991:
        return "Utilities"
    if 1300 <= code <= 1399 or 2900 <= code <= 2999:
        return "Energy"
    if 1000 <= code <= 1499:
        return "Materials"
    if 1500 <= code <= 1799:
        return "Construction"
    if 2000 <= code <= 3999:
        return "Manufacturing"
    if 4000 <= code <= 4799:
        return "Transport"
    if 4800 <= code <= 4899:
        return "Telecom"
    if 5000 <= code <= 5999:
        return "Retail"
    if 6500 <= code <= 6599:
        return "Real Estate"
    if 7000 <= code <= 7369 or 7380 <= code <= 8999:
        return "Services"
    return "Other"


def _fact_units(facts: dict, tag: str) -> list[dict]:
    """Return every reported observation for a us-gaap tag, newest units first."""
    us_gaap = (facts or {}).get("facts", {}).get("us-gaap", {})
    node = us_gaap.get(tag) or {}
    units = node.get("units") or {}
    for name in ("USD", "USD/shares", "shares"):
        if isinstance(units.get(name), list):
            return units[name]
    for rows in units.values():
        if isinstance(rows, list):
            return rows
    return []


def _period_days(row: dict) -> int | None:
    """Return the covered duration in days, or None when start/end is missing."""
    start, end = row.get("start"), row.get("end")
    if not start or not end:
        return None
    try:
        return (date.fromisoformat(str(end)) - date.fromisoformat(str(start))).days
    except ValueError:
        return None


def annual_series(facts: dict, tags, limit: int = MAX_SERIES_YEARS) -> list[list]:
    """Build a de-duplicated annual series as `[[fiscal_year, value], ...]`.

    EDGAR repeats prior-year comparatives inside each 10-K, so observations are
    keyed by period end instead of the filing's `fy` field. A 10-K also carries
    quarterly rows, which are dropped by the one-year duration check. Tags are
    merged because filers switch revenue tags over time.
    """
    by_end: dict[str, dict] = {}
    for rank, tag in enumerate(tags):
        for row in _fact_units(facts, tag):
            if row.get("form") != "10-K" or row.get("fp") != "FY":
                continue
            days = _period_days(row)
            if days is None or not 350 <= days <= 380:
                continue
            end = str(row.get("end"))
            try:
                value = float(row.get("val"))
            except (TypeError, ValueError):
                continue
            if not value:
                continue
            filed = str(row.get("filed") or "")
            current = by_end.get(end)
            if current is None or rank < current["rank"] or (rank == current["rank"] and filed >= current["filed"]):
                by_end[end] = {"value": value, "rank": rank, "filed": filed}
    if not by_end:
        return []
    rows = [[int(end[:4]), by_end[end]["value"]] for end in sorted(by_end)]
    return rows[-limit:]


def instant_series(facts: dict, tags, limit: int = MAX_SERIES_YEARS) -> list[list]:
    """Build a de-duplicated annual series for balance-sheet (instant) facts."""
    by_end: dict[str, dict] = {}
    for rank, tag in enumerate(tags):
        for row in _fact_units(facts, tag):
            if row.get("form") != "10-K":
                continue
            if row.get("start") or not row.get("end"):
                continue
            try:
                value = float(row.get("val"))
            except (TypeError, ValueError):
                continue
            if not value:
                continue
            end = str(row["end"])
            filed = str(row.get("filed") or "")
            current = by_end.get(end)
            if current is None or rank < current["rank"] or (rank == current["rank"] and filed >= current["filed"]):
                by_end[end] = {"value": value, "rank": rank, "filed": filed}
    if not by_end:
        return []
    rows = [[int(end[:4]), by_end[end]["value"]] for end in sorted(by_end)]
    return rows[-limit:]


def quarterly_series(facts: dict, tags, limit: int = 8) -> list[list]:
    """Build a recent quarterly series as `[[period_end, value], ...]`.

    Only single-quarter durations are kept, so the year-to-date rows that a
    10-Q reports beside the quarter do not double count revenue.
    """
    points: dict[str, dict] = {}
    for rank, tag in enumerate(tags):
        for row in _fact_units(facts, tag):
            if row.get("form") != "10-Q":
                continue
            days = _period_days(row)
            if days is None or not 80 <= days <= 100:
                continue
            end = str(row.get("end"))
            try:
                value = float(row.get("val"))
            except (TypeError, ValueError):
                continue
            if not value:
                continue
            filed = str(row.get("filed") or "")
            current = points.get(end)
            if current is None or rank < current["rank"] or (rank == current["rank"] and filed >= current["filed"]):
                points[end] = {"value": value, "rank": rank, "filed": filed}
    if not points:
        return []
    rows = [[end, points[end]["value"]] for end in sorted(points)]
    return rows[-limit:]


def latest_metric(series: list[list]) -> float | None:
    return float(series[-1][1]) if series else None


def growth_rate(series: list[list]) -> float | None:
    if len(series) < 2:
        return None
    latest = float(series[-1][1])
    prior = float(series[-2][1])
    if not prior:
        return None
    return latest / prior - 1.0


def ratio(numerator: float | None, denominator: float | None) -> float | None:
    if numerator is None or denominator in (None, 0):
        return None
    return numerator / denominator


def build_metrics(facts: dict, years: int = MAX_SERIES_YEARS) -> dict:
    """Extract the annual metric series and the latest ratios for one company."""
    series = {}
    for name, tags in METRIC_TAGS.items():
        build = instant_series if name in INSTANT_METRICS else annual_series
        series[name] = build(facts, tags, limit=years)
    latest = {name: latest_metric(rows) for name, rows in series.items()}

    revenue = latest.get("revenue")
    net_income = latest.get("net_income")
    equity = latest.get("equity")
    assets = latest.get("assets")
    liabilities = latest.get("liabilities")
    if liabilities is None and assets is not None and equity is not None:
        liabilities = assets - equity

    return {
        "series": {name: rows for name, rows in series.items() if rows},
        "latest": latest,
        "ratios": {
            "net_margin": ratio(net_income, revenue),
            "return_on_equity": ratio(net_income, equity),
            "liability_ratio": ratio(liabilities, assets),
            "revenue_growth": growth_rate(series.get("revenue") or []),
        },
        "fiscal_year": series["revenue"][-1][0] if series.get("revenue") else None,
        "quarterly_revenue": quarterly_series(facts, REVENUE_TAGS),
        "quarterly_net_income": quarterly_series(facts, METRIC_TAGS["net_income"]),
    }


def _recent_rows(submissions: dict) -> list[dict]:
    recent = ((submissions or {}).get("filings") or {}).get("recent") or {}
    keys = ("accessionNumber", "form", "filingDate", "reportDate", "primaryDocument", "items")
    accessions = recent.get("accessionNumber") or []
    rows = []
    for index in range(len(accessions)):
        rows.append({key: (recent.get(key) or [None] * len(accessions))[index] for key in keys})
    return rows


def parse_filings(submissions: dict, ticker: str, cik: str, limit: int = MAX_FILINGS_PER_COMPANY) -> list[dict]:
    """Pick the most recent material filings, newest first, with archive URLs."""
    cik_int = str(int(cik))
    filings = []
    for row in _recent_rows(submissions):
        form = str(row.get("form") or "")
        if form not in FILING_FORMS:
            continue
        accession = str(row.get("accessionNumber") or "")
        document = str(row.get("primaryDocument") or "")
        if not accession:
            continue
        url = ARCHIVE_URL.format(
            cik_int=cik_int,
            accession_flat=accession.replace("-", ""),
            document=document,
        )
        filings.append(
            {
                "ticker": ticker,
                "cik": cik,
                "form": form,
                "filed": str(row.get("filingDate") or ""),
                "period": str(row.get("reportDate") or ""),
                "accession": accession,
                "document": document,
                "items": str(row.get("items") or ""),
                "url": url,
            }
        )
    filings.sort(key=lambda item: (item["filed"], item["accession"]), reverse=True)
    return filings[:limit]


def company_record(ticker: str, cik: str, submissions: dict, facts: dict, years: int = MAX_SERIES_YEARS) -> dict:
    company = {
        "ticker": ticker,
        "cik": cik,
        "name": str(submissions.get("name") or facts.get("entityName") or ticker),
        "exchange": ", ".join(dict.fromkeys(submissions.get("exchanges") or [])) or "—",
        "sic": str(submissions.get("sic") or ""),
        "sic_description": str(submissions.get("sicDescription") or ""),
        "sector": sector_for_sic(submissions.get("sic")),
        "state": str(submissions.get("stateOfIncorporation") or ""),
        "fiscal_year_end": str(submissions.get("fiscalYearEnd") or ""),
        "filings_url": f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik}&type=&dateb=&owner=include&count=40",
    }
    company.update(build_metrics(facts, years))
    return company


def build_snapshot(companies: list[dict], filings: list[dict], *, generated_at: str, source_note: str = "") -> dict:
    """Assemble the published snapshot from already parsed company records."""
    companies = sorted(companies, key=lambda item: item["ticker"])
    filings = sorted(filings, key=lambda item: (item["filed"], item["accession"]), reverse=True)
    latest = max((item["filed"] for item in filings), default="")
    by_form: dict[str, int] = {}
    for item in filings:
        by_form[item["form"]] = by_form.get(item["form"], 0) + 1
    return {
        "schema_version": 1,
        "generated_at": generated_at,
        "mode": "live",
        "meta": {
            "source": "sec-edgar",
            "source_note": source_note,
            "currency": "USD",
            "company_count": len(companies),
            "filing_count": len(filings),
            "form_counts": by_form,
            "sectors": sorted({item["sector"] for item in companies}),
            "latest_filed": latest,
            "archive": "https://www.sec.gov/edgar/search/",
        },
        "companies": companies,
        "filings": filings,
        "demo": False,
    }


def export(tickers: list[str], client: EdgarClient, *, window_years: int = MAX_SERIES_YEARS, log=print) -> dict:
    """Fetch and shape one snapshot for the requested tickers."""
    years = max(2, int(window_years or MAX_SERIES_YEARS))

    log(f"Resolving {len(tickers)} tickers through company_tickers.json")
    ticker_map = client.fetch_json(TICKERS_URL)
    by_ticker = {}
    for row in ticker_map.values():
        symbol = str(row.get("ticker") or "").upper()
        if symbol:
            by_ticker[symbol] = cik10(row.get("cik_str"))
    by_ticker.setdefault("BRK.B", by_ticker.get("BRK-B", ""))

    companies: list[dict] = []
    filings: list[dict] = []
    missing: list[str] = []
    for index, ticker in enumerate(tickers, start=1):
        cik = by_ticker.get(ticker.upper())
        if not cik:
            missing.append(ticker)
            log(f"  [{index}/{len(tickers)}] {ticker}: not found")
            continue
        try:
            submissions = client.fetch_json(SUBMISSIONS_URL.format(cik=cik))
            facts = client.fetch_json(FACTS_URL.format(cik=cik))
        except RuntimeError as error:
            missing.append(ticker)
            log(f"  [{index}/{len(tickers)}] {ticker}: {error}")
            continue
        companies.append(company_record(ticker, cik, submissions, facts, years))
        filings.extend(parse_filings(submissions, ticker, cik))
        log(f"  [{index}/{len(tickers)}] {ticker}: {companies[-1]['name']}")

    note = f"missing tickers: {', '.join(missing)}" if missing else ""
    snapshot = build_snapshot(
        companies,
        filings,
        generated_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        source_note=note,
    )
    log(f"Built {snapshot['meta']['company_count']} companies and {snapshot['meta']['filing_count']} filings")
    return snapshot


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export SEC EDGAR company facts to docs/data/finance.json")
    parser.add_argument("--out", default="docs/data/finance.json", help="output JSON path")
    parser.add_argument("--tickers", default=",".join(DEFAULT_TICKERS), help="comma separated ticker list")
    parser.add_argument("--years", type=int, default=MAX_SERIES_YEARS, help="annual years to keep per series")
    parser.add_argument("--user-agent", default=None, help="SEC User-Agent, e.g. 'App name contact@example.com'")
    parser.add_argument("--dry-run", action="store_true", help="print the summary without writing")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    tickers = [item.strip().upper() for item in args.tickers.split(",") if item.strip()]
    if not tickers:
        print("No tickers requested", file=sys.stderr)
        return 2
    user_agent = args.user_agent or os.environ.get("SEC_USER_AGENT") or DEFAULT_USER_AGENT
    client = EdgarClient(user_agent=user_agent)
    try:
        snapshot = export(tickers, client, window_years=args.years)
    except RuntimeError as error:
        print(error, file=sys.stderr)
        return 1
    if args.dry_run:
        print(json.dumps(snapshot["meta"], indent=2))
        return 0
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(snapshot, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"Wrote {out} ({out.stat().st_size / 1024:.0f} KiB, {client.request_count} requests)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
