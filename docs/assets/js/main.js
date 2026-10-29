/* VoltScope controller: snapshot lifecycle, filters, replay, and rendering. */

import {
  loadSnapshot,
  loadDayIndex,
  loadDayPoints,
  indexFromSnapshot,
  filterPointsByDays,
  dayKeysForWindow,
  clampDayKey,
  dayLabel,
  sourceIds,
  zoneIds,
  countryIds,
  laneIds,
  laneLabel,
  laneColor,
  laneOf,
  pointKey,
  countryOf,
  countryLabel,
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
} from "./data.js?v=20261029-5";
import { createDemoSnapshot } from "./demo.js?v=20261029-5";
import { TimelineChart, DistributionChart } from "./charts.js?v=20261029-5";
import { loadLiveConfig, createLiveFeed, createPresence } from "./live.js?v=20261029-8";

const RANGES = {
  "6h": 6 * 3600 * 1000,
  "24h": 24 * 3600 * 1000,
  "7d": 7 * 24 * 3600 * 1000,
  "30d": 30 * 24 * 3600 * 1000,
  all: 0,
};
const RANGE_KEYS = Object.keys(RANGES);
// Rendering every zone at once turns the stage and timeline into spaghetti.
// These presets keep the default view legible while "all" stays one click away.
const ZONE_FOCUS = { top12: 12, top24: 24 };
const REFRESH_MS = 60 * 1000;
const REPLAY_MS = 14000;

const timings = {};

const $ = (id) => document.getElementById(id);
const app = $("app");

const state = {
  snapshot: null,
  points: [],
  sources: new Set(),
  country: "all",
  zone: "top12",
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
  /* Date window and shard state. `mode` is "shards", "legacy" or "demo". */
  mode: null,
  index: null,
  legacyPoints: null,
  loadedDays: [],
  dateFrom: null,
  dateTo: null,
  customDates: false,
  loadingDates: false,
  datasetSignature: "",
  /* Realtime layer. `shardPoints` is the published history; `livePoints` is the
     newest slice from the relay or the live lane. `points` is their union. */
  shardPoints: [],
  livePoints: [],
  liveMeta: null,
  liveState: { transport: "off", state: "connecting", rows: 0, synced: 0 },
  liveConfig: null,
  presence: { online: 0, peak: 0, mode: "off", ts: 0 },
  liveFeed: null,
  presenceFeed: null,
  liveSignature: "",
};

let scene = null;
let sceneReady = false;
let timelineChart = null;
let distributionChart = null;
let selectedBar = null;
let replayFrame = null;
let replayClock = null;
let lastPlayheadPaint = 0;
let lastPlayheadStats = 0;
let drawerScrim = null;
let windowToken = 0;
let windowAbort = null;

/* ---------------- boot / setup ---------------- */

async function boot() {
  const started = performance.now();
  timings.uiStart = started;
  loadPreferences();
  buildStaticUi();
  bindControls();
  initCharts();
  await initScene();
  timings.sceneReady = performance.now();
  applyHash();
  syncFilterButtons();

  await refresh({ initial: true });
  timings.snapshotReady = performance.now();
  initLive();
  const elapsed = performance.now() - started;
  if (elapsed < 550) await new Promise((resolve) => setTimeout(resolve, 550 - elapsed));
  finishBoot();
  timings.boot = performance.now() - started;
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
    const module = await import("./scene.js?v=20261029-4");
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
      const key = pointKey(point);
      const bar = scene?.byKey?.get(key);
      if (bar) selectBar(bar);
      else {
        state.selectedKey = key;
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
  if (state.loadingDates) return;
  state.loading = true;
  $("btn-refresh").classList.add("is-busy");
  $("status").dataset.state = "loading";

  try {
    const fetchStarted = performance.now();
    let index;
    let legacyPoints = null;

    if (state.mode === "legacy" || state.mode === "demo") {
      /* A deployment without shards (or demo mode) keeps reading the full
         snapshot. The date picker still filters it in memory. */
      const snapshot = await loadSnapshot();
      legacyPoints = snapshot.points;
      index = indexFromSnapshot(snapshot);
    } else {
      try {
        index = await loadDayIndex();
      } catch (manifestError) {
        if (state.mode === "shards") throw manifestError;
        // First visit against a site that has not published shards yet.
        const snapshot = await loadSnapshot();
        legacyPoints = snapshot.points;
        index = indexFromSnapshot(snapshot);
        state.mode = "legacy";
        console.info("Day shards unavailable, using the full snapshot", manifestError);
      }
    }

    timings.fetchMs = Math.round(performance.now() - fetchStarted);
    state.index = index;
    state.mode = index.legacy ? "legacy" : "shards";
    if (legacyPoints) state.legacyPoints = legacyPoints;
    state.error = null;
    state.demo = false;
    hideBanner();

    updateDateControls();
    const previousLatest = state.snapshot?.meta?.latest_timestamp_ms || 0;
    await loadWindow({ initial, animate: true });
    if (!initial && previousLatest && index.meta?.latest_timestamp_ms > previousLatest) {
      const rows = index.meta?.row_count ?? state.points.length;
      showToast(`New snapshot · ${rows} readings published`);
    }
    $("boot").dataset.state = "ready";
  } catch (error) {
    console.warn("Snapshot load failed", error);
    if (!state.snapshot) {
      const demo = parseDemo();
      state.snapshot = demo;
      state.points = demo.points;
      state.shardPoints = demo.points;
      state.demo = true;
      state.mode = "demo";
      state.error = error;
      state.index = indexFromSnapshot(demo);
      state.legacyPoints = demo.points;
      state.dateFrom = state.index.days[0].date;
      state.dateTo = state.index.days[state.index.days.length - 1].date;
      state.customDates = false;
      state.loadedDays = state.index.days.map((day) => day.date);
      hydrateSources(true);
      updateCountryOptions();
      updateZoneOptions();
      updateDateControls();
      updateView({ animate: true });
      showBanner(
        "Demo data is on screen. The Databricks export has not published a snapshot yet. Run the publish workflow to replace this with live rows.",
        true
      );
      $("boot").dataset.state = "ready";
    } else {
      state.error = error;
      $("date-note").dataset.state = "error";
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
    setDateInputsBusy(false);
  }
}

/* ---------------- live layer ---------------- */

const LIVE_WINDOW_MS = 12 * 3600 * 1000;
const MAX_LIVE_POINTS = 4000;

async function initLive() {
  const config = await loadLiveConfig();
  state.liveConfig = config;
  state.presenceFeed = createPresence(config, {
    onUpdate: (presence) => {
      state.presence = presence;
      updateLiveUi();
    },
  });
  if (config.enabled) {
    state.liveFeed = createLiveFeed(config, {
      onPoints: (points, document) => {
        state.liveMeta = document?.meta || null;
        mergeLivePoints(points);
      },
      onStatus: (status) => {
        state.liveState = { ...state.liveState, ...status };
        updateLiveUi();
      },
    });
  }
  updateLiveUi();
}

/**
 * Add newest readings on top of the published shards.
 *
 * The published history never contains these rows yet (the snapshot lags by up
 * to 30 minutes), so the union is a plain key merge. When the next snapshot
 * catches up, the same keys arrive from the shards and the live copies fall
 * away in `recomputePoints`.
 */
function mergeLivePoints(rows) {
  if (state.demo || !Array.isArray(rows) || !rows.length) return;
  const cutoff = Date.now() - LIVE_WINDOW_MS;
  const byKey = new Map();
  for (const point of state.livePoints) byKey.set(pointKey(point), point);

  for (const row of rows) {
    const t = Number(row.t);
    const p = Number(row.p);
    if (!Number.isFinite(t) || !Number.isFinite(p) || t < cutoff) continue;
    const s = String(row.s || "unknown");
    const z = String(row.z || "unknown");
    const point = { t, p, z, s, l: `${s}|${z}` };
    byKey.set(pointKey(point), point);
  }

  const merged = [...byKey.values()].sort((a, b) => a.t - b.t);
  state.livePoints = merged.length > MAX_LIVE_POINTS ? merged.slice(-MAX_LIVE_POINTS) : merged;
  if (!recomputePoints()) {
    updateLiveUi();
    return;
  }
  updateView({ animate: false });
  updateLiveUi();
}

/** Live rows only apply to the current view when today is inside it. */
function liveVisible() {
  if (state.demo || !state.livePoints.length) return false;
  if (!state.customDates) return true;
  const today = new Date().toISOString().slice(0, 10);
  return Boolean(state.dateFrom && state.dateTo && state.dateFrom <= today && state.dateTo >= today);
}

/** Rebuild `state.points` as shard history plus visible live rows. */
function recomputePoints() {
  const base = state.shardPoints || [];
  let extra = [];
  if (liveVisible()) {
    const seen = new Set(base.map((point) => pointKey(point)));
    extra = state.livePoints.filter((point) => !seen.has(pointKey(point)));
  }
  const signature = `${base.length}|${extra.length}|${extra.length ? extra[extra.length - 1].t : 0}`;
  state.points = extra.length ? [...base, ...extra].sort((a, b) => a.t - b.t) : base;
  if (signature === state.liveSignature) return false;
  state.liveSignature = signature;
  return true;
}

function liveLatest() {
  return state.livePoints.length ? state.livePoints[state.livePoints.length - 1].t : 0;
}

/** Compact age for the small live card: `now`, `42s`, `7m`, `3h`. */
function liveAge(ms) {
  if (!ms) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

function updateLiveUi() {
  const chip = $("live-chip");
  if (!chip) return;

  const presence = state.presence || {};
  const live = state.liveState || {};
  const mode = presence.mode || "off";
  const online = Number(presence.online) || 0;
  const feedActive = ["live", "waiting", "retrying"].includes(live.state);
  const relay = mode === "relay";

  chip.hidden = !(relay || mode === "local" || feedActive);
  chip.dataset.mode = relay ? "relay" : feedActive && mode !== "local" ? live.state : mode;

  let chipText = "live feed";
  if (relay) chipText = `${online} live`;
  else if (mode === "local") chipText = "1 here";
  else if (live.state === "waiting") chipText = "warming";
  $("live-chip-text").textContent = chipText;
  chip.title = relay
    ? `${online} ${online === 1 ? "person" : "people"} viewing now — realtime relay`
    : mode === "local"
      ? "Presence relay not configured — this count is this tab only"
      : "Live Databricks feed";

  const transportLabel =
    live.transport === "relay" && live.state === "live"
      ? "realtime"
      : live.state === "waiting"
        ? "warming"
        : live.state === "retrying" || live.state === "error"
          ? "retrying"
          : live.transport === "static" && live.state === "live"
            ? "5-min lane"
            : live.state === "off"
              ? "offline"
              : "connecting";
  // The card is titled "Live now" and the first two stats are viewers, so its
  // note follows the presence transport whenever the relay is connected.
  $("live-transport").textContent = relay ? "realtime" : transportLabel;

  $("live-online").textContent = relay ? String(online) : mode === "local" ? "1" : "—";
  $("live-peak").textContent = relay ? String(Number(presence.peak) || online) : "—";
  $("live-sync").textContent = live.synced ? liveAge(live.synced) : "—";

  const notes = [];
  if (live.state === "live") {
    notes.push(`${Number(live.rows) || 0} newest readings from Databricks - ${relativeTime(live.generated)}.`);
  } else if (live.state === "waiting") {
    notes.push("Waiting for the first live publication from GitHub Actions.");
  } else if (live.state === "retrying" || live.state === "error") {
    notes.push("Live feed retrying; published snapshots still refresh every 60 seconds.");
  } else if (live.state === "off") {
    notes.push("Live lane is off. Enable it in data/live-config.json.");
  }
  if (relay) notes.push("Presence is realtime across all open dashboards.");
  else if (mode === "local") notes.push('Presence relay not configured, so "viewing" counts this tab only.');
  $("live-meta").textContent = notes.join(" ");
}

/** Resolve the picker window against the days the manifest actually has. */function resolveDateWindow(index = state.index) {
  if (!index?.days?.length) return;
  const last = index.days[index.days.length - 1].date;
  if (state.customDates) {
    state.dateFrom = clampDayKey(index, state.dateFrom || last);
    state.dateTo = clampDayKey(index, state.dateTo || state.dateFrom);
    if (state.dateFrom > state.dateTo) {
      const swap = state.dateFrom;
      state.dateFrom = state.dateTo;
      state.dateTo = swap;
      state.customDates = true;
    }
  } else {
    const keys = dayKeysForWindow(index, {
      rangeMs: RANGES[state.range] || 0,
      anchor: index.meta?.latest_timestamp_ms || 0,
    });
    state.dateFrom = keys[0];
    state.dateTo = keys[keys.length - 1];
  }
}

/**
 * Load only the day shards covered by the current date window, then render.
 * Every call is tokenised so a fast second click cannot paint stale data.
 */
async function loadWindow({ initial = false, animate = true } = {}) {
  const index = state.index;
  if (!index) return;

  resolveDateWindow(index);
  const keys = dayKeysForWindow(index, {
    dateFrom: state.customDates ? state.dateFrom : null,
    dateTo: state.customDates ? state.dateTo : null,
    rangeMs: state.customDates ? 0 : RANGES[state.range] || 0,
    anchor: index.meta?.latest_timestamp_ms || 0,
  });

  const token = ++windowToken;
  if (windowAbort) windowAbort.abort();
  windowAbort = new AbortController();
  state.loadingDates = true;
  setDateInputsBusy(true);
  updateDateNote(`Loading ${keys.length} day${keys.length === 1 ? "" : "s"}…`);

  try {
    let points;
    let loadedKeys;
    if (index.legacy) {
      points = filterPointsByDays(state.legacyPoints || [], keys);
      loadedKeys = keys;
    } else {
      const result = await loadDayPoints(index, keys, {
        signal: windowAbort.signal,
        onProgress: (done, total) => {
          if (token !== windowToken) return;
          updateDateNote(`Loading ${done}/${total} day files…`);
        },
      });
      points = result.points;
      loadedKeys = result.keys;
    }
    if (token !== windowToken) return;

    const signature = datasetSignature(index, loadedKeys);
    const unchanged = !initial && Boolean(state.snapshot) && signature === state.datasetSignature;

    state.shardPoints = points;
    state.liveSignature = "";
    recomputePoints();
    state.loadedDays = loadedKeys;
    state.datasetSignature = signature;
    state.snapshot = {
      meta: index.meta,
      generated_at: index.generated_at,
      mode: index.mode,
      days: index.days,
      points: state.points,
    };
    state.snapshot.demo = state.demo;

    hydrateSources(!state.knownSources.size);
    updateCountryOptions();
    updateZoneOptions();
    updateDateControls();
    updateStatus();
    updateCountdown();

    if (unchanged) {
      state.loadingDates = false;
      setDateInputsBusy(false);
      return;
    }

    state.playhead = null;
    stopReplay();
    $("banner").dataset.persistent = "0";
    hideBanner();

    const renderStarted = performance.now();
    updateView({ animate });
    timings.renderMs = Math.round(performance.now() - renderStarted);
  } catch (error) {
    if (token !== windowToken || error?.name === "AbortError") return;
    throw error;
  } finally {
    if (token === windowToken) {
      state.loadingDates = false;
      setDateInputsBusy(false);
      updateDateNote();
    }
  }
}

function datasetSignature(index, keys) {
  const wanted = new Set(keys);
  const parts = [];
  for (const day of index.days) {
    if (!wanted.has(day.date)) continue;
    parts.push(`${day.date}:${day.last_ms}:${day.rows}`);
  }
  return `${index.meta?.latest_timestamp_ms || 0}|${parts.join(",")}`;
}

function setDateInputsBusy(busy) {
  const from = $("date-from");
  const to = $("date-to");
  if (!from || !to) return;
  from.disabled = busy;
  to.disabled = busy;
}

function updateDateControls() {
  const from = $("date-from");
  const to = $("date-to");
  if (!from || !to) return;
  const index = state.index;
  if (!index?.days?.length) {
    updateDateNote("Dates unavailable in this snapshot.");
    return;
  }
  resolveDateWindow(index);
  const first = index.days[0].date;
  const last = index.days[index.days.length - 1].date;
  from.min = first;
  from.max = last;
  to.min = first;
  to.max = last;
  if (from.value !== state.dateFrom) from.value = state.dateFrom || "";
  if (to.value !== state.dateTo) to.value = state.dateTo || "";
  updateDateNote();
}

function updateDateNote(message = null) {
  const note = $("date-note");
  if (!note) return;
  if (message) {
    note.textContent = message;
    note.dataset.state = "loading";
    return;
  }
  const index = state.index;
  if (!index?.days?.length) {
    note.textContent = "Dates unavailable in this snapshot.";
    note.dataset.state = "error";
    return;
  }
  const totalDays = index.days.length;
  const loaded = state.loadedDays.length || 0;
  const rows = state.shardPoints.length || state.points.length;
  const totalRows = index.meta?.row_count ?? rows;
  note.dataset.state = "ready";
  note.textContent = `${loaded}/${totalDays} day${totalDays === 1 ? "" : "s"} loaded · ${rows.toLocaleString(
    "en-US"
  )} of ${Number(totalRows).toLocaleString("en-US")} readings · ${dayLabel(state.dateFrom, { short: true })} → ${dayLabel(
    state.dateTo,
    { short: true }
  )} UTC`;
}

function applyDateSelection(from, to) {
  if (!state.index) return;
  const first = state.index.days[0].date;
  const last = state.index.days[state.index.days.length - 1].date;
  let start = from || to || last;
  let end = to || from || start;
  if (start > end) {
    const swap = start;
    start = end;
    end = swap;
  }
  start = start < first ? first : start > last ? last : start;
  end = end < first ? first : end > last ? last : end;
  state.customDates = true;
  state.dateFrom = start;
  state.dateTo = end;
  state.range = "custom";
  state.customRange = null;
  state.playhead = null;
  state.selectedKey = null;
  stopReplay();
  syncFilterButtons();
  updateDateControls();
  loadWindowSafe({ animate: true });
}

function clearDateSelection() {
  state.customDates = false;
  state.dateFrom = null;
  state.dateTo = null;
  state.range = "7d";
  syncFilterButtons();
  loadWindowSafe({ animate: true });
}

function loadWindowSafe(options) {
  return loadWindow(options).catch((error) => {
    console.warn("Date range load failed", error);
    showBanner("Could not load that date range. Showing the previous window.", true);
    showToast("Date range load failed");
    const note = $("date-note");
    if (note) {
      note.textContent = "Date load failed · previous window kept";
      note.dataset.state = "error";
    }
  });
}

function parseDemo() {
  /* parseSnapshot is applied inside loadSnapshot; normalise demo the same way. */
  const raw = createDemoSnapshot();
  const points = raw.points
    .map((point) => {
      const s = String(point.s);
      const z = String(point.z);
      return { t: Number(point.t), p: Number(point.p), z, s, l: `${s}|${z}` };
    })
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
  // A custom date pick already narrowed the downloaded days, so no extra
  // time cut is needed. Presets still trim inside the loaded shards.
  const rangeMs = state.customDates ? 0 : RANGES[state.range] || 0;
  let rows = filterPoints(state.points, {
    sources: state.sources,
    country: state.country,
    zone: isZoneFocus() ? "all" : state.zone,
    rangeMs,
    anchor: currentAnchor(),
  });
  if (isZoneFocus()) {
    const keep = new Set(busiestZones(rows, ZONE_FOCUS[state.zone]));
    rows = rows.filter((point) => keep.has(point.z));
  }
  if (state.customRange) {
    const { t0, t1 } = state.customRange;
    rows = rows.filter((point) => point.t >= t0 && point.t <= t1);
  }
  return rows;
}

function isZoneFocus(value = state.zone) {
  return Object.prototype.hasOwnProperty.call(ZONE_FOCUS, value);
}

/** Zones ranked by reading count, with one guaranteed pick per feed. */
function busiestZones(points, limit) {
  const counts = new Map();
  const bySource = new Map();
  for (const point of points) {
    counts.set(point.z, (counts.get(point.z) || 0) + 1);
    if (!bySource.has(point.s)) bySource.set(point.s, new Map());
    const zones = bySource.get(point.s);
    zones.set(point.z, (zones.get(point.z) || 0) + 1);
  }
  const picked = new Set();
  // Keep every feed represented; otherwise a dense day-ahead feed can push a
  // whole real-time source out of the default stage.
  const sources = [...bySource.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [, zones] of sources) {
    const [zone] = [...zones.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] || [];
    if (zone) picked.add(zone);
  }
  if (picked.size > limit) return [...picked].slice(0, limit);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [zone] of ranked) {
    if (picked.size >= limit) break;
    picked.add(zone);
  }
  return [...picked];
}

function updateCountryOptions() {
  const select = $("country-select");
  const countries = countryIds(state.points);
  const previous = state.country;
  select.innerHTML = "";
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "All";
  select.appendChild(all);
  for (const code of countries) {
    const option = document.createElement("option");
    option.value = code;
    option.textContent = `${countryLabel(code)} (${code})`;
    option.title = `${countryLabel(code)} (${code})`;
    select.appendChild(option);
  }
  if (previous !== "all" && countries.includes(previous)) select.value = previous;
  else state.country = "all";
}

function zonesForCountry(points, country) {
  return zoneIds(points).filter((zone) => country === "all" || countryOf(zone) === country);
}

function updateZoneOptions() {
  const select = $("zone-select");
  const zones = zonesForCountry(state.points, state.country);
  const previous = state.zone;
  select.innerHTML = "";
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "All zones";
  select.appendChild(all);
  if (zones.length > 12) {
    for (const [value, limit] of Object.entries(ZONE_FOCUS)) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = `Top ${limit} zones`;
      select.appendChild(option);
    }
  }
  for (const zone of zones) {
    const option = document.createElement("option");
    option.value = zone;
    option.textContent = `${zone} - ${countryLabel(countryOf(zone))}`;
    option.title = option.textContent;
    select.appendChild(option);
  }
  if (previous === "all") select.value = "all";
  else if (isZoneFocus(previous) && zones.length > 12) select.value = previous;
  else if (zones.includes(previous)) select.value = previous;
  else state.zone = zones.length > 12 ? "top12" : "all";
  select.value = state.zone;
}

/* ---------------- rendering ---------------- */

function updateView({ animate = true } = {}) {
  const rows = viewRows();
  state.rows = rows;

  if (state.selectedKey) {
    const exists = rows.some((point) => pointKey(point) === state.selectedKey);
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

  const lanes = laneIds(rows);
  const colors = {};
  for (const id of lanes) colors[id] = laneColor(id, state.theme);

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

  const ranked = stats.lanes.slice().sort((a, b) => b.last - a.last);
  const cards = [];

  const laneCard = (lane, heading) => {
    const delta = lane.lastChange;
    const deltaPct = lane.lastChangePct;
    const deltaClass = delta == null ? "flat" : delta > 0 ? "up" : delta < 0 ? "down" : "flat";
    return `
      <article class="kpi">
        <div class="kpi-label">${esc(heading)} - ${esc(lane.label)}</div>
        <div class="kpi-value">${formatPrice(lane.last)}<span>EUR/MWh</span></div>
        <div class="kpi-foot"><span class="${deltaClass}">${
          delta == null ? "first reading" : `${formatSigned(delta)} (${formatSigned(deltaPct, 1, "%")})`
        }</span> - ${timeLabel(lane.lastTime)} UTC</div>
      </article>`;
  };

  if (ranked.length === 1) {
    cards.push(laneCard(ranked[0], "Latest price"));
  } else {
    cards.push(laneCard(ranked[0], "Highest"), laneCard(ranked[ranked.length - 1], "Lowest"));
  }

  const feedCount = new Set(stats.lanes.map((lane) => lane.source)).size;
  const shownZones = new Set(stats.lanes.map((lane) => lane.zone)).size;
  const totalZones = zonesForCountry(state.points, state.country).length;
  cards.push(`
    <article class="kpi">
      <div class="kpi-label">Range</div>
      <div class="kpi-value">${formatPrice(stats.min)}<span>- ${formatPrice(stats.max)}</span></div>
      <div class="kpi-foot">spread ${formatPrice(stats.spread)} EUR/MWh</div>
    </article>
    <article class="kpi">
      <div class="kpi-label">Coverage</div>
      <div class="kpi-value">${shownZones}<span>of ${totalZones} zone${totalZones === 1 ? "" : "s"}</span></div>
      <div class="kpi-foot">${stats.count} readings - ${feedCount} feed${feedCount === 1 ? "" : "s"} - ${rangeLabel(stats.lastTime - stats.firstTime)}</div>
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

  const zonesBySource = new Map();
  const latestBySource = new Map();
  for (const point of state.points) {
    if (!zonesBySource.has(point.s)) zonesBySource.set(point.s, new Set());
    zonesBySource.get(point.s).add(point.z);
    const current = latestBySource.get(point.s);
    if (!current || point.t > current.t) latestBySource.set(point.s, point);
  }

  container.innerHTML = ids
    .map((id) => {
      const meta = sourceMeta(id);
      const latest = latestBySource.get(id);
      const zoneCount = zonesBySource.get(id)?.size || 0;
      const active = state.sources.has(id);
      return `
        <button type="button" class="source-row" data-source="${esc(id)}" aria-pressed="${active}" title="${active ? "Hide" : "Show"} ${esc(meta.label)} - ${zoneCount} zone${zoneCount === 1 ? "" : "s"} - ${esc(meta.hint)}">
          <span class="source-swatch" style="--swatch:${sourceColor(id, state.theme)}"></span>
          <span class="source-name">
            <b>${esc(meta.label)}</b>
            <small>${zoneCount} zone${zoneCount === 1 ? "" : "s"} - ${esc(meta.hint)}</small>
          </span>
          <span class="source-figs">
            <span class="source-price">${latest ? formatPrice(latest.p) : "—"}</span>
            <span class="source-delta">${latest ? `${timeLabel(latest.t)} UTC` : ""}</span>
          </span>
        </button>`;
    })
    .join("");
}

function updateSourceList() {
  const summary = $("source-summary");
  const active = [...state.sources];
  const zones = zoneIds(state.rows);
  const totalZones = zonesForCountry(state.points, state.country).length;
  const zoneNote = isZoneFocus() ? `${zones.length}/${totalZones}` : String(zones.length);
  summary.textContent = `${active.length}/${sourceIds(state.points).length} feeds - ${zoneNote} zones - ${state.rows.length} pts`;
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
  if (!stats || !stats.lanes.length) {
    container.innerHTML = `<p class="focus-empty">No zones to compare.</p>`;
    $("compare-note").textContent = "-";
    return;
  }

  const visible = stats.lanes
    .filter((lane) => lanes.includes(lane.id) || !lanes.length)
    .sort((a, b) => b.mean - a.mean);
  const limit = 14;
  const shown = visible.slice(0, limit);
  const maxAverage = Math.max(...shown.map((lane) => Math.abs(lane.mean)), 1);
  container.innerHTML = shown
    .map((lane) => {
      const color = laneColor(lane.id, state.theme);
      const width = Math.max(2, (Math.abs(lane.mean) / maxAverage) * 100);
      return `
        <div class="compare-row" style="--swatch:${color}" title="${esc(laneLabel(lane.id))} - ${esc(countryLabel(lane.country))}">
          <div class="compare-top">
            <i class="compare-swatch"></i>
            <span class="compare-name">${esc(lane.label)}</span>
            <span class="compare-avg">${formatPrice(lane.mean)}</span>
          </div>
          <div class="compare-track"><i style="width:${width}%"></i></div>
          <div class="compare-range"><span>min ${formatPrice(lane.min)}</span><span>max ${formatPrice(lane.max)}</span></div>
        </div>`;
    })
    .join("");
  const suffix = visible.length > shown.length ? ` (top ${shown.length})` : "";
  const totalZones = zonesForCountry(state.points, state.country).length;
  const scope = visible.length < totalZones ? `${visible.length} of ${totalZones}` : String(visible.length);
  $("compare-note").textContent = `${scope} zone${visible.length === 1 ? "" : "s"}${suffix} - avg`;
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
    const lane = point.l || laneOf(point);
    if (!grouped.has(lane)) grouped.set(lane, []);
    grouped.get(lane).push(point);
  }
  const series = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, points]) => ({
      id,
      color: laneColor(id, state.theme),
      // displayRows is already time-ordered; sorting each lane again is wasted work.
      points,
    }));

  let t0 = Infinity;
  let t1 = -Infinity;
  for (const point of rows) {
    if (point.t < t0) t0 = point.t;
    if (point.t > t1) t1 = point.t;
  }
  const selected = state.selectedKey
    ? displayRows.find((point) => pointKey(point) === state.selectedKey) || null
    : null;

  timelineChart.setData({
    series,
    domain: { t0, t1: Math.max(t1, t0 + 1000) },
    playhead: state.playhead,
    selected,
    brush: state.customRange,
    theme: state.theme,
  });
  $("timeline-meta").textContent = `${rows.length} readings - ${grouped.size} zones - ${rangeLabel(t1 - t0)} - ${
    state.seriesMode === "indexed" ? "indexed" : "EUR/MWh"
  } - UTC`;
}

function updateDistribution(rows) {
  if (!distributionChart) return;
  // One aggregated histogram reads far better than 52 overlapping zone series;
  // the per-zone detail already lives in Compare and the timeline.
  const accent = state.theme === "light" ? "#0a84b8" : "#4cd7ff";
  distributionChart.setData({
    series: rows.length ? [{ id: "all", color: accent, points: rows }] : [],
    bins: 18,
  });
  const zones = zoneIds(rows).length;
  $("dist-meta").textContent = rows.length ? `${rows.length} pts - ${zones} zone${zones === 1 ? "" : "s"}` : "-";
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
  const loaded = state.points.length;
  const total = meta.row_count ?? loaded;
  $("pipeline-meta").innerHTML = `${esc(table)}<br>${loaded.toLocaleString("en-US")} / ${Number(
    total
  ).toLocaleString("en-US")} rows · ${state.loadedDays.length} day${
    state.loadedDays.length === 1 ? "" : "s"
  } · query ${esc(queryMs)}<br>published ${esc(generated)}`;
  $("help-meta").textContent = `${table} · ${total} rows · warehouse ${meta.warehouse_id || "—"}`;
}

function updateFilterHint() {
  const hint = $("filter-hint");
  const totalZones = zonesForCountry(state.points, state.country).length;
  if (state.customDates) {
    hint.textContent = `Date picker active: ${dayLabel(state.dateFrom)} → ${dayLabel(
      state.dateTo
    )} UTC. Only those day shards were downloaded; presets return to rolling windows.`;
  } else if (isZoneFocus() && totalZones > ZONE_FOCUS[state.zone]) {
    hint.textContent = `Stage shows the ${ZONE_FOCUS[state.zone]} busiest of ${totalZones} zones. Choose All zones, or a specific zone, for the full set.`;
  } else if (state.seriesMode === "indexed") {
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
  const lane = point.l || laneOf(point);
  const rows = state.rows
    .filter((row) => (row.l || laneOf(row)) === lane)
    .sort((a, b) => a.t - b.t);
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
  const point = state.displayRows.find((row) => pointKey(row) === key);
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
  // KPI and focus panels regroup every visible point, so refresh them at a
  // readable cadence instead of on every animation frame.
  if (!force && now - lastPlayheadStats < 240) return;
  lastPlayheadStats = now;
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
  text.textContent = state.customDates ? "Date window" : "Live snapshot";
  sub.textContent = statusSub();
}

function statusSub(extra = "") {
  const total = state.snapshot?.meta?.row_count ?? state.points.length;
  const loaded = state.shardPoints.length || state.points.length;
  const latest = Math.max(
    state.customDates ? latestTime(state.points) : state.snapshot?.meta?.latest_timestamp_ms || latestTime(state.points),
    liveLatest()
  );
  const rows = state.customDates ? `${loaded.toLocaleString("en-US")} of ${Number(total).toLocaleString("en-US")} rows` : `${total} rows`;
  return `${rows} · ${relativeTime(latest)}${extra}`;
}

function updateCountdown() {
  const sub = $("status-sub");
  if (!sub || state.demo || state.error || state.loading || !state.snapshot) return;
  const presence = state.presence;
  const liveCount = presence?.mode === "relay" ? ` · ${Number(presence.online) || 0} live` : "";
  if (!state.live) {
    sub.textContent = statusSub(` · auto off${liveCount}`);
    return;
  }
  const seconds = Math.max(0, Math.round((state.nextRefresh - Date.now()) / 1000));
  sub.textContent = statusSub(` · ${seconds}s${liveCount}`);
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
  updateLiveUi();
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
    state.customDates = false;
    state.dateFrom = null;
    state.dateTo = null;
    state.customRange = null;
    state.playhead = null;
    stopReplay();
    for (const item of $("range-group").querySelectorAll("[data-range]")) {
      item.setAttribute("aria-pressed", String(item.dataset.range === state.range));
    }
    updateDateControls();
    loadWindowSafe({ animate: true });
    closeDrawers();
  });

  $("date-from").addEventListener("change", (event) => {
    applyDateSelection(event.target.value, $("date-to").value);
  });
  $("date-to").addEventListener("change", (event) => {
    applyDateSelection($("date-from").value, event.target.value);
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

  $("country-select").addEventListener("change", (event) => {
    state.country = event.target.value;
    state.zone = isZoneFocus() ? state.zone : "all";
    state.selectedKey = null;
    state.playhead = null;
    stopReplay();
    updateZoneOptions();
    updateView({ animate: true });
  });

  $("zone-select").addEventListener("change", (event) => {
    state.zone = event.target.value;
    state.selectedKey = null;
    state.playhead = null;
    stopReplay();
    updateView({ animate: true });
  });

  // Clicking the field label only focuses a select; open the picker from the
  // whole field so the control behaves like the rest of the dashboard.
  for (const field of document.querySelectorAll(".field")) {
    const select = field.querySelector("select");
    if (!select) continue;
    field.addEventListener("click", (event) => {
      if (event.target === select) return;
      select.focus();
      if (typeof select.showPicker === "function") {
        try {
          select.showPicker();
        } catch {
          /* browsers without a picker for this control just keep the focus */
        }
      }
    });
  }

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
    updateCountryOptions();
    updateZoneOptions();
    syncFilterButtons();
    updateDateControls();
    loadWindowSafe({ animate: false });
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.live && Date.now() - state.lastLoad > 90000) refresh();
  });

  document.addEventListener("keydown", onKeyDown);
}

function resetFilters() {
  state.sources = new Set(sourceIds(state.points));
  state.country = "all";
  state.zone = zoneIds(state.points).length > 12 ? "top12" : "all";
  state.range = "7d";
  state.baseline = "window";
  state.seriesMode = "raw";
  state.customRange = null;
  state.customDates = false;
  state.dateFrom = null;
  state.dateTo = null;
  state.playhead = null;
  state.selectedKey = null;
  stopReplay();
  updateCountryOptions();
  updateZoneOptions();
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
  updateDateControls();
  loadWindowSafe({ animate: true });
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
  params.set("country", state.country);
  params.set("zone", state.zone);
  params.set("range", state.range);
  if (state.customDates) {
    params.set("from", state.dateFrom);
    params.set("to", state.dateTo);
  }
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
  const country = params.get("country");
  if (country) state.country = country;
  const zone = params.get("zone");
  if (zone) state.zone = zone;
  const range = params.get("range");
  if (range && RANGE_KEYS.includes(range)) state.range = range;
  const from = params.get("from");
  const to = params.get("to");
  if (/^\d{4}-\d{2}-\d{2}$/.test(from || "")) {
    state.customDates = true;
    state.dateFrom = from;
    state.dateTo = /^\d{4}-\d{2}-\d{2}$/.test(to || "") ? to : from;
    state.range = "custom";
  }
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
  timings,
  get scene() {
    return scene;
  },
  refresh,
  updateView,
  loadWindow: loadWindowSafe,
};
