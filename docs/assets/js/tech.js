/* VoltScope Tech Pulse controller: Hacker News feed lifecycle, holographic 3D
   scene, headline board, focus panel, and shared dashboard chrome. */

import { TechScene } from "./tech-scene.js?v=20261104-1";
import {
  createDemoSnapshot,
  loadTechStories,
  loadTechCache,
  formatCount,
  relativeAge,
  storyTone,
} from "./tech-data.js?v=20261104-1";

const REFRESH_MS = 300000;
const SEARCH_RADIX = 36;

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
  theme: "dark",
  scene: null,
  selected: null,
  query: "",
  sortKey: "score",
  sortDir: -1,
  timer: 0,
  liveCheckedAt: 0,
  demoNoticeShown: false,
  cacheNoticeShown: false,
};

let toastTimer = 0;

/* ---------- 3D scene ---------- */

function initScene() {
  const container = $("scene");
  try {
    state.scene = new TechScene(container, {
      onHover: (id) => {
        const tip = $("story-tooltip");
        if (!id) {
          tip.hidden = true;
          return;
        }
        const story = storyById(id);
        if (!story) {
          tip.hidden = true;
          return;
        }
        tip.hidden = false;
        tip.innerHTML = `<strong>▲ ${formatCount(story.score)}</strong>${escapeHtml(story.title)}<br><small>${escapeHtml(story.domain || "news.ycombinator.com")} · by ${escapeHtml(story.by)}</small>`;
      },
      onSelect: (id) => {
        selectStory(id);
      },
      onCamera: () => {},
    });
    const loading = $("scene-loading");
    if (loading) loading.classList.add("is-done");
    const fallback = $("scene-fallback");
    if (fallback) fallback.hidden = true;
  } catch (error) {
    console.warn("3D scene unavailable", error);
    const loading = $("scene-loading");
    if (loading) loading.classList.add("is-done");
    const fallback = $("scene-fallback");
    if (fallback) fallback.hidden = false;
  }
}

function focusCamera(preset) {
  const scene = state.scene;
  if (!scene) return;
  const camera = scene.camera;
  const target = scene.controls.target;
  switch (preset) {
    case "feed":
      camera.position.set(0, 4, 26);
      target.set(0, 1.2, 0);
      break;
    case "closeup":
      camera.position.set(0, 2.5, 16);
      target.set(0, 1.4, 0);
      break;
    default:
      camera.position.set(0, 7, 30);
      target.set(0, 1, 0);
      break;
  }
  scene.controls.update();
  scene.onCamera?.();
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
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2800);
}

function applyTheme(theme) {
  state.theme = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = state.theme;
  if (state.scene) state.scene.setTheme(state.theme);
  try {
    localStorage.setItem("voltscope-tech-theme", state.theme);
  } catch {
    /* Storage can be blocked; the theme still applies for this tab. */
  }
}

function hideBoot() {
  const boot = $("boot");
  if (!boot || boot.classList.contains("is-done")) return;
  boot.classList.add("is-done");
  window.setTimeout(() => boot.remove(), 420);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ---------- Data lifecycle ---------- */

async function loadStories({ silent = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  $("btn-refresh").classList.add("spinning");
  if (!state.snapshot && !silent) setStatus("loading", "Fetching Hacker News…", "loading top stories");

  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 15000);
    let snapshot;
    try {
      snapshot = await loadTechStories({ signal: controller.signal });
    } finally {
      window.clearTimeout(timer);
    }
    state.snapshot = snapshot;
    state.demo = false;
    state.cached = false;
    state.liveCheckedAt = Date.now();
  } catch (error) {
    console.warn("Hacker News feed unavailable", error);
    if (!state.snapshot) {
      // Fail-Safe Cache: use the last committed Hacker News snapshot before
      // falling back to the demo deck.
      const cacheController = new AbortController();
      const cacheTimer = window.setTimeout(() => cacheController.abort(), 10000);
      let cached = null;
      try {
        cached = await loadTechCache({ signal: cacheController.signal });
      } catch (cacheError) {
        console.warn("Hacker News cache unavailable", cacheError);
      } finally {
        window.clearTimeout(cacheTimer);
      }
      if (cached) {
        state.snapshot = cached;
        state.cached = true;
        state.demo = false;
        if (!state.cacheNoticeShown) {
          state.cacheNoticeShown = true;
          showToast("Live Hacker News unavailable — showing the last cached headlines.");
        }
      } else {
        state.snapshot = createDemoSnapshot();
        state.demo = true;
        state.cached = false;
        if (!state.demoNoticeShown) {
          state.demoNoticeShown = true;
          showToast("Live Hacker News unavailable — showing demo headlines.");
        }
      }
    } else if (!silent) {
      showToast("Refresh failed. The last headlines are still on screen.");
    }
  } finally {
    state.loading = false;
    $("btn-refresh").classList.remove("spinning");
  }

  render();
  hideBoot();
  updateLiveMeta();
  updateStatus();
  if (state.auto) startTimer();
}

function updateStatus() {
  const meta = state.snapshot?.meta || {};
  if (state.demo) {
    setStatus("demo", "Demo Hacker News feed", `network unavailable · ${meta.count} sample headlines`);
  } else if (state.cached) {
    setStatus("cached", "Hacker News cached", `${meta.count} stories from last successful fetch`);
  } else {
    setStatus("live", "Hacker News live", `${meta.count} top stories`);
  }
}

function startTimer() {
  window.clearInterval(state.timer);
  state.timer = window.setInterval(() => {
    if (state.auto && document.visibilityState === "visible") loadStories({ silent: true });
  }, REFRESH_MS);
}

function stopTimer() {
  window.clearInterval(state.timer);
  state.timer = 0;
}

function updateLiveMeta() {
  const meta = state.snapshot?.meta || {};
  let note;
  let text;
  if (state.demo) {
    note = "demo";
    text = `Showing demo headlines (network blocked). ${meta.count} stories loaded.`;
  } else if (state.cached) {
    note = "cached";
    text = `Showing cached headlines (API unreachable). ${meta.count} stories loaded.`;
  } else {
    note = "live";
    text = `Polling Hacker News API every 5 min. ${meta.count} top stories loaded.`;
  }
  $("live-meta").textContent = text;
  $("pulse-note").textContent = note;
}

/* ---------- Rendering ---------- */

function storyById(id) {
  return state.snapshot?.stories.find((story) => story.id === id) || null;
}

function render() {
  renderKpis();
  renderTable();
  if (state.scene) state.scene.setStories(state.snapshot.stories);
  if (state.selected && !storyById(state.selected)) selectStory(null);
}

function renderKpis() {
  const meta = state.snapshot?.meta || {};
  $("kpi-stories").textContent = String(meta.count ?? "—");
  $("kpi-stories-sub").textContent = state.demo ? "demo headlines" : "top stories";
  $("kpi-score").textContent = meta.average_score != null ? formatCount(meta.average_score) : "—";
  $("kpi-domain").textContent = meta.top_domain || "—";
  $("kpi-comments").textContent = formatCount(meta.total_comments);
}

function filteredStories() {
  const query = state.query.trim().toLowerCase();
  if (!query) return state.snapshot.stories;
  return state.snapshot.stories.filter((story) => {
    return (
      story.title.toLowerCase().includes(query) ||
      (story.domain || "").toLowerCase().includes(query) ||
      story.by.toLowerCase().includes(query)
    );
  });
}

function sortValue(story, key) {
  switch (key) {
    case "title": return story.title.toLowerCase();
    case "domain": return (story.domain || "").toLowerCase();
    case "score": return story.score;
    case "comments": return story.comments;
    case "time": return story.time;
    default: return story.score;
  }
}

function renderTable() {
  const stories = filteredStories();
  const asc = state.sortDir === 1;
  stories.sort((a, b) => {
    const av = sortValue(a, state.sortKey);
    const bv = sortValue(b, state.sortKey);
    if (typeof av === "string") return asc ? av.localeCompare(bv) : bv.localeCompare(av);
    return (av - bv) * (asc ? 1 : -1) || b.score - a.score;
  });

  const tbody = $("story-rows");
  tbody.innerHTML = "";

  for (const story of stories) {
    const tr = document.createElement("tr");
    tr.dataset.story = String(story.id);
    if (story.id === state.selected) tr.classList.add("is-selected");
    tr.tabIndex = 0;
    tr.setAttribute("role", "row");

    const tone = storyTone(story);
    tr.innerHTML = `
      <td class="story-cell">
        <span class="story-title">${escapeHtml(story.title)}</span>
        <span class="story-meta">by ${escapeHtml(story.by)}</span>
      </td>
      <td class="hide-sm">${escapeHtml(story.domain || "—")}</td>
      <td class="num">
        <span class="score-tone ${tone}">▲ ${formatCount(story.score)}</span>
      </td>
      <td class="num hide-sm">${formatCount(story.comments)}</td>
      <td class="num">${relativeAge(story.time)}</td>
    `;

    tr.addEventListener("click", () => selectStory(story.id, { focus: true }));
    tr.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectStory(story.id, { focus: true });
      }
    });

    tbody.appendChild(tr);
  }

  const countEl = $("board-count");
  const total = state.snapshot.stories.length;
  countEl.textContent = state.query
    ? `${stories.length} of ${total} stories · ${state.demo ? "demo" : "live"} feed`
    : `${total} top stories · ${state.demo ? "demo" : "live"} feed`;

  for (const button of document.querySelectorAll("#story-table th button")) {
    const th = button.closest("th");
    if (button.dataset.sort === state.sortKey) {
      th.setAttribute("aria-sort", asc ? "ascending" : "descending");
    } else {
      th.removeAttribute("aria-sort");
    }
  }
}

function selectStory(id, { focus = false } = {}) {
  const previous = state.selected;
  state.selected = id || null;
  if (state.scene) state.scene.setSelected(state.selected);
  if (previous !== state.selected) renderTable();

  const focusBody = $("focus-body");
  const openBtn = $("btn-open-focus");
  const story = storyById(id);

  if (!story) {
    focusBody.innerHTML = `<p class="focus-empty">Select a story card in the 3D feed to inspect it.</p>`;
    openBtn.hidden = true;
    $("focus-note").textContent = "selection";
    return;
  }

  const domain = story.domain || "news.ycombinator.com";
  focusBody.innerHTML = `
    <div class="focus-story">
      <h3>${escapeHtml(story.title)}</h3>
      <a href="${escapeHtml(story.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(domain)} ↗</a>
      <p class="focus-sub">by ${escapeHtml(story.by)} · ${relativeAge(story.time)}</p>
      <dl class="focus-facts">
        <div><dt>Score</dt><dd>▲ ${formatCount(story.score)}</dd></div>
        <div><dt>Comments</dt><dd>${formatCount(story.comments)}</dd></div>
        <div><dt>Feed</dt><dd>${state.demo ? "demo" : "Hacker News"}</dd></div>
        <div><dt>Story id</dt><dd>${story.id}</dd></div>
      </dl>
    </div>
  `;
  openBtn.hidden = false;
  $("focus-note").textContent = "selected";

  if (focus) {
    const card = $("focus-card");
    if (card) card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

/* ---------- Events ---------- */

function bindEvents() {
  $("btn-theme").addEventListener("click", () => applyTheme(state.theme === "dark" ? "light" : "dark"));
  $("btn-refresh").addEventListener("click", () => loadStories());
  $("btn-auto").addEventListener("click", () => {
    state.auto = !state.auto;
    $("btn-auto").setAttribute("aria-pressed", String(state.auto));
    if (state.auto && state.snapshot) startTimer();
    else stopTimer();
  });
  $("btn-share").addEventListener("click", async () => {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      showToast("Link copied to clipboard.");
    } catch {
      try {
        window.prompt("Copy this link:", url);
      } catch {
        showToast("Copy the URL from the address bar.");
      }
    }
  });
  $("btn-help").addEventListener("click", () => $("help-dialog").showModal());
  $("btn-help-close").addEventListener("click", () => $("help-dialog").close());
  $("btn-open-focus").addEventListener("click", () => {
    const story = storyById(state.selected);
    if (story) window.open(story.url, "_blank", "noopener,noreferrer");
  });

  const cameraGroup = $("camera-group");
  cameraGroup.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-camera]");
    if (!button) return;
    for (const sibling of cameraGroup.querySelectorAll("button")) sibling.classList.remove("is-active");
    button.classList.add("is-active");
    focusCamera(button.dataset.camera);
  });

  $("story-table").addEventListener("click", (event) => {
    const button = event.target.closest("th button[data-sort]");
    if (!button) return;
    const key = button.dataset.sort;
    if (state.sortKey === key) {
      state.sortDir = -state.sortDir;
    } else {
      state.sortKey = key;
      state.sortDir = key === "title" || key === "domain" ? 1 : -1;
    }
    renderTable();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.auto) loadStories({ silent: true });
  });

  document.addEventListener("keydown", (event) => {
    const dialog = $("help-dialog");
    if (event.key === "Escape" && state.selected) {
      event.preventDefault();
      selectStory(null);
      return;
    }
    if (event.target.matches("input, textarea, select")) return;
    if (event.key === "r" || event.key === "R") {
      loadStories();
    } else if (event.key === "l" || event.key === "L") {
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
    saved = localStorage.getItem("voltscope-tech-theme") || "dark";
  } catch {
    saved = "dark";
  }
  applyTheme(saved);
  initScene();
  bindEvents();
  loadStories();
}

init();
