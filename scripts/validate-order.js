import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import "dotenv/config";
import { buildValidatedLongOrderPlan } from "./lib/order-ticket.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const DAILY_DIR = path.join(ROOT, "data", "daily");
const CANDLES_DIR = path.join(ROOT, "data", "candles");

const args = parseArgs(process.argv.slice(2));

if (!args.symbol) {
  console.log("Usage: npm run validate-order -- --symbol TICKER [--date YYYY-MM-DD]");
  process.exit(1);
}

const date = args.date ?? (await latestDate());
const symbol = String(args.symbol).toUpperCase();

const daily = await readOptionalJson(path.join(DAILY_DIR, `${date}.json`));
if (!daily) {
  console.error(`No daily dataset found for ${date}.`);
  process.exit(1);
}

const candleSummary = await readOptionalJson(path.join(CANDLES_DIR, date, "summary.json"));
const candle = (candleSummary?.tickers ?? []).find((item) => item.symbol === symbol && item.ok) ?? null;
if (!candle) {
  console.error(`No valid candle summary found for ${symbol} on ${date}.`);
  process.exit(1);
}

const candidate = (daily.candidates ?? []).find((item) => item.symbol === symbol) ?? null;
const liveSnapshot = await loadLiveSnapshot(symbol);
const livePrice = liveSnapshot?.currentPrice ?? candle.close ?? null;
const plan = buildValidatedLongOrderPlan({ symbol, candle, livePrice });

const result = {
  symbol,
  date,
  stance: candidate?.stance ?? "unknown",
  setup: candle.setup,
  trigger: candle.trigger,
  invalidation: candle.invalidation,
  target: candle.target,
  livePrice,
  relativeStrength: candle.relativeStrengthLabel,
  volumeRatio: candle.volumeRatio,
  executable: plan.ok,
  orderPlan: plan.ok
    ? {
        style: plan.style,
        entry: plan.entry,
        stop: plan.stop,
        target: plan.target,
      }
    : null,
  rejectionReason: plan.ok ? "" : plan.reason,
  rejectionReasons: plan.ok ? [] : plan.reasons,
};

console.log(JSON.stringify(result, null, 2));

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--symbol") parsed.symbol = argv[++index];
    else if (arg === "--date") parsed.date = argv[++index];
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

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function loadLiveSnapshot(symbol) {
  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) return null;

  const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(symbol)}?apiKey=${encodeURIComponent(apiKey)}`;
  try {
    const response = await fetch(url);
    const payload = await response.json();
    if (!response.ok) return null;
    const item = payload.ticker ?? payload.results ?? payload;
    const price = item?.lastTrade?.p ?? item?.min?.c ?? item?.day?.c ?? null;
    return Number.isFinite(Number(price)) ? { currentPrice: Number(price) } : null;
  } catch {
    return null;
  }
}
