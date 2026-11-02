/* Space observatory data layer: NASA APOD window, fail-safe cache, demo deck,
   and formatting helpers.

   The page asks NASA for a date window (one request), not one request per day,
   so the DEMO_KEY rate limit (30 requests/hour per IP) is never spent by
   navigation. A window is 14 UTC days ending today. */

export const API_BASE = "https://api.nasa.gov/planetary/apod";
export const DEMO_KEY = "DEMO_KEY";
export const WINDOW_DAYS = 14;
export const CACHE_URL = "data/apod.json";
export const SCHEMA_VERSION = 1;

const DAY_MS = 86400000;
const API_KEY_STORAGE = "voltscope-space-apikey";

const FULL_DATE = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const SHORT_DATE = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  timeZone: "UTC",
});

/* ---------- Dates ---------- */

export function parseDate(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function utcDateString(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function formatDate(value) {
  const date = parseDate(value);
  return date ? FULL_DATE.format(date) : "—";
}

export function formatShortDate(value) {
  const date = parseDate(value);
  return date ? SHORT_DATE.format(date) : "—";
}

export function todayUTC() {
  return utcDateString(new Date());
}

export function relativeWhen(value) {
  const date = parseDate(value);
  if (!date) return "";
  const today = parseDate(todayUTC());
  const days = Math.round((today.getTime() - date.getTime()) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return `${Math.round(days / 30)} months ago`;
}

export function formatWindow(first, last) {
  if (!first || !last) return "—";
  if (!parseDate(first) || !parseDate(last)) return "—";
  if (first === last) return formatDate(first);
  const sameYear = first.slice(0, 4) === last.slice(0, 4);
  return sameYear
    ? `${formatShortDate(first)} – ${formatDate(last)}`
    : `${formatDate(first)} – ${formatDate(last)}`;
}

/* ---------- API key ---------- */

/** `?api_key=` (remembered in this browser), then the saved key, then DEMO_KEY. */
export function resolveApiKey() {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("api_key");
    if (fromUrl && fromUrl.trim()) {
      const key = fromUrl.trim();
      localStorage.setItem(API_KEY_STORAGE, key);
      return key;
    }
    const saved = localStorage.getItem(API_KEY_STORAGE);
    if (saved && saved.trim()) return saved.trim();
  } catch {
    /* Private mode can block storage and URL parsing; fall through to the demo key. */
  }
  return DEMO_KEY;
}

/* ---------- Normalization ---------- */

export function cleanEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const date = String(raw.date || "").trim();
  const title = String(raw.title || "").trim();
  if (!parseDate(date) || !title) return null;

  const mediaType = raw.media_type === "video" ? "video" : raw.media_type === "other" ? "other" : "image";
  const url = String(raw.url || "").trim();
  const hdurl = String(raw.hdurl || "").trim();
  const thumbnail = String(raw.thumbnail_url || "").trim();
  const copyright = String(raw.copyright || "").trim().replace(/\s+/g, " ");

  return {
    date,
    title,
    explanation: String(raw.explanation || "").trim().replace(/\s+/g, " "),
    mediaType,
    url,
    hdurl,
    thumbnailUrl: thumbnail,
    // The texture source: videos use their YouTube thumbnail, images use the
    // display image. "other" media has no frame of its own.
    imageUrl: mediaType === "video" ? thumbnail : mediaType === "image" ? url : "",
    copyright,
  };
}

export function normalizeEntries(list) {
  const seen = new Set();
  const entries = (Array.isArray(list) ? list : [])
    .map(cleanEntry)
    .filter(Boolean)
    .filter((entry) => {
      if (seen.has(entry.date)) return false;
      seen.add(entry.date);
      return true;
    });
  entries.sort((a, b) => a.date.localeCompare(b.date));
  if (!entries.length) throw new Error("NASA APOD returned no usable pictures");
  return entries;
}

export function buildSnapshot(entries, { demo = false, meta = {} } = {}) {
  const imageCount = entries.filter((entry) => entry.mediaType === "image").length;
  const videoCount = entries.filter((entry) => entry.mediaType === "video").length;
  return {
    schema_version: SCHEMA_VERSION,
    meta: {
      source: demo ? "demo" : "nasa-apod",
      count: entries.length,
      image_count: imageCount,
      video_count: videoCount,
      other_count: entries.length - imageCount - videoCount,
      first_date: entries[0].date,
      latest_date: entries[entries.length - 1].date,
      window_days: WINDOW_DAYS,
      generated_at: new Date().toISOString(),
      ...meta,
    },
    entries,
    demo,
  };
}

/**
 * The official API answers with a placeholder "NASA Science" record (the same
 * logo image) for dates it has no entry for. Those records are not pictures of
 * the day, so they are dropped in favour of the site-feed cache.
 */
export function isPlaceholderEntry(entry) {
  if (!entry) return true;
  return (
    /^NASA Science$/i.test(String(entry.title || "").trim()) ||
    /nasa-logo@2x\.png/i.test(String(entry.imageUrl || entry.url || ""))
  );
}

export function mediaLabel(entry) {
  if (!entry) return "—";
  if (entry.mediaType === "video") return "Video";
  if (entry.mediaType === "other") return "Feature";
  return "Image";
}

export function creditOf(entry) {
  if (!entry) return "NASA APOD";
  if (entry.copyright) return entry.copyright;
  return "Public domain · NASA";
}

/** Official APOD archive page for a date (apYYMMDD.html). */
export function archiveUrl(value) {
  const date = parseDate(value);
  if (!date) return "https://apod.nasa.gov/apod/";
  const stamp = `${String(value).slice(2, 4)}${String(value).slice(5, 7)}${String(value).slice(8, 10)}`;
  return `https://apod.nasa.gov/apod/ap${stamp}.html`;
}

/**
 * A usable source link for any entry. Demo frames (and any entry without a
 * direct asset URL) fall back to the real APOD page for that date, so a click
 * never dead-ends on "no source link".
 */
export function entryUrl(entry) {
  if (!entry) return "";
  return entry.hdurl || entry.url || archiveUrl(entry.date);
}

/* ---------- Live fetch ---------- */

export function windowRange(days = WINDOW_DAYS, end = new Date()) {
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  const total = Math.max(1, Math.min(30, Number(days) || WINDOW_DAYS));
  const first = new Date(last.getTime() - (total - 1) * DAY_MS);
  return { start: utcDateString(first), end: utcDateString(last) };
}

export function buildApiUrl({ apiKey = DEMO_KEY, days = WINDOW_DAYS } = {}) {
  const { start, end } = windowRange(days);
  const url = new URL(API_BASE);
  url.searchParams.set("api_key", apiKey || DEMO_KEY);
  url.searchParams.set("start_date", start);
  url.searchParams.set("end_date", end);
  url.searchParams.set("thumbs", "true");
  return url.toString();
}

export async function loadApodWindow({ apiKey = DEMO_KEY, days = WINDOW_DAYS, signal } = {}) {
  const attempts = 2;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(buildApiUrl({ apiKey, days }), {
        cache: "no-cache",
        signal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        const error = new Error(`NASA APOD HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const payload = await response.json();
      const list = Array.isArray(payload) ? payload : [payload];
      const entries = normalizeEntries(list);
      const usable = entries.filter((entry) => !isPlaceholderEntry(entry));
      if (!usable.length) {
        const error = new Error("NASA APOD returned placeholder records");
        error.placeholder = true;
        throw error;
      }
      return buildSnapshot(usable);
    } catch (error) {
      lastError = error;
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      // A rate limit, a bad key, or placeholder records will not fix
      // themselves in 400 ms.
      if (error.status === 429 || error.status === 403 || error.placeholder) throw error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
  throw lastError;
}

/**
 * Fail-safe cache: reads the last committed snapshot written by
 * `scripts/cache_apod.mjs` (and the `apod_cache.yml` workflow), so the page can
 * still show real pictures when NASA's API is unreachable or rate limited.
 */
export async function loadApodCache({ signal } = {}) {
  const response = await fetch(`${CACHE_URL}?v=${Date.now()}`, {
    cache: "no-store",
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`APOD cache HTTP ${response.status}`);
  const doc = await response.json();
  if (!doc || !Array.isArray(doc.entries)) throw new Error("APOD cache has no entries");
  const entries = normalizeEntries(doc.entries).filter((entry) => !isPlaceholderEntry(entry));
  if (!entries.length) throw new Error("APOD cache has only placeholder records");
  return buildSnapshot(entries, {
    meta: {
      source: "nasa-apod-cache",
      cached_at: String(doc.meta?.cached_at || doc.meta?.generated_at || ""),
    },
  });
}

/* ---------- Demo deck ---------- */

const DEMO_ENTRIES = [
  {
    title: "The Pillars of Creation in Infrared",
    explanation:
      "Towers of cold molecular gas and dust rise from a stellar nursery where new stars are condensing. In infrared light the dense pillars glow through the surrounding haze, exposing freshly formed stars still wrapped in their cocoons. This demo entry stands in for the real Astronomy Picture of the Day when NASA's API cannot be reached.",
  },
  {
    title: "Aurora Over the Southern Ocean",
    explanation:
      "A geomagnetic storm paints green and violet curtains above a dark ocean horizon. Charged particles funnelled along Earth's magnetic field collide with oxygen and nitrogen in the upper atmosphere, releasing the light seen here. Demo entry.",
  },
  {
    title: "Saturn's Rings in False Colour",
    explanation:
      "Subtle colour differences in Saturn's rings reveal variations in ice grain size and trace contamination by dust. The rings are only tens of metres thick but span hundreds of thousands of kilometres. Demo entry.",
  },
  {
    title: "A Deep Field of Distant Galaxies",
    explanation:
      "Thousands of galaxies, some formed within a few hundred million years of the Big Bang, crowd a single patch of sky smaller than a grain of sand held at arm's length. Demo entry.",
  },
  {
    title: "The Lunar Terminator at Sunrise",
    explanation:
      "Along the day-night boundary the Sun grazes the lunar surface at a low angle, throwing crater rims and mountain peaks into long relief. Shadows exaggerate topography that is otherwise invisible under a full Moon. Demo entry.",
  },
  {
    title: "A Solar Prominence in Hydrogen Alpha",
    explanation:
      "A loop of magnetically confined plasma arcs above the Sun's limb. Prominences can persist for weeks before erupting as coronal mass ejections. Demo entry.",
  },
  {
    title: "Andromeda's Extended Halo",
    explanation:
      "The Andromeda galaxy's gaseous halo stretches far beyond its visible spiral arms, a diffuse reservoir of gas that feeds future star formation. Demo entry.",
  },
  {
    title: "Voyager's Pale Blue Dot",
    explanation:
      "A video feature: the farthest portrait of Earth ever taken, captured from beyond Neptune. In a single beam of scattered sunlight our world is a fraction of a pixel. Demo entry.",
    mediaType: "video",
  },
  {
    title: "The Bug Nebula in Narrowband",
    explanation:
      "Complex filaments of a planetary nebula glow in the light of ionised oxygen and hydrogen, shaped by a fast wind from the dying central star. Demo entry.",
  },
  {
    title: "A Dust Devil on Mars",
    explanation:
      "A whirlwind of fine dust tracks across a crater floor, imaged from orbit. Martian dust devils can climb kilometres high and help clean solar panels on rovers. Demo entry.",
  },
  {
    title: "A Total Eclipse from Orbit",
    explanation:
      "The Moon's shadow sweeps across Earth's cloud tops as seen from a satellite, a dark ellipse racing over the planet at more than a thousand kilometres per hour. Demo entry.",
  },
  {
    title: "The Milky Way's Galactic Core",
    explanation:
      "Dense star fields and dark dust lanes surround the supermassive black hole at the centre of our galaxy. This infrared view pierces much of the obscuring dust. Demo entry.",
  },
];

export function createDemoSnapshot() {
  const today = parseDate(todayUTC());
  const entries = DEMO_ENTRIES.map((demo, index) => {
    const date = utcDateString(new Date(today.getTime() - index * DAY_MS));
    return {
      date,
      title: demo.title,
      explanation: demo.explanation,
      mediaType: demo.mediaType || "image",
      url: "",
      hdurl: "",
      thumbnailUrl: "",
      imageUrl: "",
      copyright: "",
    };
  }).sort((a, b) => a.date.localeCompare(b.date));
  return buildSnapshot(entries, {
    demo: true,
    meta: { source: "demo", generated_at: new Date().toISOString() },
  });
}
