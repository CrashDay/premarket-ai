import { readFileSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildSwingPlan, buildTrendData } from "./lib/swing-plan.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA_DIR = path.join(ROOT, "data", "daily");
const REPORTS_DIR = path.join(ROOT, "reports");
const PUBLIC_DIR = path.join(ROOT, "public");
const DASHBOARD_PATH = path.join(PUBLIC_DIR, "dashboard.html");
const VERIFICATIONS_DIR = path.join(ROOT, "data", "verifications");
const NEWS_DIR = path.join(ROOT, "data", "news");
const SCHWAB_DIR = path.join(ROOT, "data", "schwab");
const PAPER_PORTFOLIO_DIR = path.join(ROOT, "data", "paper-portfolio");
const WATCHLISTS_DIR = path.join(ROOT, "data", "watchlists");
const SWING_WATCHLIST_PATH = path.join(WATCHLISTS_DIR, "swing", "current.json");
const SCHWAB_HOLDINGS_ACCOUNT = process.env.SCHWAB_HOLDINGS_ACCOUNT || "";
const DASHBOARD_ASSET_VERSION = Date.now().toString();

await mkdir(PUBLIC_DIR, { recursive: true });

const days = await loadDailyData();

if (days.length === 0) {
  console.log("No daily data found. Run npm run brief first.");
  process.exit(0);
}

const latest = days.at(-1);
const trendData = buildTrendData(days);
const swingPlan = buildSwingPlan(latest, trendData);
const candleSummary = await readOptionalJson(path.join(ROOT, "data", "candles", latest.date, "summary.json"));
const newsSummary = await readOptionalJson(path.join(NEWS_DIR, latest.date, "summary.json"));
const schwabSummary =
  (await readOptionalJson(path.join(SCHWAB_DIR, `${latest.date}.json`))) ??
  (await readOptionalJson(path.join(SCHWAB_DIR, "latest.json")));
const paperPortfolio =
  (await readOptionalJson(path.join(PAPER_PORTFOLIO_DIR, `${latest.date}.json`))) ??
  (await readOptionalJson(path.join(PAPER_PORTFOLIO_DIR, "latest.json")));
const verificationSummary = await loadVerificationSummary(latest.date);
const dailyTradeCandidates = await readOptionalJson(path.join(WATCHLISTS_DIR, "daily", `${latest.date}.json`));
const previousSwingWatchlist = await readOptionalJson(SWING_WATCHLIST_PATH);
const reportMarkdown = await readOptional(path.join(REPORTS_DIR, `${latest.date}.md`));
const sourceBundlePath = path.join(REPORTS_DIR, `${latest.date}.source-bundle.md`);
const promptPath = path.join(REPORTS_DIR, `${latest.date}.prompt.md`);
const swingWatchlist = buildStrictSwingWatchlist({
  latest,
  dailyTradeCandidates,
  candleSummary,
  previousSwingWatchlist,
});
await writeFile(SWING_WATCHLIST_PATH, `${JSON.stringify(swingWatchlist, null, 2)}\n`, "utf8");

await writeFile(
  DASHBOARD_PATH,
  renderDashboard({
    latest,
    days,
    trendData,
    swingPlan,
    candleSummary,
    newsSummary,
    schwabSummary,
    paperPortfolio,
    verificationSummary,
    dailyTradeCandidates,
    swingWatchlist,
    reportMarkdown,
    sourceBundlePath,
    promptPath,
  }),
  "utf8",
);

console.log(`Wrote dashboard: ${DASHBOARD_PATH}`);

async function loadDailyData() {
  let entries = [];

  try {
    entries = await readdir(DATA_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  const days = [];

  for (const file of files) {
    const raw = await readFile(path.join(DATA_DIR, file), "utf8");
    const day = JSON.parse(raw);
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(day.date ?? ""))) {
      days.push(day);
    }
  }

  return days.sort((a, b) => a.date.localeCompare(b.date));
}

async function readOptional(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function loadVerificationSummary(date) {
  const dir = path.join(VERIFICATIONS_DIR, date);
  let entries = [];

  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return new Map();
  }

  const summaries = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const record = await readOptionalJson(path.join(dir, entry.name));
        return record?.symbol ? [record.symbol, record] : null;
      }),
  );

  return new Map(summaries.filter(Boolean));
}

function renderDashboard({
  latest,
  days,
  trendData,
  swingPlan,
  candleSummary,
  newsSummary,
  schwabSummary,
  paperPortfolio,
  verificationSummary,
  dailyTradeCandidates,
  swingWatchlist,
  reportMarkdown,
  sourceBundlePath,
  promptPath,
}) {
  const hasFinalBrief = reportMarkdown.trim().length > 0;
  const title = `Premarket Research Dashboard - ${latest.date}`;
  const candleMap = new Map((candleSummary?.tickers ?? []).filter((ticker) => ticker.ok).map((ticker) => [ticker.symbol, ticker]));
  const newsMap = new Map(Object.entries(newsSummary?.symbols ?? {}));
  const selectedSchwabAccount = resolveSelectedSchwabAccount(schwabSummary);
  const schwabMap = new Map(Object.entries(selectedSchwabAccount?.positionsBySymbol ?? {}));
  const weeklyCalendar = buildWeeklyCalendar(days, latest.date);
  const headerSummary = buildHeaderSummary(latest, weeklyCalendar);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #17212b;
      --muted: #5e6a78;
      --line: #d6dee8;
      --soft: #edf4fb;
      --panel: rgba(255, 255, 255, 0.94);
      --panel-strong: #ffffff;
      --accent: #0f766e;
      --accent-2: #c65b3d;
      --accent-3: #7a8f27;
      --accent-deep: #113b52;
      --highlight: #d9a441;
      --bg: #eef2f6;
      --bg-glow: rgba(25, 118, 210, 0.09);
      --bg-warm: rgba(217, 164, 65, 0.11);
      --shadow: 0 18px 42px rgba(17, 33, 48, 0.08);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background:
        radial-gradient(circle at top left, var(--bg-glow), transparent 28%),
        radial-gradient(circle at top right, var(--bg-warm), transparent 24%),
        linear-gradient(180deg, #f5f8fb 0%, var(--bg) 100%);
      color: var(--ink);
      font-family: "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
      line-height: 1.45;
    }

    header {
      position: relative;
      z-index: 30;
      overflow: visible;
      border-bottom: 1px solid var(--line);
      background:
        linear-gradient(135deg, rgba(17, 59, 82, 0.96), rgba(15, 118, 110, 0.9)),
        linear-gradient(180deg, #ffffff, #f6f9fc);
      color: #f8fbfd;
      box-shadow: inset 0 -1px 0 rgba(255, 255, 255, 0.16);
    }

    main,
    .wrap {
      width: min(1180px, calc(100% - 32px));
      margin: 0 auto;
    }

    header .wrap {
      padding: 28px 0 22px;
      position: relative;
      z-index: 2;
      overflow: visible;
    }

    h1 {
      margin: 0;
      font-size: 32px;
      line-height: 1.1;
      font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
      letter-spacing: -0.02em;
    }

    h2 {
      margin: 0 0 14px;
      font-size: 20px;
    }

    h3 {
      margin: 0 0 8px;
      font-size: 16px;
    }

    p {
      margin: 0;
    }

    a {
      color: var(--accent);
      text-underline-offset: 2px;
    }

    .subhead {
      color: var(--muted);
      margin-top: 10px;
      max-width: 860px;
    }

    .header-summary {
      color: rgba(244, 250, 252, 0.86);
      margin-top: 12px;
      max-width: 860px;
      font-size: 15px;
    }

    .header-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 18px;
    }

    .header-pill,
    .panel,
    .item {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 14px;
      backdrop-filter: blur(12px);
    }

    .item {
      border-color: rgba(182, 196, 211, 0.85);
      box-shadow: 0 10px 26px rgba(24, 32, 42, 0.05);
    }

    .header-pill {
      padding: 9px 13px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      position: relative;
      background: rgba(255, 255, 255, 0.12);
      border-color: rgba(255, 255, 255, 0.18);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
    }

    .header-pill strong {
      font-size: 13px;
      line-height: 1;
      color: #ffffff;
    }

    .header-pill span {
      color: rgba(243, 248, 251, 0.74);
      font-size: 13px;
    }

    .header-pill-tooltip {
      position: absolute;
      left: 0;
      top: calc(100% + 10px);
      width: min(320px, 70vw);
      padding: 12px 13px;
      border-radius: 12px;
      border: 1px solid rgba(17, 59, 82, 0.18);
      background: rgba(255, 255, 255, 0.98);
      color: var(--ink);
      box-shadow: 0 16px 38px rgba(17, 33, 48, 0.14);
      font-size: 13px;
      line-height: 1.5;
      opacity: 0;
      visibility: hidden;
      transform: translateY(-4px);
      transition: opacity 140ms ease, transform 140ms ease, visibility 140ms ease;
      z-index: 20;
      pointer-events: none;
    }

    .header-pill-tooltip strong {
      display: block;
      margin-bottom: 4px;
      color: var(--accent-deep);
      font-size: 11px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }

    .header-pill.has-tooltip:hover .header-pill-tooltip,
    .header-pill.has-tooltip:focus-within .header-pill-tooltip {
      opacity: 1;
      visibility: visible;
      transform: translateY(0);
    }

    main {
      position: relative;
      z-index: 1;
      padding: 24px 0 40px;
    }

    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1.4fr) minmax(320px, 0.8fr);
      gap: 18px;
      align-items: start;
    }

    .grid > section,
    .grid > aside {
      min-width: 0;
    }

    .panel {
      padding: 18px;
      margin-bottom: 18px;
      min-width: 0;
      overflow: hidden;
      box-shadow: var(--shadow);
    }

    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 16px;
      padding: 6px;
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.7);
      border: 1px solid rgba(208, 219, 230, 0.9);
      box-shadow: 0 12px 26px rgba(17, 33, 48, 0.04);
    }

    .tab-button {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 8px 12px;
      background: transparent;
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      transition: background 140ms ease, color 140ms ease, border-color 140ms ease, transform 140ms ease;
    }

    .tab-button:hover {
      border-color: #b8c7d8;
      color: var(--accent-deep);
      transform: translateY(-1px);
    }

    .tab-button.active {
      background: linear-gradient(135deg, rgba(17, 59, 82, 0.95), rgba(15, 118, 110, 0.92));
      color: #ffffff;
      border-color: rgba(17, 59, 82, 0.92);
      box-shadow: 0 8px 18px rgba(15, 118, 110, 0.18);
    }

    .tab-panel {
      display: none;
    }

    .tab-panel.active {
      display: block;
    }

    .tab-stack {
      display: grid;
      gap: 18px;
    }

    .list {
      display: grid;
      gap: 10px;
    }

    .item {
      padding: 12px;
      position: relative;
    }

    .item::before {
      content: "";
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 5px;
      border-radius: 14px 0 0 14px;
      background: linear-gradient(180deg, var(--highlight), var(--accent));
    }

    .row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 14px;
    }

    .ticker {
      font-weight: 700;
      letter-spacing: 0;
    }

    .tag {
      display: inline-block;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 3px 8px;
      color: var(--muted);
      font-size: 12px;
      margin: 4px 5px 0 0;
      background: linear-gradient(180deg, #f8fbfe, var(--soft));
    }

    .tag-positive {
      border-color: rgba(15, 118, 110, 0.22);
      color: #0f766e;
      background: linear-gradient(180deg, #f2fbf9, #e5f6f2);
    }

    .tag-negative {
      border-color: rgba(198, 91, 61, 0.2);
      color: #b64a2e;
      background: linear-gradient(180deg, #fff7f5, #fdebe6);
    }

    .tag-neutral {
      border-color: rgba(88, 112, 139, 0.18);
      color: #5d7288;
      background: linear-gradient(180deg, #fafcfe, #eef4f9);
    }

    .move {
      color: var(--accent-3);
      font-weight: 700;
    }

    .score {
      min-width: 52px;
      border-radius: 999px;
      padding: 5px 8px;
      text-align: center;
      color: #fff;
      background: linear-gradient(135deg, var(--accent-deep), var(--accent));
      font-weight: 700;
      box-shadow: 0 10px 22px rgba(15, 118, 110, 0.18);
    }

    .stance {
      color: var(--accent-2);
      font-weight: 700;
      font-size: 13px;
    }

    .note {
      color: var(--muted);
      font-size: 13px;
      margin-top: 8px;
    }

    .trade-plan {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin-top: 10px;
    }

    .trade-plan div {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 9px;
      background: linear-gradient(180deg, #ffffff, #f7fafc);
    }

    .trade-plan strong,
    .checklist strong {
      display: block;
      margin-bottom: 3px;
      font-size: 12px;
      color: var(--muted);
      text-transform: uppercase;
    }

    .quality {
      background: #22313f;
    }

    .panel > h2,
    .section-head h2 {
      letter-spacing: 0;
    }

    .aside-title,
    .section-label {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
      color: #58708b;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .section-label::before,
    .aside-title::before {
      content: "";
      width: 18px;
      height: 2px;
      border-radius: 999px;
      background: linear-gradient(90deg, var(--highlight), var(--accent));
    }

    .checklist {
      margin: 10px 0 0;
      padding-left: 18px;
      color: var(--muted);
      font-size: 13px;
    }

    .checklist li + li {
      margin-top: 5px;
    }

    .snapshot-toggle {
      margin-top: 12px;
      border: 1px solid #d8e2ec;
      border-radius: 12px;
      background: linear-gradient(180deg, #ffffff, #f7fafc);
      overflow: hidden;
    }

    .snapshot-toggle summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 11px 12px;
      cursor: pointer;
      list-style: none;
      color: #35506b;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .snapshot-toggle summary::-webkit-details-marker {
      display: none;
    }

    .snapshot-body {
      border-top: 1px solid #e7edf4;
      padding: 12px;
      background: #fbfdff;
    }

    .snapshot-lede {
      margin-bottom: 10px;
      padding: 10px 12px;
      border: 1px solid #dce6ef;
      border-radius: 12px;
      background: linear-gradient(180deg, #ffffff, #f4f9fd);
      color: #2e4357;
      font-size: 13px;
      line-height: 1.5;
    }

    .snapshot-lede strong {
      color: var(--accent-deep);
    }

    .chart-snapshot {
      display: block;
      width: 100%;
      border: 1px solid #d9e3ec;
      border-radius: 12px;
      background: #f5f8fb;
    }

    .chart-snapshot-inline {
      overflow: hidden;
    }

    .chart-snapshot-inline svg {
      display: block;
      width: 100%;
      height: auto;
      border: 1px solid #d9e3ec;
      border-radius: 12px;
      background: #f5f8fb;
    }

    .snapshot-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 10px;
    }

    .snapshot-actions a {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 700;
      color: var(--accent-deep);
    }

    .snapshot-status {
      margin-top: 10px;
      padding: 9px 11px;
      border: 1px solid #f0d7d0;
      border-radius: 10px;
      background: #fff7f4;
      color: #8a3f2d;
      font-size: 12px;
      line-height: 1.5;
    }

    .source-meta {
      color: var(--muted);
      font-size: 13px;
      margin-bottom: 8px;
    }

    .calendar-compact {
      display: grid;
      gap: 10px;
    }

    .calendar-day {
      border-top: 1px solid rgba(212, 221, 230, 0.85);
      padding-top: 8px;
    }

    .calendar-day:first-child {
      border-top: 0;
      padding-top: 0;
    }

    .calendar-day-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 6px;
    }

    .calendar-day-head strong {
      font-size: 13px;
      color: var(--accent-deep);
    }

    .calendar-count {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .calendar-lines {
      display: grid;
      gap: 4px;
    }

    .calendar-line {
      display: grid;
      grid-template-columns: 68px minmax(0, 1fr);
      gap: 8px;
      align-items: start;
      font-size: 13px;
    }

    .calendar-time {
      color: var(--muted);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    .calendar-title {
      min-width: 0;
    }

    .calendar-kind {
      color: var(--muted);
      font-size: 11px;
      margin-left: 6px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    .macro-explainer {
      margin-top: 10px;
      padding: 10px 12px;
      border: 1px solid #d8e2ec;
      border-radius: 12px;
      background: linear-gradient(180deg, #fbfdff, #f4f9fd);
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
    }

    .macro-legend {
      display: grid;
      gap: 8px;
      margin-top: 12px;
    }

    .macro-legend-item {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: #fbfcfd;
    }

    .macro-legend-item strong {
      display: block;
      margin-bottom: 3px;
      font-size: 12px;
    }

    .agent-brief {
      margin-top: 10px;
      border: 1px solid #d8e2ec;
      border-radius: 12px;
      background: linear-gradient(180deg, rgba(255,255,255,0.98), rgba(248,251,253,0.95));
      overflow: hidden;
    }

    .agent-brief summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px;
      cursor: pointer;
      list-style: none;
    }

    .agent-brief summary::-webkit-details-marker {
      display: none;
    }

    .agent-brief-title {
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #466078;
    }

    .agent-brief-body {
      border-top: 1px solid #e7edf4;
      padding: 12px;
      background: linear-gradient(180deg, #fbfdff, #f5f9fc);
    }

    .agent-brief-copy {
      margin-top: 10px;
      width: 100%;
      text-align: left;
    }

    .sidebar-disclosure {
      border: 1px solid #d8e2ec;
      border-radius: 12px;
      background: linear-gradient(180deg, rgba(255,255,255,0.98), rgba(248,251,253,0.95));
      overflow: hidden;
    }

    .sidebar-disclosure summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px;
      cursor: pointer;
      list-style: none;
    }

    .sidebar-disclosure summary::-webkit-details-marker {
      display: none;
    }

    .sidebar-disclosure-title {
      margin: 0;
      font-size: 22px;
      color: var(--ink);
    }

    .sidebar-disclosure-body {
      border-top: 1px solid #e7edf4;
      padding: 12px;
      background: linear-gradient(180deg, #fbfdff, #f5f9fc);
    }

    .agent-brief-text {
      margin: 0;
      white-space: pre-wrap;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      line-height: 1.5;
      color: #243241;
    }

    .verification-panel {
      margin-top: 10px;
      border: 1px solid #d8e2ec;
      border-radius: 12px;
      background: linear-gradient(180deg, #fcfeff 0%, #f8fbfd 100%);
      padding: 12px;
    }

    .verification-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }

    .verification-title {
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #466078;
    }

    .verification-status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .verification-badge {
      display: inline-block;
      border-radius: 999px;
      padding: 4px 9px;
      font-size: 12px;
      font-weight: 700;
      border: 1px solid #d0dae5;
      background: #f2f5f8;
      color: #425466;
    }

    .verification-badge.actionable-now {
      background: #e8f7ef;
      border-color: #b5dfc4;
      color: #1f6a39;
    }

    .verification-badge.watchlist-only {
      background: #fff8e6;
      border-color: #e8d69b;
      color: #7b5a00;
    }

    .verification-badge.pass {
      background: #fdecec;
      border-color: #e5b9b9;
      color: #8a2d2d;
    }

    .verification-badge.error,
    .verification-badge.stale {
      background: #eef2f6;
      border-color: #d6dde6;
      color: #5e6873;
    }

    .verification-timestamp {
      color: var(--muted);
      font-size: 12px;
    }

    .verification-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }

    .button[disabled] {
      opacity: 0.55;
      cursor: not-allowed;
    }

    .verification-summary {
      margin-top: 10px;
      color: var(--ink);
    }

    .verification-meta {
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
    }

    .verification-list {
      margin: 10px 0 0;
      padding-left: 18px;
      color: var(--muted);
      font-size: 13px;
    }

    .verification-list li + li {
      margin-top: 5px;
    }

    .theme-bars {
      display: grid;
      gap: 10px;
    }

    .bar {
      height: 10px;
      border-radius: 8px;
      background: var(--soft);
      overflow: hidden;
      margin-top: 6px;
    }

    .bar span {
      display: block;
      height: 100%;
      background: var(--accent);
    }

    .empty {
      color: var(--muted);
      background: var(--soft);
      border-radius: 8px;
      padding: 14px;
    }

    .links {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 14px;
    }

    .button {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px 10px;
      text-decoration: none;
      color: var(--ink);
      background: #fff;
    }

    .button:hover {
      background: #f8fbfd;
    }

    .section-head {
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid #e6edf4;
    }

    .section-head .note {
      max-width: 820px;
    }

    .panel > h2 {
      margin-bottom: 14px;
      padding-bottom: 10px;
      border-bottom: 1px solid #e6edf4;
    }

    .briefing {
      display: grid;
      gap: 16px;
      color: var(--ink);
      min-width: 0;
    }

    .briefing-section {
      border-radius: 8px;
      border: 1px solid var(--line);
      background: #fcfdff;
      padding: 14px;
      min-width: 0;
      overflow: hidden;
    }

    .briefing-kicker {
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 8px;
    }

    .briefing h1,
    .briefing h2,
    .briefing h3 {
      margin: 0;
      line-height: 1.2;
    }

    .briefing h1 {
      font-size: 26px;
      margin-bottom: 4px;
    }

    .briefing h2 {
      font-size: 18px;
      margin-bottom: 8px;
    }

    .briefing h3 {
      font-size: 15px;
      margin-bottom: 6px;
    }

    .briefing p + p,
    .briefing ul + p,
    .briefing ol + p,
    .briefing table + p,
    .briefing blockquote + p {
      margin-top: 10px;
    }

    .briefing ul,
    .briefing ol {
      margin: 0;
      padding-left: 18px;
    }

    .briefing li + li {
      margin-top: 6px;
    }

    .briefing blockquote {
      margin: 0;
      padding: 10px 12px;
      background: var(--soft);
      border-left: 3px solid var(--accent);
      border-radius: 6px;
      color: var(--muted);
    }

    .briefing code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.92em;
      background: #eef2f6;
      border-radius: 4px;
      padding: 1px 4px;
    }

    .briefing table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      display: block;
      max-width: 100%;
      overflow-x: auto;
    }

    .briefing th,
    .briefing td {
      border: 1px solid var(--line);
      padding: 8px;
      text-align: left;
      vertical-align: top;
      white-space: normal;
      overflow-wrap: anywhere;
    }

    .briefing th {
      background: #f4f7fa;
      font-weight: 700;
    }

    .briefing strong {
      color: var(--ink);
    }

    .swing-board-view .briefing-section {
      background: #f8fbff;
      padding: 18px;
    }

    .swing-board-view h2 {
      margin-bottom: 14px;
    }

    .swing-board-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }

    .swing-glossary {
      display: grid;
      gap: 12px;
      margin-bottom: 14px;
    }

    .swing-glossary-block {
      border: 1px solid #d8e2ec;
      border-radius: 8px;
      background: #ffffff;
      overflow: hidden;
    }

    .swing-glossary-toggle {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      width: 100%;
      padding: 14px;
      cursor: pointer;
      list-style: none;
    }

    .swing-glossary-toggle::-webkit-details-marker {
      display: none;
    }

    .swing-glossary-title {
      margin: 0;
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #466078;
    }

    .swing-glossary-icon {
      color: #6d7f91;
      font-size: 16px;
      line-height: 1;
      transition: transform 120ms ease;
    }

    .swing-glossary-block[open] .swing-glossary-icon {
      transform: rotate(180deg);
    }

    .swing-glossary-body {
      padding: 0 14px 14px;
      border-top: 1px solid #e7edf4;
    }

    .swing-glossary-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px 14px;
    }

    .swing-glossary-item dt {
      font-weight: 700;
      color: var(--ink);
      margin: 0 0 4px;
    }

    .swing-glossary-item dd {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
    }

    .swing-card {
      border: 1px solid #cfdae6;
      border-radius: 8px;
      background: #ffffff;
      padding: 14px;
      min-width: 0;
    }

    .swing-card-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }

    .swing-card-symbol {
      font-size: 20px;
      line-height: 1.1;
      font-weight: 700;
    }

    .swing-card-class {
      display: inline-block;
      margin-top: 5px;
      border: 1px solid #cfe0ec;
      background: #eef5fb;
      color: #35506b;
      border-radius: 999px;
      padding: 3px 8px;
      font-size: 12px;
      font-weight: 700;
    }

    .swing-card-fields {
      display: grid;
      gap: 10px;
    }

    .swing-card-field {
      border-top: 1px solid #e6edf4;
      padding-top: 10px;
    }

    .swing-card-label {
      display: block;
      margin-bottom: 4px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .swing-card-value {
      font-size: 14px;
      line-height: 1.45;
    }

    @media (max-width: 860px) {
      .grid,
      .header-pills {
        grid-template-columns: 1fr;
      }

      h1 {
        font-size: 26px;
      }

      .trade-plan {
        grid-template-columns: 1fr;
      }

      .swing-board-grid {
        grid-template-columns: 1fr;
      }

      .swing-glossary-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <header>
    <div class="wrap">
      <h1>Premarket Brief</h1>
      <p class="header-summary">${escapeHtml(headerSummary)}</p>
      <div class="header-pills">
        <div class="header-pill"><strong>${escapeHtml(formatHeaderDate(latest.date))}</strong><span>session</span></div>
        <div class="header-pill has-tooltip" tabindex="0">
          <strong>${escapeHtml(formatToneLabel(latest.macro?.tone))}</strong>
          <span>tone</span>
          <div class="header-pill-tooltip">
            <strong>What this means</strong>
            ${escapeHtml(describeRiskRecommendation(latest.macro?.tone))}
          </div>
        </div>
        <div class="header-pill"><strong>${countNotableEvents(weeklyCalendar)}</strong><span>key events</span></div>
      </div>
    </div>
  </header>
  <main>
    <div class="grid">
      <section>
        <div class="panel">
          <div class="tabs" role="tablist" aria-label="Dashboard views">
            <button class="tab-button" type="button" role="tab" aria-selected="false" data-tab-target="candidates">Candidates</button>
            <button class="tab-button" type="button" role="tab" aria-selected="false" data-tab-target="breakouts">Breakouts</button>
            <button class="tab-button" type="button" role="tab" aria-selected="false" data-tab-target="pullbacks">Pullbacks</button>
            <button class="tab-button" type="button" role="tab" aria-selected="false" data-tab-target="scanner">Scanner</button>
            <button class="tab-button" type="button" role="tab" aria-selected="false" data-tab-target="live-holdings">Live Holdings</button>
            <button class="tab-button" type="button" role="tab" aria-selected="false" data-tab-target="paper-portfolio">Paper Portfolio</button>
            <button class="tab-button" type="button" role="tab" aria-selected="false" data-tab-target="research">Research</button>
            <button class="tab-button" type="button" role="tab" aria-selected="false" data-tab-target="swing-board">Swing Board</button>
            <button class="tab-button active" type="button" role="tab" aria-selected="true" data-tab-target="briefing">Briefing</button>
          </div>

	          <section class="tab-panel" data-tab-panel="candidates">
	            <div class="section-head">
	              <div class="section-label">Primary Workflow</div>
	              <h2>Watchlists</h2>
	            </div>
	            ${renderDailyTradeCandidates(dailyTradeCandidates, swingPlan.bySymbol, candleMap, newsMap, schwabMap, verificationSummary, latest)}
              <div style="height: 18px;"></div>
	            ${renderSwingWatchlist(swingWatchlist, latest)}
	          </section>

          <section class="tab-panel" data-tab-panel="breakouts">
            <div class="section-head">
              <div class="section-label">Momentum Setups</div>
              <h2>Breakout Board</h2>
              <p class="note">These are names pressing into or through resistance. The goal is to find stocks with enough strength, volume, and relative leadership to keep moving instead of failing at the breakout level.</p>
            </div>
            ${renderBreakoutBoard(candleSummary)}
          </section>

          <section class="tab-panel" data-tab-panel="pullbacks">
            <div class="section-head">
              <div class="section-label">Support Entries</div>
              <h2>Pullback Board</h2>
              <p class="note">These are names pulling back within a stronger trend. The goal is to find controlled weakness near support, where the stock may offer a cleaner entry than chasing a breakout.</p>
            </div>
            ${renderPullbackBoard(candleSummary, swingPlan.ranked)}
          </section>

          <section class="tab-panel" data-tab-panel="scanner">
            <div class="section-head">
              <div class="section-label">Pattern Scan</div>
              <h2>Candlestick Scanner</h2>
            </div>
            ${renderCandleScanner(candleSummary)}
          </section>

          <section class="tab-panel" data-tab-panel="live-holdings">
            <div class="section-head">
              <div class="section-label">Live Account Context</div>
              <h2>Live Holdings</h2>
              <p class="note">This view is scoped to the selected Schwab account so live holdings stay separate from your simulated paper portfolio.</p>
            </div>
            ${renderMyHoldings(selectedSchwabAccount, schwabSummary)}
          </section>

          <section class="tab-panel" data-tab-panel="paper-portfolio">
            <div class="section-head">
              <div class="section-label">Simulated Account</div>
              <h2>Paper Portfolio</h2>
              <p class="note">This portfolio is local to the dashboard. It is separate from Schwab and gives us a clean place to track simulated swing positions.</p>
            </div>
            ${renderPaperPortfolio(paperPortfolio, latest)}
          </section>

          <section class="tab-panel" data-tab-panel="research">
            <div class="tab-stack">
              <div>
                <div class="section-head">
                  <div class="section-label">Source Extraction</div>
                  <h2>Evidence Board</h2>
                </div>
                ${renderTickerBoard(latest.tickers, latest.sources)}
              </div>
              <div>
                <div>
                  <div class="section-head">
                    <div class="section-label">Email Inputs</div>
                    <h2>Source Cards</h2>
                    <p class="note">Raw source summaries and extracted links for audit/reference.</p>
                  </div>
                  ${renderSources(latest.sources)}
                </div>
              </div>
            </div>
          </section>

          <section class="tab-panel" data-tab-panel="swing-board">
            <div class="section-head">
              <div class="section-label">Execution View</div>
              <h2>Swing Trade Setup Board</h2>
            </div>
            <details style="margin-bottom: 16px;">
              <summary>Show strategy playbook</summary>
              <div style="margin-top: 16px;">${renderStrategyPlaybook(swingPlan.strategies)}</div>
            </details>
            ${
              hasFinalBrief
                ? renderBriefingSectionTab(reportMarkdown, "6. Swing Setup Board")
                : `<p class="empty">No AI-generated final briefing yet. Generate the briefing first to break Section 6 out into its own view.</p>`
            }
          </section>

          <section class="tab-panel active" data-tab-panel="briefing">
            ${
              hasFinalBrief
                ? renderBriefing(reportMarkdown)
                : `<p class="empty">No AI-generated final briefing yet. Set OPENAI_API_KEY and run npm run build, or paste the prompt file into an LLM.</p>`
            }
          </section>
        </div>
      </section>
      <aside>
        <div class="panel">
          <h2>This Week</h2>
          ${renderWeeklyCalendar(weeklyCalendar)}
        </div>
        <div class="panel">
          <h2>Top Catalysts</h2>
          ${renderReadingList((latest.readingList ?? []).slice(0, 4))}
        </div>
        <div class="panel">
          <h2>Macro Pressure</h2>
          ${renderMacro(latest.macro)}
        </div>
        <div class="panel">
          <details class="sidebar-disclosure">
            <summary>
              <h2 class="sidebar-disclosure-title">Schwab Account</h2>
              <span class="swing-glossary-icon" aria-hidden="true">▾</span>
            </summary>
            <div class="sidebar-disclosure-body">
              ${renderSchwabPanel(schwabSummary, latest, selectedSchwabAccount)}
            </div>
          </details>
        </div>
      </aside>
    </div>
  </main>
  <script>
    const tabButtons = [...document.querySelectorAll("[data-tab-target]")];
    const tabPanels = [...document.querySelectorAll("[data-tab-panel]")];
    const dashboardDate = ${JSON.stringify(latest.date)};

    for (const button of tabButtons) {
      button.addEventListener("click", () => {
        const target = button.getAttribute("data-tab-target");

        for (const item of tabButtons) {
          item.classList.toggle("active", item === button);
          item.setAttribute("aria-selected", item === button ? "true" : "false");
        }

        for (const panel of tabPanels) {
          panel.classList.toggle("active", panel.getAttribute("data-tab-panel") === target);
        }
      });
    }

    function verificationBadgeClass(state) {
      return String(state || "not_run")
        .replaceAll("_", "-")
        .toLowerCase();
    }

    function formatVerificationLabel(state) {
      if (state === "actionable_now") return "Actionable now";
      if (state === "watchlist_only") return "Watchlist only";
      if (state === "pass") return "Pass";
      if (state === "running") return "Running";
      if (state === "error") return "Error";
      if (state === "stale") return "Stale";
      return "Not run";
    }

    function formatCompactCurrency(value) {
      const amount = Number(value);
      if (!Number.isFinite(amount)) return "n/a";
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      }).format(amount);
    }

    function formatHoldingQuantity(value) {
      const quantity = Number(value);
      if (!Number.isFinite(quantity)) return "0";
      return Math.abs(quantity % 1) < 0.000001 ? String(Math.abs(quantity)) : String(Math.abs(Math.round(quantity * 100) / 100));
    }

    function formatHoldingSummary(holding) {
      if (!holding) return "Not currently held.";
      const accounts = Array.isArray(holding.accounts) ? holding.accounts.length : 0;
      const accountLabel = accounts === 1 ? "1 account" : accounts + " accounts";
      return formatHoldingQuantity(holding.totalQuantity) + " shares, about " + formatCompactCurrency(holding.totalMarketValue) + " across " + accountLabel + ".";
    }

    function escapeHtml(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function renderVerificationDetails(record) {
      const details = [];

      if (record.summary) details.push('<p class="verification-summary">' + escapeHtml(record.summary) + '</p>');
      if (Array.isArray(record.why) && record.why.length) {
        details.push('<ul class="verification-list">' + record.why.map((item) => '<li>' + escapeHtml(item) + '</li>').join("") + '</ul>');
      }

      if (record.orderPlan) {
        const orderFields = record.orderPlan.ok
          ? [
              ["Order ticket", "Executable now"],
              ["Entry style", record.orderPlan.style],
              ["Entry", record.orderPlan.entry],
              ["Stop", record.orderPlan.stop],
              ["First target", record.orderPlan.target],
            ]
          : [
              ["Order ticket", "Not executable"],
              ["Rejection reason", record.orderPlan.reason],
            ];

        details.push('<div class="trade-plan">' + orderFields.map(([label, value]) => '<div><strong>' + escapeHtml(label) + '</strong>' + escapeHtml(String(value ?? "")) + '</div>').join("") + '</div>');

        if (!record.orderPlan.ok && Array.isArray(record.orderPlan.reasons) && record.orderPlan.reasons.length > 1) {
          details.push('<ul class="verification-list">' + record.orderPlan.reasons.slice(1).map((item) => '<li>' + escapeHtml(item) + '</li>').join("") + '</ul>');
        }
      }

      const fields = [
        ["Entry plan", record.entryPlan],
        ["Risk plan", record.riskPlan],
        ["Target plan", record.targetPlan],
        ["Blocking issue", record.blockingIssue],
        ["Freshness", record.freshness],
        ["Account context", record.schwabHolding ? formatHoldingSummary(record.schwabHolding) : ""],
      ].filter(([, value]) => value);

      if (fields.length) {
        details.push('<div class="trade-plan">' + fields.map(([label, value]) => '<div><strong>' + escapeHtml(label) + '</strong>' + escapeHtml(value) + '</div>').join("") + '</div>');
      }

      if (Array.isArray(record.sourcesUsed) && record.sourcesUsed.length) {
        details.push('<p class="verification-meta"><strong>Sources checked:</strong> ' + escapeHtml(record.sourcesUsed.join(", ")) + '</p>');
      }

      return details.join("") || '<p class="verification-meta">No verification result yet.</p>';
    }

    function applyVerificationRecord(symbol, record) {
      const root = document.querySelector('[data-verification-card="' + symbol + '"]');
      if (!root) return;

      const badge = root.querySelector("[data-verification-badge]");
      const timestamp = root.querySelector("[data-verification-timestamp]");
      const body = root.querySelector("[data-verification-body]");

      const state = record?.state || "not_run";
      badge.className = "verification-badge " + verificationBadgeClass(state);
      badge.textContent = formatVerificationLabel(state);
      timestamp.textContent = record?.verifiedAtLabel || "";
      body.innerHTML = renderVerificationDetails(record || {});
    }

    function showDashboardNotice(message) {
      let notice = document.querySelector("[data-dashboard-notice]");
      if (!notice) {
        notice = document.createElement("p");
        notice.className = "empty";
        notice.setAttribute("data-dashboard-notice", "true");
        const anchor = document.querySelector("main .wrap, main");
        if (!anchor) return;
        anchor.insertAdjacentElement("afterbegin", notice);
      }

      notice.textContent = message;
    }

    function appendVersion(url, version) {
      if (!url) return "";
      return url + (url.includes("?") ? "&" : "?") + "v=" + encodeURIComponent(version);
    }

    function initSnapshotRecovery() {
      for (const image of document.querySelectorAll(".chart-snapshot")) {
        image.addEventListener("load", () => {
          const body = image.closest(".snapshot-body");
          const status = body?.querySelector("[data-snapshot-status]");
          if (status) status.remove();
        });

        image.addEventListener("error", () => {
          const body = image.closest(".snapshot-body");
          const baseSrc = image.getAttribute("data-base-src") || image.getAttribute("src") || "";
          const link = body?.querySelector("[data-full-size-link]");

          if (!image.dataset.retryAttempted) {
            image.dataset.retryAttempted = "true";
            const retrySrc = appendVersion(baseSrc, String(Date.now()));
            image.src = retrySrc;
            if (link && baseSrc) link.href = retrySrc;
            return;
          }

          if (!body) return;

          let status = body.querySelector("[data-snapshot-status]");
          if (!status) {
            status = document.createElement("p");
            status.className = "snapshot-status";
            status.setAttribute("data-snapshot-status", "true");
            body.appendChild(status);
          }

          status.textContent = "Chart snapshot could not be loaded. Refresh the page after the next dashboard rebuild, or open the latest candle SVG directly once the data file is available.";
        });
      }
    }

    async function refreshVerifications() {
      if (!window.location.protocol.startsWith("http")) return;

      try {
        const response = await fetch('/api/verifications?date=' + encodeURIComponent(dashboardDate));
        if (!response.ok) {
          showDashboardNotice("Live verification refresh is unavailable right now. Showing the last saved verification state.");
          return;
        }
        const payload = await response.json();
        for (const record of payload.records || []) applyVerificationRecord(record.symbol, record);
      } catch {
        showDashboardNotice("Live verification refresh is unavailable right now. Showing the last saved verification state.");
      }
    }

    for (const button of document.querySelectorAll("[data-copy-agent-brief]")) {
      button.addEventListener("click", async () => {
        const targetId = button.getAttribute("data-copy-agent-brief");
        const source = document.getElementById(targetId);
        if (!source) return;

        const text = source.textContent || "";

        try {
          await navigator.clipboard.writeText(text);
          const original = button.textContent;
          button.textContent = "Copied agent brief";
          window.setTimeout(() => {
            button.textContent = original;
          }, 1200);
        } catch {
          button.textContent = "Copy failed";
        }
      });
    }

    for (const button of document.querySelectorAll("[data-run-verification]")) {
      if (!window.location.protocol.startsWith("http")) {
        button.disabled = true;
        button.title = "Open the dashboard through the local verification server to run agents.";
        continue;
      }

      button.addEventListener("click", async () => {
        const symbol = button.getAttribute("data-run-verification");
        button.disabled = true;
        const original = button.textContent;
        button.textContent = "Running verification...";
        applyVerificationRecord(symbol, { state: "running", summary: "Verification agent is checking chart, trigger, and fresh news." });

        try {
          const response = await fetch("/api/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ symbol, date: dashboardDate }),
          });

          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error || "Verification failed");
          applyVerificationRecord(symbol, payload.record);
        } catch (error) {
          applyVerificationRecord(symbol, {
            state: "error",
            summary: error.message || "Verification failed.",
            blockingIssue: "Local verification runner did not return a usable result.",
          });
        } finally {
          button.disabled = false;
          button.textContent = original;
        }
      });
    }

    initSnapshotRecovery();
    refreshVerifications();
  </script>
</body>
</html>`;
}

function buildStrictSwingWatchlist({ latest, dailyTradeCandidates, candleSummary, previousSwingWatchlist }) {
  const generatedAt = new Date().toISOString();
  const priorBySymbol = new Map((previousSwingWatchlist?.candidates ?? []).map((candidate) => [candidate.symbol, candidate]));
  const candleBySymbol = new Map((candleSummary?.tickers ?? []).filter((ticker) => ticker.ok).map((ticker) => [ticker.symbol, ticker]));
  const promoted = [];

  for (const candidate of dailyTradeCandidates?.candidates ?? []) {
    const candle = candleBySymbol.get(candidate.symbol);
    const evaluation = evaluateSwingPromotion(candidate, candle);

    if (!evaluation.promotable) continue;

    const prior = priorBySymbol.get(candidate.symbol);
    const reviewEntry = {
      reviewedAt: generatedAt,
      status: evaluation.status,
      summary: evaluation.summary,
      price: candle?.close ?? null,
      relativeStrength: candle?.relativeStrengthLabel ?? "Unknown",
      volumeNote: candle ? `Volume ratio ${round(candle.volumeRatio ?? 0)}x versus 20-day average.` : "Volume review unavailable.",
      eventRisk: evaluation.eventRisk,
    };

    promoted.push(
      prior
        ? {
            ...prior,
            lastReviewedAt: generatedAt,
            status: preserveHigherPriorityStatus(prior.status, evaluation.status),
            thesis: candidate.catalyst ?? prior.thesis,
            entryTrigger: candle?.trigger ?? candidate.entryTrigger ?? prior.entryTrigger,
            triggerPrice: evaluation.triggerPrice,
            invalidation: candle?.invalidation ?? candidate.invalidation ?? prior.invalidation,
            invalidationPrice: evaluation.invalidationPrice,
            firstTarget: candle?.target ?? candidate.firstTarget ?? prior.firstTarget,
            firstTargetPrice: evaluation.targetPrice,
            carryReason: evaluation.carryReason,
            sourceDate: latest.date,
            sourceFiles: candidate.sourceFiles ?? prior.sourceFiles ?? [],
            eventRisk: evaluation.eventRisk,
            relativeStrength: candle?.relativeStrengthLabel ?? prior.relativeStrength ?? "Unknown",
            volumeCondition: evaluation.volumeCondition,
            sizeGuidance: evaluation.sizeGuidance,
            reviewHistory: [...(prior.reviewHistory ?? []), reviewEntry].slice(-20),
          }
        : {
            symbol: candidate.symbol,
            firstIdentifiedAt: generatedAt,
            lastReviewedAt: generatedAt,
            status: evaluation.status,
            thesis: candidate.catalyst,
            catalystOrigin: (candidate.sourceProfiles ?? []).join(", ") || "Daily candidate feed",
            setupType: candle?.setup ?? candidate.setupType ?? candidate.stance,
            entryTrigger: candle?.trigger ?? candidate.entryTrigger,
            triggerPrice: evaluation.triggerPrice,
            invalidation: candle?.invalidation ?? candidate.invalidation,
            invalidationPrice: evaluation.invalidationPrice,
            firstTarget: candle?.target ?? candidate.firstTarget,
            firstTargetPrice: evaluation.targetPrice,
            holdWindowDays: 7,
            expiryRule: "Keep only while the current trigger, invalidation, and 2R target remain valid; expire when the setup degrades or the thesis goes stale.",
            carryReason: evaluation.carryReason,
            promotionSource: "daily_candidate",
            sourceDate: latest.date,
            sourceFiles: candidate.sourceFiles ?? [],
            eventRisk: evaluation.eventRisk,
            relativeStrength: candle?.relativeStrengthLabel ?? "Unknown",
            volumeCondition: evaluation.volumeCondition,
            sizeGuidance: evaluation.sizeGuidance,
            reviewHistory: [reviewEntry],
          },
    );
  }

  for (const prior of priorBySymbol.values()) {
    if (promoted.some((candidate) => candidate.symbol === prior.symbol)) continue;
    if (["in_trade", "closed", "passed"].includes(prior.status)) {
      promoted.push(prior);
    }
  }

  return {
    generatedAt,
    reviewDate: latest.date,
    notes: "Strict swing workflow. Active names have a live numeric plan, non-lagging relative strength, acceptable reward-to-risk, and usable structure. Near-miss setups stay in a pending review bucket until they clear the hard gates.",
    candidates: promoted.sort((a, b) => a.symbol.localeCompare(b.symbol)),
  };
}

function evaluateSwingPromotion(candidate, candle) {
  const triggerText = candle?.trigger ?? candidate.entryTrigger ?? "";
  const invalidationText = candle?.invalidation ?? candidate.invalidation ?? "";
  const targetText = candle?.target ?? candidate.firstTarget ?? "";
  const triggerPrice = Number.isFinite(candidate.triggerPrice) ? candidate.triggerPrice : extractFirstNumber(triggerText);
  const invalidationPrice = Number.isFinite(candidate.invalidationPrice) ? candidate.invalidationPrice : extractFirstNumber(invalidationText);
  const targetPrice = Number.isFinite(candidate.firstTargetPrice) ? candidate.firstTargetPrice : extractFirstNumber(targetText);
  const rr = computeRewardRisk(triggerPrice, invalidationPrice, targetPrice);
  const setup = String(candle?.setup ?? "").toLowerCase();
  const relativeStrength = String(candle?.relativeStrengthLabel ?? "").toLowerCase();
  const extension = String(candle?.extensionLabel ?? "").toLowerCase();
  const catalystText = `${candidate.catalyst ?? ""} ${(candidate.notes ?? []).join(" ")}`.toLowerCase();
  const stance = String(candidate.stance ?? "");

  if (!["Buy Candidate", "Setup Watch"].includes(stance)) return { promotable: false };
  if (hasImminentEventRisk(catalystText)) return { promotable: false };
  if (!candle) {
    return {
      promotable: true,
      status: "swing_candidate_pending",
      summary: "Fresh candle data is unavailable, so the multi-day thesis can stay under review but cannot move into the active swing list yet.",
      carryReason: "Keep monitoring, but do not promote to the active swing watchlist until fresh candle data restores the technical scan.",
      eventRisk: "No immediate event blocker detected from the current source context.",
      volumeCondition: "No fresh candle scan is available yet, so volume confirmation is still pending.",
      sizeGuidance: "No entry yet. Restore the candle scan first, then reassess the trigger, invalidation, and first target.",
      triggerPrice,
      invalidationPrice,
      targetPrice,
    };
  }
  if (relativeStrength === "lagging" || relativeStrength === "laggard") return { promotable: false };

  const pendingReason =
    /no long trigger yet/.test(triggerText.toLowerCase())
      ? "No long trigger is live yet, so the thesis can stay under review but not in the active swing list."
      : triggerPrice == null || invalidationPrice == null || targetPrice == null
        ? "The setup still needs a fully numeric trigger, invalidation, and first target before it can move into the active swing list."
        : !Number.isFinite(rr) || rr < 2
          ? "Reward-to-risk is not yet at least 2:1 from the current swing plan."
          : setup === "risk / avoid"
            ? "The current scanner structure is still flagged Risk / Avoid."
            : setup === "needs more confirmation"
              ? "The current scanner structure still needs more confirmation."
              : extension === "extended"
                ? "The move is too extended right now to treat as an active swing entry."
                : null;

  if (pendingReason) {
    return {
      promotable: true,
      status: "swing_candidate_pending",
      summary: pendingReason,
      carryReason: "Keep monitoring, but do not promote to the active swing watchlist until the setup clears the hard gates.",
      eventRisk: "No immediate event blocker detected from the current source context.",
      volumeCondition: `Current volume ratio ${round(candle.volumeRatio ?? 0)}x; require confirming participation before promotion.`,
      sizeGuidance: "No entry yet. Keep this on a pending swing review until the trigger, structure, and reward-to-risk improve.",
      triggerPrice,
      invalidationPrice,
      targetPrice,
    };
  }

  const actionable = Number.isFinite(candle.close) && Number.isFinite(triggerPrice) && candle.close >= triggerPrice * 0.995;

  return {
    promotable: true,
    status: actionable ? "actionable" : "active_watch",
    summary: actionable
      ? "Promoted because the trigger, invalidation, and target are numeric and the setup is live with acceptable reward-to-risk."
      : "Promoted because the multi-day thesis is still alive and the setup has a valid numeric plan, but the trigger is not live yet.",
    carryReason: actionable
      ? "Current swing setup is live now with acceptable reward-to-risk."
      : "Current swing setup remains valid and should stay on watch until the trigger is active.",
    eventRisk: "No immediate event blocker detected from the current source context.",
    volumeCondition: `Current volume ratio ${round(candle.volumeRatio ?? 0)}x; require confirming participation on entry.`,
    sizeGuidance: actionable ? "Starter size only; add only after confirmation holds." : "No entry until trigger is live and confirmation holds.",
    triggerPrice,
    invalidationPrice,
    targetPrice,
  };
}

function hasImminentEventRisk(text) {
  return /after the close|after close|after market close|this afternoon|tomorrow before the open|tomorrow before market open|reports tomorrow|will report tomorrow|report today after the close|will report today after close|due to release .* this afternoon/.test(text);
}

function computeRewardRisk(triggerPrice, invalidationPrice, targetPrice) {
  if (![triggerPrice, invalidationPrice, targetPrice].every((value) => Number.isFinite(value))) return null;
  const risk = Math.abs(triggerPrice - invalidationPrice);
  const reward = Math.abs(targetPrice - triggerPrice);
  if (!Number.isFinite(risk) || risk <= 0) return null;
  return reward / risk;
}

function preserveHigherPriorityStatus(previousStatus, nextStatus) {
  if (previousStatus === "in_trade") return previousStatus;
  if (previousStatus === "actionable" && nextStatus === "active_watch") return previousStatus;
  return nextStatus;
}

function extractFirstNumber(text) {
  const normalized = String(text ?? "").replace(/\b\d+(?:\.\d+)?:1\b/g, " ");
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function round(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) / 100 : null;
}

function renderTickerBoard(tickers, sources = []) {
  if (!tickers.length) return `<p class="empty">No tickers detected in today&apos;s source material.</p>`;

  return `<div class="list">${tickers
    .map(
      (ticker) => {
        const sourceItems = collectTickerSourceItems(sources, ticker.symbol);
        return `<article class="item">
        <div class="row">
          <span class="ticker">${escapeHtml(ticker.symbol)}</span>
          <span>${ticker.sources?.length === 1 ? "1 source" : `${ticker.sources?.length ?? 0} sources`}</span>
        </div>
        <p class="note">${escapeHtml((ticker.notes ?? [])[0] ?? "Mentioned without a nearby explanatory note.")}</p>
        ${
          sourceItems.length
            ? `<div class="list" style="margin-top: 10px;">${sourceItems
                .slice(0, 3)
                .map(
                  (item) => `<article class="item">
                    <p class="note"><strong>${escapeHtml(item.sourceTitle)}</strong>${item.title ? ` | ${escapeHtml(item.title)}` : ""}</p>
                    <p class="note">${escapeHtml(item.text)}</p>
                    ${renderLinkButtons(item.links, 3)}
                  </article>`,
                )
                .join("")}</div>`
            : ""
        }
        <div>${(ticker.sources ?? []).map((source) => `<span class="tag">${escapeHtml(source)}</span>`).join("")}</div>
      </article>`;
      },
    )
    .join("")}</div>`;
}

function renderMacro(macro) {
  if (!macro) return `<p class="empty">No macro backdrop detected yet.</p>`;
  const drivers = summarizeMacroDrivers(macro);

  return `<div>
    <div class="row">
      <strong>${escapeHtml(macro.tone)}</strong>
      <span class="score">${escapeHtml(macro.score)}</span>
    </div>
    <div class="macro-explainer">${escapeHtml(describeMacroTone(macro.tone))}</div>
    <div class="list" style="margin-top: 12px;">
      ${(macro.beforeBuying ?? []).map((check) => `<article class="item"><p>${escapeHtml(check)}</p></article>`).join("")}
    </div>
    <div class="list" style="margin-top: 12px;">
      ${drivers.map((item) => `<article class="item">
        <div class="row"><strong>${escapeHtml(item.category)}</strong><span>${item.bias}</span></div>
        <div class="checklist">${item.conditions.map((condition) => `<div>${escapeHtml(condition)}</div>`).join("")}</div>
        ${(item.links ?? []).length ? renderLinkButtons(item.links, 1) : ""}
      </article>`).join("")}
    </div>
  </div>`;
}

function renderSchwabPanel(summary, latestDay, selectedAccount = null) {
  if (!summary?.ok) {
    const note = summary?.reason || "Schwab is not connected yet.";
    return `<div>
      <p class="note">${escapeHtml(note)}</p>
      <p class="note" style="margin-top: 10px;"><strong>Next step:</strong> add <code>SCHWAB_APP_KEY</code>, <code>SCHWAB_APP_SECRET</code>, and <code>SCHWAB_CALLBACK_URL</code> to <code>.env</code>, then run <code>npm run schwab:connect</code> followed by <code>npm run schwab:sync -- --date ${escapeHtml(latestDay?.date ?? "YYYY-MM-DD")}</code>.</p>
    </div>`;
  }

  const holdings = selectedAccount?.positions ?? [];
  const selectedLabel = selectedAccount ? `${selectedAccount.displayName} (${selectedAccount.accountNumberMasked})` : "No account selected";

  return `<div>
    <div class="list">
      <article class="item">
        <div class="row"><strong>${escapeHtml(selectedLabel)}</strong><span class="score">${escapeHtml(formatCompactCurrency(selectedAccount?.balances?.liquidationValue ?? summary.totals?.equity))}</span></div>
        <div class="checklist">
          <div>Cash: ${escapeHtml(formatCompactCurrency(selectedAccount?.balances?.cashBalance ?? summary.totals?.cash))}</div>
          <div>Buying power: ${escapeHtml(formatCompactCurrency(selectedAccount?.balances?.buyingPower ?? summary.totals?.buyingPower))}</div>
          <div>${escapeHtml(String(selectedAccount?.positions?.length ?? 0))} position(s) in focus</div>
        </div>
      </article>
    </div>
    ${
      holdings.length
        ? `<div class="list" style="margin-top: 12px;">
            ${holdings
              .slice(0, 5)
              .map(
                (holding) => `<article class="item">
                  <div class="row"><strong>${escapeHtml(holding.symbol)}</strong><span>${escapeHtml(formatCompactCurrency(holding.marketValue))}</span></div>
                  <p class="note">${escapeHtml(holding.description || "Held position")}</p>
                  <div class="checklist">
                    <div>Shares: ${escapeHtml(formatHoldingQuantity(holding.netQuantity))}</div>
                    <div>Day P/L: ${escapeHtml(formatSignedCurrency(holding.dayProfitLoss))}</div>
                  </div>
                </article>`,
              )
              .join("")}
          </div>`
        : `<p class="empty" style="margin-top: 12px;">No positions were returned for the selected Schwab account.</p>`
    }
    <p class="note" style="margin-top: 12px;">Last synced ${escapeHtml(formatDateTime(summary.syncedAt))}</p>
  </div>`;
}

function renderMyHoldings(selectedAccount, summary) {
  if (!summary?.ok) return `<p class="empty">Schwab is not connected yet.</p>`;
  if (!selectedAccount) return `<p class="empty">No Schwab account matched the current holdings filter.</p>`;

  const positions = [...(selectedAccount.positions ?? [])].sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0));

  return `<div class="list">
    <article class="item">
      <div class="row">
        <div>
          <span class="ticker">${escapeHtml(selectedAccount.displayName || "Selected account")}</span>
          <span class="tag">${escapeHtml(selectedAccount.accountNumberMasked || "")}</span>
          <span class="tag">${escapeHtml(selectedAccount.type || "Brokerage")}</span>
        </div>
        <span class="score">${escapeHtml(formatCompactCurrency(selectedAccount.balances?.liquidationValue))}</span>
      </div>
      <p class="note"><strong>Cash:</strong> ${escapeHtml(formatCompactCurrency(selectedAccount.balances?.cashBalance))}</p>
      <p class="note"><strong>Buying power:</strong> ${escapeHtml(formatCompactCurrency(selectedAccount.balances?.buyingPower))}</p>
      <p class="note"><strong>Positions:</strong> ${escapeHtml(String(positions.length))}</p>
    </article>
    ${positions.length
      ? positions
          .map(
            (position) => `<article class="item">
              <div class="row">
                <div>
                  <span class="ticker">${escapeHtml(position.symbol)}</span>
                  <span class="tag">${escapeHtml(position.assetType || "Holding")}</span>
                </div>
                <span class="score">${escapeHtml(formatCompactCurrency(position.marketValue))}</span>
              </div>
              <p class="note">${escapeHtml(position.description || "Held position")}</p>
              <div class="trade-plan">
                <div><strong>Shares</strong>${escapeHtml(formatHoldingQuantity(position.netQuantity))}</div>
                <div><strong>Average price</strong>${escapeHtml(formatCompactCurrency(position.averagePrice))}</div>
                <div><strong>Day P/L</strong>${escapeHtml(formatSignedCurrency(position.dayProfitLoss))}</div>
                <div><strong>Day P/L %</strong>${escapeHtml(formatPercent(position.dayProfitLossPercent))}</div>
              </div>
            </article>`,
          )
          .join("")
      : `<p class="empty">No holdings are currently present in the selected account.</p>`}
  </div>`;
}

function renderPaperPortfolio(portfolio, latestDay) {
  if (!portfolio?.ok) {
    return `<div>
      <p class="note">No paper portfolio has been loaded yet.</p>
      <p class="note" style="margin-top: 10px;"><strong>Next step:</strong> edit <code>data/paper-portfolio/latest.json</code> or create <code>data/paper-portfolio/${escapeHtml(latestDay?.date ?? "YYYY-MM-DD")}.json</code> to track your simulated positions here.</p>
    </div>`;
  }

  const positions = [...(portfolio.positions ?? [])].sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0));
  const ledger = [...(portfolio.ledger ?? portfolio.trades ?? portfolio.transactions ?? [])].sort((a, b) =>
    String(b.executedAt ?? b.timestamp ?? b.date ?? "").localeCompare(String(a.executedAt ?? a.timestamp ?? a.date ?? "")),
  );
  const cash = Number(portfolio.cash ?? 0);
  const marketValue = positions.reduce((sum, position) => sum + Number(position.marketValue ?? 0), 0);
  const equity = Number(portfolio.equity ?? cash + marketValue);

  return `<div class="list">
    <article class="item">
      <div class="row">
        <div>
          <span class="ticker">${escapeHtml(portfolio.name || "Paper Portfolio")}</span>
          <span class="tag">${escapeHtml(portfolio.mode || "Simulated")}</span>
        </div>
        <span class="score">${escapeHtml(formatCompactCurrency(equity))}</span>
      </div>
      <p class="note"><strong>Cash:</strong> ${escapeHtml(formatCompactCurrency(cash))}</p>
      <p class="note"><strong>Market value:</strong> ${escapeHtml(formatCompactCurrency(marketValue))}</p>
      <p class="note"><strong>Positions:</strong> ${escapeHtml(String(positions.length))}</p>
      ${portfolio.notes ? `<p class="note"><strong>Notes:</strong> ${escapeHtml(portfolio.notes)}</p>` : ""}
    </article>
      ${positions.length
      ? positions
          .map(
            (position) => `<article class="item">
              <div class="row">
                <div>
                  <span class="ticker">${escapeHtml(position.symbol)}</span>
                  <span class="tag">${escapeHtml(position.status || "Open")}</span>
                </div>
                <span class="score">${escapeHtml(formatCompactCurrency(position.marketValue))}</span>
              </div>
              <p class="note">${escapeHtml(position.thesis || position.description || "Simulated position")}</p>
              <div class="trade-plan">
                <div><strong>Shares</strong>${escapeHtml(formatHoldingQuantity(position.quantity))}</div>
                <div><strong>Entry</strong>${escapeHtml(formatCompactCurrency(position.entryPrice))}</div>
                <div><strong>Last</strong>${escapeHtml(formatCompactCurrency(position.lastPrice))}</div>
                <div><strong>P/L</strong>${escapeHtml(formatSignedCurrency(position.unrealizedProfitLoss))}</div>
              </div>
            </article>`,
          )
          .join("")
      : `<p class="empty">No simulated positions are currently tracked.</p>`}
    <article class="item">
      <div class="row">
        <div>
          <span class="ticker">Simulated Trade Ledger</span>
          <span class="tag">${escapeHtml(String(ledger.length))} entries</span>
        </div>
      </div>
      ${ledger.length
        ? `<div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Action</th>
                  <th>Symbol</th>
                  <th>Qty</th>
                  <th>Price</th>
                  <th>Notional</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                ${ledger.map((entry) => renderPaperLedgerRow(entry)).join("")}
              </tbody>
            </table>
          </div>`
        : `<p class="empty">No simulated trades have been recorded yet.</p>`}
    </article>
  </div>`;
}

function renderPaperLedgerRow(entry) {
  const quantity = Number(entry.quantity ?? entry.qty ?? entry.contracts ?? 0);
  const price = Number(entry.price ?? entry.entryPrice ?? entry.fillPrice ?? 0);
  const notional = Number(entry.notional ?? (Number.isFinite(quantity) && Number.isFinite(price) ? quantity * price : 0));
  const action = entry.action ?? entry.side ?? entry.type ?? "TRADE";
  return `<tr>
    <td>${escapeHtml(formatDateTime(entry.executedAt ?? entry.timestamp ?? entry.date))}</td>
    <td>${escapeHtml(String(action).toUpperCase())}</td>
    <td>${escapeHtml(entry.symbol ?? "")}</td>
    <td>${escapeHtml(formatHoldingQuantity(quantity))}</td>
    <td>${escapeHtml(formatCompactCurrency(price))}</td>
    <td>${escapeHtml(formatCompactCurrency(notional))}</td>
    <td>${escapeHtml(entry.status ?? "Simulated")}</td>
  </tr>`;
}

function summarizeMacroDrivers(macro) {
  const items = macro?.items ?? [];
  const grouped = new Map();

  for (const item of items ?? []) {
    const category = macroCategoryForThemes([item.theme]);
    const current = grouped.get(category) ?? {
      category,
      conditions: [],
      biasScore: 0,
      links: [],
      themes: [],
    };

    const condition = macroConditionForCategory(category, item.note);
    if (condition && !current.conditions.some((entry) => normalizeMacroKey(entry) === normalizeMacroKey(condition))) {
      current.conditions.push(condition);
    }
    current.biasScore += item.risk;
    current.themes.push(item.theme);
    current.links = uniqueLinkItems([...current.links, ...(item.links ?? [])]);
    grouped.set(category, current);
  }

  if (grouped.has("Risk Appetite")) {
    const current = grouped.get("Risk Appetite");
    current.conditions = [buildRiskAppetiteCondition(macro)];
    grouped.set("Risk Appetite", current);
  }

  return [...grouped.values()]
    .map((item) => ({
      ...item,
      themes: uniqueValues(item.themes).slice(0, 3),
      bias: item.biasScore > 0 ? "pressure" : item.biasScore < 0 ? "support" : "mixed",
      strength: Math.abs(item.biasScore),
      conditions: item.conditions.slice(0, 3),
      links: item.links.slice(0, 1),
    }))
    .filter((item) => item.conditions.length > 0)
    .sort((a, b) => b.strength - a.strength || a.category.localeCompare(b.category))
    .slice(0, 4);
}

function macroCategoryForThemes(themes) {
  const labels = uniqueValues(themes);
  if (labels.some((theme) => /market strength|market weakness/i.test(theme))) return "Risk Appetite";
  if (labels.some((theme) => /ai infrastructure/i.test(theme))) return "AI / Semis";
  if (labels.some((theme) => /geopolitical risk|oil shock/i.test(theme))) return "Geopolitics / Energy";
  if (labels.some((theme) => /fed and rates/i.test(theme))) return "Rates / Fed";
  if (labels.some((theme) => /tariffs and trade/i.test(theme))) return "Trade / Policy";
  return labels[0] || "Macro";
}

function buildRiskAppetiteCondition(macro) {
  const tone = String(macro?.tone ?? "").trim();
  const checks = macro?.beforeBuying ?? [];

  if (tone === "Risk-On") {
    if (checks.some((check) => /breadth confirms/i.test(check))) {
      return "Breadth and tape tone are supportive. The market is more willing to reward fresh upside catalysts if follow-through holds.";
    }
    return "The tape is leaning risk-on. Strong setups have a better chance of follow-through than they would in a defensive session.";
  }

  if (tone === "Risk-Off") {
    return "The tape is defensive. Longs need cleaner confirmation, smaller size, and more patience before chasing strength.";
  }

  return "The tape is mixed. Selective setups can work, but stock picking matters more than broad market tailwind.";
}

function normalizeMacroKey(note) {
  return String(note ?? "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .toLowerCase()
    .trim()
    .slice(0, 160);
}

function compactMacroNote(note) {
  const cleaned = String(note ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\*+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 220 ? `${cleaned.slice(0, 219).trimEnd()}…` : cleaned;
}

function macroConditionForCategory(category, note) {
  const cleaned = compactMacroNote(note);
  if (!cleaned) return "";

  if (category === "Risk Appetite") {
    if (!/\b(S&P|Nasdaq|Dow|record highs?|higher open|futures|breadth|risk-on|risk off|chip stocks)\b/i.test(cleaned)) {
      return "";
    }
    return cleaned;
  }

  if (category === "Geopolitics / Energy") {
    if (!/\b(oil|crude|iran|war|ceasefire|hormuz|tanker|attack ships|conflict)\b/i.test(cleaned)) {
      return "";
    }
    return cleaned;
  }

  if (category === "Rates / Fed") {
    if (!/\b(fed|federal reserve|rate cuts?|treasury|yield|monetary policy)\b/i.test(cleaned)) {
      return "";
    }
    return cleaned;
  }

  if (category === "Trade / Policy") {
    if (!/\b(tariff|trade|policy|refund)\b/i.test(cleaned)) {
      return "";
    }
    return cleaned;
  }

  if (category === "AI / Semis") {
    if (!/\b(ai|artificial intelligence|nvidia|data center|chip stocks|gpu|semiconductor|semis)\b/i.test(cleaned)) {
      return "";
    }
    return cleaned;
  }

  return cleaned;
}

function uniqueLinkItems(links) {
  const seen = new Set();
  return (links ?? []).filter((link) => {
    if (!link?.url || seen.has(link.url)) return false;
    seen.add(link.url);
    return true;
  });
}

function uniqueValues(values) {
  return [...new Set((values ?? []).filter(Boolean))];
}

function describeMacroTone(tone) {
  const normalized = String(tone ?? "").trim().toLowerCase();

  if (normalized === "risk-on") {
    return "This says the broader market is supportive of long ideas right now. Strong setups still need discipline, but the tape is more likely to reward follow-through.";
  }

  if (normalized === "risk-off") {
    return "This says the broader market is defensive right now. Long setups can still work, but we should be pickier, avoid chasing, and usually size a little smaller.";
  }

  return "This says the market backdrop is mixed rather than clearly supportive or clearly defensive. Stock selection matters more, and confirmation becomes more important.";
}

function describeRiskRecommendation(tone) {
  const normalized = String(tone ?? "").trim().toLowerCase();

  if (normalized === "risk-on") {
    return "Recommendation: lean more constructive, but still wait for confirmation. Favor strong names that hold their open and reward follow-through.";
  }

  if (normalized === "risk-off") {
    return "Recommendation: be selective and smaller. Avoid chasing strength and treat long setups as lower-conviction until the tape firms up.";
  }

  return "Recommendation: stay balanced. Let price action prove itself, focus on the cleanest setups, and avoid forcing trades from mixed signals.";
}

function formatToneLabel(tone) {
  const normalized = String(tone ?? "").trim().toLowerCase();

  if (normalized === "risk-on") return "Constructive";
  if (normalized === "risk-off") return "Defensive";
  return "Mixed";
}

function renderDailyTradeCandidates(
  payload,
  swingBySymbol = new Map(),
  candleBySymbol = new Map(),
  newsBySymbol = new Map(),
  schwabBySymbol = new Map(),
  verificationBySymbol = new Map(),
  latestDay = null,
) {
  const candidates = payload?.candidates ?? [];
  if (!candidates.length) return `<p class="empty">No candidates scored from today&apos;s source material.</p>`;

  const visible = candidates.filter((candidate) => candidate.stance !== "Low Priority");
  const shown = visible.length ? visible : candidates.slice(0, 5);

  return `<div class="section-head">
      <div class="section-label">Current Session</div>
      <h3>Today&apos;s Trade Candidates</h3>
      <p class="note">${escapeHtml(payload?.notes ?? "Current-session ideas. These expire by the close unless promoted into the swing watchlist.")}</p>
    </div>
    ${renderCandidatesGlossary()}
    <div class="list">${shown
    .map((candidate) => {
      const swing = swingBySymbol.get(candidate.symbol);
      const candle = candleBySymbol.get(candidate.symbol);
      const news = newsBySymbol.get(candidate.symbol) ?? null;
      const holding = schwabBySymbol.get(candidate.symbol) ?? null;
      const verification = verificationBySymbol.get(candidate.symbol) ?? {
        state: "not_run",
        summary: "No verification has been run for this candidate yet.",
      };
      const agentBrief = buildCandidateAgentBrief(candidate, swing, candle, latestDay, holding);
      const briefId = `agent-brief-${candidate.symbol.toLowerCase()}`;

      return `<article class="item">
        <div class="row">
          <div>
            <span class="ticker">${escapeHtml(candidate.symbol)}</span>
            <span class="tag">${escapeHtml(candidate.status ?? candidate.stance)}</span>
            <span class="tag">${escapeHtml(candidate.stance)}</span>
            ${swing ? `<span class="tag">${escapeHtml(swing.setup.name)}</span>` : ""}
            ${news ? `<span class="tag ${escapeHtml(newsSentimentClass(news.sentiment))}">${escapeHtml(formatNewsBadge(news))}</span>` : ""}
            ${holding ? `<span class="tag tag-positive">In account</span>` : ""}
          </div>
          <span class="score">${candidate.score}</span>
        </div>
        <p class="note">${escapeHtml(candidate.catalyst ?? candidate.evidence ?? "")}</p>
        <p class="note"><strong>Setup:</strong> ${escapeHtml(candidate.setupType ?? "Needs review")}</p>
        <p class="note"><strong>Trigger:</strong> ${escapeHtml(candidate.entryTrigger ?? candidate.nextCheck ?? "")}</p>
        <p class="note"><strong>Invalidation:</strong> ${escapeHtml(candidate.invalidation ?? "Define invalidation before entry.")}</p>
        <p class="note"><strong>Target:</strong> ${escapeHtml(candidate.firstTarget ?? "Define first target before entry.")}</p>
        <p class="note"><strong>Promotion to swing:</strong> ${candidate.promotionEligible ? escapeHtml(candidate.promotionReason || "Eligible if the thesis survives the first session.") : "Not eligible yet."}</p>
        ${holding ? `<p class="note"><strong>Schwab context:</strong> ${escapeHtml(formatHoldingSummary(holding))}</p>` : ""}
        ${renderCandidateNews(news)}
        ${
          swing
            ? `<div class="trade-plan">
                <div><strong>Trigger</strong>${escapeHtml(swing.trigger)}</div>
                <div><strong>Stop</strong>${escapeHtml(swing.stop)}</div>
                <div><strong>Target</strong>${escapeHtml(swing.target)}</div>
                <div><strong>Sizing</strong>${escapeHtml(swing.sizing)}</div>
              </div>`
            : ""
        }
        <section class="verification-panel" data-verification-card="${escapeHtml(candidate.symbol)}">
          <div class="verification-header">
            <div>
              <div class="verification-title">Candidate Verification</div>
              <div class="verification-status">
                <span class="verification-badge ${escapeHtml(verificationBadgeClass(verification.state))}" data-verification-badge>${escapeHtml(formatVerificationState(verification.state))}</span>
                <span class="verification-timestamp" data-verification-timestamp>${escapeHtml(formatVerificationTimestamp(verification.verifiedAt))}</span>
              </div>
            </div>
          </div>
          <div class="verification-actions">
            <button class="button" type="button" data-run-verification="${escapeHtml(candidate.symbol)}">Run Verification</button>
          </div>
          <div data-verification-body>${renderVerificationResult(verification)}</div>
        </section>
        <details class="agent-brief">
          <summary>
            <span class="agent-brief-title">Agent Brief</span>
            <span class="swing-glossary-icon" aria-hidden="true">▾</span>
          </summary>
          <div class="agent-brief-body">
            <pre class="agent-brief-text" id="${escapeHtml(briefId)}">${escapeHtml(agentBrief)}</pre>
            <button class="button agent-brief-copy" type="button" data-copy-agent-brief="${escapeHtml(briefId)}">Copy agent brief</button>
          </div>
        </details>
        <div>${(candidate.sourceProfiles ?? []).map((profile) => `<span class="tag">${escapeHtml(profile)}</span>`).join("")}</div>
        <div>${(candidate.sourceFiles ?? candidate.sources ?? []).map((source) => `<span class="tag">${escapeHtml(source)}</span>`).join("")}</div>
      </article>`;
    })
    .join("")}</div>`;
}

function renderSwingWatchlist(payload, latestDay = null) {
  const candidates = payload?.candidates ?? [];
  if (!candidates.length) {
    return `<div class="section-head">
      <div class="section-label">Persistent Multi-Day Setups</div>
      <h3>Active Swing Watchlist</h3>
      <p class="note">No active multi-day swing candidates are being carried right now.</p>
    </div>`;
  }

  const active = candidates.filter((candidate) => ["active_watch", "actionable", "in_trade"].includes(candidate.status));
  const pending = candidates.filter((candidate) => candidate.status === "swing_candidate_pending");

  const renderSwingCards = (items) =>
    `<div class="list">${items
      .map((candidate) => {
        const latestReview = (candidate.reviewHistory ?? []).at(-1) ?? null;

        return `<article class="item">
          <div class="row">
            <div>
              <span class="ticker">${escapeHtml(candidate.symbol)}</span>
              <span class="tag">${escapeHtml(candidate.status)}</span>
              <span class="tag">${escapeHtml(candidate.setupType ?? "Swing")}</span>
            </div>
            <span class="score">${escapeHtml(candidate.sourceDate ?? latestDay?.date ?? "")}</span>
          </div>
          <p class="note"><strong>Thesis:</strong> ${escapeHtml(candidate.thesis ?? "")}</p>
          <p class="note"><strong>Carry reason:</strong> ${escapeHtml(candidate.carryReason ?? "")}</p>
          <div class="trade-plan">
            <div><strong>Trigger</strong>${escapeHtml(candidate.entryTrigger ?? "")}</div>
            <div><strong>Invalidation</strong>${escapeHtml(candidate.invalidation ?? "")}</div>
            <div><strong>First target</strong>${escapeHtml(candidate.firstTarget ?? "")}</div>
            <div><strong>Expiry rule</strong>${escapeHtml(candidate.expiryRule ?? "")}</div>
          </div>
          <p class="note"><strong>First identified:</strong> ${escapeHtml(formatDateTime(candidate.firstIdentifiedAt))}</p>
          <p class="note"><strong>Last reviewed:</strong> ${escapeHtml(formatDateTime(candidate.lastReviewedAt))}</p>
          ${latestReview ? `<p class="note"><strong>Latest review:</strong> ${escapeHtml(latestReview.summary ?? "")}</p>` : ""}
          <div>${(candidate.sourceFiles ?? []).map((source) => `<span class="tag">${escapeHtml(source)}</span>`).join("")}</div>
        </article>`;
      })
      .join("")}</div>`;

  return `<div class="section-head">
      <div class="section-label">Persistent Multi-Day Setups</div>
      <h3>Active Swing Watchlist</h3>
      <p class="note">${escapeHtml(payload?.notes ?? "These setups persist across sessions until triggered, invalidated, expired, or closed.")}</p>
    </div>
    ${active.length ? renderSwingCards(active) : `<p class="empty">No active multi-day swing candidates are being carried right now.</p>`}
    ${
      pending.length
        ? `<div class="section-head">
            <div class="section-label">Pending Review</div>
            <h3>Pending Swing Candidates</h3>
            <p class="note">These setups still have a live multi-day thesis, but they have not cleared the active swing gates yet.</p>
          </div>
          ${renderSwingCards(pending)}`
        : ""
    }`;
}

function renderVerificationResult(record) {
  const parts = [];

  if (record.summary) {
    parts.push(`<p class="verification-summary">${escapeHtml(record.summary)}</p>`);
  }

  if ((record.why ?? []).length) {
    parts.push(`<ul class="verification-list">${record.why.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`);
  }

  if (record.orderPlan) {
    const orderFields = record.orderPlan.ok
      ? [
          ["Order ticket", "Executable now"],
          ["Entry style", record.orderPlan.style],
          ["Entry", record.orderPlan.entry],
          ["Stop", record.orderPlan.stop],
          ["First target", record.orderPlan.target],
        ]
      : [
          ["Order ticket", "Not executable"],
          ["Rejection reason", record.orderPlan.reason],
        ];

    parts.push(`<div class="trade-plan">${orderFields
      .map(([label, value]) => `<div><strong>${escapeHtml(label)}</strong>${escapeHtml(String(value ?? ""))}</div>`)
      .join("")}</div>`);

    if (!record.orderPlan.ok && (record.orderPlan.reasons ?? []).length > 1) {
      parts.push(`<ul class="verification-list">${record.orderPlan.reasons
        .slice(1)
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join("")}</ul>`);
    }
  }

  const fields = [
    ["Entry plan", record.entryPlan],
    ["Risk plan", record.riskPlan],
    ["Target plan", record.targetPlan],
    ["Blocking issue", record.blockingIssue],
    ["Freshness", record.freshness],
    ["Account context", record.schwabHolding ? formatHoldingSummary(record.schwabHolding) : ""],
  ].filter(([, value]) => value);

  if (fields.length) {
    parts.push(`<div class="trade-plan">${fields
      .map(([label, value]) => `<div><strong>${escapeHtml(label)}</strong>${escapeHtml(value)}</div>`)
      .join("")}</div>`);
  }

  if ((record.marketauxNews ?? []).length) {
    parts.push(`<p class="verification-meta"><strong>Marketaux:</strong> ${escapeHtml(record.marketauxSentiment ?? "unknown")}</p>`);
    parts.push(`<ul class="verification-list">${record.marketauxNews
      .map((item) => `<li>${escapeHtml(item.title ?? "Untitled headline")} <span class="note">(${escapeHtml(item.source ?? "Unknown source")})</span></li>`)
      .join("")}</ul>`);
  }

  if ((record.sourcesUsed ?? []).length) {
    parts.push(`<p class="verification-meta"><strong>Sources checked:</strong> ${escapeHtml(record.sourcesUsed.join(", "))}</p>`);
  }

  return parts.join("");
}

function renderCandidateNews(news) {
  if (!news?.headlines?.length) return "";

  return `<details class="agent-brief">
    <summary>
      <span class="agent-brief-title">Recent News</span>
      <span class="swing-glossary-icon" aria-hidden="true">▾</span>
    </summary>
    <div class="agent-brief-body">
      <p class="verification-meta"><strong>Marketaux sentiment:</strong> ${escapeHtml(news.sentiment ?? "unknown")}</p>
      <ul class="verification-list">${news.headlines
        .slice(0, 3)
        .map((item) => `<li>${escapeHtml(item.title ?? "Untitled headline")} <span class="note">(${escapeHtml(item.source ?? "Unknown source")}, ${escapeHtml(formatNewsPublished(item.publishedAt))})</span></li>`)
        .join("")}</ul>
    </div>
  </details>`;
}

function verificationBadgeClass(state) {
  return String(state ?? "not_run").replaceAll("_", "-").toLowerCase();
}

function formatVerificationState(state) {
  if (state === "actionable_now") return "Actionable now";
  if (state === "watchlist_only") return "Watchlist only";
  if (state === "pass") return "Pass";
  if (state === "running") return "Running";
  if (state === "error") return "Error";
  if (state === "stale") return "Stale";
  return "Not run";
}

function formatVerificationTimestamp(value) {
  if (!value) return "";

  try {
    return `Last checked ${new Date(value).toLocaleString()}`;
  } catch {
    return "";
  }
}

function formatNewsBadge(news) {
  const sentiment = String(news?.sentiment ?? "unknown").toLowerCase();
  const count = Number(news?.count ?? 0);
  if (!count) return "No fresh news";
  if (sentiment === "positive") return `${count} positive headline${count === 1 ? "" : "s"}`;
  if (sentiment === "negative") return `${count} negative headline${count === 1 ? "" : "s"}`;
  if (sentiment === "neutral") return `${count} recent headline${count === 1 ? "" : "s"}`;
  return `${count} Marketaux hit${count === 1 ? "" : "s"}`;
}

function newsSentimentClass(sentiment) {
  const normalized = String(sentiment ?? "").toLowerCase();
  if (normalized === "positive") return "tag-positive";
  if (normalized === "negative") return "tag-negative";
  return "tag-neutral";
}

function formatNewsPublished(value) {
  if (!value) return "time unknown";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "time unknown";
  }
}

function formatHoldingSummary(holding) {
  if (!holding) return "Not currently held.";
  const accounts = Array.isArray(holding.accounts) ? holding.accounts.length : 0;
  const accountLabel = accounts === 1 ? "1 account" : `${accounts} accounts`;
  return `${formatHoldingQuantity(holding.totalQuantity)} shares, about ${formatCompactCurrency(holding.totalMarketValue)} across ${accountLabel}.`;
}

function formatHoldingQuantity(value) {
  const quantity = Number(value);
  if (!Number.isFinite(quantity)) return "0";
  return Math.abs(quantity % 1) < 0.000001 ? String(Math.abs(quantity)) : String(Math.abs(Math.round(quantity * 100) / 100));
}

function formatCompactCurrency(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "n/a";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatSignedCurrency(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "n/a";
  const prefix = amount > 0 ? "+" : "";
  return `${prefix}${formatCompactCurrency(amount)}`;
}

function formatDateTime(value) {
  if (!value) return "unknown";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "unknown";
  }
}

function formatPercent(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "n/a";
  const prefix = amount > 0 ? "+" : "";
  return `${prefix}${Math.round(amount * 100) / 100}%`;
}

function resolveSelectedSchwabAccount(summary) {
  if (!summary?.ok) return null;
  const accounts = summary.accounts ?? [];
  if (!accounts.length) return null;

  const matcher = String(SCHWAB_HOLDINGS_ACCOUNT || "").trim().toLowerCase();
  if (matcher) {
    const matched = accounts.find((account) => {
      const last4 = String(account.accountNumberMasked || "").replace(/[^0-9]/g, "");
      return (
        String(account.accountHash || "").toLowerCase() === matcher ||
        String(account.displayName || "").toLowerCase() === matcher ||
        last4 === matcher
      );
    });
    if (matched) return buildSelectedSchwabAccount(summary, matched);
  }

  const withPositions = accounts.find((account) => (account.positions?.length ?? 0) > 0);
  return buildSelectedSchwabAccount(summary, withPositions || accounts[0]);
}

function buildSelectedSchwabAccount(summary, account) {
  if (!account) return null;
  const positionsBySymbol = Object.fromEntries(
    (account.positions ?? []).map((position) => [
      position.symbol,
      {
        symbol: position.symbol,
        description: position.description,
        assetType: position.assetType,
        totalQuantity: position.netQuantity,
        totalMarketValue: position.marketValue,
        totalDayProfitLoss: position.dayProfitLoss,
        accounts: [
          {
            accountHash: account.accountHash,
            accountNumberMasked: account.accountNumberMasked,
            displayName: account.displayName,
            quantity: position.netQuantity,
            marketValue: position.marketValue,
          },
        ],
      },
    ]),
  );

  return {
    ...account,
    positionsBySymbol,
    topHoldings: [...(account.positions ?? [])].sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0)),
    parentTotals: summary.totals,
  };
}

function buildCandidateAgentBrief(candidate, swing, candle, latestDay, holding = null) {
  const lines = [
    `Review ${candidate.symbol} as a possible swing trade candidate for ${latestDay?.date ?? "today"}.`,
    "",
    "Goal:",
    `Decide whether this name is actionable now, still a watchlist candidate, or a pass.`,
    "",
    "Source-backed context:",
    `- Candidate stance: ${candidate.stance}`,
    `- Score: ${candidate.score}`,
    `- Evidence: ${candidate.evidence}`,
    `- Why it ranks: ${(candidate.positives ?? []).join(", ") || "Needs more confirmation"}`,
    `- Risk flags: ${(candidate.risks ?? []).join(", ") || "None listed"}`,
    `- Before buying: ${candidate.nextCheck}`,
  ];

  if (holding) {
    lines.push(
      "",
      "Schwab account context:",
      `- Existing holding: ${formatHoldingSummary(holding)}`,
    );
  }

  if (swing) {
    lines.push(
      "",
      "Swing setup overlay:",
      `- Setup: ${swing.setup.name}`,
      `- Trigger: ${swing.trigger}`,
      `- Stop: ${swing.stop}`,
      `- Target: ${swing.target}`,
      `- Sizing: ${swing.sizing}`,
    );
  }

  if (candle) {
    lines.push(
      "",
      "Chart and scanner context:",
      `- Scanner setup: ${candle.setup ?? "Unknown"}`,
      `- Pattern: ${candle.pattern ?? "None"}`,
      `- Trend: ${candle.trend ?? "Unknown"}`,
      `- Relative strength: ${candle.relativeStrengthLabel ?? "Unknown"} (${formatRelativeStrength(candle)})`,
      `- Trigger: ${candle.trigger ?? "None"}`,
      `- Invalidation: ${candle.invalidation ?? "None"}`,
      `- Target: ${candle.target ?? "None"}`,
      `- Scores: breakout ${candle.breakoutScore ?? "n/a"}, pullback ${candle.pullbackScore ?? "n/a"}, relative strength ${candle.relativeStrengthScore ?? "n/a"}`,
    );
  }

  lines.push(
    "",
    "Verification checklist:",
    "1. Check whether price is still respecting the trigger zone or support area.",
    "2. Check whether volume confirms the move instead of fading.",
    "3. Check for any new news, guidance changes, downgrades, or event risk since the email arrived.",
    "4. Check whether the stock is leading or lagging versus SPY, QQQ, and its sector today.",
    "5. Check whether reward-to-risk still makes sense using the listed trigger, stop, and first target.",
    "",
    "Return format:",
    "- Verdict: Actionable now / Watchlist only / Pass",
    "- Why: 3 to 5 concise bullets",
    "- Entry plan: exact trigger level or condition",
    "- Risk plan: exact invalidation / stop logic",
    "- Target plan: first target and what would justify holding longer",
    "- Blocking issue: the main reason not to take it yet, if any",
  );

  return lines.join("\n");
}

function renderCandidatesGlossary() {
  const fields = [
    {
      term: "Evidence",
      meaning: "The core reason the stock showed up today. Think of this as the headline case for why it deserves attention.",
    },
    {
      term: "Why it ranks",
      meaning: "The strongest positive factors behind the score, such as earnings, price reaction, repeated source support, or a strong theme.",
    },
    {
      term: "Risk",
      meaning: "The main reasons the idea could fail or become less attractive, even if the story sounds compelling.",
    },
    {
      term: "Before buying",
      meaning: "The confirmation we still want before acting. This is the 'slow down and verify' line.",
    },
    {
      term: "Trigger / Stop / Target / Sizing",
      meaning: "These come from the swing setup overlay and turn a ranked idea into a possible trade plan with entry, risk, upside, and position-size guidance.",
    },
  ];

  const tags = [
    {
      term: "Buy Candidate",
      meaning: "One of the stronger names from today's source mix. It still needs confirmation, but it is a higher-priority idea.",
    },
    {
      term: "Setup Watch",
      meaning: "Interesting, but not quite ready. Usually the story is there, but the chart or confirmation still needs work.",
    },
    {
      term: "Risk Watch",
      meaning: "Worth monitoring mostly for caution. The dashboard sees a live issue or damaged setup that makes the long case weaker.",
    },
    {
      term: "Score",
      meaning: "A ranking signal, not a promise. Higher scores mean the dashboard sees more evidence and better alignment, but the trade still has to earn its entry.",
    },
  ];

  return `<div class="swing-glossary" style="margin-bottom: 16px;">
    <details class="swing-glossary-block">
      <summary class="swing-glossary-toggle">
        <h3 class="swing-glossary-title">How To Read Candidates</h3>
        <span class="swing-glossary-icon" aria-hidden="true">▾</span>
      </summary>
      <div class="swing-glossary-body">
        <div class="swing-glossary-grid">
          ${fields
            .map(
              ({ term, meaning }) => `<dl class="swing-glossary-item">
                <dt>${escapeHtml(term)}</dt>
                <dd>${escapeHtml(meaning)}</dd>
              </dl>`,
            )
            .join("")}
        </div>
      </div>
    </details>
    <details class="swing-glossary-block">
      <summary class="swing-glossary-toggle">
        <h3 class="swing-glossary-title">Candidate Tags</h3>
        <span class="swing-glossary-icon" aria-hidden="true">▾</span>
      </summary>
      <div class="swing-glossary-body">
        <div class="swing-glossary-grid">
          ${tags
            .map(
              ({ term, meaning }) => `<dl class="swing-glossary-item">
                <dt>${escapeHtml(term)}</dt>
                <dd>${escapeHtml(meaning)}</dd>
              </dl>`,
            )
            .join("")}
        </div>
      </div>
    </details>
  </div>`;
}

function renderSwingSetupBoard(setups) {
  if (!setups.length) return `<p class="empty">No actionable swing setups yet. Build the watchlist, then wait for chart confirmation.</p>`;

  return `<div class="list">${setups
    .map(
      (setup) => `<article class="item">
        <div class="row">
          <div>
            <span class="ticker">${escapeHtml(setup.symbol)}</span>
            <span class="tag">${escapeHtml(setup.setup.name)}</span>
            <span class="tag">${escapeHtml(setup.setup.bias)}</span>
          </div>
          <span class="score quality">${setup.quality}</span>
        </div>
        <p class="note"><strong>Timeframe:</strong> ${escapeHtml(setup.timeframe)}</p>
        <div class="trade-plan">
          <div><strong>Entry trigger</strong>${escapeHtml(setup.trigger)}</div>
          <div><strong>Invalidation</strong>${escapeHtml(setup.stop)}</div>
          <div><strong>Target logic</strong>${escapeHtml(setup.target)}</div>
          <div><strong>Avoid</strong>${escapeHtml(setup.avoid)}</div>
        </div>
        <ul class="checklist">${setup.checklist.map((check) => `<li>${escapeHtml(check)}</li>`).join("")}</ul>
      </article>`,
    )
    .join("")}</div>`;
}

function renderBreakoutBoard(summary) {
  const candidates = getCandleCandidates(summary)
    .filter((ticker) => (ticker.setup ?? "") !== "Risk / Avoid")
    .sort((a, b) => (b.breakoutScore ?? 0) - (a.breakoutScore ?? 0))
    .slice(0, 8);

  if (!candidates.length) {
    return `<p class="empty">No breakout candidates yet. Run <code>npm run candles</code> to build a breakout view.</p>`;
  }

  return `<div class="list">${candidates
    .map(
      (ticker) => `<article class="item">
        <div class="row">
          <div>
            <span class="ticker">${escapeHtml(ticker.symbol)}</span>
            <span class="tag">${escapeHtml(ticker.setup ?? "Needs More Confirmation")}</span>
            <span class="tag">${escapeHtml(ticker.relativeStrengthLabel ?? "In line")}</span>
            ${ticker.sectorRelativeStrengthLabel ? `<span class="tag">${escapeHtml(shortSectorTag(ticker))}</span>` : ""}
          </div>
          <span class="score quality">${escapeHtml(ticker.score ?? ticker.breakoutScore ?? "")}</span>
        </div>
        <p class="note"><strong>Pattern:</strong> ${escapeHtml(ticker.pattern ?? "No major pattern")} | <strong>RS:</strong> ${formatRelativeStrength(ticker)} | <strong>Sector:</strong> ${escapeHtml(formatSectorStrength(ticker))}</p>
        <div class="trade-plan">
          <div><strong>Trigger</strong>${escapeHtml(ticker.trigger ?? "None")}</div>
          <div><strong>Resistance</strong>${escapeHtml(ticker.resistance20 ?? "")}</div>
          <div><strong>Volume</strong>${escapeHtml(ticker.volumeRatio ?? "")}x 20-day average</div>
          <div><strong>Target</strong>${escapeHtml(ticker.target ?? "None")}</div>
          <div><strong>Quality</strong>B ${escapeHtml(ticker.breakoutScore ?? "")} / Fresh ${escapeHtml(ticker.extensionScore ?? "")} / Event ${escapeHtml(ticker.eventRiskScore ?? "")}</div>
        </div>
        <ul class="checklist">${(ticker.notes ?? []).slice(0, 4).map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>
      </article>`,
    )
    .join("")}</div>`;
}

function renderPullbackBoard(summary, swingSetups) {
  const swingMap = new Map((swingSetups ?? []).map((setup) => [setup.symbol, setup]));
  const candidates = getCandleCandidates(summary)
    .sort((a, b) => (b.pullbackScore ?? 0) - (a.pullbackScore ?? 0))
    .slice(0, 8);

  if (!candidates.length) {
    return `<p class="empty">No pullback candidates yet. Run <code>npm run candles</code> to build a pullback view.</p>`;
  }

  return `<div class="list">${candidates
    .map((ticker) => {
      const swing = swingMap.get(ticker.symbol);
      return `<article class="item">
        <div class="row">
          <div>
            <span class="ticker">${escapeHtml(ticker.symbol)}</span>
            <span class="tag">${escapeHtml(ticker.setup ?? "Needs More Confirmation")}</span>
            ${swing ? `<span class="tag">${escapeHtml(swing.setup.name)}</span>` : ""}
            ${ticker.sectorRelativeStrengthLabel ? `<span class="tag">${escapeHtml(shortSectorTag(ticker))}</span>` : ""}
          </div>
          <span class="score quality">${escapeHtml(ticker.pullbackScore ?? "")}</span>
        </div>
        <p class="note"><strong>Trend:</strong> ${escapeHtml(ticker.trend ?? "Mixed")} | <strong>SMA20:</strong> ${escapeHtml(ticker.sma20 ?? "")} | <strong>Support:</strong> ${escapeHtml(ticker.support20 ?? "")} | <strong>Sector:</strong> ${escapeHtml(formatSectorStrength(ticker))}</p>
        <div class="trade-plan">
          <div><strong>Trigger</strong>${escapeHtml(ticker.trigger ?? "None")}</div>
          <div><strong>Invalidation</strong>${escapeHtml(ticker.invalidation ?? "None")}</div>
          <div><strong>Relative strength</strong>${escapeHtml(ticker.relativeStrengthLabel ?? "In line")} (${formatRelativeStrength(ticker)})</div>
          <div><strong>Target</strong>${escapeHtml(ticker.target ?? "None")}</div>
          <div><strong>Quality</strong>P ${escapeHtml(ticker.pullbackScore ?? "")} / Fresh ${escapeHtml(ticker.extensionScore ?? "")} / Event ${escapeHtml(ticker.eventRiskScore ?? "")}</div>
        </div>
        <ul class="checklist">${(ticker.notes ?? []).slice(0, 4).map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>
      </article>`;
    })
    .join("")}</div>`;
}

function renderStrategyPlaybook(strategies) {
  return `<div class="list">${strategies
    .map(
      (strategy) => `<article class="item">
        <h3>${escapeHtml(strategy.name)}</h3>
        <p>${escapeHtml(strategy.use)}</p>
        <ul class="checklist">${strategy.confirms.map((confirm) => `<li>${escapeHtml(confirm)}</li>`).join("")}</ul>
      </article>`,
    )
    .join("")}</div>`;
}

function renderCandleScanner(summary) {
  if (!summary?.tickers?.length) {
    return `<p class="empty">No candle analysis cached yet. Run <code>npm run candles</code> to fetch Polygon daily OHLCV data and scan patterns.</p>`;
  }

  const failures = summary.tickers.filter((ticker) => !ticker.ok);
  const visible = summary.tickers
    .filter((ticker) => ticker.ok)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 10);

  if (!visible.length) {
    return `${renderCandleScannerGlossary()}${renderCandleFailureNotice(summary, failures, true)}`;
  }

  return `${renderCandleScannerGlossary()}${renderCandleFailureNotice(summary, failures, false)}<div class="list">${visible
    .map(
      (ticker) => `<article class="item">
        <div class="row">
          <div>
            <span class="ticker">${escapeHtml(ticker.symbol)}</span>
            <span class="tag">${escapeHtml(ticker.setup ?? "Needs More Confirmation")}</span>
            <span class="tag">${escapeHtml(ticker.pattern ?? "No major pattern")}</span>
            <span class="tag">${escapeHtml(ticker.relativeStrengthLabel ?? "In line")}</span>
            ${ticker.sectorRelativeStrengthLabel ? `<span class="tag">${escapeHtml(shortSectorTag(ticker))}</span>` : ""}
          </div>
          <span class="score quality">${escapeHtml(ticker.score ?? "")}</span>
        </div>
        <p class="note"><strong>Trend:</strong> ${escapeHtml(ticker.trend ?? "Mixed")} | <strong>Close:</strong> ${escapeHtml(ticker.close ?? "")} | <strong>Vol:</strong> ${escapeHtml(ticker.volumeRatio ?? "")}x | <strong>RS:</strong> ${formatRelativeStrength(ticker)} | <strong>Sector:</strong> ${escapeHtml(formatSectorStrength(ticker))}</p>
        <div class="trade-plan">
          <div><strong>Trigger</strong>${escapeHtml(ticker.trigger ?? "None")}</div>
          <div><strong>Invalidation</strong>${escapeHtml(ticker.invalidation ?? "None")}</div>
          <div><strong>Target</strong>${escapeHtml(ticker.target ?? "None")}</div>
          <div><strong>Scores</strong>B ${escapeHtml(ticker.breakoutScore ?? "")} / P ${escapeHtml(ticker.pullbackScore ?? "")} / RS ${escapeHtml(ticker.relativeStrengthScore ?? "")}</div>
          <div><strong>Trade quality</strong>Sector ${escapeHtml(ticker.sectorRelativeStrengthScore ?? "")} / Fresh ${escapeHtml(ticker.extensionScore ?? "")} / Event ${escapeHtml(ticker.eventRiskScore ?? "")}</div>
        </div>
        <ul class="checklist">${(ticker.notes ?? []).slice(0, 4).map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>
        ${renderSnapshotReview(summary.date, ticker)}
      </article>`,
    )
    .join("")}</div>`;
}

function renderCandleFailureNotice(summary, failures, allFailed) {
  if (!failures.length) return "";

  const uniqueErrors = [...new Set(failures.map((failure) => String(failure.error ?? "").trim()).filter(Boolean))];
  const benchmarkErrors = Object.values(summary?.benchmarks ?? {})
    .filter((item) => item && item.ok === false && item.error)
    .map((item) => String(item.error).trim());
  const combinedErrors = [...new Set([...uniqueErrors, ...benchmarkErrors])];
  const primaryError = combinedErrors[0] ?? "Unknown provider error";
  const isRateLimit = combinedErrors.some((error) => error.includes("429"));
  const isDnsFailure = combinedErrors.some((error) => /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(error));

  if (allFailed) {
    const tone = isDnsFailure
      ? "Polygon could not be reached when this scan ran."
      : isRateLimit
        ? "Polygon accepted the scan request but rate-limited the dataset."
        : "The scanner ran, but the data provider did not return usable candles.";
    const guidance = isRateLimit
      ? `Try rerunning with <code>npm run candles -- --delay-ms 13000</code>.`
      : "Rerun the candle scan to refresh the cache once the connection is healthy.";

    return `<div class="callout callout-warn" style="margin-bottom: 12px;">
      <strong>Scanner data unavailable.</strong> ${escapeHtml(tone)}
      <div style="margin-top: 6px;"><strong>Provider detail:</strong> ${escapeHtml(primaryError)}</div>
      <div style="margin-top: 6px;">${guidance}</div>
    </div>`;
  }

  const suffix = isRateLimit
    ? ` On Polygon Basic, rerun with <code>npm run candles -- --delay-ms 13000</code>.`
    : isDnsFailure
      ? " Some symbols were skipped because Polygon was temporarily unreachable."
      : "";

  return `<p class="empty" style="margin-bottom: 10px;">${failures.length} ticker${failures.length === 1 ? "" : "s"} were skipped by the data provider.${suffix}</p>`;
}

function renderSnapshotReview(date, ticker) {
  const snapshotHref = chartSnapshotHref(date, ticker);
  if (!snapshotHref) return "";
  const snapshotUrl = versionedAssetHref(snapshotHref);
  const inlineSvg = loadInlineSnapshotSvg(date, ticker);

  return `<details class="snapshot-toggle">
    <summary>
      <span>Review Chart Snapshot</span>
      <span class="swing-glossary-icon" aria-hidden="true">▾</span>
    </summary>
    <div class="snapshot-body">
      <div class="snapshot-lede"><strong>Why it stands out:</strong> ${escapeHtml(buildChartDescriptor(ticker))}</div>
      ${
        inlineSvg
          ? `<div class="chart-snapshot-inline">${inlineSvg}</div>`
          : `<img class="chart-snapshot" src="${escapeHtml(snapshotUrl)}" data-base-src="${escapeHtml(snapshotHref)}" alt="${escapeHtml(ticker.symbol)} chart snapshot" loading="eager" decoding="sync" />`
      }
      <div class="snapshot-actions">
        <a href="${escapeHtml(snapshotUrl)}" data-full-size-link="true" target="_blank" rel="noreferrer">Open full size</a>
      </div>
    </div>
  </details>`;
}

function chartSnapshotHref(date, ticker) {
  const fileName = ticker?.snapshot || (ticker?.symbol ? `${ticker.symbol}.svg` : "");
  if (!date || !fileName) return "";
  return `/data/candles/${encodeURIComponent(date)}/${encodeURIComponent(fileName)}`;
}

function versionedAssetHref(href) {
  if (!href) return "";
  return `${href}${href.includes("?") ? "&" : "?"}v=${encodeURIComponent(DASHBOARD_ASSET_VERSION)}`;
}

function loadInlineSnapshotSvg(date, ticker) {
  const fileName = ticker?.snapshot || (ticker?.symbol ? `${ticker.symbol}.svg` : "");
  if (!date || !fileName) return "";

  const filePath = path.join(ROOT, "data", "candles", date, fileName);

  try {
    return readFileSync(filePath, "utf8").replace(/^<\?xml[^>]*>\s*/i, "").trim();
  } catch {
    return "";
  }
}

function buildChartDescriptor(ticker) {
  const setup = String(ticker?.setup ?? "");
  const trend = String(ticker?.trend ?? "");
  const pattern = String(ticker?.pattern ?? "");
  const rs = String(ticker?.relativeStrengthLabel ?? "");
  const volumeRatio = Number(ticker?.volumeRatio ?? 0);
  const close = Number(ticker?.close ?? 0);
  const sma20 = Number(ticker?.sma20 ?? 0);
  const resistance20 = Number(ticker?.resistance20 ?? 0);
  const support20 = Number(ticker?.support20 ?? 0);
  const breakoutScore = Number(ticker?.breakoutScore ?? 0);
  const pullbackScore = Number(ticker?.pullbackScore ?? 0);

  if (setup === "Risk / Avoid") {
    return pattern && pattern !== "No major pattern"
      ? `The chart is flashing a caution signal with ${pattern.toLowerCase()}, so this is more about protecting capital than forcing a setup.`
      : "The structure is not earning trust yet, so this is a name to leave alone until it builds a cleaner base.";
  }

  if (setup === "Trend Pullback Watch") {
    return `This chart is appealing because the broader ${trend.toLowerCase()} is still intact, price is working near support around ${formatCompactPrice(support20)}, and the pullback setup looks cleaner than chasing a breakout.`;
  }

  if (setup === "Catalyst Continuation Watch") {
    return `This chart has continuation appeal because the catalyst is fresh, volume is running at ${formatCompactNumber(volumeRatio)}x normal, and buyers still have room to push back toward ${formatCompactPrice(resistance20)} if momentum holds.`;
  }

  if (/Breakout/i.test(setup) || breakoutScore >= pullbackScore + 10) {
    return `This chart looks strong because price is pressing toward resistance near ${formatCompactPrice(resistance20)} with enough underlying strength to make a breakout attempt believable.`;
  }

  if (trend === "Uptrend" && rs && rs !== "Lagging" && rs !== "Laggard") {
    return `This chart stands out because it is still in an uptrend, it is holding above key moving averages, and relative strength is supportive enough to keep it on the watchlist.`;
  }

  if (close && sma20 && close > sma20) {
    return `This chart is interesting because price is still holding above short-term support, even if it needs more confirmation before it becomes actionable.`;
  }

  return "This chart has some potential, but the real case depends on whether price can confirm the setup with a cleaner move from here.";
}

function formatCompactPrice(value) {
  return Number.isFinite(value) && value > 0 ? Number(value).toFixed(2) : "the nearby level";
}

function formatCompactNumber(value) {
  return Number.isFinite(value) && value > 0 ? Number(value).toFixed(2).replace(/\.00$/, "") : "1";
}

function renderCandleScannerGlossary() {
  const tagItems = [
    {
      term: "Setup",
      meaning: "The scanner's best read on the kind of trade this chart currently resembles, such as breakout candidate, pullback watch, or risk / avoid.",
    },
    {
      term: "Pattern",
      meaning: "The most notable recent candlestick or price-action signal the scan found. This is a clue, not a trade by itself.",
    },
    {
      term: "Relative Strength Label",
      meaning: "How the stock has been behaving versus SPY and QQQ. Leader means it is outperforming, while lagging or laggard means it is falling behind.",
    },
    {
      term: "Sector Tag",
      meaning: "A quick read on whether the stock is beating or lagging the ETF that best matches its lane, like XLK for software or SMH for semis.",
    },
  ];

  const fieldItems = [
    {
      term: "Trend",
      meaning: "The broader chart direction. Uptrend names are usually easier swing longs than mixed or damaged charts.",
    },
    {
      term: "Vol",
      meaning: "Volume compared with the stock's recent average. Higher volume can help confirm that a move has real participation behind it.",
    },
    {
      term: "RS",
      meaning: "Relative strength against SPY and QQQ over recent windows. This helps show whether the stock is outperforming the market or just moving with it.",
    },
    {
      term: "Sector",
      meaning: "Relative strength versus a sector proxy ETF. This helps us avoid names that look fine on their own but are weak versus their closest peer group.",
    },
    {
      term: "Trigger",
      meaning: "What price behavior would make the setup actionable instead of just interesting.",
    },
    {
      term: "Invalidation",
      meaning: "The level or behavior that would tell us the setup has failed and should not be trusted.",
    },
    {
      term: "Target",
      meaning: "The first logical area where price could run into resistance or where partial profits might make sense.",
    },
    {
      term: "Scores",
      meaning: "B is breakout score, P is pullback score, and RS is relative strength score. Higher is generally better, but the setup still needs context and confirmation.",
    },
    {
      term: "Trade Quality",
      meaning: "Sector is sector-relative strength, Fresh measures whether the setup still looks timely instead of stretched, and Event is the amount of earnings or headline risk still hanging over the chart.",
    },
  ];

  return `<div class="swing-glossary" style="margin-bottom: 16px;">
    <details class="swing-glossary-block">
      <summary class="swing-glossary-toggle">
        <h3 class="swing-glossary-title">How To Read The Scanner</h3>
        <span class="swing-glossary-icon" aria-hidden="true">▾</span>
      </summary>
      <div class="swing-glossary-body">
        <div class="swing-glossary-grid">
          ${fieldItems
            .map(
              ({ term, meaning }) => `<dl class="swing-glossary-item">
                <dt>${escapeHtml(term)}</dt>
                <dd>${escapeHtml(meaning)}</dd>
              </dl>`,
            )
            .join("")}
        </div>
      </div>
    </details>
    <details class="swing-glossary-block">
      <summary class="swing-glossary-toggle">
        <h3 class="swing-glossary-title">Scanner Tags</h3>
        <span class="swing-glossary-icon" aria-hidden="true">▾</span>
      </summary>
      <div class="swing-glossary-body">
        <div class="swing-glossary-grid">
          ${tagItems
            .map(
              ({ term, meaning }) => `<dl class="swing-glossary-item">
                <dt>${escapeHtml(term)}</dt>
                <dd>${escapeHtml(meaning)}</dd>
              </dl>`,
            )
            .join("")}
        </div>
      </div>
    </details>
  </div>`;
}

function renderBriefing(markdown) {
  const sections = splitBriefingSections(markdown);

  return `<div class="briefing">${sections
    .map((section, index) => {
      const kicker = index === 0 ? `<div class="briefing-kicker">AI Generated Morning Read</div>` : "";
      return `<article class="briefing-section">${kicker}${renderBriefingSection(section)}</article>`;
    })
    .join("")}</div>`;
}

function renderBriefingSectionTab(markdown, sectionTitle) {
  const section = splitBriefingSections(markdown).find((item) => headingMatches(item, sectionTitle));
  if (!section) {
    return `<p class="empty">The requested briefing section was not found in the generated report.</p>`;
  }

  if (sectionTitle === "6. Swing Setup Board") {
    return renderSwingBoardSection(section);
  }

  return `<div class="briefing"><article class="briefing-section">${renderBriefingSection(section)}</article></div>`;
}

function splitBriefingSections(markdown) {
  const lines = String(markdown ?? "").replace(/\r/g, "").split("\n");
  const sections = [];
  let current = [];

  for (const line of lines) {
    if (/^##\s+/.test(line) && current.length) {
      sections.push(current.join("\n").trim());
      current = [line];
      continue;
    }

    current.push(line);
  }

  if (current.length) sections.push(current.join("\n").trim());
  return sections.filter(Boolean);
}

function headingMatches(section, targetTitle) {
  const heading = String(section ?? "").split("\n")[0] ?? "";
  return normalizeHeadingText(heading) === normalizeHeadingText(`## ${targetTitle}`);
}

function normalizeHeadingText(value) {
  return String(value ?? "")
    .trim()
    .replace(/^##\s*/, "")
    .replace(/^(\d+)[.)]\s*/, "$1 ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function renderBriefingSection(sectionMarkdown) {
  const lines = sectionMarkdown.replace(/\r/g, "").split("\n");
  const parts = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index].trim();

    if (!line) {
      index += 1;
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length, 3);
      parts.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\|.*\|$/.test(line)) {
      const tableLines = [];
      while (index < lines.length && /^\|.*\|$/.test(lines[index].trim())) {
        tableLines.push(lines[index].trim());
        index += 1;
      }
      parts.push(renderMarkdownTable(tableLines));
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      parts.push(`<blockquote>${quoteLines.map((value) => renderInlineMarkdown(value)).join("<br>")}</blockquote>`);
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^[-*]\s+/, ""));
        index += 1;
      }
      parts.push(`<ul>${items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ul>`);
      continue;
    }

    if (/^\d+[.)]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\d+[.)]\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^\d+[.)]\s+/, ""));
        index += 1;
      }
      parts.push(`<ol>${items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ol>`);
      continue;
    }

    const paragraph = [];
    while (index < lines.length) {
      const current = lines[index].trim();
      if (!current) {
        index += 1;
        break;
      }
      if (/^(#{1,3})\s+/.test(current) || /^\|.*\|$/.test(current) || /^>\s?/.test(current) || /^[-*]\s+/.test(current) || /^\d+[.)]\s+/.test(current)) {
        break;
      }
      paragraph.push(current);
      index += 1;
    }
    parts.push(`<p>${renderInlineMarkdown(paragraph.join(" "))}</p>`);
  }

  return parts.join("");
}

function renderMarkdownTable(lines) {
  const rows = parseMarkdownTable(lines);
  if (!rows) return `<p>${renderInlineMarkdown(lines.join(" "))}</p>`;

  const [header, ...body] = rows;
  return `<table><thead><tr>${header.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${body
    .map((row) => `<tr>${row.map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

function parseMarkdownTable(lines) {
  if (lines.length < 2) return null;

  return lines
    .filter((line, index) => !(index === 1 && /^\|\s*[-:| ]+\|$/.test(line)))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
}

function renderSwingBoardSection(sectionMarkdown) {
  const lines = sectionMarkdown.replace(/\r/g, "").split("\n");
  const parts = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index].trim();

    if (!line) {
      index += 1;
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length, 3);
      parts.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\|.*\|$/.test(line)) {
      const tableLines = [];
      while (index < lines.length && /^\|.*\|$/.test(lines[index].trim())) {
        tableLines.push(lines[index].trim());
        index += 1;
      }
      parts.push(renderSwingBoardCards(tableLines));
      continue;
    }

    const paragraph = [];
    while (index < lines.length) {
      const current = lines[index].trim();
      if (!current) {
        index += 1;
        break;
      }
      if (/^(#{1,3})\s+/.test(current) || /^\|.*\|$/.test(current)) {
        break;
      }
      paragraph.push(current);
      index += 1;
    }
    parts.push(`<p>${renderInlineMarkdown(paragraph.join(" "))}</p>`);
  }

  return `<div class="briefing swing-board-view"><article class="briefing-section">${renderSwingBoardGlossary()}${parts.join("")}</article></div>`;
}

function renderSwingBoardCards(lines) {
  const rows = parseMarkdownTable(lines);
  if (!rows) return renderMarkdownTable(lines);

  const [header, ...body] = rows;
  const normalized = header.map((cell) => cell.toLowerCase());
  const classIndex = normalized.indexOf("class");
  const tickerIndex = normalized.indexOf("ticker");

  return `<div class="swing-board-grid">${body
    .map((row) => {
      const ticker = tickerIndex >= 0 ? row[tickerIndex] ?? "" : row[0] ?? "";
      const setupClass = classIndex >= 0 ? row[classIndex] ?? "" : "";
      const fields = header
        .map((label, cellIndex) => ({ label, value: row[cellIndex] ?? "" }))
        .filter(({ value }, cellIndex) => cellIndex !== tickerIndex && cellIndex !== classIndex && value);

      return `<article class="swing-card">
        <div class="swing-card-head">
          <div>
            <div class="swing-card-symbol">${renderInlineMarkdown(ticker)}</div>
            ${setupClass ? `<div class="swing-card-class">${renderInlineMarkdown(setupClass)}</div>` : ""}
          </div>
        </div>
        <div class="swing-card-fields">${fields
          .map(
            ({ label, value }) => `<div class="swing-card-field">
              <span class="swing-card-label">${escapeHtml(label)}</span>
              <div class="swing-card-value">${renderInlineMarkdown(value)}</div>
            </div>`,
          )
          .join("")}</div>
      </article>`;
    })
    .join("")}</div>`;
}

function renderSwingBoardGlossary() {
  const setupTypes = [
    {
      term: "Breakout / Momentum",
      meaning: "Price is strong and the idea is to buy only if that strength keeps holding, not if the move immediately fades.",
    },
    {
      term: "Catalyst Continuation",
      meaning: "A fresh event like earnings or guidance changed the story, and we are watching for follow-through over the next few sessions.",
    },
    {
      term: "Reversal Bounce",
      meaning: "The stock was weak, but there may be a trade if buyers clearly defend support and the bounce proves itself.",
    },
    {
      term: "Risk Watch",
      meaning: "There is a headline or price-damage problem. This is a caution label, not a green light.",
    },
  ];

  const fields = [
    {
      term: "Setup",
      meaning: "The short version of what kind of opportunity this is and what we think price is trying to do.",
    },
    {
      term: "Trigger",
      meaning: "What has to happen before the trade is valid. Treat this as the line between watching and acting.",
    },
    {
      term: "Stop / Invalidation",
      meaning: "The price behavior that tells us the idea is wrong. If this breaks, the setup has failed.",
    },
    {
      term: "First Target Logic",
      meaning: "Where the first reasonable profit-taking area is likely to be, based on nearby resistance or the size of the move.",
    },
    {
      term: "Sizing Caution",
      meaning: "Why you might want to use smaller size even if the setup works, usually because of volatility, gaps, or crowded sentiment.",
    },
    {
      term: "Pass If",
      meaning: "The condition that says do not take the trade at all, even if the story sounds good.",
    },
  ];

  return `<div class="swing-glossary">
    <details class="swing-glossary-block">
      <summary class="swing-glossary-toggle">
        <h3 class="swing-glossary-title">How To Read This Board</h3>
        <span class="swing-glossary-icon" aria-hidden="true">▾</span>
      </summary>
      <div class="swing-glossary-body">
        <div class="swing-glossary-grid">
        ${fields
          .map(
            ({ term, meaning }) => `<dl class="swing-glossary-item">
              <dt>${escapeHtml(term)}</dt>
              <dd>${escapeHtml(meaning)}</dd>
            </dl>`,
          )
          .join("")}
        </div>
      </div>
    </details>
    <details class="swing-glossary-block">
      <summary class="swing-glossary-toggle">
        <h3 class="swing-glossary-title">Setup Types</h3>
        <span class="swing-glossary-icon" aria-hidden="true">▾</span>
      </summary>
      <div class="swing-glossary-body">
        <div class="swing-glossary-grid">
        ${setupTypes
          .map(
            ({ term, meaning }) => `<dl class="swing-glossary-item">
              <dt>${escapeHtml(term)}</dt>
              <dd>${escapeHtml(meaning)}</dd>
            </dl>`,
          )
          .join("")}
        </div>
      </div>
    </details>
  </div>`;
}

function renderInlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function getCandleCandidates(summary) {
  return (summary?.tickers ?? []).filter((ticker) => ticker.ok);
}

function formatRelativeStrength(ticker) {
  const parts = [];
  if (ticker.rsSpy20 != null) parts.push(`SPY 20d ${ticker.rsSpy20 > 0 ? "+" : ""}${ticker.rsSpy20}%`);
  if (ticker.rsQqq20 != null) parts.push(`QQQ 20d ${ticker.rsQqq20 > 0 ? "+" : ""}${ticker.rsQqq20}%`);
  return parts.join(" | ") || "Unavailable";
}

function formatSectorStrength(ticker) {
  const proxy = String(ticker?.sectorProxy ?? "").trim();
  const label = String(ticker?.sectorRelativeStrengthLabel ?? "").trim();
  const score = ticker?.sectorRelativeStrengthScore;
  if (!proxy && !label) return "No sector proxy yet";
  return [proxy, label, score != null ? `(${score})` : ""].filter(Boolean).join(" ");
}

function shortSectorTag(ticker) {
  const proxy = String(ticker?.sectorProxy ?? "").trim();
  const score = ticker?.sectorRelativeStrengthScore;
  if (!proxy) return "Sector";
  return score == null ? `${proxy}` : `${proxy} ${score}`;
}

function renderSources(sources) {
  return `<div class="list">${sources
    .map(
      (source) => `<article class="item">
        <h3>${escapeHtml(source.title)}</h3>
        <p class="source-meta">${escapeHtml(source.from)}${source.date ? ` | ${escapeHtml(source.date)}` : ""} | ${source.wordCount} words</p>
        <p class="source-meta">${escapeHtml(source.profile ?? "Market Email")} | ${escapeHtml(source.role ?? "general market context")} | weight ${escapeHtml(source.weight ?? 0)}</p>
        <p>${escapeHtml((source.summaryHints ?? [])[0] ?? "No summary hint extracted.")}</p>
        ${(source.links ?? []).length ? renderLinkButtons(source.links) : ""}
        ${
          (source.items ?? []).length
            ? `<details class="agent-brief" style="margin-top: 12px;">
                <summary>
                  <span class="agent-brief-title">Extracted article links</span>
                  <span class="swing-glossary-icon" aria-hidden="true">▾</span>
                </summary>
                <div class="agent-brief-body">
                  <div class="list">${source.items
                    .filter((item) => (item.links ?? []).length)
                    .slice(0, 8)
                    .map(
                      (item) => `<article class="item">
                        <p class="note"><strong>${escapeHtml(item.title || "Source item")}</strong></p>
                        <p class="note">${escapeHtml(item.text || "No excerpt available.")}</p>
                        ${(item.tickers ?? []).length ? `<p class="source-meta">${escapeHtml((item.tickers ?? []).join(", "))}</p>` : ""}
                        ${renderLinkButtons(item.links, 4)}
                      </article>`,
                    )
                    .join("")}</div>
                </div>
              </details>`
            : ""
        }
      </article>`,
    )
    .join("")}</div>`;
}

function collectTickerSourceItems(sources, symbol) {
  if (!symbol) return [];

  const matches = [];

  for (const source of sources ?? []) {
    for (const item of source.items ?? []) {
      if (!(item.tickers ?? []).includes(symbol)) continue;
      if (!(item.links ?? []).length) continue;

      matches.push({
        sourceTitle: source.title ?? "Source",
        title: item.title ?? "",
        text: item.text ?? "",
        links: item.links ?? [],
      });
    }
  }

  return matches;
}

function renderReadingList(items) {
  if (!items.length) return `<p class="empty">No curated reading items were extracted from today&apos;s sources.</p>`;

  return `<div class="list">${items
    .map(
      (item) => `<article class="item">
        <h3>${escapeHtml(item.title)}</h3>
        <p class="note">${escapeHtml(item.note || "No summary note available.")}</p>
        <p class="source-meta">${escapeHtml((item.sources ?? []).length)} source${(item.sources ?? []).length === 1 ? "" : "s"}${(item.tickers ?? []).length ? ` | ${escapeHtml((item.tickers ?? []).join(", "))}` : ""}</p>
        ${(item.links ?? []).length ? renderLinkButtons(item.links, 2) : ""}
      </article>`,
    )
    .join("")}</div>`;
}

function renderWeeklyCalendar(events) {
  if (!events.length) return `<p class="empty">No significant current-week events were extracted yet.</p>`;

  const groups = [];
  let current = null;

  for (const event of events) {
    if (!current || current.dayLabel !== event.dayLabel) {
      current = { dayLabel: event.dayLabel, items: [] };
      groups.push(current);
    }
    current.items.push(event);
  }

  return `<div class="calendar-compact">${groups
    .map(
      (group) => `<div class="calendar-day">
        <div class="calendar-day-head">
          <strong>${escapeHtml(group.dayLabel)}</strong>
          <span class="calendar-count">${group.items.length} event${group.items.length === 1 ? "" : "s"}</span>
        </div>
        <div class="calendar-lines">${group.items
          .map(
            (event) => `<div class="calendar-line">
              <span class="calendar-time">${escapeHtml(event.time || "Scheduled")}</span>
              <div class="calendar-title">${escapeHtml(event.title)}<span class="calendar-kind">${escapeHtml(event.kindLabel)}</span></div>
            </div>`,
          )
          .join("")}</div>
      </div>`,
    )
    .join("")}</div>`;
}

function renderTrendTickers(tickers) {
  if (!tickers.length) return `<p class="empty">Trend memory starts after the first processed sources.</p>`;

  return `<div class="list">${tickers
    .slice(0, 10)
    .map(
      (ticker) => `<article class="item">
        <div class="row">
          <span class="ticker">${escapeHtml(ticker.symbol)}</span>
          <span>${ticker.days.length} day${ticker.days.length === 1 ? "" : "s"}</span>
        </div>
        <p class="note">${ticker.mentions} total mentions across ${ticker.sources.length} source${ticker.sources.length === 1 ? "" : "s"}.</p>
      </article>`,
    )
    .join("")}</div>`;
}

function renderThemes(todayThemes, trendThemes) {
  const themes = todayThemes.length ? todayThemes : trendThemes;
  if (!themes.length) return `<p class="empty">No recurring themes detected yet.</p>`;
  const max = Math.max(...themes.map((theme) => theme.mentions), 1);

  return `<div class="theme-bars">${themes
    .map(
      (theme) => `<div>
        <div class="row"><strong>${escapeHtml(theme.name)}</strong><span>${theme.mentions}</span></div>
        <div class="bar"><span style="width: ${Math.max(8, Math.round((theme.mentions / max) * 100))}%"></span></div>
      </div>`,
    )
    .join("")}</div>`;
}

function renderEvents(events) {
  if (!events.length) return `<p class="empty">No calendar-style items detected today.</p>`;

  return `<div class="list">${events
    .map(
      (event) => `<article class="item">
        <p>${escapeHtml(event.text)}</p>
        <p class="note">${escapeHtml(event.source)}</p>
      </article>`,
    )
    .join("")}</div>`;
}

function fileHref(filePath) {
  return `file://${filePath.split(path.sep).map(encodeURIComponent).join("/")}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function linkLabel(link) {
  const title = String(link?.title ?? "").trim();
  if (!looksLikeTrackingTitle(title)) return title || "Article";

  try {
    const hostname = new URL(link?.url ?? "").hostname;
    if (/cnbc\.com$/i.test(hostname)) return "CNBC article";
    if (/clicks\.fool\.com$/i.test(hostname) || /fool\.com$/i.test(hostname)) return "Motley Fool link";
  } catch {}

  return "Article";
}

function renderLinkButtons(links, limit = 12) {
  const labeled = (links ?? [])
    .map((link) => ({ ...link, label: linkLabel(link) }))
    .filter((link) => link.url && link.label);

  const specific = labeled.filter((link) => !isGenericLinkLabel(link.label));
  const visible = (specific.length > 0 ? specific : labeled).slice(0, limit);
  if (visible.length === 0) return "";

  return `<div class="links">${visible.map((link) => `<a class="button" href="${escapeHtml(link.url)}" target="_blank" rel="noreferrer">${escapeHtml(link.label)}</a>`).join("")}</div>`;
}

function isGenericLinkLabel(label) {
  return /^(article|cnbc article|motley fool link)$/i.test(label.trim());
}

function looksLikeTrackingTitle(title) {
  if (!title) return true;

  const compact = title.replace(/\s+/g, "");
  if (compact.length > 60 && !/[aeiou]{2,}/i.test(compact)) return true;
  if ((compact.match(/[_~]/g) ?? []).length >= 3) return true;
  return /^[A-Za-z0-9_~-]{40,}$/.test(compact);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildWeeklyCalendar(days, latestDate) {
  const latest = parseYmdDate(latestDate);
  const week = getWeekRange(latest);
  const events = [];

  for (const day of days) {
    const current = parseYmdDate(day.date);
    if (current < week.start || current > week.end) continue;

    for (const event of day.events ?? []) {
      const normalizedDate = event.date || day.date;
      const parsed = parseYmdDate(normalizedDate);
      if (parsed < week.start || parsed > week.end) continue;
      if (!isSignificantEvent(event)) continue;

      events.push({
        ...event,
        date: normalizedDate,
        title: event.title || event.text || "",
        dayLabel: formatDayLabel(normalizedDate),
        kindLabel: event.kind === "earnings" ? "Earnings" : "Economic report",
        note: event.note || "",
      });
    }
  }

  const seen = new Set();
  return events
    .filter((event) => {
      const key = [event.date, event.time, event.title, event.kind].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      const dateCompare = a.date.localeCompare(b.date);
      if (dateCompare !== 0) return dateCompare;
      return sortEventTime(a.time) - sortEventTime(b.time);
    })
    .slice(0, 12);
}

function isSignificantEvent(event) {
  const title = String(event?.title ?? event?.text ?? "").trim();
  const kind = String(event?.kind ?? "").trim();
  if (!title) return false;
  if (!kind) return false;
  if (kind === "earnings") return true;
  if (kind === "economic") return true;
  return /\b(earnings|employment|job openings|mortgage|crude oil|fed|cpi|ppi|gdp|services|manufacturing|jobless)\b/i.test(title);
}

function parseYmdDate(value) {
  const [year, month, day] = String(value ?? "").split("-").map(Number);
  return new Date(Date.UTC(year || 1970, (month || 1) - 1, day || 1));
}

function getWeekRange(date) {
  const day = date.getUTCDay();
  const deltaToMonday = (day + 6) % 7;
  const start = new Date(date);
  start.setUTCDate(start.getUTCDate() - deltaToMonday);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return { start, end };
}

function formatDayLabel(value) {
  const date = parseYmdDate(value);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function sortEventTime(value) {
  const label = String(value ?? "").trim();
  if (/before open/i.test(label)) return 0;
  if (/after close/i.test(label)) return 9999;
  const match = label.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return 5000;
  let hours = Number(match[1]) % 12;
  const minutes = Number(match[2]);
  if (/PM/i.test(match[3])) hours += 12;
  return hours * 60 + minutes;
}

function buildHeaderSummary(latest, weeklyCalendar) {
  const tone = formatToneLabel(latest?.macro?.tone);
  const sessionDate = latest?.date;
  const sessionEvents = (weeklyCalendar ?? []).filter((event) => event.date === sessionDate);
  const earnings = sessionEvents.filter((event) => event.kind === "earnings");
  const macro = sessionEvents.filter((event) => event.kind === "economic");
  const beforeOpen = earnings.filter((event) => /before open/i.test(event.time)).length;
  const afterClose = earnings.filter((event) => /after close/i.test(event.time)).length;
  const timeLabels = uniqueValues(
    macro
      .map((event) => String(event.time ?? "").trim())
      .filter((time) => time && !/all day/i.test(time))
      .sort((left, right) => sortEventTime(left) - sortEventTime(right)),
  ).slice(0, 2);

  const earningsPart = earnings.length
    ? `${earnings.length} scheduled earnings`
    : "no scheduled earnings extracted";
  const sessionMix = [];
  if (beforeOpen) sessionMix.push(`${beforeOpen} before open`);
  if (afterClose) sessionMix.push(`${afterClose} after close`);
  const earningsTiming = sessionMix.length ? ` (${sessionMix.join(", ")})` : "";
  const macroPart = macro.length
    ? `${macro.length} macro events in focus`
    : "no macro events extracted";
  const timePart = timeLabels.length ? ` Key times: ${timeLabels.join(" and ")}.` : "";

  return `${tone} tone with ${earningsPart}${earningsTiming} and ${macroPart}.${timePart}`;
}

function formatHeaderDate(value) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(parseYmdDate(value));
}

function countNotableEvents(events) {
  return events.length;
}
