/* Fail-Safe Cache writer for the Tech Pulse (Hacker News) widget.
 *
 * Fetches the latest Hacker News top stories and writes a compact JSON snapshot
 * to docs/data/tech-news.json. The GitHub Action `hn_cache.yml` runs this on a
 * schedule and commits the file when it changes, so the static page always has
 * a recent, known-good copy of the headlines to fall back to if the live API
 * is unreachable.
 *
 * Usage:  node scripts/cache_hn.mjs
 */

import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";

const API_BASE = "https://hacker-news.firebaseio.com/v0";
const TOP_STORIES_URL = `${API_BASE}/topstories.json`;
const ITEM_URL = (id) => `${API_BASE}/item/${id}.json`;
const MAX_STORIES = 60;
const SCHEMA_VERSION = 1;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function hostOf(url) {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function cleanStory(raw) {
  if (!raw || typeof raw !== "object" || raw.type !== "story") return null;
  const id = finite(raw.id);
  const title = String(raw.title || "").trim();
  if (!id || !title) return null;
  const url = String(raw.url || "").trim();
  return {
    id,
    type: "story",
    title,
    url: url || `https://news.ycombinator.com/item?id=${id}`,
    domain: hostOf(url),
    by: String(raw.by || "").trim() || "anonymous",
    score: finite(raw.score),
    comments: finite(raw.descendants),
    time: finite(raw.time),
    timeISO: raw.time ? new Date(raw.time * 1000).toISOString() : "",
  };
}

async function main() {
  const listResponse = await fetch(TOP_STORIES_URL, { headers: { Accept: "application/json" } });
  if (!listResponse.ok) throw new Error(`Hacker News top stories HTTP ${listResponse.status}`);
  const ids = await listResponse.json();
  const chosen = Array.isArray(ids) ? ids.slice(0, MAX_STORIES) : [];

  const items = await Promise.all(
    chosen.map((id) =>
      fetch(ITEM_URL(id), { headers: { Accept: "application/json" } })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null)
    )
  );

  const stories = items.map(cleanStory).filter(Boolean);
  if (!stories.length) throw new Error("Hacker News returned no usable stories");
  stories.sort((a, b) => b.score - a.score || b.time - a.time);

  const count = stories.length;
  const totalComments = stories.reduce((sum, story) => sum + story.comments, 0);
  const byDomain = new Map();
  for (const story of stories) {
    byDomain.set(story.domain, (byDomain.get(story.domain) || 0) + 1);
  }
  const topDomain = [...byDomain.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "—";

  const snapshot = {
    schema_version: SCHEMA_VERSION,
    meta: {
      source: "hackernews-cache",
      count,
      average_score: Math.round(stories.reduce((sum, story) => sum + story.score, 0) / count),
      total_comments: totalComments,
      top_domain: topDomain,
      generated_at: new Date().toISOString(),
      cached_at: new Date().toISOString(),
    },
    stories,
    demo: false,
  };

  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, "..");
  const out = path.join(root, "docs", "data", "tech-news.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(`wrote ${out} (${count} stories)`);
}

main().catch((error) => {
  console.error("cache_hn failed:", error && error.message ? error.message : error);
  process.exit(1);
});
