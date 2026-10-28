/* VoltScope controller: snapshot lifecycle, filters, replay, and rendering. */

import {
  loadSnapshot,
  sourceIds,
  zoneIds,
  latestTime,
  filterPoints,
  applyPlayhead,
  withValues,
  valueDomain,
  summarize,
  sourceMeta,
  sourceColor,
  formatPrice,
  formatSigned,
  formatCompact,
  timeLabel,
  fullLabel,
  relativeTime,
  rangeLabel,
} from "./data.js";
import { createDemoSnapshot } from "./demo.js";
import { TimelineChart, DistributionChart } from "./charts.js";

const RANGES = {
  "6h": 6 * 3600 * 1000,
  "24h": 24 * 3600 * 1000,
  "7d": 7 * 24 * 3600 * 1000,
  "30d": 30 * 24 * 3600 * 1000,
  all: 0,
};
const RANGE_KEYS = Object.keys(RANGES);
const REFRESH_MS = 60 * 1000;
const REPLAY_MS = 14000;

const $ = (id) => document.getElementById(id);
const app = $("app");

const state = {
  snapshot: null,
  points: [],
  sources: new Set(),
  zone: "all",
  range: "7d",
  baseline: "window",
  seriesMode: "raw",
  selectedKey: null,
  playhead: null,
  playing: false,
  speed: 1,
  live: true,
  theme: "dark",
  camera: "overview",
  customRange: null,
  lastLoad: 0,
  nextRefresh: 0,
  loading: false,
  demo: false,
  error: null,
  rows: [],
  displayRows: [],
  stats: null,
  knownSources: new Set(),
};

let scene = null;
let sceneReady = false;
let timelineChart = null;
let distributionChart = null;
let selectedBar = null;
let replayFrame = null;
let replayClock = null;
let lastPlayheadPaint = 0;
let drawerScrim = null;

/* ---------------- boot / setup ---------------- */

async function boot() {
  loadPreferences();
  buildStaticUi();
  bindControls();
  initCharts();
  await initScene();
  applyHash();
  syncFilterButtons();

  const started = performance.now();
  await refresh({ initial: true });
  const elapsed = performance.now() - started;
  if (elapsed < 550) await new Promise((resolve) => setTimeout(resolve, 550 - elapsed));
  finishBoot();
  setInterval(tick, 1000);
  updateStatus();
  updateCountdown();

  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    setTimeout(() => $("scene-hint")?.classList.add("is-hidden"), 9000);
  }
}

function loadPreferences() {
  try {
    const saved = localStorage.getItem("voltscope.theme");
    if (saved === "light" || saved === "dark") state.theme = saved;
    else if (window.matchMedia("(prefers-color-scheme: light)").matches) state.theme = "light";
    const live = localStorage.getItem("voltscope.live");
    if (live === "0") state.live = false;
  } catch {
    /* private mode */
  }
  document.documentElement.dataset.theme = state.theme;
  $("btn-live").setAttribute("aria-pressed", String(state.live));
}

function buildStaticUi() {
  syncFilterButtons();
  $("btn-play").disabled = false;

  drawerScrim = document.createElement("div");
  drawerScrim.className = "drawer-scrim";
  drawerScrim.hidden = true;
  document.body.appendChild(drawerScrim);
}

function syncFilterButtons() {
  for (const button of document.querySelectorAll("[data-range]")) {
    button.setAttribute("aria-pressed", String(button.dataset.range === state.range));
  }
  for (const button of document.querySelectorAll("[data-baseline]")) {
    button.setAttribute("aria-pressed", String(button.dataset.baseline === state.baseline));
  }
  for (const button of document.querySelectorAll("[data-series]")) {
    button.setAttribute("aria-pressed", String(button.dataset.series === state.seriesMode));
  }
}

async function initScene() {
  const container = $("scene");
  try {
    const module = await import("./scene.js");
    scene = new module.PriceScene(container, {
      onHover: handleSceneHover,
      onSelect: handleSceneSelect,
      onCamera: (camera) => {
        state.camera = camera;
        syncCameraButtons();
      },
    });
    sceneReady = true;
    scene.setTheme(state.theme);
  } catch (error) {
    console.error("3D scene failed", error);
    sceneReady = false;
    showBanner("3D scene unavailable (WebGL or CDN blocked). Timeline and insights still work.");
  }
}

function initCharts() {
  const timelineCanvas = $("timeline-chart");
  const distCanvas = $("dist-chart");

  timelineChart = new TimelineChart(timelineCanvas, {
    onBrush: (brush) => {
      state.customRange = brush;
      state.playhead = null;
      stopReplay();
      $("btn-clear-brush").hidden = false;
      updateView({ animate: true });
    },
    onReset: () => {
      if (!state.customRange) return;
      state.customRange = null;
      $("btn-clear-brush").hidden = true;
      updateView({ animate: true });
    },
    onHover: (point, x, y) => {
      if (!point) {
        hideTooltip();
        return;
      }
      showTooltip(
        `<b>${formatPrice(point.p)}</b> <span style="color:var(--faint)">EUR/MWh</span><small>${sourceMeta(point.s).label} · ${point.z} · ${timeLabel(point.t, { seconds: true, day: true })} UTC</small>`,
        x,
        y
      );
    },
    onSelect: (point) => {
      if (!point) {
        clearSelection();
        return;
      }
      const bar = scene?.byKey?.get(`${point.s}|${point.t}`);
      if (bar) selectBar(bar);
      else {
        state.selectedKey = `${point.s}|${point.t}`;
        scene?.setSelected(state.selectedKey);
        updateFocus();
      }
    },
  });

  distributionChart = new DistributionChart(distCanvas);

  const resize = () => {
    timelineChart?.resize();
    distributionChart?.resize();
  };
  window.addEventListener("resize", resize);
  new ResizeObserver(resize).observe($("timeline"));
  new ResizeObserver(resize).observe(distCanvas.parentElement);
}

/* ---------------- data ---------------- */

async function refresh({ initial = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  $("btn-refresh").classList.add("is-busy");
  $("status").dataset.state = "loading";

  try {
    const snapshot = await loadSnapshot();
    const previousLatest = state.snapshot?.meta?.latest_timestamp_ms || 0;
    state.snapshot = snapshot;
    state.points = snapshot.points;
    state.demo = false;
    state.error = null;
    hydrateSources(true);
    hideBanner();

    if (!initial && snapshot.meta?.latest_timestamp_ms !== previousLatest) {
      const rows = snapshot.meta?.row_count ?? snapshot.points.length;
      showToast(`New snapshot · ${rows} readings published`);
    }
    state.playhead = null;
    stopReplay();
    $("banner").dataset.persistent = "0";
    hideBanner();
    updateZoneOptions();
    updateView({ animate: true });
    $("boot").dataset.state = "ready";
  } catch (error) {
    console.warn("Snapshot load failed", error);
    if (!state.snapshot) {
      const demo = parseDemo();
      state.snapshot = demo;
      state.points = demo.points;
      state.demo = true;
      state.error = error;
      hydrateSources(true);
      updateZoneOptions();
      updateView({ animate: true });
      showBanner(
        "Demo data is on screen. The Databricks export has not published a snapshot yet. Run the publish workflow to replace this with live rows.",
        true
      );
      $("boot").dataset.state = "ready";
    } else {
      state.error = error;
      showBanner("Refresh failed. Showing the last published snapshot.", true);
      showToast("Refresh failed · keeping last snapshot");
    }
  } finally {
    state.loading = false;
    state.lastLoad = Date.now();
    scheduleNext();
    $("btn-refresh").classList.remove("is-busy");
    updateStatus();
    updateCountdown();
  }
}

function parseDemo() {
  /* parseSnapshot is applied inside loadSnapshot; normalise demo the same way. */
  const raw = createDemoSnapshot();
  const points = raw.points
    .map((point) => ({ t: Number(point.t), p: Number(point.p), z: String(point.z), s: String(point.s) }))
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.p))
    .sort((a, b) => a.t - b.t);
  return { ...raw, points, generated: Date.now(), meta: raw.meta, demo: true };
}

function hydrateSources(first = false) {
  const ids = sourceIds(state.points);
  if (first) {
    if (!state.sources.size) state.sources = new Set(ids);
  } else {
    for (const id of ids) {
      if (!state.knownSources.has(id)) state.sources.add(id);
    }
  }
  for (const id of [...state.sources]) if (!ids.includes(id)) state.sources.delete(id);
  if (!state.sources.size) state.sources = new Set(ids);
  state.knownSources = new Set(ids);
  renderSourceList();
}

function currentAnchor() {
  return latestTime(state.points) || Date.now();
}

function viewRows() {
  const rangeMs = RANGES[state.range] || 0;
  let rows = filterPoints(state.points, {
    sources: state.sources,
    zone: state.zone,
    rangeMs,
    anchor: currentAnchor(),
  });
  if (state.customRange) {
    const { t0, t1 } = state.customRange;
    rows = rows.filter((point) => point.t >= t0 && point.t <= t1);
  }
  return rows;
}

function updateZoneOptions() {
  const select = $("zone-select");
  const zones = zoneIds(state.points);
  const previous = state.zone;
  select.innerHTML = "";
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = `All zones (${zones.length})`;
  select.appendChild(all);
  for (const zone of zones) {
    const option = document.createElement("option");
    option.value = zone;
    option.textContent = zone;
    select.appendChild(option);
  }
  if (previous !== "all" && zones.includes(previous)) select.value = previous;
  else state.zone = "all";
}

/* ---------------- rendering ---------------- */

function updateView({ animate = true } = {}) {
  const rows = viewRows();
  state.rows = rows;

  if (state.selectedKey) {
    const exists = rows.some((point) => `${point.s}|${point.t}` === state.selectedKey);
    if (!exists) {
      state.selectedKey = null;
      selectedBar = null;
    }
  }

  const playheadRows = state.playhead != null ? applyPlayhead(rows, state.playhead) : rows;
  state.stats = summarize(playheadRows);

  const displayRows = withValues(rows, state.seriesMode);
  state.displayRows = displayRows;
  const domain = valueDomain(displayRows, state.baseline);

  const lanes = sourceIds(rows);
  const colors = {};
  for (const id of lanes) colors[id] = sourceColor(id, state.theme);

  if (sceneReady && scene) {
    scene.setModel(
      {
        points: displayRows,
        lanes,
        colors,
        domain,
        baseline: state.baseline,
        playhead: state.playhead,
        selected: state.selectedKey,
      },
      { animate }
    );
    scene.setPlayhead(state.playhead);
  }

  updateKpis();
  updateStatsGrid();
  updateSourceList();
  updateCompare(lanes);
  updateFocus();
  updateTimeline(rows, displayRows);
  updateDistribution(rows);
  updateScale(domain);
  updatePipelineMeta();
  updateFilterHint();
  updateEmptyState(rows);
  updateBrushUi();
  writeHash();
}

function updateKpis() {
  const stats = state.stats;
  const container = $("kpis");
  if (!stats || !stats.latest) {
    container.innerHTML = "";
    return;
  }

  const latestBySource = new Map();
  for (const point of state.rows) {
    const current = latestBySource.get(point.s);
    if (!current || point.t > current.t) latestBySource.set(point.s, point);
  }

  const cards = [];
  for (const source of stats.sources.slice(0, 2)) {
    const meta = sourceMeta(source.id);
    const zone = latestBySource.get(source.id)?.z || "";
    const delta = source.lastChange;
    const deltaPct = source.lastChangePct;
    const deltaClass = delta == null ? "flat" : delta > 0 ? "up" : delta < 0 ? "down" : "flat";
    cards.push(`
      <article class="kpi">
        <div class="kpi-label">${esc(meta.label)}${zone ? ` · ${esc(zone)}` : ""}</div>
        <div class="kpi-value">${formatPrice(source.last)}<span>EUR/MWh</span></div>
        <div class="kpi-foot"><span class="${deltaClass}">${
          delta == null ? "first reading" : `${formatSigned(delta)} (${formatSigned(deltaPct, 1, "%")})`
        }</span> · ${timeLabel(source.lastTime)} UTC</div>
      </article>`);
  }

  cards.push(`
    <article class="kpi">
      <div class="kpi-label">Range</div>
      <div class="kpi-value">${formatPrice(stats.min)}<span>→ ${formatPrice(stats.max)}</span></div>
      <div class="kpi-foot">spread ${formatPrice(stats.spread)} EUR/MWh</div>
    </article>
    <article class="kpi">
      <div class="kpi-label">Coverage</div>
      <div class="kpi-value">${stats.count}<span>readings</span></div>
      <div class="kpi-foot">${stats.sources.length} feed${stats.sources.length === 1 ? "" : "s"} · ${rangeLabel(stats.lastTime - stats.firstTime)} window</div>
    </article>`);

  container.style.setProperty("--kpi-count", String(cards.length));
  container.innerHTML = cards.join("");
  container.style.setProperty("--kpi-count", String(container.children.length));
}

function updateStatsGrid() {
  const stats = state.stats;
  const grid = $("stats-grid");
  if (!stats || !stats.count) {
    grid.innerHTML = "";
    $("stats-note").textContent = "no rows";
    return;
  }
  const rows = [
    ["Mean", formatPrice(stats.mean), "EUR"],
    ["Volatility σ", formatPrice(stats.std), "EUR"],
    ["Spread", formatPrice(stats.spread), "EUR"],
    ["Readings", String(stats.count), ""],
    ["Window", rangeLabel(stats.lastTime - stats.firstTime), "UTC"],
    ["Latest", timeLabel(stats.lastTime, { day: true }), ""],
  ];
  grid.innerHTML = rows
    .map(
      ([label, value, unit]) =>
        `<div class="stat"><dt>${esc(label)}</dt><dd>${esc(value)}${unit ? `<small>${esc(unit)}</small>` : ""}</dd></div>`
    )
    .join("");
  $("stats-note").textContent = stats.count ? `${stats.count} pts` : "no rows";
}

function renderSourceList() {
  const container = $("source-list");
  const ids = sourceIds(state.points);
  if (!ids.length) {
    container.innerHTML = `<p class="focus-empty">No feeds in this snapshot.</p>`;
    return;
  }
  const latestBySource = new Map();
  for (const point of state.points) {
    const current = latestBySource.get(point.s);
    if (!current || point.t > current.t) latestBySource.set(point.s, point);
  }
  const prevBySource = new Map();
  for (const point of state.points) {
    const latest = latestBySource.get(point.s);
    if (!latest || point.t >= latest.t) continue;
    const current = prevBySource.get(point.s);
    if (!current || point.t > current.t) prevBySource.set(point.s, point);
  }

  container.innerHTML = ids
    .map((id) => {
      const meta = sourceMeta(id);
      const latest = latestBySource.get(id);
      const previous = prevBySource.get(id);
      const delta = latest && previous && previous.p !== 0 ? ((latest.p - previous.p) / Math.abs(previous.p)) * 100 : null;
      const deltaClass = delta == null ? "flat" : delta > 0 ? "up" : delta < 0 ? "down" : "flat";
      const active = state.sources.has(id);
      return `
        <button type="button" class="source-row" data-source="${esc(id)}" aria-pressed="${active}" title="${active ? "Hide" : "Show"} ${esc(meta.label)}">
          <span class="source-swatch" style="--swatch:${sourceColor(id, state.theme)}"></span>
          <span class="source-name">
            <b>${esc(meta.label)}</b>
            <small>${esc(latest ? latest.z : meta.hint)} · ${esc(meta.hint)}</small>
          </span>
          <span class="source-figs">
            <span class="source-price">${latest ? formatPrice(latest.p) : "—"}</span>
            <span class="source-delta ${deltaClass}">${delta == null ? "—" : formatSigned(delta, 1, "%")}</span>
          </span>
        </button>`;
    })
    .join("");
}

function updateSourceList() {
  const summary = $("source-summary");
  const active = [...state.sources];
  summary.textContent = `${active.length}/${sourceIds(state.points).length} feeds · ${state.rows.length} pts`;
  const visible = new Set(state.rows.map((row) => row.s));
  for (const button of $("source-list").querySelectorAll("[data-source]")) {
    const id = button.dataset.source;
    const activeNow = state.sources.has(id);
    button.setAttribute("aria-pressed", String(activeNow));
    button.classList.toggle("is-out-of-view", !visible.has(id));
    button.title = `${activeNow ? "Hide" : "Show"} ${sourceMeta(id).label}`;
  }
}

function updateCompare(lanes) {
  const container = $("compare-list");
  const stats = state.stats;
  if (!stats || !stats.sources.length) {
    container.innerHTML = `<p class="focus-empty">No feeds to compare.</p>`;
    $("compare-note").textContent = "—";
    return;
  }

  const sourceStats = stats.sources.filter((source) => lanes.includes(source.id) || !lanes.length);
  const maxAverage = Math.max(...sourceStats.map((source) => Math.abs(source.mean)), 1);
  container.innerHTML = sourceStats
    .map((source) => {
      const meta = sourceMeta(source.id);
      const color = sourceColor(source.id, state.theme);
      const width = Math.max(2, (Math.abs(source.mean) / maxAverage) * 100);
      return `
        <div class="compare-row" style="--swatch:${color}">
          <div class="compare-top">
            <i class="compare-swatch"></i>
            <span class="compare-name">${esc(meta.label)}</span>
            <span class="compare-avg">${formatPrice(source.mean)}</span>
          </div>
          <div class="compare-track"><i style="width:${width}%"></i></div>
          <div class="compare-range"><span>min ${formatPrice(source.min)}</span><span>max ${formatPrice(source.max)}</span></div>
        </div>`;
    })
    .join("");
  $("compare-note").textContent = `${sourceStats.length} feed${sourceStats.length === 1 ? "" : "s"} · avg`;
}

function updateTimeline(rows, displayRows) {
  if (!timelineChart) return;
  if (!rows.length) {
    timelineChart.setData({ series: [], domain: null, playhead: null, selected: null, brush: state.customRange });
    $("timeline-meta").textContent = "No readings in this window.";
    return;
  }

  const grouped = new Map();
  for (const point of displayRows) {
    if (!grouped.has(point.s)) grouped.set(point.s, []);
    grouped.get(point.s).push(point);
  }
  const series = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, points]) => ({
      id,
      color: sourceColor(id, state.theme),
      points: points.sort((a, b) => a.t - b.t),
    }));

  const t0 = Math.min(...rows.map((point) => point.t));
  const t1 = Math.max(...rows.map((point) => point.t));
  const selected = state.selectedKey
    ? displayRows.find((point) => `${point.s}|${point.t}` === state.selectedKey) || null
    : null;

  timelineChart.setData({
    series,
    domain: { t0, t1: Math.max(t1, t0 + 1000) },
    playhead: state.playhead,
    selected,
    brush: state.customRange,
    theme: state.theme,
  });
  $("timeline-meta").textContent = `${rows.length} readings · ${rangeLabel(t1 - t0)} · ${
    state.seriesMode === "indexed" ? "indexed" : "EUR/MWh"
  } · UTC`;
}

function updateDistribution(rows) {
  if (!distributionChart) return;
  const grouped = new Map();
  for (const point of rows) {
    if (!grouped.has(point.s)) grouped.set(point.s, []);
    grouped.get(point.s).push(point);
  }
  const series = [...grouped.entries()].map(([id, points]) => ({
    id,
    color: sourceColor(id, state.theme),
    points,
  }));
  distributionChart.setData({ series, bins: 18 });
  $("dist-meta").textContent = rows.length ? `${rows.length} pts` : "—";
}

function updateScale(domain) {
  $("scale-max").textContent = formatCompact(domain.max);
  $("scale-min").textContent = formatCompact(domain.min);
  const caption = document.querySelector(".axis-caption");
  if (caption) caption.textContent = state.seriesMode === "indexed" ? "INDEX 100" : "EUR/MWh";
}

function updatePipelineMeta() {
  const meta = state.snapshot?.meta || {};
  const badge = $("pipeline-badge");
  badge.textContent = state.demo ? "demo" : state.error ? "stale" : "live";
  badge.dataset.mode = state.demo ? "demo" : state.error ? "error" : "live";

  const table = meta.table || "unknown table";
  const queryMs = meta.query_ms != null ? `${meta.query_ms} ms` : "—";
  const generated = state.snapshot?.generated_at ? fullLabel(Date.parse(state.snapshot.generated_at)) : "—";
  $("pipeline-meta").innerHTML = `${esc(table)}<br>${meta.row_count ?? state.points.length} rows · query ${esc(
    queryMs
  )}<br>published ${esc(generated)}`;
  $("help-meta").textContent = `${table} · ${meta.row_count ?? state.points.length} rows · warehouse ${
    meta.warehouse_id || "—"
  }`;
}

function updateFilterHint() {
  const hint = $("filter-hint");
  if (state.seriesMode === "indexed") {
    hint.textContent = "Indexed mode rebases each feed to 100 at its first visible reading. KPIs stay in EUR/MWh.";
  } else if (state.baseline === "zero") {
    hint.textContent = "Zero baseline anchors columns at 0, including negative prices. Taller columns mean higher prices.";
  } else {
    hint.textContent = "Window baseline starts at the session low so small moves stay visible. Switch to Zero for a true origin.";
  }
}

function updateEmptyState(rows) {
  const empty = $("empty-state");
  empty.hidden = rows.length > 0;
  if (!rows.length) {
    $("scene-hint").classList.add("is-hidden");
  }
}

function updateBrushUi() {
  const clear = $("btn-clear-brush");
  clear.hidden = !state.customRange;
}

function updateFocus() {
  const body = $("focus-body");
  const note = $("focus-note");
  if (!state.selectedKey) {
    selectedBar = null;
    body.innerHTML = `<p class="focus-empty">Click a column to inspect the reading. Drag the timeline to brush a window.</p>`;
    note.textContent = "selection";
    return;
  }

  const bar =
    (sceneReady && scene?.byKey?.get(state.selectedKey)) ||
    displayBarFromState(state.selectedKey);
  if (!bar) {
    state.selectedKey = null;
    updateFocus();
    return;
  }
  selectedBar = bar;
  note.textContent = "pinned";

  const point = bar.point;
  const rows = state.rows.filter((row) => row.s === point.s).sort((a, b) => a.t - b.t);
  const index = rows.findIndex((row) => row.t === point.t);
  const previous = index > 0 ? rows[index - 1] : null;
  const delta = previous ? point.p - previous.p : null;
  const values = rows.map((row) => row.p).sort((a, b) => a - b);
  const rank = values.filter((value) => value <= point.p).length;
  const percentile = values.length ? Math.round((rank / values.length) * 100) : 0;
  const meta = sourceMeta(point.s);
  const deltaClass = delta == null ? "flat" : delta > 0 ? "up" : delta < 0 ? "down" : "flat";

  body.innerHTML = `
    <div class="focus-top">
      <div>
        <div class="focus-price">${formatPrice(point.p)}<small>EUR/MWh</small></div>
        <div class="focus-meta">
          <div><span>Time</span><span>${timeLabel(point.t, { seconds: true, day: true })} UTC</span></div>
          <div><span>Zone</span><span>${esc(point.z)}</span></div>
          <div><span>vs previous</span><span class="${deltaClass}">${
            delta == null ? "—" : formatSigned(delta) + ` (${formatSigned(previous.p ? (delta / Math.abs(previous.p)) * 100 : 0, 1, "%")})`
          }</span></div>
          <div><span>Session rank</span><span>P${percentile}</span></div>
        </div>
      </div>
      <span class="focus-source" style="--dot:${sourceColor(point.s, state.theme)}"><i></i>${esc(meta.label)}</span>
    </div>
    <div class="focus-actions">
      <button type="button" data-action="focus-camera">Focus camera</button>
      <button type="button" data-action="copy-reading">Copy value</button>
    </div>`;
}

function displayBarFromState(key) {
  const point = state.displayRows.find((row) => `${row.s}|${row.t}` === key);
  if (!point) return null;
  return { key, point };
}

function selectBar(bar) {
  if (!bar) {
    clearSelection();
    return;
  }
  state.selectedKey = bar.key;
  selectedBar = bar;
  scene?.setSelected(bar.key);
  updateFocus();
  updateTimeline(state.rows, state.displayRows);
  hideTooltip();
}

function clearSelection() {
  state.selectedKey = null;
  selectedBar = null;
  scene?.setSelected(null);
  updateFocus();
  updateTimeline(state.rows, state.displayRows);
}

/* ---------------- replay ---------------- */

function replayBounds() {
  const rows = state.rows;
  if (!rows.length) return null;
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const point of rows) {
    if (point.t < t0) t0 = point.t;
    if (point.t > t1) t1 = point.t;
  }
  return { t0, t1 };
}

function toggleReplay() {
  if (state.playing) {
    pauseReplay();
    return;
  }
  const bounds = replayBounds();
  if (!bounds) return;
  const from = state.playhead != null && state.playhead < bounds.t1 ? state.playhead : bounds.t0;
  startReplay(from, bounds.t1);
}

function startReplay(from, to) {
  stopReplay();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return;
  state.playing = true;
  state.playhead = from;
  $("timeline").classList.add("is-playing");
  $("play-label").textContent = "Pause";
  replayClock = { started: performance.now(), from, to, duration: REPLAY_MS / state.speed };
  paintPlayhead(true);
  replayFrame = requestAnimationFrame(stepReplay);
}

function stepReplay(now) {
  if (!state.playing || !replayClock) return;
  const progress = Math.min(1, (now - replayClock.started) / replayClock.duration);
  const eased = progress * progress * (3 - 2 * progress);
  state.playhead = replayClock.from + (replayClock.to - replayClock.from) * eased;
  paintPlayhead(false);

  if (progress >= 1) {
    finishReplay();
    return;
  }
  replayFrame = requestAnimationFrame(stepReplay);
}

function paintPlayhead(force) {
  const now = performance.now();
  if (!force && now - lastPlayheadPaint < 55) {
    scene?.setPlayhead(state.playhead);
    return;
  }
  lastPlayheadPaint = now;
  scene?.setPlayhead(state.playhead);
  timelineChart?.setPlayhead(state.playhead);
  state.stats = summarize(applyPlayhead(state.rows, state.playhead));
  updateKpis();
  updateStatsGrid();
  updateFocus();
}

function pauseReplay() {
  state.playing = false;
  if (replayFrame) cancelAnimationFrame(replayFrame);
  replayFrame = null;
  replayClock = null;
  $("timeline").classList.remove("is-playing");
  $("play-label").textContent = "Resume";
}

function finishReplay() {
  state.playing = false;
  replayFrame = null;
  replayClock = null;
  $("timeline").classList.remove("is-playing");
  $("play-label").textContent = "Replay";
  state.playhead = null;
  updateView({ animate: false });
}

function stopReplay() {
  if (replayFrame) cancelAnimationFrame(replayFrame);
  replayFrame = null;
  replayClock = null;
  state.playing = false;
  $("timeline").classList.remove("is-playing");
  $("play-label").textContent = "Replay";
}

function changeSpeed(speed) {
  state.speed = Number(speed) || 1;
  if (state.playing && replayClock) {
    const remaining = replayClock.to - state.playhead;
    replayClock = {
      started: performance.now(),
      from: state.playhead,
      to: replayClock.to,
      duration: Math.max(400, (remaining / (replayClock.to - replayClock.from)) * (REPLAY_MS / state.speed)),
    };
  }
}

/* ---------------- hover / tooltip ---------------- */

function handleSceneHover(bar, x, y) {
  if (!bar) {
    hideTooltip();
    return;
  }
  const point = bar.point;
  const label = sourceMeta(point.s).label;
  showTooltip(
    `<b>${formatPrice(point.p)}</b> <span style="color:var(--faint)">EUR/MWh</span><small>${esc(label)} · ${esc(
      point.z
    )} · ${timeLabel(point.t, { seconds: true, day: true })} UTC</small>`,
    x,
    y
  );
}

function handleSceneSelect(bar) {
  if (!bar) {
    clearSelection();
    return;
  }
  selectBar(bar);
}

function showTooltip(html, clientX, clientY) {
  const tooltip = $("tooltip");
  tooltip.innerHTML = html;
  const x = Math.max(90, Math.min(window.innerWidth - 90, clientX));
  const y = Math.max(70, clientY);
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
  tooltip.classList.add("is-visible");
  tooltip.dataset.visible = "1";
}

function hideTooltip() {
  const tooltip = $("tooltip");
  tooltip.classList.remove("is-visible");
  delete tooltip.dataset.visible;
}

/* ---------------- status / banner / toast ---------------- */

function updateStatus() {
  const status = $("status");
  const text = $("status-text");
  const sub = $("status-sub");
  if (state.loading) {
    status.dataset.state = "loading";
    text.textContent = "Refreshing snapshot…";
    sub.textContent = "";
    return;
  }
  if (state.demo) {
    status.dataset.state = "demo";
    text.textContent = "Demo snapshot";
    sub.textContent = "awaiting first export";
    return;
  }
  if (state.error) {
    status.dataset.state = "error";
    text.textContent = "Snapshot stale";
    sub.textContent = "retrying";
    return;
  }
  if (!state.snapshot) {
    status.dataset.state = "loading";
    text.textContent = "Connecting…";
    return;
  }
  status.dataset.state = "live";
  const latest = state.snapshot.meta?.latest_timestamp_ms || latestTime(state.points);
  text.textContent = "Live snapshot";
  sub.textContent = `${state.snapshot.meta?.row_count ?? state.points.length} rows · ${relativeTime(latest)}`;
}

function updateCountdown() {
  const sub = $("status-sub");
  if (!sub || state.demo || state.error || state.loading || !state.snapshot) return;
  if (!state.live) {
    const latest = state.snapshot.meta?.latest_timestamp_ms || latestTime(state.points);
    sub.textContent = `${state.snapshot.meta?.row_count ?? state.points.length} rows · auto off · ${relativeTime(latest)}`;
    return;
  }
  const seconds = Math.max(0, Math.round((state.nextRefresh - Date.now()) / 1000));
  const latest = state.snapshot.meta?.latest_timestamp_ms || latestTime(state.points);
  sub.textContent = `${state.snapshot.meta?.row_count ?? state.points.length} rows · ${relativeTime(latest)} · ${seconds}s`;
}

function showBanner(message, persistent = false) {
  const banner = $("banner");
  banner.textContent = message;
  banner.hidden = false;
  banner.dataset.persistent = persistent ? "1" : "0";
}

function hideBanner() {
  const banner = $("banner");
  if (banner.dataset.persistent === "1") return;
  banner.hidden = true;
}

function showToast(message) {
  const toasts = $("toasts");
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  toasts.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("is-out");
    setTimeout(() => toast.remove(), 260);
  }, 3200);
}

function tick() {
  updateCountdown();
  if (!state.live || state.loading || document.hidden) return;
  if (Date.now() >= state.nextRefresh) {
    refresh();
  }
}

function scheduleNext() {
  state.nextRefresh = Date.now() + REFRESH_MS;
}

function finishBoot() {
  const bootEl = $("boot");
  bootEl.dataset.state = bootEl.dataset.state === "error" ? "error" : "ready";
  bootEl.classList.add("is-done");
}

/* ---------------- UI wiring ---------------- */

function bindControls() {
  $("btn-refresh").addEventListener("click", () => refresh());
  $("btn-live").addEventListener("click", () => {
    state.live = !state.live;
    $("btn-live").setAttribute("aria-pressed", String(state.live));
    try {
      localStorage.setItem("voltscope.live", state.live ? "1" : "0");
    } catch {
      /* ignore */
    }
    if (state.live) {
      scheduleNext();
      refresh();
    }
    updateStatus();
    updateCountdown();
    showToast(state.live ? "Auto refresh on · every 60s" : "Auto refresh off");
  });

  $("btn-theme").addEventListener("click", () => {
    setTheme(state.theme === "dark" ? "light" : "dark");
  });

  $("btn-share").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      showToast("View link copied");
    } catch {
      showToast("Copy failed · use the address bar");
    }
  });

  $("btn-help").addEventListener("click", () => $("help-dialog").showModal());
  $("help-dialog").addEventListener("click", (event) => {
    if (event.target === $("help-dialog")) $("help-dialog").close();
  });

  $("range-group").addEventListener("click", (event) => {
    const button = event.target.closest("[data-range]");
    if (!button) return;
    state.range = button.dataset.range;
    state.customRange = null;
    state.playhead = null;
    stopReplay();
    for (const item of $("range-group").querySelectorAll("[data-range]")) {
      item.setAttribute("aria-pressed", String(item.dataset.range === state.range));
    }
    updateView({ animate: true });
    closeDrawers();
  });

  $("baseline-group").addEventListener("click", (event) => {
    const button = event.target.closest("[data-baseline]");
    if (!button) return;
    state.baseline = button.dataset.baseline;
    for (const item of $("baseline-group").querySelectorAll("[data-baseline]")) {
      item.setAttribute("aria-pressed", String(item.dataset.baseline === state.baseline));
    }
    updateView({ animate: false });
  });

  $("series-group").addEventListener("click", (event) => {
    const button = event.target.closest("[data-series]");
    if (!button) return;
    state.seriesMode = button.dataset.series;
    for (const item of $("series-group").querySelectorAll("[data-series]")) {
      item.setAttribute("aria-pressed", String(item.dataset.series === state.seriesMode));
    }
    updateView({ animate: false });
  });

  $("zone-select").addEventListener("change", (event) => {
    state.zone = event.target.value;
    state.playhead = null;
    stopReplay();
    updateView({ animate: true });
  });

  $("source-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-source]");
    if (!button) return;
    const id = button.dataset.source;
    if (state.sources.has(id)) {
      if (state.sources.size === 1) {
        showToast("Keep at least one feed visible");
        return;
      }
      state.sources.delete(id);
    } else {
      state.sources.add(id);
    }
    state.selectedKey = null;
    state.playhead = null;
    stopReplay();
    renderSourceList();
    updateView({ animate: true });
  });

  $("btn-reset").addEventListener("click", resetFilters);
  $("btn-empty-reset").addEventListener("click", resetFilters);
  $("btn-clear-brush").addEventListener("click", () => {
    state.customRange = null;
    state.playhead = null;
    stopReplay();
    updateView({ animate: true });
  });

  $("btn-play").addEventListener("click", toggleReplay);
  $("speed-select").addEventListener("change", (event) => changeSpeed(event.target.value));

  $("focus-body").addEventListener("click", async (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action || !selectedBar) return;
    if (action === "focus-camera") {
      const bar = scene?.byKey?.get(selectedBar.key);
      if (bar) scene.focusBar(bar, true);
      else showToast("Focus unavailable for this reading");
    } else if (action === "copy-reading") {
      const point = selectedBar.point;
      const text = `${formatPrice(point.p)} EUR/MWh · ${point.s} · ${point.z} · ${fullLabel(point.t)}`;
      try {
        await navigator.clipboard.writeText(text);
        showToast("Reading copied");
      } catch {
        showToast("Copy failed");
      }
    }
  });

  for (const button of document.querySelectorAll(".view-tools [data-cam]")) {
    button.addEventListener("click", () => setCamera(button.dataset.cam));
  }

  $("btn-filters").addEventListener("click", () => toggleDrawer("filters"));
  $("btn-insights").addEventListener("click", () => toggleDrawer("insights"));
  drawerScrim.addEventListener("click", closeDrawers);

  window.addEventListener("hashchange", () => {
    applyHash();
    updateZoneOptions();
    syncFilterButtons();
    updateView({ animate: false });
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.live && Date.now() - state.lastLoad > 90000) refresh();
  });

  document.addEventListener("keydown", onKeyDown);
}

function resetFilters() {
  state.sources = new Set(sourceIds(state.points));
  state.zone = "all";
  state.range = "7d";
  state.baseline = "window";
  state.seriesMode = "raw";
  state.customRange = null;
  state.playhead = null;
  state.selectedKey = null;
  stopReplay();
  $("zone-select").value = "all";
  for (const button of $("range-group").querySelectorAll("[data-range]")) {
    button.setAttribute("aria-pressed", String(button.dataset.range === state.range));
  }
  for (const button of $("baseline-group").querySelectorAll("[data-baseline]")) {
    button.setAttribute("aria-pressed", String(button.dataset.baseline === state.baseline));
  }
  for (const button of $("series-group").querySelectorAll("[data-series]")) {
    button.setAttribute("aria-pressed", String(button.dataset.series === state.seriesMode));
  }
  renderSourceList();
  updateView({ animate: true });
  closeDrawers();
}

function setTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("voltscope.theme", theme);
  } catch {
    /* ignore */
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "light" ? "#e9eef6" : "#060a12");
  scene?.setTheme(theme);
  if (timelineChart) timelineChart.draw();
  if (distributionChart) distributionChart.draw();
  updateView({ animate: false });
}

function setCamera(name) {
  state.camera = name;
  scene?.setCamera(name, true);
  syncCameraButtons();
  writeHash();
  closeDrawers();
}

function syncCameraButtons() {
  for (const button of document.querySelectorAll(".view-tools [data-cam]")) {
    button.classList.toggle("is-active", button.dataset.cam === state.camera);
  }
}

function toggleDrawer(which) {
  const filters = which === "filters";
  const open = filters ? !app.classList.contains("is-filters-open") : !app.classList.contains("is-insights-open");
  app.classList.toggle("is-filters-open", filters && open);
  app.classList.toggle("is-insights-open", !filters && open);
  $("btn-filters").setAttribute("aria-expanded", String(filters && open));
  $("btn-insights").setAttribute("aria-expanded", String(!filters && open));
  drawerScrim.hidden = !open;
  drawerScrim.classList.toggle("is-visible", open);
}

function closeDrawers() {
  app.classList.remove("is-filters-open", "is-insights-open");
  $("btn-filters").setAttribute("aria-expanded", "false");
  $("btn-insights").setAttribute("aria-expanded", "false");
  drawerScrim.classList.remove("is-visible");
  drawerScrim.hidden = true;
}

function onKeyDown(event) {
  const tag = (event.target.tagName || "").toLowerCase();
  const typing = ["input", "select", "textarea"].includes(tag);

  if (event.key === "Escape") {
    if ($("help-dialog").open) return;
    if (app.classList.contains("is-filters-open") || app.classList.contains("is-insights-open")) {
      closeDrawers();
      return;
    }
    if (state.playing) {
      pauseReplay();
      return;
    }
    clearSelection();
    return;
  }

  if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === "?") {
    event.preventDefault();
    $("help-dialog").showModal();
    return;
  }
  if (event.key === " " && tag !== "button") {
    event.preventDefault();
    toggleReplay();
    return;
  }

  switch (event.key.toLowerCase()) {
    case "1":
      setCamera("overview");
      break;
    case "2":
      setCamera("profile");
      break;
    case "3":
      setCamera("top");
      break;
    case "f":
      if (selectedBar) scene?.focusBar(selectedBar, true);
      break;
    case "r":
      refresh();
      break;
    case "l":
      $("btn-live").click();
      break;
    default:
      break;
  }
}

/* ---------------- hashing ---------------- */

function writeHash() {
  const params = new URLSearchParams();
  params.set("feeds", [...state.sources].sort().join(","));
  params.set("zone", state.zone);
  params.set("range", state.range);
  params.set("baseline", state.baseline);
  params.set("series", state.seriesMode);
  params.set("cam", state.camera);
  const next = `#${params.toString()}`;
  if (window.location.hash !== next) {
    history.replaceState(null, "", next);
  }
}

function applyHash() {
  if (!window.location.hash) return;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const feeds = params.get("feeds");
  if (feeds) {
    const ids = feeds.split(",").filter(Boolean);
    if (ids.length) state.sources = new Set(ids);
  }
  const zone = params.get("zone");
  if (zone) state.zone = zone;
  const range = params.get("range");
  if (range && RANGE_KEYS.includes(range)) state.range = range;
  const baseline = params.get("baseline");
  if (baseline === "window" || baseline === "zero") state.baseline = baseline;
  const series = params.get("series");
  if (series === "raw" || series === "indexed") state.seriesMode = series;
  const cam = params.get("cam");
  if (["overview", "profile", "top"].includes(cam)) {
    state.camera = cam;
    scene?.setCamera(cam, false);
    syncCameraButtons();
  }
}

/* ---------------- helpers ---------------- */

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

boot().catch((error) => {
  console.error("VoltScope failed to start", error);
  const bootEl = $("boot");
  bootEl.dataset.state = "error";
  $("boot-sub").textContent = "Could not load the dashboard. Check the browser console.";
  showBanner("Startup failed. Reload the page or check the browser console.", true);
});

/* Support hook: inspect the live session from the console. Read-only by design. */
window.__voltscope = {
  state,
  get scene() {
    return scene;
  },
  refresh,
  updateView,
};
