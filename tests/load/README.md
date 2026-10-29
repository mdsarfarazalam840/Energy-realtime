# Dashboard load and user tests

Test harness for the static VoltScope dashboard in `docs/`. Two questions:

1. **Load** — does the origin and the cache strategy survive thousands of concurrent visitors?
2. **Users** — does every documented interaction still work, and stay fast, at production data volume?

Both run against a local in-memory mirror of `docs/`. Nothing here touches the
live Pages host.

> **Never point a load test at `https://mdsaifedu.eu.cc/Energy-realtime/`.**
> Unsolicited load against GitHub Pages violates GitHub's Acceptable Use policy
> and can suspend the account. Serve a local mirror with `serve_docs.mjs` and
> test that instead.

---

## Files

| File | Purpose |
|---|---|
| `serve_docs.mjs` | In-memory static origin with gzip, ETag, `Cache-Control`, configurable latency and workers |
| `load_test.mjs` | Node load generator. Models a page view (shell, manifest, day shards) plus ETag revalidation polls. Computes latency percentiles and egress |
| `k6-dashboard.js` | Same journey for [k6](https://k6.io/), for external or CI runners |
| `generate_snapshot.py` | Synthetic snapshot generator at 1k, 10k, or 80k rows and up to 49 lanes |
| `ui_audit.py` | Playwright user-journey, failure-mode, date-picker, and performance audit (80+ checks, including shard and legacy fallbacks) |
| `results/` | JSON reports from the runs below; CI uploads them as `dashboard-test-reports` |

---

## Quick start

```bash
# 1. Start the local origin (keep it running)
node tests/load/serve_docs.mjs --root docs --port 8000 --workers 4

# 2. Load test: 1000 concurrent users, ETag revalidation, 60 seconds
node tests/load/load_test.mjs --users 1000 --duration 60 --ramp 10 \
  --scenario revalidate --days 7 --out tests/load/results/load-revalidate.json

# 3. Worst case: unique cache-buster on every poll
node tests/load/load_test.mjs --users 1000 --duration 60 --scenario bypass \
  --out tests/load/results/load-bypass.json

# 4. Full-stack synthetic snapshot, then the browser audit against it
#    (ui_audit builds the day shards in a temp mirror itself)
python tests/load/generate_snapshot.py --points 80000 --zones 49 \
  --out tests/load/data/energy-80k.json
python tests/load/ui_audit.py --snapshot tests/load/data/energy-80k.json \
  --label 80k --soak 5 --out tests/load/results/ui-80k.json

# 5. Same audit against the published contract sample and its real shards
python tests/load/ui_audit.py --label published --soak 5 \
  --out tests/load/results/ui-published.json
```

`ui_audit.py` exits non-zero on any failed assertion or performance budget, so it
works as a gate. `load_test.mjs` does the same and prints a summary table.

With k6:

```bash
k6 run -e USERS=1000 -e BASE=http://127.0.0.1:8000 tests/load/k6-dashboard.js
```

---

## What the load test measures

A page view loads the shell and every module once, then `data/index.json` (the
manifest), then one request per UTC-day shard inside the selected window.
`--days` sets that window (default `7`, matching the dashboard's `7d` preset);
`--poll-ratio` controls how many users are polling at any moment.

Polls fetch the manifest only. The selected day files stay in the browser cache,
so a poll never re-reads the whole snapshot.

Two scenarios:

- **`revalidate`** — the behaviour the dashboard now uses: `cache: "no-cache"`
  with `If-None-Match`. An unchanged manifest returns `304 Not Modified` and an
  empty body.
- **`bypass`** — a unique `?v=<timestamp>` on every poll, so the CDN and browser
  must transfer the manifest body every time. The manifest is small by design,
  so this is now a cheap worst case; the old full-snapshot worst case is quoted
  below for comparison.

### Results — 1000 concurrent users, 80k-row snapshot

Measured on an 8-core Windows host against `serve_docs.mjs`. Local synthetic
origin, not GitHub/Fastly capacity; absolute latency reflects the harness host.
The "Before sharding" column is the same journey against the single
`data/energy.json` snapshot that the page used to poll.

| Metric | Revalidate, shards | Before sharding |
|---|---:|---:|
| Requests | 39,178 | 21,679 |
| Throughput | 940 rps | 486 rps |
| Errors | 0 | 0 |
| p50 latency | 156 ms | 175 ms |
| p95 latency | **231 ms** | 298 ms |
| p99 latency | 269 ms | 346 ms |
| `200` / `304` | 35,017 / 4,161 | 18,549 / 3,130 |
| Bytes per page view | 486 KB | 322 KB |
| Bytes per poll | **0 KB** | 0.6 KB |
| Egress, 1000 users 24/7 | **0.5 GB/month** | 24.5 GB/month |
| Egress, 1000 daily users | **14.6 GB/month** | 11.7 GB/month |
| Threshold `p95 < 500 ms` | pass | pass |

Revalidation still answers every unchanged poll with a `304`, but the payload
that can go stale is now a small manifest plus immutable day files. A page view
costs more bytes (486 KB vs 322 KB) because it loads the shell and seven day
shards, yet nothing refreshes on a timer except the manifest.

The old cache-buster worst case measured 878 KB per poll and 37.9 TB/month for
1000 users polling 24/7, and failed the 500 ms p95 budget. That is why the page
no longer downloads the whole snapshot into the UI.

Rate-limit or CDN-outage risk scales with origin fan-out, not with visitor count.
With revalidation, an unchanged manifest is a `304` that the edge can answer.
With a per-request cache-buster, every visitor forces a unique URL through the
cache.

---

## What the user audit measures

`ui_audit.py` drives real Chromium through:

- cold boot, 3D scene readiness, chart render, KPI values
- range filters (`6h`, `24h`, `7d`, `30d`, `all`)
- date picker: window shown, manifest-driven boot, subset load, one-day pick
  loads one shard, hash gets `range=custom&from=&to=`, reset restores the preset
- baseline and series toggles (`zero`, `window`, `indexed`, `raw`)
- timeline hover, brush, and playhead
- replay play/pause/scrub
- camera presets, theme toggle, help dialog
- share hash round-trip and camera shortcut
- keyboard shortcuts, skip link, canvas labels
- mobile drawers (filters, insights) at 390×844
- failure modes: missing snapshot, corrupt JSON, blocked vendor bundle, slow network
- legacy fallback: manifest blocked, full `data/energy.json` still loads and the
  date picker filters it in memory
- refresh soak for heap leaks

### Results

| Snapshot | Boot desktop | Boot mobile | Hover median | Hover max | Checks |
|---|---:|---:|---:|---:|---:|
| Published sample (225 points, 2 day shards) | 2.6 s | 1.0 s | 1.4 ms | 52 ms | 80/80 |
| 80k points (19,894 loaded for the 7d window) | **2.6 s** | 1.2 s | **1.5 ms** | 27 ms | 82/82 |

Both runs are headless Chromium on SwiftShader, so boot is a software-WebGL
number. On the 80k snapshot a one-day pick loaded a single shard and rendered in
1.3 s (desktop) and 364 ms (mobile). A 3-cycle refresh soak held the heap at
9.9 MB (0% growth) with a 91 ms worst refresh and no console output.

Earlier audits of the full-snapshot build used 64 checks; the count is higher
now because the date-picker, shard, and legacy-fallback assertions were added.

### Budgets

| Check | Budget |
|---|---|
| Boot, hardware WebGL | 8 s |
| Boot, software WebGL (CI/SwiftShader) | 12 s |
| Filter or toggle latency, hardware | 600 ms |
| Filter or toggle latency, software | 1800 ms |
| One-day date pick renders | 6000 ms |
| Timeline hover median | 50 ms |
| Timeline hover max | 150 ms |
| Refresh during soak | 5 s |
| Heap growth over soak | 60% |
| Idle / replay FPS | 30 / 24, hardware only |

Headless CI runs on SwiftShader. FPS is reported there but not gated, because
software rasterisation measures the runner, not the dashboard. Real Intel UHD
630 numbers: boot 3.8–4.7 s, filters 336–415 ms at 80k rows.

---

## Why it holds up at scale

The dashboard is static, so scale is mostly a caching and client-cost problem.
Fixes that came out of these runs:

- **Day shards instead of one snapshot.** The page reads a small manifest and only
  the UTC days in the selected window. The 7d window at 80k rows loads 19,894
  rows instead of 79,968. Day files are compact rows with interned zone and
  source names.
- **Immutable-day caching.** Past day files are fetched with the default cache;
  only the newest day revalidates. A decoded-day cache keyed by `last_ms` serves
  repeat picks without a request, and the manifest poll never refetches days.
- **ETag revalidation instead of cache-busting.** Unchanged manifest polls are
  `304`s with an empty body.
- **Vendored Three.js r169.** No third-party CDN at boot. Boot dropped from about
  8.5 s to 2–4 s and the failure mode is now "warn and keep charts working".
- **Render cap.** The 3D stage draws at most 12,000 bars, sampled per lane. KPIs,
  charts, and statistics still use every row.
- **Unchanged-window skip.** A refresh whose loaded day keys, per-day `last_ms`,
  and row counts match the current frame skips the full re-render.
- **Cheaper interaction paths.** Binary-search timeline hit testing,
  rAF-coalesced chart repaint, line decimation, no redundant per-lane sorts,
  scratch-object reuse in the scene, and throttled playhead stats.

---

## CI

`.github/workflows/dashboard-quality.yml` runs on changes to `docs/`, `tests/load/`, or the
workflow itself:

1. validate the published snapshot contract
2. rebuild the day shards from `docs/data/energy.json`, then validate the
   manifest/day-file contract (dates, row counts, totals)
3. start the local origin
4. run the 1000-user revalidation load test (manifest + day shards)
5. run the 80k browser audit with a 3-cycle soak, including date-picker checks
6. upload `tests/load/results/` as `dashboard-test-reports`, always

The workflow never calls the live host or Databricks.
