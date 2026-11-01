/* VoltScope Finance controller: SEC snapshot lifecycle, filing stream, deep-dive chart, board. */

import {
  createDemoSnapshot,
  loadFinanceSnapshot,
  summarize,
  filingsFor,
  formatMoney,
  formatPercent,
  formatDate,
  relativeDay,
  sectorColor,
  fiscalYearLabel,
} from "./finance-data.js?v=20261101-3";
import { FinanceScene } from "./finance-scene.js?v=20261101-3";

const REFRESH_MS = 5 * 60 * 1000;
const $ = (id) => document.getElementById(id);

const state = {
  snapshot: null,
  companies: [],
  filings: [],
  selected: null,
  form: "all",
  sector: "",
  search: "",
  sortKey: "ticker",
  sortDir: 1,
  series: "annual",
  auto: true,
  theme: "dark",
  demo: false,
  loading: false,
  timer: 0,
  chartIndex: -1,
  chartPeriods: [],
  demoNoticeShown: false,
  scene: null,
  sceneMetric: "revenue",
};

let toastTimer = 0;

/* ---------- 3D scene ---------- */
function initScene() {
  const container = $("scene");
  if (!container) return;
  try {
    state.scene = new FinanceScene(container, {
      onHover: (company, event) => {
        if (!company) { hideTooltip(); return; }
        const tip = $("fin-tooltip");
        tip.textContent = '';
        const strong = document.createElement("strong");
        strong.textContent = `${company.ticker} · ${company.name}`;
        const price = document.createElement("div");
        price.className = "tt-price";
        price.textContent = metricLabel(company);
        const row = document.createElement("div");
        row.className = "tt-row";
        const sectorSpan = document.createElement("span");
        sectorSpan.textContent = company.sector;
        row.append(sectorSpan);
        tip.append(strong, price, row);
        tip.hidden = false;
        if (event) {
          tip.style.left = `${Math.min(window.innerWidth - 190, event.clientX + 12)}px`;
          tip.style.top = `${event.clientY + 12}px`;
        }
      },
      onSelect: (id) => {
        if (!id) { clearSelection(); return; }
        selectCompany(id, { focus: false });
      },
      onCamera: () => {},
    });
    const loading = $("scene-loading");
    if (loading) loading.classList.add("is-done");
  } catch (error) {
    console.warn("3D scene unavailable", error);
    const loading = $("scene-loading");
    if (loading) loading.classList.add("is-done");
    const fallback = $("scene-fallback");
    if (fallback) fallback.hidden = false;
  }
}

function hideTooltip() {
  const tip = $("fin-tooltip");
  if (tip) tip.hidden = true;
}

function metricLabel(company) {
  const latest = company.latest || {};
  const ratios = company.ratios || {};
  switch (state.sceneMetric) {
    case "net_income": return formatMoney(latest.net_income);
    case "net_margin": return `${formatPercent(ratios.net_margin)} margin`;
    case "return_on_equity": return `${formatPercent(ratios.return_on_equity)} ROE`;
    case "revenue_growth": return `${formatPercent(ratios.revenue_growth)} growth`;
    default: return formatMoney(latest.revenue);
  }
}

function syncLegend() {
  const el = $("legend-label");
  if (!el) return;
  const names = { revenue: 'Revenue', net_income: 'Net income', net_margin: 'Margin', return_on_equity: 'ROE', revenue_growth: 'Growth' };
  el.textContent = `Height: ${names[state.sceneMetric] || 'Revenue'} · colour: sector`;
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
    localStorage.setItem("voltscope-finance-theme", state.theme);
  } catch {
    /* Storage can be blocked; the theme still applies for this tab. */
  }
  drawChart();
}

function hideBoot() {
  const boot = $("boot");
  if (!boot || boot.classList.contains("is-done")) return;
  boot.classList.add("is-done");
  window.setTimeout(() => boot.remove(), 420);
}

/* ---------- Data lifecycle ---------- */

async function loadSnapshot({ silent = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  $("btn-refresh").classList.add("spinning");
  if (!state.snapshot && !silent) setStatus("loading", "Loading SEC snapshot…");

  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 15000);
    let snapshot;
    try {
      snapshot = await loadFinanceSnapshot({ signal: controller.signal });
    } finally {
      window.clearTimeout(timer);
    }
    state.snapshot = snapshot;
    state.demo = false;
  } catch (error) {
    console.warn("Finance snapshot unavailable", error);
    if (!state.snapshot) {
      state.snapshot = createDemoSnapshot();
      state.demo = true;
      if (!state.demoNoticeShown) {
        state.demoNoticeShown = true;
        showToast("Live SEC snapshot unavailable — showing demo filings.");
      }
    } else if (!silent) {
      showToast("Refresh failed. The last snapshot is still on screen.");
    }
  } finally {
    state.loading = false;
    $("btn-refresh").classList.remove("spinning");
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

/* ---------- Rendering ---------- */

function render() {
  if (!state.snapshot) return;
  state.companies = state.snapshot.companies;
  state.filings = state.snapshot.filings;

  const requested = new URLSearchParams(window.location.search).get("ticker")?.toUpperCase();
  if (requested && state.companies.some((company) => company.ticker === requested)) {
    state.selected = requested;
  } else if (state.selected && !state.companies.some((company) => company.ticker === state.selected)) {
    state.selected = null;
  } else if (!state.selected) {
    const summary = summarize(state.snapshot);
    state.selected = summary.sectors[0] ? pickLeadCompany() : state.companies[0]?.ticker || null;
  }

  renderKpis();
  renderFilings();
  renderSectors();
  renderTable();
  renderFocus();
  if (state.scene) {
    state.scene.setData(state.companies);
    state.scene.setSelected(state.selected);
  }
  syncLegend();
  renderStatus();
}

function pickLeadCompany() {
  const ranked = [...state.companies]
    .filter((company) => company.latest.revenue)
    .sort((a, b) => b.latest.revenue - a.latest.revenue);
  return (ranked[0] || state.companies[0])?.ticker || null;
}

function renderStatus() {
  const meta = state.snapshot.meta || {};
  const latest = meta.latest_filed;
  if (state.demo) {
    setStatus("demo", "Demo snapshot", "no live export yet");
    $("pulse-note").textContent = "demo";
    $("source-note").textContent = "Demo data. Run the SEC exporter to replace it with live filings.";
  } else {
    setStatus("live", "Live SEC snapshot", `${state.companies.length} filers · filed ${latest ?? "—"} (${latest ? relativeDay(latest) : ""})`);
    $("pulse-note").textContent = latest ? `filed ${relativeDay(latest)}` : "SEC EDGAR";
    $("source-note").textContent = meta.source_note ? String(meta.source_note) : "";
  }
}

function renderKpis() {
  const summary = summarize(state.snapshot);
  $("kpi-companies").textContent = String(state.companies.length);
  $("kpi-companies-sub").textContent = `${summary.reporting} report revenue`;
  $("kpi-filings").textContent = String(state.filings.length);
  $("kpi-filings-sub").textContent = `${countForm("10-K")} annual · ${countForm("10-Q")} quarterly`;
  $("kpi-revenue").textContent = formatMoney(summary.totalRevenue);
  $("kpi-revenue-sub").textContent = "sum of latest fiscal years";
  $("kpi-margin").textContent = formatPercent(summary.averageMargin);
  $("kpi-margin-sub").textContent = "net income / revenue";
  $("kpi-margin").className = (summary.averageMargin || 0) >= 0 ? "up" : "down";
  const metaAsOf = state.snapshot.meta || {};
  const asOfDate = metaAsOf.latest_filed || metaAsOf.generated_at || "";
  $("snapshot-asof").textContent = asOfDate ? `As of ${asOfDate}` : "";
}

function countForm(form) {
  return state.snapshot?.meta?.form_counts?.[form] || 0;
}

function renderFilings() {
  const list = $("filing-list");
  list.textContent = "";
  const rows = state.form === "all" ? state.filings : state.filings.filter((filing) => filing.form === state.form);
  const visible = rows.slice(0, 14);
  $("filing-note").textContent = `${rows.length} shown of ${state.filings.length}`;
  $("filing-empty").hidden = rows.length > 0;

  for (const filing of visible) {
    const item = document.createElement("li");
    item.append(...filingButton(filing));
    list.append(item);
  }
}

function filingButton(filing, { compact = false } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "filing-item";
  if (filing.ticker === state.selected) button.classList.add("is-active");
  button.dataset.ticker = filing.ticker;

  const badge = document.createElement("span");
  badge.className = `form-badge form-${filing.form.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  badge.textContent = filing.form;

  const main = document.createElement("span");
  main.className = "filing-main";
  const strong = document.createElement("strong");
  strong.textContent = `${filing.ticker} · ${companyName(filing.ticker)}`;
  const small = document.createElement("small");
  small.textContent = filing.items ? `Period ${filing.period || "—"} · Items ${filing.items}` : `Period ${filing.period || "—"}`;
  main.append(strong, small);

  const date = document.createElement("span");
  date.className = "filing-date";
  date.textContent = formatDate(filing.filed);

  button.append(badge, main, date);
  button.addEventListener("click", () => selectCompany(filing.ticker, { focus: true }));

  if (compact) {
    const link = document.createElement("a");
    link.className = "fin-sec-link";
    link.href = filing.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = `Open ${filing.form} on sec.gov`;
    link.setAttribute("aria-label", `Open ${filing.form} for ${filing.ticker} on sec.gov`);
    link.innerHTML =
      '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
    link.addEventListener("click", (event) => event.stopPropagation());
    return [button, link];
  }
  return [button];
}

function companyName(ticker) {
  return state.companies.find((company) => company.ticker === ticker)?.name || ticker;
}

function renderSectors() {
  const summary = summarize(state.snapshot);
  const total = summary.sectors.reduce((sum, entry) => sum + entry.revenue, 0) || 1;
  const list = $("sector-list");
  list.textContent = "";
  for (const entry of summary.sectors) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sector-item";
    button.dataset.sector = entry.sector;
    if (state.sector === entry.sector) button.classList.add("is-active");

    const row = document.createElement("div");
    row.className = "sector-row";
    const name = document.createElement("strong");
    name.textContent = entry.sector;
    const value = document.createElement("span");
    const share = entry.revenue / total;
    value.textContent = entry.count === 1 ? `1 filer · ${formatPercent(share, 0, false)}` : `${entry.count} filers · ${formatPercent(share, 0, false)}`;
    row.append(name, value);

    const bar = document.createElement("span");
    bar.className = "sector-bar";
    const fill = document.createElement("i");
    fill.style.width = `${Math.max(3, Math.round(share * 100))}%`;
    fill.style.background = sectorColor(entry.sector);
    bar.append(fill);

    button.append(row, bar);
    button.addEventListener("click", () => {
      state.sector = state.sector === entry.sector ? "" : entry.sector;
      renderSectors();
      renderTable();
    });
    item.append(button);
    list.append(item);
  }
}

function filteredCompanies() {
  const query = state.search.trim().toLowerCase();
  let companies = state.companies.filter((company) => {
    if (state.sector && company.sector !== state.sector) return false;
    if (state.form !== "all" && !state.filings.some((filing) => filing.ticker === company.ticker && filing.form === state.form)) {
      return false;
    }
    if (!query) return true;
    return `${company.ticker} ${company.name} ${company.sector} ${company.sic_description}`.toLowerCase().includes(query);
  });
  const asc = state.sortDir;
  companies = companies.slice().sort((a, b) => {
    const key = state.sortKey;
    if (key === "ticker" || key === "sector") {
      const result = String(a[key]).localeCompare(String(b[key]));
      return (result || a.ticker.localeCompare(b.ticker)) * asc;
    }
    if (key === "filed") {
      const av = latestFiling(a.ticker)?.filed || "";
      const bv = latestFiling(b.ticker)?.filed || "";
      return av.localeCompare(bv) * asc || a.ticker.localeCompare(b.ticker);
    }
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    return (av - bv) * asc || a.ticker.localeCompare(b.ticker);
  });
  return companies;
}

function sortValue(company, key) {
  if (key === "revenue") return Number(company.latest.revenue) || -Infinity;
  if (key === "net_income") return Number(company.latest.net_income) || -Infinity;
  if (key === "net_margin") return company.ratios.net_margin ?? -Infinity;
  if (key === "return_on_equity") return company.ratios.return_on_equity ?? -Infinity;
  if (key === "revenue_growth") return company.ratios.revenue_growth ?? -Infinity;
  return 0;
}

function latestFiling(ticker) {
  return state.filings.find((filing) => filing.ticker === ticker) || null;
}

function renderTable() {
  const rows = $("company-rows");
  rows.textContent = "";
  const companies = filteredCompanies();
  const fragment = document.createDocumentFragment();

  for (const company of companies) {
    const tr = document.createElement("tr");
    tr.dataset.ticker = company.ticker;
    tr.tabIndex = 0;
    if (company.ticker === state.selected) tr.classList.add("is-selected");
    tr.setAttribute("aria-selected", String(company.ticker === state.selected));

    const companyCell = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.className = "company-cell";
    const avatar = document.createElement("span");
    avatar.className = "coin-avatar";
    avatar.style.color = sectorColor(company.sector);
    avatar.textContent = company.ticker.slice(0, 2);
    const names = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = company.name;
    const small = document.createElement("small");
    small.textContent = `${company.ticker} · CIK ${company.cik}`;
    names.append(strong, small);
    wrap.append(avatar, names);
    companyCell.append(wrap);

    const sectorCell = document.createElement("td");
    sectorCell.className = "hide-sm";
    const chip = document.createElement("span");
    chip.className = "sector-chip";
    chip.style.color = sectorColor(company.sector);
    const dot = document.createElement("i");
    const label = document.createElement("span");
    label.textContent = company.sector;
    chip.append(dot, label);
    sectorCell.append(chip);

    const revenue = cell("num", formatMoney(company.latest.revenue));
    const income = cell("num", formatMoney(company.latest.net_income));
    income.style.color = Number(company.latest.net_income) < 0 ? "var(--down)" : "";
    const margin = cell("num", formatPercent(company.ratios.net_margin));
    margin.style.color = ratioColor(company.ratios.net_margin);
    const roe = cell("num hide-sm", formatPercent(company.ratios.return_on_equity));
    roe.style.color = ratioColor(company.ratios.return_on_equity);
    const growth = cell("num hide-sm", formatPercent(company.ratios.revenue_growth));
    growth.style.color = ratioColor(company.ratios.revenue_growth);

    const filed = document.createElement("td");
    filed.className = "filed-cell hide-sm";
    const latest = latestFiling(company.ticker);
    if (latest) {
      const date = document.createElement("span");
      date.textContent = formatDate(latest.filed);
      const badge = document.createElement("span");
      badge.className = `form-badge form-${latest.form.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      badge.textContent = latest.form;
      filed.append(date, badge);
    } else {
      filed.textContent = "—";
    }

    tr.append(companyCell, sectorCell, revenue, income, margin, roe, growth, filed);
    tr.addEventListener("click", () => selectCompany(company.ticker, { focus: true }));
    tr.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectCompany(company.ticker, { focus: true });
      }
    });
    fragment.append(tr);
  }

  rows.append(fragment);
  $("empty-state").hidden = companies.length > 0;
  $("btn-clear-filters").hidden = !state.search && !state.sector && state.form === "all";
  $("board-count").textContent = `${companies.length} of ${state.companies.length} filers · ${state.demo ? "demo" : "live"} snapshot`;

  for (const button of document.querySelectorAll("#company-table th button")) {
    const th = button.closest("th");
    if (button.dataset.sort === state.sortKey) {
      th.setAttribute("aria-sort", state.sortDir === 1 ? "ascending" : "descending");
    } else {
      th.removeAttribute("aria-sort");
    }
  }
}

function cell(className, text) {
  const td = document.createElement("td");
  td.className = className;
  td.textContent = text;
  return td;
}

function ratioColor(value) {
  if (!Number.isFinite(value)) return "";
  return value > 0 ? "var(--up)" : value < 0 ? "var(--down)" : "";
}

function renderFocus() {
  const company = state.companies.find((item) => item.ticker === state.selected);
  const facts = $("focus-facts");
  facts.textContent = "";
  if (!company) {
    $("focus-ticker").textContent = "—";
    $("focus-name").textContent = "Select a company";
    $("focus-sub").textContent = "Pick a filing, a board row, or a sector.";
    $("focus-link").href = "https://www.sec.gov/edgar/search/";
    $("focus-filings").textContent = "";
    $("focus-filings-note").textContent = "—";
    $("chart-note").textContent = "—";
    drawChart();
    return;
  }

  const avatar = $("focus-ticker");
  avatar.textContent = company.ticker;
  avatar.style.color = sectorColor(company.sector);
  $("focus-name").textContent = company.name;
  const sub = [company.sector, company.exchange, `CIK ${company.cik}`].filter((part) => part && part !== "—");
  $("focus-sub").textContent = sub.join(" · ");
  $("focus-link").href = company.filings_url;

  const year = fiscalYearLabel(company);
  const latest = company.latest;
  const rows = [
    ["Revenue", formatMoney(latest.revenue), year],
    ["Net income", formatMoney(latest.net_income), formatPercent(company.ratios.net_margin) + " margin"],
    ["Net margin", formatPercent(company.ratios.net_margin), "net income / revenue"],
    ["Return on equity", formatPercent(company.ratios.return_on_equity), "net income / equity"],
    ["Total assets", formatMoney(latest.assets), "balance sheet"],
    ["Shareholders' equity", formatMoney(latest.equity), "book value"],
    ["Diluted EPS", formatMoney(latest.eps, { perShare: true }), "per share"],
    ["Operating cash flow", formatMoney(latest.operating_cash_flow), year],
  ];
  for (const [label, value, subline] of rows) {
    const wrap = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    if (label === "Net income" || label === "Operating cash flow") {
      const numeric = label === "Net income" ? latest.net_income : latest.operating_cash_flow;
      if (Number(numeric) < 0) dd.className = "down";
      else if (Number(numeric) > 0) dd.className = "up";
    }
    const small = document.createElement("span");
    small.className = "fact-sub";
    small.textContent = subline;
    wrap.append(dt, dd, small);
    facts.append(wrap);
  }

  const filings = filingsFor(state.snapshot, company.ticker);
  const list = $("focus-filings");
  list.textContent = "";
  for (const filing of filings.slice(0, 5)) {
    const item = document.createElement("li");
    item.append(...filingButton(filing, { compact: true }));
    list.append(item);
  }
  if (!filings.length) {
    const item = document.createElement("li");
    item.className = "trending-empty";
    item.textContent = "No filings in this snapshot.";
    list.append(item);
  }
  $("focus-filings-note").textContent = `${filings.length} on file`;
  $("chart-note").textContent = state.series === "annual" ? `${year} · USD` : "latest quarters · USD";
  drawChart();
}

/* ---------- Chart ---------- */

function chartSeries(company) {
  if (!company) return [];
  if (state.series === "quarterly") {
    const revenue = new Map(company.quarterly_revenue || []);
    const income = new Map(company.quarterly_net_income || []);
    const labels = [...new Set([...revenue.keys(), ...income.keys()])].sort();
    return labels.map((label) => ({
      label: shortDate(label),
      full: formatDate(label),
      revenue: revenue.get(label) ?? null,
      income: income.get(label) ?? null,
    }));
  }
  const revenue = new Map(company.series.revenue || []);
  const income = new Map(company.series.net_income || []);
  const labels = [...new Set([...revenue.keys(), ...income.keys()])].sort((a, b) => a - b);
  return labels.map((label) => ({
    label: String(label),
    full: `FY${label}`,
    revenue: revenue.get(label) ?? null,
    income: income.get(label) ?? null,
  }));
}

function shortDate(value) {
  const parsed = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" });
}

function drawChart() {
  const canvas = $("fin-chart");
  if (!canvas || canvas.offsetParent === null) return;
  const company = state.companies.find((item) => item.ticker === state.selected);
  const periods = chartSeries(company);
  state.chartPeriods = periods;

  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  if (!periods.length) {
    const styles = getComputedStyle(document.documentElement);
    context.fillStyle = styles.getPropertyValue("--faint").trim() || "#64798f";
    context.font = "12px 'Segoe UI', system-ui, sans-serif";
    context.textAlign = "center";
    context.fillText(
      company ? "No XBRL facts for this filer yet" : "Select a company to load its financial history",
      rect.width / 2,
      rect.height / 2,
    );
    canvas.setAttribute("aria-label", company ? "No annual financial facts for this company" : "No company selected");
    return;
  }

  const styles = getComputedStyle(document.documentElement);
  const muted = styles.getPropertyValue("--faint").trim() || "#64798f";
  const grid = styles.getPropertyValue("--fin-grid").trim() || "rgba(214,178,112,0.14)";
  const revenueColor = styles.getPropertyValue("--fin-revenue").trim() || "#ffc45c";
  const incomeColor = styles.getPropertyValue("--fin-income").trim() || "#5ee0b0";

  const pad = { left: 54, right: 12, top: 14, bottom: 26 };
  const plotW = Math.max(1, rect.width - pad.left - pad.right);
  const plotH = Math.max(1, rect.height - pad.top - pad.bottom);
  const values = periods.flatMap((period) => [period.revenue, period.income]).filter((value) => Number.isFinite(value));
  let max = Math.max(0, ...values);
  let min = Math.min(0, ...values);
  if (max === min) max = min + 1;
  const headroom = (max - min) * 0.12;
  max += headroom;
  if (min < 0) min -= headroom;
  const yOf = (value) => pad.top + (1 - (value - min) / (max - min)) * plotH;
  const baseline = yOf(0);

  context.strokeStyle = grid;
  context.lineWidth = 1;
  context.font = "10px 'Cascadia Code', monospace";
  context.fillStyle = muted;
  context.textAlign = "right";
  for (let tick = 0; tick <= 3; tick += 1) {
    const value = min + ((max - min) / 3) * tick;
    const y = yOf(value);
    context.beginPath();
    context.moveTo(pad.left, y);
    context.lineTo(rect.width - pad.right, y);
    context.stroke();
    context.fillText(formatMoney(value), pad.left - 7, y + 3);
  }

  const slot = plotW / periods.length;
  const barW = Math.max(3, Math.min(20, slot * 0.32));
  periods.forEach((period, index) => {
    const center = pad.left + slot * (index + 0.5);
    for (const [value, color, offset] of [
      [period.revenue, revenueColor, -barW * 0.56],
      [period.income, incomeColor, barW * 0.56],
    ]) {
      if (!Number.isFinite(value)) continue;
      const y = yOf(value);
      const top = Math.min(y, baseline);
      const height = Math.max(2, Math.abs(y - baseline));
      const x = center + offset - barW / 2;
      context.fillStyle = color;
      context.globalAlpha = index === state.chartIndex ? 1 : 0.78;
      if (height <= 2.5) {
        context.fillRect(x, y - 1, barW, 2.5);
      } else {
        context.fillRect(x, top, barW, height);
      }
    }
    context.globalAlpha = 1;
    context.fillStyle = muted;
    context.textAlign = "center";
    const stride = Math.ceil(periods.length / Math.max(3, Math.floor(plotW / 46)));
    if (index % stride === 0 || index === periods.length - 1) {
      context.fillText(period.label, center, rect.height - 9);
    }
  });

  if (state.chartIndex >= 0 && state.chartIndex < periods.length) {
    const period = periods[state.chartIndex];
    const center = pad.left + slot * (state.chartIndex + 0.5);
    context.strokeStyle = "rgba(180, 150, 90, 0.5)";
    context.beginPath();
    context.moveTo(center, pad.top);
    context.lineTo(center, rect.height - pad.bottom);
    context.stroke();
    $("chart-hint").textContent = `${period.full} · revenue ${formatMoney(period.revenue)} · net income ${formatMoney(period.income)}`;
  } else {
    $("chart-hint").textContent = "Hover the chart to read a period.";
  }

  const last = periods[periods.length - 1];
  canvas.setAttribute(
    "aria-label",
    `${company?.name || "Company"} revenue and net income, ${periods.length} periods. Latest ${last.full}: revenue ${formatMoney(last.revenue)}, net income ${formatMoney(last.income)}`,
  );
}

function chartPointer(event) {
  const canvas = $("fin-chart");
  const periods = state.chartPeriods;
  if (!periods.length) return;
  const rect = canvas.getBoundingClientRect();
  const pad = { left: 54, right: 12 };
  const plotW = Math.max(1, rect.width - pad.left - pad.right);
  const slot = plotW / periods.length;
  const index = Math.floor((event.clientX - rect.left - pad.left) / slot);
  state.chartIndex = Math.min(periods.length - 1, Math.max(0, index));
  drawChart();
  canvas.style.cursor = "crosshair";
}

/* ---------- Selection and filters ---------- */

function selectCompany(ticker, { focus = false } = {}) {
  const company = state.companies.find((item) => item.ticker === ticker);
  if (!company) return;
  state.selected = ticker;
  state.chartIndex = -1;
  renderFilings();
  renderTable();
  renderFocus();
  const url = new URL(window.location.href);
  url.searchParams.set("ticker", ticker);
  window.history.replaceState(null, "", url);
  if (focus) $("focus-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function clearSelection() {
  state.selected = null;
  state.chartIndex = -1;
  renderFilings();
  renderTable();
  renderFocus();
  const url = new URL(window.location.href);
  url.searchParams.delete("ticker");
  window.history.replaceState(null, "", url);
}

function resetFilters() {
  state.search = "";
  state.sector = "";
  state.form = "all";
  $("fin-search").value = "";
  for (const button of document.querySelectorAll("#form-group button")) {
    button.classList.toggle("is-active", button.dataset.form === "all");
  }
  renderFilings();
  renderSectors();
  renderTable();
}

/* ---------- Events ---------- */

function bindEvents() {
  $("btn-theme").addEventListener("click", () => applyTheme(state.theme === "dark" ? "light" : "dark"));
  $("btn-refresh").addEventListener("click", () => loadSnapshot());

  $("btn-auto").addEventListener("click", () => {
    state.auto = !state.auto;
    $("btn-auto").setAttribute("aria-pressed", String(state.auto));
    if (state.auto) {
      startTimer();
      showToast("Auto refresh on · every 5 minutes");
    } else {
      stopTimer();
      showToast("Auto refresh off");
    }
  });

  $("btn-share").addEventListener("click", async () => {
    const url = new URL(window.location.href);
    if (state.selected) url.searchParams.set("ticker", state.selected);
    try {
      await navigator.clipboard.writeText(url.toString());
      showToast("Link copied to clipboard");
    } catch {
      showToast(url.toString());
    }
  });

  $("btn-help").addEventListener("click", () => $("help-dialog").showModal());
  const metricGroup = $("metric-group");
  if (metricGroup) {
    metricGroup.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-metric]");
      if (!button) return;
      state.sceneMetric = button.dataset.metric;
      for (const item of metricGroup.querySelectorAll("button")) item.classList.toggle("is-active", item === button);
      state.scene?.setMetric(state.sceneMetric);
      syncLegend();
    });
  }

  const camTools = document.querySelector(".camera-tools");
  if (camTools) {
    camTools.addEventListener("click", (event) => {
      const camButton = event.target.closest("button[data-cam]");
      if (camButton) {
        for (const item of camTools.querySelectorAll("button[data-cam]")) item.classList.toggle("is-active", item === camButton);
        state.scene?.cameraPreset(camButton.dataset.cam);
        return;
      }
      if (event.target.closest("#btn-spin")) {
        const spin = $("btn-spin");
        const next = !state.scene?.controls.autoRotate;
        state.scene?.setAutoRotate(next);
        spin?.setAttribute("aria-pressed", String(Boolean(next)));
      }
    });
  }


  $("form-group").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-form]");
    if (!button) return;
    state.form = button.dataset.form;
    for (const item of document.querySelectorAll("#form-group button")) {
      item.classList.toggle("is-active", item === button);
    }
    renderFilings();
    renderTable();
  });

  $("series-group").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-series]");
    if (!button) return;
    state.series = button.dataset.series;
    state.chartIndex = -1;
    for (const item of document.querySelectorAll("#series-group button")) {
      item.classList.toggle("is-active", item === button);
    }
    const company = state.companies.find((item) => item.ticker === state.selected);
    $("chart-note").textContent = state.series === "annual" ? `${company ? fiscalYearLabel(company) : ""} · USD` : "latest quarters · USD";
    drawChart();
  });

  $("fin-search").addEventListener("input", (event) => {
    state.search = event.target.value;
    renderTable();
  });

  $("company-table").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-sort]");
    if (!button) return;
    const key = button.dataset.sort;
    if (state.sortKey === key) {
      state.sortDir *= -1;
    } else {
      state.sortKey = key;
      state.sortDir = key === "ticker" || key === "sector" ? 1 : -1;
    }
    renderTable();
  });

  $("btn-empty-reset").addEventListener("click", resetFilters);
  $("btn-clear-filters").addEventListener("click", resetFilters);

  $("fin-chart").addEventListener("pointermove", chartPointer);
  $("fin-chart").addEventListener("pointerleave", () => {
    state.chartIndex = -1;
    drawChart();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.auto && state.snapshot) {
      const latest = state.snapshot.meta?.latest_filed ? Date.parse(state.snapshot.meta.latest_filed) : 0;
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
      $("fin-search").focus();
      $("fin-search").select();
    } else if (event.key === "r" || event.key === "R") {
      loadSnapshot();
    } else if (event.key === "l" || event.key === "L") {
      $("btn-auto").click();
    } else if (event.key === "t" || event.key === "T") {
      $("btn-theme").click();
    } else if (event.key === "?") {
      dialog.showModal();
    }
  });

  window.addEventListener("resize", () => drawChart());
}

function init() {
  let saved = "dark";
  try {
    saved = localStorage.getItem("voltscope-finance-theme") || "dark";
  } catch {
    saved = "dark";
  }
  applyTheme(saved);
  initScene();
  bindEvents();
  loadSnapshot();
}

init();
