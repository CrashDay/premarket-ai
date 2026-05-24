import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listVerificationRecords, verifyCandidate } from "./lib/candidate-verifier.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const DASHBOARD_PATH = path.join(PUBLIC_DIR, "dashboard.html");
const port = Number(process.env.DASHBOARD_PORT || 8787);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const isHead = req.method === "HEAD";
  const isGetLike = req.method === "GET" || isHead;

  if (isGetLike && (url.pathname === "/" || url.pathname === "/dashboard")) {
    return serveFile(DASHBOARD_PATH, "text/html; charset=utf-8", res, isHead);
  }

  if (isGetLike && url.pathname === "/api/verifications") {
    const date = url.searchParams.get("date");
    if (!date) return sendJson(res, 400, { error: "Missing date query parameter." }, isHead);
    const records = await listVerificationRecords(date);
    return sendJson(res, 200, { records }, isHead);
  }

  if (req.method === "POST" && url.pathname === "/api/verify") {
    const body = await readJsonBody(req);
    if (!body?.symbol || !body?.date) {
      return sendJson(res, 400, { error: "Expected JSON body with symbol and date." });
    }

    try {
      const record = await verifyCandidate({ symbol: String(body.symbol).toUpperCase(), date: body.date });
      return sendJson(res, 200, { record });
    } catch (error) {
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      return sendJson(res, statusCode, { error: error.message });
    }
  }

  if (isGetLike) {
    const normalized = path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
    if (url.pathname.startsWith("/data/")) {
      const dataRelative = url.pathname.replace(/^\/data\//, "");
      const dataPath = path.join(DATA_DIR, path.normalize(dataRelative).replace(/^(\.\.[/\\])+/, ""));
      if (dataPath.startsWith(DATA_DIR) && dataPath !== DATA_DIR) {
        return serveFile(dataPath, contentTypeFor(dataPath), res, isHead);
      }
    }

    const publicPath = path.join(PUBLIC_DIR, normalized);
    if (publicPath.startsWith(PUBLIC_DIR) && publicPath !== PUBLIC_DIR) {
      return serveFile(publicPath, contentTypeFor(publicPath), res, isHead);
    }
  }

  sendJson(res, 404, { error: "Not found" }, isHead);
});

server.listen(port, () => {
  console.log(`Dashboard server running at http://127.0.0.1:${port}`);
});

async function serveFile(filePath, contentType, res, headOnly = false) {
  try {
    await readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
    if (headOnly) {
      res.end();
      return;
    }

    const stream = createReadStream(filePath);
    stream.on("error", () => {
      if (!res.headersSent) sendJson(res, 404, { error: "File not found" });
      else res.destroy();
    });
    stream.pipe(res);
  } catch {
    sendJson(res, 404, { error: "File not found" }, headOnly);
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return null;

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function sendJson(res, status, payload, headOnly = false) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(headOnly ? "" : body);
}

function contentTypeFor(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}
