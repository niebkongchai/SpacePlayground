// Run Coach backend: swaps a Garmin Personal API key for an access token, keeps both in
// memory only, proxies read-only Garmin Connect calls, and serves the SpacePlayground files.
// No dependencies. Run from the SpacePlayground folder:  node run-coach/server/server.js
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = path.resolve(__dirname, "..", "..");

const GARMIN = {
  global: "https://personal.connectapi.garmin.com",
  china: "https://personal.connectapi.garmin.cn",
};
const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";
const TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

// Only the read endpoints from the Personal API Swagger docs can be proxied.
const ALLOWED_PREFIXES = [
  "/activity-service/activity/",
  "/activitylist-service/activities/search/activities",
  "/wellnessactivity-service/activity/summary/range/",
  "/biometric-service/heartRateZones/v2",
  "/fitnessage-service/fitnessage/v2/",
  "/hrv-service/hrv/",
  "/sleep-service/sleep/",
  "/usersummary-service/",
  "/wellness-service/wellness/",
  "/weight-service/weight/",
  "/userprofile-service/userprofile/settings",
];

// sid -> { key, token, expiresAt, base, displayName, lastUsed }
const sessions = new Map();
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) if (now - s.lastUsed > SESSION_IDLE_MS) sessions.delete(sid);
}, 10 * 60 * 1000).unref();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
};

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) { reject(new Error("Body too large")); req.destroy(); }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function getSid(req) {
  const m = /(?:^|;\s*)rc_sid=([A-Za-z0-9-]+)/.exec(req.headers.cookie || "");
  return m ? m[1] : null;
}

function pickToken(json) {
  if (!json || typeof json !== "object") return null;
  const token = json.access_token || json.accessToken || json.token || json.oauth2Token?.access_token;
  if (!token) return null;
  const secs = Number(json.expires_in || json.expiresIn || json.oauth2Token?.expires_in);
  return { token, expiresAt: Date.now() + (secs > 0 ? secs * 1000 : TOKEN_LIFETIME_MS) };
}

async function mintToken(base, key) {
  const r = await fetch(base + TOKEN_PATH, {
    method: "POST",
    // Garmin answers 406 if Accept asks for JSON; the token comes back as plain text.
    headers: { Authorization: "ApiKey " + key },
  });
  const text = await r.text();
  if (!r.ok) {
    const err = new Error(`Garmin token endpoint answered ${r.status}`);
    err.status = r.status;
    err.detail = text.slice(0, 300);
    throw err;
  }
  let json = null;
  try { json = JSON.parse(text); } catch { /* plain-text token */ }
  const picked = pickToken(json) || (text.trim() && !text.trim().startsWith("{")
    ? { token: text.trim().replace(/^"|"$/g, ""), expiresAt: Date.now() + TOKEN_LIFETIME_MS }
    : null);
  if (!picked) throw new Error("Garmin returned no access token");
  return picked;
}

async function garminGet(session, pathAndQuery, retried = false) {
  if (session.key && Date.now() > session.expiresAt - 60 * 1000) {
    Object.assign(session, await mintToken(session.base, session.key));
  }
  const r = await fetch(session.base + pathAndQuery, {
    headers: { Authorization: "Bearer " + session.token },
  });
  if (r.status === 401 && session.key && !retried) {
    Object.assign(session, await mintToken(session.base, session.key));
    return garminGet(session, pathAndQuery, true);
  }
  return r;
}

async function handleCreateSession(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: "Send JSON: {\"key\": \"...\"}" }); }
  const secret = String(body.key || "").trim();
  const base = GARMIN[body.region] || GARMIN.global;
  if (secret.length < 10) return sendJson(res, 400, { error: "That doesn't look like a Garmin API key." });

  const session = { key: null, token: null, expiresAt: 0, base, displayName: null, lastUsed: Date.now() };
  let mode = "apikey";
  try {
    Object.assign(session, await mintToken(base, secret));
    session.key = secret;
  } catch (e) {
    // Maybe the user pasted an access token that was already minted: try it directly.
    if (e.status && e.status < 500) {
      session.token = secret;
      session.expiresAt = Date.now() + TOKEN_LIFETIME_MS;
      mode = "token";
    } else {
      return sendJson(res, 502, { error: "Couldn't reach Garmin: " + e.message });
    }
  }

  let profile;
  try {
    const r = await garminGet(session, "/userprofile-service/userprofile/settings");
    if (!r.ok) {
      return sendJson(res, 401, { error: `Garmin rejected this key (HTTP ${r.status}). Check it hasn't expired or been deleted, then create a new one.` });
    }
    profile = await r.json();
  } catch (e) {
    return sendJson(res, 502, { error: "Couldn't reach Garmin: " + e.message });
  }

  session.displayName = profile.displayName || null;
  const sid = crypto.randomUUID();
  sessions.set(sid, session);
  sendJson(res, 200, { ok: true, mode, displayName: session.displayName, expiresAt: session.expiresAt }, {
    "Set-Cookie": `rc_sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_IDLE_MS / 1000}`,
  });
}

async function handleProxy(req, res, url, session) {
  const garminPath = url.pathname.slice("/api/garmin".length);
  if (!ALLOWED_PREFIXES.some((p) => garminPath.startsWith(p)) || garminPath.includes("..")) {
    return sendJson(res, 403, { error: "Endpoint not allowed: " + garminPath });
  }
  try {
    const r = await garminGet(session, garminPath + url.search);
    const text = await r.text();
    res.writeHead(r.status, {
      "Content-Type": r.headers.get("content-type") || "application/json",
      "Cache-Control": "no-store",
    });
    res.end(text);
  } catch (e) {
    sendJson(res, 502, { error: "Garmin request failed: " + e.message });
  }
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.resolve(ROOT, "." + rel);
  if (!file.startsWith(ROOT + path.sep) || file.includes(`${path.sep}.git`) || file.includes(`${path.sep}server${path.sep}`)) {
    res.writeHead(404); return res.end("Not found");
  }
  fs.stat(file, (err, st) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    if (st.isDirectory()) { res.writeHead(301, { Location: url.pathname + "/" }); return res.end(); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/api/health") return sendJson(res, 200, { ok: true });

    if (url.pathname === "/api/session") {
      if (req.method === "POST") return await handleCreateSession(req, res);
      const sid = getSid(req);
      if (req.method === "DELETE") {
        if (sid) sessions.delete(sid);
        return sendJson(res, 200, { ok: true }, { "Set-Cookie": "rc_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
      }
      const s = sid && sessions.get(sid);
      if (!s) return sendJson(res, 401, { error: "Not connected" });
      return sendJson(res, 200, { ok: true, displayName: s.displayName, expiresAt: s.expiresAt, renews: !!s.key });
    }

    if (url.pathname.startsWith("/api/garmin/")) {
      if (req.method !== "GET") return sendJson(res, 405, { error: "Read-only" });
      const s = sessions.get(getSid(req));
      if (!s) return sendJson(res, 401, { error: "Not connected" });
      if (!s.key && Date.now() > s.expiresAt) { sessions.delete(getSid(req)); return sendJson(res, 401, { error: "Access token expired" }); }
      s.lastUsed = Date.now();
      return await handleProxy(req, res, url, s);
    }

    if (url.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "Unknown API route" });
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
    serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: "Server error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`SpacePlayground + Run Coach on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/run-coach/`);
});
