/* AI & Tech Trends controller: Hugging Face trending model lifecycle,
   holographic 3D scene, model board, focus panel, and shared dashboard chrome. */

import { AIScene } from "./ai-scene.js?v=20261104-1";
import {
  createDemoSnapshot,
  loadHfModels,
  loadHfCache,
  formatCount,
  trendingTone,
} from "./ai-data.js?v=20261104-1";
import { initLiveCounter } from "./live-counter.js?v=20261105-1";

const REFRESH_MS = 300000;

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
  sortKey: "trendingScore",
  sortDir: -1,
  timer: 0,
  liveCheckedAt: 0,
  demoNoticeShown: false,
  cacheNoticeShown: false,
};

let toastTimer = 0;

function initScene() {
  const container = $("scene");
  try {
    state.scene = new AIScene(container, {
      onHover: (id) => {
        const tip = $("model-tooltip");
        if (!id) {
          tip.hidden = true;
          return;
        }
        const model = modelById(id);
        if (!model) {
          tip.hidden = true;
          return;
        }
        tip.hidden = false;
        tip.innerHTML = `<strong>▲ ${formatCount(model.trendingScore)}</strong>${escapeHtml(model.title)}<br><small>${escapeHtml(model.pipeline_tag || "—")} · by ${escapeHtml(model.author)}</small>`;
      },
      onSelect: (id) => {
        selectModel(id);
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
    localStorage.setItem("voltscope-ai-theme", state.theme);
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

async function loadModels({ silent = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  $("btn-refresh").classList.add("spinning");
  if (!state.snapshot && !silent) setStatus("loading", "Fetching Hugging Face…", "loading trending models");

  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 15000);
    let snapshot;
    try {
      snapshot = await loadHfModels({ signal: controller.signal });
    } finally {
      window.clearTimeout(timer);
    }
    state.snapshot = snapshot;
    state.demo = false;
    state.cached = false;
    state.liveCheckedAt = Date.now();
  } catch (error) {
    console.warn("Hugging Face feed unavailable", error);
    if (!state.snapshot) {
      const cacheController = new AbortController();
      const cacheTimer = window.setTimeout(() => cacheController.abort(), 10000);
      let cached = null;
      try {
        cached = await loadHfCache({ signal: cacheController.signal });
      } catch (cacheError) {
        console.warn("Hugging Face cache unavailable", cacheError);
      } finally {
        window.clearTimeout(cacheTimer);
      }
      if (cached) {
        state.snapshot = cached;
        state.cached = true;
        state.demo = false;
        if (!state.cacheNoticeShown) {
          state.cacheNoticeShown = true;
          showToast("Live Hugging Face unavailable — showing the last cached trending models.");
        }
      } else {
        state.snapshot = createDemoSnapshot();
        state.demo = true;
        state.cached = false;
        if (!state.demoNoticeShown) {
          state.demoNoticeShown = true;
          showToast("Live Hugging Face unavailable — showing demo trending models.");
        }
      }
    } else if (!silent) {
      showToast("Refresh failed. The last trending models are still on screen.");
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
    setStatus("demo", "Demo Hugging Face feed", `network unavailable · ${meta.count} sample models`);
  } else if (state.cached) {
    setStatus("cached", "Hugging Face cached", `${meta.count} models from last successful fetch`);
  } else {
    setStatus("live", "Hugging Face live", `${meta.count} trending models`);
  }
}

function startTimer() {
  window.clearInterval(state.timer);
  state.timer = window.setInterval(() => {
    if (state.auto && document.visibilityState === "visible") loadModels({ silent: true });
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
    text = `Showing demo trending models (network blocked). ${meta.count} models loaded.`;
  } else if (state.cached) {
    note = "cached";
    text = `Showing cached trending models (API unreachable). ${meta.count} models loaded.`;
  } else {
    note = "live";
    text = `Polling Hugging Face API every 5 min. ${meta.count} trending models loaded.`;
  }
  $("live-meta").textContent = text;
  $("pulse-note").textContent = note;
}

function modelById(id) {
  return state.snapshot?.models.find((m) => m.id === id) || null;
}

function render() {
  renderKpis();
  renderTable();
  if (state.scene) state.scene.setModels(state.snapshot.models);
  if (state.selected && !modelById(state.selected)) selectModel(null);
}

function renderKpis() {
  const meta = state.snapshot?.meta || {};
  $("kpi-models").textContent = String(meta.count ?? "—");
  $("kpi-models-sub").textContent = state.demo ? "demo models" : "trending models";
  $("kpi-trending").textContent = meta.average_trending_score != null ? formatCount(meta.average_trending_score) : "—";
  $("kpi-downloads").textContent = formatCount(meta.total_downloads);
  $("kpi-likes").textContent = formatCount(meta.total_likes);
  $("kpi-pipeline").textContent = meta.top_pipeline || "—";
}

function sortValue(model, key) {
  switch (key) {
    case "title": return model.title.toLowerCase();
    case "author": return model.author.toLowerCase();
    case "trendingScore": return model.trendingScore;
    case "downloads": return model.downloads;
    case "likes": return model.likes;
    default: return model.trendingScore;
  }
}

function renderTable() {
  const models = [...state.snapshot.models];
  const asc = state.sortDir === 1;
  models.sort((a, b) => {
    const av = sortValue(a, state.sortKey);
    const bv = sortValue(b, state.sortKey);
    if (typeof av === "string") return asc ? av.localeCompare(bv) : bv.localeCompare(av);
    return (av - bv) * (asc ? 1 : -1) || b.trendingScore - a.trendingScore;
  });

  const tbody = $("model-rows");
  tbody.innerHTML = "";

  for (const model of models) {
    const tr = document.createElement("tr");
    tr.dataset.model = String(model.id);
    if (model.id === state.selected) tr.classList.add("is-selected");
    tr.tabIndex = 0;
    tr.setAttribute("role", "row");

    const tone = trendingTone(model.trendingScore);
    tr.innerHTML = `
      <td class="model-cell">
        <span class="model-title">${escapeHtml(model.title)}</span>
        <span class="model-meta">by ${escapeHtml(model.author)}</span>
      </td>
      <td class="hide-sm">${escapeHtml(model.pipeline_tag || "—")}</td>
      <td class="num">
        <span class="score-tone ${tone}">▲ ${formatCount(model.trendingScore)}</span>
      </td>
      <td class="num hide-sm">${formatCount(model.downloads)}</td>
      <td class="num hide-sm">${formatCount(model.likes)}</td>
    `;

    tr.addEventListener("click", () => selectModel(model.id, { focus: true }));
    tr.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectModel(model.id, { focus: true });
      }
    });

    tbody.appendChild(tr);
  }

  const countEl = $("board-count");
  const total = state.snapshot.models.length;
  countEl.textContent = `${total} trending models · ${state.demo ? "demo" : "live"} feed`;

  for (const button of document.querySelectorAll("#model-table th button")) {
    const th = button.closest("th");
    if (button.dataset.sort === state.sortKey) {
      th.setAttribute("aria-sort", asc ? "ascending" : "descending");
    } else {
      th.removeAttribute("aria-sort");
    }
  }
}

function selectModel(id, { focus = false } = {}) {
  const previous = state.selected;
  state.selected = id || null;
  if (state.scene) state.scene.setSelected(state.selected);
  if (previous !== state.selected) renderTable();

  const focusBody = $("focus-body");
  const openBtn = $("btn-open-focus");
  const model = modelById(id);

  if (!model) {
    focusBody.innerHTML = `<p class="focus-empty">Select a model card in the 3D feed to inspect it.</p>`;
    openBtn.hidden = true;
    $("focus-note").textContent = "selection";
    return;
  }

  const tags = (model.tags || []).slice(0, 4).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("");
  focusBody.innerHTML = `
    <div class="focus-model">
      <h3>${escapeHtml(model.title)}</h3>
      <div class="focus-tags">${tags}</div>
      <a href="${escapeHtml(model.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(model.modelId)} ↗</a>
      <p class="focus-sub">by ${escapeHtml(model.author)} · ${model.library_name || "—"}</p>
      <dl class="focus-facts">
        <div><dt>Trending score</dt><dd>▲ ${formatCount(model.trendingScore)}</dd></div>
        <div><dt>Downloads</dt><dd>${formatCount(model.downloads)}</dd></div>
        <div><dt>Likes</dt><dd>${formatCount(model.likes)}</dd></div>
        <div><dt>Pipeline</dt><dd>${escapeHtml(model.pipeline_tag || "—")}</dd></div>
        <div><dt>Library</dt><dd>${escapeHtml(model.library_name || "—")}</dd></div>
        <div><dt>Model id</dt><dd>${model.id}</dd></div>
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

function bindEvents() {
  $("btn-theme").addEventListener("click", () => applyTheme(state.theme === "dark" ? "light" : "dark"));
  $("btn-refresh").addEventListener("click", () => loadModels());
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
    const model = modelById(state.selected);
    if (model) window.open(model.url, "_blank", "noopener,noreferrer");
  });

  const cameraGroup = $("camera-group");
  cameraGroup.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-camera]");
    if (!button) return;
    for (const sibling of cameraGroup.querySelectorAll("button")) sibling.classList.remove("is-active");
    button.classList.add("is-active");
    focusCamera(button.dataset.camera);
  });

  $("model-table").addEventListener("click", (event) => {
    const button = event.target.closest("th button[data-sort]");
    if (!button) return;
    const key = button.dataset.sort;
    if (state.sortKey === key) {
      state.sortDir = -state.sortDir;
    } else {
      state.sortKey = key;
      state.sortDir = key === "title" || key === "author" ? 1 : -1;
    }
    renderTable();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.auto) loadModels({ silent: true });
  });

  document.addEventListener("keydown", (event) => {
    const dialog = $("help-dialog");
    if (event.key === "Escape" && state.selected) {
      event.preventDefault();
      selectModel(null);
      return;
    }
    if (event.target.matches("input, textarea, select")) return;
    if (event.key === "r" || event.key === "R") {
      loadModels();
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
    saved = localStorage.getItem("voltscope-ai-theme") || "dark";
  } catch {
    saved = "dark";
  }
  applyTheme(saved);
  initScene();
  bindEvents();
  initLiveCounter({ room: "ai" });
  loadModels();
}

init();
