/* Flights page data layer: snapshot parsing, the deterministic demo deck, and
 * formatting helpers. Everything the page shows comes from a single
 * same-origin JSON file (docs/data/flights.json, cached by
 * scripts/cache_flights.mjs); no browser-side call reaches the OpenSky API.
 *
 * The live feed is OpenSky Network's anonymous states/all tier, which is rate
 * limited — hence a committed snapshot plus a labelled demo fallback rather
 * than per-visitor polling. */

export const FLIGHTS_URL = "data/flights.json";
export const SCHEMA_VERSION = 1;
export const DEMO_COUNT = 48;
export const DEMO_SEED = 0x5eed2026;
const DAY_MS = 86400000;

/* Fixed hub positions give the demo deck plausible, deterministic coverage
 * instead of a uniform noise blob. Coordinates are approximate hub centres
 * (lat, lon in decimal degrees, WGS-84); demo aircraft jitter around them. */
const DEMO_HUBS = [
  [51.4500, -0.4543, "United Kingdom"],
  [40.6413, -73.7781, "United States"],
  [33.9416, -118.4085, "United States"],
  [-33.9399, 151.1753, "Australia"],
  [35.7720, 140.3929, "Japan"],
  [50.0379, 8.5620, "Germany"],
  [25.2532, 55.3657, "United Arab Emirates"],
  [-23.4260, -46.4432, "Brazil"],
  [28.5562, 77.1000, "India"],
  [22.3080, 113.9185, "Hong Kong"],
  [1.3644, 103.9915, "Singapore"],
  [49.0098, 2.5479, "France"],
  [52.3105, 4.7683, "Netherlands"],
  [41.2753, 28.7519, "Türkiye"],
  [30.1219, 31.4056, "Egypt"],
  [-1.3192, 36.9278, "Kenya"],
  [-37.0082, 174.7854, "New Zealand"],
  [45.5089, -73.5874, "Canada"],
  [19.4363, -99.0721, "Mexico"],
  [40.0799, 116.5546, "China"],
];

function seededRandom(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function buildDemoSnapshot(nowMs = Date.now()) {
  const random = seededRandom(DEMO_SEED);
  const planes = [];
  for (let index = 0; index < DEMO_COUNT; index++) {
    const [lat, lon, country] = DEMO_HUBS[Math.floor(random() * DEMO_HUBS.length)];
    const jitterLat = (random() - 0.5) * 1.2;
    const jitterLon = (random() - 0.5) * 1.2;
    const ageMinutes = random() * 42;
    planes.push({
      icao24: `d${(index % 0xffff).toString(16).padStart(4, "0")}`,
      callsign: `DEMO-${Math.floor(random() * 9000 + 1000)}`,
      country,
      lon: round4(lon + jitterLon),
      lat: round4(lat + jitterLat),
      lastUpdateMs: nowMs - Math.round(ageMinutes * 60000),
      lastUpdate: new Date(nowMs - Math.round(ageMinutes * 60000)).toISOString().slice(0, 19) + "Z",
    });
  }
  planes.sort((a, b) => b.lastUpdateMs - a.lastUpdateMs);
  return {
    schema_version: SCHEMA_VERSION,
    source: "demo",
    fetched_at: new Date(nowMs).toISOString(),
    counts: { aircraft: planes.length, positioned: planes.length, countries: DEMO_HUBS.length },
    planes,
    note: "Deterministic demo aircraft generated in the browser — run scripts/cache_flights.mjs for live data.",
  };
}

function round4(value) {
  return Number(value.toFixed(4));
}

function sanitizePlane(row) {
  if (!row || typeof row !== "object") return null;
  const icao24 = String(row.icao24 === undefined || row.icao24 === null ? "" : row.icao24).trim().toLowerCase();
  if (!icao24) return null;
  const lon = toNumber(row.lon);
  const lat = toNumber(row.lat);
  const lastUpdateMs = toNumber(row.lastUpdateMs);
  return {
    icao24,
    callsign: String(row.callsign === undefined || row.callsign === null ? "" : row.callsign).trim().slice(0, 10),
    country: String(row.country === undefined || row.country === null ? "" : row.country).trim() || "Unknown",
    lon: lon !== null && Math.abs(lon) <= 180 ? lon : null,
    lat: lat !== null && Math.abs(lat) <= 90 ? lat : null,
    lastUpdateMs: lastUpdateMs !== null && lastUpdateMs > 0 ? Math.round(lastUpdateMs) : null,
    lastUpdate: typeof row.lastUpdate === "string" && row.lastUpdate ? row.lastUpdate : null,
  };
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function parseSnapshot(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.planes)) {
    throw new Error("flights snapshot has no planes array");
  }
  const planes = [];
  for (const row of raw.planes) {
    const plane = sanitizePlane(row);
    if (plane) planes.push(plane);
  }
  const meta = raw.meta && typeof raw.meta === "object" ? raw.meta : {};
  if (meta.fetched_at === undefined && typeof raw.fetched_at === "string") meta.fetched_at = raw.fetched_at;
  const declared = String(raw.source ?? meta.source ?? "").toLowerCase();
  return { planes, meta, source: declared === "demo" ? "demo" : "live" };
}

export async function fetchFlights(url = FLIGHTS_URL) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`flights snapshot -> HTTP ${response.status}`);
  return parseSnapshot(await response.json());
}

export function groupByCountry(planes) {
  const counts = new Map();
  for (const plane of planes) {
    if (plane.lon === null || plane.lat === null) continue;
    counts.set(plane.country, (counts.get(plane.country) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([country, count]) => ({ country, count }))
    .sort((a, b) => (a.count === b.count ? a.country.localeCompare(b.country) : b.count - a.count));
}

export function countryFilterOptions(planes, limit = 60) {
  const groups = groupByCountry(planes);
  const top = groups.slice(0, limit);
  const rest = groups.slice(limit).reduce((sum, group) => sum + group.count, 0);
  return {
    top,
    rest,
    label: (group) => `${group.country} · ${group.count}`,
  };
}

export function formatAge(elapsedMs) {
  if (elapsedMs === null || elapsedMs === undefined || !Number.isFinite(elapsedMs)) return "—";
  if (elapsedMs < 0) return "just now";
  const minutes = elapsedMs / 60000;
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)} h`;
  return `${Math.floor(hours / 24)} d`;
}

export function formatStamp(ms) {
  if (!ms) return "—";
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? "—" : `${date.toISOString().slice(0, 19)}Z`;
}

export function formatCoord(value, axis) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const hemi = value > 0 ? (axis === "lat" ? "N" : "E") : value < 0 ? (axis === "lat" ? "S" : "W") : "";
  const degrees = Math.abs(value).toFixed(2) + "°";
  return hemi ? `${degrees} ${hemi}` : degrees;
}

export function formatClock(ms) {
  if (!Number.isFinite(ms)) return "—";
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? "—" : `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}Z`;
}

export { DAY_MS };