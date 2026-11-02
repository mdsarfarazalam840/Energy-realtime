/* Fail-Safe Cache writer for the Space (NASA APOD) page.
 *
 * Fetches a UTC date window of NASA's Astronomy Picture of the Day and writes a
 * compact JSON snapshot to docs/data/apod.json. The GitHub Action
 * `apod_cache.yml` runs this on a schedule and commits the file when it
 * changes, so the static page always has real pictures to fall back to when
 * api.nasa.gov is unreachable or rate limited.
 *
 * The official API is tried first. It can return placeholder "NASA Science"
 * records (all pointing at the same logo) for dates it has no entry for; when
 * that happens, or when the API fails, this script reads NASA's public APOD
 * site feed (the same `image-article` records the APOD page renders) so the
 * snapshot keeps real titles, explanations and images.
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
const SITE_BASE = "https://science.nasa.gov/wp-json/wp/v2/image-article";
const APOD_CATEGORY = "22766";
const DEMO_KEY = "DEMO_KEY";
const SCHEMA_VERSION = 1;
const DAY_MS = 86400000;
const DEFAULT_DAYS = 14;

function utcDateString(date) {
  return date.toISOString().slice(0, 10);
}

function decodeEntities(value) {
  return String(value)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&ndash;/gi, "–")
    .replace(/&mdash;/gi, "—")
    .replace(/&hellip;/gi, "…")
    .replace(/&lsquo;/gi, "‘")
    .replace(/&rsquo;/gi, "’")
    .replace(/&ldquo;/gi, "“")
    .replace(/&rdquo;/gi, "”")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function cleanHtml(value) {
  return decodeEntities(
    String(value || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:?!])/g, "$1")
    .trim();
}

function cleanTitle(raw) {
  let title = cleanHtml(raw);
  if (/^APOD:/i.test(title)) {
    // "APOD: 2026 November 2 – A Long Cloud on Mars" → "A Long Cloud on Mars"
    const parts = title.split(/\s[–—-]\s/);
    if (parts.length > 1) title = parts.slice(1).join(" – ");
  }
  return title.trim();
}

function isPlaceholder(raw) {
  const title = String(raw?.title || "").trim();
  const url = String(raw?.hdurl || raw?.url || raw?.thumbnail_url || "");
  return /^NASA Science$/i.test(title) || /nasa-logo@2x\.png/i.test(url);
}

/* ---------- Official API ---------- */

async function fetchApiEntries({ apiKey, days }) {
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
  return list
    .map(cleanEntry)
    .filter(Boolean)
    .filter((entry) => {
      if (seen.has(entry.date)) return false;
      seen.add(entry.date);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
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
    explanation: cleanHtml(raw.explanation || ""),
    media_type: mediaType,
    url,
    hdurl,
    thumbnail_url: thumbnail,
    copyright: String(raw.copyright || "").trim().replace(/\s+/g, " "),
  };
}

/* ---------- APOD site feed (real records) ---------- */

async function fetchSiteEntries({ days }) {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - (days - 1) * DAY_MS);
  const startDate = utcDateString(start);
  const endDate = utcDateString(end);

  const url = new URL(SITE_BASE);
  url.searchParams.set("categories", APOD_CATEGORY);
  url.searchParams.set("per_page", String(Math.min(100, Math.max(14, days + 6))));
  url.searchParams.set("orderby", "date");
  url.searchParams.set("order", "desc");
  url.searchParams.set("_fields", "id,date,slug,link,title,content,featured_image_url");

  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`APOD site feed HTTP ${response.status}`);
  const posts = await response.json();
  if (!Array.isArray(posts)) throw new Error("APOD site feed returned no posts");

  const entries = posts
    .map(cleanSitePost)
    .filter(Boolean)
    .filter((entry) => entry.date >= startDate && entry.date <= endDate);

  const seen = new Set();
  return entries
    .filter((entry) => {
      if (seen.has(entry.date)) return false;
      seen.add(entry.date);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

function cleanSitePost(post) {
  if (!post || typeof post !== "object") return null;
  const date = String(post.date || "").slice(0, 10);
  const content = String(post.content?.rendered || "");
  const title = cleanTitle(post.title?.rendered);
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const imageUrl = String(post.featured_image_url || "").trim();
  // Only a real player counts; explanation text often links to YouTube clips.
  const isVideo = /<iframe|<video|youtube\.com\/embed|player\.vimeo\.com/i.test(content);

  const explanationMatch =
    content.match(/media-detail-hero__description[^>]*>([\s\S]*?)<\/p>/i) ||
    content.match(/<strong>\s*Explanation:\s*<\/strong>([\s\S]*?)<\/p>/i);
  const explanation = cleanHtml(explanationMatch ? explanationMatch[1] : "").replace(/^Explanation:\s*/i, "");

  const creditMatch = content.match(/Credit:\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
  const copyright = creditMatch
    ? cleanHtml(creditMatch[1]).replace(/\s*;?\s*Processing[\s\S]*$/i, "").slice(0, 160)
    : "";

  if (isVideo) {
    if (!post.link) return null;
    return {
      date,
      title,
      explanation,
      media_type: "video",
      url: String(post.link),
      hdurl: "",
      thumbnail_url: imageUrl,
      copyright,
    };
  }

  if (!imageUrl) return null;
  return {
    date,
    title,
    explanation,
    media_type: "image",
    url: imageUrl,
    hdurl: imageUrl,
    thumbnail_url: "",
    copyright,
  };
}

/* ---------- Main ---------- */

async function main() {
  const days = Math.max(1, Math.min(30, Number(process.env.APOD_DAYS) || DEFAULT_DAYS));
  const apiKey = (process.env.NASA_API_KEY || "").trim() || DEMO_KEY;

  let entries = [];
  let apiHadPlaceholders = false;

  try {
    const apiEntries = await fetchApiEntries({ apiKey, days });
    const usable = apiEntries.filter((entry) => !isPlaceholder(entry));
    apiHadPlaceholders = usable.length < apiEntries.length;
    entries = usable;
    if (apiHadPlaceholders) {
      console.warn(`official API returned ${apiEntries.length - usable.length} placeholder record(s); trying the APOD site feed`);
    }
  } catch (error) {
    console.warn(`official API unavailable: ${error.message}; trying the APOD site feed`);
  }

  if (!entries.length || apiHadPlaceholders) {
    try {
      const siteEntries = await fetchSiteEntries({ days });
      if (siteEntries.length > entries.length) {
        console.log(`using ${siteEntries.length} real record(s) from the NASA APOD site feed`);
        entries = siteEntries;
      }
    } catch (error) {
      console.warn(`APOD site feed unavailable: ${error.message}`);
    }
  }

  if (!entries.length) throw new Error("No usable NASA APOD entries were returned");
  if (entries.some((entry) => !entry.explanation)) {
    console.warn("warning: some entries have no explanation text");
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
