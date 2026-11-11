/* AI & Tech Trends data layer: Hugging Face trending model loading,
   demo fallback, and formatting helpers. */

export const API_URL = "https://huggingface.co/api/models?limit=100";
export const MAX_MODELS = 100;
export const CACHE_URL = "data/ai-trends.json";
export const SCHEMA_VERSION = 1;

const DEMO_MODELS = [
  ["xtools-at/DeepSeek-V4-Pro-Qwen3.5-9B", "xtools-at", "DeepSeek-V4-Pro-Qwen3.5-9B", 961, 1249, 14378, "text-generation", "transformers"],
  ["speridlabs/idol", "speridlabs", "idol", 934, 1897, 26470, "image-to-3d", "idol"],
  ["moonshotai/Kimi-K3.1-Pro", "moonshotai", "Kimi-K3.1-Pro", 619, 1878, 30721, "image-text-to-text", "transformers"],
  ["MiniMaxAI/MiniMax-H3-Image", "MiniMaxAI", "MiniMax-H3-Image", 485, 490, 667, "text-to-image", "minimax-h3"],
  ["ricursiveAI/Ripple-65B-Preview", "ricursiveAI", "Ripple-65B-Preview", 468, 490, 6480, "text-generation", "—"],
];

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function cleanModel(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || raw.modelId || "").trim();
  if (!id) return null;
  const parts = id.split("/");
  const author = String(raw.author || parts[0] || "").trim() || "unknown";
  const title = String(raw.modelId || id).split("/").pop() || id;
  return {
    id,
    modelId: String(raw.modelId || id).trim(),
    author,
    title,
    likes: finite(raw.likes),
    downloads: finite(raw.downloads),
    trendingScore: finite(raw.trendingScore),
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    pipeline_tag: String(raw.pipeline_tag || "").trim() || "—",
    library_name: String(raw.library_name || "").trim() || "—",
    createdAt: raw.createdAt ? new Date(raw.createdAt).toISOString() : "",
    url: `https://huggingface.co/${id}`,
  };
}

export function normalizeModels(list) {
  const models = (Array.isArray(list) ? list : [])
    .map(cleanModel)
    .filter(Boolean);
  if (!models.length) throw new Error("AI snapshot has no usable models");
  models.sort((a, b) => b.trendingScore - a.trendingScore || b.downloads - a.downloads);
  return models;
}

export function buildSnapshot(models, { demo = false, meta = {} } = {}) {
  const totalDownloads = models.reduce((sum, m) => sum + m.downloads, 0);
  const totalLikes = models.reduce((sum, m) => sum + m.likes, 0);
  const avgTrending = models.length
    ? Math.round(models.reduce((sum, m) => sum + m.trendingScore, 0) / models.length)
    : 0;
  const byPipeline = new Map();
  for (const m of models) {
    byPipeline.set(m.pipeline_tag, (byPipeline.get(m.pipeline_tag) || 0) + 1);
  }
  const topPipeline = [...byPipeline.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "—";
  return {
    schema_version: SCHEMA_VERSION,
    meta: {
      source: demo ? "demo" : "huggingface",
      count: models.length,
      average_trending_score: avgTrending,
      total_downloads: totalDownloads,
      total_likes: totalLikes,
      top_pipeline: topPipeline,
      generated_at: new Date().toISOString(),
      ...meta,
    },
    models,
    demo,
  };
}

export function createDemoSnapshot() {
  const models = DEMO_MODELS.map(
    ([id, author, title, trendingScore, likes, downloads, pipeline, library]) =>
      cleanModel({
        id,
        modelId: id,
        author,
        trendingScore,
        likes,
        downloads,
        pipeline_tag: pipeline,
        library_name: library,
        tags: [pipeline],
      })
  ).filter(Boolean);
  return buildSnapshot(models, { demo: true });
}

export async function loadHfModels({ signal } = {}) {
  const attempts = 2;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${API_URL}&v=${Date.now()}`, {
        cache: "no-store",
        signal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Hugging Face API HTTP ${response.status}`);
      const list = await response.json();
      if (!Array.isArray(list) || !list.length) throw new Error("Hugging Face returned no models");
      const models = normalizeModels(list).slice(0, MAX_MODELS);
      return buildSnapshot(models);
    } catch (error) {
      lastError = error;
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
    }
  }
  throw lastError;
}

export async function loadHfCache({ signal } = {}) {
  const response = await fetch(`${CACHE_URL}?v=${Date.now()}`, {
    cache: "no-store",
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Hugging Face cache HTTP ${response.status}`);
  const doc = await response.json();
  if (!doc || !Array.isArray(doc.models)) throw new Error("Hugging Face cache has no models");
  const models = normalizeModels(doc.models);
  return buildSnapshot(models, {
    meta: { source: "huggingface-cache", cached_at: String(doc.meta?.cached_at || "") },
  });
}

export function formatCount(value) {
  const number = finite(value);
  if (number >= 1e9) return `${(number / 1e9).toFixed(1)}B`;
  if (number >= 1e6) return `${(number / 1e6).toFixed(1)}M`;
  if (number >= 1e3) return `${(number / 1e3).toFixed(1)}k`;
  return String(Math.round(number));
}

export function trendingTone(score) {
  const s = finite(score);
  if (s >= 700) return "hot";
  if (s >= 300) return "warm";
  return "cool";
}
