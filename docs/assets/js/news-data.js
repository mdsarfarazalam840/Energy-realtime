/* Global News & Culture data layer: Wikipedia top pageviews (last 24 hours).
   No API key required. Falls back to cache, then demo, when the network is blocked. */

export const API_BASE = "https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access";
export const MAX_ARTICLES = 50;
export const CACHE_URL = "data/news-cache.json";
export const SCHEMA_VERSION = 1;

/* Category palette shared by the board, the legend and the 3D scene. */
export const CATEGORY_COLORS = {
  Country: "#22d3ee",
  History: "#818cf8",
  Technology: "#34d399",
  Music: "#f472b6",
  Sports: "#fbbf24",
  Politics: "#ef4444",
  Literature: "#a78bfa",
  Finance: "#f59e0b",
  Environment: "#2dd4bf",
  "Film & TV": "#fb7185",
  Culture: "#94a3b8",
};

export function categoryColor(category) {
  return CATEGORY_COLORS[category] || CATEGORY_COLORS.Culture;
}

/* Wikipedia's top-pageviews feed includes maintenance namespaces
   (`Main Page`, `Special:Search`, `Wikipedia:Featured pictures`…). They are
   not stories, so they never reach the board. */
const META_PREFIXES = [
  "Main Page",
  "Special:",
  "Wikipedia:",
  "Portal:",
  "Category:",
  "Help:",
  "Talk:",
  "File:",
  "Template:",
  "Draft:",
  "Module:",
  "MediaWiki:",
  "Book:",
  "TimedText:",
  "User:",
  "Deaths in",
];

export function isMetaArticle(id, title = "") {
  const value = String(id || title || "").replace(/_/g, " ").trim();
  if (!value || /^[-\u2013\u2014]$/.test(value)) return true;
  return META_PREFIXES.some((prefix) => value.startsWith(prefix));
}

const DEMO_ARTICLES = [
  ["United_States", "United States", 8923410, "Country"],
  ["World_War_II", "World War II", 6541200, "History"],
  ["Artificial_intelligence", "Artificial intelligence", 5210900, "Technology"],
  ["Taylor_Swift", "Taylor Swift", 4870300, "Music"],
  ["The_Lord_of_the_Rings", "The Lord of the Rings", 4120500, "Literature"],
  ["Climate_change", "Climate change", 3890100, "Environment"],
  ["Cristiano_Ronaldo", "Cristiano Ronaldo", 3560200, "Sports"],
  ["Japan", "Japan", 3210800, "Country"],
  ["Barack_Obama", "Barack Obama", 2980400, "Politics"],
  ["Bitcoin", "Bitcoin", 2750600, "Finance"],
];

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function inferCategory(article) {
  const lower = article.toLowerCase();
  const keywords = [
    ["History", ["world war", "holocaust", "ancient", "empire", "revolution", "independence", "dynasty", "century"]],
    ["Sports", ["football", "soccer", "basketball", "cricket", "olympics", "ronaldo", "messi", "nba", "nfl", "formula", "ufc", "boxing", "tennis", "world cup", "f.c.", " fc ", "league", "championship", "super bowl", "ipl", "wwe"]],
    ["Music", ["taylor", "swift", "beyonce", "drake", "spotify", "grammy", "album", "singer", "rapper", "band", "tour", "billboard", "bts"]],
    ["Technology", ["artificial", "intelligence", "iphone", "android", "tesla", "apple", "google", "microsoft", "openai", "chatgpt", "nvidia", "chip", "software", "robot", "spacex", "starlink"]],
    ["Finance", ["bitcoin", "crypto", "stock", "market", "dollar", "economy", "ethereum", "nasdaq", "inflation", "bank"]],
    ["Film & TV", ["film", "movie", "series", "actor", "actress", "oscar", "netflix", "hollywood", "television", "season", "episode"]],
    ["Politics", ["obama", "biden", "trump", "president", "election", "government", "senate", "congress", "minister", "parliament", "war", "military", "israel", "gaza", "ukraine"]],
    ["Country", ["united states", "united kingdom", "china", "india", "russia", "japan", "germany", "france", "canada", "australia", "brazil", "italy", "spain", "mexico", "pakistan", "bangladesh", "indonesia", "nigeria", "egypt"]],
    ["Literature", ["lord of the rings", "harry potter", "shakespeare", "novel", "book", "author", "writer"]],
    ["Environment", ["climate", "global warming", "nature", "earth", "animal", "earthquake", "hurricane", "wildfire"]],
  ];
  for (const [category, words] of keywords) {
    for (const word of words) {
      if (lower.includes(word)) return category;
    }
  }
  return "Culture";
}

export function cleanArticle(raw) {
  if (!raw || typeof raw !== "object") return null;
  const article = String(raw.article || raw.title || "").trim().replace(/_/g, " ");
  if (!article) return null;
  const views = finite(raw.views || raw.daily_views || raw.daily);
  const rank = finite(raw.rank);
  const id = String(raw.article || raw.title || article).replace(/\s+/g, "_");
  return {
    id,
    article,
    title: article,
    views,
    rank: rank || 0,
    category: String(raw.category || inferCategory(article)).trim() || "Culture",
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(id)}`,
  };
}

export function normalizeArticles(list) {
  const articles = (Array.isArray(list) ? list : [])
    .map(cleanArticle)
    .filter((article) => article && !isMetaArticle(article.id, article.article));
  if (!articles.length) throw new Error("News snapshot has no usable articles");
  articles.sort((a, b) => b.views - a.views);
  articles.forEach((article, index) => {
    article.rank = index + 1;
  });
  return articles;
}

export function buildSnapshot(articles, { demo = false, meta = {} } = {}) {
  const totalViews = articles.reduce((sum, a) => sum + a.views, 0);
  const byCategory = new Map();
  for (const a of articles) {
    byCategory.set(a.category, (byCategory.get(a.category) || 0) + 1);
  }
  const topCategory = [...byCategory.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "—";
  return {
    schema_version: SCHEMA_VERSION,
    meta: {
      source: demo ? "demo" : "wikipedia",
      count: articles.length,
      total_views: totalViews,
      top_category: topCategory,
      generated_at: new Date().toISOString(),
      ...meta,
    },
    articles,
    demo,
  };
}

export function createDemoSnapshot() {
  const articles = DEMO_ARTICLES.map(
    ([id, title, views, category]) =>
      cleanArticle({ article: id, title, views, category })
  ).filter(Boolean);
  articles.sort((a, b) => b.views - a.views);
  articles.forEach((article, index) => {
    article.rank = index + 1;
  });
  return buildSnapshot(articles, { demo: true });
}

function yesterdayUtc() {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return {
    y: d.getUTCFullYear(),
    m: String(d.getUTCMonth() + 1).padStart(2, "0"),
    d: String(d.getUTCDate()).padStart(2, "0"),
  };
}

export async function loadWikipediaTopArticles({ signal } = {}) {
  const attempts = 2;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { y, m, d } = yesterdayUtc();
      const url = `${API_BASE}/${y}/${m}/${d}?v=${Date.now()}`;
      const response = await fetch(url, { cache: "no-store", signal, headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`Wikipedia API HTTP ${response.status}`);
      const json = await response.json();
      const items = json?.items || [];
      let rawArticles = [];
      for (const item of items) {
        const list = item?.articles || item?.article || [];
        if (Array.isArray(list)) rawArticles.push(...list);
      }
      if (!rawArticles.length) throw new Error("Wikipedia returned no articles");
      const articles = normalizeArticles(rawArticles).slice(0, MAX_ARTICLES);
      return buildSnapshot(articles);
    } catch (error) {
      lastError = error;
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
    }
  }
  throw lastError;
}

export async function loadNewsCache({ signal } = {}) {
  const response = await fetch(`${CACHE_URL}?v=${Date.now()}`, { cache: "no-store", signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`News cache HTTP ${response.status}`);
  const doc = await response.json();
  if (!doc || !Array.isArray(doc.articles)) throw new Error("News cache has no articles");
  const articles = normalizeArticles(doc.articles);
  return buildSnapshot(articles, { meta: { source: "wikipedia-cache", cached_at: String(doc.meta?.cached_at || "") } });
}

export function formatCount(value) {
  const number = finite(value);
  if (number >= 1e9) return `${(number / 1e9).toFixed(1)}B`;
  if (number >= 1e6) return `${(number / 1e6).toFixed(1)}M`;
  if (number >= 1e3) return `${(number / 1e3).toFixed(1)}k`;
  return String(Math.round(number));
}

export function viewsTone(views) {
  const v = finite(views);
  if (v >= 5000000) return "hot";
  if (v >= 1000000) return "warm";
  return "cool";
}
