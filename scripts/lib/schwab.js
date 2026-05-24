import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import "dotenv/config";

const ROOT = path.resolve(import.meta.dirname, "../..");
const DATA_DIR = path.join(ROOT, "data", "schwab");
const TOKEN_PATH = path.join(DATA_DIR, "oauth.json");
const AUTH_BASE_URL = "https://api.schwabapi.com/v1/oauth/authorize";
const TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";
const TRADER_BASE_URL = "https://api.schwabapi.com/trader/v1";
const MARKET_DATA_BASE_URL = "https://api.schwabapi.com/marketdata/v1";
const ACCESS_TOKEN_BUFFER_MS = 60_000;
const REQUEST_TIMEOUT_MS = Number(process.env.SCHWAB_TIMEOUT_MS || 20_000);

export function getSchwabConfig() {
  const callbackUrl = String(process.env.SCHWAB_CALLBACK_URL || "https://127.0.0.1").trim();
  return {
    appKey: process.env.SCHWAB_APP_KEY || process.env.SCHWAB_CLIENT_ID || "",
    appSecret: process.env.SCHWAB_APP_SECRET || process.env.SCHWAB_CLIENT_SECRET || "",
    callbackUrl,
    callbackUrlWithSlash: callbackUrl.endsWith("/") ? callbackUrl : `${callbackUrl}/`,
  };
}

export function getSchwabPaths() {
  return {
    dataDir: DATA_DIR,
    tokenPath: TOKEN_PATH,
  };
}

export async function readSchwabSnapshot(date) {
  const files = date
    ? [path.join(DATA_DIR, `${date}.json`), path.join(DATA_DIR, "latest.json")]
    : [path.join(DATA_DIR, "latest.json")];

  for (const filePath of files) {
    try {
      return JSON.parse(await readFile(filePath, "utf8"));
    } catch {}
  }

  return null;
}

export function buildAuthorizationUrl() {
  const { callbackUrl } = getSchwabConfig();
  return buildAuthorizationUrlForRedirect(callbackUrl);
}

export async function connectSchwab({ redirectedUrl, interactive = true } = {}) {
  const { appKey, appSecret, callbackUrl, callbackUrlWithSlash } = getSchwabConfig();
  if (!appKey || !appSecret) {
    throw new Error("Missing SCHWAB_APP_KEY or SCHWAB_APP_SECRET in .env");
  }

  let finalUrl = redirectedUrl?.trim() || "";

  if (!finalUrl && interactive) {
    const rl = readline.createInterface({ input, output });
    try {
      console.log("1. Open this URL in your browser and approve the app:");
      console.log(buildAuthorizationUrl());
      console.log("");
      finalUrl = (await rl.question("2. Paste the full redirected URL here: ")).trim();
    } finally {
      rl.close();
    }
  }

  if (!finalUrl) {
    return {
      ok: false,
      authorizationUrl: buildAuthorizationUrl(),
      message: "No redirected URL was provided yet.",
    };
  }

  const code = extractAuthorizationCode(finalUrl);
  const token = await exchangeAuthorizationCode({ code, callbackUrl, callbackUrlWithSlash, appKey, appSecret });
  await saveToken(token);
  return {
    ok: true,
    authorizationUrl: buildAuthorizationUrl(),
    token: summarizeToken(token),
  };
}

export async function connectSchwabWithLoopback({ port = 8182, pathName = "/callback" } = {}) {
  const { appKey, appSecret } = getSchwabConfig();
  if (!appKey || !appSecret) {
    throw new Error("Missing SCHWAB_APP_KEY or SCHWAB_APP_SECRET in .env");
  }

  const callbackUrl = `http://127.0.0.1:${port}${pathName}`;
  const authorizationUrl = buildAuthorizationUrlForRedirect(callbackUrl);
  const code = await waitForAuthorizationCode({ authorizationUrl, callbackUrl, port, pathName });
  const token = await exchangeAuthorizationCode({ code, callbackUrl, callbackUrlWithSlash: callbackUrl, appKey, appSecret });
  await saveToken(token);

  return {
    ok: true,
    authorizationUrl,
    callbackUrl,
    token: summarizeToken(token),
  };
}

export async function syncSchwabAccount({ date = todayString(), includeQuotes = true } = {}) {
  const token = await getUsableAccessToken();
  if (!token.ok) {
    return {
      ok: false,
      date,
      syncedAt: new Date().toISOString(),
      reason: token.reason,
      needsAuth: true,
      authorizationUrl: canBuildAuthUrl() ? buildAuthorizationUrl() : null,
    };
  }

  const [accountNumbers, accounts, userPreference] = await Promise.all([
    schwabJson("/accounts/accountNumbers", token.accessToken),
    schwabJson("/accounts?fields=positions", token.accessToken),
    schwabJson("/userPreference", token.accessToken),
  ]);

  const errors = [];
  if (!accountNumbers.ok) errors.push(`Account numbers: ${accountNumbers.error}`);
  if (!accounts.ok) errors.push(`Accounts: ${accounts.error}`);
  if (!userPreference.ok) errors.push(`Preferences: ${userPreference.error}`);

  if (!accounts.ok) {
    return {
      ok: false,
      date,
      syncedAt: new Date().toISOString(),
      reason: errors.join(" | ") || "Schwab account sync failed.",
      authorizationUrl: canBuildAuthUrl() ? buildAuthorizationUrl() : null,
    };
  }

  const normalizedAccounts = normalizeAccounts({
    accountNumbers: accountNumbers.ok ? accountNumbers.data : [],
    accounts: accounts.data,
    userPreference: userPreference.ok ? userPreference.data : null,
  });

  let quotes = null;
  if (includeQuotes) {
    const symbols = [...normalizedAccounts.positionsBySymbol.keys()];
    if (symbols.length) {
      const response = await schwabMarketDataJson(`/quotes?symbols=${encodeURIComponent(symbols.join(","))}`, token.accessToken);
      if (response.ok) {
        quotes = normalizeQuotes(response.data);
      } else {
        errors.push(`Quotes: ${response.error}`);
      }
    }
  }

  const summary = buildSchwabSnapshot({
    date,
    accounts: normalizedAccounts.accounts,
    positionsBySymbol: normalizedAccounts.positionsBySymbol,
    userPreference: normalizedAccounts.userPreference,
    quotes,
    errors,
  });

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(path.join(DATA_DIR, `${date}.json`), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(path.join(DATA_DIR, "latest.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}

export async function loadSchwabHolding(symbol, date) {
  const snapshot = await readSchwabSnapshot(date);
  if (!snapshot?.ok) return null;
  return snapshot.positionsBySymbol?.[symbol] ?? null;
}

async function getUsableAccessToken() {
  const token = await readToken();
  if (!token) {
    return {
      ok: false,
      reason: "No Schwab OAuth token found yet. Run npm run schwab:connect first.",
    };
  }

  if (token.accessToken && token.accessTokenExpiresAt && Date.now() < new Date(token.accessTokenExpiresAt).getTime() - ACCESS_TOKEN_BUFFER_MS) {
    return { ok: true, accessToken: token.accessToken };
  }

  if (!token.refreshToken) {
    return {
      ok: false,
      reason: "Schwab token is missing a refresh token. Reconnect with npm run schwab:connect.",
    };
  }

  let refreshed;
  try {
    refreshed = await refreshAccessToken(token.refreshToken);
  } catch (error) {
    if (isAuthRecoveryError(error)) {
      return {
        ok: false,
        reason: `${error.message}. Reconnect with npm run schwab:connect.`,
      };
    }
    throw error;
  }
  const merged = {
    ...token,
    ...refreshed,
    refreshToken: refreshed.refreshToken || token.refreshToken,
  };
  await saveToken(merged);
  return { ok: true, accessToken: merged.accessToken };
}

function isAuthRecoveryError(error) {
  return /invalid_grant|refresh token is invalid, expired or revoked/i.test(String(error?.message ?? ""));
}

async function refreshAccessToken(refreshToken) {
  const { appKey, appSecret } = getSchwabConfig();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const response = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${appKey}:${appSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const payload = await parseJsonSafe(response);
  if (!response.ok) {
    throw new Error(`Schwab token refresh failed (${response.status}): ${payload?.error_description || payload?.error || "Unknown error"}`);
  }

  return normalizeTokenPayload(payload);
}

async function exchangeAuthorizationCode({ code, callbackUrl, callbackUrlWithSlash, appKey, appSecret }) {
  const redirects = [callbackUrl, callbackUrlWithSlash].filter(Boolean).filter((value, index, list) => list.indexOf(value) === index);
  let lastError = null;

  for (const redirectUri of redirects) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    });

    const response = await fetchWithTimeout(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${appKey}:${appSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    const payload = await parseJsonSafe(response);
    if (response.ok) {
      return normalizeTokenPayload(payload);
    }

    lastError = `Schwab token exchange failed (${response.status}) using redirect_uri ${redirectUri}: ${payload?.error_description || payload?.error || "Unknown error"}`;
  }

  throw new Error(lastError || "Schwab token exchange failed.");
}

function normalizeTokenPayload(payload) {
  const now = Date.now();
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || null,
    scope: payload.scope || "",
    tokenType: payload.token_type || "Bearer",
    accessTokenExpiresAt: new Date(now + Number(payload.expires_in || 1800) * 1000).toISOString(),
    refreshTokenIssuedAt: new Date(now).toISOString(),
    raw: payload,
  };
}

async function readToken() {
  try {
    return JSON.parse(await readFile(TOKEN_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function saveToken(token) {
  await mkdir(DATA_DIR, { recursive: true });
  const payload = {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    tokenType: token.tokenType,
    scope: token.scope,
    accessTokenExpiresAt: token.accessTokenExpiresAt,
    refreshTokenIssuedAt: token.refreshTokenIssuedAt,
    updatedAt: new Date().toISOString(),
    raw: token.raw ?? null,
  };
  await writeFile(TOKEN_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function summarizeToken(token) {
  return {
    scope: token.scope || "",
    accessTokenExpiresAt: token.accessTokenExpiresAt,
    hasRefreshToken: Boolean(token.refreshToken),
  };
}

function buildAuthorizationUrlForRedirect(callbackUrl) {
  const { appKey } = getSchwabConfig();
  if (!appKey) throw new Error("Missing SCHWAB_APP_KEY in .env");
  const redirect = String(callbackUrl || "").trim();
  return `${AUTH_BASE_URL}?response_type=code&client_id=${encodeURIComponent(appKey)}&redirect_uri=${redirect}`;
}

function extractAuthorizationCode(redirectedUrl) {
  let url;
  try {
    url = new URL(redirectedUrl);
  } catch {
    throw new Error("The pasted redirect value is not a valid URL.");
  }

  const code = url.searchParams.get("code");
  if (!code) {
    const error = url.searchParams.get("error");
    if (error) throw new Error(`Schwab authorization failed: ${error}`);
    throw new Error("No authorization code found in the redirected URL.");
  }
  return code;
}

async function schwabJson(endpoint, accessToken) {
  const response = await fetchWithTimeout(`${TRADER_BASE_URL}${endpoint}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const payload = await parseJsonSafe(response);
  if (!response.ok) {
    return { ok: false, error: payload?.message || payload?.error || `${response.status} ${response.statusText}` };
  }
  return { ok: true, data: payload };
}

async function schwabMarketDataJson(endpoint, accessToken) {
  const response = await fetchWithTimeout(`${MARKET_DATA_BASE_URL}${endpoint}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const payload = await parseJsonSafe(response);
  if (!response.ok) {
    return { ok: false, error: payload?.message || payload?.error || `${response.status} ${response.statusText}` };
  }
  return { ok: true, data: payload };
}

function normalizeAccounts({ accountNumbers, accounts, userPreference }) {
  const numberMap = new Map((accountNumbers ?? []).map((item) => [item.hashValue || item.accountNumber, item]));
  const normalizedAccounts = [];
  const positionsBySymbol = new Map();

  for (const item of accounts ?? []) {
    const account = item.securitiesAccount ?? item;
    const accountHash = account.accountNumber || "";
    const numberInfo = numberMap.get(accountHash) || numberMap.get(account.accountNumber) || null;
    const balances = account.currentBalances ?? {};
    const initialBalances = account.initialBalances ?? {};
    const positions = (account.positions ?? []).map((position) => normalizePosition(position, accountHash));
    const preference = findPreferenceForAccount(userPreference, accountHash);

    const normalized = {
      accountHash,
      accountNumberMasked: maskAccountNumber(numberInfo?.accountNumber || account.accountNumber),
      type: account.type || account.accountType || "Brokerage",
      displayName: preference?.nickName || preference?.displayName || `Account ${maskAccountNumber(numberInfo?.accountNumber || account.accountNumber)}`,
      balances: {
        liquidationValue: numberOrNull(balances.liquidationValue),
        cashBalance: numberOrNull(balances.cashBalance),
        availableFunds: numberOrNull(balances.availableFunds),
        buyingPower: numberOrNull(balances.buyingPower ?? balances.dayTradingBuyingPower ?? initialBalances.buyingPower),
        dayTradingBuyingPower: numberOrNull(balances.dayTradingBuyingPower),
        maintenanceCall: numberOrNull(balances.maintenanceCall),
      },
      positions,
    };

    for (const position of positions) {
      const current = positionsBySymbol.get(position.symbol) ?? {
        symbol: position.symbol,
        description: position.description,
        assetType: position.assetType,
        totalQuantity: 0,
        totalMarketValue: 0,
        totalDayProfitLoss: 0,
        totalLongQuantity: 0,
        totalShortQuantity: 0,
        accounts: [],
      };

      current.totalQuantity += position.netQuantity;
      current.totalMarketValue += position.marketValue ?? 0;
      current.totalDayProfitLoss += position.dayProfitLoss ?? 0;
      current.totalLongQuantity += position.longQuantity ?? 0;
      current.totalShortQuantity += position.shortQuantity ?? 0;
      current.accounts.push({
        accountHash,
        accountNumberMasked: normalized.accountNumberMasked,
        displayName: normalized.displayName,
        quantity: position.netQuantity,
        marketValue: position.marketValue,
      });
      positionsBySymbol.set(position.symbol, current);
    }

    normalizedAccounts.push(normalized);
  }

  return {
    accounts: normalizedAccounts,
    positionsBySymbol,
    userPreference,
  };
}

function normalizePosition(position, accountHash) {
  const instrument = position.instrument ?? {};
  const longQuantity = numberOrNull(position.longQuantity) ?? 0;
  const shortQuantity = numberOrNull(position.shortQuantity) ?? 0;
  return {
    accountHash,
    symbol: instrument.symbol || instrument.underlyingSymbol || "UNKNOWN",
    description: instrument.description || instrument.symbol || "Unknown security",
    assetType: instrument.assetType || position.assetType || "EQUITY",
    longQuantity,
    shortQuantity,
    netQuantity: longQuantity - shortQuantity,
    averagePrice: numberOrNull(position.averagePrice),
    marketValue: numberOrNull(position.marketValue),
    dayProfitLoss: numberOrNull(position.currentDayProfitLoss),
    dayProfitLossPercent: numberOrNull(position.currentDayProfitLossPercentage),
  };
}

function buildSchwabSnapshot({ date, accounts, positionsBySymbol, userPreference, quotes, errors }) {
  const totals = accounts.reduce(
    (acc, account) => {
      acc.accountCount += 1;
      acc.positionCount += account.positions.length;
      acc.equity += account.balances.liquidationValue || 0;
      acc.cash += account.balances.cashBalance || 0;
      acc.buyingPower += account.balances.buyingPower || 0;
      return acc;
    },
    { accountCount: 0, positionCount: 0, equity: 0, cash: 0, buyingPower: 0 },
  );

  const symbolObject = Object.fromEntries(
    [...positionsBySymbol.entries()]
      .sort((a, b) => Math.abs((b[1].totalMarketValue || 0)) - Math.abs((a[1].totalMarketValue || 0)))
      .map(([symbol, item]) => [symbol, { ...item, accounts: item.accounts.sort((a, b) => Math.abs(b.marketValue || 0) - Math.abs(a.marketValue || 0)) }]),
  );

  return {
    ok: true,
    date,
    syncedAt: new Date().toISOString(),
    totals: {
      accountCount: totals.accountCount,
      positionCount: totals.positionCount,
      equity: round(totals.equity),
      cash: round(totals.cash),
      buyingPower: round(totals.buyingPower),
    },
    accounts,
    positionsBySymbol: symbolObject,
    topHoldings: Object.values(symbolObject).slice(0, 8),
    quotes,
    preferences: summarizePreferences(userPreference),
    errors,
  };
}

function summarizePreferences(userPreference) {
  if (!userPreference) return null;
  const accounts = Array.isArray(userPreference.accounts) ? userPreference.accounts : Array.isArray(userPreference) ? userPreference.flatMap((item) => item.accounts ?? []) : [];
  return {
    preferredAccounts: accounts
      .map((item) => ({
        accountHash: item.accountNumber || item.accountId || "",
        displayName: item.nickName || item.displayName || "",
        primaryAccount: Boolean(item.primaryAccount),
        type: item.type || item.accountType || "",
      }))
      .filter((item) => item.accountHash || item.displayName),
  };
}

function normalizeQuotes(payload) {
  const entries = [];
  for (const [symbol, quote] of Object.entries(payload ?? {})) {
    entries.push([
      symbol,
      {
        symbol,
        lastPrice: numberOrNull(quote.quote?.lastPrice ?? quote.lastPrice),
        mark: numberOrNull(quote.quote?.mark ?? quote.mark),
        netChange: numberOrNull(quote.quote?.netChange ?? quote.netChange),
      },
    ]);
  }
  return Object.fromEntries(entries);
}

function findPreferenceForAccount(userPreference, accountHash) {
  const accounts = Array.isArray(userPreference?.accounts)
    ? userPreference.accounts
    : Array.isArray(userPreference)
      ? userPreference.flatMap((item) => item.accounts ?? [])
      : [];
  return accounts.find((item) => item.accountNumber === accountHash || item.accountId === accountHash) ?? null;
}

function maskAccountNumber(accountNumber) {
  const value = String(accountNumber ?? "");
  if (value.length <= 4) return value || "Unknown";
  return `••••${value.slice(-4)}`;
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value) {
  if (!Number.isFinite(Number(value))) return null;
  return Math.round(Number(value) * 100) / 100;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function parseJsonSafe(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function canBuildAuthUrl() {
  const { appKey } = getSchwabConfig();
  return Boolean(appKey);
}

async function waitForAuthorizationCode({ authorizationUrl, callbackUrl, port, pathName }) {
  console.log("Open this URL in your browser:");
  console.log(authorizationUrl);
  console.log("");
  console.log(`Waiting for Schwab redirect on ${callbackUrl} ...`);

  return await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const requestUrl = new URL(req.url || "/", callbackUrl);
        if (requestUrl.pathname !== pathName) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
          return;
        }

        const error = requestUrl.searchParams.get("error");
        const code = requestUrl.searchParams.get("code");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(`Schwab authorization failed: ${error}`);
          server.close(() => reject(new Error(`Schwab authorization failed: ${error}`)));
          return;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("No authorization code received.");
          server.close(() => reject(new Error("No authorization code received from Schwab.")));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<html><body style=\"font-family: sans-serif; padding: 24px;\"><h1>Schwab connected</h1><p>You can close this tab and return to Codex.</p></body></html>");
        server.close(() => resolve(code));
      } catch (error) {
        server.close(() => reject(error));
      }
    });

    server.on("error", (error) => reject(error));
    server.listen(port, "127.0.0.1");
  });
}
