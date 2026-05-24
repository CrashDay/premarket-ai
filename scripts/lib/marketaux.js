import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import "dotenv/config";

const ROOT = path.resolve(import.meta.dirname, "../..");
const NEWS_DIR = path.join(ROOT, "data", "news");
const API_TOKEN = process.env.MARKETAUX_API_TOKEN;
const BASE_URL = "https://api.marketaux.com/v1/news/all";
const REQUEST_TIMEOUT_MS = Number(process.env.MARKETAUX_TIMEOUT_MS || 15000);
const LOOKBACK_DAYS = Number(process.env.MARKETAUX_LOOKBACK_DAYS || 3);
const MIN_QUALITY_SCORE = Number(process.env.MARKETAUX_MIN_QUALITY_SCORE || 45);
const TRUSTED_SOURCE_BONUS = {
  "seekingalpha.com": 30,
  "fool.com": 26,
  "benzinga.com": 22,
  "cnbc.com": 24,
  "investing.com": 20,
  "reuters.com": 28,
  "bloomberg.com": 28,
  "finance.yahoo.com": 18,
  "marketwatch.com": 18,
  "wsj.com": 28,
  "barons.com": 24,
  "thestreet.com": 16,
};
const NOISY_SOURCE_PENALTY = {
  "thestockmarketwatch.com": -30,
  "www2.stockmarketwatch.com": -30,
  "manilatimes.net": -28,
  "globenewswire.com": -26,
  "accessnewswire.com": -24,
  "prnewswire.com": -22,
  "businesswire.com": -18,
};
const GENERIC_HEADLINE_PENALTIES = [
  /\bglobal markets\b/i,
  /\bmixed markets\b/i,
  /\bmarkets hold steady\b/i,
  /\bmarket overview\b/i,
  /\bafternoon trading\b/i,
  /\bsmall caps\b/i,
  /\benergy lead\b/i,
  /\btech drifts lower\b/i,
];

export async function fetchMarketauxSummary({ date, symbols, limit = 25, perArticleLimit = 20 }) {
  const normalizedSymbols = [...new Set((symbols ?? []).map((symbol) => String(symbol ?? "").trim().toUpperCase()).filter(Boolean))];
  if (!normalizedSymbols.length) {
    return buildEmptySummary(date, "No symbols were provided for Marketaux enrichment.");
  }

  if (!API_TOKEN) {
    return buildEmptySummary(date, "Missing MARKETAUX_API_TOKEN in .env");
  }

  const requests = chunk(normalizedSymbols, 10).map((group) =>
    fetchMarketauxChunk({
      symbols: group,
      date,
      perArticleLimit,
    }),
  );

  const chunkResults = await Promise.all(requests);
  const errors = chunkResults.flatMap((item) => item.errors ?? []);
  const articles = chunkResults.flatMap((item) => item.articles ?? []);
  const dedupedArticles = dedupeArticles(articles);
  const bySymbol = groupArticlesBySymbol(dedupedArticles, normalizedSymbols);
  const summary = {
    date,
    fetchedAt: new Date().toISOString(),
    provider: "Marketaux",
    ok: true,
    requestedSymbols: normalizedSymbols,
    articleCount: dedupedArticles.length,
    errors,
    symbols: Object.fromEntries(
      normalizedSymbols.map((symbol) => {
        const items = (bySymbol.get(symbol) ?? []).slice(0, limit);
        return [
          symbol,
          {
            symbol,
            count: items.length,
            sentiment: summarizeSymbolSentiment(items),
            headlines: items,
          },
        ];
      }),
    ),
  };

  await mkdir(path.join(NEWS_DIR, date), { recursive: true });
  await writeFile(path.join(NEWS_DIR, date, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}

export async function readMarketauxSummary(date) {
  try {
    const filePath = path.join(NEWS_DIR, date, "summary.json");
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

export async function fetchMarketauxNewsForSymbol({ symbol, date, limit = 5 }) {
  const summary = await fetchMarketauxSummary({ date, symbols: [symbol], limit, perArticleLimit: limit });
  return summary.symbols?.[String(symbol).toUpperCase()] ?? { symbol: String(symbol).toUpperCase(), count: 0, sentiment: "unknown", headlines: [] };
}

function buildEmptySummary(date, error) {
  return {
    date,
    fetchedAt: new Date().toISOString(),
    provider: "Marketaux",
    ok: false,
    requestedSymbols: [],
    articleCount: 0,
    errors: error ? [error] : [],
    symbols: {},
  };
}

async function fetchMarketauxChunk({ symbols, date, perArticleLimit }) {
  const publishedAfter = daysAgo(date, Math.max(LOOKBACK_DAYS - 1, 0));
  const query = new URLSearchParams({
    api_token: API_TOKEN,
    symbols: symbols.join(","),
    language: "en",
    filter_entities: "true",
    limit: String(perArticleLimit),
    published_after: publishedAfter,
    sort: "published_desc",
  });
  const response = await fetchJson(`${BASE_URL}?${query.toString()}`);
  if (!response.ok) {
    return { articles: [], errors: [response.error ?? "Unknown Marketaux error"] };
  }

  const articles = (response.data ?? []).map((item) => ({
    uuid: item.uuid,
    title: item.title,
    description: item.description,
    snippet: item.snippet,
    url: item.url,
    source: item.source,
    publishedAt: item.published_at,
    sentiment: normalizeSentiment(item.entities),
    entities: (item.entities ?? []).map((entity) => ({
      symbol: String(entity.symbol ?? "").toUpperCase(),
      name: entity.name,
      sentiment: entity.sentiment_score,
      matchScore: entity.match_score,
    })),
  }));

  return { articles, errors: [] };
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Marketaux request timed out after ${REQUEST_TIMEOUT_MS}ms`)), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    const json = text ? tryParseJson(text) : null;

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: json?.error?.message ?? json?.message ?? truncateText(text) ?? `HTTP ${response.status}`,
      };
    }

    return { ok: true, ...(json ?? {}) };
  } catch (error) {
    return { ok: false, error: error?.name === "AbortError" ? `Marketaux request timed out after ${REQUEST_TIMEOUT_MS}ms` : error?.message ?? "Marketaux fetch failed" };
  } finally {
    clearTimeout(timeout);
  }
}

function groupArticlesBySymbol(articles, requestedSymbols) {
  const map = new Map(requestedSymbols.map((symbol) => [symbol, []]));

  for (const article of articles) {
    for (const entity of article.entities ?? []) {
      if (!map.has(entity.symbol)) continue;
      const item = {
        title: article.title,
        description: article.description,
        snippet: article.snippet,
        url: article.url,
        source: article.source,
        publishedAt: article.publishedAt,
        sentiment: scoreToSentiment(entity.sentiment),
        entitySentimentScore: entity.sentiment,
        entityName: entity.name,
        entityMatchScore: entity.matchScore,
      };
      item.qualityScore = scoreHeadlineQuality(item, entity.symbol);
      if (isUsableHeadline(item, entity.symbol) && item.qualityScore >= MIN_QUALITY_SCORE) {
        map.get(entity.symbol).push(item);
      }
    }
  }

  for (const [symbol, items] of map.entries()) {
    items.sort((a, b) => {
      const qualityDiff = Number(b.qualityScore ?? 0) - Number(a.qualityScore ?? 0);
      if (qualityDiff !== 0) return qualityDiff;
      return String(b.publishedAt ?? "").localeCompare(String(a.publishedAt ?? ""));
    });
    map.set(symbol, dedupeHeadlines(items));
  }

  return map;
}

function summarizeSymbolSentiment(items) {
  const scores = items
    .map((item) => Number(item.entitySentimentScore))
    .filter((value) => Number.isFinite(value));

  if (!scores.length) return "unknown";
  const averageScore = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  return scoreToSentiment(averageScore);
}

function normalizeSentiment(entities = []) {
  const scores = entities
    .map((entity) => Number(entity.sentiment_score))
    .filter((value) => Number.isFinite(value));

  if (!scores.length) return "unknown";
  const averageScore = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  return scoreToSentiment(averageScore);
}

function scoreToSentiment(score) {
  if (!Number.isFinite(score)) return "unknown";
  if (score >= 0.18) return "positive";
  if (score <= -0.18) return "negative";
  return "neutral";
}

function dedupeArticles(articles) {
  const seen = new Set();
  return articles.filter((article) => {
    const key = article.uuid || article.url || article.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeHeadlines(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.url || item.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scoreHeadlineQuality(item, symbol) {
  const title = String(item.title ?? "");
  const description = String(item.description ?? "");
  const snippet = String(item.snippet ?? "");
  const source = String(item.source ?? "").toLowerCase();
  const entityName = String(item.entityName ?? "").trim();
  const haystack = `${title} ${description} ${snippet}`;
  const titleTickerMatch = containsTickerMention(title, symbol);
  const titleEntityMatch = entityName && containsEntityName(title, entityName);
  const bodyTickerMatch = containsTickerMention(haystack, symbol);
  const bodyEntityMatch = entityName && containsEntityName(haystack, entityName);

  let score = 0;
  score += sourceBonus(source);
  score += Math.round(normalizeMatchScore(item.entityMatchScore) * 20);
  score += Math.round(Math.abs(Number(item.entitySentimentScore ?? 0)) * 8);

  if (titleTickerMatch) score += 24;
  else if (bodyTickerMatch) score += 14;

  if (titleEntityMatch) score += 22;
  else if (bodyEntityMatch) score += 10;

  if (/\bearnings|guidance|downgrade|upgrade|price target|acquisition|merger|results|revenue|profit|outlook|forecast|press release|launch|layoffs?\b/i.test(title)) {
    score += 10;
  }

  if (GENERIC_HEADLINE_PENALTIES.some((pattern) => pattern.test(title))) score -= 28;
  if (!bodyTickerMatch && !bodyEntityMatch) score -= 18;
  if (!titleTickerMatch && !titleEntityMatch) score -= 20;

  return score;
}

function isUsableHeadline(item, symbol) {
  const source = String(item.source ?? "").toLowerCase();
  const title = String(item.title ?? "");
  const entityName = String(item.entityName ?? "").trim();
  const haystack = `${title} ${item.description ?? ""} ${item.snippet ?? ""}`;
  const titleMatch = containsTickerMention(title, symbol) || (entityName && containsEntityName(title, entityName));
  const bodyMatch = containsTickerMention(haystack, symbol) || (entityName && containsEntityName(haystack, entityName));

  if (NOISY_SOURCE_PENALTY[source] != null) return false;
  if (GENERIC_HEADLINE_PENALTIES.some((pattern) => pattern.test(title))) return false;
  if (titleMatch) return true;
  if (sourceBonus(source) >= 20 && bodyMatch) return true;
  return false;
}

function containsTickerMention(text, symbol) {
  return new RegExp(`\\b${escapeRegex(symbol)}\\b`, "i").test(String(text ?? ""));
}

function containsEntityName(text, name) {
  const normalized = String(name ?? "").trim();
  if (!normalized) return false;
  const compact = normalized.replace(/\s+/g, "\\s+");
  return new RegExp(`\\b${compact}\\b`, "i").test(String(text ?? ""));
}

function sourceBonus(source) {
  if (TRUSTED_SOURCE_BONUS[source] != null) return TRUSTED_SOURCE_BONUS[source];
  if (NOISY_SOURCE_PENALTY[source] != null) return NOISY_SOURCE_PENALTY[source];
  return 0;
}

function normalizeMatchScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  if (numeric <= 1) return numeric;
  return Math.min(Math.log10(numeric + 1), 2);
}

function escapeRegex(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function chunk(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function truncateText(value, maxLength = 180) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function daysAgo(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}
