import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderBriefingHtml } from "./lib/briefing-html.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS_DIR = path.join(ROOT, "reports");
const SITE_ROOT = process.env.PREMARKET_SITE_ROOT || path.resolve(ROOT, "..", "crash-motorsport");
const OUTPUT_DIR = path.join(SITE_ROOT, "data", "premarket-briefs");

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
