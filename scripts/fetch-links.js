import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DAILY_DIR = path.join(ROOT, "data", "daily");
const ARTICLES_DIR = path.join(ROOT, "data", "articles");

const args = parseArgs(process.argv.slice(2));
const dailyPath = path.join(DAILY_DIR, `${args.date ?? latestDate()}.json`);

await mkdir(ARTICLES_DIR, { recursive: true });

const daily = JSON.parse(await readFile(dailyPath, "utf8"));
const links = collectLinks(daily);
const results = [];

for (const link of links) {
  const articlePath = path.join(ARTICLES_DIR, `${slugify(link.url)}.json`);
  const existing = await readOptionalJson(articlePath);

  if (existing?.status === 200) {
    results.push({ url: link.url, status: "cached" });
    continue;
  }

  const article = await fetchArticle(link.url);
  await writeFile(articlePath, `${JSON.stringify(article, null, 2)}\n`, "utf8");
  results.push({ url: link.url, status: article.status, title: article.title });
}

console.log(`Processed ${results.length} article links.`);
for (const result of results) {
  console.log(`${result.status}: ${result.title ?? result.url}`);
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--date") parsed.date = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm run fetch-links -- [--date YYYY-MM-DD]");
      process.exit(0);
    }
  }

  return parsed;
}

function latestDate() {
  throw new Error("Pass --date YYYY-MM-DD.");
}

function collectLinks(daily) {
  const map = new Map();

  for (const source of daily.sources ?? []) {
    for (const link of source.links ?? []) map.set(link.url, link);
    for (const item of source.items ?? []) {
      for (const link of item.links ?? []) map.set(link.url, link);
    }
  }

  return [...map.values()];
}

async function fetchArticle(url) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    const html = await response.text();

    return {
      url,
      fetchedAt: new Date().toISOString(),
      status: response.status,
      ok: response.ok,
      title: extractTitle(html),
      description: extractDescription(html),
      text: response.ok ? extractReadableText(html).slice(0, 8000) : "",
    };
  } catch (error) {
    return {
      url,
      fetchedAt: new Date().toISOString(),
      status: "error",
      ok: false,
      error: error.message,
    };
  }
}

function extractTitle(html) {
  return html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1] ??
    html.match(/<title[^>]*>([^<]+)/i)?.[1] ??
    "";
}

function extractDescription(html) {
  return html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i)?.[1] ??
    html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i)?.[1] ??
    "";
}

function extractReadableText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function slugify(value) {
  return value
    .replace(/^https?:\/\//, "")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 180);
}

