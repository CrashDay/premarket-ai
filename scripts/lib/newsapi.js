import "dotenv/config";

const API_KEY = process.env.NEWSAPI_API_KEY;
const BASE_URL = "https://newsapi.org/v2/everything";
const REQUEST_TIMEOUT_MS = Number(process.env.NEWSAPI_TIMEOUT_MS || 15000);
const LOOKBACK_DAYS = Number(process.env.NEWSAPI_LOOKBACK_DAYS || 3);
const MIN_QUALITY_SCORE = Number(process.env.NEWSAPI_MIN_QUALITY_SCORE || 32);
const TRUSTED_SOURCES = new Set([
  "reuters",
  "bloomberg",
  "cnbc",
  "marketwatch",
  "the-wall-street-journal",
  "the-motley-fool",
  "seeking-alpha",
  "benzinga",
  "business-insider",
  "financial-times",
  "the-street",
  "yahoo-entertainment",
]);
const BLOCKED_SOURCE_PATTERNS = [
  /softpedia/i,
  /pypi/i,
  /crypto briefing/i,
  /slashdot/i,
  /ibtimes/i,
  /globenewswire/i,
  /prnewswire/i,
];
const BLOCKED_URL_PATTERNS = [
  /consent\.yahoo\.com/i,
];
const GENERIC_BLOCK_PATTERNS = [
  /\bgraphics driver\b/i,
  /\bwindows 11\b/i,
  /\bpypi\b/i,
  /^\s*[a-z0-9-]+\s+\d+\.\d+\.\d+/i,
  /\bclass action\b/i,
  /\bdeadline tomorrow\b/i,
  /\binvestor counsel\b/i,
  /\bsecurities fraud lawsuit\b/i,
];
const COMPANY_ALIASES = {
  AAPL: ["Apple"],
  GOOG: ["Alphabet", "Google"],
  NVDA: ["NVIDIA"],
  RKLB: ["Rocket Lab"],
  MNDY: ["monday.com", "Monday.com"],
  HIMS: ["Hims & Hers", "Hims & Hers Health", "Hims and Hers"],
  CRCL: ["Circle Internet Group"],
  CSCO: ["Cisco", "Cisco Systems"],
  SPG: ["Simon Property Group"],
};

export async function fetchNewsApiFallback({ date, targets, limit = 3 }) {
  if (!API_KEY) {
    return {
      ok: false,
      provider: "NewsAPI",
      fetchedAt: new Date().toISOString(),
      errors: ["Missing NEWSAPI_API_KEY in .env"],
      symbols: {},
    };
  }

  const symbols = [...new Set((targets ?? []).map((item) => String(item?.symbol ?? "").trim().toUpperCase()).filter(Boolean))];
  const results = {};
  const errors = [];

  for (const target of targets ?? []) {
    const symbol = String(target?.symbol ?? "").trim().toUpperCase();
    if (!symbol) continue;
    if (results[symbol]) continue;

    try {
      results[symbol] = await fetchForTarget({ symbol, companyName: target?.companyName ?? "", date, limit });
    } catch (error) {
      results[symbol] = { symbol, count: 0, sentiment: "unknown", headlines: [] };
      errors.push(`${symbol}: ${error?.message ?? "NewsAPI fetch failed"}`);
    }
  }

  return {
    ok: true,
    provider: "NewsAPI",
    fetchedAt: new Date().toISOString(),
    errors,
    symbols: results,
  };
}

async function fetchForTarget({ symbol, companyName, date, limit }) {
  const from = daysAgo(date, Math.max(LOOKBACK_DAYS - 1, 0));
  const queryValue = buildQuery(symbol, companyName);
  const query = new URLSearchParams({
    apiKey: API_KEY,
    q: queryValue,
    searchIn: "title,description",
    language: "en",
    sortBy: "publishedAt",
    pageSize: String(Math.max(limit * 4, 8)),
    from: `${from}T00:00:00Z`,
  });

  const response = await fetchJson(`${BASE_URL}?${query.toString()}`);
  if (!response.ok) {
    throw new Error(response.error ?? "NewsAPI request failed");
  }

  const articles = (response.articles ?? [])
    .map((article) => normalizeArticle(article, symbol, companyName))
    .filter(Boolean)
    .sort((a, b) => (b.qualityScore ?? 0) - (a.qualityScore ?? 0) || String(b.publishedAt ?? "").localeCompare(String(a.publishedAt ?? "")));

  const deduped = dedupeByUrl(articles).slice(0, limit);

  return {
    symbol,
    count: deduped.length,
    sentiment: summarizeSentiment(deduped),
    headlines: deduped,
  };
}

function normalizeArticle(article, symbol, companyName) {
  const title = String(article?.title ?? "");
  const description = String(article?.description ?? "");
  const sourceId = String(article?.source?.id ?? "").toLowerCase();
  const sourceName = String(article?.source?.name ?? "");
  const url = article?.url;
  if (!title || !url) return null;
  if (BLOCKED_URL_PATTERNS.some((pattern) => pattern.test(url))) return null;

  const qualityScore = scoreQuality({ title, description, sourceId, sourceName, symbol, companyName });
  if (qualityScore < MIN_QUALITY_SCORE) return null;

  return {
    title,
    description,
    snippet: description,
    url,
    source: sourceName || sourceId || "NewsAPI",
    publishedAt: article?.publishedAt,
    sentiment: inferSentiment(title, description),
    qualityScore,
  };
}

function scoreQuality({ title, description, sourceId, sourceName, symbol, companyName }) {
  const haystack = `${title} ${description}`;
  const aliases = buildAliases(symbol, companyName);
  const titleHasDirectAlias = aliases.some((alias) => containsCompany(title, alias));
  const bodyHasDirectAlias = aliases.some((alias) => containsCompany(haystack, alias));
  const titleHasTicker = containsTicker(title, symbol);
  const bodyHasTicker = containsTicker(haystack, symbol);
  let score = 0;

  if (TRUSTED_SOURCES.has(sourceId)) score += 28;
  else if (/Reuters|Bloomberg|CNBC|MarketWatch|Motley Fool|Seeking Alpha|Benzinga|Barron|Wall Street Journal|Financial Times/i.test(sourceName)) score += 22;
  if (BLOCKED_SOURCE_PATTERNS.some((pattern) => pattern.test(sourceId) || pattern.test(sourceName))) score -= 30;

  if (titleHasTicker) score += 20;
  else if (bodyHasTicker) score += 10;

  if (titleHasDirectAlias) score += 22;
  else if (bodyHasDirectAlias) score += 12;

  if (/\bearnings|guidance|results|outlook|forecast|upgrade|downgrade|price target|acquisition|merger|shares|stock\b/i.test(title)) score += 10;
  if (/\bmarket overview|global markets|mixed markets|small caps|energy lead|afternoon trading\b/i.test(title)) score -= 25;
  if (GENERIC_BLOCK_PATTERNS.some((pattern) => pattern.test(title))) score -= 28;
  if (!bodyHasTicker && !bodyHasDirectAlias) score -= 18;
  if (!titleHasTicker && !titleHasDirectAlias) score -= 8;

  return score;
}

function inferSentiment(title, description) {
  const haystack = `${title} ${description}`.toLowerCase();
  if (/\bbeats?|upgrade|bullish|surges?|jumps?|gains?|buy|strong|raises?|record|growth\b/.test(haystack)) return "positive";
  if (/\bmiss(es|ed)?|downgrade|falls?|fell|drops?|warning|cuts?|lawsuit|probe|investigation|weak\b/.test(haystack)) return "negative";
  return "neutral";
}

function summarizeSentiment(items) {
  if (!items.length) return "unknown";
  const positive = items.filter((item) => item.sentiment === "positive").length;
  const negative = items.filter((item) => item.sentiment === "negative").length;
  if (positive > negative) return "positive";
  if (negative > positive) return "negative";
  return "neutral";
}

function buildQuery(symbol, companyName) {
  const aliases = buildAliases(symbol, companyName);
  const terms = [...new Set([symbol, ...aliases].filter(Boolean))];
  return terms
    .map((term) => (/\s/.test(term) ? `"${term}"` : term))
    .join(" OR ");
}

function normalizeCompanyName(name) {
  return String(name ?? "")
    .replace(/\b(inc|corp|corporation|ltd|limited|plc|group|holdings|co)\.?$/i, "")
    .trim();
}

function buildAliases(symbol, companyName) {
  const normalizedCompany = normalizeCompanyName(companyName);
  return [...new Set([normalizedCompany, ...(COMPANY_ALIASES[symbol] ?? [])].filter(Boolean))];
}

function containsTicker(text, symbol) {
  return new RegExp(`\\b${escapeRegex(symbol)}\\b`, "i").test(String(text ?? ""));
}

function containsCompany(text, name) {
  return new RegExp(`\\b${escapeRegex(name).replace(/\s+/g, "\\s+")}\\b`, "i").test(String(text ?? ""));
}

function dedupeByUrl(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.url || item.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    const json = text ? tryParseJson(text) : null;
    if (!response.ok) {
      return { ok: false, error: json?.message ?? `HTTP ${response.status}` };
    }
    return { ok: true, ...(json ?? {}) };
  } catch (error) {
    return { ok: false, error: error?.name === "AbortError" ? `NewsAPI request timed out after ${REQUEST_TIMEOUT_MS}ms` : error?.message ?? "NewsAPI fetch failed" };
  } finally {
    clearTimeout(timeout);
  }
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function daysAgo(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

function escapeRegex(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
