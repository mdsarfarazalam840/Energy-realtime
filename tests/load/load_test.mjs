/* Load test a local mirror of the dashboard.
 *
 *   node tests/load/serve_docs.mjs --root docs --port 8000 --workers 4
 *   node tests/load/load_test.mjs --users 1000 --duration 60 --scenario revalidate
 *
 * Never point this at the public GitHub Pages site. Unsolicited load is against
 * GitHub's Acceptable Use policy and can suspend the account.
 *
 * The dashboard reads `data/index.json` and then only the day shards inside the
 * selected window, so a page view here loads the shell, the manifest, and up to
 * `--days` day files (default 7). Polls revalidate the manifest only.
 *
 * Scenarios
 *   revalidate  ETag-conditional polls, like `cache: "no-cache"` in the page.
 *               Unchanged manifests cost a 304 and no body.
 *   bypass      Unique `?v=` per poll, forcing a full manifest body every time.
 */

import http from "node:http";
import zlib from "node:zlib";
import { performance } from "node:perf_hooks";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

const URL_BASE = arg("url", "http://127.0.0.1:8000").replace(/\/$/, "");
const USERS = Number(arg("users", "1000"));
const DURATION = Number(arg("duration", "60"));
const RAMP = Number(arg("ramp", "10"));
const SCENARIO = arg("scenario", "revalidate");
const POLL_RATIO = Number(arg("poll-ratio", "0.65"));
const THINK_MS = Number(arg("think-ms", "300"));
const OUT = arg("out", "");
const TIMEOUT_MS = Number(arg("timeout", "30000"));

const ASSETS = [
  "/",
  "/assets/css/dashboard.css?v=20261028-5",
  "/assets/js/main.js?v=20261028-5",
  "/assets/js/data.js?v=20261028-5",
  "/assets/js/demo.js?v=20261028-5",
  "/assets/js/charts.js?v=20261028-5",
  "/assets/js/scene.js?v=20261028-5",
  "/assets/vendor/three/three.module.js",
  "/assets/vendor/three/addons/controls/OrbitControls.js",
  "/assets/vendor/three/addons/postprocessing/EffectComposer.js",
  "/assets/vendor/three/addons/postprocessing/RenderPass.js",
  "/assets/vendor/three/addons/postprocessing/UnrealBloomPass.js",
  "/assets/vendor/three/addons/postprocessing/ShaderPass.js",
  "/assets/vendor/three/addons/postprocessing/MaskPass.js",
  "/assets/vendor/three/addons/postprocessing/Pass.js",
  "/assets/vendor/three/addons/shaders/CopyShader.js",
  "/assets/vendor/three/addons/shaders/LuminosityHighPassShader.js",
];
const SNAPSHOT = "/data/index.json";
const DAYS_TO_LOAD = Math.max(1, Number(arg("days", "7")));
const origin = new URL(URL_BASE);
const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity, maxFreeSockets: 2048 });

const stats = {
  latencies: [],
  errors: [],
  status: {},
  requests: 0,
  bytes: 0,
  pageBytes: 0,
  snapshotBytes: 0,
  dayFiles: 0,
  snapshotOk: 0,
  snapshotBad: 0,
  notModified: 0,
  pageViews: 0,
  polls: 0,
};

function record(status, ms, bytes, error, kind = "page") {
  stats.requests += 1;
  stats.latencies.push(ms);
  stats.status[status] = (stats.status[status] || 0) + 1;
  stats.bytes += bytes;
  if (kind === "snapshot") stats.snapshotBytes += bytes;
  else stats.pageBytes += bytes;
  if (error) stats.errors.push(error);
}

async function get(path, etag, kind = "page") {
  return new Promise((resolve) => {
    const headers = { "accept-encoding": "gzip", connection: "keep-alive" };
    if (etag) headers["if-none-match"] = etag;
    const started = performance.now();
    const request = http.request(
      {
        hostname: origin.hostname,
        port: origin.port,
        path,
        method: "GET",
        agent,
        headers,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const raw = Buffer.concat(chunks);
          const wireBytes = raw.length;
          let body = raw;
          if (response.headers["content-encoding"] === "gzip") {
            try {
              body = zlib.gunzipSync(body);
            } catch {
              /* keep the raw bytes for the error path */
            }
          }
          const ms = performance.now() - started;
          const status = response.statusCode || 0;
          record(status, ms, wireBytes, status >= 400 ? `${path} -> HTTP ${status}` : null, kind);
          resolve({ status, etag: response.headers.etag || null, body });
        });
      }
    );
    request.setTimeout(TIMEOUT_MS, () => {
      request.destroy(new Error("timeout"));
    });
    request.on("error", (error) => {
      record(0, performance.now() - started, 0, `${path} -> ${error.name}: ${error.message}`, kind);
      resolve(null);
    });
    request.end();
  });
}

function percentile(values, pct) {
  if (!values.length) return 0;
  const ordered = values.slice().sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.round((pct / 100) * (ordered.length - 1))))];
}

let snapshotEtag = null;
let dayPaths = [];

async function snapshotPoll() {
  stats.polls += 1;
  if (SCENARIO === "bypass") {
    const response = await get(`${SNAPSHOT}?v=${performance.timeOrigin}-${Math.random()}`, undefined, "snapshot");
    if (response) validateSnapshot(response.body);
    return;
  }
  const response = await get(SNAPSHOT, snapshotEtag, "snapshot");
  if (!response) return;
  if (response.status === 304) {
    stats.notModified += 1;
    return;
  }
  if (response.etag) snapshotEtag = response.etag;
  validateSnapshot(response.body);
}

function validateSnapshot(body) {
  if (!body || body.length === 0) return;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body));
    if (Array.isArray(parsed.days) && parsed.days.length) stats.snapshotOk += 1;
    else {
      stats.snapshotBad += 1;
      stats.errors.push("manifest has no days array");
    }
  } catch {
    stats.snapshotBad += 1;
    stats.errors.push("manifest is not valid JSON");
  }
}

function manifestDays(body) {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body));
    return Array.isArray(parsed.days) ? parsed.days.map((day) => day.file).filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function pageView() {
  stats.pageViews += 1;
  for (const asset of ASSETS) await get(asset);
  for (const file of dayPaths.slice(-DAYS_TO_LOAD)) {
    await get(`/data/${file}`, undefined, "day");
    stats.dayFiles += 1;
  }
  await snapshotPoll();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function virtualUser(stopAt) {
  while (performance.now() < stopAt) {
    if (Math.random() < POLL_RATIO) {
      await snapshotPoll();
    } else {
      await pageView();
    }
    if (THINK_MS > 0) await sleep(THINK_MS * (0.35 + Math.random()));
  }
}

function report(startedAt) {
  const elapsed = (performance.now() - startedAt) / 1000;
  const total = Math.max(1, stats.requests);
  const errorRate = stats.errors.length / total;
  const p50 = percentile(stats.latencies, 50);
  const p95 = percentile(stats.latencies, 95);
  const p99 = percentile(stats.latencies, 99);
  const pageBytesPerView = stats.pageBytes / Math.max(1, stats.pageViews);
  const pollBytes = stats.snapshotBytes / Math.max(1, stats.polls);
  const monthlyGb = (USERS * (pageBytesPerView + 43200 * pollBytes)) / 1e9;
  const typicalMonthlyGb = (USERS * (pageBytesPerView + 120 * pollBytes) * 30) / 1e9;
  const result = {
    scenario: SCENARIO,
    users: USERS,
    duration_s: Number(elapsed.toFixed(2)),
    requests: stats.requests,
    rps: Number((stats.requests / elapsed).toFixed(1)),
    error_rate_pct: Number((errorRate * 100).toFixed(3)),
    latency_ms: {
      p50: Number(p50.toFixed(1)),
      p95: Number(p95.toFixed(1)),
      p99: Number(p99.toFixed(1)),
      mean: Number((stats.latencies.reduce((sum, value) => sum + value, 0) / total).toFixed(1)),
    },
    status: stats.status,
    not_modified: stats.notModified,
    snapshot_valid: stats.snapshotOk,
    snapshot_invalid: stats.snapshotBad,
    day_files_loaded: stats.dayFiles,
    date_window_days: DAYS_TO_LOAD,
    throughput_mbps: Number(((stats.bytes / elapsed / 1_000_000) * 8).toFixed(2)),
    page_views: stats.pageViews,
    polls: stats.polls,
    bytes_per_page_view_kb: Number((pageBytesPerView / 1000).toFixed(1)),
    bytes_per_poll_kb: Number((pollBytes / 1000).toFixed(1)),
    egress_1000_users_month_gb: Number(((monthlyGb / USERS) * 1000).toFixed(1)),
    egress_1000_daily_users_month_gb: Number(((typicalMonthlyGb / USERS) * 1000).toFixed(1)),
    sample_errors: stats.errors.slice(0, 5),
  };
  const thresholds = {
    error_rate_lt_1pct: errorRate < 0.01,
    p95_lt_500ms: p95 < 500,
    p99_lt_1500ms: p99 < 1500,
    no_invalid_snapshots: stats.snapshotBad === 0,
  };
  result.thresholds = thresholds;
  result.passed = Object.values(thresholds).every(Boolean);
  return result;
}

async function main() {
  console.error(`Load test: ${USERS} users, ${DURATION}s, scenario=${SCENARIO}, origin=${URL_BASE}`);
  // Warm-up so the first keep-alive handshakes do not skew the percentiles.
  await get("/");
  const manifest = await get(SNAPSHOT);
  dayPaths = manifestDays(manifest?.body);
  if (!dayPaths.length) {
    console.error("Manifest has no day shards. Run scripts/dashboard_shards.py first.");
    process.exit(1);
  }
  for (const key of Object.keys(stats)) {
    stats[key] = Array.isArray(stats[key]) ? [] : typeof stats[key] === "number" ? 0 : stats[key];
  }
  stats.status = {};

  const startedAt = performance.now();
  const stopAt = startedAt + DURATION * 1000;
  const users = [];
  for (let index = 0; index < USERS; index += 1) {
    if (RAMP > 0) await sleep((RAMP / USERS) * 1000);
    users.push(virtualUser(stopAt));
    if (index && index % 500 === 0) console.error(`  ...${index} users started`);
  }
  await Promise.all(users);

  const result = report(startedAt);
  console.log(JSON.stringify(result, null, 2));
  if (OUT) {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    if (dirname(OUT)) mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(result, null, 2));
  }
  process.exit(result.passed ? 0 : 1);
}

main();
