"""Offline tests for the SEC EDGAR exporter and the published finance snapshot.

The exporter is standard-library only, so these tests use the recorded fixtures
in `fixtures/edgar/` instead of touching sec.gov.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "fixtures" / "edgar"
PUBLISHED = ROOT / "docs" / "data" / "finance.json"

spec = importlib.util.spec_from_file_location("export_edgar_data", ROOT / "scripts" / "export_edgar_data.py")
assert spec and spec.loader
edgar = importlib.util.module_from_spec(spec)
spec.loader.exec_module(edgar)


def load_fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


class FakeClient:
    """Stand-in for EdgarClient that serves recorded responses by URL."""

    def __init__(self, responses: dict[str, dict]):
        self.responses = responses
        self.request_count = 0

    def fetch_json(self, url: str):
        if url not in self.responses:
            raise AssertionError(f"unexpected URL: {url}")
        self.request_count += 1
        return self.responses[url]


def fake_responses() -> dict[str, dict]:
    return {
        edgar.TICKERS_URL: load_fixture("company_tickers.json"),
        edgar.SUBMISSIONS_URL.format(cik="0000000001"): load_fixture("CIK0000000001_submissions.json"),
        edgar.FACTS_URL.format(cik="0000000001"): load_fixture("CIK0000000001_facts.json"),
        edgar.SUBMISSIONS_URL.format(cik="0000000002"): load_fixture("CIK0000000002_submissions.json"),
        edgar.FACTS_URL.format(cik="0000000002"): load_fixture("CIK0000000002_facts.json"),
    }


def test_cik10_normalizes_and_rejects_bad_values():
    assert edgar.cik10(320193) == "0000320193"
    assert edgar.cik10("0000320193") == "0000320193"
    with pytest.raises(ValueError):
        edgar.cik10("not-a-cik")


@pytest.mark.parametrize(
    ("sic", "sector"),
    [("3571", "Technology"), ("7372", "Technology"), ("2836", "Healthcare"), ("6324", "Healthcare"),
     ("6021", "Financials"), ("1311", "Energy"), ("5411", "Retail"), (None, "Unclassified")],
)
def test_sector_mapping(sic, sector):
    assert edgar.sector_for_sic(sic) == sector


def test_annual_series_merges_tags_and_drops_quarterly_rows():
    facts = load_fixture("CIK0000000001_facts.json")
    series = edgar.annual_series(facts, edgar.REVENUE_TAGS, limit=8)
    # 2023 comes from the older tag, 2024 keeps the restated value from the
    # newer filing, and the 2025 Q1 row inside the 10-K must be dropped.
    assert series == [[2023, 90_000_000_000.0], [2024, 101_000_000_000.0], [2025, 120_000_000_000.0]]


def test_instant_series_reads_balance_sheet_rows():
    facts = load_fixture("CIK0000000001_facts.json")
    assert edgar.instant_series(facts, ("Assets",)) == [[2024, 200_000_000_000.0], [2025, 210_000_000_000.0]]
    assert edgar.instant_series(facts, ("MissingTag",)) == []


def test_quarterly_series_keeps_single_quarter_periods():
    facts = load_fixture("CIK0000000001_facts.json")
    assert edgar.quarterly_series(facts, edgar.REVENUE_TAGS) == [["2026-03-31", 26_000_000_000.0]]


def test_build_metrics_computes_ratios():
    metrics = edgar.build_metrics(load_fixture("CIK0000000001_facts.json"), years=8)
    assert metrics["latest"]["revenue"] == 120_000_000_000.0
    assert metrics["latest"]["net_income"] == 12_000_000_000.0
    assert metrics["latest"]["eps"] == 4.0
    assert metrics["fiscal_year"] == 2025
    assert metrics["ratios"]["net_margin"] == pytest.approx(0.1)
    assert metrics["ratios"]["return_on_equity"] == pytest.approx(12 / 55)
    assert metrics["ratios"]["revenue_growth"] == pytest.approx(120 / 101 - 1)
    assert metrics["ratios"]["liability_ratio"] == pytest.approx((210 - 55) / 210)


def test_parse_filings_builds_archive_urls_and_filters_forms():
    submissions = load_fixture("CIK0000000001_submissions.json")
    filings = edgar.parse_filings(submissions, "AAA", "0000000001")
    assert [filing["form"] for filing in filings] == ["10-Q", "8-K", "10-K"]
    assert filings[0]["url"] == (
        "https://www.sec.gov/Archives/edgar/data/1/000000000126000004/aaa-10q.htm"
    )
    assert all(filing["ticker"] == "AAA" and filing["cik"] == "0000000001" for filing in filings)
    assert len(edgar.parse_filings(submissions, "AAA", "0000000001", limit=1)) == 1


def test_company_record_dedupes_exchanges():
    submissions = load_fixture("CIK0000000001_submissions.json")
    submissions["exchanges"] = ["NYSE", "NYSE", "Nasdaq"]
    company = edgar.company_record(
        "AAA", "0000000001", submissions, load_fixture("CIK0000000001_facts.json")
    )
    assert company["exchange"] == "NYSE, Nasdaq"


def test_export_runs_end_to_end_without_network():
    client = FakeClient(fake_responses())
    logs: list[str] = []
    snapshot = edgar.export(["AAA", "BBB"], client, window_years=5, log=logs.append)

    assert client.request_count == 5
    companies = {company["ticker"]: company for company in snapshot["companies"]}
    assert set(companies) == {"AAA", "BBB"}
    assert companies["AAA"]["name"] == "ALPHA CORP"
    assert companies["AAA"]["sector"] == "Technology"
    assert companies["AAA"]["fiscal_year"] == 2025
    assert companies["BBB"]["sector"] == "Manufacturing"
    assert companies["BBB"]["series"] == {}

    assert snapshot["schema_version"] == 1
    assert snapshot["mode"] == "live"
    assert snapshot["meta"]["company_count"] == 2
    assert snapshot["meta"]["filing_count"] == 5
    assert snapshot["meta"]["latest_filed"] == "2026-05-04"
    assert snapshot["meta"]["form_counts"] == {"10-K": 1, "10-Q": 2, "8-K": 1, "DEF 14A": 1}
    assert len(logs) >= 4


def test_export_reports_unknown_tickers_without_failing():
    snapshot = edgar.export(["AAA", "ZZZ"], FakeClient(fake_responses()), log=lambda _: None)
    assert snapshot["meta"]["company_count"] == 1
    assert "ZZZ" in snapshot["meta"]["source_note"]


def test_published_snapshot_matches_the_contract():
    assert PUBLISHED.exists(), "docs/data/finance.json is missing; run scripts/export_edgar_data.py"
    snapshot = json.loads(PUBLISHED.read_text(encoding="utf-8"))

    assert snapshot["schema_version"] == 1
    assert snapshot["mode"] == "live"
    assert snapshot["demo"] is False
    meta = snapshot["meta"]
    companies = snapshot["companies"]
    filings = snapshot["filings"]

    assert meta["source"] == "sec-edgar"
    assert meta["company_count"] == len(companies) >= 20
    assert meta["filing_count"] == len(filings) >= 100
    assert meta["form_counts"]["10-K"] >= 1
    assert meta["latest_filed"]

    tickers = {company["ticker"] for company in companies}
    assert len(tickers) == len(companies)
    for company in companies:
        assert len(company["cik"]) == 10 and company["cik"].isdigit()
        assert company["filings_url"].startswith("https://www.sec.gov/")
        for rows in company["series"].values():
            assert all(len(row) == 2 for row in rows)
        revenue = company["series"].get("revenue", [])
        if revenue:
            assert [row[0] for row in revenue] == sorted(row[0] for row in revenue)
            assert company["latest"]["revenue"] == revenue[-1][1]
            assert company["fiscal_year"] == revenue[-1][0]
        assert set(company["ratios"]) == {"net_margin", "return_on_equity", "liability_ratio", "revenue_growth"}

    for filing in filings:
        assert filing["ticker"] in tickers
        assert filing["form"] in edgar.FILING_FORMS
        assert filing["url"].startswith("https://www.sec.gov/Archives/edgar/data/")
