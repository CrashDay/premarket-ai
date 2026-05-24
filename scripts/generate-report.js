import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import "dotenv/config";

const ROOT = path.resolve(import.meta.dirname, "..");
const PROMPT_PATH = path.join(ROOT, "prompts", "daily-market-brief.md");
const REPORTS_DIR = path.join(ROOT, "reports");
const INBOX_DIR = path.join(ROOT, "inbox");
const DATA_DIR = path.join(ROOT, "data", "daily");
const WATCHLISTS_DIR = path.join(ROOT, "data", "watchlists");
const DAILY_WATCHLISTS_DIR = path.join(WATCHLISTS_DIR, "daily");
const SWING_WATCHLISTS_DIR = path.join(WATCHLISTS_DIR, "swing");

const COMPANY_ALIASES = [
  ["AAPL", ["Apple", "iPhone"]],
  ["NFLX", ["Netflix"]],
  ["JPM", ["JPMorgan", "JP Morgan", "JPMorgan Chase"]],
  ["GS", ["Goldman Sachs"]],
  ["WFC", ["Wells Fargo"]],
  ["DHR", ["Danaher"]],
  ["PG", ["Procter & Gamble", "P&G"]],
  ["EL", ["Estee Lauder", "Estée Lauder"]],
  ["AFRM", ["Affirm"]],
  ["PLD", ["Prologis"]],
  ["ABT", ["Abbott Laboratories", "Abbott Labs", "Abbott"]],
  ["CALM", ["Cal-Maine", "Cal Maine"]],
  ["MOG.A", ["Moog"]],
  ["JBLU", ["JetBlue Airways", "JetBlue"]],
  ["UPST", ["Upstart"]],
  ["XYZ", ["Block"]],
  ["SHOP", ["Shopify"]],
  ["NVDA", ["Nvidia"]],
  ["TFC", ["Truist"]],
  ["RF", ["Regions Financial", "Regions"]],
  ["BAC", ["Bank of America"]],
  ["MS", ["Morgan Stanley"]],
];

const SOURCE_PROFILES = [
  {
    name: "CNBC Jim's Top 10",
    patterns: [/jim'?s top 10/i, /top 10 things to watch/i, /jim cramer/i],
    weight: 16,
    role: "pre-market buy ideas",
  },
  {
    name: "CNBC Morning Squawk",
    patterns: [/morning squawk/i],
    weight: 14,
    role: "pre-market market setup",
  },
  {
    name: "CNBC The Exchange",
    patterns: [/\bthe exchange\b/i],
    weight: 10,
    role: "intraday catalyst context",
  },
  {
    name: "CNBC Breaking News",
    patterns: [/breaking news/i],
    weight: 8,
    role: "urgent catalyst alert",
  },
  {
    name: "CNBC Disruptors",
    patterns: [/disruptors/i],
    weight: 6,
    role: "theme discovery",
  },
  {
    name: "Motley Fool Stock Advisor",
    patterns: [/stock advisor/i, /new stock recommendation/i],
    weight: 18,
    role: "source-backed recommendation",
  },
  {
    name: "Motley Fool Breakfast News",
    patterns: [/breakfast news/i],
    weight: 14,
    role: "pre-market market setup",
  },
  {
    name: "Motley Fool My Stocks",
    patterns: [/my stocks/i],
    weight: 10,
    role: "watchlist coverage",
  },
  {
    name: "MarketDly Daily Technical Patterns",
    patterns: [/marketdly/i, /daily technical patterns/i, /morning market update/i, /bullish breakout/i, /macd bullish divergence/i, /cup & handle/i],
    weight: 11,
    role: "technical pattern scanner",
  },
  {
    name: "Stock Analysis Market Bullets",
    patterns: [/stockanalysis\.com/i, /market bullets/i, /top market moving news/i, /today's ipos/i],
    weight: 10,
    role: "pre-market market summary",
  },
  {
    name: "Market Email",
    patterns: [],
    weight: 6,
    role: "general market context",
  },
];

const args = parseArgs(process.argv.slice(2));
const runDate = args.date ?? todayLocal();
const inputDir = path.resolve(args.input ?? path.join(INBOX_DIR, runDate));
const outputPath = path.resolve(args.output ?? path.join(REPORTS_DIR, `${runDate}.md`));
const bundlePath = path.join(REPORTS_DIR, `${runDate}.source-bundle.md`);
const promptPath = path.join(REPORTS_DIR, `${runDate}.prompt.md`);
const dataPath = path.join(DATA_DIR, `${runDate}.json`);

const model = process.env.OPENAI_MODEL || "gpt-5.4-mini";
const apiKey = process.env.OPENAI_API_KEY;
const generateFinalBriefing = process.env.GENERATE_FINAL_BRIEFING === "true";

await mkdir(REPORTS_DIR, { recursive: true });
await mkdir(DATA_DIR, { recursive: true });
await mkdir(inputDir, { recursive: true });
await mkdir(DAILY_WATCHLISTS_DIR, { recursive: true });
await mkdir(SWING_WATCHLISTS_DIR, { recursive: true });

const files = await loadInputFiles(inputDir);

if (files.length === 0) {
  console.log(`No source files found in ${inputDir}`);
  console.log("Add .txt, .md, .eml, or .html email exports, then run again.");
  process.exit(0);
}

const basePrompt = await readFile(PROMPT_PATH, "utf8");
const bundle = buildSourceBundle(files);
const fullPrompt = `${basePrompt.trim()}\n\n## Email Sources\n\n${bundle}`;
const dailyData = buildDailyData(runDate, files);
const dailyTradeCandidates = buildDailyTradeCandidates(dailyData);
const previousSwingWatchlist = await readOptionalJson(path.join(SWING_WATCHLISTS_DIR, "current.json"));
const swingWatchlist = buildSwingWatchlist({ date: runDate, dailyData, dailyTradeCandidates, previousSwingWatchlist });
const dailyWatchlistPath = path.join(DAILY_WATCHLISTS_DIR, `${runDate}.json`);
const swingWatchlistPath = path.join(SWING_WATCHLISTS_DIR, "current.json");

await writeFile(bundlePath, bundle, "utf8");
await writeFile(promptPath, fullPrompt, "utf8");
await writeFile(dataPath, `${JSON.stringify(dailyData, null, 2)}\n`, "utf8");
await writeFile(dailyWatchlistPath, `${JSON.stringify(dailyTradeCandidates, null, 2)}\n`, "utf8");
await writeFile(swingWatchlistPath, `${JSON.stringify(swingWatchlist, null, 2)}\n`, "utf8");

if (!apiKey || !generateFinalBriefing) {
  console.log(`Wrote source bundle: ${bundlePath}`);
  console.log(`Wrote prompt file: ${promptPath}`);
  console.log(`Wrote dashboard data: ${dataPath}`);
  console.log(`Wrote daily trade candidates: ${dailyWatchlistPath}`);
  console.log(`Wrote swing watchlist: ${swingWatchlistPath}`);
  if (!apiKey) {
    console.log("Set OPENAI_API_KEY and GENERATE_FINAL_BRIEFING=true to generate the Final Briefing.");
  } else {
    console.log("Skipped Final Briefing. Set GENERATE_FINAL_BRIEFING=true to call OpenAI.");
  }
  process.exit(0);
}

const report = await generateWithOpenAI({ apiKey, model, prompt: fullPrompt });
await writeFile(outputPath, report, "utf8");

console.log(`Wrote briefing: ${outputPath}`);
console.log(`Wrote source bundle: ${bundlePath}`);
console.log(`Wrote dashboard data: ${dataPath}`);
console.log(`Wrote daily trade candidates: ${dailyWatchlistPath}`);
console.log(`Wrote swing watchlist: ${swingWatchlistPath}`);

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--date") parsed.date = argv[++index];
    else if (arg === "--input") parsed.input = argv[++index];
    else if (arg === "--output") parsed.output = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm run brief -- [--date YYYY-MM-DD] [--input DIR] [--output FILE]");
      process.exit(0);
    }
  }

  return parsed;
}

function todayLocal() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function loadInputFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const supported = new Set([".txt", ".md", ".eml", ".html", ".htm"]);
  const files = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const filePath = path.join(dir, entry.name);
    const ext = path.extname(entry.name).toLowerCase();
    if (!supported.has(ext)) continue;

    const raw = await readFile(filePath, "utf8");
    const parsed = parseSourceFile(entry.name, ext, raw);
    files.push(parsed);
  }

  return files.sort((a, b) => a.name.localeCompare(b.name));
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function parseSourceFile(name, ext, raw) {
  if (ext === ".eml") return parseEml(name, raw);
  if (ext === ".html" || ext === ".htm") {
    return {
      name,
      subject: name,
      from: "unknown",
      rawText: raw,
      linkText: raw,
      text: cleanEmailText(stripHtml(raw)),
    };
  }

  return {
    name,
    rawText: raw,
    linkText: raw,
    ...parseLooseEmailText(name, raw),
  };
}

function parseEml(name, raw) {
  const headerEnd = raw.search(/\r?\n\r?\n/);
  const headerText = headerEnd >= 0 ? raw.slice(0, headerEnd) : "";
  const bodyText = headerEnd >= 0 ? raw.slice(headerEnd).trim() : raw;
  const headers = parseHeaders(headerText);
  const contentType = headers["content-type"] || "";
  const decodedBody = decodeEmailBody(bodyText, contentType);
  const htmlBody = extractHtmlBody(bodyText, contentType);

  return {
    name,
    subject: headers.subject || name,
    from: headers.from || "unknown",
    date: headers.date,
    rawText: decodedBody,
    linkText: htmlBody || decodedBody,
    text: cleanEmailText(decodedBody),
  };
}

function parseHeaders(headerText) {
  const headers = {};
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, " ");

  for (const line of unfolded.split(/\r?\n/)) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    headers[match[1].toLowerCase()] = decodeMimeWords(match[2].trim());
  }

  return headers;
}

function decodeEmailBody(bodyText, contentType) {
  const boundary = contentType.match(/boundary="?([^";]+)"?/i)?.[1];

  if (!boundary) {
    return decodeTransferBody(bodyText, contentType);
  }

  const parts = bodyText
    .split(`--${boundary}`)
    .map((part) => part.trim())
    .filter((part) => part && part !== "--");

  const parsedParts = parts.map(parseMimePart).filter(Boolean);
  const plainPart = parsedParts.find((part) => /text\/plain/i.test(part.contentType));
  const htmlPart = parsedParts.find((part) => /text\/html/i.test(part.contentType));
  const selected = plainPart || htmlPart || parsedParts[0];

  if (!selected) return decodeQuotedPrintable(bodyText);
  return selected.isHtml ? stripHtml(selected.body) : selected.body;
}

function extractHtmlBody(bodyText, contentType) {
  const boundary = contentType.match(/boundary="?([^";]+)"?/i)?.[1];
  if (!boundary) return /text\/html/i.test(contentType) ? bodyText : "";

  const parts = bodyText
    .split(`--${boundary}`)
    .map((part) => part.trim())
    .filter((part) => part && part !== "--");

  const parsedParts = parts.map(parseMimePart).filter(Boolean);
  const htmlPart = parsedParts.find((part) => /text\/html/i.test(part.contentType));
  return htmlPart?.body ?? "";
}

function parseMimePart(partText) {
  const headerEnd = partText.search(/\r?\n\r?\n/);
  if (headerEnd < 0) return null;

  const headerText = partText.slice(0, headerEnd);
  const bodyText = partText.slice(headerEnd).trim();
  const headers = parseHeaders(headerText);
  const contentType = headers["content-type"] || "";
  const transferEncoding = headers["content-transfer-encoding"] || "";

  return {
    contentType,
    isHtml: /text\/html/i.test(contentType),
    body: decodeTransferBody(bodyText, transferEncoding),
  };
}

function decodeTransferBody(bodyText, transferEncoding) {
  if (/quoted-printable/i.test(transferEncoding)) {
    return decodeQuotedPrintable(bodyText);
  }

  if (/base64/i.test(transferEncoding)) {
    try {
      return Buffer.from(bodyText.replace(/\s+/g, ""), "base64").toString("utf8");
    } catch {
      return bodyText;
    }
  }

  return bodyText;
}

function decodeQuotedPrintable(value) {
  const withoutSoftBreaks = value.replace(/=\r?\n/g, "");
  const bytes = [];

  for (let index = 0; index < withoutSoftBreaks.length; index += 1) {
    const char = withoutSoftBreaks[index];
    const hex = withoutSoftBreaks.slice(index + 1, index + 3);

    if (char === "=" && /^[A-Fa-f0-9]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }

    bytes.push(...Buffer.from(char, "utf8"));
  }

  return Buffer.from(bytes).toString("utf8");
}

function parseLooseEmailText(name, raw) {
  const lines = raw.split(/\r?\n/);
  const subjectLine = lines.find((line) => /^subject:\s*/i.test(line));
  const fromLine = lines.find((line) => /^from:\s*/i.test(line));

  return {
    subject: subjectLine ? subjectLine.replace(/^subject:\s*/i, "").trim() : name,
    from: fromLine ? fromLine.replace(/^from:\s*/i, "").trim() : "unknown",
    text: cleanEmailText(raw),
  };
}

function decodeMimeWords(value) {
  return value.replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_, encoded) => {
    try {
      return Buffer.from(encoded, "base64").toString("utf8");
    } catch {
      return encoded;
    }
  });
}

function stripHtml(value) {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

function cleanEmailText(value) {
  return value
    .replace(/\(\s*https?:\/\/[\s\S]*?\)/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^\(\s*https?:\/\/[^)]+\s*\)$/.test(line))
    .filter((line) => !/^https?:\/\/\S+$/.test(line))
    .filter((line) => !/^(unsubscribe|manage preferences|view in browser)$/i.test(line))
    .filter((line) => !/^you received this email/i.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildSourceBundle(files) {
  return files
    .map((file, index) => {
      const parts = [
        `### Source ${index + 1}: ${file.subject}`,
        `- File: ${file.name}`,
        `- From: ${file.from}`,
      ];

      if (file.date) parts.push(`- Date: ${file.date}`);

      parts.push("", truncate(file.text, 12000));
      return parts.join("\n");
    })
    .join("\n\n---\n\n");
}

function buildDailyData(date, files) {
  const sources = files.map((file) => analyzeSource(file));
  const tickerMap = new Map();
  const themeMap = new Map();
  const events = [];

  for (const source of sources) {
    for (const ticker of source.tickers) {
      if (!tickerMap.has(ticker.symbol)) {
        tickerMap.set(ticker.symbol, {
          symbol: ticker.symbol,
          mentions: 0,
          sources: [],
          sourceProfiles: [],
          sourceWeight: 0,
          primaryWeight: 0,
          notes: [],
          latestMove: ticker.move ?? null,
        });
      }

      const item = tickerMap.get(ticker.symbol);
      item.mentions += ticker.mentions;
      item.sources.push(source.title);
      item.sourceProfiles.push(source.profile);
      item.sourceWeight += source.weight;
      if (source.weight >= item.primaryWeight) {
        item.notes = [...ticker.notes, ...item.notes];
        item.primaryWeight = source.weight;
      } else {
        item.notes.push(...ticker.notes);
      }
      if (ticker.move) item.latestMove = ticker.move;
    }

    for (const theme of source.themes) {
      const current = themeMap.get(theme) ?? { name: theme, mentions: 0, sources: [] };
      current.mentions += 1;
      current.sources.push(source.title);
      themeMap.set(theme, current);
    }

    events.push(...source.events.map((event) => ({ ...event, source: source.title })));
  }

  const tickers = [...tickerMap.values()]
    .map((ticker) => ({
        ...ticker,
        sources: unique(ticker.sources),
        sourceProfiles: unique(ticker.sourceProfiles),
        notes: unique(ticker.notes).slice(0, 5),
      }))
    .sort((a, b) => b.mentions - a.mentions || a.symbol.localeCompare(b.symbol));

  const themes = [...themeMap.values()]
    .map((theme) => ({ ...theme, sources: unique(theme.sources) }))
    .sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name));
  const macro = buildMacroBackdrop(sources);
  const readingList = buildReadingList(sources);

  return {
    date,
    generatedAt: new Date().toISOString(),
    sourceCount: sources.length,
    sources,
    readingList,
    macro,
    candidates: scoreCandidates(tickers, themes),
    tickers,
    themes,
    events,
  };
}

function buildDailyTradeCandidates(dailyData) {
  const candidates = (dailyData.candidates ?? [])
    .filter((candidate) => candidate.stance !== "Low Priority")
    .map((candidate) => {
      const status = candidate.stance === "Buy Candidate" ? "watch_intraday" : "new";
      const promotionEligible = candidate.stance === "Buy Candidate" || candidate.stance === "Research Watch" || candidate.stance === "Setup Watch";

      return {
        symbol: candidate.symbol,
        createdAt: dailyData.generatedAt,
        updatedAt: dailyData.generatedAt,
        status,
        stance: candidate.stance,
        score: candidate.score,
        catalyst: candidate.evidence,
        setupType: inferSetupType(candidate),
        entryTrigger: candidate.nextCheck,
        triggerPrice: null,
        invalidation: buildDailyInvalidation(candidate),
        invalidationPrice: null,
        firstTarget: buildDailyTarget(candidate),
        firstTargetPrice: null,
        rewardRiskMinimum: 2,
        sizeGuidance: candidate.stance === "Buy Candidate" ? "Starter size until price confirms." : "Watch only until trigger becomes precise.",
        sessionWindow: "regular-hours",
        sourceProfiles: candidate.sourceProfiles ?? [],
        sourceFiles: candidate.sources ?? [],
        promotionEligible,
        promotionReason: promotionEligible ? "Promote only if the catalyst survives the first session and a multi-day trigger remains clean." : "",
        notes: [
          `Why it ranks: ${(candidate.positives ?? []).join(", ") || "Needs more confirmation"}`,
          `Risk flags: ${(candidate.risks ?? []).join(", ") || "None listed"}`,
        ],
        history: [
          {
            at: dailyData.generatedAt,
            status,
            note: "Created from the daily source-backed candidate scan.",
          },
        ],
      };
    });

  return {
    date: dailyData.date,
    generatedAt: dailyData.generatedAt,
    sourceReport: `reports/${dailyData.date}.md`,
    notes: "Current-session candidates. Expire by the close unless promoted into the swing watchlist.",
    candidates,
  };
}

function buildSwingWatchlist({ date, dailyData, dailyTradeCandidates, previousSwingWatchlist }) {
  const previousBySymbol = new Map((previousSwingWatchlist?.candidates ?? []).map((candidate) => [candidate.symbol, candidate]));
  const currentCandidates = [];

  for (const dailyCandidate of dailyTradeCandidates.candidates ?? []) {
    if (!dailyCandidate.promotionEligible) continue;

    const previous = previousBySymbol.get(dailyCandidate.symbol);
    if (previous && ["in_trade", "closed", "passed"].includes(previous.status)) {
      currentCandidates.push(previous);
      previousBySymbol.delete(dailyCandidate.symbol);
      continue;
    }

    const reviewEntry = {
      reviewedAt: dailyData.generatedAt,
      status: "active_watch",
      summary: "Reviewed from the current daily candidate feed; still needs confirmation before a swing entry.",
      relativeStrength: summarizeRelativeStrengthFromNotes(dailyCandidate.notes ?? []),
      volumeNote: "Recheck volume after the first session move.",
      eventRisk: "Review next earnings or company event before carrying overnight.",
    };

    currentCandidates.push(
      previous
        ? {
            ...previous,
            lastReviewedAt: dailyData.generatedAt,
            carryReason: "Still eligible after daily review; keep on the active swing watchlist until triggered, invalidated, or expired.",
            reviewHistory: [...(previous.reviewHistory ?? []), reviewEntry].slice(-20),
          }
        : {
            symbol: dailyCandidate.symbol,
            firstIdentifiedAt: dailyData.generatedAt,
            lastReviewedAt: dailyData.generatedAt,
            status: "active_watch",
            thesis: dailyCandidate.catalyst,
            catalystOrigin: (dailyCandidate.sourceProfiles ?? []).join(", ") || "Daily source bundle",
            setupType: dailyCandidate.stance,
            entryTrigger: dailyCandidate.entryTrigger,
            triggerPrice: dailyCandidate.triggerPrice ?? null,
            invalidation: dailyCandidate.invalidation,
            invalidationPrice: dailyCandidate.invalidationPrice ?? null,
            firstTarget: dailyCandidate.firstTarget,
            firstTargetPrice: dailyCandidate.firstTargetPrice ?? null,
            holdWindowDays: 5,
            expiryRule: "Expire after 5 trading days or sooner if the catalyst loses relevance.",
            carryReason: "Promoted from the daily trade candidates list because the setup could develop over multiple sessions.",
            promotionSource: "daily_candidate",
            sourceDate: date,
            sourceFiles: dailyCandidate.sourceFiles ?? [],
            eventRisk: "Review upcoming catalysts before entry.",
            relativeStrength: summarizeRelativeStrengthFromNotes(dailyCandidate.notes ?? []),
            volumeCondition: "Needs confirming volume before promotion to actionable.",
            sizeGuidance: "Starter size only after confirmation.",
            reviewHistory: [reviewEntry],
          },
    );

    previousBySymbol.delete(dailyCandidate.symbol);
  }

  for (const leftover of previousBySymbol.values()) {
    if (["in_trade", "actionable", "active_watch"].includes(leftover.status)) {
      currentCandidates.push(leftover);
    }
  }

  return {
    generatedAt: dailyData.generatedAt,
    reviewDate: date,
    notes: "Persistent multi-day swing setups. These names survive across sessions until triggered, invalidated, expired, or closed.",
    candidates: currentCandidates.sort((a, b) => a.symbol.localeCompare(b.symbol)),
  };
}

function buildMacroBackdrop(sources) {
  const macroThemes = [
    {
      name: "Geopolitical Risk",
      patterns: [/iran|war|ceasefire|strait of hormuz|gulf of oman|attack ships|conflict/i],
      risk: 2,
    },
    {
      name: "Oil Shock",
      patterns: [/oil prices?|crude|tanker|hormuz/i],
      risk: 2,
    },
    {
      name: "Fed And Rates",
      patterns: [/fed|federal reserve|warsh|rate cuts?|monetary policy|senate banking/i],
      risk: 1,
    },
    {
      name: "Tariffs And Trade",
      patterns: [/tariff|trade|refund/i],
      risk: 1,
    },
    {
      name: "Market Strength",
      patterns: [/dow rises|higher open|stock market comeback|record high|losses kept in check|deal with iran/i],
      risk: -2,
    },
    {
      name: "Market Weakness",
      patterns: [/dow futures drop|stocks fall|stocks close lower|nasdaq snaps|uncertainty|deadline looms/i],
      risk: 2,
    },
    {
      name: "AI Infrastructure",
      patterns: [/anthropic|ai infrastructure|artificial intelligence|nvidia|data center/i],
      risk: -1,
    },
  ];
  const items = [];
  let score = 0;

  for (const source of sources) {
    const sourceMacroItems = source.items?.length
      ? source.items
      : [
          {
            title: source.title,
            text: source.summaryHints?.[0] ?? source.title,
            links: source.links ?? [],
          },
        ];

    for (const macroItem of sourceMacroItems) {
      const haystack = `${source.title} ${macroItem.title ?? ""} ${macroItem.text ?? ""}`;

      for (const theme of macroThemes) {
        if (!theme.patterns.some((pattern) => pattern.test(haystack))) continue;

        score += theme.risk;
        items.push({
          theme: theme.name,
          source: source.title,
          note: cleanMacroNote(macroItem.text ?? macroItem.title ?? source.title),
          risk: theme.risk,
          links: uniqueLinks(macroItem.links?.length ? macroItem.links : source.links ?? []),
        });
      }
    }
  }

  const uniqueItems = uniqueMacroItems(items);

  return {
    tone: classifyMacroTone(score),
    score,
    items: uniqueItems,
    beforeBuying: buildMacroChecklist(uniqueItems, score),
  };
}

function buildReadingList(sources) {
  const storyMap = new Map();

  for (const source of sources) {
    for (const item of source.items ?? []) {
      const curatedLinks = curateReadingLinks(item.links ?? []);
      if (curatedLinks.length === 0) continue;

      const title = deriveReadingTitle(item, curatedLinks);
      if (!title) continue;

      const key = normalizeReadingKey(curatedLinks[0]?.label || title);
      const note = summarizeReadingItem(item.text ?? item.title ?? source.title);
      const score = source.weight + curatedLinks.length * 2 + Math.min((item.tickers ?? []).length, 3);
      const current = storyMap.get(key) ?? {
        title,
        note,
        links: [],
        sources: [],
        sourceProfiles: [],
        tickers: [],
        score: 0,
      };

      if (score > current.score) {
        current.title = title;
        current.note = note;
        current.score = score;
      }

      current.links = mergeReadingLinks(current.links, curatedLinks);
      current.sources.push(source.title);
      current.sourceProfiles.push(source.profile);
      current.tickers.push(...(item.tickers ?? []));
      storyMap.set(key, current);
    }
  }

  return [...storyMap.values()]
    .map((item) => ({
      ...item,
      sources: unique(item.sources),
      sourceProfiles: unique(item.sourceProfiles),
      tickers: unique(item.tickers).slice(0, 4),
      links: item.links.slice(0, 2),
    }))
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, 8);
}

function curateReadingLinks(links) {
  const curated = [];
  const seen = new Set();

  for (const link of links ?? []) {
    const label = String(link?.title ?? "").replace(/\s+/g, " ").trim();
    const url = String(link?.url ?? "").trim();
    if (!url || !label) continue;
    if (!isDescriptiveLinkLabel(label)) continue;
    if (isPromotionalLinkLabel(label)) continue;

    const key = `${normalizeReadingKey(label)}|${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    curated.push({ url, title: label, label });
  }

  return curated;
}

function mergeReadingLinks(existing, incoming) {
  const merged = [];
  const seen = new Set();

  for (const link of [...existing, ...incoming]) {
    const key = link.url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(link);
  }

  return merged;
}

function deriveReadingTitle(item, links) {
  const primary = links[0]?.label || "";
  if (primary) return primary;

  const fallback = String(item.title ?? item.text ?? "")
    .replace(/^item\s+\d+$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  return fallback ? truncateText(fallback, 90) : "";
}

function normalizeReadingKey(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[“”'"`]/g, "")
    .replace(/\b(q[1-4]|first-quarter|second-quarter|third-quarter|fourth-quarter)\b/g, "")
    .replace(/\b(details|full|report|in full|learn more|dig into|watch the team assess|understand|comments?)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function summarizeReadingItem(text) {
  const cleaned = String(text ?? "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return truncateText(cleaned, 180);
}

function truncateText(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function isPromotionalLinkLabel(label) {
  return /\b(epic membership|get the report|read online|subscription|sign up|subscribe|join now|free report)\b/i.test(label);
}

function cleanMacroNote(value) {
  return value
    .replace(/-+>\s*-+>\s*/g, "")
    .replace(/^96\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueMacroItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.theme}:${item.source}:${item.note}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueLinks(links) {
  const seen = new Set();
  return (links ?? []).filter((link) => {
    if (!link?.url || seen.has(link.url)) return false;
    seen.add(link.url);
    return true;
  });
}

function classifyMacroTone(score) {
  if (score >= 5) return "Risk-Off";
  if (score <= -3) return "Risk-On";
  return "Mixed";
}

function buildMacroChecklist(items, score) {
  const themes = new Set(items.map((item) => item.theme));
  const checks = [];

  if (themes.has("Geopolitical Risk") || themes.has("Oil Shock")) checks.push("Watch oil, defense, transports, and broad-index reaction before adding risk.");
  if (themes.has("Fed And Rates")) checks.push("Check rate-sensitive groups and bond yields before chasing breakouts.");
  if (themes.has("Tariffs And Trade")) checks.push("Treat import/export and margin-sensitive names with extra caution.");
  if (themes.has("Market Weakness")) checks.push("Require stronger chart confirmation; avoid buying weak opens blindly.");
  if (themes.has("Market Strength")) checks.push("If breadth confirms, prioritize candidates with fresh catalysts and relative strength.");
  if (score > 4) checks.push("Consider smaller initial size until macro pressure cools.");

  return checks.length ? checks : ["Macro tape is not giving a strong warning; focus on ticker-specific catalyst quality and chart confirmation."];
}

function scoreCandidates(tickers, themes) {
  const themeNames = themes.map((theme) => theme.name);

  return tickers
    .map((ticker) => {
      const primaryEvidence = ticker.notes?.[0] ?? "";
      const evidenceText = [ticker.symbol, primaryEvidence, ...(ticker.sources ?? []), ...(ticker.sourceProfiles ?? [])].join(" ");
      const evidenceLower = evidenceText.toLowerCase();
      const catalystScore = scoreMatches(evidenceLower, [
        "new recommendation",
        "recommendation",
        "recommended",
        "buy",
        "winner",
        "growth",
        "surge",
        "backlog",
        "profitable",
        "leader",
        "opportunity",
        "higher",
        "top pick",
        "best ideas",
        "own, don't trade",
        "kept a buy",
        "top mover",
      ]);
      const riskScore = scoreMatches(evidenceLower, [
        " lawsuit",
        "lawsuit",
        " doj ",
        "antitrust",
        "investigation",
        "alleging",
        "price-fixing",
        "sell-off",
        " down ",
        "downgraded",
        "price target cut",
        "price target cuts",
        "lowered",
        "trimmed",
        "lackluster",
        "broken stock",
      ]);
      const themeScore = scoreThemeAlignment(themeNames, evidenceLower);
      const moveScore = scoreMove(ticker.latestMove);
      const topMoverOnly = /top movers?/.test(evidenceLower) && !/recommendation|recommended|earnings|guidance|contract|backlog|lawsuit|investigation|leader/.test(evidenceLower);
      const sourceScore = Math.min((ticker.sources ?? []).length * 6 + (ticker.sourceWeight ?? 0), 34);
      const mentionScore = Math.min(ticker.mentions * 6, 18);
      const contextPenalty = scoreContextPenalty(ticker.symbol, primaryEvidence);
      const score = clamp(25 + catalystScore + themeScore + moveScore + sourceScore + mentionScore - riskScore - contextPenalty - (topMoverOnly ? 18 : 0), 0, 100);

      return {
        symbol: ticker.symbol,
        score,
        stance: classifyCandidate(score, riskScore, catalystScore, moveScore, topMoverOnly),
        evidence: primaryEvidence || "Mentioned in source material without a nearby explanatory note.",
        sources: ticker.sources ?? [],
        sourceProfiles: ticker.sourceProfiles ?? [],
        positives: buildPositiveReasons({ catalystScore, themeScore, moveScore, sourceScore }),
        risks: buildRiskReasons(evidenceLower, riskScore, contextPenalty),
        nextCheck: buildNextCheck(evidenceLower),
      };
    })
    .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
}

function scoreMatches(text, keywords) {
  return keywords.reduce((score, keyword) => (text.includes(keyword) ? score + 8 : score), 0);
}

function scoreThemeAlignment(_themeNames, evidenceLower) {
  let score = 0;
  if (/space|satellite|launch/.test(evidenceLower)) score += 8;
  if (/defense|geopolitical|military/.test(evidenceLower)) score += 8;
  if (/automation|industrial|machinery/.test(evidenceLower)) score += 8;
  if (/semiconductor|nvidia|chip/.test(evidenceLower)) score += 8;
  if (/\bai\b|artificial intelligence|infrastructure/.test(evidenceLower)) score += 8;
  return Math.min(score, 30);
}

function scoreMove(move) {
  if (!move) return 0;
  const value = Number.parseFloat(move.replace("%", ""));
  if (Number.isNaN(value)) return 0;
  if (value > 5) return 18;
  if (value > 2) return 12;
  if (value > 0) return 6;
  if (value < -5) return -18;
  return -8;
}

function classifyCandidate(score, riskScore, catalystScore, moveScore, topMoverOnly) {
  if (riskScore >= 24 && score < 60) return "Risk Watch";
  if (topMoverOnly && score >= 55) return "Setup Watch";
  if (score >= 70) return "Buy Candidate";
  if (score >= 58 && catalystScore + moveScore > 10) return "Setup Watch";
  if (score >= 45) return "Research Watch";
  return "Low Priority";
}

function buildPositiveReasons({ catalystScore, themeScore, moveScore, sourceScore }) {
  const reasons = [];
  if (catalystScore > 0) reasons.push("fresh catalyst language");
  if (themeScore > 0) reasons.push("aligned with active themes");
  if (moveScore > 0) reasons.push("positive recent move");
  if (sourceScore > 8) reasons.push("higher-confidence source");
  return reasons.length ? reasons : ["needs more confirmation"];
}

function buildRiskReasons(evidenceLower, riskScore, contextPenalty = 0) {
  const risks = [];
  if (/\bsuit\b|lawsuit|\bdoj\b|antitrust|investigation|alleging|price-fixing/.test(evidenceLower)) risks.push("regulatory or legal overhang");
  if (/sell-off|\bdown\b|downgraded/.test(evidenceLower)) risks.push("negative price or sentiment context");
  if (/price target cut|price target cuts|lowered|trimmed|lackluster|broken stock/.test(evidenceLower)) risks.push("analyst or execution pressure");
  if (contextPenalty > 0) risks.push("mentioned as the actor around another stock's catalyst, not the primary setup");
  if (riskScore === 0) risks.push("no major risk flag found in current sources");
  return risks;
}

function buildNextCheck(evidenceLower) {
  if (/new recommendation|buy/.test(evidenceLower)) return "Check chart structure, liquidity, valuation context, and whether the catalyst is already extended.";
  if (/\bsuit\b|lawsuit|\bdoj\b|antitrust|investigation|alleging|price-fixing/.test(evidenceLower)) return "Wait for market reaction and avoid treating headline volatility as a clean long setup.";
  if (/earnings|report/.test(evidenceLower)) return "Check post-earnings trend, volume, guidance, and whether support holds.";
  return "Confirm price trend, volume, upcoming events, and source quality before considering an entry.";
}

function inferSetupType(candidate) {
  const evidence = String(candidate.evidence ?? "").toLowerCase();
  if (/earnings|guidance|forecast/.test(evidence)) return "Catalyst Continuation";
  if (/breakout|surged|jumped|rose/.test(evidence)) return "Breakout / Momentum";
  return "Research Watch";
}

function buildDailyInvalidation(candidate) {
  const evidence = String(candidate.evidence ?? "").toLowerCase();
  if (/earnings|guidance|forecast/.test(evidence)) return "Lose post-earnings support or fully fade the move.";
  if (/breakout|surged|jumped|rose/.test(evidence)) return "Lose the breakout-day support or fail immediately after reclaim.";
  return "Break the nearest support that would invalidate the thesis.";
}

function buildDailyTarget(candidate) {
  const evidence = String(candidate.evidence ?? "").toLowerCase();
  if (/earnings|guidance|forecast/.test(evidence)) return "Use measured move or next clear resistance and take partial profits into strength.";
  if (/breakout|surged|jumped|rose/.test(evidence)) return "Use the next resistance band or measured move from the breakout range.";
  return "Define the first target before entry; require at least 2:1 reward-to-risk.";
}

function summarizeRelativeStrengthFromNotes(notes) {
  const joined = String((notes ?? []).join(" ")).toLowerCase();
  if (joined.includes("lagging")) return "Lagging";
  if (joined.includes("leader")) return "Leader";
  return "Needs review";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function analyzeSource(file) {
  const text = file.text;
  const links = extractArticleLinks(file.linkText ?? file.rawText ?? text);
  const profile = classifySource(file, text);
  const sentences = splitSentences(text);
  const sourceItems = segmentSourceItems(text);
  const tickerSymbols = extractTickers(text);
  const tickers = tickerSymbols.map((symbol) => {
    const aliases = COMPANY_ALIASES.find(([candidate]) => candidate === symbol)?.[1] ?? [];
    const relatedItems = sourceItems
      .filter((item) => textMentionsTicker(item.text, symbol, aliases))
      .map((item) => localizeItemEvidence(item.text, symbol, aliases))
      .slice(0, 3);
    const relatedSentences = sentences
      .filter(
        (sentence) =>
          textMentionsTicker(sentence, symbol, aliases),
      )
      .slice(0, 3);
    const related = relatedItems.length > 0 ? relatedItems : relatedSentences;

    return {
      symbol,
      mentions: countTickerMentions(text, symbol),
      move: findMoveNearTicker(text, symbol),
      notes: related.length > 0 ? related : findFallbackTickerNotes(sentences, symbol),
    };
  });

  return {
    title: file.subject,
    file: file.name,
    from: file.from,
    date: file.date,
    profile: profile.name,
    role: profile.role,
    weight: profile.weight,
    links,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    summaryHints: sentences.slice(0, 5),
    items: sourceItems.map((item) => ({
      title: item.title,
      text: item.text,
      links: links.filter((link) => item.text.includes(link.url) || item.text.includes(link.title)),
      tickers: extractTickers(item.text),
      themes: extractThemes(item.text),
    })),
    tickers,
    themes: extractThemes(text),
    events: extractEvents(text, file.date),
  };
}

function extractArticleLinks(text) {
  const links = new Map();
  const anchorTitles = extractAnchorTitles(text);
  const urlPattern = /https?:\/\/(?:www\.)?(?:cnbc\.com|fool\.com)\/[^\s<>"')]+/gi;

  for (const match of text.matchAll(urlPattern)) {
    const url = cleanArticleUrl(match[0]);
    if (!isArticleUrl(url)) continue;
    const title = pickLinkTitle({
      text,
      url,
      matchText: match[0],
      anchorTitles,
      index: match.index ?? 0,
    });
    links.set(url, {
      url,
      title,
      fetched: false,
    });
  }

  for (const match of text.matchAll(/https?:\/\/link\.cnbc\.com\/click\/[^\s<>"']+/gi)) {
    const decoded = decodeCnbcTrackingUrl(match[0]);
    if (!decoded || !isArticleUrl(decoded)) continue;
    const title = pickLinkTitle({
      text,
      url: decoded,
      matchText: match[0],
      anchorTitles,
      index: match.index ?? 0,
    });
    links.set(decoded, {
      url: decoded,
      title,
      fetched: false,
    });
  }

  for (const match of text.matchAll(/https?:\/\/clicks\.fool\.com\/f\/a\/[^\s<>"')]+/gi)) {
    const url = cleanArticleUrl(match[0]);
    const title = pickLinkTitle({
      text,
      url,
      matchText: match[0],
      anchorTitles,
      index: match.index ?? 0,
    });
    links.set(url, {
      url,
      title,
      fetched: false,
    });
  }

  return [...links.values()].slice(0, 12);
}

function pickLinkTitle({ text, url, matchText, anchorTitles, index }) {
  const directTitle = anchorTitles.get(url) || anchorTitles.get(matchText) || titleFromUrl(url);
  if (isDescriptiveLinkLabel(directTitle)) return directTitle;

  const contextTitle = inferContextTitle(text, index, directTitle);
  if (contextTitle) return contextTitle;

  return directTitle;
}

function extractAnchorTitles(html) {
  const titles = new Map();
  if (!/[<]a\b/i.test(html)) return titles;

  for (const match of html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const rawUrl = cleanArticleUrl(decodeHtmlEntities(match[1]));
    const rawText = stripHtml(decodeHtmlEntities(match[2])).replace(/\s+/g, " ").trim();
    if (!rawText || looksLikeTrackingTitle(rawText) || !isUsefulAnchorTitle(rawText)) continue;
    const current = titles.get(rawUrl);
    if (!current || anchorTitleScore(rawText) > anchorTitleScore(current)) {
      titles.set(rawUrl, rawText);
    }
  }

  return titles;
}

function isUsefulAnchorTitle(title) {
  if (!title) return false;
  if (/^read online$/i.test(title)) return false;
  if (/^(nasdaq|nyse|amex):[A-Z.\-]+$/i.test(title)) return false;
  if (/^[A-Z.\-]{1,8}$/.test(title)) return false;
  return true;
}

function isDescriptiveLinkLabel(title) {
  if (!isUsefulAnchorTitle(title)) return false;

  const normalized = title.replace(/\s+/g, " ").trim();
  const words = normalized.split(/\s+/).filter(Boolean);

  if (words.length <= 2) return false;
  if (/^(seth jayson noted|read online|after results showed|after posting results)$/i.test(normalized)) return false;
  if (/^(payment volume in its first quarter|by a record \$?[0-9.]+ billion in q[1-4])$/i.test(normalized)) return false;
  if (/^(as results offered cautious guidance|watch the team assess [A-Z.\-]+(?:'s)? prospects)$/i.test(normalized)) return false;

  return true;
}

function anchorTitleScore(title) {
  let score = title.length;
  if (/[’'"]/u.test(title)) score += 10;
  if (/\b(dig into|learn more|understand|explore|get|details|report|earnings|quarter)\b/i.test(title)) score += 20;
  if (/^(nasdaq|nyse|amex):/i.test(title)) score -= 50;
  if (/^read online$/i.test(title)) score -= 50;
  return score;
}

function inferContextTitle(text, index, fallbackTitle = "") {
  const start = Math.max(0, index - 1400);
  const end = Math.min(text.length, index + 400);
  const window = text.slice(start, end);

  const strongTitle = extractNearestStrongTitle(window);
  if (isDescriptiveLinkLabel(strongTitle)) return strongTitle;

  if (strongTitle && /^[A-Z][A-Za-z&.' -]{2,30}$/.test(strongTitle) && isUsefulAnchorTitle(fallbackTitle)) {
    const combined = `${strongTitle} ${fallbackTitle}`.replace(/\s+/g, " ").trim();
    if (isDescriptiveLinkLabel(combined)) return combined;
  }

  const headingTitle = extractNearestHeadingTitle(window);
  if (isDescriptiveLinkLabel(headingTitle)) return headingTitle;

  return "";
}

function extractNearestStrongTitle(text) {
  const matches = [...text.matchAll(/<strong>([\s\S]*?)<\/strong>/gi)];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const candidate = stripHtml(decodeHtmlEntities(matches[index][1])).replace(/\s+/g, " ").trim();
    if (candidate && isUsefulAnchorTitle(candidate)) return candidate.replace(/:$/, "");
  }
  return "";
}

function extractNearestHeadingTitle(text) {
  const plain = decodeHtmlEntities(stripHtml(text))
    .replace(/=\r?\n/g, "")
    .replace(/\r/g, "\n");
  const lines = plain.split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines[index]
      .replace(/^[0-9]+\.\s*/, "")
      .replace(/^[*-]\s*/, "")
      .replace(/[:*#-]+$/g, "")
      .trim();
    if (!candidate) continue;
    if (candidate.length < 12 || candidate.length > 120) continue;
    if (/^https?:\/\//i.test(candidate)) continue;
    if (!/[A-Za-z]/.test(candidate)) continue;
    if (!isUsefulAnchorTitle(candidate)) continue;
    return candidate;
  }

  return "";
}

function decodeCnbcTrackingUrl(url) {
  const encoded = url.match(/\/click\/[^/]+\/([^/]+)/)?.[1];
  if (!encoded) return null;

  try {
    return cleanArticleUrl(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function cleanArticleUrl(url) {
  try {
    const parsed = new URL(url.replace(/=+$/, ""));
    parsed.searchParams.delete("__source");
    return parsed.toString();
  } catch {
    return url;
  }
}

function isArticleUrl(url) {
  return (
    /cnbc\.com\/\d{4}\/\d{2}\/\d{2}\//i.test(url) ||
    /fool\.com\/investing\//i.test(url)
  );
}

function titleFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (/clicks\.fool\.com$/i.test(parsed.hostname)) {
      return "Motley Fool link";
    }

    const slug = parsed.pathname.split("/").filter(Boolean).at(-1)?.replace(/\.html$/, "") ?? parsed.hostname;
    const title = slug
      .split("-")
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");

    return looksLikeTrackingTitle(title) ? hostLabel(parsed.hostname) : title;
  } catch {
    return url;
  }
}

function looksLikeTrackingTitle(title) {
  if (!title) return true;

  const compact = title.replace(/\s+/g, "");
  if (compact.length > 60 && !/[aeiou]{2,}/i.test(compact)) return true;
  if ((compact.match(/[_~]/g) ?? []).length >= 3) return true;
  return /^[A-Za-z0-9_~-]{40,}$/.test(compact);
}

function hostLabel(hostname) {
  if (/cnbc\.com$/i.test(hostname)) return "CNBC article";
  if (/fool\.com$/i.test(hostname)) return "Motley Fool link";
  return "Article";
}

function localizeItemEvidence(itemText, symbol, aliases) {
  const matchingSentences = splitSentences(itemText)
    .filter((sentence) => textMentionsTicker(sentence, symbol, aliases))
    .slice(0, 3);

  return matchingSentences.length > 0 ? matchingSentences.join(" ") : itemText;
}

function textMentionsTicker(text, symbol, aliases = []) {
  return (
    text.includes(symbol) ||
    text.includes(`NASDAQ: ${symbol}`) ||
    text.includes(`NYSE: ${symbol}`) ||
    aliases.some((alias) => hasCompanyAlias(text, alias))
  );
}

function segmentSourceItems(text) {
  const compact = removeNewsletterFooter(text).replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  const matches = [...compact.matchAll(/(?:^|\s)(\d{1,2})\.\s+/g)];

  if (matches.length < 3) return [];

  return matches
    .map((match, index) => {
      const start = match.index + match[0].length;
      const end = matches[index + 1]?.index ?? compact.length;
      const itemText = compact.slice(start, end).trim();
      return {
        title: `Item ${match[1]}`,
        text: itemText,
      };
    })
    .filter((item) => item.text.length > 30)
    .slice(0, 25);
}

function removeNewsletterFooter(text) {
  const footerPatterns = [
    /\bSign up for my Top 10 Morning Thoughts[\s\S]*$/i,
    /\bAs a subscriber to the CNBC Investing Club[\s\S]*$/i,
    /\bTHE ABOVE INVESTING CLUB INFORMATION[\s\S]*$/i,
    /\bDigital Products\s+Manage Newsletters[\s\S]*$/i,
  ];

  return footerPatterns.reduce((cleaned, pattern) => cleaned.replace(pattern, ""), text);
}

function classifySource(file, text) {
  const haystack = `${file.subject} ${file.from} ${text.slice(0, 1000)}`;

  return (
    SOURCE_PROFILES.find((profile) => profile.patterns.some((pattern) => pattern.test(haystack))) ??
    SOURCE_PROFILES.at(-1)
  );
}

function splitSentences(text) {
  return text
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+|(?=\* )/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 20)
    .slice(0, 120);
}

function extractTickers(text) {
  const symbols = new Set();
  const deny = new Set([
    "A",
    "AI",
    "AM",
    "AMEX",
    "CEO",
    "CFO",
    "DOJ",
    "EPS",
    "ETF",
    "ET",
    "FAQ",
    "GAAP",
    "GDP",
    "IPO",
    "MAU",
    "NASDAQ",
    "NEW",
    "NYSE",
    "OTC",
    "Q",
    "SEC",
    "SP",
    "YOY",
    "UTC",
    "USA",
  ]);

  for (const match of text.matchAll(/\b(?:NASDAQ|NYSE|OTC|AMEX):\s*([A-Z][A-Z.]{1,6})\b/g)) {
    symbols.add(match[1].replace(/\.$/, ""));
  }

  for (const match of text.matchAll(/\(([A-Z][A-Z.]{1,6})\b/g)) {
    const symbol = match[1].replace(/\.$/, "");
    if (!deny.has(symbol)) symbols.add(symbol);
  }

  for (const match of text.matchAll(/\n([A-Z][A-Z.]{1,6})\n/g)) {
    const symbol = match[1].replace(/\.$/, "");
    if (!deny.has(symbol)) symbols.add(symbol);
  }

  for (const [symbol, aliases] of COMPANY_ALIASES) {
    if (aliases.some((alias) => hasCompanyAlias(text, alias))) {
      symbols.add(symbol);
    }
  }

  return [...symbols].sort();
}

function scoreContextPenalty(symbol, evidenceText) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`\\bafter\\b[^.!?]{0,80}\\b${escaped}\\b[^.!?]{0,80}\\bupgraded the stock\\b`, "i"),
    new RegExp(`\\bafter\\b[^.!?]{0,80}\\b${escaped}\\b[^.!?]{0,80}\\braised (?:its|the) target\\b`, "i"),
  ];

  if (patterns.some((pattern) => pattern.test(evidenceText))) return 24;
  return 0;
}

function hasCompanyAlias(text, alias) {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9&.])${escaped}([^A-Za-z0-9&.]|$)`, "i").test(text);
}

function countTickerMentions(text, symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...text.matchAll(new RegExp(`\\b${escaped}\\b`, "g"))].length;
}

function findMoveNearTicker(text, symbol) {
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes(symbol)) continue;
    const window = lines.slice(index, index + 4).join(" ");
    const match = window.match(/[+-]\d+(?:\.\d+)?%/);
    if (match) return match[0];
  }

  return null;
}

function findFallbackTickerNotes(sentences, symbol) {
  const aliases = COMPANY_ALIASES.find(([candidate]) => candidate === symbol)?.[1] ?? [];

  const aliasNotes = aliases
    .flatMap((alias) => sentences.filter((sentence) => hasCompanyAlias(sentence, alias)))
    .slice(0, 3);

  if (aliasNotes.length > 0) return aliasNotes;

  return sentences
    .filter((sentence) => new RegExp(`\\b${symbol}\\b`).test(sentence))
    .slice(0, 2);
}

function extractThemes(text) {
  const themes = [
    ["AI Infrastructure", /\bAI\b|artificial intelligence|infrastructure/i],
    ["Defense Spending", /defense|geopolitical|military/i],
    ["Space Economy", /space|satellite|launch/i],
    ["Industrial Automation", /automation|industrial|machinery/i],
    ["Streaming And Media", /streaming|Netflix|media/i],
    ["Food Inflation", /egg|food price|avian flu|crop seed|fertilizer|beef/i],
    ["Financials", /bank|Goldman|regional bank/i],
    ["Semiconductors", /semiconductor|Nvidia|NVDA|chip/i],
    ["Earnings", /\bearnings?\b|quarterly/i],
    ["Regulatory Risk", /\bDOJ\b|\bSEC\b|antitrust|lawsuit|investigation/i],
  ];

  return themes.filter(([, pattern]) => pattern.test(text)).map(([theme]) => theme);
}

function extractEvents(text, sourceDate) {
  const normalizedText = String(text ?? "").replace(/=\r?\n/g, "");
  const lines = normalizedText
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const fallbackDate = normalizeDateString(sourceDate) || null;
  const events = [];

  for (const line of lines) {
    if (/data as of|how did you like this email|manage notifications|presented by/i.test(line)) continue;

    const timed = line.match(/^\*?\s*(\d{1,2}:\d{2}\s*(?:AM|PM)):\s*(.+)$/i);
    if (timed) {
      events.push({
        kind: "economic",
        date: fallbackDate,
        time: timed[1].toUpperCase(),
        title: timed[2].trim(),
      });
      continue;
    }

    const earnings = line.match(/^\*?\s*([A-Z][A-Za-z0-9&.' -]{1,60})\s*\((?:NASDAQ|NYSE|AMEX):([A-Z.\-]+)\s*\)\s*(.+)$/i);
    if (earnings && /\b(earnings|report|before the opening bell|before the market open|after the market close|after close|reports?)\b/i.test(earnings[3])) {
      const schedule = inferScheduledEarningsTime(earnings[3]);
      if (!schedule) continue;
      events.push({
        kind: "earnings",
        date: fallbackDate,
        time: schedule,
        title: `${earnings[1].trim()} (${earnings[2].toUpperCase()})`,
        symbol: earnings[2].toUpperCase(),
        note: summarizeEventNote(earnings[3]),
      });
      continue;
    }
  }

  for (const match of normalizedText.matchAll(/([A-Z][A-Za-z0-9&.' -]{1,80})\s*\((?:NASDAQ|NYSE|AMEX):\s*([A-Z.\-]+)\s*\)\s*([^.\n]{0,220})/gi)) {
    const company = match[1].replace(/\s+/g, " ").trim();
    const symbol = match[2].toUpperCase();
    const context = match[3].replace(/\s+/g, " ").trim();
    const schedule = inferScheduledEarningsTime(context);
    if (!schedule) continue;

    events.push({
      kind: "earnings",
      date: fallbackDate,
      time: schedule,
      title: `${company} (${symbol})`,
      symbol,
      note: summarizeEventNote(context),
    });
  }

  return uniqueStructuredEvents(events).slice(0, 12);
}

function normalizeDateString(value) {
  if (!value) return "";

  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "";

  const year = parsed.getUTCFullYear();
  const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const day = String(parsed.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function inferEventTime(text) {
  if (/before the opening bell|before the market open/i.test(text)) return "Before Open";
  if (/after the market close|after close/i.test(text)) return "After Close";
  return "Scheduled";
}

function inferScheduledEarningsTime(text) {
  if (/results offered|reported|beat|missed|fell|soared|jumped|rose/i.test(text) && !/will report|should deliver earnings|reports after|reports ahead|scheduled to report/i.test(text)) {
    return "";
  }
  if (/before the opening bell|before the market open|ahead of the market opening/i.test(text)) return "Before Open";
  if (/after the market close|after close|reports after the market close|will report today after close/i.test(text)) return "After Close";
  if (/should deliver earnings|will report|reports today|reports tomorrow|scheduled to report/i.test(text)) return "Scheduled";
  return "";
}

function summarizeEventNote(text) {
  return truncateText(
    String(text ?? "")
      .replace(/\s+/g, " ")
      .trim(),
    140,
  );
}

function uniqueStructuredEvents(events) {
  const seen = new Set();
  return events.filter((event) => {
    const key = [event.date, event.time, event.title, event.kind].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function truncate(value, maxChars) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[Truncated after ${maxChars} characters]`;
}

async function generateWithOpenAI({ apiKey, model, prompt }) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: prompt,
    }),
  });

  const payload = await response.json();

  if (!response.ok) {
    const message = payload.error?.message || response.statusText;
    throw new Error(`OpenAI request failed: ${message}`);
  }

  if (payload.output_text) return payload.output_text;

  const text = payload.output
    ?.flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text)
    .join("\n\n");

  if (!text) throw new Error("OpenAI response did not include text output.");
  return text;
}
