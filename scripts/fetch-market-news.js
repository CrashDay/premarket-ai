import { readFile } from "node:fs/promises";
import path from "node:path";
import "dotenv/config";
import { fetchMarketauxSummary } from "./lib/marketaux.js";
import { fetchNewsApiFallback } from "./lib/newsapi.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const DAILY_DIR = path.join(ROOT, "data", "daily");
const args = parseArgs(process.argv.slice(2));
const runDate = args.date ?? (await latestDate());
const daily = JSON.parse(await readFile(path.join(DAILY_DIR, `${runDate}.json`), "utf8"));
const COMPANY_NAME_OVERRIDES = {
  AAPL: "Apple",
  GOOG: "Alphabet",
  NVDA: "NVIDIA",
  RKLB: "Rocket Lab",
  MNDY: "monday.com",
  HIMS: "Hims & Hers Health",
  CRCL: "Circle Internet Group",
};

const candidates = (daily.candidates ?? [])
  .filter((candidate) => candidate.stance !== "Low Priority")
  .slice(0, args.limit);

const symbols = candidates.map((candidate) => candidate.symbol);

const summary = await fetchMarketauxSummary({
  date: runDate,
  symbols,
  limit: args.articlesPerSymbol,
  perArticleLimit: args.perRequestLimit,
});

if (!summary.ok) {
  console.log(`Marketaux enrichment skipped: ${(summary.errors ?? []).join("; ") || "Unknown error"}`);
  process.exit(0);
}

const missingTargets = candidates
  .filter((candidate) => Number(summary.symbols?.[candidate.symbol]?.count ?? 0) === 0)
  .map((candidate) => ({
    symbol: candidate.symbol,
    companyName: inferCompanyName(candidate.evidence, candidate.symbol),
  }));

const newsApi = await fetchNewsApiFallback({
  date: runDate,
  targets: missingTargets,
  limit: args.articlesPerSymbol,
});

const merged = mergeSummaries(summary, newsApi, runDate);
await writeMergedSummary(merged, runDate);

console.log(`Fetched Marketaux news for ${Object.keys(summary.symbols ?? {}).length} symbol(s).`);
if (newsApi.ok) {
  console.log(`Fetched NewsAPI fallback for ${Object.keys(newsApi.symbols ?? {}).length} fallback symbol(s).`);
} else if ((newsApi.errors ?? []).length) {
  console.log(`NewsAPI fallback skipped: ${(newsApi.errors ?? []).join("; ")}`);
}
console.log(`Wrote news summary: ${path.join(ROOT, "data", "news", runDate, "summary.json")}`);

function parseArgs(argv) {
  const parsed = {
    limit: 20,
    articlesPerSymbol: 5,
    perRequestLimit: 30,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--date") parsed.date = argv[++index];
    else if (arg === "--limit") parsed.limit = Number(argv[++index] || 20);
    else if (arg === "--articles-per-symbol") parsed.articlesPerSymbol = Number(argv[++index] || 5);
    else if (arg === "--per-request-limit") parsed.perRequestLimit = Number(argv[++index] || 30);
  }

  return parsed;
}

async function latestDate() {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(DAILY_DIR, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.replace(/\.json$/, ""))
    .sort();
  if (!files.length) throw new Error("No daily data files found.");
  return files.at(-1);
}

function inferCompanyName(evidence, symbol) {
  if (COMPANY_NAME_OVERRIDES[symbol]) return COMPANY_NAME_OVERRIDES[symbol];
  const text = String(evidence ?? "");
  const patterns = [
    new RegExp(`([A-Z][A-Za-z0-9&.'’ -]{2,}?)\\s*\\((?:NASDAQ|NYSE|OTC|AMEX)?[:\\s]*${symbol}\\b`, "i"),
    new RegExp(`([A-Z][A-Za-z0-9&.'’ -]{2,}?)\\s*\\(${symbol}\\b`, "i"),
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }

  return "";
}

async function writeMergedSummary(summary, date) {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const outputDir = path.join(ROOT, "data", "news", date);
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

function mergeSummaries(primary, fallback, date) {
  const symbols = Object.keys(primary.symbols ?? {});
  const mergedSymbols = {};
  let articleCount = 0;

  for (const symbol of symbols) {
    const marketaux = primary.symbols?.[symbol] ?? { symbol, count: 0, sentiment: "unknown", headlines: [] };
    const newsApi = fallback.symbols?.[symbol] ?? { symbol, count: 0, sentiment: "unknown", headlines: [] };
    const chosen = marketaux.count ? marketaux : newsApi;
    mergedSymbols[symbol] = {
      ...chosen,
      primaryProvider: marketaux.count ? "Marketaux" : newsApi.count ? "NewsAPI" : "none",
      fallbackProvider: marketaux.count && newsApi.count ? "NewsAPI" : null,
      marketauxCount: marketaux.count ?? 0,
      newsApiCount: newsApi.count ?? 0,
    };
    articleCount += chosen.count ?? 0;
  }

  return {
    date,
    fetchedAt: new Date().toISOString(),
    provider: "Marketaux + NewsAPI",
    ok: true,
    requestedSymbols: symbols,
    articleCount,
    errors: [...(primary.errors ?? []), ...(fallback.errors ?? [])],
    symbols: mergedSymbols,
  };
}
