/* VoltScope Space controller: APOD window lifecycle, full-screen 3D
   observatory, accessible picture panel, orbit index, and shared dashboard
   chrome. */

import { SpaceScene } from "./space-scene.js?v=20261106-1";
import {
  createDemoSnapshot,
  loadApodWindow,
  loadApodCache,
  formatDate,
  formatShortDate,
  formatWindow,
  relativeWhen,
  mediaLabel,
  creditOf,
  entryUrl,
  resolveApiKey,
  todayUTC,
} from "./space-data.js?v=20261106-1";
import { initLiveCounter } from "./live-counter.js?v=20261105-1";

const REFRESH_MS = 1800000;
const FETCH_TIMEOUT_MS = 20000;

function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

const state = {
  snapshot: null,
  demo: false,
  cached: false,
  loading: false,
  auto: true,
  orbit: true,
  theme: "dark",
  scene: null,
  selectedDate: null,
  hashDate: null,
  apiKey: "DEMO_KEY",
  timer: 0,
  shownNotice: false,
};

let toastTimer = 0;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function readHashDate() {
  const match = /^#date=(\d{4}-\d{2}-\d{2})$/.exec(window.location.hash || "");
  return match ? match[1] : null;
}

function currentEntry() {
  const entries = state.snapshot?.entries || [];
  return entries.find((entry) => entry.date === state.selectedDate) || entries[entries.length - 1] || null;
}

/* ---------- 3D scene ---------- */

function initScene() {
  try {
    state.scene = new SpaceScene($("scene"), {
      onHover: handleHover,
      onSelect: (date) => selectDate(date),
      onOpen: (entry) => {
        const url = entryUrl(entry);
        if (url) window.open(url, "_blank", "noopener,noreferrer");
        else showToast("This demo frame has no source link.");
      },
    });
    state.scene.setTheme(state.theme);
    state.scene.setOrbit(state.orbit);
    const loading = $("scene-loading");
    if (loading) loading.classList.add("is-done");
  } catch (error) {
    console.warn("3D observatory unavailable", error);
    const loading = $("scene-loading");
    if (loading) loading.classList.add("is-done");
    const fallback = $("scene-fallback");
    if (fallback) fallback.hidden = false;
    state.scene = null;
  }
}

function handleHover(entry, event) {
  const tip = $("hero-tooltip");
  if (!entry || !event) {
    tip.hidden = true;
    return;
  }
  const rect = $("scene").getBoundingClientRect();
  tip.hidden = false;
  tip.innerHTML = `<strong>${escapeHtml(formatDate(entry.date))}</strong>${escapeHtml(entry.title)}<br><small>${escapeHtml(mediaLabel(entry))} · click to focus</small>`;
  const left = Math.min(rect.width - 292, Math.max(8, event.clientX - rect.left + 16));
  const top = Math.min(rect.height - 92, Math.max(8, event.clientY - rect.top + 14));
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

/* ---------- Chrome ---------- */

function setStatus(kind, text, sub = "") {
  $("status").dataset.state = kind;
  $("status-text").textContent = text;
  $("status-sub").textContent = sub;
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 3200);
}

function applyTheme(theme) {
  state.theme = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = state.theme;
  if (state.scene) state.scene.setTheme(state.theme);
  try {
    localStorage.setItem("voltscope-space-theme", state.theme);
  } catch {
    /* Storage can be blocked; the theme still applies to this tab. */
  }
}

function hideBoot() {
  const boot = $("boot");
  if (!boot || boot.classList.contains("is-done")) return;
  boot.classList.add("is-done");
  window.setTimeout(() => boot.remove(), 420);
}

/* ---------- Data lifecycle ---------- */

async function loadEntries({ silent = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  $("btn-refresh").classList.add("spinning");
  if (!state.snapshot && !silent) setStatus("loading", "Contacting NASA…", "fetching the last 14 days");

  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let snapshot;
    try {
      snapshot = await loadApodWindow({ apiKey: state.apiKey, signal: controller.signal });
    } finally {
      window.clearTimeout(timer);
    }
    state.snapshot = snapshot;
    state.demo = false;
    state.cached = false;
  } catch (error) {
    console.warn("NASA APOD unavailable", error);
    if (!state.snapshot) {
      // Fail-Safe Cache first: real pictures from the last committed snapshot.
      const cacheController = new AbortController();
      const cacheTimer = window.setTimeout(() => cacheController.abort(), 10000);
      let cached = null;
      try {
        cached = await loadApodCache({ signal: cacheController.signal });
      } catch (cacheError) {
        console.warn("APOD cache unavailable", cacheError);
      } finally {
        window.clearTimeout(cacheTimer);
      }
      if (cached) {
        state.snapshot = cached;
        state.cached = true;
        state.demo = false;
        if (!state.shownNotice) {
          state.shownNotice = true;
          showToast("NASA is unreachable — showing the last cached pictures.");
        }
      } else {
        state.snapshot = createDemoSnapshot();
        state.demo = true;
        state.cached = false;
        if (!state.shownNotice) {
          state.shownNotice = true;
          showToast(
            error?.status === 429
              ? "NASA rate limit reached — showing the demo gallery. Add ?api_key=YOUR_KEY for a higher limit."
              : "NASA is unreachable — showing the demo gallery."
          );
        }
      }
    } else if (!silent) {
      showToast("Refresh failed. The current pictures are still on screen.");
    }
  } finally {
    state.loading = false;
    $("btn-refresh").classList.remove("spinning");
  }

  render();
  hideBoot();
  if (state.auto) startTimer();
}

function updateStatus() {
  const meta = state.snapshot?.meta || {};
  if (state.demo) {
    setStatus("demo", "Demo space gallery", `network unavailable · ${meta.count || 0} sample frames`);
  } else if (state.cached) {
    setStatus("cached", "NASA APOD cached", `${meta.count || 0} frames · ${formatDate(meta.latest_date)}`);
  } else {
    setStatus("live", "NASA APOD live", `${meta.count || 0} frames · latest ${formatDate(meta.latest_date)}`);
  }
}

function startTimer() {
  window.clearInterval(state.timer);
  state.timer = window.setInterval(() => {
    if (state.auto && document.visibilityState === "visible") loadEntries({ silent: true });
  }, REFRESH_MS);
}

function stopTimer() {
  window.clearInterval(state.timer);
  state.timer = 0;
}

function sourceNote() {
  if (state.demo) return "NASA APOD · demo gallery";
  if (state.cached) return "NASA APOD · cached snapshot";
  return "NASA APOD · live";
}

/* ---------- Rendering ---------- */

function render() {
  const entries = state.snapshot?.entries || [];
  if (!entries.length) return;

  const hasSelection = entries.some((entry) => entry.date === state.selectedDate);
  if (!hasSelection) {
    const fromHash = state.hashDate && entries.some((entry) => entry.date === state.hashDate) ? state.hashDate : null;
    state.selectedDate = fromHash || entries[entries.length - 1].date;
    state.hashDate = null;
  }

  if (state.scene) state.scene.setEntries(entries, state.selectedDate);
  renderInfo();
  renderStrip();
  renderStats();
  updateStatus();
  updateHash();
}

function renderInfo() {
  const entry = currentEntry();
  if (!entry) return;
  const entries = state.snapshot.entries;
  $("space-title").textContent = entry.title;
  $("space-date").textContent = `${formatDate(entry.date)} · ${relativeWhen(entry.date)}`;
  $("space-media").textContent = mediaLabel(entry);
  $("space-media").dataset.media = entry.mediaType;
  $("space-explanation").textContent = entry.explanation || "NASA did not publish a description for this picture.";
  $("space-window").textContent = formatWindow(entries[0].date, entries[entries.length - 1].date);
  $("feed-note").textContent = `${creditOf(entry)} · ${sourceNote()}`;

  const link = $("space-link");
  const url = entryUrl(entry);
  if (url) {
    link.href = url;
    link.textContent = entry.mediaType === "video" ? "Watch on NASA ↗" : "Open full resolution ↗";
    link.hidden = false;
  } else {
    link.hidden = true;
    link.removeAttribute("href");
  }

  const index = entries.findIndex((item) => item.date === entry.date);
  $("btn-prev").disabled = index <= 0;
  $("btn-next").disabled = index >= entries.length - 1;
}

function updateStripSelection() {
  for (const chip of document.querySelectorAll("#day-strip .day-chip")) {
    chip.setAttribute("aria-selected", String(chip.dataset.date === state.selectedDate));
  }
}

function renderStrip() {
  const entries = state.snapshot.entries;
  const strip = $("day-strip");
  strip.innerHTML = "";
  for (const entry of entries) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "day-chip";
    button.dataset.date = entry.date;
    button.dataset.media = entry.mediaType;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(entry.date === state.selectedDate));
    button.setAttribute("aria-label", `${formatDate(entry.date)}: ${entry.title}`);
    button.innerHTML = `
      <strong><span class="day-dot" aria-hidden="true"></span>${escapeHtml(formatShortDate(entry.date))}</strong>
      <small>${escapeHtml(mediaLabel(entry))}${entry.date === todayUTC() ? " · today" : ""}</small>
    `;
    button.addEventListener("click", () => selectDate(entry.date, { scroll: true }));
    strip.appendChild(button);
  }
  updateStripSelection();
}

function renderStats() {
  const meta = state.snapshot?.meta || {};
  const parts = [`${meta.count || 0} frames`];
  if (meta.image_count) parts.push(`${meta.image_count} images`);
  if (meta.video_count) parts.push(`${meta.video_count} ${meta.video_count === 1 ? "video" : "videos"}`);
  if (meta.first_date && meta.latest_date) parts.push(formatWindow(meta.first_date, meta.latest_date));
  $("rail-note").textContent = parts.join(" · ");
}

function updateHash() {
  if (!state.selectedDate) return;
  const hash = `#date=${state.selectedDate}`;
  if (window.location.hash === hash) return;
  try {
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}${hash}`);
  } catch {
    /* Some embedded contexts block history writes; the panel still works. */
  }
}

/* ---------- Selection ---------- */

function selectDate(date, { scroll = false } = {}) {
  const entries = state.snapshot?.entries || [];
  if (!entries.some((entry) => entry.date === date)) return;
  state.selectedDate = date;
  if (state.scene) state.scene.setSelected(date);
  renderInfo();
  updateStripSelection();
  updateHash();
  if (scroll) {
    const chip = document.querySelector(`#day-strip .day-chip[data-date="${date}"]`);
    if (chip && typeof chip.scrollIntoView === "function") {
      chip.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  }
}

function step(delta) {
  const entries = state.snapshot?.entries || [];
  const index = entries.findIndex((entry) => entry.date === state.selectedDate);
  if (index < 0) return;
  const next = entries[index + delta];
  if (!next) {
    showToast(`That is the ${delta < 0 ? "oldest" : "newest"} picture in this window.`);
    return;
  }
  selectDate(next.date, { scroll: true });
}

/* ---------- Events ---------- */

function syncOrbitButton() {
  $("btn-orbit").setAttribute("aria-pressed", String(state.orbit));
}

function bindEvents() {
  $("btn-theme").addEventListener("click", () => applyTheme(state.theme === "dark" ? "light" : "dark"));
  $("btn-refresh").addEventListener("click", () => loadEntries());
  $("btn-auto").addEventListener("click", () => {
    state.auto = !state.auto;
    $("btn-auto").setAttribute("aria-pressed", String(state.auto));
    if (state.auto && state.snapshot) startTimer();
    else stopTimer();
  });
  $("btn-orbit").addEventListener("click", () => {
    state.orbit = !state.orbit;
    syncOrbitButton();
    if (state.scene) state.scene.setOrbit(state.orbit);
  });
  $("btn-share").addEventListener("click", async () => {
    const url = new URL(window.location.href);
    url.searchParams.delete("api_key");
    url.hash = `date=${state.selectedDate || ""}`;
    try {
      await navigator.clipboard.writeText(url.toString());
      showToast("Link copied to clipboard.");
    } catch {
      try {
        window.prompt("Copy this link:", url.toString());
      } catch {
        showToast("Copy the URL from the address bar.");
      }
    }
  });
  $("btn-help").addEventListener("click", () => $("help-dialog").showModal());
  $("btn-help-close").addEventListener("click", () => $("help-dialog").close());
  $("btn-prev").addEventListener("click", () => step(-1));
  $("btn-next").addEventListener("click", () => step(1));

  const cameraGroup = $("camera-group");
  cameraGroup.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-camera]");
    if (!button) return;
    for (const sibling of cameraGroup.querySelectorAll("button")) sibling.classList.remove("is-active");
    button.classList.add("is-active");
    if (state.scene) state.scene.focusCamera(button.dataset.camera);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.auto) loadEntries({ silent: true });
  });

  document.addEventListener("keydown", (event) => {
    const dialog = $("help-dialog");
    if (event.key === "Escape" && dialog.open) {
      dialog.close();
      return;
    }
    if (event.target.matches("input, textarea, select")) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      step(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      step(1);
    } else if (event.key === "r" || event.key === "R") {
      loadEntries();
    } else if (event.key === "l" || event.key === "L") {
      $("btn-orbit").click();
    } else if (event.key === "a" || event.key === "A") {
      $("btn-auto").click();
    } else if (event.key === "t" || event.key === "T") {
      $("btn-theme").click();
    } else if (event.key === "?") {
      dialog.showModal();
    }
  });
}

function init() {
  let saved = "dark";
  try {
    saved = localStorage.getItem("voltscope-space-theme") || "dark";
  } catch {
    saved = "dark";
  }
  state.apiKey = resolveApiKey();
  state.hashDate = readHashDate();
  state.orbit = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  state.theme = saved === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = state.theme;

  initScene();
  bindEvents();
  syncOrbitButton();
  initLiveCounter({ room: "space" });
  loadEntries();
}

init();
