/* VoltScope Crypto controller: snapshot lifecycle, 3D scene, market board, and focus chart. */

import {
  createDemoSnapshot,
  loadCryptoSnapshot,
  summarize,
  formatPrice,
  formatCompact,
  formatPercent,
  relativeTime,
  timeLabel,
  metricLabel,
  changeColor,
  coinColor,
} from "./crypto-data.js?v=20261031-1";
import { CryptoScene } from "./crypto-scene.js?v=20261031-1";

const REFRESH_MS = 60 * 1000;
const $ = (id) => document.getElementById(id);

const state = {
  snapshot: null,
  coins: [],
  history: {},
  selected: null,
  metric: "market_cap",
  color: "change",
  filter: "all",
  search: "",
  sortKey: "market_rank",
  sortDir: 1,
  auto: true,
  theme: "dark",
  demo: false,
  loading: false,
  scene: null,
  timer: 0,
  chartIndex: -1,
  demoNoticeShown: false,
};

let toastTimer = 0;

function setStatus(kind, text, sub = "") {
  const status = $("status");
  status.dataset.state = kind;
  $("status-text").textContent = text;
  $("status-sub").textContent = sub;
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2800);
}

function applyTheme(theme) {
  state.theme = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = state.theme;
  try {
    localStorage.setItem("voltscope-crypto-theme", state.theme);
  } catch {
    /* Storage can be blocked; the theme still applies for this tab. */
  }
  state.scene?.setTheme(state.theme);
  drawCoinChart();
}

function initScene() {
  const container = $("scene");
  try {
    state.scene = new CryptoScene(container, {
      onHover: showTooltip,
      onSelect: (id) => {
        if (!id) {
          clearSelection();
          return;
        }
        selectCoin(id, { focus: true });
      },
      onCamera: (event) => {
        if (typeof event.autoRotate === "boolean") {
          $("btn-spin").setAttribute("aria-pressed", String(event.autoRotate));
        }
      },
    });
    $("scene-loading").classList.add("is-done");
  } catch (error) {
    console.warn("3D scene unavailable", error);
    $("scene-loading").classList.add("is-done");
    $("scene-fallback").hidden = false;
  }
}

/* ---------- Tooltip ---------- */

function showTooltip(coin, event) {
  const tooltip = $("coin-tooltip");
  if (!coin || !event) {
    tooltip.hidden = true;
    return;
  }
  tooltip.textContent = "";
  const title = document.createElement("strong");
  title.textContent = `${coin.symbol} · ${coin.name}`;
  const price = document.createElement("div");
  price.className = "tt-price";
  price.textContent = formatPrice(coin.price);
  tooltip.append(title, price);
  const rows = [
    ["24h", formatPercent(coin.change_24h), changeColor(coin.change_24h)],
    ["Market cap", formatCompact(coin.market_cap), ""],
    ["Volume", formatCompact(coin.volume_24h), ""],
  ];
  if (coin.trending) rows.push(["Signal", "Trending", "#ffc45c"]);
  for (const [label, value, color] of rows) {
    const row = document.createElement("div");
    row.className = "tt-row";
    const key = document.createElement("span");
    key.textContent = label;
    const val = document.createElement("span");
    val.textContent = value;
    if (color) val.style.color = color;
    row.append(key, val);
    tooltip.append(row);
  }
  tooltip.hidden = false;
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  const left = Math.min(window.innerWidth - width - 10, event.clientX + 14);
  const top = Math.min(window.innerHeight - height - 10, event.clientY + 14);
  tooltip.style.left = `${Math.max(8, left)}px`;
  tooltip.style.top = `${Math.max(8, top)}px`;
}

/* ---------- Data lifecycle ---------- */

async function loadSnapshot({ silent = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  const refresh = $("btn-refresh");
  refresh.classList.add("spinning");
  if (!state.snapshot && !silent) setStatus("loading", "Loading market snapshot…");

  try {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    let snapshot;
    try {
      snapshot = await loadCryptoSnapshot({ signal: controller.signal });
    } finally {
      window.clearTimeout(timeout);
    }
    state.snapshot = snapshot;
    state.demo = false;
    if (!silent) setStatus("live", "Live market snapshot", `${snapshot.coins.length} coins`);
  } catch (error) {
    console.warn("Crypto snapshot unavailable", error);
    if (!state.snapshot) {
      state.snapshot = createDemoSnapshot();
      state.demo = true;
      setStatus("demo", "Demo snapshot", "live feed unavailable");
      if (!state.demoNoticeShown) {
        state.demoNoticeShown = true;
        showToast("Live crypto snapshot unavailable — showing demo market data.");
      }
    } else {
      setStatus("error", "Refresh failed", "showing last snapshot");
      if (!silent) showToast("Refresh failed. The last snapshot is still on screen.");
    }
  } finally {
    state.loading = false;
    refresh.classList.remove("spinning");
  }

  render();
  hideBoot();
  if (state.auto) startTimer();
}

function startTimer() {
  window.clearInterval(state.timer);
  state.timer = window.setInterval(() => {
    if (state.auto && document.visibilityState === "visible") loadSnapshot({ silent: true });
  }, REFRESH_MS);
}

function stopTimer() {
  window.clearInterval(state.timer);
  state.timer = 0;
}

function hideBoot() {
  const boot = $("boot");
  if (!boot || boot.classList.contains("is-done")) return;
  boot.classList.add("is-done");
  window.setTimeout(() => boot.remove(), 420);
}

/* ---------- Rendering ---------- */

function render() {
  if (!state.snapshot) return;
  state.coins = state.snapshot.coins;
  state.history = state.snapshot.history || {};
  state.demo = Boolean(state.snapshot.demo);

  const requested = new URLSearchParams(window.location.search).get("coin");
  if (requested && state.coins.some((coin) => coin.id === requested)) {
    state.selected = requested;
  } else if (state.selected && !state.coins.some((coin) => coin.id === state.selected)) {
    state.selected = null;
  } else if (!state.selected) {
    const summary = summarize(state.coins);
    state.selected = summary.trending[0]?.id || state.coins[0].id;
  }

  renderPulse();
  renderTrending();
  renderTable();
  renderFocus();
  renderStatus();
  updateLegend();

  if (state.scene) {
    state.scene.setData(state.coins, {
      metric: state.metric,
      colorMode: state.color,
      selectedId: state.selected,
    });
  }
}

function renderStatus() {
  const meta = state.snapshot.meta || {};
  const latest = meta.latest_timestamp_ms || summarize(state.coins).latest;
  if (state.demo) {
    setStatus("demo", "Demo snapshot", "no live export yet");
  } else {
    setStatus("live", "Live market snapshot", `${state.coins.length} coins · ${relativeTime(latest)}`);
  }
  $("pulse-note").textContent = state.demo ? "demo" : relativeTime(latest);
}

function renderPulse() {
  const summary = summarize(state.coins);
  $("kpi-cap").textContent = formatCompact(summary.totalCap);
  $("kpi-cap-sub").textContent = `${state.coins.length} assets tracked`;
  $("kpi-vol").textContent = formatCompact(summary.totalVolume);
  $("kpi-vol-sub").textContent = "24h turnover";
  $("kpi-breadth").textContent = `${summary.gainers} / ${summary.losers}`;
  $("kpi-breadth-sub").textContent = `${formatPercent(summary.averageChange)} average`;
  $("kpi-breadth").className = summary.averageChange > 0 ? "up" : summary.averageChange < 0 ? "down" : "";
  $("kpi-dominance").textContent = `${(summary.dominance * 100).toFixed(1)}%`;
  $("kpi-dominance-sub").textContent = summary.dominance ? "Bitcoin share" : "no BTC row";
  $("board-count").textContent = `${state.coins.length} coins · ${state.demo ? "demo" : "live"} snapshot`;
}

function renderTrending() {
  const list = $("trending-list");
  list.textContent = "";
  const summary = summarize(state.coins);
  $("trending-note").textContent = summary.trending.length ? `${summary.trending.length} hot` : "CoinGecko";
  if (!summary.trending.length) {
    const empty = document.createElement("li");
    empty.className = "trending-empty";
    empty.textContent = "No trending coins in this snapshot.";
    list.append(empty);
    return;
  }
  for (const coin of summary.trending) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "trending-item";
    button.dataset.id = coin.id;
    const symbol = document.createElement("span");
    symbol.className = "t-symbol";
    symbol.textContent = coin.symbol;
    const name = document.createElement("span");
    name.className = "t-name";
    name.textContent = coin.name;
    const change = document.createElement("span");
    change.className = "t-change";
    change.style.color = changeColor(coin.change_24h);
    change.textContent = formatPercent(coin.change_24h);
    button.append(symbol, name, change);
    button.addEventListener("click", () => selectCoin(coin.id, { focus: true }));
    item.append(button);
    list.append(item);
  }
}

function filteredCoins() {
  const query = state.search.trim().toLowerCase();
  let coins = state.coins.filter((coin) => {
    if (state.filter === "gainers" && coin.change_24h <= 0) return false;
    if (state.filter === "losers" && coin.change_24h >= 0) return false;
    if (state.filter === "trending" && !coin.trending) return false;
    if (!query) return true;
    return `${coin.name} ${coin.symbol} ${coin.id}`.toLowerCase().includes(query);
  });
  const key = state.sortKey;
  const dir = state.sortDir;
  coins = coins.slice().sort((a, b) => {
    if (key === "name" || key === "symbol") {
      return a[key].localeCompare(b[key]) * dir;
    }
    let av = Number(a[key]) || 0;
    let bv = Number(b[key]) || 0;
    if (key === "trending_rank") {
      av = av || 999;
      bv = bv || 999;
    }
    return (av - bv) * dir;
  });
  return coins;
}

function renderTable() {
  const rows = $("coin-rows");
  rows.textContent = "";
  const coins = filteredCoins();
  const fragment = document.createDocumentFragment();

  for (const coin of coins) {
    const tr = document.createElement("tr");
    tr.dataset.id = coin.id;
    tr.tabIndex = 0;
    if (coin.id === state.selected) tr.classList.add("is-selected");
    tr.setAttribute("aria-selected", String(coin.id === state.selected));

    const rank = document.createElement("td");
    rank.className = "rank-cell";
    rank.textContent = coin.market_rank ? `#${coin.market_rank}` : "—";

    const name = document.createElement("td");
    const coinCell = document.createElement("div");
    coinCell.className = "coin-cell";
    const avatar = document.createElement("span");
    avatar.className = "coin-avatar";
    avatar.style.color = coinColor(coin);
    avatar.textContent = coin.symbol.slice(0, 3);
    const names = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = coin.name;
    const small = document.createElement("small");
    small.textContent = coin.symbol;
    names.append(strong, small);
    coinCell.append(avatar, names);
    name.append(coinCell);

    const price = document.createElement("td");
    price.className = "num";
    price.textContent = formatPrice(coin.price);

    const change = document.createElement("td");
    change.className = "num";
    const pill = document.createElement("span");
    pill.className = `change-pill ${coin.change_24h > 0 ? "up" : coin.change_24h < 0 ? "down" : "flat"}`;
    pill.textContent = formatPercent(coin.change_24h);
    change.append(pill);

    const cap = document.createElement("td");
    cap.className = "num";
    cap.textContent = formatCompact(coin.market_cap);

    const volume = document.createElement("td");
    volume.className = "num hide-sm";
    volume.textContent = formatCompact(coin.volume_24h);

    const signal = document.createElement("td");
    signal.className = "hide-sm";
    const badge = document.createElement("span");
    badge.className = coin.trending ? "signal hot" : "signal";
    const dot = document.createElement("i");
    dot.className = "signal-dot";
    badge.append(dot, document.createTextNode(coin.trending ? `Hot #${coin.trending_rank || "—"}` : "—"));
    signal.append(badge);

    tr.append(rank, name, price, change, cap, volume, signal);
    tr.addEventListener("click", () => selectCoin(coin.id, { focus: true }));
    tr.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectCoin(coin.id, { focus: true });
      }
    });
    fragment.append(tr);
  }

  rows.append(fragment);
  const empty = $("empty-state");
  empty.hidden = coins.length > 0;
  $("board-count").textContent = `${coins.length} of ${state.coins.length} coins · ${state.demo ? "demo" : "live"} snapshot`;

  for (const button of document.querySelectorAll("#coin-table th button")) {
    const th = button.closest("th");
    if (button.dataset.sort === state.sortKey) {
      th.setAttribute("aria-sort", state.sortDir === 1 ? "ascending" : "descending");
    } else {
      th.removeAttribute("aria-sort");
    }
  }
}

function renderFocus() {
  const coin = state.coins.find((item) => item.id === state.selected);
  const body = $("focus-body");
  const empty = $("focus-empty");
  if (!coin) {
    body.hidden = true;
    empty.hidden = false;
    $("focus-note").textContent = "selection";
    return;
  }

  body.hidden = false;
  empty.hidden = true;
  $("focus-note").textContent = coin.symbol;
  const avatar = $("focus-avatar");
  avatar.textContent = coin.symbol.slice(0, 3);
  avatar.style.color = coinColor(coin);
  $("focus-name").textContent = coin.name;
  $("focus-symbol").textContent = `${coin.symbol} · #${coin.market_rank || "—"}`;
  $("focus-trend").hidden = !coin.trending;
  $("focus-price").textContent = formatPrice(coin.price);
  const change = $("focus-change");
  change.textContent = formatPercent(coin.change_24h);
  change.style.color = changeColor(coin.change_24h);
  $("focus-rank").textContent = coin.market_rank ? `#${coin.market_rank}` : "—";
  $("focus-cap").textContent = formatCompact(coin.market_cap);
  $("focus-vol").textContent = formatCompact(coin.volume_24h);
  $("focus-updated").textContent = relativeTime(coin.t);
  drawCoinChart();
}

function updateLegend() {
  $("legend-label").textContent = `Height: ${metricLabel(state.metric)}`;
}

/* ---------- Chart ---------- */

function drawCoinChart() {
  const canvas = $("coin-chart");
  if (!canvas || canvas.offsetParent === null) return;
  const coin = state.coins.find((item) => item.id === state.selected);
  const points = (state.history[state.selected] || []).filter((point) => Number.isFinite(point[1]));
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);

  const width = rect.width;
  const height = rect.height;
  const pad = { left: 8, right: 8, top: 12, bottom: 20 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const styles = getComputedStyle(document.documentElement);
  const muted = styles.getPropertyValue("--faint").trim() || "#64798f";
  const lineColor = coin ? changeColor(coin.change_24h) : "#4cd7ff";

  if (!points.length || points.length < 2) {
    context.fillStyle = muted;
    context.font = "12px 'Segoe UI', system-ui, sans-serif";
    context.textAlign = "center";
    context.fillText("History builds after the next producer run", width / 2, height / 2);
    canvas.setAttribute("aria-label", "No price history yet for the selected coin");
    return;
  }

  const values = points.map((point) => point[1]);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (max === min) {
    max = min + Math.max(min * 0.01, 0.000001);
    min = min - Math.max(min * 0.01, 0.000001);
  }
  const padding = (max - min) * 0.12;
  min -= padding;
  max += padding;
  const first = points[0][0];
  const last = points[points.length - 1][0];
  const span = Math.max(1, last - first);
  const xOf = (t) => pad.left + ((t - first) / span) * plotW;
  const yOf = (value) => pad.top + (1 - (value - min) / (max - min)) * plotH;

  context.strokeStyle = "rgba(130, 170, 210, 0.16)";
  context.lineWidth = 1;
  for (let line = 0; line <= 3; line += 1) {
    const y = pad.top + (plotH / 3) * line;
    context.beginPath();
    context.moveTo(pad.left, y);
    context.lineTo(width - pad.right, y);
    context.stroke();
  }

  const gradient = context.createLinearGradient(0, pad.top, 0, height - pad.bottom);
  gradient.addColorStop(0, `${lineColor}44`);
  gradient.addColorStop(1, `${lineColor}00`);
  context.beginPath();
  context.moveTo(xOf(points[0][0]), height - pad.bottom);
  for (const point of points) context.lineTo(xOf(point[0]), yOf(point[1]));
  context.lineTo(xOf(last), height - pad.bottom);
  context.closePath();
  context.fillStyle = gradient;
  context.fill();

  context.beginPath();
  points.forEach((point, index) => {
    const x = xOf(point[0]);
    const y = yOf(point[1]);
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.strokeStyle = lineColor;
  context.lineWidth = 2;
  context.lineJoin = "round";
  context.stroke();

  const lastPoint = points[points.length - 1];
  context.beginPath();
  context.arc(xOf(lastPoint[0]), yOf(lastPoint[1]), 3, 0, Math.PI * 2);
  context.fillStyle = lineColor;
  context.fill();

  context.fillStyle = muted;
  context.font = "10px 'Cascadia Code', monospace";
  context.textAlign = "left";
  context.fillText(timeLabel(first), pad.left, height - 5);
  context.textAlign = "right";
  context.fillText(timeLabel(last), width - pad.right, height - 5);
  context.textAlign = "left";
  context.fillText(formatPrice(max), pad.left, pad.top - 2);

  if (state.chartIndex >= 0 && state.chartIndex < points.length) {
    const point = points[state.chartIndex];
    const x = xOf(point[0]);
    context.strokeStyle = "rgba(150, 190, 225, 0.5)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x, pad.top);
    context.lineTo(x, height - pad.bottom);
    context.stroke();
    context.beginPath();
    context.arc(x, yOf(point[1]), 3.4, 0, Math.PI * 2);
    context.fillStyle = lineColor;
    context.fill();
    const label = `${formatPrice(point[1])} · ${timeLabel(point[0])}`;
    context.font = "600 10px 'Segoe UI', system-ui, sans-serif";
    context.textAlign = "center";
    const textWidth = context.measureText(label).width + 12;
    const boxX = Math.min(width - textWidth - 4, Math.max(4, x - textWidth / 2));
    context.fillStyle = "rgba(5, 12, 22, 0.86)";
    context.fillRect(boxX, pad.top + 2, textWidth, 18);
    context.fillStyle = "#eaf4ff";
    context.fillText(label, boxX + textWidth / 2, pad.top + 15);
  }

  const change = ((lastPoint[1] - points[0][1]) / (points[0][1] || 1)) * 100;
  canvas.setAttribute(
    "aria-label",
    `${coin?.name || "Selected coin"} price history, ${formatPrice(points[0][1])} to ${formatPrice(lastPoint[1])}, ${formatPercent(change)} over ${points.length} readings`,
  );
}

function chartPointer(event) {
  const canvas = $("coin-chart");
  const points = state.history[state.selected] || [];
  if (points.length < 2) return;
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left - 8) / Math.max(1, rect.width - 16)));
  state.chartIndex = Math.round(ratio * (points.length - 1));
  drawCoinChart();
}

/* ---------- Selection ---------- */

function selectCoin(id, { focus = false } = {}) {
  if (!id) {
    clearSelection();
    return;
  }
  if (!state.coins.some((coin) => coin.id === id)) return;
  const changed = state.selected !== id;
  state.selected = id;
  state.chartIndex = -1;
  if (state.scene) {
    state.scene.setSelected(id);
    if (focus) state.scene.focusOn(id);
  }
  renderTable();
  renderFocus();
  const url = new URL(window.location.href);
  url.searchParams.set("coin", id);
  window.history.replaceState(null, "", url);
  if (changed) drawCoinChart();
}

function clearSelection() {
  state.selected = null;
  state.chartIndex = -1;
  if (state.scene) state.scene.setSelected(null);
  renderTable();
  renderFocus();
  const url = new URL(window.location.href);
  url.searchParams.delete("coin");
  window.history.replaceState(null, "", url);
}

/* ---------- Events ---------- */

function bindEvents() {
  $("btn-theme").addEventListener("click", () => {
    applyTheme(state.theme === "dark" ? "light" : "dark");
  });

  $("btn-refresh").addEventListener("click", () => loadSnapshot());

  $("btn-auto").addEventListener("click", () => {
    state.auto = !state.auto;
    $("btn-auto").setAttribute("aria-pressed", String(state.auto));
    if (state.auto) {
      startTimer();
      showToast("Auto refresh on · every 60 seconds");
    } else {
      stopTimer();
      showToast("Auto refresh off");
    }
  });

  $("btn-share").addEventListener("click", async () => {
    const url = new URL(window.location.href);
    if (state.selected) url.searchParams.set("coin", state.selected);
    try {
      await navigator.clipboard.writeText(url.toString());
      showToast("Link copied to clipboard");
    } catch {
      showToast(url.toString());
    }
  });

  $("btn-help").addEventListener("click", () => $("help-dialog").showModal());

  $("metric-group").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-metric]");
    if (!button) return;
    state.metric = button.dataset.metric;
    for (const item of document.querySelectorAll("#metric-group button")) {
      item.classList.toggle("is-active", item === button);
    }
    updateLegend();
    state.scene?.setMetric(state.metric);
  });

  $("color-select").addEventListener("change", (event) => {
    state.color = event.target.value;
    state.scene?.setColorMode(state.color);
  });

  document.querySelector(".camera-tools").addEventListener("click", (event) => {
    const camera = event.target.closest("button[data-cam]");
    if (!camera) return;
    for (const item of document.querySelectorAll(".camera-tools button[data-cam]")) {
      item.classList.toggle("is-active", item === camera);
    }
    state.scene?.cameraPreset(camera.dataset.cam);
  });

  $("btn-spin").addEventListener("click", () => {
    if (!state.scene) return;
    const next = $("btn-spin").getAttribute("aria-pressed") !== "true";
    state.scene.setAutoRotate(next);
    $("btn-spin").setAttribute("aria-pressed", String(next));
  });

  $("filter-group").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-filter]");
    if (!button) return;
    state.filter = button.dataset.filter;
    for (const item of document.querySelectorAll("#filter-group button")) {
      item.classList.toggle("is-active", item === button);
    }
    renderTable();
  });

  $("coin-search").addEventListener("input", (event) => {
    state.search = event.target.value;
    renderTable();
  });

  $("coin-table").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-sort]");
    if (!button) return;
    const key = button.dataset.sort;
    if (state.sortKey === key) {
      state.sortDir *= -1;
    } else {
      state.sortKey = key;
      state.sortDir = key === "name" || key === "market_rank" ? 1 : -1;
    }
    renderTable();
  });

  $("btn-empty-reset").addEventListener("click", () => {
    state.search = "";
    state.filter = "all";
    $("coin-search").value = "";
    for (const item of document.querySelectorAll("#filter-group button")) {
      item.classList.toggle("is-active", item.dataset.filter === "all");
    }
    renderTable();
  });

  $("coin-chart").addEventListener("pointermove", chartPointer);
  $("coin-chart").addEventListener("pointerleave", () => {
    state.chartIndex = -1;
    drawCoinChart();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.auto && state.snapshot) {
      const latest = state.snapshot.meta?.latest_timestamp_ms || 0;
      if (Date.now() - latest > REFRESH_MS) loadSnapshot({ silent: true });
    }
  });

  document.addEventListener("keydown", (event) => {
    const dialog = $("help-dialog");
    if (event.key === "Escape") {
      if (dialog.open) return;
      clearSelection();
      return;
    }
    if (dialog.open) return;
    const target = event.target;
    if (target instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    if (event.key === "/") {
      event.preventDefault();
      $("coin-search").focus();
      $("coin-search").select();
    } else if (event.key === "r" || event.key === "R") {
      loadSnapshot();
    } else if (event.key === "l" || event.key === "L") {
      $("btn-auto").click();
    } else if (event.key === "t" || event.key === "T") {
      $("btn-theme").click();
    } else if (event.key === "?") {
      dialog.showModal();
    } else if (event.key === "1") {
      state.scene?.cameraPreset("overview");
    } else if (event.key === "2") {
      state.scene?.cameraPreset("close");
    } else if (event.key === "3") {
      state.scene?.cameraPreset("top");
    }
  });

  window.addEventListener("resize", () => drawCoinChart());
}

function init() {
  let saved = "dark";
  try {
    saved = localStorage.getItem("voltscope-crypto-theme") || "dark";
  } catch {
    saved = "dark";
  }
  applyTheme(saved);
  initScene();
  bindEvents();
  loadSnapshot();
}

init();
