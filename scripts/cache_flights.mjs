/* OpenSky snapshot cache for the VoltScope flights globe.
 *
 * Fetches aircraft positions from OpenSky's anonymous states/all tier and
 * writes docs/data/flights.json for the static page. The anonymous tier is
 * rate limited, so this script is deliberately polite:
 *
 *   - 429/5xx get a jittered backoff (honouring Retry-After when present);
 *   - a fresh cache file is left alone unless refresh is forced;
 *   - --dry-run fetches and reports without writing.
 *
 * Usage:
 *   node scripts/cache_flights.mjs
 *   node scripts/cache_flights.mjs --dry-run
 *   FLIGHTS_FORCE=1 node scripts/cache_flights.mjs      # refresh even if a recent snapshot exists
 *   FLIGHTS_REFRESH_MINUTES=30 node scripts/cache_flights.mjs
 *
 * Requires Node 18+ (global fetch). The page itself never calls the API:
 * it only reads the committed JSON, and there is no API key anywhere.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DEFAULT_OUT = path.join(ROOT, "docs", "data", "flights.json");
const DEFAULT_URL = "https://opensky-network.org/api/states/all?verbose=0";
const USER_AGENT = "voltscope-flights-cache/1.0 (+https://github.com/mdsarfarazalam840/Energy-realtime)";
const FETCH_TIMEOUT_MS = 20000;
const DAY_MS = 86400000;

class CacheError extends Error {}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function signalForTimeout() {
  if (typeof AbortSignal === "function" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(FETCH_TIMEOUT_MS);
  }
  return undefined;
}

async function fetchStates(url) {
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: signalForTimeout(),
      });
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`HTTP ${response.status}`);
        const retryAfter = Number(response.headers && response.headers.get ? response.headers.get("retry-after") : NaN);
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 60000)
          : Math.min(2 ** (attempt - 1) * 1000, 8000) + Math.floor(Math.random() * 500);
        log(`retry ${attempt}/4 in ${Math.round(waitMs / 1000)}s (${lastError.message})`);
        await sleep(waitMs);
        continue;
      }
      if (!response.ok) {
        throw new CacheError(`states/all -> HTTP ${response.status}`);
      }
      try {
        return await response.json();
      } catch {
        throw new CacheError("states/all returned invalid JSON");
      }
    } catch (error) {
      lastError = error;
      if (error instanceof CacheError) break;
      if (attempt < 4) {
        const waitMs = Math.min(2 ** (attempt - 1) * 1000, 8000) + Math.floor(Math.random() * 500);
        log(`retry ${attempt}/4 in ${Math.round(waitMs / 1000)}s (${error.message})`);
        await sleep(waitMs);
      }
    }
  }
  throw new CacheError(`could not fetch states/all: ${lastError ? lastError.message : "unknown error"}`);
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round4(value) {
  return Number(value.toFixed(4));
}

/* Row layout per OpenSky's states/all documentation:
 * [0] icao24, [1] callsign, [2] origin country, [3] last position update
 * (unix seconds), [5] longitude, [6] latitude. Parse defensively: anything
 * outside the valid ranges is nulled rather than trusted. */
function parsePlane(row) {
  if (!Array.isArray(row)) return null;
  const icao24 = String(row[0] === undefined || row[0] === null ? "" : row[0]).trim().toLowerCase();
  if (!icao24) return null;
  const lastUpdateMs = toNumber(row[3]);
  const lon = toNumber(row[5]);
  const lat = toNumber(row[6]);
  return {
    icao24,
    callsign: String(row[1] === undefined || row[1] === null ? "" : row[1]).trim().slice(0, 10),
    country: String(row[2] === undefined || row[2] === null ? "" : row[2]).trim() || "Unknown",
    lon: lon !== null && Math.abs(lon) <= 180 ? round4(lon) : null,
    lat: lat !== null && Math.abs(lat) <= 90 ? round4(lat) : null,
    lastUpdateMs: lastUpdateMs !== null && lastUpdateMs > 0 ? Math.round(lastUpdateMs * 1000) : null,
  };
}

function buildSnapshot(payload, fetchedAtMs) {
  const states = Array.isArray(payload && payload.states) ? payload.states : null;
  if (!states) throw new CacheError("states/all payload has no states array");

  const byIcao = new Map();
  for (const row of states) {
    const plane = parsePlane(row);
    if (!plane) continue;
    const existing = byIcao.get(plane.icao24);
    if (!existing || (plane.lastUpdateMs !== null && (existing.lastUpdateMs === null || plane.lastUpdateMs > existing.lastUpdateMs))) {
      byIcao.set(plane.icao24, plane);
    }
  }
  const planes = [...byIcao.values()].sort((a, b) => {
    if (a.lastUpdateMs === null && b.lastUpdateMs !== null) return 1;
    if (b.lastUpdateMs === null && a.lastUpdateMs !== null) return -1;
    if (a.lastUpdateMs !== null && b.lastUpdateMs !== null && a.lastUpdateMs !== b.lastUpdateMs) {
      return b.lastUpdateMs - a.lastUpdateMs;
    }
    return a.icao24 < b.icao24 ? -1 : a.icao24 > b.icao24 ? 1 : 0;
  });
  const countries = new Set(planes.map((plane) => plane.country));
  const positioned = planes.filter((plane) => plane.lon !== null && plane.lat !== null).length;
  const apiTime = toNumber(payload && payload.time);

  return {
    schema_version: 1,
    source: "OpenSky Network",
    endpoint: "states/all (anonymous)",
    fetched_at: new Date(fetchedAtMs).toISOString(),
    api_time: apiTime !== null && apiTime > 0 ? new Date(apiTime * 1000).toISOString() : null,
    counts: { aircraft: planes.length, positioned, countries: countries.size },
    planes,
  };
}

function atomicWriteJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, target);
}

function printSummary(snapshot) {
  log(
    `${snapshot.counts.aircraft} aircraft · ${snapshot.counts.positioned} positioned · ${snapshot.counts.countries} countries`,
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  for (const arg of argv) {
    if (arg !== "--dry-run") log(`warning: ignoring unknown argument ${arg}`);
  }
  const target = process.env.FLIGHTS_OUT || DEFAULT_OUT;
  const url = process.env.FLIGHTS_API_URL || DEFAULT_URL;
  const refreshMinutes = envInt("FLIGHTS_REFRESH_MINUTES", 60);
  const force = process.env.FLIGHTS_FORCE === "1" || process.env.FLIGHTS_FORCE === "true";

  if (!dryRun && !force && refreshMinutes > 0) {
    try {
      const ageMs = Date.now() - fs.statSync(target).mtimeMs;
      if (ageMs >= 0 && ageMs < refreshMinutes * 60000) {
        log(`cache is ${Math.round(ageMs / 60000)}m old; skip (FLIGHTS_FORCE=1 or FLIGHTS_REFRESH_MINUTES=0 to override)`);
        return;
      }
    } catch {
      /* no cache yet — fetch below */
    }
  }

  const payload = await fetchStates(url);
  const snapshot = buildSnapshot(payload, Date.now());
  if (!dryRun) atomicWriteJson(target, snapshot);
  const label = dryRun ? "dry run" : `wrote ${path.relative(ROOT, target) || target}`;
  log(`${label} (${snapshot.fetched_at})`);
  printSummary(snapshot);
}

main().catch((error) => {
  console.error(`[flights cache] error: ${error && error.message ? error.message : error}`);
  process.exit(1);
});
