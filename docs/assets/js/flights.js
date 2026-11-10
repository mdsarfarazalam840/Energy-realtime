/* Flights page controller: snapshot loading, status/filter/selection UI, and
 * the keyboard/theme chrome. Rendering lives in flights-scene.js; data logic
 * (parsing, the deterministic demo deck, formatting) lives in
 * flights-data.js. */

import {
  fetchFlights,
  parseSnapshot,
  buildDemoSnapshot,
  countryFilterOptions,
  groupByCountry,
  formatAge,
  formatStamp,
  formatCoord,
} from "./flights-data.js?v=20261110-2";
import { createScene } from "./flights-scene.js?v=20261110-2";

const $ = (id) => document.getElementById(id);
const THEME_KEY = "voltscope-flights-theme";
const STALE_AFTER_MS = 90 * 60000; // the cache workflow runs hourly; past this the pipeline is suspect
const TOAST_MS = 4500;

let toastTimer = 0;

const els = {
  scene: $("flights-scene"),
  tooltip: $("flight-tooltip"),
  fallback: $("flight-fallback"),
  loading: $("flights-loading"),
  boot: $("boot"),
  bootSub: $("boot-sub"),
  toast: $("toast"),
  status: $("status"),
  statusText: $("status-text"),
  statusSub: $("status-sub"),
  source: $("flights-source"),
  asOf: $("flights-asof"),
  summary: $("flights-summary"),
  country: $("flights-country"),
  selected: $("flight-selected"),
  btnRefresh: $("btn-refresh"),
  btnOrbit: $("btn-orbit"),
  btnTheme: $("btn-theme"),
  btnHelp: $("btn-help"),
  btnHelpClose: $("btn-help-close"),
  help: $("help-dialog"),
};

const state = {
  planes: [],
  source: "loading",
  asOfMs: null,
  country: "",
  topCountries: new Set(),
  selected: null,
  orbitOn: true,
  scene: null,
  firstPaint: true,
};

const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
state.orbitOn = !reducedMotion;

function showToast(message) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, TOAST_MS);
}

function plottedCount(planes) {
  let count = 0;
  for (const plane of planes) {
    if (plane.lon !== null && plane.lat !== null) count++;
  }
  return count;
}

function renderSelected() {
  if (!els.selected) return;
  els.selected.textContent = "";
  if (!state.selected) {
    els.selected.textContent = "Click an aircraft on the globe to inspect it.";
    return;
  }
  const plane = state.planes.find((candidate) => candidate.icao24 === state.selected);
  if (!plane) {
    els.selected.textContent = "Click an aircraft on the globe to inspect it.";
    return;
  }
  const title = document.createElement("strong");
  title.textContent = plane.callsign || plane.icao24;
  const meta = document.createElement("span");
  meta.textContent = `${plane.country} · ${plane.icao24}`;
  const coords = document.createElement("span");
  coords.textContent = `${formatCoord(plane.lat, "lat")} ${formatCoord(plane.lon, "lon")}`;
  const stamp = document.createElement("span");
  stamp.textContent = plane.lastUpdateMs
    ? `updated ${formatStamp(plane.lastUpdateMs)} (${formatAge(Date.now() - plane.lastUpdateMs)})`
    : "update time unknown";
  els.selected.append(title, meta, coords, stamp);
}

function updateStatus() {
  if (!els.status) return;
  let kind = state.source;
  let text = "Loading snapshot";
  let sub = "reading data/flights.json";
  els.source.textContent = "—";
  els.asOf.textContent = "—";
  if (state.source === "demo") {
    kind = "demo";
    text = "Demo data";
    sub = "deterministic sample — no live snapshot loaded";
    els.source.textContent = "Demo";
  } else if (state.source === "live" || state.source === "loading") {
    if (state.source === "loading") {
      kind = "loading";
    } else {
      const age = state.asOfMs === null ? null : Date.now() - state.asOfMs;
      kind = age !== null && age > STALE_AFTER_MS ? "stale" : "live";
      text = kind === "stale" ? "Snapshot is stale" : "Live snapshot";
      els.source.textContent = "OpenSky";
      els.asOf.textContent = state.asOfMs === null ? "—" : `as of ${formatStamp(state.asOfMs)}`;
      sub = state.asOfMs === null
        ? `${plottedCount(state.planes)} aircraft · update time unknown`
        : `${plottedCount(state.planes)} aircraft · ${formatAge(age)} old`;
    }
  }
  status.dataset.state = kind;
  statusText.textContent = text;
  statusSub.textContent = sub;
}

function updateSummary(visible) {
  if (!els.summary) return;
  const total = plottedCount(state.planes);
  const countries = groupByCountry(state.planes).length;
  const parts = [`${total} aircraft`, `${countries} countries`];
  if (visible && visible.length !== total) parts.push(`showing ${visible.length}`);
  els.summary.textContent = parts.join(" · ");
}

function applyCountry() {
  const top = state.topCountries;
  const visible = state.planes.filter((plane) => {
    if (plane.lon === null || plane.lat === null) return false;
    if (state.country === "") return true;
    if (state.country === "__other__") return !top.has(plane.country);
    return plane.country === state.country;
  });
  if (state.selected && !visible.some((plane) => plane.icao24 === state.selected)) state.selected = null;
  if (state.scene) {
    state.scene.setPlanes(visible);
    state.scene.setHighlight(state.selected, "select");
  }
  renderSelected();
  updateSummary(visible);
}

function buildCountryOptions() {
  if (!els.country) return;
  const { top, rest, label } = countryFilterOptions(state.planes);
  state.topCountries = new Set(top.map((group) => group.country));
  els.country.textContent = "";
  const all = document.createElement("option");
  all.value = "";
  all.textContent = state.planes.length ? `All countries · ${state.planes.length}` : "All countries";
  els.country.appendChild(all);
  for (const group of top) {
    const option = document.createElement("option");
    option.value = group.country;
    option.textContent = label(group);
    els.country.appendChild(option);
  }
  if (rest > 0) {
    const option = document.createElement("option");
    option.value = "__other__";
    option.textContent = `Other countries · ${rest}`;
    els.country.appendChild(option);
  }
  const allowed = new Set(["", "__other__", ...top.map((group) => group.country)]);
  state.country = allowed.has(state.country) ? state.country : "";
  els.country.value = state.country;
}

function setData(snapshot) {
  state.planes = snapshot.planes;
  state.source = snapshot.source === "demo" ? "demo" : "live";
  state.asOfMs = null;
  if (state.source === "live" && snapshot.meta && snapshot.meta.fetched_at) {
    const parsed = Date.parse(snapshot.meta.fetched_at);
    if (Number.isFinite(parsed)) state.asOfMs = parsed;
  }
  state.selected = null;
  buildCountryOptions();
  applyCountry();
  updateStatus();
}

async function loadSnapshot({ announce = false } = {}) {
  try {
    const snapshot = await fetchFlights();
    setData(snapshot);
    if (announce) showToast(`Snapshot refreshed · ${plottedCount(state.planes)} aircraft`);
    if (state.firstPaint) {
      state.firstPaint = false;
      if (els.loading) els.loading.classList.add("is-done");
      if (els.boot) els.boot.classList.add("is-done");
      if (els.bootSub) els.bootSub.textContent = `${plottedCount(state.planes)} aircraft charted`;
    }
    return true;
  } catch (error) {
    console.warn("[flights] snapshot load failed:", error);
    if (state.planes.length === 0) {
      setData(parseSnapshot(buildDemoSnapshot()));
      showToast("No readable flights snapshot — showing demo data.");
    } else if (announce) {
      showToast("Refresh failed — showing the last good snapshot.");
    }
    return false;
  }
}

function selectIcao(icao) {
  const next = icao === null || icao === undefined ? null : String(icao);
  state.selected = next && state.planes.some((plane) => plane.icao24 === next) ? next : null;
  if (state.scene) state.scene.setHighlight(state.selected, "select");
  renderSelected();
}

function toggleTheme() {
  const light = document.documentElement.dataset.theme !== "light";
  document.documentElement.dataset.theme = light ? "light" : "dark";
  try {
    localStorage.setItem(THEME_KEY, light ? "light" : "dark");
  } catch {
    /* private mode: the toggle still works for this tab */
  }
  if (state.scene) state.scene.setTheme(light ? "light" : "dark");
}



function wireControls() {
  if (els.btnRefresh) els.btnRefresh.addEventListener("click", () => loadSnapshot({ announce: true }));
  if (els.btnOrbit) {
    els.btnOrbit.setAttribute("aria-pressed", String(state.orbitOn));
    els.btnOrbit.addEventListener("click", () => {
      state.orbitOn = !state.orbitOn;
      els.btnOrbit.setAttribute("aria-pressed", String(state.orbitOn));
      if (state.scene) state.scene.setOrbit(state.orbitOn);
    });
  }
  if (els.btnTheme) els.btnTheme.addEventListener("click", toggleTheme);
  if (els.btnHelp && typeof els.help?.showModal === "function") els.btnHelp.addEventListener("click", () => els.help.showModal());
  if (els.btnHelpClose) els.btnHelpClose.addEventListener("click", () => els.help?.close?.());
  if (els.country) els.country.addEventListener("change", () => {
    state.country = els.country.value;
    applyCountry();
  });
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const tag = (event.target && event.target.tagName) || "";
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    const key = event.key.toLowerCase();
    if (key === "l") {
      state.orbitOn = !state.orbitOn;
      els.btnOrbit?.setAttribute("aria-pressed", String(state.orbitOn));
      if (state.scene) state.scene.setOrbit(state.orbitOn);
    } else if (key === "r") {
      els.btnRefresh?.click();
    } else if (key === "t") {
      toggleTheme();
    } else if (key === "?") {
      if (typeof els.help?.showModal === "function") els.help.showModal();
    }
  });
}

function init() {
  wireControls();
  if (els.country) els.country.value = "";
  if (document.documentElement.dataset.theme !== "light") {
    try {
      const stored = localStorage.getItem(THEME_KEY);
      if (stored === "light" || stored === "dark") document.documentElement.dataset.theme = stored;
    } catch {
      /* storage may be unavailable */
    }
  }
  const scene = createScene(els.scene, {
    tooltip: els.tooltip,
    onSelect: (icao) => {
      state.selected = icao || null;
      if (state.scene && state.selected) state.scene.setHighlight(state.selected, "select");
      renderSelected();
    },
    onContextLost: () => {
      els.fallback.hidden = false;
      showToast("3D context lost — the snapshot panel still works.");
    },
    onUnavailable: () => {
      els.fallback.hidden = false;
      showToast("3D unavailable in this browser — snapshot details below.");
    },
  });
  state.scene = scene || null;
  if (scene) {
    scene.setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
    scene.setOrbit(state.orbitOn);
  }
  updateStatus();
  loadSnapshot();
}

if (typeof window !== "undefined") {
  window.__flights = {
    stats: () => ({
      source: state.source,
      total: state.planes.length,
      plotted: plottedCount(state.planes),
      selected: state.selected,
      asOf: state.asOfMs === null ? null : new Date(state.asOfMs).toISOString(),
    }),
    listIcaos: () => state.planes.map((plane) => plane.icao24),
    select: selectIcao,
  };
}

init();
