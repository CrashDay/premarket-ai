import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { authenticate } from "@google-cloud/local-auth";
import { OAuth2Client } from "google-auth-library";

const ROOT = path.resolve(import.meta.dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config", "gmail-labels.json");
const CREDENTIALS_PATH = path.join(ROOT, "credentials.json");
const TOKEN_PATH = path.join(ROOT, "token.json");
const STATE_DIR = path.join(ROOT, "state");
const STATE_PATH = path.join(STATE_DIR, "gmail-processed.json");
const INBOX_DIR = path.join(ROOT, "inbox");
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

const args = parseArgs(process.argv.slice(2));
const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
const state = await loadState();

await mkdir(STATE_DIR, { recursive: true });
if (args.output) {
  await mkdir(path.resolve(args.output), { recursive: true });
}

const accessToken = await authorize();

const labels = await loadLabels(accessToken);
const imported = [];
const missing = [];
const skipped = {
  processed: 0,
  dateMismatch: 0,
};
const queue = [];

for (const labelName of config.labels) {
  const label = labels.find((item) => item.name === labelName);

  if (!label) {
    missing.push(labelName);
    continue;
  }

  const messages = await listMessages(accessToken, {
    labelId: label.id,
    maxResults: config.maxMessagesPerLabel ?? 20,
    query: config.query,
  });

  queue.push(...messages.map((message) => ({ id: message.id, sourceName: labelName })));
}

for (const fallback of config.fallbackQueries ?? []) {
  const messages = await listMessages(accessToken, {
    maxResults: fallback.maxResults ?? config.maxMessagesPerLabel ?? 20,
    query: fallback.query,
  });

  queue.push(...messages.map((message) => ({ id: message.id, sourceName: fallback.name })));
}

for (const message of uniqueMessages(queue)) {
  if (state.processedMessageIds.includes(message.id)) {
    skipped.processed += 1;
    continue;
  }

  const fullMessage = await getMessage(accessToken, message.id);
  const metadata = await getMessageMetadata(accessToken, message.id);
  const messageDate = resolveMessageDate(metadata);

  if (args.date && messageDate !== args.date) {
    skipped.dateMismatch += 1;
    continue;
  }

  const raw = decodeBase64Url(fullMessage.raw);
  const subject = findHeader(metadata.payload?.headers ?? [], "Subject") ?? message.id;
  const outputDir = args.output
    ? path.resolve(args.output)
    : path.join(INBOX_DIR, messageDate);
  const fileName = `${messageDate}-${slugify(message.sourceName)}-${slugify(subject).slice(0, 80)}-${message.id}.eml`;
  const filePath = path.join(outputDir, fileName);

  await mkdir(outputDir, { recursive: true });
  await writeFile(filePath, raw, "utf8");
  state.processedMessageIds.push(message.id);
  imported.push({ label: message.sourceName, subject, filePath });
}

state.processedMessageIds = [...new Set(state.processedMessageIds)].slice(-5000);
state.updatedAt = new Date().toISOString();
await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");

for (const item of imported) {
  console.log(`Imported [${item.label}] ${item.subject}`);
  console.log(`  ${item.filePath}`);
}

if (missing.length > 0) {
  console.log("Missing Gmail labels:");
  for (const label of missing) console.log(`  ${label}`);
}

if (skipped.processed > 0) {
  console.log(`Skipped ${skipped.processed} message(s) already imported.`);
}

if (skipped.dateMismatch > 0) {
  console.log(`Skipped ${skipped.dateMismatch} message(s) outside requested --date.`);
}

if (imported.length === 0) {
  console.log("No new Gmail messages imported.");
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--date") parsed.date = argv[++index];
    else if (arg === "--output") parsed.output = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm run gmail:import -- [--date YYYY-MM-DD] [--output DIR]");
      process.exit(0);
    }
  }

  return parsed;
}

async function loadState() {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      processedMessageIds: parsed.processedMessageIds ?? [],
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return {
      processedMessageIds: [],
      updatedAt: null,
    };
  }
}

async function authorize() {
  const cached = await loadCachedToken();

  if (cached) {
    const client = await createOAuthClient();
    client.setCredentials(cached);
    const token = await client.getAccessToken();
    if (token?.token) {
      await writeFile(TOKEN_PATH, `${JSON.stringify(client.credentials, null, 2)}\n`, "utf8");
      return token.token;
    }
  }

  const client = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH,
  });

  const token = await client.getAccessToken();

  if (!token?.token) {
    throw new Error("Google OAuth completed but did not return an access token. Confirm your Gmail account is listed as a test user and re-run npm run gmail:import.");
  }

  await writeFile(TOKEN_PATH, `${JSON.stringify(client.credentials, null, 2)}\n`, "utf8");
  return token.token;
}

async function loadCachedToken() {
  try {
    return JSON.parse(await readFile(TOKEN_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function createOAuthClient() {
  const credentials = JSON.parse(await readFile(CREDENTIALS_PATH, "utf8"));
  const keys = credentials.installed ?? credentials.web;

  return new OAuth2Client({
    clientId: keys.client_id,
    clientSecret: keys.client_secret,
    redirectUri: keys.redirect_uris?.[0],
  });
}

async function loadLabels(accessToken) {
  const result = await gmailFetch(accessToken, "/users/me/labels");
  return result.labels ?? [];
}

async function listMessages(accessToken, { labelId, maxResults, query }) {
  const params = new URLSearchParams({
    maxResults: String(maxResults),
    q: query ?? "",
  });
  if (labelId) params.append("labelIds", labelId);

  const result = await gmailFetch(accessToken, `/users/me/messages?${params}`);
  return result.messages ?? [];
}

async function getMessage(accessToken, messageId) {
  return gmailFetch(accessToken, `/users/me/messages/${encodeURIComponent(messageId)}?format=raw`);
}

async function getMessageMetadata(accessToken, messageId) {
  const params = new URLSearchParams({
    format: "metadata",
  });
  params.append("metadataHeaders", "Subject");
  params.append("metadataHeaders", "Date");

  return gmailFetch(accessToken, `/users/me/messages/${encodeURIComponent(messageId)}?${params}`);
}

async function gmailFetch(accessToken, pathName) {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1${pathName}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const payload = await response.json();

  if (!response.ok) {
    const message = payload.error?.message || response.statusText;
    throw new Error(`Gmail API request failed (${response.status}): ${message}`);
  }

  return payload;
}

function findHeader(headers, name) {
  return headers.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value;
}

function resolveMessageDate(metadata) {
  const internalDate = Number(metadata.internalDate);
  if (Number.isFinite(internalDate) && internalDate > 0) {
    return formatLocalDate(new Date(internalDate));
  }

  const headerDate = findHeader(metadata.payload?.headers ?? [], "Date");
  const parsedDate = headerDate ? new Date(headerDate) : null;
  if (parsedDate && !Number.isNaN(parsedDate.getTime())) {
    return formatLocalDate(parsedDate);
  }

  return formatLocalDate(new Date());
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function decodeBase64Url(value) {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function slugify(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[^\w\s.-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
}

function uniqueMessages(messages) {
  const seen = new Set();
  const unique = [];

  for (const message of messages) {
    if (!message?.id || seen.has(message.id)) continue;
    seen.add(message.id);
    unique.push(message);
  }

  return unique;
}
