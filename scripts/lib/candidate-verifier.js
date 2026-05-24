import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import "dotenv/config";
import { buildSwingPlan, buildTrendData } from "./swing-plan.js";
import { fetchMarketauxNewsForSymbol, readMarketauxSummary } from "./marketaux.js";
import { readSchwabSnapshot } from "./schwab.js";
import { buildValidatedLongOrderPlan } from "./order-ticket.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const DAILY_DIR = path.join(ROOT, "data", "daily");
const CANDLES_DIR = path.join(ROOT, "data", "candles");
const VERIFICATIONS_DIR = path.join(ROOT, "data", "verifications");

export async function verifyCandidate({ symbol, date }) {
  const days = await loadDailyData();
  const latest = days.find((day) => day.date === date);
  if (!latest) throw createStatusError(404, `No daily dataset found for ${date}`);

  const candidate = (latest.candidates ?? []).find((item) => item.symbol === symbol);
  if (!candidate) throw createStatusError(404, `Ticker ${symbol} is not present in the candidate list for ${date}`);

  const trendData = buildTrendData(days);
  const swingPlan = buildSwingPlan(latest, trendData);
  const swing = swingPlan.bySymbol.get(symbol) ?? null;
  const candleSummary = await readOptionalJson(path.join(CANDLES_DIR, date, "summary.json"));
  const candle = (candleSummary?.tickers ?? []).find((item) => item.symbol === symbol && item.ok) ?? null;
  const marketauxSummary = await readMarketauxSummary(date);
  const cachedNews = marketauxSummary?.symbols?.[symbol] ?? null;
  const schwabSnapshot = await readSchwabSnapshot(date);
  const schwabHolding = schwabSnapshot?.positionsBySymbol?.[symbol] ?? null;

  const live = await loadLiveEvidence({ symbol, date, cachedNews });
  const record = buildVerificationRecord({ symbol, date, latest, candidate, swing, candle, live, cachedNews, schwabHolding, schwabSnapshot });

  await mkdir(path.join(VERIFICATIONS_DIR, date), { recursive: true });
  await writeFile(path.join(VERIFICATIONS_DIR, date, `${symbol}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");

  return record;
}

export async function listVerificationRecords(date) {
  const dir = path.join(VERIFICATIONS_DIR, date);
  let entries = [];

  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const records = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readOptionalJson(path.join(dir, entry.name))),
  );

  return records.filter(Boolean).sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function createStatusError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function loadDailyData() {
  const entries = await readdir(DAILY_DIR, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  const days = [];
  for (const file of files) {
    const raw = await readFile(path.join(DAILY_DIR, file), "utf8");
    days.push(JSON.parse(raw));
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function loadLiveEvidence({ symbol, date, cachedNews }) {
  const apiKey = process.env.POLYGON_API_KEY;
  const errors = [];
  const sourcesUsed = [];
  let snapshot = null;
  let news = [];
  let marketauxNews = cachedNews ?? null;

  if (!marketauxNews && process.env.MARKETAUX_API_TOKEN) {
    marketauxNews = await fetchMarketauxNewsForSymbol({ symbol, date, limit: 5 });
  }
  if (marketauxNews?.count) sourcesUsed.push("Marketaux news");

  if (!apiKey) {
    errors.push("Missing POLYGON_API_KEY for live verification checks.");
    return { snapshot, news, marketauxNews, errors, sourcesUsed };
  }

  const snapshotUrl = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(symbol)}?apiKey=${encodeURIComponent(apiKey)}`;
  const newsUrl = `https://api.polygon.io/v2/reference/news?ticker=${encodeURIComponent(symbol)}&limit=5&order=desc&sort=published_utc&apiKey=${encodeURIComponent(apiKey)}`;
  const [snapshotPayload, newsPayload] = await Promise.all([fetchJson(snapshotUrl), fetchJson(newsUrl)]);

  if (!snapshotPayload.ok) {
    errors.push(`Snapshot unavailable: ${snapshotPayload.error}`);
  } else {
    snapshot = summarizeSnapshot(snapshotPayload.ticker ?? snapshotPayload.results ?? snapshotPayload);
    sourcesUsed.push("Polygon snapshot");
  }

  if (!newsPayload.ok) {
    errors.push(`News unavailable: ${newsPayload.error}`);
  } else {
    news = (newsPayload.results ?? []).slice(0, 5).map((item) => ({
      title: item.title,
      publishedUtc: item.published_utc,
      publisher: item.publisher?.name,
      sentiment: summarizeInsights(item.insights ?? [], symbol),
      articleUrl: item.article_url,
    }));
    if (news.length) sourcesUsed.push("Polygon news");
  }

  return { snapshot, news, marketauxNews, errors, sourcesUsed };
}

function summarizeSnapshot(payload) {
  if (!payload) return null;

  const lastTradePrice = payload.lastTrade?.p ?? null;
  const minuteClose = payload.min?.c ?? null;
  const dayClose = payload.day?.c ?? null;
  const prevClose = payload.prevDay?.c ?? null;
  const updated = payload.updated ?? payload.lastTrade?.t ?? payload.min?.t ?? null;

  return {
    currentPrice: round(lastTradePrice ?? minuteClose ?? dayClose),
    previousClose: round(prevClose),
    dayVolume: payload.day?.v ?? null,
    minuteVolume: payload.min?.v ?? null,
    updatedAt: normalizeTimestamp(updated),
  };
}

function summarizeInsights(insights, symbol) {
  const matching = insights.filter((item) => item.ticker === symbol);
  if (!matching.length) return "neutral";
  if (matching.some((item) => item.sentiment === "negative")) return "negative";
  if (matching.some((item) => item.sentiment === "positive")) return "positive";
  return matching[0]?.sentiment ?? "neutral";
}

function buildVerificationRecord({ symbol, date, latest, candidate, swing, candle, live, cachedNews, schwabHolding, schwabSnapshot }) {
  const why = [];
  const blockers = [];
  const freshness = [];
  const sourcesUsed = [
    ...(candidate.sourceProfiles ?? []),
    ...(live.sourcesUsed ?? []),
  ];

  if (latest.macro?.tone === "Risk-Off") {
    why.push("Macro backdrop is Risk-Off, so the setup needs cleaner confirmation than usual.");
  }

  if (candidate.stance === "Risk Watch") {
    blockers.push("Candidate was already classified as Risk Watch from source analysis.");
  }

  if ((candidate.risks ?? []).some((risk) => risk !== "no major risk flag found in current sources")) {
    why.push(`Dashboard risk flags: ${(candidate.risks ?? []).join(", ")}.`);
  }

  if (schwabHolding) {
    why.push(
      `Schwab account context: already holding ${formatHoldingQuantity(schwabHolding.totalQuantity)} share${Math.abs(Number(schwabHolding.totalQuantity || 0)) === 1 ? "" : "s"} with about ${formatCurrency(schwabHolding.totalMarketValue)} market value.`,
    );
    sourcesUsed.push("Schwab positions");
  } else if (schwabSnapshot?.ok) {
    why.push("Schwab account context: this ticker is not currently held.");
    sourcesUsed.push("Schwab positions");
  }

  if (schwabSnapshot?.ok && Number.isFinite(Number(schwabSnapshot.totals?.buyingPower))) {
    why.push(`Approximate Schwab buying power available: ${formatCurrency(schwabSnapshot.totals.buyingPower)}.`);
  }

  if (swing) {
    why.push(`Swing overlay sees this as ${swing.setup.name}.`);
  }

  if (candle) {
    why.push(`Scanner setup is ${candle.setup} with ${candle.pattern}.`);
    if (candle.stale) {
      why.push(`Technical scan is using stale candle data from ${candle.staleSourceDate ?? "a prior session"}, so treat the setup review as provisional until a fresh scan lands.`);
    }

    if (["Risk / Avoid"].includes(candle.setup)) {
      blockers.push("Candlestick scanner still classifies the chart as Risk / Avoid.");
    }

    if (["Laggard"].includes(candle.relativeStrengthLabel)) {
      blockers.push("Relative strength is laggard versus SPY/QQQ.");
    } else if (["Lagging"].includes(candle.relativeStrengthLabel)) {
      why.push("Relative strength is lagging, which lowers conviction for immediate entry.");
    } else {
      why.push(`Relative strength is ${candle.relativeStrengthLabel.toLowerCase()} versus SPY/QQQ.`);
    }
  } else {
    why.push("No fresh candle scan was available, so technical confirmation is incomplete.");
  }

  const marketauxHeadlines = live.marketauxNews?.headlines ?? cachedNews?.headlines ?? [];
  const marketauxNegative = marketauxHeadlines.filter((item) => item.sentiment === "negative");
  const marketauxPositive = marketauxHeadlines.filter((item) => item.sentiment === "positive");

  if (marketauxNegative.length) {
    blockers.push(`Marketaux found ${marketauxNegative.length} negative recent headline${marketauxNegative.length === 1 ? "" : "s"} for ${symbol}.`);
  } else if (marketauxPositive.length) {
    why.push(`Marketaux found ${marketauxPositive.length} supportive recent headline${marketauxPositive.length === 1 ? "" : "s"}.`);
  } else if (live.marketauxNews) {
    why.push("Marketaux did not add a strong symbol-specific catalyst check.");
  }

  const negativeNews = (live.news ?? []).filter((item) => {
    const title = `${item.title ?? ""} ${item.publisher ?? ""}`.toLowerCase();
    return item.sentiment === "negative" || /downgrade|lawsuit|antitrust|investigation|cut|miss|warning|delay|plunge|falls|fell|drops/.test(title);
  });

  const positiveNews = (live.news ?? []).filter((item) => item.sentiment === "positive");

  if (negativeNews.length) {
    blockers.push(`Fresh news check found ${negativeNews.length} negative headline${negativeNews.length === 1 ? "" : "s"} for ${symbol}.`);
  } else if (positiveNews.length) {
    why.push(`Fresh news check found ${positiveNews.length} supportive recent headline${positiveNews.length === 1 ? "" : "s"}.`);
  } else {
    why.push("Live news check did not add a strong positive confirmation.");
  }

  if (live.snapshot?.updatedAt) {
    freshness.push(`Market snapshot updated ${formatRelativeTime(live.snapshot.updatedAt)}.`);
  }
  if ((live.news ?? []).length) {
    freshness.push(`Latest Polygon news item published ${formatRelativeTime(live.news[0].publishedUtc)}.`);
  }
  if (marketauxHeadlines.length) {
    freshness.push(`Latest Marketaux headline published ${formatRelativeTime(marketauxHeadlines[0].publishedAt)}.`);
  }
  for (const error of live.errors ?? []) freshness.push(error);

  const triggerPrice = extractFirstNumber(candle?.trigger) ?? extractFirstNumber(swing?.trigger);
  const stopPrice = extractFirstNumber(candle?.invalidation) ?? extractFirstNumber(swing?.stop);
  const targetPrice = extractFirstNumber(candle?.target) ?? extractFirstNumber(swing?.target);
  const livePrice = live.snapshot?.currentPrice ?? candle?.close ?? null;
  const orderPlan = buildValidatedLongOrderPlan({ symbol, candle, livePrice });

  if (triggerPrice != null && livePrice != null) {
    if (livePrice >= triggerPrice * 0.995) {
      why.push(`Live price ${livePrice} is near or above trigger ${triggerPrice}.`);
    } else {
      why.push(`Live price ${livePrice} is still below trigger ${triggerPrice}.`);
    }
  }

  if (stopPrice != null && livePrice != null && livePrice <= stopPrice) {
    blockers.push(`Live price ${livePrice} is at or below the invalidation zone around ${stopPrice}.`);
  }

  if (triggerPrice != null && stopPrice != null && targetPrice != null) {
    const risk = Math.abs(triggerPrice - stopPrice);
    const reward = Math.abs(targetPrice - triggerPrice);
    if (!Number.isFinite(risk) || risk <= 0 || reward / risk < 1.5) {
      blockers.push("Current trigger, stop, and target do not support acceptable reward-to-risk.");
    } else {
      why.push(`Current reward-to-risk is about ${round(reward / risk)}R.`);
    }
  } else {
    why.push("One or more of trigger, stop, or target is not numeric, so reward-to-risk remains partly manual.");
  }

  if (!orderPlan.ok) {
    blockers.push(`Order-ticket guardrail: ${orderPlan.reason}`);
  }

  let state = "watchlist_only";
  if (blockers.length) {
    state = "pass";
  } else if (
    live.snapshot &&
    !live.errors?.length &&
    candidate.stance === "Buy Candidate" &&
    candle &&
    !["Risk / Avoid", "Needs More Confirmation"].includes(candle.setup) &&
    !["Lagging", "Laggard"].includes(candle.relativeStrengthLabel) &&
    (triggerPrice == null || livePrice == null || livePrice >= triggerPrice * 0.995) &&
    orderPlan.ok
  ) {
    state = "actionable_now";
  }

  const summary =
    state === "actionable_now"
      ? `${symbol} still looks tradeable: chart context, trigger behavior, and fresh checks remain aligned.`
      : state === "pass"
        ? `${symbol} is a pass for now because the setup is broken, degraded, or blocked by fresh evidence.`
        : `${symbol} stays on watch, but the setup still needs more confirmation before entry.`;

  return {
    symbol,
    date,
    verifiedAt: new Date().toISOString(),
    verifiedAtLabel: `Last checked ${new Date().toLocaleString()}`,
    state,
    summary,
    why: unique(why).slice(0, 5),
    entryPlan: candle?.trigger ?? swing?.trigger ?? candidate.nextCheck,
    riskPlan: candle?.invalidation ?? swing?.stop ?? "Define invalidation from support before entry.",
    targetPlan: candle?.target ?? swing?.target ?? "Define first target before entry.",
    blockingIssue: blockers[0] ?? "",
    sourcesUsed: unique(sourcesUsed),
    freshness: freshness.join(" "),
    liveSnapshot: live.snapshot,
    liveNews: live.news,
    schwabHolding,
    marketauxNews: marketauxHeadlines.slice(0, 3),
    marketauxSentiment: live.marketauxNews?.sentiment ?? cachedNews?.sentiment ?? "unknown",
    orderPlan,
  };
}

async function fetchJson(url) {
  try {
    const response = await fetch(url);
    const json = await response.json();
    if (!response.ok) {
      return {
        ok: false,
        error: json.error ?? json.message ?? `HTTP ${response.status}`,
      };
    }
    return { ok: true, ...json };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function extractFirstNumber(text) {
  const match = String(text ?? "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function normalizeTimestamp(value) {
  if (!value) return null;
  if (typeof value === "number") {
    let millis = value;
    if (value > 10_000_000_000_000_000) millis = Math.round(value / 1_000_000);
    else if (value > 10_000_000_000_000) millis = Math.round(value / 1000);
    else if (value < 10_000_000_000) millis = value * 1000;
    const parsed = new Date(millis);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function formatRelativeTime(value) {
  if (!value) return "at an unknown time";
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return "at an unknown time";
  const diffMinutes = Math.round((Date.now() - then) / 60000);
  if (diffMinutes <= 1) return "moments ago";
  if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes === 1 ? "" : "s"} ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  const diffDays = Math.round(diffHours / 24);
  return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function unique(values) {
  return [...new Set((values ?? []).filter(Boolean))];
}

function formatHoldingQuantity(value) {
  if (!Number.isFinite(Number(value))) return "0";
  const absolute = Math.abs(Number(value));
  return absolute % 1 === 0 ? String(absolute) : String(round(absolute));
}

function formatCurrency(value) {
  if (!Number.isFinite(Number(value))) return "unknown";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Number(value));
}
