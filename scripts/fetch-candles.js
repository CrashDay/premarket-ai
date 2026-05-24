import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import "dotenv/config";

const ROOT = path.resolve(import.meta.dirname, "..");
const DAILY_DIR = path.join(ROOT, "data", "daily");
const CANDLES_DIR = path.join(ROOT, "data", "candles");
let candleDateCache = null;

const apiKey = process.env.POLYGON_API_KEY;
const args = parseArgs(process.argv.slice(2));
const runDate = args.date ?? (await latestDate());

if (!apiKey) {
  console.log("Missing POLYGON_API_KEY in .env");
  process.exit(1);
}

const dailyPath = path.join(DAILY_DIR, `${runDate}.json`);
const daily = JSON.parse(await readFile(dailyPath, "utf8"));
const outputDir = path.join(CANDLES_DIR, runDate);

await mkdir(outputDir, { recursive: true });

const tickers = selectTickers(daily, args.limit);
const from = daysAgo(runDate, args.lookbackDays);
const benchmarks = await loadBenchmarks(from, runDate, args);
const summary = {
  date: runDate,
  generatedAt: new Date().toISOString(),
  provider: "Polygon.io",
  benchmarks: summarizeBenchmarks(benchmarks),
  tickers: [],
};

for (const ticker of tickers) {
  const url = buildPolygonUrl(ticker.symbol, from, runDate, apiKey);
  const payload = await fetchJson(url, args.retryMs);
  const snapshotFileName = `${ticker.symbol}.svg`;

  if (!payload.ok || !Array.isArray(payload.results) || payload.results.length < 60) {
    const errorMessage = payload.error ?? `Polygon response missing candle data (${payload.status ?? "unknown"})`;
    const fallback = await loadFallbackTicker(ticker.symbol, runDate, outputDir);

    if (fallback) {
      const staleResult = {
        ...fallback.result,
        fetchedAt: new Date().toISOString(),
        provider: `${fallback.result.provider ?? "Polygon.io"} (stale fallback)`,
        stale: true,
        staleSourceDate: fallback.sourceDate,
        staleReason: errorMessage,
      };
      summary.tickers.push({
        symbol: ticker.symbol,
        ok: true,
        snapshot: snapshotFileName,
        ...staleResult.analysis,
        stale: true,
        staleSourceDate: fallback.sourceDate,
        staleReason: errorMessage,
      });
      await writeJsonAtomic(path.join(outputDir, `${ticker.symbol}.json`), staleResult);
      await writeTextAtomic(path.join(outputDir, snapshotFileName), renderChartSnapshotSvg(ticker.symbol, staleResult.candles ?? [], staleResult.analysis));
      console.log(`Reused stale ${ticker.symbol} scan from ${fallback.sourceDate}: ${staleResult.analysis.pattern || "No major pattern"} | ${staleResult.analysis.setup} | ${staleResult.analysis.score}`);
      if (args.delayMs > 0) await sleep(args.delayMs);
      continue;
    }

    const failed = {
      symbol: ticker.symbol,
      ok: false,
      error: errorMessage,
    };
    summary.tickers.push(failed);
    await removeIfExists(path.join(outputDir, `${ticker.symbol}.svg`)).catch(() => {});
    await writeJsonAtomic(path.join(outputDir, `${ticker.symbol}.json`), failed);
    console.log(`Skipped ${ticker.symbol}: ${failed.error}`);
    if (args.delayMs > 0) await sleep(args.delayMs);
    continue;
  }

  const candles = payload.results.map(normalizeCandle);
  const analysis = analyzeTicker(ticker, candles, benchmarks, daily);
  const result = {
    symbol: ticker.symbol,
    ok: true,
    provider: "Polygon.io",
    fetchedAt: new Date().toISOString(),
    from,
    to: runDate,
    candleCount: candles.length,
    analysis,
    candles: candles.slice(-120),
  };

  summary.tickers.push({
    symbol: ticker.symbol,
    ok: true,
    snapshot: snapshotFileName,
    ...analysis,
  });

  await writeJsonAtomic(path.join(outputDir, `${ticker.symbol}.json`), result);
  await writeTextAtomic(path.join(outputDir, snapshotFileName), renderChartSnapshotSvg(ticker.symbol, result.candles, analysis));
  console.log(`Fetched ${ticker.symbol}: ${analysis.pattern || "No major pattern"} | ${analysis.setup} | ${analysis.score}`);
  if (args.delayMs > 0) await sleep(args.delayMs);
}

await writeJsonAtomic(path.join(outputDir, "summary.json"), summary);
console.log(`Wrote candle summary: ${path.join(outputDir, "summary.json")}`);

function parseArgs(argv) {
  const parsed = {
    lookbackDays: 220,
    limit: 10,
    delayMs: 0,
    retryMs: 65000,
    networkRetries: 2,
    networkRetryMs: 3000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--date") parsed.date = argv[++index];
    else if (arg === "--lookback-days") parsed.lookbackDays = Number(argv[++index] || 220);
    else if (arg === "--limit") parsed.limit = Number(argv[++index] || 10);
    else if (arg === "--delay-ms") parsed.delayMs = Number(argv[++index] || 0);
    else if (arg === "--retry-ms") parsed.retryMs = Number(argv[++index] || 65000);
    else if (arg === "--network-retries") parsed.networkRetries = Number(argv[++index] || 2);
    else if (arg === "--network-retry-ms") parsed.networkRetryMs = Number(argv[++index] || 3000);
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm run candles -- [--date YYYY-MM-DD] [--lookback-days 220] [--limit 10] [--delay-ms 13000] [--retry-ms 65000] [--network-retries 2] [--network-retry-ms 3000]");
      process.exit(0);
    }
  }

  return parsed;
}

async function latestDate() {
  const entries = await readdir(DAILY_DIR, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.replace(/\.json$/, ""))
    .sort();

  if (!files.length) throw new Error("No daily data files found.");
  return files.at(-1);
}

async function removeIfExists(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function listAvailableCandleDates() {
  if (candleDateCache) return candleDateCache;

  try {
    const entries = await readdir(CANDLES_DIR, { withFileTypes: true });
    candleDateCache = entries
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    return candleDateCache;
  } catch {
    candleDateCache = [];
    return candleDateCache;
  }
}

async function loadFallbackBenchmark(symbol, runDate) {
  const dates = await listAvailableCandleDates();

  for (const date of dates) {
    if (date > runDate) continue;
    const summary = await readOptionalJson(path.join(CANDLES_DIR, date, "summary.json"));
    const benchmark = summary?.benchmarks?.[symbol];
    if (benchmark?.ok) return { ...benchmark, sourceDate: date };
  }

  return null;
}

async function loadFallbackTicker(symbol, runDate, outputDir) {
  const current = await readOptionalJson(path.join(outputDir, `${symbol}.json`));
  if (current?.ok && current.analysis) {
    return { result: current, sourceDate: runDate };
  }

  const dates = await listAvailableCandleDates();
  for (const date of dates) {
    if (date >= runDate) continue;
    const prior = await readOptionalJson(path.join(CANDLES_DIR, date, `${symbol}.json`));
    if (prior?.ok && prior.analysis) {
      return { result: prior, sourceDate: date };
    }
  }

  return null;
}

async function loadBenchmarks(from, to, args) {
  const symbols = ["SPY", "QQQ", "XLK", "XLF", "XLE", "XLI", "XLY", "XLP", "XLV", "XLRE", "XLC", "SMH", "IBB"];
  const results = {};

  for (const symbol of symbols) {
    const url = buildPolygonUrl(symbol, from, to, apiKey);
    const payload = await fetchJson(url, args.retryMs);

    if (!payload.ok || !Array.isArray(payload.results) || payload.results.length < 60) {
      const fallback = await loadFallbackBenchmark(symbol, to);
      if (fallback) {
        results[symbol] = {
          ok: true,
          close: fallback.close,
          return20: fallback.return20,
          return50: fallback.return50,
          stale: true,
          staleSourceDate: fallback.sourceDate,
          staleReason: payload.error ?? "Missing benchmark data",
        };
        console.log(`Reused stale benchmark ${symbol} from ${fallback.sourceDate}: ${results[symbol].return20}% 20d | ${results[symbol].return50}% 50d`);
      } else {
        results[symbol] = { ok: false, error: payload.error ?? "Missing benchmark data" };
        console.log(`Skipped benchmark ${symbol}: ${results[symbol].error}`);
      }
    } else {
      const candles = payload.results.map(normalizeCandle);
      results[symbol] = {
        ok: true,
        candles,
        close: round(candles.at(-1).close),
        return20: round(percentChange(candles.at(-21)?.close, candles.at(-1).close)),
        return50: round(percentChange(candles.at(-51)?.close, candles.at(-1).close)),
      };
      console.log(`Fetched benchmark ${symbol}: ${results[symbol].return20}% 20d | ${results[symbol].return50}% 50d`);
    }

    if (args.delayMs > 0) await sleep(args.delayMs);
  }

  return results;
}

function summarizeBenchmarks(benchmarks) {
  return Object.fromEntries(
    Object.entries(benchmarks).map(([symbol, data]) => [
      symbol,
      data.ok
        ? {
            ok: true,
            close: data.close,
            return20: data.return20,
            return50: data.return50,
            ...(data.stale ? { stale: true, staleSourceDate: data.staleSourceDate, staleReason: data.staleReason } : {}),
          }
        : { ok: false, error: data.error },
    ]),
  );
}

function selectTickers(daily, limit) {
  const candidates = (daily.candidates ?? [])
    .filter((candidate) => candidate.stance !== "Low Priority")
    .slice(0, limit);

  const fallback = (daily.tickers ?? []).slice(0, limit).map((ticker) => ({
    symbol: ticker.symbol,
    score: 40,
    stance: "Research Watch",
    evidence: ticker.notes?.[0] ?? "",
  }));

  return (candidates.length ? candidates : fallback).map((candidate) => ({
    symbol: candidate.symbol,
    score: candidate.score,
    stance: candidate.stance,
    evidence: candidate.evidence,
    positives: candidate.positives ?? [],
    risks: candidate.risks ?? [],
    nextCheck: candidate.nextCheck ?? "",
    sources: candidate.sources ?? [],
    sourceProfiles: candidate.sourceProfiles ?? [],
  }));
}

function daysAgo(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

function buildPolygonUrl(symbol, from, to, key) {
  const encoded = encodeURIComponent(symbol);
  return `https://api.polygon.io/v2/aggs/ticker/${encoded}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=5000&apiKey=${encodeURIComponent(key)}`;
}

async function fetchJson(url, retryMs) {
  return fetchJsonWithRetry(url, retryMs, args.networkRetries, args.networkRetryMs);
}

async function fetchJsonWithRetry(url, retryMs, networkRetries, networkRetryMs, attempt = 0) {
  try {
    const response = await fetch(url);
    const text = await response.text();
    const json = text ? tryParseJson(text) : null;

    if (response.status === 429) {
      await sleep(retryMs);
      return fetchJson(url, 0);
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: json?.error ?? json?.message ?? truncateText(text) ?? `HTTP ${response.status}`,
      };
    }

    return {
      ok: true,
      status: response.status,
      ...(json ?? {}),
    };
  } catch (error) {
    if (attempt < networkRetries && isTransientNetworkError(error)) {
      await sleep(networkRetryMs);
      return fetchJsonWithRetry(url, retryMs, networkRetries, networkRetryMs, attempt + 1);
    }
    const causeCode = error?.cause?.code ? ` (${error.cause.code})` : "";
    const causeMessage = error?.cause?.message && error.cause.message !== error.message ? `: ${error.cause.message}` : "";
    return {
      ok: false,
      error: `${error.message}${causeCode}${causeMessage}`,
    };
  }
}

function isTransientNetworkError(error) {
  const code = error?.cause?.code ?? error?.code ?? "";
  return ["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(code);
}

async function writeJsonAtomic(filePath, value) {
  await writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(filePath, contents) {
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, contents, "utf8");
  await rename(tempPath, filePath);
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function truncateText(value, maxLength = 180) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeCandle(candle) {
  return {
    date: new Date(candle.t).toISOString().slice(0, 10),
    open: candle.o,
    high: candle.h,
    low: candle.l,
    close: candle.c,
    volume: candle.v,
  };
}

function renderChartSnapshotSvg(symbol, candles, analysis) {
  const visible = candles.slice(-60);
  const width = 980;
  const height = 620;
  const pad = { top: 74, right: 34, bottom: 68, left: 68 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const lows = visible.map((candle) => candle.low);
  const highs = visible.map((candle) => candle.high);
  const minPrice = Math.min(...lows, analysis.support20 ?? Infinity);
  const maxPrice = Math.max(...highs, analysis.resistance20 ?? -Infinity);
  const priceRange = Math.max(maxPrice - minPrice, 1);
  const scaleY = (price) => pad.top + ((maxPrice - price) / priceRange) * plotHeight;
  const stepX = plotWidth / Math.max(visible.length, 1);
  const candleWidth = Math.max(4, Math.min(10, stepX * 0.58));
  const close = analysis.close ?? visible.at(-1)?.close ?? 0;
  const sma20Points = movingAveragePoints(visible, 20, stepX, pad.left, scaleY);
  const sma50Points = movingAveragePoints(visible, 50, stepX, pad.left, scaleY);
  const supportY = Number.isFinite(analysis.support20) ? scaleY(analysis.support20) : null;
  const resistanceY = Number.isFinite(analysis.resistance20) ? scaleY(analysis.resistance20) : null;
  const priceTicks = buildPriceTicks(minPrice, maxPrice, 5);
  const dateLabels = buildDateLabels(visible, stepX, pad.left, pad.top + plotHeight + 24);
  const candleMarkup = visible
    .map((candle, index) => {
      const x = pad.left + index * stepX + stepX / 2;
      const rising = candle.close >= candle.open;
      const color = rising ? "#0f766e" : "#c65b3d";
      const wickTop = scaleY(candle.high);
      const wickBottom = scaleY(candle.low);
      const bodyTop = scaleY(Math.max(candle.open, candle.close));
      const bodyBottom = scaleY(Math.min(candle.open, candle.close));
      const bodyHeight = Math.max(bodyBottom - bodyTop, 1.5);

      return `<g>
        <line x1="${round(x)}" y1="${round(wickTop)}" x2="${round(x)}" y2="${round(wickBottom)}" stroke="${color}" stroke-width="1.4" stroke-linecap="round" />
        <rect x="${round(x - candleWidth / 2)}" y="${round(bodyTop)}" width="${round(candleWidth)}" height="${round(bodyHeight)}" rx="1.4" fill="${color}" opacity="${rising ? "0.9" : "0.82"}" />
      </g>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(symbol)} chart snapshot">
  <defs>
    <linearGradient id="bg" x1="0%" x2="100%" y1="0%" y2="100%">
      <stop offset="0%" stop-color="#f8fbfe" />
      <stop offset="100%" stop-color="#eef4f8" />
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" rx="24" fill="url(#bg)" />
  <rect x="18" y="18" width="${width - 36}" height="${height - 36}" rx="20" fill="#ffffff" stroke="#d7e0e8" />
  <text x="${pad.left}" y="44" font-size="28" font-weight="700" font-family="Avenir Next, Segoe UI, sans-serif" fill="#17212b">${escapeXml(symbol)} Candlestick Snapshot</text>
  <text x="${pad.left}" y="66" font-size="15" font-family="Avenir Next, Segoe UI, sans-serif" fill="#5e6a78">${escapeXml(analysis.setup ?? "Needs More Confirmation")} | ${escapeXml(analysis.pattern ?? "No major pattern")} | Close ${close}</text>
  <text x="${width - pad.right}" y="44" text-anchor="end" font-size="14" font-family="Avenir Next, Segoe UI, sans-serif" fill="#4d6478">Trend: ${escapeXml(analysis.trend ?? "Mixed")}</text>
  <text x="${width - pad.right}" y="64" text-anchor="end" font-size="14" font-family="Avenir Next, Segoe UI, sans-serif" fill="#4d6478">Scores B ${escapeXml(String(analysis.breakoutScore ?? ""))} / P ${escapeXml(String(analysis.pullbackScore ?? ""))} / RS ${escapeXml(String(analysis.relativeStrengthScore ?? ""))}</text>

  <g>
    ${priceTicks
      .map(
        ({ price, y }) => `<g>
        <line x1="${pad.left}" y1="${round(y)}" x2="${width - pad.right}" y2="${round(y)}" stroke="#e6edf4" stroke-width="1" />
        <text x="${pad.left - 12}" y="${round(y + 4)}" text-anchor="end" font-size="12" font-family="Avenir Next, Segoe UI, sans-serif" fill="#6d7887">${escapeXml(formatPrice(price))}</text>
      </g>`,
      )
      .join("")}
  </g>

  ${
    resistanceY == null
      ? ""
      : `<line x1="${pad.left}" y1="${round(resistanceY)}" x2="${width - pad.right}" y2="${round(resistanceY)}" stroke="#d9a441" stroke-width="1.6" stroke-dasharray="8 6" />
         <text x="${width - pad.right}" y="${round(resistanceY - 8)}" text-anchor="end" font-size="12" font-family="Avenir Next, Segoe UI, sans-serif" fill="#a87416">Resistance ${escapeXml(formatPrice(analysis.resistance20))}</text>`
  }
  ${
    supportY == null
      ? ""
      : `<line x1="${pad.left}" y1="${round(supportY)}" x2="${width - pad.right}" y2="${round(supportY)}" stroke="#0f766e" stroke-width="1.6" stroke-dasharray="8 6" opacity="0.8" />
         <text x="${width - pad.right}" y="${round(supportY - 8)}" text-anchor="end" font-size="12" font-family="Avenir Next, Segoe UI, sans-serif" fill="#0f766e">Support ${escapeXml(formatPrice(analysis.support20))}</text>`
  }

  ${candleMarkup}
  ${
    sma20Points
      ? `<polyline fill="none" stroke="#113b52" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" points="${sma20Points}" />`
      : ""
  }
  ${
    sma50Points
      ? `<polyline fill="none" stroke="#7a8f27" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" points="${sma50Points}" />`
      : ""
  }

  <g>
    ${dateLabels.join("")}
  </g>

  <g transform="translate(${pad.left}, ${height - 34})">
    <rect x="0" y="-14" width="12" height="3" rx="2" fill="#113b52" />
    <text x="18" y="-8" font-size="12" font-family="Avenir Next, Segoe UI, sans-serif" fill="#506274">SMA20</text>
    <rect x="88" y="-14" width="12" height="3" rx="2" fill="#7a8f27" />
    <text x="106" y="-8" font-size="12" font-family="Avenir Next, Segoe UI, sans-serif" fill="#506274">SMA50</text>
    <text x="${plotWidth}" y="-8" text-anchor="end" font-size="12" font-family="Avenir Next, Segoe UI, sans-serif" fill="#506274">Last 60 sessions</text>
  </g>
</svg>`;
}

function movingAveragePoints(candles, windowSize, stepX, startX, scaleY) {
  const points = [];

  for (let index = 0; index < candles.length; index += 1) {
    if (index + 1 < windowSize) continue;
    const window = candles.slice(index + 1 - windowSize, index + 1);
    const average = window.reduce((sum, candle) => sum + candle.close, 0) / window.length;
    const x = startX + index * stepX + stepX / 2;
    points.push(`${round(x)},${round(scaleY(average))}`);
  }

  return points.length ? points.join(" ") : "";
}

function buildPriceTicks(minPrice, maxPrice, count) {
  const ticks = [];
  const step = (maxPrice - minPrice) / Math.max(count - 1, 1);

  for (let index = 0; index < count; index += 1) {
    const price = maxPrice - step * index;
    ticks.push({ price, y: round(74 + (index / Math.max(count - 1, 1)) * (620 - 74 - 68)) });
  }

  return ticks;
}

function buildDateLabels(candles, stepX, startX, y) {
  const points = [];
  const indexes = [0, Math.floor(candles.length * 0.33), Math.floor(candles.length * 0.66), candles.length - 1]
    .filter((value, index, array) => array.indexOf(value) === index);

  for (const index of indexes) {
    const candle = candles[index];
    const x = startX + index * stepX + stepX / 2;
    points.push(`<text x="${round(x)}" y="${round(y)}" text-anchor="middle" font-size="12" font-family="Avenir Next, Segoe UI, sans-serif" fill="#6d7887">${escapeXml(formatShortDate(candle.date))}</text>`);
  }

  return points;
}

function formatShortDate(value) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function formatPrice(value) {
  return Number(value).toFixed(2);
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function analyzeTicker(ticker, candles, benchmarks, daily) {
  const latest = candles.at(-1);
  const previous = candles.at(-2);
  const dailyContext = deriveDailyContext(ticker, daily);
  const sma20 = average(candles.slice(-20).map((candle) => candle.close));
  const sma50 = average(candles.slice(-50).map((candle) => candle.close));
  const avgVolume20 = average(candles.slice(-20).map((candle) => candle.volume));
  const atr14 = average(
    candles.slice(-14).map((candle, index, window) => {
      const priorClose = index === 0 ? candles.at(-(14 + 1))?.close ?? candle.close : window[index - 1].close;
      return trueRange(candle, priorClose);
    }),
  );

  const range20 = candles.slice(-20, -1);
  const resistance20 = Math.max(...range20.map((candle) => candle.high));
  const support20 = Math.min(...range20.map((candle) => candle.low));
  const volumeRatio = latest.volume / Math.max(avgVolume20, 1);
  const pattern = detectPrimaryPattern(candles);
  const trend = latest.close > sma20 && sma20 > sma50 ? "Uptrend" : latest.close < sma20 && sma20 < sma50 ? "Downtrend" : "Mixed";
  const relativeLocation = latest.close > resistance20 ? "Above resistance" : latest.close < support20 ? "Below support" : "Inside range";
  const relativeStrength = analyzeRelativeStrength(candles, benchmarks);
  const sectorStrength = analyzeSectorStrength(candles, benchmarks, dailyContext.sectorProxy);
  const eventRisk = analyzeEventRisk(ticker, dailyContext);
  const structure = analyzeStructure({ latest, previous, sma20, sma50, resistance20, support20, atr14, volumeRatio, candles });
  const breakoutScore = scoreBreakout({ trend, pattern, latest, resistance20, volumeRatio, relativeStrength, sectorStrength, structure, eventRisk });
  const pullbackScore = scorePullback({ trend, pattern, latest, support20, sma20, sma50, volumeRatio, relativeStrength, sectorStrength, structure, eventRisk });
  const premarketMove = inferPremarketMove(ticker.evidence);
  const setup = classifySetup({
    trend,
    pattern,
    latest,
    previous,
    resistance20,
    support20,
    volumeRatio,
    ticker,
    breakoutScore,
    pullbackScore,
    relativeStrength,
    sectorStrength,
    premarketMove,
    structure,
    eventRisk,
  });
  const score = scorePattern({
    setup,
    trend,
    pattern,
    latest,
    resistance20,
    support20,
    volumeRatio,
    ticker,
    breakoutScore,
    pullbackScore,
    relativeStrength,
    sectorStrength,
    premarketMove,
    structure,
    eventRisk,
  });
  const primaryStrategy = breakoutScore >= pullbackScore ? "Breakout" : "Pullback";

  return {
    score,
    pattern,
    setup,
    primaryStrategy,
    trend,
    close: round(latest.close),
    sma20: round(sma20),
    sma50: round(sma50),
    atr14: round(atr14),
    avgVolume20: Math.round(avgVolume20),
    volumeRatio: round(volumeRatio),
    support20: round(support20),
    resistance20: round(resistance20),
    relativeLocation,
    breakoutScore,
    pullbackScore,
    relativeStrengthScore: relativeStrength.score,
    relativeStrengthLabel: relativeStrength.label,
    sectorProxy: dailyContext.sectorProxy ?? null,
    sectorRelativeStrengthScore: sectorStrength.score,
    sectorRelativeStrengthLabel: sectorStrength.label,
    rsSector20: sectorStrength.rs20,
    rsSector50: sectorStrength.rs50,
    eventRiskScore: eventRisk.score,
    eventRiskLabel: eventRisk.label,
    eventRiskFlags: eventRisk.flags,
    extensionScore: structure.extensionScore,
    extensionLabel: structure.extensionLabel,
    structureQualityScore: structure.qualityScore,
    rsSpy20: relativeStrength.rsSpy20,
    rsSpy50: relativeStrength.rsSpy50,
    rsQqq20: relativeStrength.rsQqq20,
    rsQqq50: relativeStrength.rsQqq50,
    premarketMove,
    trigger: buildTrigger({ setup, latest, resistance20, support20 }),
    invalidation: buildInvalidation({ setup, latest, support20, atr14 }),
    target: buildTarget({ setup, latest, resistance20, support20, atr14 }),
    notes: buildNotes({
      ticker,
      pattern,
      trend,
      volumeRatio,
      latest,
      previous,
      sma20,
      sma50,
      relativeStrength,
      sectorStrength,
      breakoutScore,
      pullbackScore,
      premarketMove,
      dailyContext,
      eventRisk,
      structure,
    }),
  };
}

function deriveDailyContext(ticker, daily) {
  const events = (daily?.events ?? []).filter((event) => event?.symbol === ticker.symbol);
  const evidenceText = [ticker.evidence, ticker.nextCheck, ...(ticker.positives ?? []), ...(ticker.risks ?? [])].join(" ");
  return {
    events,
    macroEventCount: (daily?.events ?? []).filter((event) => event?.kind === "economic").length,
    sectorProxy: inferSectorProxy(ticker.symbol, evidenceText),
    sourceCount: ticker.sources?.length ?? 0,
  };
}

function inferPremarketMove(evidence) {
  const text = String(evidence ?? "").replace(/,/g, "");
  const downMatch = text.match(/\b(?:fell|down|slumped|dropped|lost)\s+(?:over\s+|around\s+|about\s+)?(\d+(?:\.\d+)?)%\s+(?:ahead of the opening bell|pre-market|premarket|pre-open)/i);
  if (downMatch) return -Number(downMatch[1]);

  const upMatch = text.match(/\b(?:rose|up|jumped|popped|gained)\s+(?:over\s+|around\s+|about\s+)?(\d+(?:\.\d+)?)%\s+(?:ahead of the opening bell|pre-market|premarket|pre-open)/i);
  if (upMatch) return Number(upMatch[1]);

  return null;
}

function analyzeRelativeStrength(candles, benchmarks) {
  const stock20 = percentChange(candles.at(-21)?.close, candles.at(-1)?.close);
  const stock50 = percentChange(candles.at(-51)?.close, candles.at(-1)?.close);
  const spy20 = benchmarks.SPY?.ok ? benchmarks.SPY.return20 : null;
  const spy50 = benchmarks.SPY?.ok ? benchmarks.SPY.return50 : null;
  const qqq20 = benchmarks.QQQ?.ok ? benchmarks.QQQ.return20 : null;
  const qqq50 = benchmarks.QQQ?.ok ? benchmarks.QQQ.return50 : null;
  const rsSpy20 = spy20 == null ? null : round(stock20 - spy20);
  const rsSpy50 = spy50 == null ? null : round(stock50 - spy50);
  const rsQqq20 = qqq20 == null ? null : round(stock20 - qqq20);
  const rsQqq50 = qqq50 == null ? null : round(stock50 - qqq50);
  const values = [rsSpy20, rsSpy50, rsQqq20, rsQqq50].filter((value) => value != null);
  const averageRs = values.length ? average(values) : 0;

  return {
    score: clamp(Math.round(50 + averageRs * 3), 0, 100),
    label: averageRs >= 5 ? "Leader" : averageRs >= 1 ? "Outperforming" : averageRs <= -5 ? "Laggard" : averageRs <= -1 ? "Lagging" : "In line",
    rsSpy20,
    rsSpy50,
    rsQqq20,
    rsQqq50,
  };
}

function analyzeSectorStrength(candles, benchmarks, sectorProxy) {
  if (!sectorProxy || !benchmarks?.[sectorProxy]?.ok) {
    return {
      score: 50,
      label: "Unknown",
      rs20: null,
      rs50: null,
    };
  }

  const stock20 = percentChange(candles.at(-21)?.close, candles.at(-1)?.close);
  const stock50 = percentChange(candles.at(-51)?.close, candles.at(-1)?.close);
  const sector20 = benchmarks[sectorProxy].return20;
  const sector50 = benchmarks[sectorProxy].return50;
  const rs20 = round(stock20 - sector20);
  const rs50 = round(stock50 - sector50);
  const averageRs = average([rs20, rs50]);

  return {
    score: clamp(Math.round(50 + averageRs * 4), 0, 100),
    label: averageRs >= 5 ? "Leading sector peers" : averageRs >= 1 ? "Beating sector" : averageRs <= -5 ? "Lagging sector badly" : averageRs <= -1 ? "Lagging sector" : "In line with sector",
    rs20,
    rs50,
  };
}

function analyzeEventRisk(ticker, dailyContext) {
  const flags = [];
  let score = 8;
  const text = [ticker.evidence, ticker.nextCheck, ...(ticker.risks ?? [])].join(" ");

  if (dailyContext.events.some((event) => event.kind === "earnings")) {
    score += 28;
    flags.push("same-day earnings event");
  }

  if (/\b(before open|after close|reports? (before|after)|earnings)\b/i.test(text)) {
    score += 12;
    flags.push("fresh earnings reaction");
  }

  if (/\b(guidance|outlook|layoff|cuts|probe|investigation|lawsuit|tariff|downgrade|miss|warning|margin pressure)\b/i.test(text)) {
    score += 16;
    flags.push("headline sensitivity");
  }

  if (dailyContext.macroEventCount >= 3) {
    score += 5;
    flags.push("busy macro tape");
  }

  const label = score >= 50 ? "High event risk" : score >= 28 ? "Medium event risk" : "Low event risk";
  return { score: clamp(score, 0, 100), label, flags };
}

function analyzeStructure({ latest, previous, sma20, sma50, resistance20, support20, atr14, volumeRatio, candles }) {
  const extensionFromSma20 = percentChange(sma20, latest.close);
  const extensionFromResistance = percentChange(resistance20, latest.close);
  const supportBuffer = percentChange(support20, latest.close);
  const nearRecentHigh = latest.close >= Math.max(...candles.slice(-10).map((candle) => candle.close)) * 0.985;

  let extensionScore = 55;
  if (extensionFromSma20 >= 12) extensionScore -= 28;
  else if (extensionFromSma20 >= 8) extensionScore -= 18;
  else if (extensionFromSma20 <= 1 && latest.close >= sma20) extensionScore += 8;

  if (extensionFromResistance >= 10) extensionScore -= 18;
  else if (extensionFromResistance >= 5) extensionScore -= 10;
  else if (extensionFromResistance >= -2 && extensionFromResistance <= 3) extensionScore += 10;

  if (supportBuffer <= 2 && latest.close >= support20) extensionScore += 8;
  if (latest.close < sma20) extensionScore -= 10;

  let qualityScore = 42;
  if (latest.close > sma20 && sma20 > sma50) qualityScore += 16;
  if (volumeRatio >= 1.2 && volumeRatio <= 3.5) qualityScore += 10;
  if (nearRecentHigh) qualityScore += 10;
  if (atr14 > 0 && (latest.high - latest.low) / atr14 >= 2.4) qualityScore -= 10;
  if (previous && latest.close < previous.close && latest.close < sma20) qualityScore -= 8;

  const label = extensionScore >= 62 ? "Fresh" : extensionScore >= 42 ? "Workable" : extensionScore >= 25 ? "Extended" : "Stale / stretched";
  return {
    extensionScore: clamp(Math.round(extensionScore), 0, 100),
    extensionLabel: label,
    qualityScore: clamp(Math.round(qualityScore), 0, 100),
  };
}

function detectPrimaryPattern(candles) {
  const latest = candles.at(-1);
  const previous = candles.at(-2);
  if (!latest || !previous) return "Insufficient data";

  if (isBullishEngulfing(previous, latest)) return "Bullish Engulfing";
  if (isBearishEngulfing(previous, latest)) return "Bearish Engulfing";
  if (isHammer(latest)) return "Hammer";
  if (isShootingStar(latest)) return "Shooting Star";
  if (isInsideDay(previous, latest)) return "Inside Day";
  if (latest.close > Math.max(...candles.slice(-21, -1).map((candle) => candle.high))) return "20-Day Breakout Close";
  if (latest.close < Math.min(...candles.slice(-21, -1).map((candle) => candle.low))) return "20-Day Breakdown Close";
  return "No major pattern";
}

function classifySetup({ trend, pattern, latest, resistance20, support20, volumeRatio, ticker, breakoutScore, pullbackScore, relativeStrength, sectorStrength, premarketMove, structure, eventRisk }) {
  const closeNearHigh = latest.close >= latest.low + (latest.high - latest.low) * 0.7;

  if (premarketMove != null && premarketMove <= -8) return "Risk / Avoid";
  if (eventRisk.score >= 60 && /miss|layoff|cuts|warning/i.test(String(ticker.evidence ?? ""))) return "Risk / Avoid";
  if (/Breakdown|Bearish|Shooting Star/.test(pattern)) return "Risk / Avoid";
  if (structure.extensionScore < 20 && /Breakout|Inside Day/.test(pattern)) return "Needs More Confirmation";
  if (breakoutScore >= 78 && structure.extensionScore >= 35) return "Breakout Candidate";
  if (pullbackScore >= 76 && /Bullish Engulfing|Hammer/.test(pattern) && structure.extensionScore >= 40) return "Pullback Reversal";
  if (/Inside Day/.test(pattern) && trend === "Uptrend" && closeNearHigh && relativeStrength.score >= 55 && sectorStrength.score >= 48) return "Inside-Day Breakout Watch";
  if (pullbackScore >= 62 && structure.extensionScore >= 38) return "Trend Pullback Watch";
  if ((ticker.stance === "Buy Candidate" || ticker.score >= 65) && volumeRatio >= 1 && relativeStrength.score >= 50 && sectorStrength.score >= 45) return "Catalyst Continuation Watch";
  return "Needs More Confirmation";
}

function scorePattern({ setup, trend, pattern, latest, resistance20, support20, volumeRatio, ticker, breakoutScore, pullbackScore, relativeStrength, sectorStrength, premarketMove, structure, eventRisk }) {
  let score = Math.round((ticker.score ?? 50) * 0.45);
  if (premarketMove != null && premarketMove <= -8) score -= 45;
  else if (premarketMove != null && premarketMove >= 5) score += 8;
  if (trend === "Uptrend") score += 15;
  if (/Breakout Candidate|Catalyst Continuation Watch/.test(setup)) score += 16;
  if (/Pullback Reversal|Inside-Day Breakout Watch|Trend Pullback Watch/.test(setup)) score += 10;
  if (/Bullish|Hammer|Breakout/.test(pattern)) score += 12;
  if (/Bearish|Breakdown|Shooting Star/.test(pattern)) score -= 20;
  if (volumeRatio >= 1.5) score += 10;
  if (latest.close > resistance20) score += 8;
  if (latest.close < support20) score -= 12;
  score += Math.round(relativeStrength.score * 0.12) - 6;
  score += Math.round(sectorStrength.score * 0.08) - 4;
  score += Math.round(Math.max(breakoutScore, pullbackScore) * 0.1) - 5;
  score += Math.round(structure.qualityScore * 0.08) - 4;
  score += Math.round(structure.extensionScore * 0.1) - 5;
  score -= Math.round(eventRisk.score * 0.16);
  if (structure.extensionScore < 20) score -= 30;
  else if (structure.extensionScore < 35) score -= 15;
  return clamp(score, 0, 100);
}

function scoreBreakout({ trend, pattern, latest, resistance20, volumeRatio, relativeStrength, sectorStrength, structure, eventRisk }) {
  let score = 20;
  if (trend === "Uptrend") score += 20;
  if (latest.close >= resistance20 * 0.995) score += 18;
  if (/Breakout|Inside Day/.test(pattern)) score += 18;
  if (volumeRatio >= 1.2) score += 12;
  if (volumeRatio >= 1.8) score += 8;
  score += Math.round(relativeStrength.score * 0.18) - 9;
  score += Math.round(sectorStrength.score * 0.12) - 6;
  score += Math.round(structure.qualityScore * 0.12) - 6;
  score += Math.round(structure.extensionScore * 0.08) - 4;
  score -= Math.round(eventRisk.score * 0.12);
  if (structure.extensionScore < 20) score -= 28;
  else if (structure.extensionScore < 35) score -= 12;
  return clamp(score, 0, 100);
}

function scorePullback({ trend, pattern, latest, support20, sma20, sma50, volumeRatio, relativeStrength, sectorStrength, structure, eventRisk }) {
  let score = 18;
  if (trend === "Uptrend") score += 24;
  if (latest.close >= sma20 * 0.985 && latest.close <= sma20 * 1.03) score += 18;
  if (latest.close >= support20 * 1.01 && latest.close <= support20 * 1.08) score += 14;
  if (/Bullish Engulfing|Hammer/.test(pattern)) score += 18;
  if (volumeRatio >= 0.9 && volumeRatio <= 1.6) score += 8;
  if (latest.close > sma50) score += 8;
  score += Math.round(relativeStrength.score * 0.14) - 7;
  score += Math.round(sectorStrength.score * 0.1) - 5;
  score += Math.round(structure.qualityScore * 0.1) - 5;
  score += Math.round(structure.extensionScore * 0.12) - 6;
  score -= Math.round(eventRisk.score * 0.08);
  return clamp(score, 0, 100);
}

function buildTrigger({ setup, latest, resistance20, support20 }) {
  if (setup === "Breakout Candidate") return `Buy only above ${round(Math.max(latest.high, resistance20))} with follow-through volume.`;
  if (setup === "Pullback Reversal") return `Buy only if price holds above ${round(support20)} and takes out ${round(latest.high)}.`;
  if (setup === "Inside-Day Breakout Watch") return `Buy only on an inside-day break above ${round(latest.high)}.`;
  if (setup === "Trend Pullback Watch") return `Watch for support near ${round(support20)} and a higher low before entry.`;
  if (setup === "Catalyst Continuation Watch") return `Enter only if the move stays above ${round((latest.high + latest.low) / 2)} and volume remains firm.`;
  return "No long trigger yet.";
}

function buildInvalidation({ setup, latest, support20, atr14 }) {
  if (setup === "Risk / Avoid") return "Invalidation already broken; wait for a fresh base.";
  if (/Breakout|Inside-Day/.test(setup)) return `Stop below ${round(Math.max(support20, latest.low - atr14 * 0.5))}.`;
  return `Stop below ${round(Math.min(support20, latest.low) - atr14 * 0.25)}.`;
}

function buildTarget({ setup, latest, resistance20, atr14 }) {
  if (setup === "Risk / Avoid") return "No upside target until trend repairs.";
  if (setup === "Breakout Candidate") return `First target ${round(latest.close + atr14 * 2)}; next area beyond ${round(resistance20 + atr14 * 2)}.`;
  return `Initial target near ${round(latest.close + atr14 * 1.5)} with 2R minimum.`;
}

function buildNotes({ ticker, pattern, trend, volumeRatio, latest, previous, sma20, sma50, relativeStrength, sectorStrength, breakoutScore, pullbackScore, premarketMove, dailyContext, eventRisk, structure }) {
  const notes = [];
  if (pattern !== "No major pattern") notes.push(`Detected ${pattern}.`);
  notes.push(`${trend} with close ${round(latest.close)} versus SMA20 ${round(sma20)} and SMA50 ${round(sma50)}.`);
  notes.push(`Volume ran at ${round(volumeRatio)}x the 20-day average.`);
  notes.push(`Relative strength is ${relativeStrength.label.toLowerCase()} versus SPY/QQQ.`);
  if (dailyContext.sectorProxy) notes.push(`Sector check versus ${dailyContext.sectorProxy}: ${sectorStrength.label.toLowerCase()}.`);
  notes.push(`Structure quality ${structure.qualityScore} with setup freshness tagged ${structure.extensionLabel.toLowerCase()}.`);
  notes.push(`Breakout score ${breakoutScore} | Pullback score ${pullbackScore}.`);
  if (eventRisk.score >= 28) notes.push(`Event risk is ${eventRisk.label.toLowerCase()}${eventRisk.flags.length ? ` (${eventRisk.flags.join(", ")})` : ""}.`);
  if (premarketMove != null) notes.push(`Source evidence points to a ${Math.abs(round(premarketMove))}% premarket move ${premarketMove >= 0 ? "up" : "down"}.`);
  if (latest.close > previous.close) notes.push("Latest close improved versus the prior session.");
  if (ticker.evidence) notes.push(`Narrative: ${truncate(ticker.evidence, 160)}`);
  return notes;
}

function inferSectorProxy(symbol, text) {
  const upper = String(symbol ?? "").toUpperCase();
  const haystack = `${upper} ${String(text ?? "").toUpperCase()}`;

  const directMap = {
    AAPL: "XLK",
    AMD: "SMH",
    AMZN: "XLY",
    AVGO: "SMH",
    ABNB: "XLY",
    BAM: "XLF",
    BKNG: "XLY",
    BLD: "XLI",
    COIN: "XLF",
    CRWV: "XLK",
    CVNA: "XLY",
    DGX: "XLV",
    DLR: "XLRE",
    ENB: "XLE",
    EQT: "XLE",
    GOOG: "XLC",
    HUBS: "XLK",
    IBM: "XLK",
    IREN: "XLK",
    MA: "XLF",
    MELI: "XLY",
    META: "XLC",
    MNST: "XLP",
    MSFT: "XLK",
    NET: "XLK",
    NFLX: "XLC",
    NVDA: "SMH",
    ONON: "XLY",
    PLD: "XLRE",
    QXO: "XLI",
    RBLX: "XLC",
    RKLB: "XLI",
    SPOT: "XLC",
    TEAM: "XLK",
    TFC: "XLF",
    TSCO: "XLY",
    TSM: "SMH",
    TWLO: "XLK",
    UNH: "XLV",
  };

  if (directMap[upper]) return directMap[upper];
  if (/\b(SEMI|CHIP|NVIDIA|AI INFRASTRUCTURE|DATACENTER)\b/.test(haystack)) return "SMH";
  if (/\b(CLOUD|SOFTWARE|CYBER|SAAS)\b/.test(haystack)) return "XLK";
  if (/\b(INTERNET|STREAMING|MEDIA|ADVERTISING|SOCIAL)\b/.test(haystack)) return "XLC";
  if (/\b(CONSUMER|TRAVEL|RETAIL|E-COMMERCE)\b/.test(haystack)) return "XLY";
  if (/\b(BANK|INSUR|PAYMENT|ASSET MANAGEMENT|FINANCIAL)\b/.test(haystack)) return "XLF";
  if (/\b(ENERGY|OIL|GAS|PIPELINE|UTILITY POWER)\b/.test(haystack)) return "XLE";
  if (/\b(HEALTH|BIOTECH|PHARMA|MEDICAL)\b/.test(haystack)) return "XLV";
  if (/\b(INDUSTRIAL|AEROSPACE|DEFENSE|SPACE)\b/.test(haystack)) return "XLI";
  if (/\b(REIT|WAREHOUSE|DATA CENTER REAL ESTATE|LOGISTICS)\b/.test(haystack)) return "XLRE";
  return null;
}

function percentChange(from, to) {
  if (!from || !to) return 0;
  return ((to - from) / from) * 100;
}

function trueRange(candle, priorClose) {
  return Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - priorClose),
    Math.abs(candle.low - priorClose),
  );
}

function isBullishEngulfing(previous, latest) {
  return previous.close < previous.open &&
    latest.close > latest.open &&
    latest.open <= previous.close &&
    latest.close >= previous.open;
}

function isBearishEngulfing(previous, latest) {
  return previous.close > previous.open &&
    latest.close < latest.open &&
    latest.open >= previous.close &&
    latest.close <= previous.open;
}

function isHammer(candle) {
  const body = Math.abs(candle.close - candle.open);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  return lowerWick >= body * 2 && upperWick <= body;
}

function isShootingStar(candle) {
  const body = Math.abs(candle.close - candle.open);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  return upperWick >= body * 2 && lowerWick <= body;
}

function isInsideDay(previous, latest) {
  return latest.high <= previous.high && latest.low >= previous.low;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function truncate(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
