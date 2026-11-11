/* Global News & Culture controller: Wikipedia top-pageviews lifecycle,
   attention-constellation 3D scene, ranked board, focus panel and feed health.
   The page is self-contained: this module owns every element it renders. */

import { NewsScene } from "./news-scene.js?v=20261111-1";
import {
  createDemoSnapshot,
  loadWikipediaTopArticles,
  loadNewsCache,
  formatCount,
  categoryColor,
} from "./news-data.js?v=20261111-1";
import { initLiveCounter } from "./live-counter.js?v=20261105-1";

const REFRESH_MS = 300000;

function $(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element;
}

const state = {
  snapshot: null,
  demo: false,
  cached: false,
  loading: false,
  auto: true,
  theme: "dark",
  mode: "globe",
  scene: null,
  selected: null,
  sortKey: "views",
  sortDir: -1,
  query: "",
  timer: 0,
  clock: 0,
  lastLoadedAt: 0,
  liveCheckedAt: 0,
  demoNoticeShown: false,
  cacheNoticeShown: false,
};

let toastTimer = 0;

const FOCUS_EMPTY = `
  <div class="focus-empty">
    <span class="focus-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="2.2"/></svg>
    </span>
    <strong>Choose a story</strong>
    <p>Pick any row in the ranking or a point on the constellation to inspect it here.</p>
  </div>
`;

/* ---------- utilities ---------- */

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatUtcTime(ms) {
  const date = new Date(ms);
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes} UTC`;
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

/* ---------- 3D scene ---------- */

function initScene() {
  const container = $("scene");
  const loading = $("scene-loading");
  const fallback = $("scene-fallback");

  function showFallback() {
    if (loading) loading.hidden = true;
    if (fallback) fallback.hidden = false;
  }

  let webgl = false;
  try {
    const test = document.createElement("canvas");
    webgl = !!(test.getContext("webgl") || test.getContext("experimental-webgl"));
  } catch {
    webgl = false;
  }

  if (!webgl) {
    console.warn("WebGL is not available in this browser.");
    showFallback();
    return;
  }

  try {
    state.scene = new NewsScene(container, {
      mode: state.mode,
      onHover: (id, event) => {
        const tip = $("article-tooltip");
        if (!id || !event) {
          tip.hidden = true;
          return;
        }
        const article = articleById(id);
        if (!article) {
          tip.hidden = true;
          return;
        }
        tip.hidden = false;
        tip.innerHTML = `<strong>${escapeHtml(article.title)}</strong>#${article.rank} · ${escapeHtml(article.category)}<br><small>${formatCount(article.views)} views · last 24h</small>`;
        const rect = container.getBoundingClientRect();
        const x = Math.min(Math.max(event.clientX - rect.left + 14, 8), Math.max(8, rect.width - 310));
        const y = Math.min(Math.max(event.clientY - rect.top + 14, 8), Math.max(8, rect.height - 110));
        tip.style.transform = `translate(${x}px, ${y}px)`;
      },
      onSelect: (id) => {
        selectArticle(id);
      },
      onCamera: () => {},
    });
    if (loading) loading.hidden = true;
    if (fallback) fallback.hidden = true;
  } catch (error) {
    console.error("3D scene failed", error);
    showToast("3D scene unavailable: " + error.message);
    showFallback();
  }
}

function focusCamera(preset) {
  const scene = state.scene;
  if (!scene) return;
  const camera = scene.camera;
  const target = scene.controls.target;
  switch (preset) {
    case "feed":
      camera.position.set(0, 3, 18);
      target.set(0, 1, 0);
      break;
    case "closeup":
      camera.position.set(0, 2, 13);
      target.set(0, 1.2, 0);
      break;
    default:
      camera.position.set(0, 6, 26);
      target.set(0, 0.5, 0);
      break;
  }
  scene.controls.update();
  scene.onCamera?.();
}

/* ---------- chrome ---------- */

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
    localStorage.setItem("voltscope-news-theme", state.theme);
  } catch {
    /* Storage can be blocked; the theme still applies for this tab. */
  }
}

function switchTheme(mode) {
  state.mode = mode;
  if (state.scene) state.scene.setMode(mode);
  try {
    localStorage.setItem("voltscope-news-mode", state.mode);
  } catch {
    /* Storage can be blocked; the mode still applies for this tab. */
  }
  const select = document.getElementById("theme-select");
  if (select) select.value = mode;
  showToast(`Constellation theme: ${mode.charAt(0).toUpperCase() + mode.slice(1)}`);
}

function hideBoot() {
  const boot = document.getElementById("boot");
  if (!boot || boot.classList.contains("is-done")) return;
  boot.classList.add("is-done");
  window.setTimeout(() => boot.remove(), 420);
}

/* ---------- data loading ---------- */

async function loadArticles({ silent = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  $("btn-refresh").classList.add("is-busy");
  if (!state.snapshot && !silent) setStatus("loading", "Fetching Wikipedia…", "loading top pageviews");

  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 15000);
    let snapshot;
    try {
      snapshot = await loadWikipediaTopArticles({ signal: controller.signal });
    } finally {
      window.clearTimeout(timer);
    }
    state.snapshot = snapshot;
    state.demo = false;
    state.cached = false;
    state.liveCheckedAt = Date.now();
  } catch (error) {
    console.warn("Wikipedia feed unavailable", error);
    if (!state.snapshot) {
      const cacheController = new AbortController();
      const cacheTimer = window.setTimeout(() => cacheController.abort(), 10000);
      let cached = null;
      try {
        cached = await loadNewsCache({ signal: cacheController.signal });
      } catch (cacheError) {
        console.warn("News cache unavailable", cacheError);
      } finally {
        window.clearTimeout(cacheTimer);
      }
      if (cached) {
        state.snapshot = cached;
        state.cached = true;
        state.demo = false;
        if (!state.cacheNoticeShown) {
          state.cacheNoticeShown = true;
          showToast("Live Wikipedia unavailable — showing the last cached top articles.");
        }
      } else {
        state.snapshot = createDemoSnapshot();
        state.demo = true;
        state.cached = false;
        if (!state.demoNoticeShown) {
          state.demoNoticeShown = true;
          showToast("Live Wikipedia unavailable — showing demo top articles.");
        }
      }
    } else if (!silent) {
      showToast("Refresh failed. The last top articles are still on screen.");
    }
  } finally {
    state.loading = false;
    $("btn-refresh").classList.remove("is-busy");
  }

  state.lastLoadedAt = Date.now();
  render();
  hideBoot();
  updateFeedHealth();
  updateStatus();
  updateClock();
  if (state.auto) startTimer();
}

function updateStatus() {
  const meta = state.snapshot?.meta || {};
  if (state.demo) {
    setStatus("demo", "Demo feed", `${meta.count} sample stories`);
  } else if (state.cached) {
    setStatus("cached", "Wikipedia cached", `${meta.count} stories from the last fetch`);
  } else {
    setStatus("live", "Wikipedia live", `${meta.count} stories · last 24h`);
  }
}

function updateFeedHealth() {
  const meta = state.snapshot?.meta || {};
  let stateKey = "live";
  let label = "Live";
  let note;

  if (state.demo) {
    stateKey = "demo";
    label = "Demo data";
    note = `Live Wikipedia is unreachable, so the page shows a labelled demo set of ${meta.count} stories.`;
  } else if (state.cached) {
    stateKey = "cached";
    label = "Cached snapshot";
    note = `Wikipedia is unreachable, so the page shows the last cached snapshot of ${meta.count} stories.`;
  } else {
    note = `Polling the Wikimedia Pageviews API every 5 minutes. ${meta.count} stories in the current window.`;
  }

  const feedState = $("feed-state");
  feedState.dataset.state = stateKey;
  setText("feed-state-label", label);
  setText("live-meta", note);
  setText("feed-count", String(meta.count ?? "—"));
  setText("feed-views", formatCount(meta.total_views));
}

function startTimer() {
  window.clearInterval(state.timer);
  state.timer = window.setInterval(() => {
    if (state.auto && document.visibilityState === "visible") loadArticles({ silent: true });
  }, REFRESH_MS);
}

function stopTimer() {
  window.clearInterval(state.timer);
  state.timer = 0;
}

function updateClock() {
  const nodes = document.querySelectorAll("[data-next]");
  let text = "—";
  if (!state.auto) {
    text = "Paused";
  } else if (state.lastLoadedAt) {
    text = formatClock(REFRESH_MS - (Date.now() - state.lastLoadedAt));
  }
  for (const node of nodes) node.textContent = text;

  const updated = document.querySelectorAll("[data-updated]");
  const stamp = state.lastLoadedAt ? formatUtcTime(state.lastLoadedAt) : "—";
  for (const node of updated) node.textContent = stamp;
}

function startClock() {
  window.clearInterval(state.clock);
  state.clock = window.setInterval(updateClock, 1000);
}

/* ---------- rendering ---------- */

function articleById(id) {
  return state.snapshot?.articles.find((article) => article.id === id) || null;
}

function render() {
  renderKpis();
  renderTable();
  renderSpotlight();
  renderMix();
  renderLegend();
  if (state.scene) state.scene.setItems(state.snapshot.articles);
  if (state.selected && !articleById(state.selected)) selectArticle(null);
}

function renderKpis() {
  const meta = state.snapshot?.meta || {};
  const count = meta.count ?? 0;
  const total = meta.total_views ?? 0;
  setText("kpi-articles", String(meta.count ?? "—"));
  setText("kpi-articles-sub", state.demo ? "demo stories" : state.cached ? "cached stories" : "live stories");
  setText("kpi-views", formatCount(total));
  setText("kpi-views-sub", "combined · last 24h");
  setText("kpi-category", meta.top_category || "—");
  setText("kpi-category-sub", "most frequent");
  setText("kpi-avg", count ? formatCount(total / count) : "—");
  setText("kpi-avg-sub", "views per story");
}

function sortValue(article, key) {
  switch (key) {
    case "title": return article.title.toLowerCase();
    case "category": return article.category.toLowerCase();
    case "views": return article.views;
    default: return article.views;
  }
}

function renderTable() {
  const all = state.snapshot.articles;
  const totalViews = state.snapshot.meta.total_views || all.reduce((sum, article) => sum + article.views, 0);
  const maxViews = all[0]?.views || 1;
  const query = state.query.trim().toLowerCase();

  const filtered = query
    ? all.filter((article) => `${article.title} ${article.category}`.toLowerCase().includes(query))
    : all;

  const asc = state.sortDir === 1;
  const sorted = [...filtered].sort((a, b) => {
    const av = sortValue(a, state.sortKey);
    const bv = sortValue(b, state.sortKey);
    if (typeof av === "string") return asc ? av.localeCompare(bv) : bv.localeCompare(av);
    return (av - bv) * (asc ? 1 : -1) || a.rank - b.rank;
  });

  const tbody = $("article-rows");
  tbody.innerHTML = sorted
    .map((article) => {
      const share = totalViews ? (article.views / totalViews) * 100 : 0;
      const bar = Math.max(2, (article.views / maxViews) * 100);
      const color = categoryColor(article.category);
      const rowClass = [
        article.id === state.selected ? "is-selected" : "",
        article.rank <= 3 ? "is-top" : "",
        article.rank === 1 ? "rank-one" : "",
      ].filter(Boolean).join(" ");
      return `
        <tr data-article="${escapeHtml(article.id)}"${rowClass ? ` class="${rowClass}"` : ""} tabindex="0">
          <td class="rank-cell">${String(article.rank).padStart(2, "0")}</td>
          <td class="story-cell">
            <span class="story-title">${escapeHtml(article.title)}</span>
            <span class="story-meta"><i class="cat-dot" style="--c:${color}"></i>${escapeHtml(article.category)} · Wikipedia</span>
          </td>
          <td class="share-cell hide-sm">
            <span class="share-track"><span class="share-fill" style="width:${bar.toFixed(1)}%"></span></span>
            <span class="share-label">${share >= 0.05 ? share.toFixed(1) : "<0.1"}% of views</span>
          </td>
          <td class="views-cell">${formatCount(article.views)}</td>
        </tr>
      `;
    })
    .join("");

  if (!sorted.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4">
          <div class="table-empty"><strong>No stories match “${escapeHtml(state.query.trim())}”.</strong>Try another word, or clear the filter.</div>
        </td>
      </tr>
    `;
  }

  const feedKind = state.demo ? "demo" : state.cached ? "cached" : "live";
  const countText = query
    ? `${sorted.length} of ${all.length} match “${state.query.trim()}”`
    : `${all.length} stories · ${feedKind} feed`;
  setText("board-count", countText);

  for (const button of document.querySelectorAll("#article-table th button[data-sort]")) {
    const th = button.closest("th");
    if (button.dataset.sort === state.sortKey) {
      th.setAttribute("aria-sort", asc ? "ascending" : "descending");
    } else {
      th.removeAttribute("aria-sort");
    }
  }
}

function renderSpotlight() {
  const lead = state.snapshot.articles[0];
  if (!lead) return;
  setText("spotlight-views", `${formatCount(lead.views)} views`);
  setText("spotlight-title", lead.title);
  setText("spotlight-meta", `#${lead.rank} · ${lead.category} · last 24h`);
}

function renderMix() {
  const list = $("mix-list");
  const articles = state.snapshot.articles;
  const counts = new Map();
  for (const article of articles) {
    counts.set(article.category, (counts.get(article.category) || 0) + 1);
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (!rows.length) return;
  const max = rows[0][1] || 1;

  list.innerHTML = rows
    .map(([category, count]) => {
      const color = categoryColor(category);
      const width = Math.max(6, (count / max) * 100);
      return `
        <li class="mix-row">
          <span class="mix-name"><i class="cat-dot" style="--c:${color}"></i>${escapeHtml(category)}</span>
          <span class="mix-count">${count} ${count === 1 ? "story" : "stories"}</span>
          <span class="mix-track"><span class="mix-fill" style="--c:${color}; width:${width.toFixed(1)}%"></span></span>
        </li>
      `;
    })
    .join("");
}

function renderLegend() {
  const legend = $("stage-legend");
  const articles = state.snapshot.articles;
  const counts = new Map();
  for (const article of articles) {
    counts.set(article.category, (counts.get(article.category) || 0) + 1);
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  legend.innerHTML = rows
    .map(([category, count]) => {
      const color = categoryColor(category);
      return `<span class="legend-item"><i class="legend-swatch" style="background:${color}"></i>${escapeHtml(category)} · ${count}</span>`;
    })
    .join("");
}

/* ---------- selection ---------- */

function selectArticle(id, { focus = false } = {}) {
  const previous = state.selected;
  state.selected = id || null;
  if (state.scene) state.scene.setSelected(state.selected);
  if (previous !== state.selected) {
    for (const row of $("article-rows").querySelectorAll("tr[data-article]")) {
      row.classList.toggle("is-selected", row.dataset.article === state.selected);
    }
  }

  const focusBody = $("focus-body");
  const openBtn = $("btn-open-focus");
  const article = articleById(id);

  if (!article) {
    focusBody.innerHTML = FOCUS_EMPTY;
    openBtn.hidden = true;
    setText("focus-note", "nothing selected");
    return;
  }

  const total = state.snapshot.meta.total_views || state.snapshot.articles.reduce((sum, item) => sum + item.views, 0);
  const share = total ? (article.views / total) * 100 : 0;
  const lead = state.snapshot.articles[0];
  const gap = lead && lead.id !== article.id ? formatCount(lead.views - article.views) : "—";
  const color = categoryColor(article.category);

  focusBody.innerHTML = `
    <span class="focus-kicker"><i class="cat-dot" style="--c:${color}"></i>${escapeHtml(article.category)}</span>
    <h3 class="focus-title">${escapeHtml(article.title)}</h3>
    <dl class="focus-facts">
      <div><dt>Rank</dt><dd>#${article.rank}</dd></div>
      <div><dt>Views · 24h</dt><dd>${formatCount(article.views)}</dd></div>
      <div><dt>Share of feed</dt><dd>${share >= 0.05 ? share.toFixed(1) : "<0.1"}%</dd></div>
      <div><dt>Gap to lead</dt><dd>${gap}</dd></div>
    </dl>
    <div class="focus-actions">
      <a class="btn-primary" href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer">Open on Wikipedia ↗</a>
      <button class="btn-ghost" type="button" data-action="clear">Clear</button>
    </div>
    <p class="focus-source">Article id: ${escapeHtml(String(article.id))}</p>
  `;
  openBtn.hidden = false;
  setText("focus-note", `story #${article.rank} of ${state.snapshot.articles.length}`);

  if (focus) {
    const card = $("focus-card");
    if (card) card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

/* ---------- events ---------- */

function bindEvents() {
  $("btn-theme").addEventListener("click", () => applyTheme(state.theme === "dark" ? "light" : "dark"));
  $("btn-refresh").addEventListener("click", () => loadArticles());
  $("btn-auto").addEventListener("click", () => {
    state.auto = !state.auto;
    $("btn-auto").setAttribute("aria-pressed", String(state.auto));
    if (state.auto && state.snapshot) startTimer();
    else stopTimer();
    updateClock();
    showToast(state.auto ? "Auto-refresh on · every 5 min." : "Auto-refresh paused.");
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
    const article = articleById(state.selected);
    if (article) window.open(article.url, "_blank", "noopener,noreferrer");
  });

  $("stage-spotlight").addEventListener("click", () => {
    const lead = state.snapshot?.articles[0];
    if (lead) selectArticle(lead.id, { focus: true });
  });

  $("focus-body").addEventListener("click", (event) => {
    if (event.target.closest("[data-action='clear']")) selectArticle(null);
  });

  const cameraGroup = $("camera-group");
  cameraGroup.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-camera]");
    if (!button) return;
    for (const sibling of cameraGroup.querySelectorAll("button")) sibling.classList.remove("is-active");
    button.classList.add("is-active");
    focusCamera(button.dataset.camera);
  });

  $("theme-select")?.addEventListener("change", (event) => switchTheme(event.target.value));

  $("article-search").addEventListener("input", (event) => {
    state.query = event.target.value;
    renderTable();
  });

  $("article-table").addEventListener("click", (event) => {
    const sortButton = event.target.closest("th button[data-sort]");
    if (sortButton) {
      const key = sortButton.dataset.sort;
      if (state.sortKey === key) {
        state.sortDir = -state.sortDir;
      } else {
        state.sortKey = key;
        state.sortDir = key === "title" || key === "category" ? 1 : -1;
      }
      renderTable();
      return;
    }
    const row = event.target.closest("tr[data-article]");
    if (row) selectArticle(row.dataset.article, { focus: true });
  });

  $("article-table").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest("tr[data-article]");
    if (!row) return;
    event.preventDefault();
    selectArticle(row.dataset.article, { focus: true });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.auto) loadArticles({ silent: true });
  });

  document.addEventListener("keydown", (event) => {
    const dialog = $("help-dialog");
    const search = $("article-search");
    if (event.key === "Escape") {
      if (dialog.open) return; // native dialog closes itself on Escape
      if (state.query) {
        search.value = "";
        state.query = "";
        renderTable();
        return;
      }
      if (state.selected) {
        event.preventDefault();
        selectArticle(null);
      }
      return;
    }
    if (event.target.matches("input, textarea, select")) return;
    if (event.key === "/") {
      event.preventDefault();
      search.focus();
      search.select();
    } else if (event.key === "r" || event.key === "R") {
      loadArticles();
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
  let savedTheme = "dark";
  let savedMode = "globe";
  try {
    savedTheme = localStorage.getItem("voltscope-news-theme") || "dark";
    savedMode = localStorage.getItem("voltscope-news-mode") || "globe";
  } catch {
    savedTheme = "dark";
    savedMode = "globe";
  }
  applyTheme(savedTheme);
  state.mode = savedMode;
  const select = document.getElementById("theme-select");
  if (select) select.value = savedMode;
  const nav = document.querySelector(".site-nav");
  const active = nav?.querySelector("a.is-active");
  if (nav && active && nav.scrollWidth > nav.clientWidth) {
    nav.scrollLeft = active.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2;
  }
  initScene();
  bindEvents();
  initLiveCounter({ room: "news" });
  startClock();
  loadArticles();
}

init();
