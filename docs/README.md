# VoltScope dashboard

Live site: https://mdsaifedu.eu.cc/Energy-realtime/
(the account's Pages custom domain; the `github.io` project URL redirects here).

This folder is the GitHub Pages site. It is plain HTML/CSS/JS: no build step,
no npm install, no server. Three.js is vendored under
`assets/vendor/three/` and served from the same origin.

## System diagrams

The same Pages site hosts the architecture and data-flow diagrams:

- Gallery: <https://mdsaifedu.eu.cc/Energy-realtime/diagrams/>
- Architecture: <https://mdsaifedu.eu.cc/Energy-realtime/diagrams/architecture.html>
- Data flow: <https://mdsaifedu.eu.cc/Energy-realtime/diagrams/dataflow.html>
- Editorial pipeline: <https://mdsaifedu.eu.cc/Energy-realtime/diagrams/pipeline.html>

The interactive diagrams are generated from `diagrams/specs/*.json` with
Archify. See [`diagrams/README.md`](diagrams/README.md) for regeneration and
screenshot commands.

## How the data reaches the page

```
AEMO five-region NEM dispatch + ENTSO-E + Elecz
      │  producer_dual.py (GitHub Action, every 30 min)
      ▼
   Aiven Kafka  ──►  Databricks notebook (kafka_ingest.ipynb)
                         └─► workspace.default.energy_prices_realtime
                                   │
                                   │  publish_dashboard.yml + Databricks SQL Statement API
                                   ▼
                         docs/data/index.json + days/*.json  (committed)
                                   │
                                   ▼
                        GitHub Pages ──► browser polls every 60 s
```

The Databricks token stays in GitHub Actions secrets. The browser only reads
static JSON files, so the page can be public without exposing credentials.

The exporter publishes the manifest and the day shards together. The manifest
is small (dates, row counts, time bounds) and is revalidated every 60 seconds;
day files for completed UTC days are immutable. The dashboard reads the
manifest, then downloads only the days inside the selected date range.

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
    "sources": ["aemo", "elecz", "entsoe"],
    "zones": ["DE", "DE_LU", "NSW1", "QLD1", "SA1", "TAS1", "VIC1"],
    "currency": "EUR/MWh",
    "latest_timestamp": "2026-10-28T16:00:00Z",
    "latest_timestamp_ms": 1793203200000
  },
  "points": [
    { "t": 1793158423413, "z": "DE", "p": 20.9779, "s": "elecz" },
    { "t": 1793203200000, "z": "NSW1", "p": 78.326, "s": "aemo" }
  ]
}
```

`t` is epoch milliseconds (UTC), `p` is the price, `z` is the bidding zone and
`s` is the feed. The page flattens duplicate `(source, zone, timestamp)` tuples
and sorts by time. AEMO points use the five NEM region codes (`NSW1`, `QLD1`,
`VIC1`, `SA1`, `TAS1`). Their source values are AUD/MWh and are converted to
EUR/MWh before being written to the common price contract.

`energy.json` stays published as the full-window artifact and as the fallback
when shards are missing. The dashboard normally reads the shards instead:

`data/index.json` (manifest, schema 2)

```json
{
  "schema_version": 2,
  "generated_at": "2026-10-29T05:23:36Z",
  "mode": "live",
  "meta": { "row_count": 79968, "day_count": 30, "sharded": true },
  "days": [
    {
      "date": "2026-10-28",
      "file": "days/2026-10-28.json",
      "rows": 2303,
      "first_ms": 1793145600000,
      "last_ms": 1793231999000,
      "bytes": 41234
    }
  ]
}
```

`data/days/YYYY-MM-DD.json` (one UTC day, compact)

```json
{
  "date": "2026-10-28",
  "schema_version": 1,
  "sources": ["elecz", "entsoe"],
  "zones": ["DE", "DE_LU"],
  "rows": [[1793145600000, 1, 20.9779, 0]]
}
```

A row is `[t, zone_index, price, source_index]`; the indexes point into the
`sources` and `zones` string tables. This halves the payload versus repeated
object keys. Past day files never change, so the CDN can cache them; only the
manifest and the newest day are revalidated.

## Filters and interactions

- Hover a column for the reading; click to pin it in **Focus**.
- **Zone focus** starts on the 12 busiest zones (one pick per feed) so the stage
  and timeline stay readable. Pick **All zones** or a single zone to widen it.
- **Date range** (`From` / `To`) loads only the selected UTC days. Presets
  (`6h`, `24h`, `7d`, `30d`, `All`) return to a rolling window.
- Drag across the timeline to brush a window; double-click to clear.
- Replay animates the session; `Space` toggles it.
- Camera presets: `1` overview, `2` profile, `3` top.
- `F` focuses a pinned column, `R` refreshes, `L` toggles auto refresh.
- Window baseline trims the vertical axis to the session range; Zero baseline
  keeps a truthful origin, including negative prices.
- Indexed mode rebases each zone to 100 so different price levels compare.

Filter state lives in the URL hash, so **Share** copies a reproducible session.

## Export locally

```bash
export DATABRICKS_HOST=https://dbc-xxxx.cloud.databricks.com
export DATABRICKS_TOKEN=...            # never commit
export DATABRICKS_WAREHOUSE_ID=...
python scripts/export_dashboard_data.py --window-days 30 --out docs/data/energy.json
```

Useful flags: `--wait-new-data 300` waits for a newer row before publishing,
`--dry-run` validates without writing, `--max-rows 80000` caps payload size.
The exporter also writes `docs/data/index.json` and `docs/data/days/*.json`.
To rebuild shards from an existing snapshot without Databricks:

```bash
python scripts/dashboard_shards.py docs/data/energy.json --out docs/data
```

## Setup checklist

1. Add repository variable `DATABRICKS_WAREHOUSE_ID` (Settings → Secrets and
   variables → Actions → Variables).
2. Keep secrets `DATABRICKS_HOST` and `DATABRICKS_TOKEN`. AEMO NEMWeb and its
   daily Frankfurter currency reference need no API credentials. Configure
   `KAFKA_BOOTSTRAP`, `KAFKA_PASSWORD`, and `KAFKA_CA_PEM` for producer runs.
3. Enable Pages: Settings → Pages → Source: **Deploy from a branch** →
   branch `main`, folder `/docs`.
4. Run **Energy Market Data to Kafka**, then **Publish Dashboard Snapshot**
   from the Actions tab to verify the configured ingestion and publishing path.

If the export has not run yet, the page renders a deterministic demo snapshot
and clearly labels it as demo data.
