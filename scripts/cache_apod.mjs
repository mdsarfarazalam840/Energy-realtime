/* Fail-Safe Cache writer for the Space (NASA APOD) page.
 *
 * Fetches a UTC date window of NASA's Astronomy Picture of the Day and writes a
 * compact JSON snapshot to docs/data/apod.json. The GitHub Action
 * `apod_cache.yml` runs this on a schedule and commits the file when it
 * changes, so the static page always has real pictures to fall back to when
 * api.nasa.gov is unreachable or rate limited.
 *
 * The public DEMO_KEY works immediately (30 requests/hour per IP). Set
 * NASA_API_KEY for the higher limit used by the scheduled workflow.
 *
 * Usage:  node scripts/cache_apod.mjs
 *         APOD_DAYS=7 NASA_API_KEY=... node scripts/cache_apod.mjs
 */

import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";

const API_BASE = "https://api.nasa.gov/planetary/apod";
const DEMO_KEY = "DEMO_KEY";
const SCHEMA_VERSION = 1;
const DAY_MS = 86400000;
const DEFAULT_DAYS = 14;

function utcDateString(date) {
  return date.toISOString().slice(0, 10);
}

function cleanEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const date = String(raw.date || "").trim();
  const title = String(raw.title || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !title) return null;

  const mediaType = raw.media_type === "video" ? "video" : raw.media_type === "other" ? "other" : "image";
  const url = String(raw.url || "").trim();
  const hdurl = String(raw.hdurl || "").trim();
  const thumbnail = String(raw.thumbnail_url || "").trim();

  return {
    date,
    title,
    explanation: String(raw.explanation || "").trim().replace(/\s+/g, " "),
    media_type: mediaType,
    url,
    hdurl,
    thumbnail_url: thumbnail,
    copyright: String(raw.copyright || "").trim().replace(/\s+/g, " "),
  };
}

async function main() {
  const days = Math.max(1, Math.min(30, Number(process.env.APOD_DAYS) || DEFAULT_DAYS));
  const apiKey = (process.env.NASA_API_KEY || "").trim() || DEMO_KEY;

  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - (days - 1) * DAY_MS);

  const url = new URL(API_BASE);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("start_date", utcDateString(start));
  url.searchParams.set("end_date", utcDateString(end));
  url.searchParams.set("thumbs", "true");

  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`NASA APOD HTTP ${response.status}`);
  const payload = await response.json();
  const list = Array.isArray(payload) ? payload : [payload];

  const seen = new Set();
  const entries = list
    .map(cleanEntry)
    .filter(Boolean)
    .filter((entry) => {
      if (seen.has(entry.date)) return false;
      seen.add(entry.date);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  if (!entries.length) throw new Error("NASA APOD returned no usable entries");

  for (const entry of entries) {
    if (!entry.explanation) console.warn(`warning: ${entry.date} has no explanation`);
  }

  const snapshot = {
    schema_version: SCHEMA_VERSION,
    meta: {
      source: "nasa-apod-cache",
      count: entries.length,
      image_count: entries.filter((entry) => entry.media_type === "image").length,
      video_count: entries.filter((entry) => entry.media_type === "video").length,
      other_count: entries.filter((entry) => entry.media_type === "other").length,
      first_date: entries[0].date,
      latest_date: entries[entries.length - 1].date,
      window_days: days,
      generated_at: new Date().toISOString(),
      cached_at: new Date().toISOString(),
    },
    entries,
    demo: false,
  };

  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, "..");
  const out = path.join(root, "docs", "data", "apod.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(`wrote ${out} (${entries.length} entries, ${entries[0].date} to ${entries[entries.length - 1].date})`);
}

main().catch((error) => {
  console.error("cache_apod failed:", error && error.message ? error.message : error);
  process.exit(1);
});
