/* adsb.lol snapshot cache for the VoltScope flights globe.
 *
 * The public adsb.lol API is keyless but regional: `/v2/point` returns every
 * aircraft inside one circle of at most 250 nautical miles, and there is no
 * whole-world endpoint (the global readsb API needs a feeder key). This script
 * therefore samples a grid of 250 NM circles over the busy aviation regions,
 * merges the replies, and writes docs/data/flights.json for the static page.
 *
 * adsb.lol rate limits dynamically and asks clients to stay polite, so:
 *
 *   - requests run one at a time with a configurable gap (default 6 s, keeping
 *     under the public API's ~10 requests/minute burst allowance);
 *   - 429/5xx get a backoff that honours Retry-After when present;
 *   - a region that keeps failing is skipped instead of failing the whole run;
 *   - a fresh cache file is left alone unless refresh is forced;
 *   - --dry-run fetches and reports without writing.
 *
 * The page itself never calls the API: it only reads the committed JSON.
 * adsb.lol data is published under the ODbL 1.0 licence.
 *
 * Usage:
 *   node scripts/cache_flights.mjs
 *   node scripts/cache_flights.mjs --dry-run
 *   FLIGHTS_FORCE=1 node scripts/cache_flights.mjs              # refresh even if recent
 *   FLIGHTS_REFRESH_MINUTES=30 node scripts/cache_flights.mjs
 *   FLIGHTS_MAX_REGIONS=4 node scripts/cache_flights.mjs        # small test run
 *   FLIGHTS_REQUEST_INTERVAL_MS=1500 node scripts/cache_flights.mjs
 *
 * Requires Node 18+ (global fetch).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DEFAULT_OUT = path.join(ROOT, "docs", "data", "flights.json");
const DEFAULT_BASE = "https://api.adsb.lol";
const COUNTRY_CSV = path.join(HERE, "icao_country_ranges.csv");
const USER_AGENT = "voltscope-flights-cache/2.0 (+https://github.com/mdsarfarazalam840/Energy-realtime)";
const FETCH_TIMEOUT_MS = 20000;
const REGION_RADIUS_NM = 250; // public adsb.lol API cap
const MAX_REGION_ATTEMPTS = 4;

/* 250 NM circles over the busiest aviation regions. Together they give broad
 * continental coverage; the API cannot return a single whole-world snapshot,
 * and receiver coverage is thin over oceans regardless of the grid. */
const COVERAGE = [
  ["US Central", 39.0, -98.0],
  ["US Northeast", 40.7, -74.0],
  ["US Southeast", 33.9, -84.4],
  ["US Gulf", 29.8, -95.4],
  ["US West", 34.0, -118.3],
  ["US Pacific NW", 47.5, -122.3],
  ["US Mountain", 39.9, -105.0],
  ["US Florida", 25.8, -80.3],
  ["Canada East", 43.7, -79.4],
  ["Canada West", 49.2, -123.0],
  ["Mexico", 19.4, -99.1],
  ["Alaska", 61.2, -149.9],
  ["Hawaii", 21.3, -157.9],
  ["Brazil Southeast", -23.4, -46.5],
  ["Brazil Central", -15.8, -47.9],
  ["Argentina", -34.6, -58.4],
  ["Chile", -33.4, -70.6],
  ["Colombia", 4.7, -74.1],
  ["Peru", -12.0, -77.0],
  ["UK", 51.5, -0.1],
  ["France", 48.9, 2.4],
  ["Germany", 50.1, 8.6],
  ["Italy", 43.0, 12.0],
  ["Spain", 40.4, -3.7],
  ["Portugal", 38.7, -9.1],
  ["Ireland", 53.3, -6.3],
  ["Scandinavia", 57.7, 12.0],
  ["Baltic", 59.0, 24.0],
  ["Central Europe", 50.1, 14.3],
  ["Balkans", 44.8, 20.5],
  ["Turkey", 41.0, 29.0],
  ["Greece", 37.9, 23.7],
  ["Egypt", 30.1, 31.4],
  ["West Africa", 7.0, 3.5],
  ["East Africa", -1.3, 36.9],
  ["South Africa", -26.1, 28.2],
  ["Morocco", 33.6, -7.6],
  ["Ethiopia", 9.0, 38.7],
  ["UAE", 25.2, 55.3],
  ["Saudi Arabia", 24.7, 46.7],
  ["Iran", 35.7, 51.4],
  ["Levant", 32.0, 35.0],
  ["Japan East", 35.7, 139.7],
  ["Japan West", 34.7, 135.5],
  ["Korea", 37.6, 126.8],
  ["East China", 31.2, 121.5],
  ["North China", 39.9, 116.4],
  ["South China", 23.4, 113.9],
  ["Taiwan", 25.0, 121.5],
  ["Thailand", 13.7, 100.6],
  ["Singapore", 1.35, 103.8],
  ["Indonesia", -6.1, 106.7],
  ["India North", 28.6, 77.2],
  ["India West", 19.1, 72.9],
  ["India South", 12.9, 77.6],
  ["Central Asia", 41.3, 69.3],
  ["Moscow", 55.4, 37.4],
  ["Urals", 56.8, 60.6],
  ["Siberia", 55.0, 82.9],
  ["Sydney", -33.9, 151.2],
  ["Melbourne", -37.7, 145.0],
  ["Brisbane", -27.4, 153.1],
  ["Perth", -31.9, 115.9],
  ["New Zealand", -36.8, 174.8],
];

/* Country labels differ slightly between sources; keep the names a dashboard
 * reader expects. */
const COUNTRY_NAMES = new Map([
  ["Coate d Ivoire", "Côte d'Ivoire"],
  ["D R Congo", "DR Congo"],
  ["Democratic Republic of the Congo", "DR Congo"],
  ["Macedonia", "North Macedonia"],
  ["Swaziland", "Eswatini"],
  ["Taiwan (unofficial)", "Taiwan"],
  ["United Republic of Tanzania", "Tanzania"],
  ["Yugoslavia", "Serbia"],
]);

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

/* ICAO 24-bit address blocks come from the assignment table in Annex 10 Vol
 * III (the same table tar1090 and dump1090 use; CSV copy from
 * github.com/rikgale/ICAOList). adsb.lol has no country field, so the country
 * label is derived from the aircraft address. */
function loadCountryRanges() {
  const text = fs.readFileSync(COUNTRY_CSV, "utf8");
  const ranges = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9A-Fa-f]{6}),([0-9A-Fa-f]{6}),(.*)$/.exec(line.trim());
    if (!match) continue;
    const country = match[3].trim().replace(/^"|"$/g, "").replace(/,$/, "").trim();
    if (!country || country.startsWith("(")) continue; // reserved / unallocated blocks
    ranges.push({
      start: Number.parseInt(match[1], 16),
      end: Number.parseInt(match[2], 16),
      country: COUNTRY_NAMES.get(country) || country,
    });
  }
  // Smallest block first: nested assignments (for example Namibia inside the
  // reserved AFI block) must win over the broad parent range.
  ranges.sort((a, b) => a.end - a.start - (b.end - b.start));
  return ranges;
}

const COUNTRY_RANGES = loadCountryRanges();

function countryForIcao(icao24) {
  const value = Number.parseInt(icao24, 16);
  if (!Number.isFinite(value)) return "Unknown";
  for (const range of COUNTRY_RANGES) {
    if (value >= range.start && value <= range.end) return range.country;
  }
  return "Unknown";
}

/* Keep the request cadence under the public API's dynamic rate limit. */
let lastRequestAt = 0;
async function politeFetch(url) {
  const waitMs = envInt("FLIGHTS_REQUEST_INTERVAL_MS", 6000) - (Date.now() - lastRequestAt);
  if (waitMs > 0) await sleep(waitMs);
  lastRequestAt = Date.now();
  return fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: signalForTimeout(),
  });
}

async function fetchRegion(base, region) {
  const [label, lat, lon] = region;
  const url = `${base.replace(/\/+$/, "")}/v2/point/${lat}/${lon}/${REGION_RADIUS_NM}`;
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_REGION_ATTEMPTS; attempt++) {
    try {
      const response = await politeFetch(url);
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`HTTP ${response.status}`);
        const retryAfter = Number(response.headers && response.headers.get ? response.headers.get("retry-after") : NaN);
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 60000)
          : Math.min(2 ** (attempt - 1) * 1000, 8000) + Math.floor(Math.random() * 500);
        log(`  ${label}: retry ${attempt}/${MAX_REGION_ATTEMPTS} in ${Math.round(waitMs / 1000)}s (${lastError.message})`);
        await sleep(waitMs);
        continue;
      }
      if (!response.ok) {
        throw new CacheError(`${label} -> HTTP ${response.status}`);
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new CacheError(`${label} returned invalid JSON`);
      }
      if (!payload || !Array.isArray(payload.ac)) {
        throw new CacheError(`${label} payload has no aircraft array`);
      }
      return payload;
    } catch (error) {
      lastError = error;
      if (error instanceof CacheError) break;
      if (attempt < MAX_REGION_ATTEMPTS) {
        const waitMs = Math.min(2 ** (attempt - 1) * 1000, 8000) + Math.floor(Math.random() * 500);
        log(`  ${label}: retry ${attempt}/${MAX_REGION_ATTEMPTS} in ${Math.round(waitMs / 1000)}s (${error.message})`);
        await sleep(waitMs);
      }
    }
  }
  throw new CacheError(`${label}: ${lastError ? lastError.message : "unknown error"}`);
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round4(value) {
  return Number(value.toFixed(4));
}

/* adsb.lol follows the ADSBExchange v2 shape:
 * hex = ICAO address, flight = callsign, lat/lon = degrees, seen_pos = seconds
 * since the position was observed, and `now` = server time in milliseconds. */
function parsePlane(row, nowMs) {
  if (!row || typeof row !== "object") return null;
  const icao24 = String(row.hex === undefined || row.hex === null ? "" : row.hex).trim().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(icao24)) return null;
  const lat = toNumber(row.lat);
  const lon = toNumber(row.lon);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const ageSeconds = toNumber(row.seen_pos) ?? toNumber(row.seen);
  const lastUpdateMs = ageSeconds !== null && ageSeconds >= 0
    ? Math.round(nowMs - ageSeconds * 1000)
    : null;
  return {
    icao24,
    callsign: String(row.flight === undefined || row.flight === null ? "" : row.flight).trim().slice(0, 10),
    country: "Unknown",
    lon: round4(lon),
    lat: round4(lat),
    lastUpdateMs,
    lastUpdate: lastUpdateMs === null ? null : new Date(lastUpdateMs).toISOString().slice(0, 19) + "Z",
  };
}

function buildSnapshot(regions, responses, fetchedAtMs) {
  if (responses.length === 0) throw new CacheError("no adsb.lol region returned usable data");

  const byIcao = new Map();
  let apiTimeMs = null;
  for (const payload of responses) {
    const nowMs = toNumber(payload.now);
    const regionNow = nowMs !== null && nowMs > 0 ? nowMs : fetchedAtMs;
    if (apiTimeMs === null || regionNow > apiTimeMs) apiTimeMs = regionNow;
    for (const row of payload.ac) {
      const plane = parsePlane(row, regionNow);
      if (!plane) continue;
      const existing = byIcao.get(plane.icao24);
      if (!existing || (plane.lastUpdateMs !== null && (existing.lastUpdateMs === null || plane.lastUpdateMs > existing.lastUpdateMs))) {
        byIcao.set(plane.icao24, plane);
      }
    }
  }

  const planes = [...byIcao.values()];
  for (const plane of planes) plane.country = countryForIcao(plane.icao24);
  planes.sort((a, b) => {
    if (a.lastUpdateMs === null && b.lastUpdateMs !== null) return 1;
    if (b.lastUpdateMs === null && a.lastUpdateMs !== null) return -1;
    if (a.lastUpdateMs !== null && b.lastUpdateMs !== null && a.lastUpdateMs !== b.lastUpdateMs) {
      return b.lastUpdateMs - a.lastUpdateMs;
    }
    return a.icao24 < b.icao24 ? -1 : a.icao24 > b.icao24 ? 1 : 0;
  });
  const countries = new Set(planes.map((plane) => plane.country));

  return {
    schema_version: 1,
    source: "adsb.lol",
    endpoint: `v2/point grid (${REGION_RADIUS_NM} NM)`,
    fetched_at: new Date(fetchedAtMs).toISOString(),
    api_time: apiTimeMs === null ? null : new Date(apiTimeMs).toISOString(),
    coverage: {
      regions: regions.length,
      succeeded: responses.length,
      radius_nm: REGION_RADIUS_NM,
    },
    counts: { aircraft: planes.length, positioned: planes.length, countries: countries.size },
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
    `${snapshot.counts.aircraft} aircraft · ${snapshot.counts.countries} countries · `
      + `${snapshot.coverage.succeeded}/${snapshot.coverage.regions} regions`,
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  for (const arg of argv) {
    if (arg !== "--dry-run") log(`warning: ignoring unknown argument ${arg}`);
  }
  const target = process.env.FLIGHTS_OUT || DEFAULT_OUT;
  const base = process.env.FLIGHTS_API_BASE || DEFAULT_BASE;
  const refreshMinutes = envInt("FLIGHTS_REFRESH_MINUTES", 60);
  const force = process.env.FLIGHTS_FORCE === "1" || process.env.FLIGHTS_FORCE === "true";
  const maxRegions = envInt("FLIGHTS_MAX_REGIONS", 0);
  const regions = maxRegions > 0 ? COVERAGE.slice(0, maxRegions) : COVERAGE;

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

  const responses = [];
  const failed = [];
  for (let index = 0; index < regions.length; index++) {
    const region = regions[index];
    try {
      responses.push(await fetchRegion(base, region));
      log(`  ${region[0]} (${index + 1}/${regions.length})`);
    } catch (error) {
      failed.push(region[0]);
      log(`  ${region[0]} skipped: ${error.message}`);
    }
  }
  if (failed.length > 0) log(`regions skipped: ${failed.join(", ")}`);

  const snapshot = buildSnapshot(regions, responses, Date.now());
  if (!dryRun) atomicWriteJson(target, snapshot);
  const label = dryRun ? "dry run" : `wrote ${path.relative(ROOT, target) || target}`;
  log(`${label} (${snapshot.fetched_at})`);
  printSummary(snapshot);
}

main().catch((error) => {
  console.error(`[flights cache] error: ${error && error.message ? error.message : error}`);
  process.exit(1);
});
