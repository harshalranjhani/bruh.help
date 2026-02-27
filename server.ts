import type { ServerWebSocket } from "bun";
import { timingSafeEqual } from "node:crypto";
import indexHtml from "./index.html";
import historyHtml from "./history.html";
import adminHtml from "./admin.html";
import broadcastHtml from "./broadcast.html";
import {
  clearAllRounds,
  countRounds,
  getAllRounds,
  getAvailableLanguages,
  getRounds,
} from "./db.ts";
import {
  ACTIVE_AI_PROVIDER,
  ALL_MODELS,
  LOG_FILE,
  bootstrapStateFromRounds,
  createBlankScores,
  createBlankJudgeScores,
  createEmptyLanguageScores,
  log,
  resetExternalStateAfterAdminReset,
  runGame,
} from "./game.ts";
import {
  setQuestionDifficulty,
  getQuestionDifficulty,
  type QuestionDifficulty,
} from "./stackoverflow.ts";
import type { GameState, RoundState } from "./types.ts";

const VERSION = crypto.randomUUID().slice(0, 8);

const runsArg = process.argv.find((arg) => arg.startsWith("runs="));
const runsRaw = runsArg ? runsArg.split("=")[1] : "infinite";
const runs = runsRaw === "infinite" ? Infinity : Number.parseInt(runsRaw ?? "", 10);

if (!process.env.STACK_EXCHANGE_KEY) {
  console.warn("Warning: STACK_EXCHANGE_KEY missing. Stack Overflow quota is lower without it.");
}

const persistedRounds = await getAllRounds();
const bootstrappedState = {
  scores: createBlankScores(),
  viewerScores: createBlankScores(),
  languageScores: createEmptyLanguageScores(),
};
bootstrapStateFromRounds(persistedRounds, bootstrappedState);

const initialCompleted: RoundState[] = persistedRounds.length
  ? [persistedRounds[persistedRounds.length - 1]!]
  : [];

const gameState: GameState = {
  completed: initialCompleted,
  active: null,
  scores: bootstrappedState.scores,
  viewerScores: bootstrappedState.viewerScores,
  judgeScores: createBlankJudgeScores(),
  judgeRounds: createBlankJudgeScores(),
  languageScores: bootstrappedState.languageScores,
  done: false,
  isPaused: false,
  generation: 0,
  roundDelayMs: 180_000,
};

// Guardrails

type WsData = { ip: string };
type ViewerVoteSide = "A" | "B";

const WINDOW_MS = 60_000;
const HISTORY_LIMIT_PER_MIN = parsePositiveInt(process.env.HISTORY_LIMIT_PER_MIN, 120);
const ADMIN_LIMIT_PER_MIN = parsePositiveInt(process.env.ADMIN_LIMIT_PER_MIN, 10);
const VOTE_LIMIT_PER_MIN = parsePositiveInt(process.env.VOTE_LIMIT_PER_MIN, 240);
const MAX_WS_GLOBAL = parsePositiveInt(process.env.MAX_WS_GLOBAL, 100_000);
const MAX_WS_PER_IP = parsePositiveInt(process.env.MAX_WS_PER_IP, 8);
const MAX_WS_NEW_PER_SEC = parsePositiveInt(process.env.MAX_WS_NEW_PER_SEC, 50);
let wsNewConnections = 0;
let wsNewConnectionsResetAt = Date.now() + 1000;

const MAX_HISTORY_PAGE = parsePositiveInt(process.env.MAX_HISTORY_PAGE, 100_000);
const MAX_HISTORY_LIMIT = parsePositiveInt(process.env.MAX_HISTORY_LIMIT, 50);
const HISTORY_CACHE_TTL_MS = parsePositiveInt(process.env.HISTORY_CACHE_TTL_MS, 5000);
const MAX_HISTORY_CACHE_KEYS = parsePositiveInt(process.env.MAX_HISTORY_CACHE_KEYS, 500);
const VIEWER_VOTE_BROADCAST_DEBOUNCE_MS = parsePositiveInt(
  process.env.VIEWER_VOTE_BROADCAST_DEBOUNCE_MS,
  250,
);

const ADMIN_COOKIE = "bruhhelp_admin";
const ADMIN_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const requestWindows = new Map<string, number[]>();
const wsByIp = new Map<string, number>();
const historyCache = new Map<string, { body: string; expiresAt: number }>();
let lastRateWindowSweep = 0;
let lastHistoryCacheSweep = 0;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isPrivateIp(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (v4 === "127.0.0.1" || ip === "::1") return true;
  if (v4.startsWith("10.")) return true;
  if (v4.startsWith("192.168.")) return true;
  if (v4.startsWith("172.")) {
    const second = Number.parseInt(v4.split(".")[1] ?? "", 10);
    if (second >= 16 && second <= 31) return true;
  }
  if (v4.startsWith("100.")) {
    const second = Number.parseInt(v4.split(".")[1] ?? "", 10);
    if (second >= 64 && second <= 127) return true;
  }
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
  return false;
}

function getClientIp(req: Request, server: Bun.Server<WsData>): string {
  const socketIp = server.requestIP(req)?.address ?? "unknown";

  if (socketIp !== "unknown" && isPrivateIp(socketIp)) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const rightmost = xff.split(",").at(-1)?.trim();
      if (rightmost && !isPrivateIp(rightmost)) {
        return rightmost.startsWith("::ffff:") ? rightmost.slice(7) : rightmost;
      }
    }
  }

  return socketIp.startsWith("::ffff:") ? socketIp.slice(7) : socketIp;
}

function isRateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  if (now - lastRateWindowSweep >= windowMs) {
    for (const [bucketKey, timestamps] of requestWindows) {
      const recent = timestamps.filter((timestamp) => now - timestamp <= windowMs);
      if (recent.length === 0) {
        requestWindows.delete(bucketKey);
      } else {
        requestWindows.set(bucketKey, recent);
      }
    }
    lastRateWindowSweep = now;
  }

  const existing = requestWindows.get(key) ?? [];
  const recent = existing.filter((timestamp) => now - timestamp <= windowMs);
  if (recent.length >= limit) {
    requestWindows.set(key, recent);
    return true;
  }
  recent.push(now);
  requestWindows.set(key, recent);
  return false;
}

function secureCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function parseCookies(req: Request): Record<string, string> {
  const cookieHeader = req.headers.get("cookie");
  if (!cookieHeader) return {};

  const cookies: Record<string, string> = {};
  for (const pair of cookieHeader.split(";")) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(val);
    } catch {
      cookies[key] = val;
    }
  }
  return cookies;
}

function buildAdminCookie(passcode: string, isSecure: boolean, maxAgeSeconds = ADMIN_COOKIE_MAX_AGE_SECONDS) {
  const parts = [
    `${ADMIN_COOKIE}=${encodeURIComponent(passcode)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isSecure) parts.push("Secure");
  return parts.join("; ");
}

function clearAdminCookie(isSecure: boolean) {
  return buildAdminCookie("", isSecure, 0);
}

function getProvidedAdminSecret(req: Request, url: URL): string {
  const viaHeaderOrQuery = req.headers.get("x-admin-secret") ?? url.searchParams.get("secret");
  if (viaHeaderOrQuery) return viaHeaderOrQuery;
  const cookies = parseCookies(req);
  return cookies[ADMIN_COOKIE] ?? "";
}

function isAdminAuthorized(req: Request, url: URL): boolean {
  const expected = process.env.ADMIN_SECRET;
  if (!expected) return false;
  const provided = getProvidedAdminSecret(req, url);
  if (!provided) return false;
  return secureCompare(provided, expected);
}

function decrementIpConnection(ip: string) {
  const current = wsByIp.get(ip) ?? 0;
  if (current <= 1) {
    wsByIp.delete(ip);
  } else {
    wsByIp.set(ip, current - 1);
  }
}

function setHistoryCache(key: string, body: string, expiresAt: number) {
  if (historyCache.size >= MAX_HISTORY_CACHE_KEYS) {
    const firstKey = historyCache.keys().next().value;
    if (firstKey) historyCache.delete(firstKey);
  }
  historyCache.set(key, { body, expiresAt });
}

// WebSocket clients + voting

const clients = new Set<ServerWebSocket<WsData>>();
const viewerVoters = new Map<string, ViewerVoteSide>();
let viewerVoteBroadcastTimer: ReturnType<typeof setTimeout> | null = null;

function getClientState() {
  return {
    active: gameState.active,
    lastCompleted: gameState.completed.at(-1) ?? null,
    scores: gameState.scores,
    viewerScores: gameState.viewerScores,
    languageScores: gameState.languageScores,
    done: gameState.done,
    isPaused: gameState.isPaused,
    generation: gameState.generation,
    roundDelayMs: gameState.roundDelayMs,
    nextRoundAt: gameState.nextRoundAt,
  };
}

function broadcast() {
  const payload = JSON.stringify({
    type: "state",
    data: getClientState(),
    totalRounds: runs,
    viewerCount: clients.size,
    version: VERSION,
  });

  for (const ws of clients) {
    ws.send(payload);
  }
}

let viewerCountTimer: ReturnType<typeof setTimeout> | null = null;
function broadcastViewerCount() {
  if (viewerCountTimer) return;
  viewerCountTimer = setTimeout(() => {
    viewerCountTimer = null;
    const payload = JSON.stringify({ type: "viewerCount", viewerCount: clients.size });
    for (const ws of clients) {
      ws.send(payload);
    }
  }, 10_000);
}

function scheduleViewerVoteBroadcast() {
  if (viewerVoteBroadcastTimer) return;
  viewerVoteBroadcastTimer = setTimeout(() => {
    viewerVoteBroadcastTimer = null;
    broadcast();
  }, VIEWER_VOTE_BROADCAST_DEBOUNCE_MS);
}

function applyViewerVote(voterId: string, side: ViewerVoteSide): boolean {
  const round = gameState.active;
  if (!round || round.phase !== "voting") return false;
  if (!round.viewerVotingEndsAt || Date.now() > round.viewerVotingEndsAt) return false;

  const previousVote = viewerVoters.get(voterId);
  if (previousVote === side) return false;

  if (previousVote === "A") {
    round.viewerVotesA = Math.max(0, (round.viewerVotesA ?? 0) - 1);
  } else if (previousVote === "B") {
    round.viewerVotesB = Math.max(0, (round.viewerVotesB ?? 0) - 1);
  }

  viewerVoters.set(voterId, side);
  if (side === "A") {
    round.viewerVotesA = (round.viewerVotesA ?? 0) + 1;
  } else {
    round.viewerVotesB = (round.viewerVotesB ?? 0) + 1;
  }

  return true;
}

async function getAdminSnapshot() {
  return {
    isPaused: gameState.isPaused,
    isRunningRound: Boolean(gameState.active),
    done: gameState.done,
    completedInMemory: gameState.completed.length,
    persistedRounds: await countRounds(),
    viewerCount: clients.size,
    questionDifficulty: getQuestionDifficulty(),
    roundDelayMs: gameState.roundDelayMs,
  };
}

// Server

const port = Number.parseInt(process.env.PORT ?? "5109", 10);

const server = Bun.serve<WsData>({
  port,
  routes: {
    "/": indexHtml,
    "/history": historyHtml,
    "/admin": adminHtml,
    "/broadcast": broadcastHtml,
  },
  async fetch(req, server) {
    const url = new URL(req.url);
    const ip = getClientIp(req, server);

    if (url.pathname.startsWith("/assets/")) {
      const file = Bun.file(`./public${url.pathname}`);
      return new Response(file, {
        headers: {
          "Cache-Control": "public, max-age=604800, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }

    if (url.pathname === "/api/vote") {
      if (req.method !== "POST") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "POST" },
        });
      }
      if (isRateLimited(`vote:${ip}`, VOTE_LIMIT_PER_MIN, WINDOW_MS)) {
        return new Response("Too Many Requests", { status: 429 });
      }

      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return new Response("Invalid JSON body", { status: 400 });
      }

      const record = body as Record<string, unknown>;
      const voterId = String(record.voterId ?? "").trim();
      const side = String(record.side ?? "").trim().toUpperCase();
      if (!voterId || voterId.length > 128) {
        return new Response("Invalid voterId", { status: 400 });
      }
      if (side !== "A" && side !== "B") {
        return new Response("Invalid side", { status: 400 });
      }

      const applied = applyViewerVote(voterId, side as ViewerVoteSide);
      if (applied) scheduleViewerVoteBroadcast();

      return new Response(
        JSON.stringify({
          ok: true,
          applied,
          viewerVotesA: gameState.active?.viewerVotesA ?? 0,
          viewerVotesB: gameState.active?.viewerVotesB ?? 0,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        },
      );
    }

    if (url.pathname === "/api/admin/login") {
      if (req.method !== "POST") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "POST" },
        });
      }
      if (isRateLimited(`admin:${ip}`, ADMIN_LIMIT_PER_MIN, WINDOW_MS)) {
        return new Response("Too Many Requests", { status: 429 });
      }

      const expected = process.env.ADMIN_SECRET;
      if (!expected) return new Response("ADMIN_SECRET is not configured", { status: 503 });

      let passcode = "";
      try {
        const body = (await req.json()) as Record<string, unknown>;
        passcode = String(body.passcode ?? "");
      } catch {
        return new Response("Invalid JSON body", { status: 400 });
      }

      if (!passcode || !secureCompare(passcode, expected)) {
        return new Response("Invalid passcode", { status: 401 });
      }

      const isSecure = url.protocol === "https:";
      return new Response(JSON.stringify({ ok: true, ...await getAdminSnapshot() }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": buildAdminCookie(passcode, isSecure),
          "Cache-Control": "no-store",
        },
      });
    }

    if (url.pathname === "/api/admin/logout") {
      if (req.method !== "POST") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "POST" },
        });
      }
      const isSecure = url.protocol === "https:";
      return new Response(null, {
        status: 204,
        headers: {
          "Set-Cookie": clearAdminCookie(isSecure),
          "Cache-Control": "no-store",
        },
      });
    }

    if (url.pathname === "/api/admin/status") {
      if (isRateLimited(`admin:${ip}`, ADMIN_LIMIT_PER_MIN, WINDOW_MS)) {
        return new Response("Too Many Requests", { status: 429 });
      }
      if (!isAdminAuthorized(req, url)) {
        return new Response("Unauthorized", { status: 401 });
      }
      return new Response(JSON.stringify({ ok: true, ...await getAdminSnapshot() }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    }

    if (url.pathname === "/api/admin/export") {
      if (req.method !== "GET") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "GET" },
        });
      }
      if (isRateLimited(`admin:${ip}`, ADMIN_LIMIT_PER_MIN, WINDOW_MS)) {
        return new Response("Too Many Requests", { status: 429 });
      }
      if (!isAdminAuthorized(req, url)) {
        return new Response("Unauthorized", { status: 401 });
      }

      const payload = {
        exportedAt: new Date().toISOString(),
        rounds: getAllRounds(),
        state: gameState,
      };

      return new Response(JSON.stringify(payload, null, 2), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="bruh-help-export-${Date.now()}.json"`,
        },
      });
    }

    if (url.pathname === "/api/admin/reset") {
      if (req.method !== "POST") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "POST" },
        });
      }
      if (isRateLimited(`admin:${ip}`, ADMIN_LIMIT_PER_MIN, WINDOW_MS)) {
        return new Response("Too Many Requests", { status: 429 });
      }
      if (!isAdminAuthorized(req, url)) {
        return new Response("Unauthorized", { status: 401 });
      }

      let confirm = "";
      try {
        const body = (await req.json()) as Record<string, unknown>;
        confirm = String(body.confirm ?? "");
      } catch {
        return new Response("Invalid JSON body", { status: 400 });
      }

      if (confirm !== "RESET") {
        return new Response("Confirmation token must be RESET", { status: 400 });
      }

      await clearAllRounds();
      historyCache.clear();
      gameState.completed = [];
      gameState.active = null;
      gameState.scores = createBlankScores();
      gameState.viewerScores = createBlankScores();
      gameState.judgeScores = createBlankJudgeScores();
      gameState.judgeRounds = createBlankJudgeScores();
      gameState.languageScores = createEmptyLanguageScores();
      gameState.done = false;
      gameState.isPaused = true;
      gameState.generation += 1;
      viewerVoters.clear();
      resetExternalStateAfterAdminReset();
      broadcast();

      return new Response(JSON.stringify({ ok: true, ...await getAdminSnapshot() }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    }

    if (
      url.pathname === "/api/pause" ||
      url.pathname === "/api/resume" ||
      url.pathname === "/api/admin/pause" ||
      url.pathname === "/api/admin/resume"
    ) {
      if (req.method !== "POST") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "POST" },
        });
      }
      if (isRateLimited(`admin:${ip}`, ADMIN_LIMIT_PER_MIN, WINDOW_MS)) {
        return new Response("Too Many Requests", { status: 429 });
      }
      if (!isAdminAuthorized(req, url)) {
        return new Response("Unauthorized", { status: 401 });
      }

      if (url.pathname.endsWith("/pause")) {
        gameState.isPaused = true;
      } else {
        gameState.isPaused = false;
      }
      broadcast();

      const action = url.pathname.endsWith("/pause") ? "Paused" : "Resumed";
      if (url.pathname === "/api/pause" || url.pathname === "/api/resume") {
        return new Response(action, { status: 200 });
      }

      return new Response(JSON.stringify({ ok: true, action, ...await getAdminSnapshot() }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    }

    if (url.pathname === "/api/admin/difficulty") {
      if (req.method !== "POST") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "POST" },
        });
      }
      if (isRateLimited(`admin:${ip}`, ADMIN_LIMIT_PER_MIN, WINDOW_MS)) {
        return new Response("Too Many Requests", { status: 429 });
      }
      if (!isAdminAuthorized(req, url)) {
        return new Response("Unauthorized", { status: 401 });
      }

      let difficulty: QuestionDifficulty;
      try {
        const body = (await req.json()) as Record<string, unknown>;
        const d = String(body.difficulty ?? "");
        if (d !== "easy" && d !== "medium" && d !== "hard") {
          return new Response('difficulty must be "easy", "medium", or "hard"', { status: 400 });
        }
        difficulty = d;
      } catch {
        return new Response("Invalid JSON body", { status: 400 });
      }

      setQuestionDifficulty(difficulty);
      log("INFO", "admin", "Question difficulty changed", { difficulty });

      return new Response(JSON.stringify({ ok: true, difficulty, ...await getAdminSnapshot() }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    }

    if (url.pathname === "/api/admin/delay") {
      if (req.method !== "POST") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "POST" },
        });
      }
      if (isRateLimited(`admin:${ip}`, ADMIN_LIMIT_PER_MIN, WINDOW_MS)) {
        return new Response("Too Many Requests", { status: 429 });
      }
      if (!isAdminAuthorized(req, url)) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        const body = (await req.json()) as Record<string, unknown>;
        const ms = Number(body.delayMs);
        if (!Number.isFinite(ms) || ms < 0 || ms > 600_000) {
          return new Response("delayMs must be 0-600000", { status: 400 });
        }
        gameState.roundDelayMs = ms;
        log("INFO", "admin", "Round delay changed", { delayMs: ms });

        return new Response(JSON.stringify({ ok: true, ...await getAdminSnapshot() }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        });
      } catch {
        return new Response("Invalid JSON body", { status: 400 });
      }
    }

    if (url.pathname === "/api/history/languages") {
      if (isRateLimited(`history:${ip}`, HISTORY_LIMIT_PER_MIN, WINDOW_MS)) {
        return new Response("Too Many Requests", { status: 429 });
      }
      const languages = await getAvailableLanguages();
      return new Response(JSON.stringify({ languages }), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=30, stale-while-revalidate=60",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    if (url.pathname === "/api/history") {
      if (isRateLimited(`history:${ip}`, HISTORY_LIMIT_PER_MIN, WINDOW_MS)) {
        return new Response("Too Many Requests", { status: 429 });
      }

      const rawPage = Number.parseInt(url.searchParams.get("page") || "1", 10);
      const rawLimit = Number.parseInt(url.searchParams.get("limit") || "10", 10);
      const language = url.searchParams.get("language")?.trim().toLowerCase() || undefined;
      const page = Number.isFinite(rawPage)
        ? Math.min(Math.max(rawPage, 1), MAX_HISTORY_PAGE)
        : 1;
      const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(rawLimit, 1), MAX_HISTORY_LIMIT)
        : 10;
      const cacheKey = `${page}:${limit}:${language ?? "all"}`;

      const now = Date.now();
      if (now - lastHistoryCacheSweep >= HISTORY_CACHE_TTL_MS) {
        for (const [key, value] of historyCache) {
          if (value.expiresAt <= now) {
            historyCache.delete(key);
          }
        }
        lastHistoryCacheSweep = now;
      }

      const cached = historyCache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        return new Response(cached.body, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=5, stale-while-revalidate=30",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      const body = JSON.stringify(await getRounds(page, limit, language));
      setHistoryCache(cacheKey, body, now + HISTORY_CACHE_TTL_MS);

      return new Response(body, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=5, stale-while-revalidate=30",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    if (url.pathname === "/ws") {
      if (req.method !== "GET") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "GET" },
        });
      }

      const now = Date.now();
      if (now >= wsNewConnectionsResetAt) {
        wsNewConnections = 0;
        wsNewConnectionsResetAt = now + 1000;
      }
      if (wsNewConnections >= MAX_WS_NEW_PER_SEC) {
        return new Response("Too Many Requests", { status: 429 });
      }

      if (clients.size >= MAX_WS_GLOBAL) {
        return new Response("Service Unavailable", { status: 503 });
      }
      const existingForIp = wsByIp.get(ip) ?? 0;
      if (existingForIp >= MAX_WS_PER_IP) {
        return new Response("Too Many Requests", { status: 429 });
      }

      const upgraded = server.upgrade(req, { data: { ip } });
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      wsNewConnections += 1;
      return undefined;
    }

    return new Response("Not found", { status: 404 });
  },
  websocket: {
    data: {} as WsData,
    open(ws) {
      clients.add(ws);
      wsByIp.set(ws.data.ip, (wsByIp.get(ws.data.ip) ?? 0) + 1);

      ws.send(
        JSON.stringify({
          type: "state",
          data: getClientState(),
          totalRounds: runs,
          viewerCount: clients.size,
          version: VERSION,
        }),
      );

      broadcastViewerCount();
    },
    message() {
      // Input handled via HTTP voting endpoints.
    },
    close(ws) {
      clients.delete(ws);
      decrementIpConnection(ws.data.ip);
      broadcastViewerCount();
    },
  },
  development:
    process.env.NODE_ENV === "production"
      ? false
      : {
          hmr: true,
          console: true,
        },
  error(error) {
    log("ERROR", "server", "Unhandled server error", {
      message: error.message,
      stack: error.stack,
    });
    return new Response("Internal Server Error", { status: 500 });
  },
});

console.log(`\nbruh.help Web -> http://localhost:${server.port}`);
console.log(`WebSocket -> ws://localhost:${server.port}/ws`);
console.log(`AI Provider -> ${ACTIVE_AI_PROVIDER}`);
console.log(`Rounds -> ${runs === Infinity ? "infinite" : runs}`);
console.log(`Models -> ${ALL_MODELS.map((m: { name: string }) => m.name).join(", ")}`);

log("INFO", "server", "bruh.help server started", {
  port: server.port,
  runs: Number.isFinite(runs) ? runs : "infinite",
  provider: ACTIVE_AI_PROVIDER,
  models: ALL_MODELS.map((m: { id: string }) => m.id),
});

runGame(runs, gameState, broadcast, (_round) => {
  viewerVoters.clear();
}).then(() => {
  console.log(`\nGame complete. Log: ${LOG_FILE}`);
});
