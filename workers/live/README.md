# VoltScope live relay

A small Cloudflare Worker that adds the two things a static GitHub Pages site
cannot do by itself:

| Route | Purpose |
|---|---|
| `GET /ws` | WebSocket presence. Counts unique visitors across open tabs. |
| `GET /api/presence` | JSON presence snapshot `{ online, peak, ts }`. |
| `GET /api/live` | Newest Databricks rows, read-only, KV-cached for 20 seconds. |
| `GET /health` | Service probe. |
| cron `*/5` | Refreshes the cache and can dispatch the `live_feed.yml` workflow. |

The Worker holds the Databricks token. The browser never sees it: Pages reads
the Worker over CORS, and the Worker only returns `{t,z,p,s}` points.

## Why a Worker

GitHub Pages has no server runtime, so it cannot count visitors or hold a
credential. The Worker is the smallest relay that keeps both promises:

- **Presence is real.** A Durable Object keeps the open WebSocket set in one
  place. Each visitor gets a random id in `localStorage`, so two tabs on one
  machine count once.
- **Live data is real.** The relay queries Delta through the SQL Statement API
  on demand and caches the result for 20 seconds. Many browsers hitting the
  relay cause one warehouse query per cache window, not one per visitor.

## Deploy

```bash
cd workers/live
wrangler login
wrangler kv namespace create LIVE_CACHE
# put the returned id into wrangler.toml
wrangler secret put DATABRICKS_HOST          # https://dbc-xxxx.cloud.databricks.com
wrangler secret put DATABRICKS_TOKEN         # dedicated read-only token
wrangler secret put DATABRICKS_WAREHOUSE_ID
wrangler deploy
```

Then enable the relay in the static site config:

```json
{
  "schema_version": 1,
  "enabled": true,
  "relay_url": "https://voltscope-live.<account>.workers.dev",
  "poll_ms": 12000
}
```

Edit `docs/data/live-config.json` in the repository and push. The dashboard
reads that file on load; no rebuild is needed.

If the Worker runs without `DATABRICKS_*` secrets, add `"live_url": "data/live.json"`
so the page reads points from the published file. Presence still comes from the
relay, and `/api/live` stays unused instead of returning 502.

## Deployed instance

| Item | Value |
|---|---|
| URL | `https://voltscope-live.md-sarfarazalam840.workers.dev` |
| KV binding | `LIVE_CACHE`, id `d659208acf384ac19e09613a6a081af8` |
| State | Presence live. `/api/live` returns 502 until the three `DATABRICKS_*` secrets are set. |

## Optional: let the Worker trigger GitHub Actions

Create a fine-grained PAT with **Actions: write** on this repository, then:

```bash
wrangler secret put GITHUB_DISPATCH_TOKEN
# set DISPATCH_ENABLED = "1" in wrangler.toml, then:
wrangler deploy
```

The cron dispatches `live_feed.yml` at most once every four minutes. The
workflow itself is also scheduled every five minutes, so this is a nudge for
when GitHub's scheduler drifts, not a replacement for the schedule.

## Local development

```bash
cd workers/live
wrangler dev --local
# http://localhost:8787/health
```

Set `ALLOWED_ORIGIN` to `http://localhost:8000` when testing the site locally
against a local Worker.

## Security notes

- `DATABRICKS_TOKEN` and `GITHUB_DISPATCH_TOKEN` are Worker secrets. Never put
  them in `wrangler.toml` or the repository.
- `/api/live` is deliberately read-only and unauthenticated; it exposes market
  prices only. Do not add write endpoints to this Worker.
- Use a dedicated Databricks token with `CAN_VIEW` on the warehouse and
  `SELECT` on the energy table.
- The Durable Object can be spammed by anyone who finds the URL. Cloudflare's
  free tier rate-limits abusive traffic; add a WAF rule if the site gets
  attention.
