"""Offline integrity validation for the published finance snapshot.

Mirrors the assertions in tests/test_edgar_export.py (offline, no network,
no Databricks) plus a check that all expected tickers are present.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT = ROOT / "docs" / "data" / "finance.json"

REQUIRED_FORMS = ("10-K", "10-Q", "8-K", "DEF 14A", "20-F", "40-F", "6-K")

EXPECTED_TICKERS = {
    "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "JPM", "V",
    "JNJ", "WMT", "XOM", "UNH", "PG", "MA", "HD", "CVX", "ABBV", "KO",
    "COST", "AVGO", "LLY", "PEP", "MRK", "NFLX", "AMD", "CRM",
}


def main() -> int:
    doc = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    assert doc.get("mode") == "live", f"mode={doc.get('mode')!r}"
    assert doc.get("schema_version") == 1, doc.get("schema_version")
    meta = doc["meta"]
    assert meta.get("source") == "sec-edgar"
    assert meta.get("latest_filed"), meta.get("latest_filed")

    companies = doc["companies"]
    filings = doc["filings"]
    tickers = {c["ticker"] for c in companies}
    assert len(tickers) == len(companies), "duplicate tickers in snapshot"

    missing = EXPECTED_TICKERS - tickers
    assert not missing, f"missing tickers: {sorted(missing)}"

    for c in companies:
        cik = c["cik"]
        assert len(cik) == 10 and cik.isdigit(), cik
        assert c["filings_url"].startswith("https://www.sec.gov/"), c["filings_url"]
        for rows in c["series"].values():
            assert all(len(row) == 2 for row in rows), c["ticker"]
        revenue = c["series"].get("revenue", [])
        assert c["latest"], f"empty latest for {c['ticker']}"
        if revenue:
            years = [row[0] for row in revenue]
            assert years == sorted(years), c["ticker"]
            assert c["latest"]["revenue"] == revenue[-1][1], c["ticker"]
            assert c["fiscal_year"] == revenue[-1][0], c["ticker"]
        assert set(c["ratios"]) == {
            "net_margin", "return_on_equity", "liability_ratio", "revenue_growth",
        }, c["ticker"]
        for value in c["latest"].values():
            if value is not None:
                assert isinstance(value, (int, float)) and value == value, "NaN/Non-numeric in latest"

    for f in filings:
        assert f["ticker"] in tickers
        assert f["form"] in REQUIRED_FORMS, f["form"]
        assert f["url"].startswith("https://www.sec.gov/Archives/edgar/data/"), f["url"]

    print(
        f"OK: {len(companies)} companies, {len(filings)} filings, "
        f"latest_filed={meta.get('latest_filed')}, generated_at={doc.get('generated_at')}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
