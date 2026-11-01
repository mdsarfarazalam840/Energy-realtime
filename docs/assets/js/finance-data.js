/* Finance dashboard data layer: SEC EDGAR snapshot loading, demo fallback, formatting. */

export const DATA_URL = "data/finance.json";
export const SCHEMA_VERSION = 1;

const DEMO_COMPANIES = [
  {
    ticker: "AAPL",
    name: "Apple Inc.",
    sector: "Technology",
    sic_description: "Electronic Computers",
    revenue: [265595, 260174, 274515, 365817, 394328, 383285, 391035, 416161],
    net_income: [59531, 55256, 57411, 94680, 99803, 96995, 93736, 112010],
    assets: [365725, 338516, 323888, 351002, 352755, 352583, 364980, 359241],
    equity: [107147, 90488, 65339, 63090, 50672, 62146, 56950, 73733],
    eps: [2.98, 2.97, 3.28, 5.61, 6.11, 6.13, 6.08, 7.46],
    ocf: [77434, 69010, 80674, 104038, 122151, 110543, 118254, 111482],
  },
  {
    ticker: "MSFT",
    name: "Microsoft Corp.",
    sector: "Technology",
    sic_description: "Services-Prepackaged Software",
    revenue: [125843, 143015, 168088, 198270, 211915, 245122, 281724, 331839],
    net_income: [39240, 44281, 61271, 72738, 72361, 88136, 101832, 133749],
    assets: [286556, 301311, 333779, 364840, 411976, 512163, 619003, 758400],
    equity: [118304, 118304, 141988, 166542, 206223, 268477, 343479, 442400],
    eps: [5.06, 5.76, 8.05, 9.65, 9.68, 11.8, 13.64, 17.9],
    ocf: [52185, 60675, 76740, 89035, 87582, 118548, 136162, 182900],
  },
  {
    ticker: "NVDA",
    name: "NVIDIA Corp.",
    sector: "Technology",
    sic_description: "Semiconductors",
    revenue: [11716, 10918, 16675, 26914, 26974, 60922, 130497, 213000],
    net_income: [4141, 2796, 4332, 9752, 4368, 29760, 72880, 118500],
    assets: [13292, 17315, 28791, 44187, 44187, 65728, 96800, 148000],
    equity: [9136, 12204, 16893, 26612, 22101, 42978, 70000, 108000],
    eps: [1.66, 1.13, 1.74, 3.85, 1.74, 11.93, 29.76, 47.4],
    ocf: [4695, 5822, 6416, 9108, 5641, 28090, 64800, 96000],
  },
  {
    ticker: "JPM",
    name: "JPMorgan Chase & Co.",
    sector: "Financials",
    sic_description: "National Commercial Banks",
    revenue: [118667, 122625, 121648, 121786, 128695, 158104, 179000, 183000],
    net_income: [32474, 29131, 36431, 48334, 37676, 49552, 58500, 61200],
    assets: [2651251, 2914341, 3387378, 3744245, 3665743, 3875393, 4000000, 4200000],
    equity: [266659, 281044, 299131, 317369, 292332, 327878, 345000, 365000],
    eps: [10.71, 9.58, 11.87, 16.41, 12.09, 15.94, 19.75, 21.4],
    ocf: [32259, 94392, 82753, 94494, 61064, 132000, 120000, 130000],
  },
  {
    ticker: "JNJ",
    name: "Johnson & Johnson",
    sector: "Healthcare",
    sic_description: "Pharmaceutical Preparations",
    revenue: [81581, 82059, 82584, 93775, 94943, 88890, 88820, 90500],
    net_income: [15297, 15119, 14714, 20878, 17941, 35153, 14060, 16800],
    assets: [152954, 157728, 174894, 182018, 187378, 167000, 175000, 180000],
    equity: [59471, 63403, 63403, 63350, 76804, 70400, 74000, 78000],
    eps: [5.61, 5.63, 5.51, 7.81, 6.73, 13.2, 5.45, 6.6],
    ocf: [22462, 23536, 23624, 24598, 24364, 28400, 24200, 25500],
  },
  {
    ticker: "XOM",
    name: "Exxon Mobil Corp.",
    sector: "Energy",
    sic_description: "Petroleum Refining",
    revenue: [290212, 264938, 181502, 285640, 413680, 344582, 339247, 332238],
    net_income: [20840, 14840, -22440, 23040, 55740, 36010, 33680, 28800],
    assets: [346196, 362597, 332750, 338923, 369067, 376317, 453475, 448980],
    equity: [191650, 191650, 174937, 181927, 195049, 204802, 263700, 259300],
    eps: [4.88, 3.36, -5.25, 5.39, 13.26, 8.89, 7.84, 6.4],
    ocf: [29725, 14668, 12308, 48600, 76700, 55370, 55000, 52000],
  },
  {
    ticker: "WMT",
    name: "Walmart Inc.",
    sector: "Retail",
    sic_description: "Variety Stores",
    revenue: [510329, 519926, 555233, 567762, 605881, 642637, 674538, 706413],
    net_income: [6670, 14881, 13510, 13673, 11680, 15511, 19436, 21900],
    assets: [219295, 236495, 252496, 244860, 243197, 252399, 260823, 284700],
    equity: [72896, 74669, 80925, 82821, 76449, 83861, 91013, 99600],
    eps: [2.28, 5.19, 4.75, 4.87, 4.27, 5.74, 7.06, 7.8],
    ocf: [27753, 25325, 36074, 24181, 28841, 35826, 36200, 41600],
  },
  {
    ticker: "TSLA",
    name: "Tesla, Inc.",
    sector: "Manufacturing",
    sic_description: "Motor Vehicles & Passenger Car Bodies",
    revenue: [21461, 24578, 31536, 53823, 81462, 96773, 97690, 101500],
    net_income: [-976, -862, 721, 5519, 12556, 14997, 7091, 8400],
    assets: [29740, 34309, 52148, 62131, 82338, 106618, 118000, 130000],
    equity: [4792, 6344, 22225, 30219, 44704, 62634, 68000, 75000],
    eps: [-0.98, -0.85, 0.74, 5.6, 12.3, 15.3, 7.0, 8.1],
    ocf: [2098, 2394, 6040, 11497, 14724, 13256, 14900, 15200],
  },
  {
    ticker: "V",
    name: "Visa Inc.",
    sector: "Services",
    sic_description: "Services-Business Services",
    revenue: [20609, 22977, 21846, 24105, 29310, 32653, 35926, 38900],
    net_income: [10301, 12080, 10736, 12311, 14957, 17273, 19743, 21100],
    assets: [69725, 72631, 80396, 82896, 85297, 90499, 95000, 99000],
    equity: [34548, 34626, 35322, 37471, 38050, 38740, 41000, 43000],
    eps: [4.42, 5.22, 4.66, 5.63, 7.0, 8.28, 9.73, 10.6],
    ocf: [12779, 12377, 15754, 15975, 20000, 20600, 21000, 22000],
  },
  {
    ticker: "UNH",
    name: "UnitedHealth Group Inc.",
    sector: "Healthcare",
    sic_description: "Hospital & Medical Service Plans",
    revenue: [226247, 257141, 287597, 324162, 371622, 400278, 410000, 425000],
    net_income: [11986, 13839, 15403, 17285, 20120, 22381, 14405, 15600],
    assets: [152221, 197289, 212206, 245705, 273720, 298278, 310000, 325000],
    equity: [57020, 63182, 69783, 77528, 86784, 95200, 98000, 104000],
    eps: [12.4, 14.33, 15.77, 17.92, 21.18, 23.86, 15.5, 16.8],
    ocf: [15862, 20073, 22304, 24076, 27816, 29000, 26000, 27500],
  },
];

const DEMO_FILING_FORMS = ["10-K", "10-Q", "8-K", "DEF 14A"];

function demoFilings(company, index) {
  const base = new Date("2026-10-30T00:00:00Z").getTime();
  const forms = [DEMO_FILING_FORMS[index % 4], "10-Q", "8-K", "8-K", "10-K"];
  return forms.map((form, offset) => {
    const filed = new Date(base - (offset * 21 + index * 2) * 86400000).toISOString().slice(0, 10);
    const accession = `0000000${index + 1}-26-00000${offset}`;
    return {
      ticker: company.ticker,
      cik: String(index + 1).padStart(10, "0"),
      form,
      filed,
      period: filed,
      accession,
      document: `${company.ticker.toLowerCase()}-${filed}.htm`,
      items: form === "8-K" ? "2.02,9.01" : "",
      url: "https://www.sec.gov/edgar/search/",
    };
  });
}

function seriesFrom(values, firstYear = 2018) {
  return values.map((value, index) => [firstYear + index, value * 1e6]);
}

export function createDemoSnapshot() {
  const companies = DEMO_COMPANIES.map((entry, index) => {
    const revenue = seriesFrom(entry.revenue);
    const netIncome = seriesFrom(entry.net_income);
    const assets = seriesFrom(entry.assets);
    const equity = seriesFrom(entry.equity);
    const latest = (rows) => (rows.length ? rows[rows.length - 1][1] : null);
    return {
      ticker: entry.ticker,
      cik: String(index + 1).padStart(10, "0"),
      name: entry.name,
      exchange: "Nasdaq",
      sector: entry.sector,
      sic: "",
      sic_description: entry.sic_description,
      state: "DE",
      fiscal_year_end: "1231",
      fiscal_year: revenue[revenue.length - 1][0],
      filings_url: "https://www.sec.gov/edgar/search/",
      series: {
        revenue,
        net_income: netIncome,
        assets,
        equity,
        eps: seriesFrom(entry.eps),
        cash: [],
        liabilities: [],
        operating_cash_flow: seriesFrom(entry.ocf),
      },
      latest: {
        revenue: latest(revenue),
        net_income: latest(netIncome),
        assets: latest(assets),
        equity: latest(equity),
        eps: Number(entry.eps[entry.eps.length - 1]),
        operating_cash_flow: latest(seriesFrom(entry.ocf)),
        cash: null,
        liabilities: null,
      },
      ratios: {
        net_margin: latest(netIncome) / latest(revenue),
        return_on_equity: latest(netIncome) / latest(equity),
        liability_ratio: null,
        revenue_growth: revenue[revenue.length - 1][1] / revenue[revenue.length - 2][1] - 1,
      },
      quarterly_revenue: [],
      quarterly_net_income: [],
    };
  });
  const filings = DEMO_COMPANIES.flatMap(demoFilings).sort((a, b) => b.filed.localeCompare(a.filed));
  return buildSnapshot(companies, filings, { demo: true });
}

export function buildSnapshot(companies, filings, { demo = false, meta = {} } = {}) {
  const formCounts = {};
  for (const filing of filings) formCounts[filing.form] = (formCounts[filing.form] || 0) + 1;
  return {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    mode: demo ? "demo" : "live",
    meta: {
      source: "sec-edgar",
      currency: "USD",
      company_count: companies.length,
      filing_count: filings.length,
      form_counts: formCounts,
      sectors: [...new Set(companies.map((company) => company.sector))].sort(),
      latest_filed: filings.reduce((max, filing) => (filing.filed > max ? filing.filed : max), ""),
      archive: "https://www.sec.gov/edgar/search/",
      ...meta,
    },
    companies,
    filings,
    demo,
  };
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanSeries(raw, numericLabel = false) {
  if (!Array.isArray(raw)) return [];
  const rows = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const value = nullableNumber(row[1]);
    if (value === null) continue;
    const label = numericLabel ? Math.round(finite(row[0])) : String(row[0]);
    rows.push([label, value]);
  }
  if (numericLabel) rows.sort((a, b) => a[0] - b[0]);
  else rows.sort((a, b) => a[0].localeCompare(b[0]));
  return rows;
}

function cleanSeriesMap(raw) {
  const series = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return series;
  for (const [name, rows] of Object.entries(raw)) {
    const cleaned = cleanSeries(rows, name !== "quarterly_revenue" && name !== "quarterly_net_income");
    if (cleaned.length) series[name] = cleaned;
  }
  return series;
}

function cleanCompany(raw) {
  const ticker = String(raw?.ticker || "").trim().toUpperCase();
  if (!ticker) return null;
  const series = cleanSeriesMap(raw.series);
  const latest = {};
  for (const key of [
    "revenue",
    "net_income",
    "assets",
    "liabilities",
    "equity",
    "eps",
    "cash",
    "operating_cash_flow",
  ]) {
    const rows = series[key] || [];
    latest[key] = rows.length ? Number(rows[rows.length - 1][1]) : nullableNumber(raw.latest?.[key]);
  }
  const ratios = {};
  for (const key of ["net_margin", "return_on_equity", "liability_ratio", "revenue_growth"]) {
    ratios[key] = nullableNumber(raw.ratios?.[key]);
  }
  return {
    ticker,
    cik: String(raw.cik || "").padStart(10, "0"),
    name: displayName(String(raw.name || ticker)),
    exchange: [...new Set(String(raw.exchange || "").split(",").map((part) => part.trim()).filter(Boolean))].join(", "),
    sector: String(raw.sector || "Unclassified"),
    sic: String(raw.sic || ""),
    sic_description: String(raw.sic_description || ""),
    state: String(raw.state || ""),
    fiscal_year_end: String(raw.fiscal_year_end || ""),
    fiscal_year: Number(raw.fiscal_year) || null,
    filings_url: String(raw.filings_url || "https://www.sec.gov/edgar/search/"),
    series,
    latest,
    ratios,
    quarterly_revenue: cleanSeries(raw.quarterly_revenue),
    quarterly_net_income: cleanSeries(raw.quarterly_net_income),
  };
}

function cleanFiling(raw) {
  const ticker = String(raw?.ticker || "").trim().toUpperCase();
  const form = String(raw?.form || "").trim();
  if (!ticker || !form) return null;
  return {
    ticker,
    cik: String(raw.cik || ""),
    form,
    filed: String(raw.filed || ""),
    period: String(raw.period || ""),
    accession: String(raw.accession || ""),
    document: String(raw.document || ""),
    items: String(raw.items || ""),
    url: String(raw.url || "https://www.sec.gov/edgar/search/"),
  };
}

export function normalizeSnapshot(doc) {
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.companies)) {
    throw new Error("Finance snapshot has no companies array");
  }
  const companies = doc.companies.map(cleanCompany).filter(Boolean);
  if (!companies.length) throw new Error("Finance snapshot has no usable companies");
  const tickers = new Set(companies.map((company) => company.ticker));
  const filings = (Array.isArray(doc.filings) ? doc.filings : [])
    .map(cleanFiling)
    .filter((filing) => filing && tickers.has(filing.ticker))
    .sort((a, b) => (b.filed + b.accession).localeCompare(a.filed + a.accession));
  companies.sort((a, b) => a.ticker.localeCompare(b.ticker));
  const formCounts = {};
  for (const filing of filings) formCounts[filing.form] = (formCounts[filing.form] || 0) + 1;
  return {
    ...doc,
    schema_version: Number(doc.schema_version) || SCHEMA_VERSION,
    mode: doc.demo ? "demo" : doc.mode || "live",
    meta: {
      ...(doc.meta || {}),
      company_count: companies.length,
      filing_count: filings.length,
      form_counts: formCounts,
      sectors: [...new Set(companies.map((company) => company.sector))].sort(),
      latest_filed: filings.reduce((max, filing) => (filing.filed > max ? filing.filed : max), ""),
    },
    companies,
    filings,
    demo: Boolean(doc.demo),
  };
}

export async function loadFinanceSnapshot({ signal } = {}) {
  const attempts = 3;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${DATA_URL}?v=${Date.now()}`, {
        cache: "no-store",
        signal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Finance snapshot HTTP ${response.status}`);
      return normalizeSnapshot(await response.json());
    } catch (error) {
      lastError = error;
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
  throw lastError;
}

/* ---------- Selectors and summary ---------- */

export function filingsFor(snapshot, ticker) {
  return snapshot.filings.filter((filing) => filing.ticker === ticker);
}

export function summarize(snapshot) {
  const companies = snapshot.companies;
  const withRevenue = companies.filter((company) => Number(company.latest.revenue) > 0);
  const totalRevenue = withRevenue.reduce((sum, company) => sum + company.latest.revenue, 0);
  const totalNetIncome = companies.reduce((sum, company) => sum + (company.latest.net_income || 0), 0);
  const margins = companies.map((company) => company.ratios.net_margin).filter((value) => Number.isFinite(value));
  const bySector = new Map();
  for (const company of companies) {
    const entry = bySector.get(company.sector) || { sector: company.sector, count: 0, revenue: 0 };
    entry.count += 1;
    entry.revenue += company.latest.revenue || 0;
    bySector.set(company.sector, entry);
  }
  return {
    totalRevenue,
    totalNetIncome,
    averageMargin: margins.length ? margins.reduce((sum, value) => sum + value, 0) / margins.length : null,
    reporting: withRevenue.length,
    sectors: [...bySector.values()].sort((a, b) => b.revenue - a.revenue),
  };
}

export function sectorColor(sector) {
  const palette = {
    Technology: "#4cd7ff",
    Financials: "#ffc45c",
    Healthcare: "#5ee0b0",
    Energy: "#ff9f6e",
    Retail: "#c49bff",
    Manufacturing: "#7ea6ff",
    Services: "#67d7c4",
    Utilities: "#9ad36b",
    Telecom: "#e58fff",
  };
  if (palette[sector]) return palette[sector];
  let hash = 0;
  for (const char of String(sector)) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return `hsl(${hash} 68% 62%)`;
}

const NAME_OVERRIDES = {
  "AMAZON COM INC": "Amazon.com, Inc.",
  "ALPHABET INC.": "Alphabet Inc.",
  "BERKSHIRE HATHAWAY INC": "Berkshire Hathaway Inc.",
  "COCA COLA CO": "Coca-Cola Co.",
  "ELI LILLY & CO": "Eli Lilly & Co.",
  "JOHNSON & JOHNSON": "Johnson & Johnson",
  "JPMORGAN CHASE & CO": "JPMorgan Chase & Co.",
  "PROCTER & GAMBLE Co": "Procter & Gamble Co.",
};

const NAME_WORDS = {
  INC: "Inc.",
  CORP: "Corp.",
  CO: "Co.",
  COMPANY: "Company",
  COMPANIES: "Companies",
  GROUP: "Group",
  HOLDINGS: "Holdings",
  INTERNATIONAL: "International",
  OF: "of",
  THE: "the",
  FOR: "for",
  AND: "and",
  LLC: "LLC",
  LP: "LP",
  LTD: "Ltd.",
  PLC: "PLC",
  USA: "USA",
  JPMORGAN: "JPMorgan",
  EXXONMOBIL: "ExxonMobil",
  PEPSICO: "PepsiCo",
  UNITEDHEALTH: "UnitedHealth",
  ABBVIE: "AbbVie",
  NVIDIA: "NVIDIA",
  MASTERCARD: "Mastercard",
  COSTCO: "Costco",
  BROADCOM: "Broadcom",
  CHEVRON: "Chevron",
  WALMART: "Walmart",
  TESLA: "Tesla",
  VISA: "Visa",
  ALPHABET: "Alphabet",
  MERCK: "Merck",
  PROCTER: "Procter",
  GAMBLE: "Gamble",
  JOHNSON: "Johnson",
  ELI: "Eli",
  LILLY: "Lilly",
  AMAZON: "Amazon",
  APPLE: "Apple",
  MICROSOFT: "Microsoft",
  META: "Meta",
  PLATFORMS: "Platforms",
  ABBOTT: "Abbott",
  LABORATORIES: "Laboratories",
};

/**
 * Turn all-caps EDGAR legal name fragments into display case while keeping
 * brand spellings (NVIDIA) and mixed-case names untouched.
 */
export function displayName(raw) {
  const name = String(raw || "").trim().replace(/\s*\/(?:NEW|MD|DE|VA|PA|CA)$/i, "");
  if (!name) return name;
  if (NAME_OVERRIDES[name]) return NAME_OVERRIDES[name];
  const words = name.split(/\s+/).map((word) => {
    if (NAME_WORDS[word]) return NAME_WORDS[word];
    if (!/^[A-Z]{2,}[.,&'/-]*$/.test(word)) return word;
    const lower = word.toLowerCase();
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  });
  return words.join(" ").replace(/\b(Inc|Corp|Co|Ltd)$/, "$1.");
}

/* ---------- Formatting ---------- */

export function formatMoney(value, { perShare = false } = {}) {
  const number = nullableNumber(value);
  if (number === null) return "—";
  if (perShare) return `$${number.toFixed(2)}`;
  const absolute = Math.abs(number);
  const sign = number < 0 ? "-" : "";
  const units = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) {
    if (absolute >= size) {
      const scaled = absolute / size;
      return `${sign}$${scaled.toFixed(scaled >= 100 ? 0 : 1)}${suffix}`;
    }
  }
  return `${sign}$${absolute.toFixed(0)}`;
}

export function formatPercent(value, digits = 1, signed = true) {
  const number = nullableNumber(value);
  if (number === null) return "—";
  const sign = signed && number > 0 ? "+" : "";
  return `${sign}${(number * 100).toFixed(digits)}%`;
}

export function formatDate(value) {
  if (!value) return "—";
  const parsed = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

export function relativeDay(value) {
  if (!value) return "—";
  const parsed = new Date(`${String(value).slice(0, 10)}T00:00:00Z`).getTime();
  if (!Number.isFinite(parsed)) return "—";
  const days = Math.floor((Date.now() - parsed) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 45) return `${days} days ago`;
  if (days < 365) return `${Math.round(days / 30)} mo ago`;
  return `${Math.floor(days / 365)} yr ago`;
}

export function fiscalYearLabel(company) {
  if (company.fiscal_year) return `FY${company.fiscal_year}`;
  const rows = company.series.revenue || [];
  return rows.length ? `FY${rows[rows.length - 1][0]}` : "latest";
}
