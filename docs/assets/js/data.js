/* Snapshot loading, filtering, and statistics for VoltScope. */

export const SOURCE_META = {
  elecz: { label: "Elecz", hint: "spot API", color: "#ffb24d", darkColor: "#ffb24d", lightColor: "#c97900" },
  entsoe: { label: "ENTSO-E", hint: "day-ahead", color: "#4cd7ff", darkColor: "#4cd7ff", lightColor: "#0a84b8" },
  aemo: {
    label: "AEMO",
    hint: "5-minute NEM dispatch",
    color: "#f28c45",
    darkColor: "#f28c45",
    lightColor: "#b84f12",
  },
};

export const FALLBACK_META = { label: "Source", hint: "feed", color: "#9fb2cc" };

export const COUNTRY_NAMES = {
  DE: "Germany",
  NL: "Netherlands",
  BE: "Belgium",
  AT: "Austria",
  FR: "France",
  PL: "Poland",
  CH: "Switzerland",
  CZ: "Czechia",
  SK: "Slovakia",
  HU: "Hungary",
  SI: "Slovenia",
  ES: "Spain",
  PT: "Portugal",
  SE: "Sweden",
  NO: "Norway",
  DK: "Denmark",
  FI: "Finland",
  EE: "Estonia",
  LV: "Latvia",
  LT: "Lithuania",
  HR: "Croatia",
  RO: "Romania",
  BG: "Bulgaria",
  GR: "Greece",
  RS: "Serbia",
  BA: "Bosnia and Herzegovina",
  ME: "Montenegro",
  MK: "North Macedonia",
  AL: "Albania",
  XK: "Kosovo",
  MD: "Moldova",
  UA: "Ukraine",
  IE: "Ireland",
  IT: "Italy",
  AU: "Australia",
};

export function sourceMeta(id) {
  return SOURCE_META[id] || { ...FALLBACK_META, label: id || "Unknown" };
}

export function sourceColor(id, theme = "dark") {
  const meta = sourceMeta(id);
  return theme === "light" ? meta.lightColor : meta.darkColor;
}

/* ---------------- zones and lanes ---------------- */

/** ISO country code for a public zone code: `SE3` -> `SE`, `IT_NORD` -> `IT`. */
export function countryOf(zone) {
  const value = String(zone || "").toUpperCase();
  if (["NSW1", "QLD1", "VIC1", "SA1", "TAS1"].includes(value)) return "AU";
  const head = value.split(/[_-]/)[0];
  const code = head.replace(/\d+$/, "");
  return code || head || "??";
}

export function countryLabel(code) {
  return COUNTRY_NAMES[code] || code || "Unknown";
}

export function laneOf(point) {
  return `${point.s}|${point.z}`;
}

/** Stable selection key for one reading. Zones never contain `|`. */
export function pointKey(point) {
  return `${point.s}|${point.z}|${point.t}`;
}

export function laneParts(id) {
  const cut = String(id).indexOf("|");
  if (cut < 0) return { source: String(id), zone: "" };
  return { source: id.slice(0, cut), zone: id.slice(cut + 1) };
}

export function laneLabel(id) {
  const { source, zone } = laneParts(id);
  if (source === "elecz") return `Elecz ${zone}`;
  if (source === "aemo") return `AEMO ${zone}`;
  return zone;
}

function hueOf(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash % 360;
}

/** HSL to `#rrggbb`; charts append a hex alpha suffix to these colours. */
function hslToHex(hue, saturation, lightness) {
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const sector = ((hue % 360) + 360) % 360 / 60;
  const x = chroma * (1 - Math.abs((sector % 2) - 1));
  const match = l - chroma / 2;
  let rgb;
  if (sector < 1) rgb = [chroma, x, 0];
  else if (sector < 2) rgb = [x, chroma, 0];
  else if (sector < 3) rgb = [0, chroma, x];
  else if (sector < 4) rgb = [0, x, chroma];
  else if (sector < 5) rgb = [x, 0, chroma];
  else rgb = [chroma, 0, x];
  return `#${rgb
    .map((channel) => Math.round((channel + match) * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * Colour per zone, grouped by country. Zones in one country share a hue so the
 * country filter reads as a family; Elecz keeps its own warm accent.
 */
export function laneColor(id, theme = "dark") {
  const { source, zone } = laneParts(id);
  if (source === "elecz") return theme === "light" ? "#c97900" : "#ffb24d";
  if (source === "aemo") return theme === "light" ? "#b84f12" : "#f28c45";
  const hue = hueOf(countryOf(zone));
  return theme === "light" ? hslToHex(hue, 72, 40) : hslToHex(hue, 82, 64);
}

export function parseSnapshot(raw) {
  if (!raw || !Array.isArray(raw.points)) throw new Error("Snapshot has no points array");
  const seen = new Set();
  const points = [];
  for (const row of raw.points) {
    const t = Number(row.t);
    const p = Number(row.p);
    if (!Number.isFinite(t) || !Number.isFinite(p)) continue;
    const s = String(row.s || "unknown");
    const z = String(row.z || "unknown");
    const l = `${s}|${z}`;
    const key = `${s}|${t}|${z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    points.push({ t, p, z, s, l });
  }
  points.sort((a, b) => a.t - b.t || a.s.localeCompare(b.s));
  return {
    ...raw,
    meta: raw.meta || {},
    points,
    generated: raw.generated_at ? Date.parse(raw.generated_at) : Date.now(),
    demo: Boolean(raw.demo || (raw.meta && raw.meta.demo)),
  };
}

export async function loadSnapshot(url = "data/energy.json") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    // Revalidate with ETag instead of minting a unique URL. Every open
    // dashboard then costs one conditional request per minute (usually 304),
    // not a full snapshot download from the origin.
    const response = await fetch(url, {
      cache: "no-cache",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parseSnapshot(await response.json());
  } finally {
    clearTimeout(timer);
  }
}

export function sourceIds(points) {
  return [...new Set(points.map((p) => p.s))].sort();
}

export function zoneIds(points) {
  return [...new Set(points.map((p) => p.z))].sort();
}

export function countryIds(points) {
  return [...new Set(points.map((p) => countryOf(p.z)))].sort();
}

/** Lanes are one market each: source + zone. */
export function laneIds(points) {
  return [...new Set(points.map((point) => point.l || laneOf(point)))].sort((a, b) => {
    const left = laneParts(a);
    const right = laneParts(b);
    return left.zone.localeCompare(right.zone) || left.source.localeCompare(right.source);
  });
}

export function latestTime(points) {
  let max = 0;
  for (const point of points) if (point.t > max) max = point.t;
  return max;
}

/**
 * Filter by source, country, zone, and a window anchored on the newest raw row
 * so stale exports still render their own history instead of collapsing.
 */
export function filterPoints(points, { sources, country, zone, rangeMs, anchor }) {
  const cutoff = rangeMs ? anchor - rangeMs : -Infinity;
  const rows = [];
  for (const point of points) {
    if (!sources.has(point.s)) continue;
    if (country && country !== "all" && countryOf(point.z) !== country) continue;
    if (zone !== "all" && point.z !== zone) continue;
    if (point.t < cutoff) continue;
    rows.push(point);
  }
  return rows;
}

export function applyPlayhead(points, playhead) {
  if (playhead == null) return points;
  return points.filter((point) => point.t <= playhead);
}

/** Rebase each lane (source + zone) to 100 at its first visible reading. */
export function indexPoints(points) {
  const firstByLane = new Map();
  for (const point of points) {
    const lane = point.l || laneOf(point);
    if (!firstByLane.has(lane)) firstByLane.set(lane, point.p);
  }
  return points.map((point) => {
    const base = firstByLane.get(point.l || laneOf(point));
    const value = base ? (point.p / base) * 100 : point.p;
    return { ...point, v: value };
  });
}

export function withValues(points, mode = "raw") {
  if (mode === "indexed") return indexPoints(points);
  // Raw mode needs no copy: every consumer already reads `v ?? p`.
  return points;
}

export function valueDomain(points, baseline = "window") {
  if (!points.length) return { min: 0, max: 1, pad: 0.1 };
  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    const value = point.v ?? point.p;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (baseline === "zero") {
    min = Math.min(0, min);
    max = Math.max(0, max);
  } else if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = max - min || 1;
  const pad = span * 0.08;
  return { min: min - pad, max: max + pad, rawMin: min, rawMax: max };
}

export function summarize(points) {
  const groups = new Map();
  for (const point of points) {
    const lane = point.l || laneOf(point);
    let group = groups.get(lane);
    if (!group) {
      const { source, zone } = laneParts(lane);
      group = { id: lane, source, zone, country: countryOf(zone), points: [] };
      groups.set(lane, group);
    }
    group.points.push(point);
  }

  const lanes = [...groups.values()].map((group) => {
    // Points arrive time-sorted (parseSnapshot sorts, every filter keeps order),
    // so the per-lane sort that used to run here is redundant at 80k rows.
    const rows = group.points;
    const values = rows.map((row) => row.v ?? row.p);
    const first = values[0];
    const last = values[values.length - 1];
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (const value of values) {
      if (value < min) min = value;
      if (value > max) max = value;
      sum += value;
    }
    const mean = sum / values.length;
    let variance = 0;
    for (const value of values) variance += (value - mean) ** 2;
    variance /= values.length;
    const previous = values.length > 1 ? values[values.length - 2] : null;
    return {
      id: group.id,
      source: group.source,
      zone: group.zone,
      country: group.country,
      label: laneLabel(group.id),
      count: values.length,
      first,
      last,
      min,
      max,
      mean,
      std: Math.sqrt(variance),
      change: last - first,
      changePct: first ? ((last - first) / Math.abs(first)) * 100 : 0,
      lastChange: previous == null ? null : last - previous,
      lastChangePct: previous ? ((last - previous) / Math.abs(previous)) * 100 : null,
      firstTime: rows[0].t,
      lastTime: rows[rows.length - 1].t,
      rawLast: rows[rows.length - 1].p,
    };
  });
  lanes.sort((a, b) => a.zone.localeCompare(b.zone) || a.source.localeCompare(b.source));

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;
  let firstTime = Infinity;
  let lastTime = -Infinity;
  let latest = null;
  for (const point of points) {
    const value = point.v ?? point.p;
    if (value < min) min = value;
    if (value > max) max = value;
    if (point.t < firstTime) firstTime = point.t;
    if (point.t > lastTime) { lastTime = point.t; latest = point; }
    sum += value;
    count += 1;
  }
  const mean = count ? sum / count : 0;
  let variance = 0;
  for (const point of points) variance += ((point.v ?? point.p) - mean) ** 2;
  variance = count ? variance / count : 0;

  let previous = null;
  if (latest) {
    const lane = latest.l || laneOf(latest);
    for (const point of points) {
      const pointLane = point.l || laneOf(point);
      if (pointLane === lane && point.t < latest.t && (!previous || point.t > previous.t)) previous = point;
    }
  }

  return {
    lanes,
    count,
    min: count ? min : 0,
    max: count ? max : 0,
    mean,
    std: Math.sqrt(variance),
    spread: count ? max - min : 0,
    firstTime: count ? firstTime : 0,
    lastTime: count ? lastTime : 0,
    latest,
    latestValue: latest ? (latest.v ?? latest.p) : null,
    previous,
    change: latest && previous ? (latest.v ?? latest.p) - (previous.v ?? previous.p) : 0,
    changePct:
      latest && previous && previous.p !== 0
        ? (((latest.v ?? latest.p) - (previous.v ?? previous.p)) / Math.abs(previous.p)) * 100
        : 0,
  };
}

/* ---------------- formatting ---------------- */

const priceFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const compactFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatPrice(value, digits = 2) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (digits === 2) return priceFormatter.format(value);
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatCompact(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return Math.abs(value) >= 1000 ? compactFormatter.format(value) : formatPrice(value, 1);
}

export function formatSigned(value, digits = 2, suffix = "") {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}${suffix}`;
}

export function timeLabel(ms, { seconds = false, day = false } = {}) {
  if (!ms) return "—";
  const date = new Date(ms);
  const time = date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: seconds ? "2-digit" : undefined,
    timeZone: "UTC",
  });
  if (!day) return time;
  return `${date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" })} · ${time}`;
}

export function fullLabel(ms) {
  if (!ms) return "—";
  const date = new Date(ms);
  return `${date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  })} · ${timeLabel(ms, { seconds: true })} UTC`;
}

export function relativeTime(ms, now = Date.now()) {
  if (!ms) return "—";
  const diff = Math.max(0, now - ms);
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function rangeLabel(ms) {
  if (!ms) return "all time";
  const hours = ms / 3600000;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}
