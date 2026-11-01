/* Tech Pulse data layer: Hacker News top-story loading, demo fallback, and formatting. */

export const API_BASE = "https://hacker-news.firebaseio.com/v0";
export const TOP_STORIES_URL = `${API_BASE}/topstories.json`;
export const ITEM_URL = (id) => `${API_BASE}/item/${id}.json`;
export const MAX_STORIES = 60;
export const CACHE_URL = "data/tech-news.json";
export const SCHEMA_VERSION = 1;

const DEMO_STORIES = [
  ["Apple unveils LLM-powered on-device AI assistant", "https://www.apple.com/newsroom/", "apple.com", "timsweeney", 1284, 386, 1730000000],
  ["A low-level look at Rust's async runtime", "https://blog.burntsushi.net/async/", "blog.burntsushi.net", "burntsushi", 941, 218, 1729900000],
  ["The future of the programming language ecosystem", "https://talkingpixels.com", "talkingpixels.com", "razvan", 812, 194, 1729800000],
  ["Databricks releases open diffusion LLM inference", "https://www.databricks.com/blog/", "databricks.com", "mdsaif", 762, 431, 1729750000],
  ["How I debug a production incident at 3am", "https://sre.dev/incident", "sre.dev", "oncall", 690, 152, 1729650000],
  ["A tiny SIMD renderer in 400 lines of Zig", "https://zig.news/simd", "zig.news", "zigtoday", 545, 121, 1729550000],
  ["SQLite is 40% faster after the latest release", "https://www.sqlite.org/releaselog.html", "sqlite.org", "drh", 521, 187, 1729450000],
  ["Designing a keyboard-first web dashboard", "https://ui.dev/keyboard-first", "ui.dev", "kentcdodds", 480, 98, 1729350000],
  ["The vector database landscape in 2025", "https://thedatafold.com/vector", "thedatafold.com", "pedro", 432, 143, 1729250000],
  ["How browsers load web fonts in 2025", "https://web.dev/fonts", "web.dev", "aneesha", 398, 76, 1729150000],
  ["Advent of Code 2025 solutions in Haskell", "https://haskell.org/advent", "haskell.org", "aoc2025", 360, 132, 1729050000],
  ["Meet the OpenTelemetry 2.0 SDK", "https://opentelemetry.io/blog/2.0", "opentelemetry.io", "tyler", 340, 89, 1728950000],
  ["A practical guide to eBPF tracing", "https://ebpf.dev/guide", "ebpf.dev", "kernelbee", 312, 74, 1728850000],
  ["Kubernetes used the new 3.0 scheduler", "https://kubernetes.io/blog/", "kubernetes.io", "sig-node", 298, 101, 1728750000],
  ["Postgres: the good parts, 2025 edition", "https://postgresql.org/goodparts", "postgresql.org", "nathan", 288, 77, 1728650000],
  ["Building a realtime dashboard with WebSockets", "https://socket.dev/realtime", "socket.dev", "crypto", 255, 63, 1728550000],
  ["WebGPU is ready for production", "https://developer.chrome.com/webgpu", "developer.chrome.com", "chrmod", 247, 88, 1728450000],
  ["Why we chose Go for our edge workers", "https://edgecloud.io/go", "edgecloud.io", "golang", 231, 52, 1728350000],
  ["A visual tour of modern CPU pipelines", "https://comparch.dev/pipelines", "comparch.dev", "mips", 212, 49, 1728250000],
  ["Deno 2.2 and the standard library reset", "https://deno.com/blog", "deno.com", "ry", 198, 61, 1728150000],
  ["Decentralized identity finally ships", "https://identity.works/ship", "identity.works", "verified", 187, 44, 1728050000],
  ["The state of WebAssembly outside the browser", "https://wasm.org/state", "wasm.org", "linclark", 176, 58, 1727950000],
  ["Writing a SQL engine from scratch", "https://craig.io/sql-engine", "craig.io", "craig", 165, 71, 1727850000],
  ["Observability for your local dev loop", "https://devloop.dev/observability", "devloop.dev", "kelsey", 152, 39, 1727750000],
  ["GPU-guided vector search explained", "https://vectors.dev/gpu", "vectors.dev", "akshaya", 143, 33, 1727650000],
  ["The 2025 stack for side projects", "https://sideprojects.dev/stack", "sideprojects.dev", "halcyon", 131, 47, 1727550000],
  ["What I learned shipping a multiplayer editor", "https://editor.team/postmortem", "editor.team", "multiplayer", 119, 28, 1727450000],
  ["A gentle introduction to Rust threads", "https://learn-rust.dev/threads", "learn-rust.dev", "rustacean", 108, 31, 1727350000],
  ["Designing satellite internet for low Earth orbit", "https://leo.net/satellite", "leo.net", "leo", 96, 22, 1727250000],
  ["Zero-dependency HTTP servers in 2025", "https://http.dev/zero", "http.dev", "response", 84, 26, 1727150000],
  ["A history of artificial life simulations", "https://alife.dev/history", "alife.dev", "vonneumann", 77, 18, 1727050000],
  ["Tuning G1 garbage collection for low latency", "https://jvm.dev/g1", "jvm.dev", "hotspot", 69, 15, 1726950000],
];

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function cleanStory(raw) {
  if (!raw || typeof raw !== "object" || raw.type !== "story") return null;
  const id = finite(raw.id);
  const title = String(raw.title || "").trim();
  if (!id || !title) return null;
  const url = String(raw.url || "").trim();
  const domain = hostOf(url);
  return {
    id,
    title,
    url: url || `https://news.ycombinator.com/item?id=${id}`,
    domain,
    by: String(raw.by || "").trim() || "anonymous",
    score: finite(raw.score),
    comments: finite(raw.descendants),
    time: finite(raw.time),
    timeISO: raw.time ? new Date(raw.time * 1000).toISOString() : "",
  };
}

export function hostOf(url) {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function normalizeStories(list) {
  const stories = (Array.isArray(list) ? list : [])
    .map(cleanStory)
    .filter(Boolean);
  if (!stories.length) throw new Error("Tech snapshot has no usable stories");
  stories.sort((a, b) => b.score - a.score || b.time - a.time);
  return stories;
}

export function buildSnapshot(stories, { demo = false, meta = {} } = {}) {
  const byDomain = new Map();
  let totalComments = 0;
  for (const story of stories) {
    byDomain.set(story.domain, (byDomain.get(story.domain) || 0) + 1);
    totalComments += story.comments;
  }
  const topDomain = [...byDomain.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "—";
  return {
    schema_version: SCHEMA_VERSION,
    meta: {
      source: demo ? "demo" : "hackernews",
      count: stories.length,
      average_score: stories.length ? Math.round(stories.reduce((sum, s) => sum + s.score, 0) / stories.length) : 0,
      total_comments: totalComments,
      top_domain: topDomain,
      generated_at: new Date().toISOString(),
      ...meta,
    },
    stories,
    demo,
  };
}

export function createDemoSnapshot() {
  const stories = DEMO_STORIES
    .map(([title, url, domain, by, score, comments, time]) =>
      cleanStory({ id: finite(time), type: "story", title, url, by, score, descendants: comments, time })
    )
    .filter(Boolean);
  return buildSnapshot(stories, { demo: true });
}

export async function loadTechStories({ signal } = {}) {
  const attempts = 2;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const listResponse = await fetch(`${TOP_STORIES_URL}?v=${Date.now()}`, {
        cache: "no-store",
        signal,
        headers: { Accept: "application/json" },
      });
      if (!listResponse.ok) throw new Error(`Hacker News top stories HTTP ${listResponse.status}`);
      const ids = await listResponse.json();
      if (!Array.isArray(ids) || !ids.length) throw new Error("Hacker News returned no story IDs");
      const chosen = ids.slice(0, MAX_STORIES);
      const items = await Promise.all(
        chosen.map((id) =>
          fetch(`${ITEM_URL(id)}?v=${Date.now()}`, { cache: "no-store", signal, headers: { Accept: "application/json" } })
            .then((response) => (response.ok ? response.json() : null))
            .catch(() => null)
        )
      );
      const stories = normalizeStories(items);
      return buildSnapshot(stories);
    } catch (error) {
      lastError = error;
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
    }
  }
  throw lastError;
}

/**
 * Fail-Safe Cache fallback: loads the last committed Hacker News snapshot
 * (docs/data/tech-news.json), refreshed periodically by the GitHub Action
 * `hn_cache.yml`. Used when the live API is unreachable.
 */
export async function loadTechCache({ signal } = {}) {
  const response = await fetch(`${CACHE_URL}?v=${Date.now()}`, {
    cache: "no-store",
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Hacker News cache HTTP ${response.status}`);
  const doc = await response.json();
  if (!doc || !Array.isArray(doc.stories)) throw new Error("Hacker News cache has no stories");
  const stories = normalizeStories(doc.stories);
  return buildSnapshot(stories, {
    meta: { source: "hackernews-cache", cached_at: String(doc.meta?.cached_at || "") },
  });
}

export function formatCount(value) {
  const number = finite(value);
  if (number >= 1e9) return `${(number / 1e9).toFixed(1)}B`;
  if (number >= 1e6) return `${(number / 1e6).toFixed(1)}M`;
  if (number >= 1e3) return `${(number / 1e3).toFixed(1)}k`;
  return String(Math.round(number));
}

export function relativeAge(unixSeconds) {
  const ts = Number(unixSeconds) * 1000;
  if (!Number.isFinite(ts) || ts <= 0) return "—";
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 60000) return "now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 2592000000) return `${Math.floor(diff / 86400000)}d ago`;
  return `${Math.floor(diff / 2592000000)}mo ago`;
}

export function storyTone(story) {
  const score = finite(story.score);
  if (score >= 700) return "hot";
  if (score >= 300) return "warm";
  return "cool";
}
