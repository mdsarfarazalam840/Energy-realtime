/* Fail-Safe Cache writer for the AI & Tech Trends (Hugging Face) widget.
 *
 * Fetches the latest trending AI models from the Hugging Face Hub API and
 * writes a compact JSON snapshot to docs/data/ai-trends.json. The GitHub
 * Action `hf_cache.yml` runs this on a schedule and commits the file when it
 * changes, so the static page always has a recent, known-good copy of the
 * trending models to fall back to if the live API is unreachable.
 *
 * Usage:  node scripts/cache_hf.mjs
 */

import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";

const API_URL = "https://huggingface.co/api/models?limit=100";
const MAX_MODELS = 100;
const SCHEMA_VERSION = 1;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanModel(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || raw.modelId || "").trim();
  if (!id) return null;
  const author = String(raw.author || id.split("/")[0] || "").trim() || "unknown";
  const title = String(raw.modelId || id).split("/").pop() || id;
  const likes = finite(raw.likes);
  const downloads = finite(raw.downloads);
  const trendingScore = finite(raw.trendingScore);
  const pipelineTag = String(raw.pipeline_tag || "").trim() || "—";
  const tags = Array.isArray(raw.tags) ? raw.tags : [];
  const createdAt = raw.createdAt ? new Date(raw.createdAt).toISOString() : "";
  return {
    id,
    modelId: String(raw.modelId || id).trim(),
    author,
    title,
    likes,
    downloads,
    trendingScore,
    tags,
    pipeline_tag: pipelineTag,
    library_name: String(raw.library_name || "").trim() || "—",
    createdAt,
    url: `https://huggingface.co/${id}`,
  };
}

async function main() {
  const response = await fetch(API_URL, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Hugging Face API HTTP ${response.status}`);
  const list = await response.json();
  if (!Array.isArray(list) || !list.length) throw new Error("Hugging Face returned no models");

  const models = list.map(cleanModel).filter(Boolean);
  if (!models.length) throw new Error("Hugging Face returned no usable models");

  // Guarantee trending order: sort by trendingScore descending, then downloads.
  models.sort((a, b) => b.trendingScore - a.trendingScore || b.downloads - a.downloads);

  const chosen = models.slice(0, MAX_MODELS);

  const count = chosen.length;
  const totalDownloads = chosen.reduce((sum, m) => sum + m.downloads, 0);
  const totalLikes = chosen.reduce((sum, m) => sum + m.likes, 0);
  const avgTrending = Math.round(chosen.reduce((sum, m) => sum + m.trendingScore, 0) / count);

  const byPipeline = new Map();
  for (const m of chosen) {
    byPipeline.set(m.pipeline_tag, (byPipeline.get(m.pipeline_tag) || 0) + 1);
  }
  const topPipeline = [...byPipeline.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "—";

  const snapshot = {
    schema_version: SCHEMA_VERSION,
    meta: {
      source: "huggingface-cache",
      count,
      average_trending_score: avgTrending,
      total_downloads: totalDownloads,
      total_likes: totalLikes,
      top_pipeline: topPipeline,
      generated_at: new Date().toISOString(),
      cached_at: new Date().toISOString(),
    },
    models: chosen,
    demo: false,
  };

  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, "..");
  const out = path.join(root, "docs", "data", "ai-trends.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(`wrote ${out} (${count} models)`);
}

main().catch((error) => {
  console.error("cache_hf failed:", error && error.message ? error.message : error);
  process.exit(1);
});
