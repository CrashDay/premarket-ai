import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderBriefingHtml } from "./lib/briefing-html.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS_DIR = path.join(ROOT, "reports");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const SITE_ROOT = process.env.PREMARKET_SITE_ROOT || path.resolve(ROOT, "..", "crash-motorsport");
const OUTPUT_DIR = path.join(SITE_ROOT, "data", "premarket-briefs");
const DASHBOARD_OUTPUT_DIR = path.join(SITE_ROOT, "data", "premarket-dashboard");
const SITE_PUBLIC_DATA_DIR = path.join(SITE_ROOT, "public", "data");

const latestDate = await findLatestReportDate();

if (!latestDate) {
  console.log("No dated markdown reports found. Skipping site publish.");
  process.exit(0);
}

const reportPath = path.join(REPORTS_DIR, `${latestDate}.md`);

let markdown = "";
try {
  markdown = await readFile(reportPath, "utf8");
} catch {
  console.log(`Latest report ${reportPath} is missing. Skipping site publish.`);
  process.exit(0);
}

try {
  await mkdir(OUTPUT_DIR, { recursive: true });
} catch (error) {
  console.log(`Could not prepare ${OUTPUT_DIR}: ${error.message}`);
  process.exit(0);
}

const brief = {
  date: latestDate,
  title: `Pre-Market Briefing - ${latestDate}`,
  markdown,
  html: renderBriefingHtml(markdown),
  publishedAt: new Date().toISOString(),
};

await writeFile(path.join(OUTPUT_DIR, `${latestDate}.json`), `${JSON.stringify(brief, null, 2)}\n`, "utf8");
await writeFile(path.join(OUTPUT_DIR, "latest.json"), `${JSON.stringify(brief, null, 2)}\n`, "utf8");
await publishDashboardBundle(latestDate);

console.log(`Published premarket brief to ${OUTPUT_DIR}`);

async function findLatestReportDate() {
  let entries = [];

  try {
    entries = await readdir(REPORTS_DIR, { withFileTypes: true });
  } catch {
    return null;
  }

  const dates = entries
    .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name))
    .map((entry) => entry.name.replace(/\.md$/, ""))
    .sort();

  return dates.at(-1) ?? null;
}

async function publishDashboardBundle(date) {
  const dashboardHtmlPath = path.join(PUBLIC_DIR, "dashboard.html");
  const dashboardHtml = await readFile(dashboardHtmlPath, "utf8");
  const datedOutputDir = path.join(DASHBOARD_OUTPUT_DIR, date);
  const latestOutputDir = path.join(DASHBOARD_OUTPUT_DIR, "latest");
  const candlesSourceDir = path.join(DATA_DIR, "candles", date);
  const candlesTargetDir = path.join(SITE_PUBLIC_DATA_DIR, "candles", date);
  const verificationsSourceDir = path.join(DATA_DIR, "verifications", date);

  await mkdir(datedOutputDir, { recursive: true });
  await mkdir(latestOutputDir, { recursive: true });
  await mkdir(path.dirname(candlesTargetDir), { recursive: true });

  await writeFile(path.join(datedOutputDir, "dashboard.html"), dashboardHtml, "utf8");
  await writeFile(path.join(latestOutputDir, "dashboard.html"), dashboardHtml, "utf8");

  await rm(candlesTargetDir, { recursive: true, force: true });
  await cp(candlesSourceDir, candlesTargetDir, { recursive: true });

  const verificationRecords = await loadVerificationRecords(verificationsSourceDir);
  const payload = `${JSON.stringify({ date, records: verificationRecords }, null, 2)}\n`;
  await writeFile(path.join(datedOutputDir, "verifications.json"), payload, "utf8");
  await writeFile(path.join(latestOutputDir, "verifications.json"), payload, "utf8");
}

async function loadVerificationRecords(sourceDir) {
  let entries = [];

  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const records = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => JSON.parse(await readFile(path.join(sourceDir, entry.name), "utf8"))),
  );

  return records.sort((a, b) => String(a.symbol ?? "").localeCompare(String(b.symbol ?? "")));
}
