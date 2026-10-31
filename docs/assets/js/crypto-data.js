/* Crypto dashboard data layer: snapshot loading, demo fallback, and formatting helpers. */

export const DATA_URL = "data/crypto.json";
export const SCHEMA_VERSION = 1;

const DEMO_COINS = [
  ["bitcoin", "BTC", "Bitcoin", 109500, 2160000000000, 42000000000, 1.8, 1],
  ["ethereum", "ETH", "Ethereum", 4120, 496000000000, 21800000000, 2.7, 2],
  ["tether", "USDT", "Tether", 1.0, 172000000000, 64000000000, 0.01, 3],
  ["solana", "SOL", "Solana", 214, 118000000000, 6200000000, 5.4, 4],
  ["binancecoin", "BNB", "BNB", 742, 107000000000, 1900000000, -0.8, 5],
  ["ripple", "XRP", "XRP", 2.61, 149000000000, 4300000000, 3.2, 6],
  ["usd-coin", "USDC", "USDC", 1.0, 61000000000, 7200000000, 0.0, 7],
  ["dogecoin", "DOGE", "Dogecoin", 0.31, 46000000000, 2400000000, -2.4, 8],
  ["cardano", "ADA", "Cardano", 0.94, 33000000000, 1100000000, 1.1, 9],
  ["tron", "TRX", "TRON", 0.29, 25000000000, 780000000, 0.6, 10],
  ["avalanche-2", "AVAX", "Avalanche", 44.5, 18000000000, 540000000, 4.1, 11],
  ["chainlink", "LINK", "Chainlink", 26.8, 16700000000, 610000000, -1.3, 12],
  ["toncoin", "TON", "Toncoin", 5.9, 14600000000, 290000000, 2.2, 13],
  ["shiba-inu", "SHIB", "Shiba Inu", 0.000026, 15400000000, 620000000, -3.6, 14],
  ["polkadot", "DOT", "Polkadot", 8.4, 12800000000, 340000000, 0.9, 15],
];

function demoHistory(coin, index) {
  const now = Date.now();
  const points = [];
  const drift = (coin[6] || 0) / 100;
  for (let step = 47; step >= 0; step -= 1) {
    const t = now - step * 30 * 60 * 1000;
    const wave = Math.sin((step + index) / 4.2) * 0.018 + Math.cos((step + index) / 8) * 0.012;
    const price = coin[3] * (1 + wave + drift * (1 - step / 47));
    points.push([
      t,
      Number(price.toFixed(price < 0.01 ? 10 : 6)),
      Math.round(coin[4] * (1 + wave / 2)),
      Math.round(coin[5] * (0.75 + Math.abs(wave) * 4)),
      Number((coin[6] + wave * 40).toFixed(4)),
    ]);
  }
  return points;
}

export function createDemoSnapshot() {
  const now = Date.now();
  const coins = DEMO_COINS.map((coin, index) => ({
    id: coin[0],
    symbol: coin[1],
    name: coin[2],
    price: coin[3],
    market_cap: coin[4],
    volume_24h: coin[5],
    change_24h: coin[6],
    market_rank: coin[7],
    trending: index === 3 || index === 10 ? 1 : 0,
    trending_rank: index === 3 ? 1 : index === 10 ? 2 : 0,
    t: now,
  }));
  const history = Object.fromEntries(coins.map((coin, index) => [coin.id, demoHistory(DEMO_COINS[index], index)]));
  return buildSnapshot(coins, history, { demo: true });
}

export function buildSnapshot(coins, history, { demo = false, meta = {} } = {}) {
  const totalCap = coins.reduce((sum, coin) => sum + coin.market_cap, 0);
  const totalVolume = coins.reduce((sum, coin) => sum + coin.volume_24h, 0);
  const latest = coins.reduce((max, coin) => Math.max(max, Number(coin.t) || 0), 0) || Date.now();
  return {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    mode: demo ? "demo" : "live",
    meta: {
      source: "coingecko",
      currency: "USD",
      coin_count: coins.length,
      total_market_cap: totalCap,
      total_volume_24h: totalVolume,
      latest_timestamp_ms: latest,
      latest_timestamp: new Date(latest).toISOString(),
      ...meta,
    },
    coins,
    history,
    demo,
  };
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanCoin(raw, index) {
  const id = String(raw?.id || raw?.coin_id || "").trim().toLowerCase();
  if (!id) return null;
  return {
    id,
    symbol: String(raw.symbol || id.slice(0, 4)).toUpperCase(),
    name: String(raw.name || id),
    price: finite(raw.price),
    market_cap: finite(raw.market_cap),
    volume_24h: finite(raw.volume_24h),
    change_24h: finite(raw.change_24h),
    market_rank: Math.round(finite(raw.market_rank, index + 1)) || index + 1,
    trending: finite(raw.trending) > 0 ? 1 : 0,
    trending_rank: Math.round(finite(raw.trending_rank)),
    t: Math.round(finite(raw.t, finite(raw.timestamp_ms, Date.now()))),
  };
}

function cleanHistory(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const history = {};
  for (const [id, rows] of Object.entries(raw)) {
    if (!Array.isArray(rows)) continue;
    const points = [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const t = Math.round(finite(row[0]));
      const price = finite(row[1]);
      if (!t || !Number.isFinite(price) || price < 0) continue;
      points.push([t, price, finite(row[2]), finite(row[3]), finite(row[4])]);
    }
    points.sort((a, b) => a[0] - b[0]);
    if (points.length) history[String(id).toLowerCase()] = points;
  }
  return history;
}

export function normalizeSnapshot(doc) {
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.coins)) {
    throw new Error("Crypto snapshot has no coins array");
  }
  const coins = doc.coins.map(cleanCoin).filter(Boolean);
  if (!coins.length) throw new Error("Crypto snapshot has no usable coins");
  coins.sort((a, b) => (a.market_rank || 999) - (b.market_rank || 999));
  const history = cleanHistory(doc.history);
  const meta = { ...(doc.meta || {}) };
  meta.coin_count = coins.length;
  meta.total_market_cap = finite(meta.total_market_cap, coins.reduce((sum, coin) => sum + coin.market_cap, 0));
  meta.total_volume_24h = finite(meta.total_volume_24h, coins.reduce((sum, coin) => sum + coin.volume_24h, 0));
  return {
    ...doc,
    schema_version: Number(doc.schema_version) || SCHEMA_VERSION,
    mode: doc.demo ? "demo" : doc.mode || "live",
    meta,
    coins,
    history,
    demo: Boolean(doc.demo),
  };
}

export async function loadCryptoSnapshot({ signal } = {}) {
  const attempts = 3;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${DATA_URL}?v=${Date.now()}`, {
        cache: "no-store",
        signal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Crypto snapshot HTTP ${response.status}`);
      return normalizeSnapshot(await response.json());
    } catch (error) {
      lastError = error;
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  }
  throw lastError;
}

export function summarize(coins) {
  const gainers = coins.filter((coin) => coin.change_24h > 0);
  const losers = coins.filter((coin) => coin.change_24h < 0);
  const trending = coins.filter((coin) => coin.trending > 0).sort((a, b) => a.trending_rank - b.trending_rank);
  const sorted = [...coins].sort((a, b) => b.change_24h - a.change_24h);
  const totalCap = coins.reduce((sum, coin) => sum + coin.market_cap, 0);
  const totalVolume = coins.reduce((sum, coin) => sum + coin.volume_24h, 0);
  const bitcoin = coins.find((coin) => coin.id === "bitcoin");
  return {
    totalCap,
    totalVolume,
    gainers: gainers.length,
    losers: losers.length,
    trending,
    topGainer: sorted[0] || null,
    topLoser: sorted[sorted.length - 1] || null,
    averageChange: coins.length ? coins.reduce((sum, coin) => sum + coin.change_24h, 0) / coins.length : 0,
    dominance: bitcoin && totalCap ? bitcoin.market_cap / totalCap : 0,
    latest: coins.reduce((max, coin) => Math.max(max, coin.t || 0), 0),
  };
}

export function coinColor(coin) {
  let hash = 0;
  for (const char of coin.symbol || coin.id) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return `hsl(${hash} 72% 58%)`;
}

export function changeColor(value) {
  if (value > 0.05) return "#2ee6a8";
  if (value < -0.05) return "#ff5f7a";
  return "#8fa4c4";
}

export function formatPrice(value) {
  const number = finite(value);
  if (number === 0) return "$0";
  if (number >= 1000) return `$${number.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (number >= 1) return `$${number.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
  if (number >= 0.001) return `$${number.toFixed(6)}`;
  return `$${number.toFixed(10).replace(/0+$/, "").replace(/\.$/, "")}`;
}

export function formatCompact(value) {
  const number = finite(value);
  if (!number) return "$0";
  const units = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) {
    if (Math.abs(number) >= size) return `$${(number / size).toFixed(number / size >= 100 ? 0 : 1)}${suffix}`;
  }
  return `$${number.toFixed(2)}`;
}

export function formatPercent(value) {
  const number = finite(value);
  const sign = number > 0 ? "+" : "";
  return `${sign}${number.toFixed(2)}%`;
}

export function relativeTime(ms) {
  const delta = Date.now() - finite(ms);
  if (!delta || delta < 0) return "just now";
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function timeLabel(ms) {
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
}

export function metricValue(coin, metric) {
  if (metric === "price") return finite(coin.price);
  if (metric === "volume_24h") return finite(coin.volume_24h);
  return finite(coin.market_cap);
}

export function metricLabel(metric) {
  if (metric === "price") return "Price";
  if (metric === "volume_24h") return "24h volume";
  return "Market cap";
}
