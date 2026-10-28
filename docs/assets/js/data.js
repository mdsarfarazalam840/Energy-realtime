/* Snapshot loading, filtering, and statistics for VoltScope. */

export const SOURCE_META = {
  elecz: { label: "Elecz", hint: "spot API", color: "#ffb24d", darkColor: "#ffb24d", lightColor: "#c97900" },
  entsoe: { label: "ENTSO-E", hint: "day-ahead", color: "#4cd7ff", darkColor: "#4cd7ff", lightColor: "#0a84b8" },
};

export const FALLBACK_META = { label: "Source", hint: "feed", color: "#9fb2cc" };

export function sourceMeta(id) {
  return SOURCE_META[id] || { ...FALLBACK_META, label: id || "Unknown" };
}

export function sourceColor(id, theme = "dark") {
  const meta = sourceMeta(id);
  return theme === "light" ? meta.lightColor : meta.darkColor;
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
    const key = `${s}|${t}|${z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    points.push({ t, p, z, s });
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
    const response = await fetch(`${url}?v=${Date.now()}`, {
      cache: "no-store",
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

export function latestTime(points) {
  let max = 0;
  for (const point of points) if (point.t > max) max = point.t;
  return max;
}

/**
 * Filter by source, zone, and a window anchored on the newest raw row so stale
 * exports still render their own history instead of collapsing to nothing.
 */
export function filterPoints(points, { sources, zone, rangeMs, anchor }) {
  const cutoff = rangeMs ? anchor - rangeMs : -Infinity;
  const rows = [];
  for (const point of points) {
    if (!sources.has(point.s)) continue;
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

/** Rebase each source to 100 at its first visible reading. */
export function indexPoints(points) {
  const firstBySource = new Map();
  for (const point of points) {
    if (!firstBySource.has(point.s)) firstBySource.set(point.s, point.p);
  }
  return points.map((point) => {
    const base = firstBySource.get(point.s);
    const value = base ? (point.p / base) * 100 : point.p;
    return { ...point, v: value };
  });
}

export function withValues(points, mode = "raw") {
  if (mode === "indexed") return indexPoints(points);
  return points.map((point) => ({ ...point, v: point.p }));
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
    let group = groups.get(point.s);
    if (!group) {
      group = { id: point.s, points: [] };
      groups.set(point.s, group);
    }
    group.points.push(point);
  }

  const sources = [...groups.values()].map((group) => {
    const rows = group.points.slice().sort((a, b) => a.t - b.t);
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
  sources.sort((a, b) => a.id.localeCompare(b.id));

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
    for (const point of points) {
      if (point.s === latest.s && point.t < latest.t && (!previous || point.t > previous.t)) previous = point;
    }
  }

  return {
    sources,
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
