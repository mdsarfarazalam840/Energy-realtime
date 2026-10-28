# VoltScope dashboard

Live site: https://mdsaifedu.eu.cc/Energy-realtime/
(the account's Pages custom domain; the `github.io` project URL redirects here).

This folder is the GitHub Pages site. It is plain HTML/CSS/JS: no build step,
no npm install, no server. Three.js is pinned from jsDelivr.

## How the data reaches the page

```
ENTSO-E + Elecz
      │  producer_dual.py (GitHub Action, every 30 min)
      ▼
   Aiven Kafka  ──►  Databricks notebook (kafka_ingest.ipynb)
                        └─► workspace.default.energy_prices_realtime
                                  │
                                  │  publish_dashboard.yml + Databricks SQL Statement API
                                  ▼
                        docs/data/energy.json  (committed snapshot)
                                  │
                                  ▼
                        GitHub Pages ──► browser polls every 60 s
```

The Databricks token stays in GitHub Actions secrets. The browser only reads a
small static JSON file, so the page can be public without exposing credentials.

## Local preview

```bash
python -m http.server 8000 --directory docs
# open http://localhost:8000
```

Open `index.html` through a server, not `file://`, because ES modules and
`fetch` need an origin.

## Snapshot schema

```json
{
  "schema_version": 1,
  "generated_at": "2026-10-28T05:23:36Z",
  "mode": "live",
  "meta": {
    "table": "workspace.default.energy_prices_realtime",
    "row_count": 12,
    "sources": ["elecz", "entsoe"],
    "zones": ["DE", "DE_LU"],
    "currency": "EUR/MWh",
    "latest_timestamp": "2026-10-28T03:33:43Z",
    "latest_timestamp_ms": 1793158423413
  },
  "points": [
    { "t": 1793158423413, "z": "DE", "p": 20.9779, "s": "elecz" }
  ]
}
```

`t` is epoch milliseconds (UTC), `p` is the price, `z` is the bidding zone and
`s` is the feed. The page flattens duplicate `(source, timestamp)` pairs and
sorts by time.

## Filters and interactions

- Hover a column for the reading; click to pin it in **Focus**.
- Drag across the timeline to brush a window; double-click to clear.
- Replay animates the session; `Space` toggles it.
- Camera presets: `1` overview, `2` profile, `3` top.
- `F` focuses a pinned column, `R` refreshes, `L` toggles auto refresh.
- Window baseline trims the vertical axis to the session range; Zero baseline
  keeps a truthful origin, including negative prices.
- Indexed mode rebases each feed to 100 so different price levels compare.

Filter state lives in the URL hash, so **Share** copies a reproducible session.

## Export locally

```bash
export DATABRICKS_HOST=https://dbc-xxxx.cloud.databricks.com
export DATABRICKS_TOKEN=...            # never commit
export DATABRICKS_WAREHOUSE_ID=...
python scripts/export_dashboard_data.py --window-days 30 --out docs/data/energy.json
```

Useful flags: `--wait-new-data 300` waits for a newer row before publishing,
`--dry-run` validates without writing, `--max-rows 20000` caps payload size.

## Setup checklist

1. Add repository variable `DATABRICKS_WAREHOUSE_ID` (Settings → Secrets and
   variables → Actions → Variables).
2. Keep secrets `DATABRICKS_HOST`, `DATABRICKS_TOKEN` (already used by the
   producer workflow).
3. Enable Pages: Settings → Pages → Source: **Deploy from a branch** →
   branch `main`, folder `/docs`.
4. Run **Publish Dashboard Snapshot** once from the Actions tab.

If the export has not run yet, the page renders a deterministic demo snapshot
and clearly labels it as demo data.
