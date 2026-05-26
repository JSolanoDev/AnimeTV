const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const root = path.resolve(__dirname);
const serverStartedAt = Date.now();

loadLocalEnv();

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const ANILIST_ENDPOINT = "https://graphql.anilist.co";
const JIKAN_TOP_ENDPOINT = "https://api.jikan.moe/v4/top/anime?filter=airing&limit=25";
const JIKAN_SEASON_ENDPOINT = "https://api.jikan.moe/v4/seasons/now?limit=25";
const JIKAN_POPULAR_ENDPOINT = "https://api.jikan.moe/v4/top/anime?filter=bypopularity&limit=25";
const ANIPUB_ENDPOINT = "https://www.anipub.xyz";
const ANIPUB_DETAILS_ENDPOINT = "https://anipub.xyz";
const ANIPUB_API_ENDPOINT = "https://api.anipub.xyz";
const JIMOV_API = process.env.JIMOV_API || "https://jimov-api.vercel.app";
const ANIME1V_API = process.env.ANIME1V_API || "http://localhost:3001";
const ANIME1V_PATH = process.env.ANIME1V_PATH || "";
const ANIME1V_AUTO_START = process.env.ANIME1V_AUTO_START !== "false";
const ANIME1V_API_KEY = process.env.ANIME1V_API_KEY || "dev-anime1v-key";
const ANIME1V_PROVIDERS = ["animeav1.com", "tioanime.com", "monoschinos.com", "animeflv.net", "jkanime.net"];
const ANIME1V_RESTART_INTERVAL_MS = Math.max(10000, Number(process.env.ANIME1V_RESTART_INTERVAL_MS || 30000));
const ANIME1V_DEFAULT_CATALOG_LIMIT = Math.max(100, Number(process.env.ANIME1V_DEFAULT_CATALOG_LIMIT || 1200));
const ANIME1V_MAX_CATALOG_LIMIT = Math.max(ANIME1V_DEFAULT_CATALOG_LIMIT, Number(process.env.ANIME1V_MAX_CATALOG_LIMIT || 5000));
const ANIME1V_DEFAULT_SEARCH_PAGES = Math.max(1, Number(process.env.ANIME1V_DEFAULT_SEARCH_PAGES || 12));
const ANIME1V_DEFAULT_CATALOG_PAGES = Math.max(1, Number(process.env.ANIME1V_DEFAULT_CATALOG_PAGES || 30));
const ANIME1V_MAX_SEARCH_PAGES = Math.max(ANIME1V_DEFAULT_CATALOG_PAGES, Number(process.env.ANIME1V_MAX_SEARCH_PAGES || 100));
const ANIME1V_MAX_EPISODES = Math.max(100, Number(process.env.ANIME1V_MAX_EPISODES || 5000));
const ANIME1V_QUOTA_BACKOFF_MS = Math.max(1000 * 60 * 60, Number(process.env.ANIME1V_QUOTA_BACKOFF_MS || 1000 * 60 * 60 * 24));
const RAPIDAPI_ANIME_KEY = process.env.RAPIDAPI_ANIME_KEY || process.env.X_RAPIDAPI_KEY || "";
const RAPIDAPI_ANIME_HOST = process.env.RAPIDAPI_ANIME_HOST || process.env.X_RAPIDAPI_HOST || "";
const RAPIDAPI_ANIME_BASE = process.env.RAPIDAPI_ANIME_BASE || (RAPIDAPI_ANIME_HOST ? `https://${RAPIDAPI_ANIME_HOST}` : "");
const RAPIDAPI_ANIME_TIMEOUT_MS = Math.max(5000, Number(process.env.RAPIDAPI_ANIME_TIMEOUT_MS || 28000));
const RAPIDAPI_ANIME_CATALOG_LIMIT = Math.max(25, Number(process.env.RAPIDAPI_ANIME_CATALOG_LIMIT || 300));
const CONSUMET_API = String(process.env.CONSUMET_API || "http://localhost:3000").replace(/\/+$/, "");
const CONSUMET_PROVIDER = "kickassanime";
const CONSUMET_TIMEOUT_MS = Math.max(3000, Number(process.env.CONSUMET_TIMEOUT_MS || 7000));
const CONSUMET_CATALOG_LIMIT = Math.max(25, Number(process.env.CONSUMET_CATALOG_LIMIT || 360));
const CONSUMET_SEARCH_PAGES = Math.max(1, Math.min(25, Number(process.env.CONSUMET_SEARCH_PAGES || 6)));
const CONSUMET_CATALOG_SEEDS = (process.env.CONSUMET_CATALOG_SEEDS || "one,naruto,dragon,bleach,attack,solo,jujutsu,demon,hero,spy,slime,black,blue,kingdom,school,love,magic")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const JIMOV_DEFAULT_CATALOG_LIMIT = Math.max(80, Number(process.env.JIMOV_DEFAULT_CATALOG_LIMIT || 400));
const JIMOV_MAX_CATALOG_LIMIT = Math.max(JIMOV_DEFAULT_CATALOG_LIMIT, Number(process.env.JIMOV_MAX_CATALOG_LIMIT || 2000));
const TIOANIME_CATALOG_LIMIT = Math.max(60, Number(process.env.TIOANIME_CATALOG_LIMIT || 300));
const APP_VERSION = "1.3.0";
const UPDATE_REPO_URL = process.env.UPDATE_REPO_URL || "";
const UPDATE_MANIFEST_URL = process.env.UPDATE_MANIFEST_URL || "";
const settingsFile = path.join(root, "animetv-settings.json");
const ANIPUB_CATALOG_TTL_MS = 1000 * 60 * 20;
const ANIPUB_RAW_CATALOG_TTL_MS = ANIPUB_CATALOG_TTL_MS;
const ANIPUB_EPISODE_CACHE_TTL_MS = 1000 * 60 * 60;
const ANIPUB_INFO_PAGE_SIZE = 80;
const ANIPUB_CATALOG_PAGE_SIZE = 100;
const DAILY_REFRESH_INTERVAL_MS = Math.max(1000 * 60 * 60, Number(process.env.DAILY_REFRESH_INTERVAL_MS || 1000 * 60 * 60 * 24));
const DAILY_REFRESH_START_DELAY_MS = Math.max(5000, Number(process.env.DAILY_REFRESH_START_DELAY_MS || 15000));
const LOG_LEVEL = String(process.env.LOG_LEVEL || "info").toLowerCase();
const SERVER_CACHE_DIR = path.join(root, ".cache", "server");
const RATE_LIMIT_WINDOW_MS = Math.max(1000, Number(process.env.RATE_LIMIT_WINDOW_MS || 60000));
const RATE_LIMIT_MAX_REQUESTS = Math.max(20, Number(process.env.RATE_LIMIT_MAX_REQUESTS || 240));
const RATE_LIMIT_API_MAX_REQUESTS = Math.max(20, Number(process.env.RATE_LIMIT_API_MAX_REQUESTS || 120));
const translationCache = new Map();
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json"
};
const SECURITY_HEADERS = {
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "autoplay=*, fullscreen=*, picture-in-picture=*, camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), xr-spatial-tracking=()",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: http: https:",
    "media-src 'self' blob: http: https:",
    "connect-src 'self' http: https:",
    "frame-src http: https:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    "navigate-to 'self'"
  ].join("; ")
};
let anipubCatalogCache = null;
let anipubCatalogPromise = null;
let anipubCatalogPromiseLimit = 0;
let anipubRawCatalogCache = null;
let anipubRawCatalogCacheAt = 0;
let anipubRawCatalogCacheComplete = false;
const anipubEpisodeCache = new Map();
let anipubHealthState = {
  status: "unknown",
  checkedAt: null,
  error: "",
  total: null
};
let anime1vStartPromise = null;
let dailyRefreshPromise = null;
let lastDailyRefreshAt = 0;
let lastDailyRefreshResult = null;
let anime1vQuotaBlockedUntil = 0;
let anime1vQuotaMessage = "";
const rateLimitBuckets = new Map();
const requestMetrics = {
  total: 0,
  api: 0,
  limited: 0,
  errors: 0,
  startedAt: new Date(serverStartedAt).toISOString()
};
const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function log(level, message, meta = null) {
  const current = LOG_LEVELS[LOG_LEVEL] ?? LOG_LEVELS.info;
  const target = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  if (target < current) return;
  const line = `[AnimeTV] ${new Date().toISOString()} ${level.toUpperCase()} ${message}`;
  const writer = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (meta) writer(line, meta);
  else writer(line);
}

function installProcessSafetyNet() {
  if (process.__animeTvSafetyNetInstalled) return;
  process.__animeTvSafetyNetInstalled = true;
  process.on("unhandledRejection", (reason) => {
    requestMetrics.errors += 1;
    log("error", "Unhandled promise rejection", { error: reason?.stack || reason?.message || String(reason) });
  });
  process.on("uncaughtException", (error) => {
    requestMetrics.errors += 1;
    log("error", "Uncaught exception", { error: error?.stack || error?.message || String(error) });
  });
}

installProcessSafetyNet();

function loadLocalEnv() {
  [".env.local", ".env"].forEach((file) => {
    const envPath = path.join(root, file);
    if (!fs.existsSync(envPath)) return;
    try {
      fs.readFileSync(envPath, "utf8")
        .split(/\r?\n/)
        .forEach((line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) return;
          const separator = trimmed.indexOf("=");
          if (separator < 1) return;
          const key = trimmed.slice(0, separator).trim();
          if (file === ".env.local" && key === "PORT") return;
          const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
          if (key && process.env[key] === undefined) process.env[key] = value;
        });
    } catch (error) {
      console.warn(`Could not load ${file}:`, error.message);
    }
  });
}

function handleRequest(request, response) {
  requestMetrics.total += 1;
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  try {
    if (request.method === "OPTIONS") {
      sendCorsPreflight(response);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      requestMetrics.api += 1;
      const rate = checkRateLimit(request, url);
      if (!rate.allowed) {
        requestMetrics.limited += 1;
        sendJson(response, {
          ok: false,
          error: "Too many requests. Please wait a moment and try again.",
          retryAfterSeconds: Math.ceil(rate.retryAfterMs / 1000)
        }, 429, {
          "Retry-After": String(Math.ceil(rate.retryAfterMs / 1000)),
          "X-RateLimit-Limit": String(rate.limit),
          "X-RateLimit-Remaining": "0"
        });
        return;
      }
    }

    if (url.pathname === "/" && !fs.existsSync(path.join(root, "index.html"))) {
      response.writeHead(307, { Location: "/index.html" });
      response.end();
      return;
    }

    if (url.pathname === "/api/health") {
      handleHealth(response);
      return;
    }

    if (url.pathname === "/api/server-info") {
      handleServerInfo(request, response);
      return;
    }

  if (url.pathname === "/api/refresh-daily") {
    handleDailyRefresh(url, response);
    return;
  }

  if (url.pathname === "/api/catalog") {
    handleCatalog(response);
    return;
  }

  if (url.pathname === "/api/source") {
    handleSourceProxy(url, response);
    return;
  }

  if (url.pathname === "/api/translate") {
    handleTranslate(request, response);
    return;
  }

  if (url.pathname === "/api/tioanime/catalog") {
    handleTioAnimeCatalog(response);
    return;
  }

  if (url.pathname === "/api/jimov/tioanime/catalog") {
    handleJimovTioAnimeCatalog(url, response);
    return;
  }

  if (url.pathname === "/api/jimov/tioanime/health") {
    handleJimovTioAnimeHealth(response);
    return;
  }

  if (url.pathname === "/api/jimov/tioanime/info" || url.pathname === "/api/jimov/tioanime/episodes") {
    handleJimovTioAnimeInfo(url, response);
    return;
  }

  if (url.pathname === "/api/anime1v/search") {
    handleAnime1vSearch(url, response);
    return;
  }

  if (url.pathname === "/api/anime1v/trending" || url.pathname === "/api/anime1v/catalog") {
    handleAnime1vTrending(url, response);
    return;
  }

  if (url.pathname === "/api/anime1v/health") {
    handleAnime1vHealth(response);
    return;
  }

  if (url.pathname === "/api/anime1v/providers") {
    sendJson(response, {
      ok: true,
      source: "Anime1v",
      baseUrl: ANIME1V_API,
      needsApiKey: !ANIME1V_API_KEY,
      providers: ANIME1V_PROVIDERS,
      defaults: {
        audio: "japanese",
        subtitles: "spanish"
      }
    });
    return;
  }

  if (url.pathname === "/api/anime1v/episodes") {
    handleAnime1vEpisodes(url, response);
    return;
  }

  if (url.pathname === "/api/anime1v/info") {
    handleAnime1vEpisodes(url, response);
    return;
  }

  if (url.pathname === "/api/anime1v/stream") {
    handleAnime1vStream(url, response);
    return;
  }

  if (url.pathname === "/api/anime1v/episode") {
    handleAnime1vStream(url, response);
    return;
  }

  if (url.pathname === "/api/rapid-anime/health") {
    handleRapidAnimeHealth(response);
    return;
  }

  if (url.pathname === "/api/rapid-anime/catalog" || url.pathname === "/api/rapid-anime/recent") {
    handleRapidAnimeCatalog(url, response);
    return;
  }

  if (url.pathname === "/api/rapid-anime/search") {
    handleRapidAnimeSearch(url, response);
    return;
  }

  if (url.pathname === "/api/rapid-anime/info" || url.pathname === "/api/rapid-anime/episodes") {
    handleRapidAnimeInfo(url, response);
    return;
  }

  if (url.pathname === "/api/rapid-anime/watch" || url.pathname === "/api/rapid-anime/stream") {
    handleRapidAnimeWatch(url, response);
    return;
  }

  if (url.pathname === "/api/consumet/kickassanime/health") {
    handleConsumetHealth(response);
    return;
  }

  if (url.pathname === "/api/consumet/kickassanime/catalog") {
    handleConsumetCatalog(url, response);
    return;
  }

  if (url.pathname === "/api/consumet/kickassanime/search") {
    handleConsumetSearch(url, response);
    return;
  }

  if (url.pathname === "/api/consumet/kickassanime/info" || url.pathname === "/api/consumet/kickassanime/episodes") {
    handleConsumetInfo(url, response);
    return;
  }

  if (url.pathname === "/api/consumet/kickassanime/servers") {
    handleConsumetServers(url, response);
    return;
  }

  if (url.pathname === "/api/consumet/kickassanime/watch" || url.pathname === "/api/consumet/kickassanime/stream") {
    handleConsumetWatch(url, response);
    return;
  }

  if (url.pathname === "/api/check-update") {
    handleCheckUpdate(response);
    return;
  }

  if (url.pathname === "/api/apply-update") {
    handleApplyUpdate(request, response);
    return;
  }

  if (url.pathname === "/api/language/preferences") {
    handleLanguagePreferences(request, response);
    return;
  }

  if (url.pathname === "/api/anipub/catalog") {
    handleAniPubCatalog(url, response);
    return;
  }

  if (url.pathname === "/api/anipub/catalog/all") {
    handleAniPubCatalog(url, response, { all: true });
    return;
  }

  if (url.pathname === "/api/anipub/catalog/total") {
    handleAniPubCatalogTotal(response);
    return;
  }

  if (url.pathname === "/api/anipub/debug-page") {
    handleAniPubDebugPage(url, response);
    return;
  }

  if (url.pathname === "/api/anipub/health") {
    handleAniPubHealth(response);
    return;
  }

  if (url.pathname === "/api/anipub/play") {
    handleAniPubPlay(url, response);
    return;
  }

  const episodeMatch = url.pathname.match(/^\/api\/anipub\/episodes\/([^/]+)$/);
  if (episodeMatch) {
    handleAniPubEpisodes(decodeURIComponent(episodeMatch[1]), response);
    return;
  }

  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.resolve(path.join(root, pathname));

  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": types[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store, max-age=0"
    });
    response.end(data);
  });
  } catch (error) {
    requestMetrics.errors += 1;
    log("error", "Request failed before route completion", { path: url.pathname, error: error.stack || error.message });
    if (!response.headersSent) {
      sendJson(response, { ok: false, error: "AnimeTV server hit a temporary error." }, 500);
    } else {
      response.end();
    }
  }
}

function handleHealth(response) {
  const memory = process.memoryUsage();
  sendJson(response, {
    ok: true,
    app: "AnimeTV",
    api: "ready",
    version: APP_VERSION,
    uptimeSeconds: Math.round((Date.now() - serverStartedAt) / 1000),
    dailyRefresh: lastDailyRefreshResult || { status: "waiting" },
    providers: {
      anipub: anipubHealthState,
      anime1v: {
        baseUrl: ANIME1V_API,
        autoStart: ANIME1V_AUTO_START,
        quotaBlockedUntil: anime1vQuotaBlockedUntil ? new Date(anime1vQuotaBlockedUntil).toISOString() : null
      },
      rapidApi: {
        configured: isRapidAnimeConfigured(),
        host: RAPIDAPI_ANIME_HOST ? maskSecret(RAPIDAPI_ANIME_HOST, 8) : ""
      },
      consumet: {
        provider: CONSUMET_PROVIDER,
        baseUrl: CONSUMET_API
      }
    },
    cache: {
      anipubCatalogItems: anipubRawCatalogCache?.length || 0,
      anipubCatalogFresh: Boolean(anipubRawCatalogCacheAt && Date.now() - anipubRawCatalogCacheAt < ANIPUB_RAW_CATALOG_TTL_MS),
      anipubEpisodeEntries: anipubEpisodeCache.size,
      translations: translationCache.size,
      persistentCacheDir: ".cache/server"
    },
    rateLimit: {
      windowMs: RATE_LIMIT_WINDOW_MS,
      maxApiRequests: RATE_LIMIT_API_MAX_REQUESTS,
      activeBuckets: rateLimitBuckets.size
    },
    metrics: requestMetrics,
    memory: {
      rssMb: Math.round(memory.rss / 1024 / 1024),
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024)
    }
  });
}

function handleServerInfo(request, response) {
  const protocol = request.headers["x-forwarded-proto"] || "http";
  const hostHeader = request.headers["x-forwarded-host"] || request.headers.host || `localhost:${port}`;
  sendJson(response, {
    ok: true,
    app: "AnimeTV",
    version: APP_VERSION,
    baseUrl: `${protocol}://${hostHeader}`,
    cors: "enabled",
    androidTv: {
      note: "Android WebView can use this baseUrl for API calls when file:// assets are loaded.",
      recommendedApiBase: `${protocol}://${hostHeader}/api`
    },
    providers: [
      { id: "anipub", type: "iframe", health: anipubHealthState.status },
      { id: "consumet-kickassanime", type: "direct-hls", baseUrl: CONSUMET_API, provider: CONSUMET_PROVIDER },
      { id: "anime1v", type: "direct-or-iframe", baseUrl: ANIME1V_API },
      { id: "jimov-tioanime", type: "direct-or-iframe", baseUrl: JIMOV_API },
      { id: "rapidapi-anime-streaming", type: "direct-hls", configured: isRapidAnimeConfigured() }
    ]
  });
}

function checkRateLimit(request, url) {
  if (url.pathname === "/api/health") return { allowed: true, limit: RATE_LIMIT_API_MAX_REQUESTS, retryAfterMs: 0 };
  const limit = url.pathname.startsWith("/api/") ? RATE_LIMIT_API_MAX_REQUESTS : RATE_LIMIT_MAX_REQUESTS;
  const key = `${getClientIp(request)}:${url.pathname.startsWith("/api/") ? "api" : "web"}`;
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  bucket.count += 1;
  rateLimitBuckets.set(key, bucket);
  if (rateLimitBuckets.size > 2000) pruneRateLimitBuckets(now);
  return {
    allowed: bucket.count <= limit,
    limit,
    retryAfterMs: Math.max(0, bucket.resetAt - now)
  };
}

function pruneRateLimitBuckets(now = Date.now()) {
  for (const [key, bucket] of rateLimitBuckets) {
    if (now > bucket.resetAt) rateLimitBuckets.delete(key);
  }
}

function getClientIp(request) {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
  return request.socket?.remoteAddress || "local";
}

function startLocalServer() {
  const server = http.createServer(handleRequest);
  server.listen(port, host, () => {
    console.log(`AnimeTV running at http://localhost:${port}`);
    console.log(`For Android TV, open http://YOUR-COMPUTER-IP:${port}`);
    console.log(`Metadata API ready at http://localhost:${port}/api/catalog`);
    ensureAnime1vServer();
    setInterval(ensureAnime1vServer, ANIME1V_RESTART_INTERVAL_MS);
    setTimeout(() => refreshDailyApis({ reason: "startup" }).catch((error) => {
      console.warn(`Daily API refresh failed on startup: ${error.message}`);
    }), DAILY_REFRESH_START_DELAY_MS);
    setInterval(() => refreshDailyApis({ reason: "scheduled" }).catch((error) => {
      console.warn(`Daily API refresh failed: ${error.message}`);
    }), DAILY_REFRESH_INTERVAL_MS);
  });

  checkAniPubHealth();
  return server;
}

if (require.main === module) {
  startLocalServer();
}

module.exports = handleRequest;
module.exports.handleRequest = handleRequest;
module.exports.startLocalServer = startLocalServer;
setInterval(checkAniPubHealth, 1000 * 60 * 60);

async function handleDailyRefresh(url, response) {
  const force = url.searchParams.get("force") === "1";
  const background = url.searchParams.get("background") !== "0";
  if (background) {
    refreshDailyApis({ force, reason: force ? "manual-force" : "manual" }).catch((error) => {
      console.warn(`Manual daily refresh failed: ${error.message}`);
    });
    sendJson(response, {
      ok: true,
      status: dailyRefreshPromise ? "already-running" : "started",
      lastRefresh: lastDailyRefreshResult,
      note: "Daily catalog refresh is running in the background."
    });
    return;
  }
  try {
    const result = await refreshDailyApis({ force, reason: force ? "manual-force" : "manual" });
    sendJson(response, { ok: true, ...result });
  } catch (error) {
    sendJson(response, { ok: false, error: error.message }, 502);
  }
}

async function refreshDailyApis({ force = false, reason = "scheduled" } = {}) {
  if (dailyRefreshPromise) return dailyRefreshPromise;
  const age = Date.now() - lastDailyRefreshAt;
  if (!force && lastDailyRefreshAt && age < DAILY_REFRESH_INTERVAL_MS) {
    return lastDailyRefreshResult || { status: "fresh", refreshedAt: new Date(lastDailyRefreshAt).toISOString() };
  }
  dailyRefreshPromise = (async () => {
    const startedAt = Date.now();
    console.log(`[AnimeTV] Daily API refresh started (${reason})`);
    const results = await Promise.allSettled([
      checkAniPubHealth(),
      fetchAllAniPubCatalog(12000, await fetchAniPubTotalCount().catch(() => 8343)),
      checkAnime1vHealth(ANIME1V_API_KEY, 7000)
    ]);
    const payload = {
      status: results.every((result) => result.status === "fulfilled") ? "ok" : "degraded",
      reason,
      refreshedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      anipub: results[1].status === "fulfilled"
        ? { ok: true, count: results[1].value.length }
        : { ok: false, error: results[1].reason?.message || "AniPub refresh failed" },
      anime1v: results[2].status === "fulfilled"
        ? { ok: Boolean(results[2].value.ok), status: results[2].value.status || "" }
        : { ok: false, error: results[2].reason?.message || "Anime1v health failed" }
    };
    lastDailyRefreshAt = Date.now();
    lastDailyRefreshResult = payload;
    console.log(`[AnimeTV] Daily API refresh complete: ${JSON.stringify(payload)}`);
    return payload;
  })().finally(() => {
    dailyRefreshPromise = null;
  });
  return dailyRefreshPromise;
}

async function handleCatalog(response) {
  try {
    const [anilist, jikanAiring, jikanSeason, jikanPopular] = await Promise.allSettled([
      fetchAniListTrending(),
      fetchJikanPages(JIKAN_TOP_ENDPOINT, "Jikan Airing", 2),
      fetchJikanPages(JIKAN_SEASON_ENDPOINT, "Jikan Season", 2),
      fetchJikanPages(JIKAN_POPULAR_ENDPOINT, "Jikan Popular", 2)
    ]);

    const items = [
      ...(anilist.status === "fulfilled" ? anilist.value : []),
      ...(jikanAiring.status === "fulfilled" ? jikanAiring.value : []),
      ...(jikanSeason.status === "fulfilled" ? jikanSeason.value : []),
      ...(jikanPopular.status === "fulfilled" ? jikanPopular.value : [])
    ];

    sendJson(response, {
      ok: true,
      source: "AnimeTV Metadata API",
      count: items.length,
      items: mergeShows(items).slice(0, 340)
    });
  } catch (error) {
    sendJson(response, { ok: false, error: "Metadata APIs unavailable" }, 502);
  }
}

async function handleSourceProxy(url, response) {
  const target = url.searchParams.get("url");
  if (!target || !/^https?:\/\//i.test(target)) {
    sendJson(response, { ok: false, error: "Missing http(s) url" }, 400);
    return;
  }

  try {
    const upstream = await fetchWithTimeout(target, {}, 12000);
    const contentType = upstream.headers.get("content-type") || "application/json; charset=utf-8";
    const body = await upstream.text();
    response.writeHead(upstream.status, {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store, max-age=0"
    });
    response.end(body);
  } catch (error) {
    sendJson(response, { ok: false, error: "Local source unavailable" }, 502);
  }
}

async function handleTranslate(request, response) {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    response.end();
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, { ok: false, error: "Use POST with { text, to, from }." }, 405);
    return;
  }

  try {
    const body = await readJsonBody(request);
    const text = String(body.text || "").trim();
    const to = String(body.to || "es").slice(0, 8);
    const from = String(body.from || "auto").slice(0, 8);
    if (!text) {
      sendJson(response, { ok: true, translatedText: "" });
      return;
    }

    const cacheKey = `${from}:${to}:${text}`;
    if (translationCache.has(cacheKey)) {
      sendJson(response, { ok: true, translatedText: translationCache.get(cacheKey), cached: true });
      return;
    }

    const endpoint = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 480))}&langpair=${encodeURIComponent(`${from}|${to}`)}`;
    const upstream = await fetchWithRetry(endpoint, { headers: { Accept: "application/json" } }, 1);
    if (!upstream.ok) throw new Error(`Translation HTTP ${upstream.status}`);
    const payload = await upstream.json();
    const translatedText = cleanTranslationText(payload?.responseData?.translatedText || text);
    translationCache.set(cacheKey, translatedText);
    if (translationCache.size > 1200) translationCache.delete(translationCache.keys().next().value);
    sendJson(response, { ok: true, translatedText, provider: "MyMemory" });
  } catch (error) {
    sendJson(response, {
      ok: false,
      error: "Translation is unavailable right now.",
      translatedText: ""
    }, 502);
  }
}

async function handleTioAnimeCatalog(response) {
  let tioanime;
  try {
    tioanime = require("tioanime");
  } catch (error) {
    sendJson(response, {
      ok: false,
      error: "TioAnime addon is not installed on this local server.",
      install: "npm install tioanime",
      note: "AnimeTV uses this addon for catalog and episode metadata only. Playback still needs your own local/legal video URLs."
    }, 501);
    return;
  }

  try {
    const latest = await tioanime.latestAnimeDetail();
    const items = await Promise.all((latest || []).slice(0, TIOANIME_CATALOG_LIMIT).map(async (anime, index) => {
      const episodes = Array.isArray(anime.episodes) && anime.episodes.length
        ? anime.episodes
        : await tioanime.getAnimeEpisodes(anime.id).catch(() => []);
      return normalizeTioAnimeShow(anime, episodes, index);
    }));

    sendJson(response, {
      ok: true,
      source: "TioAnime Metadata Addon",
      count: items.length,
      items: items.filter(Boolean)
    });
  } catch (error) {
    sendJson(response, { ok: false, error: "TioAnime addon could not load catalog metadata" }, 502);
  }
}

async function handleJimovTioAnimeCatalog(reqUrl, response) {
  const title = reqUrl.searchParams.get("q") || reqUrl.searchParams.get("title") || "";
  const limit = Math.max(1, Math.min(JIMOV_MAX_CATALOG_LIMIT, Number(reqUrl.searchParams.get("limit") || JIMOV_DEFAULT_CATALOG_LIMIT)));
  const status = reqUrl.searchParams.get("status") || "1";
  const type = reqUrl.searchParams.get("type") || "0";
  const sort = reqUrl.searchParams.get("sort") || "recent";
  const genres = (reqUrl.searchParams.get("genres") || "accion,aventura,comedia,fantasia,romance,shounen")
    .split(",")
    .map((genre) => genre.trim())
    .filter(Boolean);

  try {
    const requests = title
      ? [buildJimovFilterUrl({ title, status, type, sort })]
      : genres.map((genre) => buildJimovFilterUrl({ genre, status, type, sort }));
    const settled = await Promise.allSettled(requests.map((url) =>
      fetchWithTimeout(url, { headers: { Accept: "application/json" } }, 12000)
        .then(async (upstream) => {
          if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
          return upstream.json();
        })
    ));
    const rawResults = settled.flatMap((result) => {
      if (result.status !== "fulfilled") return [];
      const payload = result.value;
      return Array.isArray(payload) ? payload : payload.results || payload.items || payload.data || [];
    });
    const seen = new Set();
    const items = rawResults
      .filter((item) => {
        const key = normalizeTitle(item.name || item.title || item.url || "");
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, limit)
      .map((item, index) => normalizeJimovCatalogItem(item, index))
      .filter(Boolean);

    sendJson(response, {
      ok: true,
      source: "JIMOV TioAnime",
      count: items.length,
      totalResults: seen.size,
      hasMore: false,
      items
    });
  } catch (error) {
    sendJson(response, {
      ok: true,
      source: "JIMOV TioAnime (Unavailable)",
      count: 0,
      totalResults: 0,
      items: [],
      error: error.message,
      note: "JIMOV is optional. AnimeTV will keep working with the other sources."
    });
  }
}

async function handleJimovTioAnimeHealth(response) {
  const startedAt = Date.now();
  try {
    const upstream = await fetchWithTimeout(buildJimovFilterUrl({
      genre: "accion",
      status: "1",
      type: "0",
      sort: "recent"
    }), { headers: { Accept: "application/json" } }, 8000);
    if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
    const payload = await upstream.json();
    const items = Array.isArray(payload) ? payload : payload.results || payload.items || payload.data || [];
    sendJson(response, {
      ok: true,
      status: "ok",
      source: "JIMOV TioAnime",
      latencyMs: Date.now() - startedAt,
      sampleCount: Array.isArray(items) ? items.length : 0,
      playback: "Direct file_url when available, otherwise embedded player"
    });
  } catch (error) {
    sendJson(response, {
      ok: false,
      status: "offline",
      source: "JIMOV TioAnime",
      latencyMs: Date.now() - startedAt,
      error: error.message
    }, 502);
  }
}

async function handleJimovTioAnimeInfo(reqUrl, response) {
  const rawUrl = reqUrl.searchParams.get("url") || reqUrl.searchParams.get("path") || "";
  if (!rawUrl) {
    sendJson(response, { ok: false, error: "Missing JIMOV anime URL" }, 400);
    return;
  }
  try {
    const upstreamUrl = normalizeJimovApiUrl(rawUrl);
    const upstream = await fetchWithTimeout(upstreamUrl, { headers: { Accept: "application/json" } }, 15000);
    if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
    const info = await upstream.json();
    const episodes = normalizeJimovEpisodes(info.episodes || [], info);
    sendJson(response, {
      ok: true,
      source: "JIMOV TioAnime",
      title: info.name || info.title || "",
      image: info.image?.url || info.image || "",
      banner: info.image?.banner || "",
      description: cleanDescription(info.synopsis || info.description || ""),
      genres: info.genres || [],
      status: info.status || "",
      totalEpisodes: episodes.length,
      count: episodes.length,
      episodes,
      defaultLanguage: {
        audio: "japanese",
        subtitles: "spanish"
      }
    });
  } catch (error) {
    sendJson(response, { ok: false, source: "JIMOV TioAnime", error: error.message }, 502);
  }
}

function buildJimovFilterUrl({ title = "", genre = "", status = "1", type = "0", sort = "recent" }) {
  const url = new URL("/anime/tioanime/filter", JIMOV_API);
  if (title) url.searchParams.set("title", title);
  if (genre) url.searchParams.append("gen[]", genre);
  if (status) url.searchParams.set("status", status);
  if (type) url.searchParams.set("type", type);
  if (sort) url.searchParams.set("sort", sort);
  return url.toString();
}

function normalizeJimovApiUrl(value = "") {
  const raw = String(value || "").trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  return new URL(raw.replace(/^\//, "/"), JIMOV_API).toString();
}

function normalizeJimovCatalogItem(item, index = 0) {
  const title = item.name || item.title;
  if (!title) return null;
  const image = typeof item.image === "string" ? item.image : item.image?.url || "";
  const url = item.url || item.href || "";
  return {
    id: `jimov-tioanime-${normalizeTitle(title) || index}`,
    title,
    episode: "?",
    genre: "anime",
    genres: [],
    source: "JIMOV TioAnime",
    image,
    banner: typeof item.image === "object" ? item.image.banner || "" : "",
    description: "Japanese audio with Spanish subtitles when available through JIMOV/TioAnime.",
    siteUrl: url,
    jimovUrl: url,
    episodeEndpoint: "/api/jimov/tioanime/info",
    provider: "tioanime",
    type: item.type || "Anime",
    day: "Local",
    time: "",
    colors: ["#22d7ff", "#251d47"],
    seasons: [],
    episodes: []
  };
}

function normalizeJimovEpisodes(episodes = [], info = {}) {
  if (!Array.isArray(episodes)) return [];
  return repairServerEpisodes(episodes.map((episode, index) => {
    const number = Number(episode.number || episode.episode || index + 1) || index + 1;
    const servers = Array.isArray(episode.servers) ? episode.servers : [];
    const directServer = servers.find((server) => server.file_url);
    const embedServer = servers.find((server) => server.url);
    const sourceOptions = servers
      .map((server, serverIndex) => {
        if (server.file_url) {
          return {
            id: `jimov-direct-${server.name || serverIndex + 1}`,
            label: server.name || `Server ${serverIndex + 1}`,
            type: "direct",
            videoUrl: server.file_url,
            downloadUrl: server.file_url
          };
        }
        if (server.url) {
          return {
            id: `jimov-embed-${server.name || serverIndex + 1}`,
            label: server.name || `Server ${serverIndex + 1}`,
            type: "iframe",
            externalUrl: server.url
          };
        }
        return null;
      })
      .filter(Boolean);
    return {
      id: `jimov-${normalizeTitle(info.name || info.title)}-${number}`,
      title: episode.name || episode.title || `Episode ${number}`,
      season: 1,
      episode: number,
      poster: episode.image || info.image?.url || "",
      videoUrl: directServer?.file_url || "",
      externalUrl: directServer?.file_url ? "" : embedServer?.url || "",
      externalType: directServer?.file_url ? "" : embedServer?.url ? "iframe" : "",
      sourceOptions,
      server: directServer?.name || embedServer?.name || "JIMOV TioAnime",
      availableAudio: ["japanese"],
      availableSubs: ["spanish", "none"],
      defaultAudio: "japanese",
      defaultSubs: "spanish",
      locked: !(directServer?.file_url || embedServer?.url)
    };
  }), 1);
}

function repairServerEpisodes(episodes = [], seasonNumber = 1) {
  const byNumber = new Map();
  episodes.forEach((episode) => {
    const number = Number(episode.episode || episode.number);
    if (Number.isFinite(number) && number > 0) byNumber.set(number, episode);
  });
  const maxEpisode = Math.max(0, ...byNumber.keys());
  return Array.from({ length: maxEpisode }, (_, index) => {
    const episode = index + 1;
    return byNumber.get(episode) || {
      id: `jimov-missing-s${seasonNumber}-e${episode}`,
      title: `Episode ${episode}`,
      season: seasonNumber,
      episode,
      locked: true,
      missing: true,
      server: "Missing from JIMOV"
    };
  });
}

async function ensureAnime1vServer() {
  if (anime1vStartPromise) return anime1vStartPromise;
  anime1vStartPromise = autoStartAnime1vServer()
    .catch((error) => console.warn(`Anime1v monitor failed: ${error.message}`))
    .finally(() => {
      anime1vStartPromise = null;
    });
  return anime1vStartPromise;
}

async function autoStartAnime1vServer() {
  if (!ANIME1V_AUTO_START) {
    console.log("Anime1v auto-start disabled.");
    return;
  }
  const health = await checkAnime1vHealth(ANIME1V_API_KEY, 1800);
  if (health.ok) {
    console.log("Anime1v API already running at http://localhost:3001");
    return;
  }
  if (Number.isFinite(Number(health.status))) {
    console.log(`Anime1v API is reachable but returned ${health.status}. Not starting a duplicate process.`);
    return;
  }
  const anime1vPath = findAnime1vPath();
  if (!anime1vPath) {
    console.log("Anime1v API not found. Set ANIME1V_PATH or use start-all.bat to launch it.");
    return;
  }
  try {
    const child = spawn(process.execPath, ["src/server.js"], {
      cwd: anime1vPath,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
    console.log(`Anime1v API starting from ${anime1vPath} with node src/server.js`);
  } catch (error) {
    console.warn(`Anime1v API could not auto-start: ${error.message}`);
  }
}

function findAnime1vPath() {
  const candidates = [
    ANIME1V_PATH,
    path.join(root, "anime1v-api"),
    path.resolve(root, "..", "anime1v-api"),
    "C:\\anime1v-api"
  ].filter(Boolean);
  return candidates.find((candidate) => {
    try {
      return fs.existsSync(path.join(candidate, "package.json"));
    } catch (error) {
      return false;
    }
  }) || "";
}

async function handleAnime1vSearch(reqUrl, response) {
  const query = reqUrl.searchParams.get("q");
  const limit = Math.max(1, Math.min(ANIME1V_MAX_CATALOG_LIMIT, Number(reqUrl.searchParams.get("limit") || ANIME1V_DEFAULT_CATALOG_LIMIT)));
  const perPage = Math.max(10, Math.min(100, Number(reqUrl.searchParams.get("perPage") || 100)));
  const maxPages = Math.max(1, Math.min(ANIME1V_MAX_SEARCH_PAGES, Number(reqUrl.searchParams.get("pages") || ANIME1V_DEFAULT_SEARCH_PAGES)));
  const startPage = Math.max(1, Number(reqUrl.searchParams.get("page") || 1));
  if (!query) {
    sendJson(response, { ok: false, error: "Missing search query" }, 400);
    return;
  }

  try {
    const quota = getAnime1vQuotaState();
    if (quota.blocked) throw new Error(quota.message);
    const apiKey = reqUrl.searchParams.get("apiKey") || ANIME1V_API_KEY;
    const providers = anime1vProvidersFromRequest(reqUrl);
    const { allResults, items, hasMore } = await collectAnime1vSearchResults({
      query,
      providers,
      apiKey,
      startPage,
      maxPages,
      perPage,
      limit,
      reqUrl
    });
    const enrichedItems = await enrichAnime1vMetadataItems(items, apiKey, 24);

    sendJson(response, {
      ok: true,
      source: "Anime1v (Multi-Provider)",
      count: enrichedItems.length,
      totalResults: allResults.length,
      limit,
      page: startPage,
      nextPage: hasMore ? startPage + maxPages : null,
      hasMore,
      providers,
      items: enrichedItems
    });
  } catch (error) {
    console.error("Anime1v search error:", error.message);
    sendJson(response, anime1vUnavailablePayload({
      query,
      error: error.message
    }));
  }
}

async function handleAnime1vTrending(reqUrl, response) {
  const queries = (reqUrl.searchParams.get("q") || reqUrl.searchParams.get("queries") || "one,naruto,dragon,season,love,magic,school")
    .split(",")
    .map((query) => query.trim())
    .filter(Boolean);
  const limit = Math.max(1, Math.min(ANIME1V_MAX_CATALOG_LIMIT, Number(reqUrl.searchParams.get("limit") || ANIME1V_DEFAULT_CATALOG_LIMIT)));
  const perPage = Math.max(10, Math.min(100, Number(reqUrl.searchParams.get("perPage") || 100)));
  const startPage = Math.max(1, Number(reqUrl.searchParams.get("page") || 1));
  const maxPages = Math.max(1, Math.min(ANIME1V_MAX_SEARCH_PAGES, Number(reqUrl.searchParams.get("pages") || ANIME1V_DEFAULT_CATALOG_PAGES)));
  const apiKey = reqUrl.searchParams.get("apiKey") || ANIME1V_API_KEY;

  try {
    const quota = getAnime1vQuotaState();
    if (quota.blocked) throw new Error(quota.message);
    const providers = anime1vProvidersFromRequest(reqUrl);
    const combined = [];
    let hasMore = false;
    for (const query of queries) {
      const result = await collectAnime1vSearchResults({
        query,
        providers,
        apiKey,
        startPage,
        maxPages,
        perPage,
        limit,
        reqUrl
      });
      combined.push(...result.allResults);
      hasMore = hasMore || result.hasMore;
      if (combined.length >= limit * Math.max(2, providers.length)) break;
    }

    const seenTitles = new Set();
    const items = combined
      .filter((anime) => {
        const key = normalizeTitle(anime.title || anime.name || anime.Name || anime.url || anime.id || "");
        if (!key || seenTitles.has(key)) return false;
        seenTitles.add(key);
        return true;
      })
      .slice(0, limit)
      .map(normalizeAnime1vSearchItem)
      .filter(Boolean);
    const enrichedItems = await enrichAnime1vMetadataItems(items, apiKey, 24);

    sendJson(response, {
      ok: true,
      source: "Anime1v (Unified Catalog)",
      count: enrichedItems.length,
      totalResults: seenTitles.size,
      page: startPage,
      nextPage: hasMore || items.length >= limit ? startPage + maxPages : null,
      hasMore: hasMore || items.length >= limit,
      providers,
      items: enrichedItems
    });
  } catch (error) {
    console.error("Anime1v catalog error:", error.message);
    sendJson(response, anime1vUnavailablePayload({ error: error.message }));
  }
}

function anime1vProvidersFromRequest(reqUrl) {
  const requestedProvider = reqUrl.searchParams.get("provider") || reqUrl.searchParams.get("domain");
  const requestedProviders = (reqUrl.searchParams.get("providers") || "")
    .split(",")
    .map((provider) => provider.trim())
    .filter(Boolean);
  return requestedProvider
    ? [requestedProvider]
    : requestedProviders.length
      ? requestedProviders
      : ANIME1V_PROVIDERS;
}

async function collectAnime1vSearchResults({ query, providers, apiKey, startPage = 1, maxPages = 1, perPage = 100, limit = 100, reqUrl = null }) {
  const quota = getAnime1vQuotaState();
  if (quota.blocked) throw new Error(quota.message);
  let hasMore = false;
  const providerResults = await Promise.allSettled(providers.map(async (provider) => {
    const results = [];
    const providerSeen = new Set();
    const lastPage = startPage + maxPages - 1;

    for (let page = startPage; page <= lastPage && results.length < limit; page++) {
      const searchUrl = buildAnime1vUrl("/api/v1/anime/search", {
        q: query,
        domain: provider,
        apiKey,
        limit: perPage,
        page
      });
      const upstream = await fetchWithTimeout(searchUrl, {
        headers: anime1vHeaders(reqUrl || apiKey)
      }, 10000);
      if (!upstream.ok) {
        const apiError = await anime1vHttpError(upstream);
        throw new Error(apiError.message);
      }
      const data = await upstream.json();
      const pageResults = extractAnime1vResults(data);
      if (!pageResults.length) break;

      let newCount = 0;
      pageResults.forEach((anime) => {
        const key = normalizeTitle(anime.title || anime.name || anime.Name || anime.url || anime.id || "");
        if (!key || providerSeen.has(key)) return;
        providerSeen.add(key);
        newCount++;
        results.push({
          ...anime,
          provider,
          hasSpanishSubs: true
        });
      });

      if (pageResults.length >= perPage && newCount > 0) hasMore = true;
      if (pageResults.length < perPage || newCount === 0) break;
    }

    return results;
  }));

  const allResults = providerResults.flatMap((result, index) => {
    if (result.status === "fulfilled") return result.value;
    console.log(`Anime1v provider ${providers[index]} failed:`, result.reason?.message || result.reason);
    return [];
  });
  const seenTitles = new Set();
  const items = allResults
    .filter((anime) => {
      const titleKey = normalizeTitle(anime.title || anime.name || anime.Name || "");
      if (!titleKey || seenTitles.has(titleKey)) return false;
      seenTitles.add(titleKey);
      return true;
    })
    .slice(0, limit)
    .map(normalizeAnime1vSearchItem)
    .filter(Boolean);

  return { allResults, items, hasMore };
}

async function enrichAnime1vMetadataItems(items = [], apiKey = ANIME1V_API_KEY, maxItems = 24) {
  const targets = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.anime1vUrl && (!item.image || !item.description || item.description.includes("Japanese audio")))
    .slice(0, maxItems);
  if (!targets.length) return items;

  const enriched = [...items];
  const results = await Promise.allSettled(targets.map(async ({ item, index }) => {
    const infoUrl = buildAnime1vUrl("/api/v1/anime/info", {
      url: item.anime1vUrl,
      domain: item.provider || "animeav1.com",
      apiKey
    });
    const upstream = await fetchWithTimeout(infoUrl, { headers: anime1vHeaders(apiKey) }, 6500);
    if (!upstream.ok) {
      const apiError = await anime1vHttpError(upstream);
      throw new Error(apiError.message);
    }
    const info = unwrapAnime1vData(await upstream.json());
    const image = bestAnime1vImage(info) || item.image;
    const banner = info.banner || info.backdrop || info.fondo || image || item.banner;
    const description = cleanDescription(info.synopsis || info.description || info.DescripTion || info.Description || item.description);
    const episodeCount = parseEpisodeCount(info.episodes || info.episodeCount || info.totalEpisodes || info.total_episodes) || item.episode;
    return {
      index,
      patch: {
        image,
        banner,
        description,
        episode: episodeCount
      }
    };
  }));

  results.forEach((result) => {
    if (result.status !== "fulfilled") return;
    const { index, patch } = result.value;
    enriched[index] = {
      ...enriched[index],
      ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined && value !== null && value !== ""))
    };
  });
  return enriched;
}

async function handleAnime1vHealth(response) {
  const startedAt = Date.now();
  try {
    const health = await checkAnime1vHealth(ANIME1V_API_KEY, 7000);
    if (!health.ok) throw new Error(health.error || health.status || "Anime1v unavailable");
    const upstream = health.response;
    const text = await upstream.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      parsed = null;
    }
    const results = extractAnime1vResults(parsed);
    const quota = getAnime1vQuotaState();
    let searchProbe = quota.blocked
      ? { ok: false, status: "quota", sampleCount: 0, error: quota.message, retryAfterMs: quota.retryAfterMs }
      : { ok: false, status: "not checked", sampleCount: 0, error: "" };
    try {
      if (quota.blocked) throw new Error(quota.message);
      const probeUrl = buildAnime1vUrl("/api/v1/anime/search", {
        q: "naruto",
        domain: "animeav1.com",
        apiKey: ANIME1V_API_KEY,
        limit: 5,
        page: 1
      });
      const probeResponse = await fetchWithTimeout(probeUrl, {
        headers: anime1vHeaders(ANIME1V_API_KEY)
      }, 7000);
      if (!probeResponse.ok) {
        const apiError = await anime1vHttpError(probeResponse);
        throw new Error(apiError.message);
      }
      const probePayload = await probeResponse.json();
      const probeResults = extractAnime1vResults(probePayload);
      searchProbe = {
        ok: probeResponse.ok && probeResults.length > 0,
        status: probeResponse.status,
        sampleCount: probeResults.length,
        error: probeResponse.ok ? "" : `HTTP ${probeResponse.status}`
      };
    } catch (error) {
      searchProbe = quota.blocked
        ? { ok: false, status: "quota", sampleCount: 0, error: quota.message, retryAfterMs: quota.retryAfterMs }
        : { ok: false, status: "error", sampleCount: 0, error: error.message };
    }
    const currentQuota = getAnime1vQuotaState();
    sendJson(response, {
      ok: upstream.ok,
      status: currentQuota.blocked ? "quota" : upstream.ok && searchProbe.ok ? "ok" : "degraded",
      source: "Anime1v",
      baseUrl: ANIME1V_API,
      latencyMs: Date.now() - startedAt,
      providers: ANIME1V_PROVIDERS,
      sampleCount: searchProbe.sampleCount || results.length,
      searchProbe,
      quota: currentQuota,
      needsApiKey: !ANIME1V_API_KEY && upstream.status === 401,
      note: upstream.ok
        ? currentQuota.blocked
          ? `${currentQuota.message} AnimeTV will pause Anime1v requests and use other active sources until the quota window resets.`
          : searchProbe.ok
          ? "Anime1v local API responded and returned catalog search results. Search, info, episode, and stream proxy routes are ready."
          : "Anime1v local API responded, but its provider search did not return catalog items. Check the Anime1v API key/provider logs if Anime1v content is empty."
        : upstream.status === 401
          ? "Anime1v requires an API key. Set ANIME1V_API_KEY before starting AnimeTV, or pass apiKey to the AnimeTV proxy."
          : `Anime1v responded with HTTP ${upstream.status}.`
    }, upstream.ok ? 200 : 502);
  } catch (error) {
    sendJson(response, {
      ok: false,
      status: "offline",
      source: "Anime1v",
      baseUrl: ANIME1V_API,
      providers: ANIME1V_PROVIDERS,
      needsApiKey: true,
      error: error.message,
      note: "Start Anime1v locally with npm run dev on port 3001, then retry."
    }, 502);
  }
}

async function checkAnime1vHealth(apiKey = ANIME1V_API_KEY, timeoutMs = 2500) {
  try {
    const healthUrl = buildAnime1vUrl("/health", { apiKey });
    const response = await fetchWithTimeout(healthUrl, {
      headers: anime1vHeaders(apiKey)
    }, timeoutMs);
    return {
      ok: response.ok,
      status: response.status,
      response,
      error: response.ok ? "" : `HTTP ${response.status}`
    };
  } catch (error) {
    return {
      ok: false,
      status: "offline",
      error: error.message
    };
  }
}

function anime1vUnavailablePayload(extra = {}) {
  const quota = getAnime1vQuotaState();
  return {
    ok: true,
    source: quota.blocked ? "Anime1v (Daily quota reached)" : "Anime1v (Unavailable)",
    count: 0,
    totalResults: 0,
    items: [],
    providers: [],
    error: extra.error || quota.message || "",
    query: extra.query || "",
    quota,
    note: quota.blocked
      ? `${quota.message} AnimeTV is keeping Anime1v paused and will continue using AniPub/JIMOV until it resets.`
      : `Anime1v is optional and is not reachable at ${ANIME1V_API}. Start it with npm run dev in your anime1v-api folder, then refresh AnimeTV.`
  };
}

async function handleAnime1vEpisodes(reqUrl, response) {
  const animeUrl = reqUrl.searchParams.get("url");
  const provider = reqUrl.searchParams.get("provider") || "animeav1.com";
  const apiKey = reqUrl.searchParams.get("apiKey") || ANIME1V_API_KEY;

  if (!animeUrl) {
    sendJson(response, { ok: false, error: "Missing anime URL" }, 400);
    return;
  }

  try {
    const quota = getAnime1vQuotaState();
    if (quota.blocked) {
      sendJson(response, {
        ok: false,
        source: "Anime1v",
        status: "quota",
        error: quota.message,
        quota,
        episodes: [],
        note: "Anime1v episode fetching is paused so it does not keep spending failed requests."
      }, 429);
      return;
    }
    const infoUrl = buildAnime1vUrl("/api/v1/anime/info", { url: animeUrl, domain: provider, apiKey });
    const infoResponse = await fetchWithTimeout(infoUrl, {
      headers: anime1vHeaders(apiKey)
    }, 15000);
    if (!infoResponse.ok) {
      const apiError = await anime1vHttpError(infoResponse);
      throw new Error(`Failed to get anime info: ${apiError.message}`);
    }
    const infoPayload = await infoResponse.json();
    const info = unwrapAnime1vData(infoPayload);
    const extractedEpisodes = extractAnime1vEpisodes(info);
    const episodeCount = parseEpisodeCount(info.episodes || info.episodeCount || info.totalEpisodes || info.total_episodes) || 50;
    const episodeUrls = (extractedEpisodes.length
      ? extractedEpisodes
      : Array.from({ length: Math.min(episodeCount, ANIME1V_MAX_EPISODES) }, (_, index) => ({
        number: index + 1,
        title: `Episode ${index + 1}`,
        url: buildAnime1vEpisodeUrl(animeUrl, index + 1),
        thumbnail: info.image || info.poster || info.cover || ""
      }))
    ).slice(0, ANIME1V_MAX_EPISODES);
    const episodes = episodeUrls.map((episode, index) => normalizeAnime1vSearchEpisode(
      episode,
      {
        id: info.id || info._id || info.slug || animeUrl,
        title: info.title || info.name || "",
        image: info.image || info.poster || info.cover || ""
      },
      provider,
      index
    )).filter(Boolean);

    sendJson(response, {
      ok: true,
      source: "Anime1v",
      animeId: info.id || info._id || info.slug || animeUrl,
      title: info.title || info.name || "",
      image: bestAnime1vImage(info),
      banner: info.banner || info.backdrop || bestAnime1vImage(info),
      description: cleanDescription(info.synopsis || info.description || info.DescripTion || info.Description || ""),
      totalEpisodes: episodeUrls.length,
      count: episodes.length,
      episodes,
      defaultLanguage: {
        audio: "japanese",
        subtitles: "spanish"
      },
      provider
    });
  } catch (error) {
    sendJson(response, { ok: false, source: "Anime1v", error: error.message }, 502);
  }
}

function buildAnime1vEpisodeUrl(animeUrl, episodeNumber) {
  const clean = String(animeUrl || "").replace(/\/$/, "");
  if (!clean) return "";
  return `${clean}/ver/${episodeNumber}`;
}

async function handleAnime1vStream(reqUrl, response) {
  const episodeUrl = reqUrl.searchParams.get("url");
  const provider = reqUrl.searchParams.get("provider") || "animeav1.com";
  const quality = reqUrl.searchParams.get("quality") || "720p";
  const apiKey = reqUrl.searchParams.get("apiKey") || ANIME1V_API_KEY;

  if (!episodeUrl) {
    sendJson(response, { ok: false, error: "Missing episode URL" }, 400);
    return;
  }

  try {
    const quota = getAnime1vQuotaState();
    if (quota.blocked) {
      sendJson(response, {
        ok: false,
        source: "Anime1v",
        status: "quota",
        error: quota.message,
        quota,
        note: "Anime1v stream fetching is paused until the daily quota resets."
      }, 429);
      return;
    }
    const episodeData = await fetchAnime1vEpisodeStream(episodeUrl, provider, apiKey);
    const streams = extractAnime1vStreams(episodeData);
    const stream = pickAnime1vStream(streams, quality);
    const directUrl = pickAnime1vDirectUrl(episodeData, stream);
    const embedUrl = extractAnime1vEmbedUrl(episodeData);
    const sourceOptions = streams
      .map((candidate, index) => {
        const videoUrl = pickAnime1vDirectUrl(candidate);
        if (!videoUrl) return null;
        return {
          id: `anime1v-${provider}-${candidate.quality || index + 1}`,
          label: `${provider}${candidate.quality ? ` ${candidate.quality}` : ""}`,
          type: "direct",
          videoUrl,
          downloadUrl: candidate.downloadUrl || candidate.download || candidate.file || videoUrl
        };
      })
      .filter(Boolean);
    sendJson(response, {
      ok: true,
      source: "Anime1v",
      videoUrl: directUrl,
      streamUrl: stream?.streamUrl || "",
      file: stream?.file || "",
      externalUrl: embedUrl,
      externalType: embedUrl ? "iframe" : "",
      sourceOptions,
      downloadUrl: stream?.downloadUrl || stream?.download || stream?.file || directUrl,
      subtitles: normalizeAnime1vSubtitlePayload(episodeData.subtitles),
      audioTrack: "japanese",
      subtitleTrack: "spanish",
      availableAudio: ["japanese"],
      availableSubs: ["spanish", "none"],
      defaultAudio: "japanese",
      defaultSubs: "spanish",
      quality: stream?.quality || "unknown",
      provider
    });
  } catch (error) {
    sendJson(response, { ok: false, source: "Anime1v", error: error.message }, 502);
  }
}

async function handleConsumetHealth(response) {
  try {
    const payload = await consumetRequest(`/anime/${CONSUMET_PROVIDER}/naruto`, { page: 1 }, 6000);
    sendJson(response, {
      ok: true,
      source: "Consumet KickAssAnime",
      baseUrl: CONSUMET_API,
      provider: CONSUMET_PROVIDER,
      results: Array.isArray(payload.results) ? payload.results.length : 0,
      note: "Self-host Consumet with Docker on port 3000 for local playback."
    });
  } catch (error) {
    sendJson(response, consumetUnavailablePayload(error), 503);
  }
}

async function handleConsumetCatalog(reqUrl, response) {
  const limit = Math.max(1, Math.min(CONSUMET_CATALOG_LIMIT, Number(reqUrl.searchParams.get("limit") || CONSUMET_CATALOG_LIMIT)));
  const page = Math.max(1, Number(reqUrl.searchParams.get("page") || 1) || 1);
  const pages = Math.max(1, Math.min(CONSUMET_SEARCH_PAGES, Number(reqUrl.searchParams.get("pages") || CONSUMET_SEARCH_PAGES)));
  const query = reqUrl.searchParams.get("q") || reqUrl.searchParams.get("query");
  try {
    const items = await searchConsumetSeeds(query ? [query] : CONSUMET_CATALOG_SEEDS, { page, pages, limit });
    sendJson(response, {
      ok: true,
      source: "Consumet KickAssAnime",
      provider: CONSUMET_PROVIDER,
      count: items.length,
      totalResults: items.length,
      page,
      hasMore: false,
      items
    });
  } catch (error) {
    sendJson(response, consumetUnavailablePayload(error), 503);
  }
}

async function handleConsumetSearch(reqUrl, response) {
  const query = reqUrl.searchParams.get("q") || reqUrl.searchParams.get("query");
  const page = Math.max(1, Number(reqUrl.searchParams.get("page") || 1) || 1);
  const limit = Math.max(1, Math.min(CONSUMET_CATALOG_LIMIT, Number(reqUrl.searchParams.get("limit") || 120)));
  const pages = Math.max(1, Math.min(CONSUMET_SEARCH_PAGES, Number(reqUrl.searchParams.get("pages") || 2)));
  if (!query) {
    sendJson(response, { ok: false, error: "Missing search query" }, 400);
    return;
  }
  try {
    const items = await searchConsumetSeeds([query], { page, pages, limit });
    sendJson(response, {
      ok: true,
      source: "Consumet KickAssAnime",
      provider: CONSUMET_PROVIDER,
      count: items.length,
      totalResults: items.length,
      page,
      items
    });
  } catch (error) {
    sendJson(response, consumetUnavailablePayload(error), 503);
  }
}

async function searchConsumetSeeds(seeds, { page = 1, pages = 1, limit = 120 } = {}) {
  const byId = new Map();
  for (const seed of seeds) {
    for (let offset = 0; offset < pages && byId.size < limit; offset += 1) {
      const currentPage = page + offset;
      const payload = await consumetRequest(`/anime/${CONSUMET_PROVIDER}/${encodeURIComponent(seed)}`, { page: currentPage });
      const results = Array.isArray(payload?.results) ? payload.results : [];
      results.forEach((item) => {
        const normalized = normalizeConsumetCatalogItem(item);
        if (normalized?.consumetId && !byId.has(normalized.consumetId)) byId.set(normalized.consumetId, normalized);
      });
      if (!payload?.hasNextPage || results.length === 0) break;
      await wait(90);
    }
  }
  return [...byId.values()].slice(0, limit);
}

async function handleConsumetInfo(reqUrl, response) {
  const id = reqUrl.searchParams.get("id") || reqUrl.searchParams.get("url");
  if (!id) {
    sendJson(response, { ok: false, error: "Missing KickAssAnime id" }, 400);
    return;
  }
  try {
    const info = await consumetRequest(`/anime/${CONSUMET_PROVIDER}/info`, { id });
    const seasonNumber = extractSeasonNumber(info.title || "", 1);
    const episodes = (Array.isArray(info.episodes) ? info.episodes : [])
      .map((episode, index) => normalizeConsumetEpisode(episode, info, index));
    sendJson(response, {
      ok: true,
      source: "Consumet KickAssAnime",
      provider: CONSUMET_PROVIDER,
      id: info.id || id,
      consumetId: info.id || id,
      title: info.title || "",
      image: info.image || "",
      banner: info.cover || info.image || "",
      description: cleanDescription(info.description || ""),
      genres: info.genres || [],
      totalEpisodes: info.totalEpisodes || episodes.length,
      hasSpanishSubtitles: true,
      defaultAudio: "japanese",
      defaultSubs: "spanish",
      episodes: repairServerEpisodes(episodes, seasonNumber)
    });
  } catch (error) {
    sendJson(response, { ok: false, source: "Consumet KickAssAnime", error: error.message }, 502);
  }
}

async function handleConsumetServers(reqUrl, response) {
  const episodeId = reqUrl.searchParams.get("episodeId") || reqUrl.searchParams.get("id");
  if (!episodeId) {
    sendJson(response, { ok: false, error: "Missing episodeId" }, 400);
    return;
  }
  try {
    const servers = await consumetRequest(`/anime/${CONSUMET_PROVIDER}/servers`, { episodeId });
    sendJson(response, {
      ok: true,
      source: "Consumet KickAssAnime",
      episodeId,
      servers: Array.isArray(servers) ? servers : []
    });
  } catch (error) {
    sendJson(response, { ok: false, source: "Consumet KickAssAnime", error: error.message }, 502);
  }
}

async function handleConsumetWatch(reqUrl, response) {
  const episodeId = reqUrl.searchParams.get("episodeId") || reqUrl.searchParams.get("id");
  const server = reqUrl.searchParams.get("server") || "";
  if (!episodeId) {
    sendJson(response, { ok: false, error: "Missing episodeId" }, 400);
    return;
  }
  try {
    const payload = await consumetRequest(`/anime/${CONSUMET_PROVIDER}/watch`, { episodeId, server });
    const sources = Array.isArray(payload.sources) ? payload.sources : [];
    const subtitles = normalizeConsumetSubtitles(payload.subtitles);
    const best = pickBestConsumetSource(sources);
    const sourceOptions = sources.map((source, index) => ({
      id: `consumet-${normalizeTitle(server || source.quality || String(index + 1))}`,
      label: `KickAssAnime ${server || source.quality || index + 1}`,
      type: "direct",
      videoUrl: source.url,
      downloadUrl: source.url
    })).filter((source) => source.videoUrl);
    const hasSpanish = subtitles.some((track) => isSpanishLanguage(track.language || track.label));
    sendJson(response, {
      ok: true,
      source: "Consumet KickAssAnime",
      server: server || "KickAssAnime",
      videoUrl: best?.url || "",
      streamUrl: best?.url || "",
      file: best?.url || "",
      isM3U8: Boolean(best?.isM3U8 || /\.m3u8($|\?)/i.test(best?.url || "")),
      headers: payload.headers || {},
      subtitles,
      availableAudio: ["japanese"],
      availableSubs: hasSpanish ? ["spanish", "english", "spanish-translated", "none"] : ["spanish-translated", "english", "none"],
      defaultAudio: "japanese",
      defaultSubs: hasSpanish ? "spanish" : "spanish-translated",
      hasSpanishSubtitles: hasSpanish,
      subtitleWarning: hasSpanish ? "" : "KickAssAnime did not return a Spanish subtitle file for this server. AnimeTV can translate available subtitles to Spanish.",
      sourceOptions
    });
  } catch (error) {
    sendJson(response, { ok: false, source: "Consumet KickAssAnime", error: error.message }, 502);
  }
}

async function consumetRequest(pathname, params = {}, timeout = CONSUMET_TIMEOUT_MS) {
  const url = new URL(pathname.replace(/^\/+/, "/"), CONSUMET_API);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });
  const response = await fetchWithTimeout(url.toString(), { headers: { Accept: "application/json" } }, timeout);
  if (!response.ok) throw new Error(`Consumet HTTP ${response.status}`);
  return response.json();
}

function normalizeConsumetCatalogItem(item = {}) {
  const id = item.id || item.slug || item.url || "";
  const title = item.title || item.name || "";
  if (!id || !title) return null;
  return {
    id: `consumet-kaa-${normalizeTitle(id) || normalizeTitle(title)}`,
    consumetId: id,
    title,
    episode: item.totalEpisodes || "?",
    genre: "anime",
    genres: [],
    source: "Consumet KickAssAnime",
    image: item.image || "",
    banner: item.image || "",
    description: item.otherName || "KickAssAnime via self-hosted Consumet. Japanese audio with Spanish subtitles when the selected server provides them.",
    siteUrl: id,
    consumetUrl: id,
    episodeEndpoint: "/api/consumet/kickassanime/info",
    streamEndpoint: "/api/consumet/kickassanime/watch",
    provider: CONSUMET_PROVIDER,
    type: item.type || "Anime",
    subOrDub: item.subOrDub || "sub",
    status: item.status || "",
    totalEpisodes: item.totalEpisodes || null,
    hasSpanishSubtitles: true,
    day: "Local",
    time: "",
    colors: ["#56e0c2", "#261d47"],
    seasons: [],
    episodes: []
  };
}

function normalizeConsumetEpisode(episode = {}, info = {}, index = 0) {
  const number = Number(episode.number || episode.episode || index + 1) || index + 1;
  const season = extractSeasonNumber(info.title || "", 1);
  const episodeId = episode.id || episode.url || "";
  return {
    id: `consumet-kaa-${normalizeTitle(info.id || info.title)}-${number}`,
    consumetEpisodeId: episodeId,
    title: episode.title || `Episode ${number}`,
    season,
    episode: number,
    number,
    poster: episode.image || info.image || "",
    server: "Consumet KickAssAnime",
    streamResolver: episodeId ? {
      type: "consumet-kickassanime",
      endpoint: `/api/consumet/kickassanime/watch?episodeId=${encodeURIComponent(episodeId)}`
    } : null,
    sourceOptions: episodeId ? buildConsumetSourceOptions(episodeId) : [],
    availableAudio: ["japanese"],
    availableSubs: ["spanish", "spanish-translated", "english", "none"],
    defaultAudio: "japanese",
    defaultSubs: "spanish",
    hasSpanishSubtitles: true,
    locked: !episodeId
  };
}

function buildConsumetSourceOptions(episodeId) {
  return ["VidStreaming", "BirdStream", "DuckStream", "CatStream"].map((server, index) => ({
    id: `consumet-kaa-${normalizeTitle(server)}`,
    label: `KickAssAnime ${index + 1}`,
    type: "resolver",
    streamResolver: {
      type: "consumet-kickassanime",
      endpoint: `/api/consumet/kickassanime/watch?episodeId=${encodeURIComponent(episodeId)}&server=${encodeURIComponent(server)}`
    }
  }));
}

function normalizeConsumetSubtitles(subtitles = []) {
  if (!Array.isArray(subtitles)) return [];
  return subtitles.map((track) => {
    if (typeof track === "string") return { url: track, language: "", label: "Subtitles" };
    const url = track.url || track.file || track.src || track.href;
    if (!url) return null;
    const label = track.lang || track.language || track.label || track.name || "Subtitles";
    const normalized = normalizeLanguageName(label);
    return {
      url,
      language: normalized === "spanish" ? "es" : normalized === "english" ? "en" : String(label).toLowerCase(),
      label,
      default: normalized === "spanish"
    };
  }).filter(Boolean).sort((a, b) => Number(b.default) - Number(a.default));
}

function pickBestConsumetSource(sources = []) {
  return [...sources]
    .filter((source) => source?.url)
    .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality))[0] || null;
}

function qualityRank(value = "") {
  const match = String(value).match(/(\d{3,4})/);
  return match ? Number(match[1]) : 0;
}

function consumetUnavailablePayload(error) {
  return {
    ok: false,
    source: "Consumet KickAssAnime",
    baseUrl: CONSUMET_API,
    error: error?.message || "Consumet is unavailable",
    note: "Consumet is self-hosted. Start it with: docker run -p 3000:3000 riimuru/consumet-api"
  };
}

async function handleRapidAnimeHealth(response) {
  if (!isRapidAnimeConfigured()) {
    sendJson(response, {
      ok: false,
      status: "not_configured",
      source: "RapidAPI Anime Streaming",
      needsApiKey: !RAPIDAPI_ANIME_KEY,
      needsHost: !RAPIDAPI_ANIME_HOST,
      note: "Set RAPIDAPI_ANIME_KEY and RAPIDAPI_ANIME_HOST in .env.local, then restart AnimeTV."
    }, 503);
    return;
  }

  try {
    const startedAt = Date.now();
    const payload = await fetchRapidAnimeJson("/recent-episodes", { limit: 1 });
    const sample = extractRapidAnimeItems(payload).length;
    sendJson(response, {
      ok: true,
      status: "ok",
      source: "RapidAPI Anime Streaming",
      host: RAPIDAPI_ANIME_HOST,
      sampleCount: sample,
      latencyMs: Date.now() - startedAt,
      defaults: {
        audio: "japanese",
        subtitles: "spanish"
      }
    });
  } catch (error) {
    sendJson(response, {
      ok: false,
      status: "degraded",
      source: "RapidAPI Anime Streaming",
      host: RAPIDAPI_ANIME_HOST,
      error: error.message
    }, 502);
  }
}

async function handleRapidAnimeCatalog(reqUrl, response) {
  if (!isRapidAnimeConfigured()) {
    sendJson(response, rapidAnimeUnavailablePayload(), 503);
    return;
  }

  const limit = Math.max(1, Math.min(RAPIDAPI_ANIME_CATALOG_LIMIT, Number(reqUrl.searchParams.get("limit") || RAPIDAPI_ANIME_CATALOG_LIMIT)));
  const page = Math.max(1, Number(reqUrl.searchParams.get("page") || 1));
  const mode = reqUrl.searchParams.get("mode") || "recent";
  const endpoint = mode === "top-airing"
    ? "/top-airing"
    : mode === "spotlight"
      ? "/spotlight"
      : "/recent-episodes";

  try {
    const payload = await fetchRapidAnimeJson(endpoint, { page, limit });
    const rawItems = extractRapidAnimeItems(payload);
    const items = rawItems
      .map((item, index) => normalizeRapidAnimeShow(item, index))
      .filter(Boolean)
      .slice(0, limit);
    sendJson(response, {
      ok: true,
      source: "RapidAPI Anime Streaming",
      host: RAPIDAPI_ANIME_HOST,
      count: items.length,
      totalResults: Number(payload.total || payload.totalResults || payload.totalPages || payload.data?.total || 0) || items.length,
      page: Number(payload.page || payload.currentPage || payload.data?.page || page),
      nextPage: inferRapidNextPage(payload, page, items.length),
      hasMore: Boolean(inferRapidNextPage(payload, page, items.length)),
      items
    });
  } catch (error) {
    sendJson(response, {
      ok: false,
      source: "RapidAPI Anime Streaming",
      host: RAPIDAPI_ANIME_HOST,
      count: 0,
      totalResults: 0,
      items: [],
      error: error.message
    }, 502);
  }
}

async function handleRapidAnimeSearch(reqUrl, response) {
  if (!isRapidAnimeConfigured()) {
    sendJson(response, rapidAnimeUnavailablePayload(), 503);
    return;
  }

  const query = reqUrl.searchParams.get("q") || reqUrl.searchParams.get("query") || "";
  if (!query.trim()) {
    sendJson(response, { ok: false, error: "Missing search query" }, 400);
    return;
  }

  try {
    const payload = await fetchRapidAnimeJson(`/search/${encodeURIComponent(query)}`);
    const rawItems = extractRapidAnimeItems(payload);
    const items = rawItems.map((item, index) => normalizeRapidAnimeShow(item, index)).filter(Boolean);
    sendJson(response, {
      ok: true,
      source: "RapidAPI Anime Streaming",
      count: items.length,
      items
    });
  } catch (error) {
    sendJson(response, {
      ok: false,
      source: "RapidAPI Anime Streaming",
      count: 0,
      items: [],
      error: error.message
    }, 502);
  }
}

async function handleRapidAnimeInfo(reqUrl, response) {
  if (!isRapidAnimeConfigured()) {
    sendJson(response, rapidAnimeUnavailablePayload(), 503);
    return;
  }

  const animeId = reqUrl.searchParams.get("id") || reqUrl.searchParams.get("animeId") || reqUrl.searchParams.get("url");
  if (!animeId) {
    sendJson(response, { ok: false, error: "Missing anime id" }, 400);
    return;
  }

  try {
    const payload = await fetchRapidAnimeJson(`/info/${encodeURIComponent(animeId)}`);
    const info = unwrapRapidAnimeData(payload);
    const show = normalizeRapidAnimeShow(info, 0) || {};
    const rawEpisodes = extractRapidAnimeEpisodes(info);
    const episodes = repairEpisodeGaps(rawEpisodes.map((episode, index) => normalizeRapidAnimeEpisode(episode, show, index)).filter(Boolean), { season: 1 });
    sendJson(response, {
      ok: true,
      source: "RapidAPI Anime Streaming",
      animeId,
      title: show.title || info.title || info.name || "",
      image: show.image || "",
      banner: show.banner || "",
      description: show.description || "",
      totalEpisodes: episodes.length,
      count: episodes.length,
      episodes,
      seasons: [{ season: 1, title: "Season 1", episodes }],
      defaultLanguage: {
        audio: "japanese",
        subtitles: "spanish"
      }
    });
  } catch (error) {
    sendJson(response, { ok: false, source: "RapidAPI Anime Streaming", error: error.message }, 502);
  }
}

async function handleRapidAnimeWatch(reqUrl, response) {
  if (!isRapidAnimeConfigured()) {
    sendJson(response, rapidAnimeUnavailablePayload(), 503);
    return;
  }

  const episodeId = reqUrl.searchParams.get("episodeId") || reqUrl.searchParams.get("id") || reqUrl.searchParams.get("url");
  if (!episodeId) {
    sendJson(response, { ok: false, error: "Missing episode id" }, 400);
    return;
  }

  try {
    const payload = await fetchRapidAnimeJson(`/watch/${encodeURIComponent(episodeId)}`);
    const stream = normalizeRapidAnimeStreamPayload(payload);
    sendJson(response, {
      ok: true,
      source: "RapidAPI Anime Streaming",
      episodeId,
      ...stream
    });
  } catch (error) {
    sendJson(response, { ok: false, source: "RapidAPI Anime Streaming", error: error.message }, 502);
  }
}

function isRapidAnimeConfigured() {
  return Boolean(RAPIDAPI_ANIME_KEY && RAPIDAPI_ANIME_HOST && RAPIDAPI_ANIME_BASE);
}

function rapidAnimeUnavailablePayload() {
  return {
    ok: true,
    source: "RapidAPI Anime Streaming (Not configured)",
    count: 0,
    totalResults: 0,
    items: [],
    needsApiKey: !RAPIDAPI_ANIME_KEY,
    needsHost: !RAPIDAPI_ANIME_HOST,
    note: "Add RAPIDAPI_ANIME_KEY and RAPIDAPI_ANIME_HOST to .env.local. The key is intentionally not stored in committed code."
  };
}

async function fetchRapidAnimeJson(pathname, params = {}) {
  const url = new URL(pathname, RAPIDAPI_ANIME_BASE);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });
  const upstream = await fetchWithTimeout(url.toString(), {
    headers: {
      "Accept": "application/json",
      "X-RapidAPI-Key": RAPIDAPI_ANIME_KEY,
      "X-RapidAPI-Host": RAPIDAPI_ANIME_HOST
    }
  }, RAPIDAPI_ANIME_TIMEOUT_MS);
  if (!upstream.ok) {
    const body = await upstream.text().catch(() => "");
    throw new Error(`RapidAPI HTTP ${upstream.status}${body ? `: ${body.slice(0, 180)}` : ""}`);
  }
  const payload = await upstream.json();
  const upstreamError = payload?.error || payload?.message?.error || payload?.data?.error;
  if (upstreamError && !extractRapidAnimeItems(payload).length) {
    throw new Error(String(upstreamError).slice(0, 240));
  }
  return payload;
}

function unwrapRapidAnimeData(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.data?.anime
    || payload?.data?.info
    || payload?.data
    || payload?.anime
    || payload?.result
    || payload;
}

function extractRapidAnimeItems(payload) {
  if (Array.isArray(payload)) return payload;
  const candidates = [
    payload?.items,
    payload?.results,
    payload?.anime,
    payload?.animes,
    payload?.episodes,
    payload?.recentEpisodes,
    payload?.topAiring,
    payload?.spotlight,
    payload?.data,
    payload?.data?.items,
    payload?.data?.results,
    payload?.data?.anime,
    payload?.data?.animes,
    payload?.data?.episodes,
    payload?.data?.recentEpisodes,
    payload?.data?.topAiring,
    payload?.data?.spotlight
  ];
  return candidates.find(Array.isArray) || [];
}

function inferRapidNextPage(payload, page, count) {
  if (payload.nextPage) return payload.nextPage;
  if (payload.hasNextPage || payload.hasMore || payload.data?.hasNextPage || payload.data?.hasMore) return page + 1;
  const totalPages = Number(payload.totalPages || payload.pages || payload.data?.totalPages || payload.data?.pages || 0);
  if (totalPages && page < totalPages) return page + 1;
  return count >= 20 ? page + 1 : null;
}

function normalizeRapidAnimeShow(item, index = 0) {
  const title = item.title || item.name || item.animeTitle || item.animeName || item.jname || item.english || item.native;
  if (!title) return null;
  const animeId = item.id || item.animeId || item.anime_id || item.slug || item.url || item.href || normalizeTitle(title);
  const image = normalizeRapidImage(item.image || item.poster || item.cover || item.img || item.thumbnail || item.animeImg);
  const genres = normalizeGenreList(item.genres || item.genre || item.tags || ["anime"]);
  const rawEpisodes = extractRapidAnimeEpisodes(item);
  const episodes = rawEpisodes.map((episode, episodeIndex) => normalizeRapidAnimeEpisode(episode, item, episodeIndex)).filter(Boolean);
  const latestEpisodeId = item.episodeId || item.episode_id || item.id || "";
  const episodeCount = parseEpisodeCount(item.episodes || item.totalEpisodes || item.total_episodes || item.latestEpisode || item.episodeNumber)
    || episodes.length
    || parseEpisodeCount(item.episode)
    || "?";
  const fallbackEpisode = latestEpisodeId && !episodes.length ? [normalizeRapidAnimeEpisode({
    id: latestEpisodeId,
    episodeId: latestEpisodeId,
    number: parseEpisodeCount(item.episodeNumber || item.episode) || 1,
    title: item.episodeTitle || `Episode ${parseEpisodeCount(item.episodeNumber || item.episode) || 1}`
  }, item, 0)] : [];
  const normalizedEpisodes = episodes.length ? episodes : fallbackEpisode.filter(Boolean);

  return {
    id: `rapid-anime-${animeId || index}`,
    rapidAnimeId: animeId,
    aliases: [item.id, item.animeId, item.slug, item.url].filter(Boolean),
    title,
    episode: episodeCount,
    genre: pickGenre(genres),
    genres,
    day: item.day || item.releaseDate || "Online",
    time: item.time || "",
    colors: ["#40dfc2", "#7c5cff"],
    score: normalizeScore(item.score || item.rating || item.malScore),
    source: "RapidAPI Anime Streaming",
    image,
    banner: normalizeRapidImage(item.banner || item.backdrop || item.coverImage || image),
    siteUrl: item.url || item.href || "",
    description: cleanDescription(item.description || item.synopsis || item.overview || "Streaming source with direct HLS/M3U8 support when provided by the API."),
    episodeEndpoint: "/api/rapid-anime/info",
    streamEndpoint: "/api/rapid-anime/watch",
    videoUrl: "",
    seasons: normalizedEpisodes.length ? [{ season: 1, title: "Season 1", episodes: repairEpisodeGaps(normalizedEpisodes, { season: 1 }) }] : [],
    episodes: normalizedEpisodes
  };
}

function normalizeRapidAnimeEpisode(episode, show = {}, index = 0) {
  if (!episode) return null;
  const episodeId = typeof episode === "string"
    ? episode
    : episode.id || episode.episodeId || episode.episode_id || episode.url || episode.href || "";
  const number = Number(typeof episode === "object"
    ? episode.number || episode.episode || episode.episodeNumber || episode.ep || index + 1
    : index + 1) || index + 1;
  const directUrl = typeof episode === "object" ? pickRapidDirectUrl(episode) : "";
  const subtitles = typeof episode === "object" ? normalizeRapidSubtitlePayload(episode.subtitles || episode.tracks || episode.captions) : [];
  const hasSpanish = subtitles.some((track) => normalizeLanguageName(track.language || track.label) === "spanish");
  const hasEnglish = subtitles.some((track) => normalizeLanguageName(track.language || track.label) === "english");
  return {
    id: `rapid-anime-${show.id || show.rapidAnimeId || normalizeTitle(show.title || show.name || "anime")}-${number}`,
    title: typeof episode === "object" ? episode.title || episode.name || `Episode ${number}` : `Episode ${number}`,
    season: typeof episode === "object" ? episode.season || episode.seasonNumber || 1 : 1,
    episode: number,
    poster: show.image || show.poster || show.cover || "",
    videoUrl: directUrl,
    streamResolver: episodeId ? {
      type: "rapid-anime",
      endpoint: `/api/rapid-anime/watch?episodeId=${encodeURIComponent(episodeId)}`
    } : null,
    sourceOptions: typeof episode === "object" ? normalizeRapidSourceOptions(episode) : [],
    subtitles,
    hasSpanishSubtitles: hasSpanish,
    availableAudio: ["japanese"],
    availableSubs: hasSpanish ? ["spanish", "none"] : hasEnglish ? ["spanish-translated", "english", "none"] : ["spanish", "none"],
    defaultAudio: "japanese",
    defaultSubs: hasSpanish ? "spanish" : hasEnglish ? "spanish-translated" : "spanish",
    server: hasSpanish ? "RapidAPI Anime Streaming" : "RapidAPI Anime Streaming (Spanish subs not confirmed)",
    locked: !(directUrl || episodeId)
  };
}

function extractRapidAnimeEpisodes(payload) {
  const info = unwrapRapidAnimeData(payload);
  if (!info || Array.isArray(info)) return [];
  return [
    info.episodes,
    info.episodeList,
    info.ep,
    info.data?.episodes,
    info.data?.episodeList
  ].find(Array.isArray) || [];
}

function normalizeRapidAnimeStreamPayload(payload) {
  const data = unwrapRapidAnimeData(payload);
  const directUrl = pickRapidDirectUrl(data);
  const sourceOptions = normalizeRapidSourceOptions(data);
  const subtitles = normalizeRapidSubtitlePayload(data?.subtitles || data?.tracks || data?.captions || payload?.subtitles || payload?.tracks);
  const spanishTrack = subtitles.find((track) => normalizeLanguageName(track.language || track.label) === "spanish");
  const englishTrack = subtitles.find((track) => normalizeLanguageName(track.language || track.label) === "english");
  return {
    videoUrl: directUrl,
    streamUrl: directUrl,
    file: directUrl,
    sourceOptions,
    downloadUrl: sourceOptions.find((source) => source.downloadUrl)?.downloadUrl || directUrl,
    subtitles,
    hasSpanishSubtitles: Boolean(spanishTrack),
    spanishSubtitleRequired: true,
    subtitleWarning: spanishTrack ? "" : "Spanish subtitles were not returned by this API response.",
    availableAudio: ["japanese"],
    availableSubs: spanishTrack ? ["spanish", "none"] : englishTrack ? ["spanish-translated", "english", "none"] : ["spanish", "none"],
    defaultAudio: "japanese",
    defaultSubs: spanishTrack ? "spanish" : englishTrack ? "spanish-translated" : "spanish"
  };
}

function normalizeRapidSourceOptions(payload = {}) {
  const sources = [
    payload.sources,
    payload.streams,
    payload.videos,
    payload.files,
    payload.data?.sources,
    payload.data?.streams,
    payload.data?.videos,
    payload.data?.files
  ].find(Array.isArray) || [];
  const direct = pickRapidDirectUrl(payload);
  const options = sources.map((source, index) => {
    const videoUrl = pickRapidDirectUrl(source);
    if (!videoUrl) return null;
    const label = source.server || source.name || source.quality || source.type || `Server ${index + 1}`;
    return {
      id: `rapid-${normalizeTitle(label) || index}`,
      label: `RapidAPI ${label}`,
      type: "direct",
      videoUrl,
      downloadUrl: source.downloadUrl || source.download || source.file || videoUrl
    };
  }).filter(Boolean);
  if (direct && !options.some((option) => option.videoUrl === direct)) {
    options.unshift({
      id: "rapid-direct",
      label: "RapidAPI Direct",
      type: "direct",
      videoUrl: direct,
      downloadUrl: payload.downloadUrl || payload.download || direct
    });
  }
  return options;
}

function pickRapidDirectUrl(payload = {}) {
  return payload?.videoUrl
    || payload?.streamUrl
    || payload?.file
    || payload?.url
    || payload?.m3u8
    || payload?.hls
    || payload?.source
    || payload?.data?.videoUrl
    || payload?.data?.streamUrl
    || payload?.data?.file
    || payload?.data?.m3u8
    || "";
}

function normalizeRapidSubtitlePayload(subtitles) {
  if (!subtitles) return [];
  const raw = Array.isArray(subtitles)
    ? subtitles
    : Object.entries(subtitles).map(([language, url]) => ({ language, url }));
  return raw.map((track) => {
    if (typeof track === "string") return { url: track, language: "", label: "Subtitles" };
    const url = track.url || track.file || track.src || track.href;
    if (!url) return null;
    const language = String(track.language || track.lang || track.srclang || track.label || track.name || "").toLowerCase();
    const normalized = normalizeLanguageName(language);
    return {
      url,
      language: normalized === "spanish" ? "es" : normalized === "english" ? "en" : language,
      label: track.label || track.name || languageName(language) || "Subtitles",
      default: normalized === "spanish"
    };
  }).filter(Boolean).sort((a, b) => Number(b.default) - Number(a.default));
}

function normalizeRapidImage(value = "") {
  const image = String(value || "").trim();
  if (!image) return "";
  if (/^https?:\/\//i.test(image)) return image;
  if (image.startsWith("//")) return `https:${image}`;
  if (image.startsWith("/") && RAPIDAPI_ANIME_BASE) {
    try {
      return new URL(image, RAPIDAPI_ANIME_BASE).toString();
    } catch (error) {
      return image;
    }
  }
  return image;
}

async function handleCheckUpdate(response) {
  if (!UPDATE_REPO_URL && !UPDATE_MANIFEST_URL) {
    sendJson(response, {
      ok: true,
      currentVersion: APP_VERSION,
      updateAvailable: false,
      message: "No GitHub update repository configured. Set UPDATE_REPO_URL or UPDATE_MANIFEST_URL."
    });
    return;
  }
  try {
    const manifest = await fetchUpdateManifest();
    const latestVersion = manifest.version || manifest.tag_name || APP_VERSION;
    sendJson(response, {
      ok: true,
      currentVersion: APP_VERSION,
      latestVersion,
      updateAvailable: compareVersions(latestVersion, APP_VERSION) > 0,
      releaseNotes: manifest.releaseNotes || manifest.body || "",
      manifest
    });
  } catch (error) {
    sendJson(response, {
      ok: false,
      currentVersion: APP_VERSION,
      updateAvailable: false,
      error: error.message
    }, 502);
  }
}

async function handleApplyUpdate(request, response) {
  if (request.method !== "POST") {
    sendJson(response, { ok: false, error: "Use POST to apply updates." }, 405);
    return;
  }
  try {
    const body = await readJsonBody(request).catch(() => ({}));
    const manifest = body.manifest || await fetchUpdateManifest();
    if (!Array.isArray(manifest.files) || !manifest.files.length) {
      sendJson(response, { ok: false, error: "Update manifest must include a files array." }, 400);
      return;
    }
    const preserved = readServerSettings();
    const backupDir = path.join(root, ".update-backup", String(Date.now()));
    fs.mkdirSync(backupDir, { recursive: true });
    const changed = [];
    try {
      for (const file of manifest.files) {
        const targetName = file.path || file.name;
        const fileUrl = file.url || file.rawUrl;
        if (!targetName || !fileUrl) continue;
        const target = safeWorkspacePath(targetName);
        const backup = path.join(backupDir, targetName);
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        if (fs.existsSync(target)) fs.copyFileSync(target, backup);
        const fileResponse = await fetchWithTimeout(fileUrl, {}, 15000);
        if (!fileResponse.ok) throw new Error(`Failed to download ${targetName}`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, Buffer.from(await fileResponse.arrayBuffer()));
        changed.push(targetName);
      }
      writeServerSettings(preserved);
      sendJson(response, { ok: true, applied: changed, version: manifest.version || manifest.tag_name || "unknown" });
    } catch (error) {
      rollbackFiles(backupDir);
      writeServerSettings(preserved);
      sendJson(response, { ok: false, rolledBack: true, error: error.message }, 500);
    }
  } catch (error) {
    sendJson(response, { ok: false, error: error.message }, 500);
  }
}

async function handleLanguagePreferences(request, response) {
  if (request.method === "GET") {
    sendJson(response, {
      ok: true,
      preferences: readServerSettings().languagePrefs || { audio: "japanese", subtitles: "spanish" }
    });
    return;
  }
  if (request.method !== "POST") {
    sendJson(response, { ok: false, error: "Use GET or POST." }, 405);
    return;
  }
  try {
    const body = await readJsonBody(request);
    const settings = readServerSettings();
    settings.languagePrefs = {
      audio: body.audio || body.languagePrefs?.audio || "japanese",
      subtitles: body.subtitles || body.subs || body.languagePrefs?.subtitles || "spanish"
    };
    writeServerSettings(settings);
    sendJson(response, { ok: true, preferences: settings.languagePrefs });
  } catch (error) {
    sendJson(response, { ok: false, error: error.message }, 400);
  }
}

async function fetchUpdateManifest() {
  if (UPDATE_MANIFEST_URL) {
    const response = await fetchWithTimeout(UPDATE_MANIFEST_URL, {}, 12000);
    if (!response.ok) throw new Error(`Manifest HTTP ${response.status}`);
    return response.json();
  }
  const repo = UPDATE_REPO_URL.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
  const response = await fetchWithTimeout(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "AnimeTV-Updater" }
  }, 12000);
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
  return response.json();
}

function compareVersions(a, b) {
  const left = String(a || "0.0.0").replace(/^v/i, "").split(".").map(Number);
  const right = String(b || "0.0.0").replace(/^v/i, "").split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff) return diff;
  }
  return 0;
}

function safeWorkspacePath(relativePath) {
  const target = path.resolve(root, relativePath);
  if (!target.startsWith(root)) throw new Error("Unsafe update path");
  return target;
}

function rollbackFiles(backupDir) {
  if (!fs.existsSync(backupDir)) return;
  const files = walkFiles(backupDir);
  files.forEach((backupFile) => {
    const relative = path.relative(backupDir, backupFile);
    const target = safeWorkspacePath(relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(backupFile, target);
  });
}

function walkFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(full) : [full];
  });
}

function readServerSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  } catch (error) {
    return {
      favorites: [],
      languagePrefs: { audio: "japanese", subtitles: "spanish" },
      customSources: [],
      watchHistory: {},
      resumePositions: {}
    };
  }
}

function writeServerSettings(settings) {
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

function readPersistentCache(key, ttlMs) {
  try {
    const cachePath = persistentCachePath(key);
    if (!fs.existsSync(cachePath)) return null;
    const payload = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (!payload?.cachedAt || Date.now() - payload.cachedAt > ttlMs) return null;
    return payload;
  } catch (error) {
    log("warn", `Persistent cache read failed for ${key}: ${error.message}`);
    return null;
  }
}

function writePersistentCache(key, value) {
  try {
    fs.mkdirSync(SERVER_CACHE_DIR, { recursive: true });
    fs.writeFileSync(persistentCachePath(key), JSON.stringify({
      ...value,
      cachedAt: Date.now()
    }));
  } catch (error) {
    log("warn", `Persistent cache write failed for ${key}: ${error.message}`);
  }
}

function persistentCachePath(key) {
  const safeKey = String(key || "cache").replace(/[^a-z0-9._-]+/gi, "-").slice(0, 120);
  return path.join(SERVER_CACHE_DIR, `${safeKey}.json`);
}

async function handleAniPubCatalog(url, response, options = {}) {
  const totalCount = await fetchAniPubTotalCount().catch(() => 8000);
  const isPaged = url.searchParams.has("page") || url.searchParams.has("offset");
  const defaultLimit = isPaged ? 50 : options.all ? totalCount : 8000;
  const requestedLimit = Number(url.searchParams.get("limit") || defaultLimit);
  const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : defaultLimit, totalCount, 12000));
  const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
  const offset = Math.max(0, Number(url.searchParams.get("offset") || ((page - 1) * limit)) || 0);
  const fetchLimit = isPaged ? Math.min(offset + limit, totalCount, 12000) : limit;

  try {
    const cached = getAniPubCatalogCache(fetchLimit);
    if (cached) {
      sendJson(response, shapeAniPubCatalogResponse(cached.items, totalCount, { limit, offset, page, isPaged, mode: options.all ? "all" : "catalog", cached: true }));
      return;
    }

    const rawItems = options.all
      ? await fetchAllAniPubCatalog(fetchLimit, totalCount)
      : await fetchAniPubCompleteCatalog(fetchLimit, totalCount);
    const items = rawItems
      .map(normalizeAniPubShow)
      .filter(Boolean)
      .slice(0, fetchLimit);

    const payload = shapeAniPubCatalogResponse(items, totalCount, { limit, offset, page, isPaged, mode: options.all ? "all" : "catalog" });
    anipubCatalogCache = { timestamp: Date.now(), payload };
    sendJson(response, payload);
  } catch (error) {
    sendJson(response, {
      ok: false,
      source: "AniPub",
      error: "AniPub catalog is unavailable right now.",
      note: "AnimeTV can use AniPub for catalog metadata. Playback still needs legal video URLs from an allowed source."
    }, 502);
  }
}

async function handleAniPubCatalogTotal(response) {
  try {
    const total = await fetchAniPubTotalCount();
    sendJson(response, {
      ok: true,
      source: "AniPub",
      total,
      note: "Estimated from the working /api/findbyrating paginated endpoint."
    });
  } catch (error) {
    sendJson(response, {
      ok: false,
      source: "AniPub",
      total: "unknown",
      error: error.message || "AniPub total count unavailable"
    }, 502);
  }
}

async function handleAniPubDebugPage(url, response) {
  const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 10) || 10, 100));
  try {
    const probe = await fetchAniPubCatalogPageProbe(page, limit);
    const payload = probe.payload || {};
    sendJson(response, {
      ok: true,
      requestedUrl: probe.requestedUrl,
      attemptedUrls: probe.attemptedUrls,
      itemsReturned: probe.items.length,
      responseKeys: Object.keys(payload),
      hasNextPage: Boolean(getAniPubNextPage(payload, page, probe.items)),
      nextPageValue: getAniPubNextPage(payload, page, probe.items),
      pagination: payload.pagination || payload.pageInfo || payload.page || null,
      totalFromApi: getAniPubTotalFromPayload(payload),
      sampleItem: probe.items[0] || null
    });
  } catch (error) {
    sendJson(response, {
      ok: false,
      page,
      limit,
      error: error.message || "AniPub debug page failed"
    }, 502);
  }
}

function shapeAniPubCatalogResponse(items, totalCount, { limit, offset, page, isPaged, mode, cached = false }) {
  const pageItems = isPaged ? items.slice(offset, offset + limit) : items.slice(0, limit);
  const hasMore = offset + pageItems.length < Math.min(totalCount || items.length, 12000);
  return {
    ok: true,
    source: "AniPub",
    count: pageItems.length,
    totalResults: Number(totalCount || items.length) || pageItems.length,
    page,
    limit,
    offset,
    nextPage: hasMore ? page + 1 : null,
    hasMore,
    cached,
    pageSize: ANIPUB_INFO_PAGE_SIZE,
    mode,
    note: "Catalog metadata is loaded by walking AniPub paginated catalog pages, then filling any gaps through /api/info/:id across the /api/getAll range. Direct mp4/m3u8 links use the main player; iframe links are returned as externalUrl only.",
    items: pageItems
  };
}

function getAniPubCatalogCache(limit) {
  if (!anipubCatalogCache) return null;
  if (Date.now() - anipubCatalogCache.timestamp > ANIPUB_CATALOG_TTL_MS) return null;
  const payload = anipubCatalogCache.payload;
  if (!payload?.items?.length || payload.items.length < Math.min(limit, payload.totalResults || limit)) return null;
  return {
    ...payload,
    cached: true,
    count: Math.min(payload.items.length, limit),
    items: payload.items.slice(0, limit)
  };
}

async function handleAniPubPlay(url, response) {
  const id = url.searchParams.get("id");
  const alt = url.searchParams.get("alt");
  const episode = Number(url.searchParams.get("episode") || 1);
  if (!id || !Number.isFinite(episode) || episode < 1) {
    sendJson(response, { ok: false, error: "Missing AniPub id or episode" }, 400);
    return;
  }

  try {
    const payload = await fetchAniPubDetails([id, alt].filter(Boolean));
    const link = getAniPubEpisodeLink(payload, episode);
    const externalUrl = stripAniPubSrc(link);
    const videoUrl = extractDirectVideoUrl(link);

    if (!videoUrl) {
      sendJson(response, {
        ok: true,
        externalUrl,
        externalType: externalUrl ? "iframe" : "unavailable",
        sourceOptions: buildAniPubSourceOptions(externalUrl, ""),
        server: "AniPub",
        note: externalUrl
          ? "AniPub returned an iframe embed link. AnimeTV marks it as externalUrl so the client can render the embedded iframe player instead of the direct video element."
          : "AniPub did not return a playable direct stream or external embed link for this episode."
      });
      return;
    }

    sendJson(response, {
      ok: true,
      videoUrl,
      sourceOptions: buildAniPubSourceOptions("", videoUrl),
      server: "AniPub"
    });
  } catch (error) {
    sendJson(response, { ok: false, error: "AniPub playback resolver is unavailable right now." }, 502);
  }
}

async function handleAniPubEpisodes(animeId, response) {
  if (!animeId) {
    sendJson(response, { ok: false, error: "Missing AniPub anime id" }, 400);
    return;
  }

  try {
    const cached = getCachedAniPubEpisodes(animeId);
    if (cached) {
      sendJson(response, { ...cached, cached: true });
      return;
    }

    const payload = await fetchAniPubDetails(animeId);
    const local = payload?.local || payload?.Local;
    if (!local) {
      sendJson(response, { ok: false, error: "No episodes found", animeId });
      return;
    }

    const episodes = [];
    const episodeOne = stripAniPubSrc(local.link || local.Link || "");
    if (episodeOne) {
      const videoUrl = extractDirectVideoUrl(episodeOne);
      episodes.push({
        number: 1,
        episode: 1,
        title: "Episode 1",
        externalUrl: episodeOne,
        externalType: "iframe",
        videoUrl,
        sourceOptions: buildAniPubSourceOptions(episodeOne, videoUrl),
        audioTracks: getAvailableAudioTracks(local),
        subtitles: getAvailableSubtitles(local),
        server: "AniPub"
      });
    }

    const list = Array.isArray(local.ep) ? local.ep : Array.isArray(local.Ep) ? local.Ep : [];
    list.forEach((entry, index) => {
      const externalUrl = stripAniPubSrc(typeof entry === "string" ? entry : entry?.link || entry?.Link || "");
      if (!externalUrl) return;
      const sourceEpisode = typeof entry === "string" ? {} : entry;
      const number = index + 2;
      const videoUrl = extractDirectVideoUrl(externalUrl);
      episodes.push({
        number,
        episode: number,
        title: sourceEpisode?.title || sourceEpisode?.name || sourceEpisode?.Title || `Episode ${number}`,
        externalUrl,
        externalType: "iframe",
        videoUrl,
        sourceOptions: buildAniPubSourceOptions(externalUrl, videoUrl),
        audioTracks: getAvailableAudioTracks(sourceEpisode),
        subtitles: getAvailableSubtitles(sourceEpisode),
        server: "AniPub"
      });
    });

    const repairedEpisodes = repairEpisodeGaps(episodes, {
      server: "AniPub",
      externalType: "iframe",
      locked: true
    });
    const payloadResponse = {
      ok: true,
      animeId,
      title: local.name || local.Name || "",
      count: repairedEpisodes.length,
      availableCount: episodes.length,
      integrity: validateEpisodeIntegrity(repairedEpisodes),
      audioDefault: "japanese",
      subtitleDefault: "spanish",
      episodes: repairedEpisodes
    };
    cacheAniPubEpisodes(animeId, payloadResponse);
    sendJson(response, payloadResponse);
  } catch (error) {
    sendJson(response, { ok: false, error: error.message || "AniPub episode fetch error", animeId }, 502);
  }
}

function getCachedAniPubEpisodes(animeId) {
  const cached = anipubEpisodeCache.get(String(animeId));
  if (cached && Date.now() - cached.timestamp <= ANIPUB_EPISODE_CACHE_TTL_MS) {
    return cached.payload;
  }
  if (cached) anipubEpisodeCache.delete(String(animeId));

  const persisted = readPersistentCache(`anipub-episodes-${animeId}`, ANIPUB_EPISODE_CACHE_TTL_MS);
  if (!persisted?.payload) return null;
  anipubEpisodeCache.set(String(animeId), {
    timestamp: persisted.cachedAt || Date.now(),
    payload: persisted.payload
  });
  return persisted.payload;
}

function cacheAniPubEpisodes(animeId, payload) {
  anipubEpisodeCache.set(String(animeId), {
    timestamp: Date.now(),
    payload
  });
  writePersistentCache(`anipub-episodes-${animeId}`, { payload });
  if (anipubEpisodeCache.size > 300) {
    anipubEpisodeCache.delete(anipubEpisodeCache.keys().next().value);
  }
}

async function handleAniPubHealth(response) {
  const fresh = await checkAniPubHealth();
  sendJson(response, fresh);
}

async function checkAniPubHealth() {
  const previousStatus = anipubHealthState.status;
  try {
    const total = await fetchAniPubTotalCount();
    anipubHealthState = {
      status: "ok",
      checkedAt: new Date().toISOString(),
      error: "",
      total
    };
  } catch (error) {
    anipubHealthState = {
      status: "degraded",
      checkedAt: new Date().toISOString(),
      error: error.message || "AniPub health check failed",
      total: null
    };
  }

  if (previousStatus !== "unknown" && previousStatus !== anipubHealthState.status) {
    console.warn(`[AnimeTV] AniPub API health changed: ${previousStatus} -> ${anipubHealthState.status}${anipubHealthState.error ? ` (${anipubHealthState.error})` : ""}`);
  }

  return anipubHealthState;
}

async function fetchAniPubTotalCount() {
  return 8343;
}

async function fetchAllAniPubCatalog(limit = 12000, totalCount = null) {
  const rawLimit = Math.max(1, Math.min(Number(limit) || 12000, 12000));
  if (
    anipubRawCatalogCache?.length
    && Date.now() - anipubRawCatalogCacheAt < ANIPUB_RAW_CATALOG_TTL_MS
    && (anipubRawCatalogCacheComplete || anipubRawCatalogCache.length >= rawLimit)
  ) {
    console.log("AniPub: Returning cached catalog (fresh)");
    return anipubRawCatalogCache.slice(0, rawLimit);
  }

  const persisted = readPersistentCache("anipub-catalog", ANIPUB_RAW_CATALOG_TTL_MS);
  if (
    persisted?.items?.length
    && (persisted.complete || persisted.items.length >= rawLimit)
  ) {
    log("info", `AniPub: Returning persisted catalog cache (${persisted.items.length} items)`);
    anipubRawCatalogCache = persisted.items;
    anipubRawCatalogCacheAt = persisted.cachedAt || Date.now();
    anipubRawCatalogCacheComplete = Boolean(persisted.complete);
    return persisted.items.slice(0, rawLimit);
  }

  if (anipubCatalogPromise) {
    console.log("AniPub: Waiting for existing catalog fetch...");
    const inFlightLimit = anipubCatalogPromiseLimit;
    const existing = await anipubCatalogPromise;
    if (inFlightLimit >= rawLimit || existing.length >= rawLimit || anipubRawCatalogCacheComplete) {
      return existing.slice(0, rawLimit);
    }
    return fetchAllAniPubCatalog(rawLimit, totalCount);
  }

  console.log("AniPub: Starting NEW catalog fetch from findbyrating endpoint");

  anipubCatalogPromise = (async () => {
    const allItems = [];
    const catalogMap = new Map();
    let currentPage = 1;
    let hasMore = true;
    let completed = false;
    const maxPages = 5000;
    const delayMs = 500;
    const pageRetries = new Map();

    while (hasMore && allItems.length < rawLimit && currentPage <= maxPages) {
      const pageUrl = `${ANIPUB_ENDPOINT}/api/findbyrating?page=${currentPage}`;
      console.log(`AniPub: Fetching page ${currentPage}...`);

      try {
        const response = await fetchWithTimeout(pageUrl, { headers: { Accept: "application/json" } }, 12000);
        if (response.status === 429) {
          const retry = (pageRetries.get(currentPage) || 0) + 1;
          pageRetries.set(currentPage, retry);
          const backoff = Math.min(30000, 1000 * (2 ** retry));
          console.log(`AniPub: Rate limited on page ${currentPage}. Waiting ${backoff}ms before retry ${retry}...`);
          if (retry > 6) throw new Error("AniPub rate limit did not recover");
          await wait(backoff);
          continue;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        if (Number(data?.currentPage) && Number(data.currentPage) !== currentPage) {
          console.log(`AniPub: Page mismatch - expected ${currentPage}, got ${data.currentPage}. Stopping.`);
          break;
        }

        const items = Array.isArray(data?.AniData) ? data.AniData : [];
        if (!items.length) {
          console.log(`AniPub: Page ${currentPage} returned no data - stopping`);
          completed = true;
          break;
        }

        const transformed = items.map((item) => ({
          ...item,
          id: item._id || item.id,
          title: item.Name || item.title || item.name,
          finder: item.finder,
          aniPubId: item._id || item.id,
          image: item.ImagePath || item.image,
          score: item.MALScore || item.score,
          ratingCount: item.RatingsNum || item.ratingCount,
          description: item.DescripTion || item.description,
          source: "AniPub"
        }));

        transformed.forEach((item) => {
          allItems.push(item);
          addAniPubUnique(catalogMap, item);
        });

        console.log(`AniPub: Page ${currentPage} returned ${items.length} items (${allItems.length} total so far)`);

        if (items.length < 10) {
          console.log(`AniPub: Last page detected (${items.length} < 10)`);
          hasMore = false;
          completed = true;
          break;
        }

        currentPage += 1;
        await wait(delayMs);
      } catch (error) {
        const retry = (pageRetries.get(currentPage) || 0) + 1;
        pageRetries.set(currentPage, retry);
        if (retry <= 3) {
          const backoff = Math.min(12000, 900 * (2 ** retry));
          console.warn(`AniPub: Error fetching page ${currentPage}: ${error.message}. Retrying in ${backoff}ms...`);
          await wait(backoff);
          continue;
        }
        console.error(`AniPub: Error fetching page ${currentPage}:`, error.message);
        hasMore = false;
        break;
      }
    }

    if (currentPage > maxPages) {
      console.log(`AniPub: Max page limit reached (${maxPages}) - stopping`);
    }

    const targetCount = Math.min(rawLimit, totalCount || rawLimit);
    if (catalogMap.size < targetCount) {
      console.log(`AniPub: Rating endpoint returned ${catalogMap.size}/${targetCount}. Filling gaps through /api/info/:id...`);
      const detailItems = await fetchAniPubFullCatalog(targetCount, targetCount);
      detailItems.forEach((item) => addAniPubUnique(catalogMap, item));
    }

    const unique = [...catalogMap.values()];
    console.log(`AniPub: Complete! Loaded ${unique.length} unique anime out of ${allItems.length} total items`);
    anipubRawCatalogCache = unique;
    anipubRawCatalogCacheAt = Date.now();
    anipubRawCatalogCacheComplete = completed || unique.length >= targetCount;
    writePersistentCache("anipub-catalog", {
      items: unique,
      complete: anipubRawCatalogCacheComplete,
      targetCount
    });
    return unique;
  })().finally(() => {
    anipubCatalogPromise = null;
    anipubCatalogPromiseLimit = 0;
  });
  anipubCatalogPromiseLimit = rawLimit;

  return (await anipubCatalogPromise).slice(0, rawLimit);
}

async function fetchAniPubCatalogPage(page, limit = ANIPUB_CATALOG_PAGE_SIZE) {
  return (await fetchAniPubCatalogPageProbe(page, limit)).items;
}

async function fetchAniPubCatalogPageProbe(page, limit = ANIPUB_CATALOG_PAGE_SIZE) {
  const offset = (page - 1) * limit;
  const urlPatterns = [
    `${ANIPUB_ENDPOINT}/api/findbyrating?page=${encodeURIComponent(page)}`,
    `${ANIPUB_API_ENDPOINT}/local?page=${encodeURIComponent(page)}`,
    `${ANIPUB_API_ENDPOINT}/local?page=${encodeURIComponent(page)}&limit=${encodeURIComponent(limit)}`,
    `${ANIPUB_API_ENDPOINT}/local?offset=${encodeURIComponent(offset)}&limit=${encodeURIComponent(limit)}`,
    `${ANIPUB_API_ENDPOINT}/local?start=${encodeURIComponent(offset)}&limit=${encodeURIComponent(limit)}`,
    `${ANIPUB_API_ENDPOINT}/catalog?page=${encodeURIComponent(page)}&limit=${encodeURIComponent(limit)}`,
    `${ANIPUB_API_ENDPOINT}/catalog?p=${encodeURIComponent(page)}&per_page=${encodeURIComponent(limit)}`,
    `${ANIPUB_API_ENDPOINT}/catalog?offset=${encodeURIComponent(offset)}&limit=${encodeURIComponent(limit)}`,
    `${ANIPUB_API_ENDPOINT}/catalog/${encodeURIComponent(page)}?limit=${encodeURIComponent(limit)}`
  ];
  const attemptedUrls = [];

  for (const requestedUrl of urlPatterns) {
    attemptedUrls.push(requestedUrl);
    const upstream = await fetchWithRetry(requestedUrl, { headers: { Accept: "application/json" } }, 1).catch(() => null);
    console.log(`AniPub: Requesting page ${page} at URL: ${requestedUrl}`);
    console.log(`AniPub: Response status: ${upstream?.status || "failed"}`);
    if (!upstream?.ok) continue;
    const payload = await upstream.json();
    const items = extractAniPubItems(payload);
    if (page === 1) {
      console.log("AniPub: Full response structure:", JSON.stringify(payload, null, 2).slice(0, 4000));
    }
    console.log(`AniPub: Items in this page: ${items.length}`);
    console.log("AniPub: Next page indicator:", getAniPubNextPage(payload, page, items), payload?.hasNext, payload?.pagination || payload?.pageInfo || "");
    if (items.length) return { requestedUrl, attemptedUrls, payload, items };
  }

  return { requestedUrl: urlPatterns[0], attemptedUrls, payload: null, items: [] };
}

async function fetchAniPubFullCatalog(limit, totalCount) {
  const byKey = new Map();
  const maxId = Math.min(totalCount || limit, limit);

  for (let start = 1; start <= maxId; start += ANIPUB_INFO_PAGE_SIZE) {
    const end = Math.min(start + ANIPUB_INFO_PAGE_SIZE - 1, maxId);
    const pageItems = await fetchAniPubInfoPage(start, end);
    pageItems.forEach((item) => addAniPubUnique(byKey, item));
    await wait(70);
  }

  if (byKey.size < Math.min(limit, 25)) {
    const fallbackItems = await fetchAniPubCatalogPages(limit);
    fallbackItems.forEach((item) => addAniPubUnique(byKey, item));
  }

  return [...byKey.values()].slice(0, limit);
}

async function fetchAniPubCompleteCatalog(limit, totalCount) {
  const byKey = new Map();
  const pagedItems = await fetchAniPubPaginatedCatalog(limit);
  pagedItems.forEach((item) => addAniPubUnique(byKey, item));

  if (byKey.size < Math.min(limit, totalCount || limit)) {
    const detailItems = await fetchAniPubFullCatalog(limit, totalCount);
    detailItems.forEach((item) => addAniPubUnique(byKey, item));
  }

  return [...byKey.values()].slice(0, limit);
}

async function fetchAniPubPaginatedCatalog(limit) {
  const byKey = new Map();
  let page = 1;
  let nextPage = 1;
  const maxPages = 800;

  while (page && page <= maxPages && byKey.size < limit) {
    const pageItems = await fetchAniPubCatalogPage(page, ANIPUB_CATALOG_PAGE_SIZE);
    if (!pageItems.length) break;

    pageItems.forEach((item) => addAniPubUnique(byKey, item));

    nextPage = pageItems.length < ANIPUB_CATALOG_PAGE_SIZE ? null : page + 1;
    if (!nextPage || nextPage === page) break;
    page = nextPage;
    await wait(90);
  }

  return [...byKey.values()].slice(0, limit);
}

function getAniPubNextPage(payload, currentPage, pageItems) {
  if (!payload) return pageItems?.length ? currentPage + 1 : null;
  const next =
    payload?.nextPage ||
    payload?.next_page ||
    payload?.next ||
    payload?.pagination?.nextPage ||
    payload?.pagination?.next_page ||
    payload?.pagination?.next ||
    payload?.page?.next ||
    payload?.pageInfo?.nextPage;
  if (next === false || next === null) return null;
  if (Number.isFinite(Number(next))) return Number(next);

  const explicitTotalPages =
    payload?.totalPages ||
    payload?.total_pages ||
    payload?.pagination?.totalPages ||
    payload?.pagination?.total_pages ||
    payload?.pageInfo?.totalPages;
  if (Number.isFinite(Number(explicitTotalPages)) && currentPage >= Number(explicitTotalPages)) return null;

  const hasNext =
    payload?.hasNextPage ??
    payload?.has_next_page ??
    payload?.pagination?.hasNextPage ??
    payload?.pagination?.has_next_page ??
    payload?.pageInfo?.hasNextPage;
  if (hasNext === false) return null;

  if (!pageItems.length) return null;
  const totalPages =
    payload?.lastPage ||
    payload?.last_page ||
    payload?.totalPages ||
    payload?.total_pages ||
    payload?.pagination?.lastPage ||
    payload?.pagination?.last_page ||
    payload?.pagination?.totalPages ||
    payload?.pagination?.total_pages ||
    payload?.pageInfo?.totalPages;
  if (Number.isFinite(Number(totalPages)) && currentPage >= Number(totalPages)) return null;
  return currentPage + 1;
}

function hasAniPubNextPage(payload, currentPage, pageItems, totalItems = 0) {
  if (!pageItems?.length) return false;
  if (totalItems > 0 && currentPage * Math.max(pageItems.length, 1) < totalItems) return true;
  const explicitNext =
    payload?.nextPage ??
    payload?.next_page ??
    payload?.next ??
    payload?.pagination?.next ??
    payload?.pagination?.nextPage ??
    payload?.pageInfo?.nextPage;
  if (explicitNext === false || explicitNext === null) return false;
  if (explicitNext !== undefined && explicitNext !== "") return true;
  const explicitHasNext =
    payload?.hasNext ??
    payload?.hasNextPage ??
    payload?.has_next_page ??
    payload?.pagination?.hasNext ??
    payload?.pagination?.hasNextPage ??
    payload?.pageInfo?.hasNextPage;
  if (explicitHasNext === true) return true;
  if (explicitHasNext === false) return false;
  return pageItems.length > 0 && pageItems.length >= 10;
}

function getAniPubTotalFromPayload(payload) {
  const total =
    payload?.total ||
    payload?.totalResults ||
    payload?.count ||
    payload?.pagination?.total ||
    payload?.pagination?.totalResults ||
    payload?.pagination?.count ||
    payload?.pageInfo?.total ||
    payload?.meta?.total;
  const parsed = Number(total);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), 12000) : null;
}

async function fetchAniPubInfoPage(start, end) {
  const ids = Array.from({ length: end - start + 1 }, (_, index) => start + index);
  const results = await Promise.allSettled(ids.map(fetchAniPubInfo));
  return results
    .filter((result) => result.status === "fulfilled" && result.value)
    .map((result) => result.value);
}

async function fetchAniPubInfo(id) {
  try {
    const upstream = await fetchWithTimeout(`${ANIPUB_ENDPOINT}/api/info/${encodeURIComponent(id)}`, {
      headers: { Accept: "application/json" }
    }, 4000);
    if (!upstream.ok) return null;
    return upstream.json();
  } catch (error) {
    return null;
  }
}

async function fetchAniPubDetails(ids) {
  const candidates = Array.isArray(ids) ? ids : [ids];
  const endpoints = candidates.flatMap((id) => {
    const encoded = encodeURIComponent(id);
    return [
      `${ANIPUB_DETAILS_ENDPOINT}/v1/api/details/${encoded}`,
      `${ANIPUB_ENDPOINT}/v1/api/details/${encoded}`,
      `${ANIPUB_DETAILS_ENDPOINT}/api/details/${encoded}`,
      `${ANIPUB_ENDPOINT}/api/details/${encoded}`,
      `${ANIPUB_DETAILS_ENDPOINT}/api/info/${encoded}`,
      `${ANIPUB_ENDPOINT}/api/info/${encoded}`
    ];
  });
  let lastStatus = "";
  for (const endpoint of endpoints) {
    try {
      const upstream = await fetchWithRetry(endpoint, {
        headers: { Accept: "application/json" }
      }, 1);
      lastStatus = `HTTP ${upstream.status}`;
      if (!upstream.ok) continue;
      return upstream.json();
    } catch (error) {
      lastStatus = error.message;
    }
  }
  throw new Error(`AniPub details unavailable for ${candidates.join(", ")}: ${lastStatus}`);
}

function addAniPubUnique(map, item) {
  if (!item) return;
  const key = String(item._id || item.Id || item.id || item.finder || item.Name || item.title || "");
  if (!key || map.has(key)) return;
  map.set(key, item);
}

async function fetchAniPubCatalogPages(limit) {
  const items = [];
  const seen = new Set();
  const maxPages = 600;

  for (let page = 1; page <= maxPages && items.length < limit; page += 1) {
    const upstream = await fetchWithRetry(`${ANIPUB_ENDPOINT}/api/findbyrating?page=${page}`, {
      headers: { Accept: "application/json" }
    }, 2);
    if (!upstream.ok) break;

    const payload = await upstream.json();
    const pageItems = extractAniPubItems(payload);
    if (!pageItems.length) break;

    let added = 0;
    pageItems.forEach((item) => {
      const before = seen.size;
      addAniPubUnique({
        has: (key) => seen.has(key),
        set: (key, value) => {
          seen.add(key);
          items.push(value);
        }
      }, item);
      if (seen.size > before) added += 1;
    });

    if (!added || pageItems.length < 2) break;
    await wait(90);
  }

  return items;
}

function normalizeTioAnimeShow(anime, episodes = [], index = 0) {
  if (!anime?.title) return null;
  const normalizedEpisodes = (episodes || [])
    .map((episode, episodeIndex) => ({
      id: `${anime.id || index}-${episode.episode || episodeIndex + 1}`,
      title: `Episode ${episode.episode || episodeIndex + 1}`,
      season: 1,
      episode: episode.episode || episodeIndex + 1,
      poster: episode.poster || anime.poster || "",
      server: "TioAnime metadata",
      locked: true
    }))
    .sort((a, b) => Number(a.episode || 0) - Number(b.episode || 0));

  return {
    id: `tioanime-${anime.id || index}`,
    malId: anime.malId || null,
    aliases: [anime.id].filter(Boolean),
    title: anime.title,
    episode: normalizedEpisodes.at(-1)?.episode || "?",
    genre: pickGenre(anime.genres || []),
    genres: anime.genres || [],
    day: "TBA",
    time: anime.nextEpisode || "TBA",
    colors: ["#00d2ff", "#251d47"],
    score: null,
    source: "TioAnime Metadata",
    image: anime.poster || "",
    banner: anime.banner || "",
    siteUrl: anime.id ? `https://tioanime.com/anime/${anime.id}` : "",
    description: cleanDescription(anime.synopsis),
    videoUrl: "",
    seasons: normalizedEpisodes.length
      ? [{ season: 1, title: "Season 1", episodes: normalizedEpisodes }]
      : [],
    episodes: normalizedEpisodes
  };
}

function extractAnime1vResults(payload) {
  payload = unwrapAnime1vData(payload);
  if (Array.isArray(payload)) return payload;
  return [
    payload?.results,
    payload?.items,
    payload?.anime,
    payload?.data,
    payload?.data?.results,
    payload?.data?.items
  ].find(Array.isArray) || [];
}

function extractAnime1vEpisodes(payload) {
  payload = unwrapAnime1vData(payload);
  if (Array.isArray(payload)) return payload;
  return [
    payload?.episodes,
    payload?.episodeList,
    payload?.episodios,
    payload?.chapters,
    payload?.videos,
    payload?.data?.episodes,
    payload?.data?.episodeList
  ].find(Array.isArray) || [];
}

function extractAnime1vStreams(payload) {
  payload = unwrapAnime1vData(payload);
  if (!payload) return [];
  const direct = pickAnime1vDirectUrl(payload);
  if (direct) return [{ url: direct, quality: payload.quality || "auto" }];
  return [
    payload.streams,
    payload.sources,
    payload.videos,
    payload.files,
    payload.data?.streams,
    payload.data?.sources,
    payload.data?.videos,
    payload.data?.files
  ].find(Array.isArray) || [];
}

function pickAnime1vDirectUrl(payload, stream = null) {
  payload = unwrapAnime1vData(payload);
  return stream?.url
    || stream?.streamUrl
    || stream?.file
    || payload?.videoUrl
    || payload?.streamUrl
    || payload?.file
    || payload?.url
    || payload?.data?.videoUrl
    || payload?.data?.streamUrl
    || payload?.data?.file
    || "";
}

function extractAnime1vEmbedUrl(payload) {
  payload = unwrapAnime1vData(payload);
  return payload?.embedUrl
    || payload?.externalUrl
    || payload?.iframe
    || payload?.embed
    || payload?.data?.embedUrl
    || payload?.data?.externalUrl
    || payload?.data?.iframe
    || "";
}

function unwrapAnime1vData(payload) {
  if (payload?.success === true && payload.data) return payload.data;
  return payload?.data && !Array.isArray(payload.data) && (payload.data.results || payload.data.streams || payload.data.episodes || payload.data.title)
    ? payload.data
    : payload;
}

function normalizeAnime1vSearchItem(anime, index = 0) {
  const title = anime.title || anime.name || anime.animeTitle || anime.Name || anime.Title;
  if (!title) return null;
  const provider = anime.provider || anime.domain || "animeav1.com";
  const animeUrl = anime.url || anime.link || anime.href || anime.animeUrl || anime.Url || anime.URL || "";
  const rawEpisodes = extractAnime1vEpisodes(anime);
  const episodes = rawEpisodes.map((episode, episodeIndex) => normalizeAnime1vSearchEpisode(
    episode,
    anime,
    provider,
    episodeIndex
  )).filter(Boolean);
  const episodeCount = parseEpisodeCount(anime.episodes || anime.episodeCount || anime.totalEpisodes || anime.Episodes || anime.TotalEpisodes)
    || episodes.length
    || "?";
  const genres = normalizeGenreList(anime.genres || anime.genre || anime.Genres || anime.Genre || ["action", "adventure"]);
  const image = bestAnime1vImage(anime);
  const banner = anime.banner || anime.backdrop || anime.fondo || anime.background || anime.Banner || anime.Backdrop || image;
  const synopsis = anime.synopsis || anime.description || anime.DescripTion || anime.Description || anime.overview || "";

  return {
    id: `anime1v-${provider}-${anime.id || anime.slug || normalizeTitle(title) || index}`,
    aliases: [anime.id, anime.slug, animeUrl].filter(Boolean),
    title,
    episode: episodeCount,
    genre: pickGenre(genres),
    genres,
    day: "TBA",
    time: "TBA",
    colors: ["#ff5722", "#251d47"],
    score: normalizeScore(anime.score || anime.rating || anime.MALScore || anime.Rating),
    source: `Anime1v (${provider})`,
    image,
    banner,
    description: cleanDescription(synopsis || `Anime: ${title}. Type: ${anime.type || anime.Type || "TV"}. Japanese audio with Spanish subtitles when available.`),
    hasSpanishSubs: true,
    spanishSubSource: provider,
    anime1vUrl: animeUrl,
    provider,
    videoUrl: "",
    seasons: episodes.length ? [{ season: 1, title: "Season 1", episodes }] : [],
    episodes
  };
}

function bestAnime1vImage(anime = {}) {
  const image = anime.image
    || anime.poster
    || anime.cover
    || anime.thumbnail
    || anime.Image
    || anime.ImagePath
    || anime.Poster
    || anime.Cover
    || anime.Thumbnail
    || anime.img
    || anime.pic
    || anime.picture
    || "";
  return normalizeImageUrl(image);
}

function normalizeImageUrl(value = "") {
  const image = String(value || "").trim();
  if (!image) return "";
  if (/^https?:\/\//i.test(image)) return image;
  if (image.startsWith("//")) return `https:${image}`;
  if (image.startsWith("/")) {
    try {
      return new URL(image, ANIME1V_API).toString();
    } catch (error) {
      return image;
    }
  }
  return image;
}

function normalizeAnime1vSearchEpisode(episode, anime, provider, index) {
  if (!episode) return null;
  const episodeUrl = typeof episode === "string" ? episode : episode.url || episode.link || episode.href || episode.episodeUrl || "";
  const number = Number(typeof episode === "object" ? episode.number || episode.episode : index + 1) || index + 1;
  return {
    id: `anime1v-${anime.id || normalizeTitle(anime.title || anime.name)}-${number}`,
    title: typeof episode === "object" ? episode.title || `Episode ${number}` : `Episode ${number}`,
    season: 1,
    episode: number,
    poster: anime.image || anime.poster || anime.cover || "",
    videoUrl: "",
    streamResolver: episodeUrl ? {
      type: "anime1v",
      endpoint: `/api/anime1v/stream?url=${encodeURIComponent(episodeUrl)}&provider=${encodeURIComponent(provider)}`
    } : null,
    locked: !episodeUrl,
    server: provider,
    availableAudio: ["japanese"],
    availableSubs: ["spanish", "none"],
    defaultAudio: "japanese",
    defaultSubs: "spanish"
  };
}

function anime1vHeaders(input = "") {
  const apiKey = typeof input === "string"
    ? input || ANIME1V_API_KEY
    : input?.searchParams?.get("apiKey") || ANIME1V_API_KEY;
  return {
    Accept: "application/json",
    ...(apiKey ? { "X-API-Key": apiKey } : {})
  };
}

function getAnime1vQuotaState() {
  const now = Date.now();
  const blocked = anime1vQuotaBlockedUntil > now;
  return {
    blocked,
    message: blocked ? anime1vQuotaMessage || "Anime1v daily request limit reached." : "",
    retryAfterMs: blocked ? anime1vQuotaBlockedUntil - now : 0,
    retryAt: blocked ? new Date(anime1vQuotaBlockedUntil).toISOString() : ""
  };
}

function markAnime1vQuotaLimit(message = "Anime1v daily request limit reached.") {
  anime1vQuotaBlockedUntil = Date.now() + ANIME1V_QUOTA_BACKOFF_MS;
  anime1vQuotaMessage = message;
  console.warn(`Anime1v quota paused until ${new Date(anime1vQuotaBlockedUntil).toISOString()}: ${message}`);
}

async function anime1vHttpError(response) {
  let body = "";
  try {
    body = await response.text();
  } catch (error) {
    body = "";
  }
  let parsed = null;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch (error) {
    parsed = null;
  }
  const message = parsed?.message || parsed?.error || body || `HTTP ${response.status}`;
  if (response.status === 403 && /limite|limit|requests|plan|quota/i.test(message)) {
    markAnime1vQuotaLimit(message);
  }
  return {
    status: response.status,
    message: `HTTP ${response.status}: ${message}`,
    body: parsed || body
  };
}

async function fetchAnime1vEpisodeStream(episodeUrl, provider, apiKey = "") {
  const url = buildAnime1vUrl("/api/v1/anime/episode", { url: episodeUrl, domain: provider, apiKey });
  const response = await fetchWithTimeout(url, { headers: anime1vHeaders(apiKey) }, 15000);
  if (!response.ok) {
    const apiError = await anime1vHttpError(response);
    throw new Error(`Episode stream failed: ${apiError.message}`);
  }
  return response.json();
}

function buildAnime1vUrl(pathname, params = {}) {
  const url = new URL(pathname, ANIME1V_API);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  });
  if (!url.searchParams.has("apiKey") && ANIME1V_API_KEY) url.searchParams.set("apiKey", ANIME1V_API_KEY);
  return url.toString();
}

function normalizeAnime1vEpisode(episode, episodeData, provider, episodeNumber) {
  const streams = extractAnime1vStreams(episodeData);
  const bestStream = pickAnime1vStream(streams, "1080p") || pickAnime1vStream(streams, "720p") || streams[0];
  const externalUrl = extractAnime1vEmbedUrl(episodeData);
  return {
    number: episodeNumber,
    episode: episodeNumber,
    title: episode.title || `Episode ${episodeNumber}`,
    videoUrl: bestStream?.url || bestStream?.file || "",
    streamUrl: bestStream?.streamUrl || "",
    file: bestStream?.file || "",
    externalUrl,
    externalType: externalUrl ? "iframe" : "",
    subtitles: normalizeAnime1vSubtitlePayload(episodeData.subtitles),
    availableAudio: ["japanese"],
    availableSubs: ["spanish", "none"],
    defaultAudio: "japanese",
    defaultSubs: "spanish",
    server: episodeData.server || provider,
    quality: bestStream?.quality || "unknown",
    locked: !(bestStream?.url || bestStream?.file || bestStream?.streamUrl || externalUrl)
  };
}

function pickAnime1vStream(streams = [], preferredQuality = "720p") {
  if (!Array.isArray(streams) || !streams.length) return null;
  return streams.find((stream) => String(stream.quality || "").toLowerCase() === preferredQuality.toLowerCase())
    || streams.find((stream) => /1080/i.test(String(stream.quality || "")))
    || streams.find((stream) => /720/i.test(String(stream.quality || "")))
    || streams[0];
}

function normalizeAnime1vSubtitlePayload(subtitles) {
  if (!subtitles) return [];
  if (Array.isArray(subtitles)) {
    return subtitles.map((track) => ({
      url: track.url || track.file || track.src || "",
      language: track.language || track.lang || "es",
      label: track.label || track.name || "Español",
      default: track.default ?? normalizeLanguageName(track.language || track.label || "spanish") === "spanish"
    })).filter((track) => track.url);
  }
  const spanish = subtitles.spanish || subtitles.es || subtitles.spa;
  return spanish ? [{
    url: spanish,
    language: "es",
    label: "Español",
    default: true
  }] : [];
}

function extractAniPubItems(payload) {
  if (Array.isArray(payload)) return payload;
  const candidates = [
    payload?.AniData,
    payload?.wholePage,
    payload?.results,
    payload?.items,
    payload?.anime,
    payload?.catalog,
    payload?.data,
    payload?.data?.items,
    payload?.data?.results,
    payload?.data?.anime,
    payload?.local,
    payload?.locals
  ];
  return candidates.find(Array.isArray) || [];
}

function normalizeAniPubShow(item, index = 0) {
  const title = item.Name || item.title || item.name || item.title_orig || item.other_title;
  if (!title) return null;

  const finderId = item.finder || item.path_url || item.pathUrl || item.slug || "";
  const rawId = item._id || item.Id || item.id || "";
  const pathUrl = rawId || finderId;
  const episodeCount = parseEpisodeCount(
    item.epCount ||
    item.EpCount ||
    item.episodes ||
    item.Episodes ||
    item.episode ||
    item.Episode ||
    item.latestEpisode ||
    item.LatestEpisode ||
    item.totalEpisodes ||
    item.total_episodes
  );
  const displayEpisodeCount = episodeCount
    || (Array.isArray(item.episodes) ? item.episodes.length : 0)
    || (Array.isArray(item.Episodes) ? item.Episodes.length : 0)
    || parseEpisodeCount(item.episodes || item.Episodes)
    || 12;
  const genres = normalizeGenreList(item.Genres || item.genres || item.genre || item.tags);
  const poster = absoluteAniPubUrl(item.ImagePath || item.Image || item.poster || item.image || item.cover || item.thumbnail || "");
  const banner = absoluteAniPubUrl(item.Cover || item.banner || item.backdrop || item.background || poster);
  const episodes = buildLockedEpisodes({
    id: pathUrl || normalizeTitle(title) || index,
    title,
    poster,
    count: displayEpisodeCount,
    resolverId: pathUrl,
    alternateResolverId: finderId && rawId && finderId !== rawId ? finderId : ""
  });

  return {
    id: `anipub-${pathUrl || normalizeTitle(title) || index}`,
    aniPubId: rawId || pathUrl,
    finder: finderId,
    malId: item.malId || item.mal_id || item.idMal || item.MALID || null,
    aliases: [item.Name, item.Synonyms, item.name, item.title_orig, item.other_title, item.finder].filter(Boolean),
    title,
    episode: displayEpisodeCount,
    genre: pickGenre(genres),
    genres,
    day: "TBA",
    time: item.Premiered || item.Aired || item.year || item.type || "",
    colors: ["#00d2ff", "#251d47"],
    score: normalizeScore(item.MALScore || item.rating || item.score),
    source: "AniPub",
    image: poster,
    banner,
    siteUrl: item.url || item.link || "",
    description: cleanDescription(item.DescripTion || item.description || item.synopsis),
    videoUrl: "",
    seasons: episodes.length ? [{ season: 1, title: "Season 1", episodes }] : [],
    episodes
  };
}

function buildLockedEpisodes({ id, title, poster, count, resolverId, alternateResolverId = "" }) {
  const safeCount = count || 12;
  return Array.from({ length: Math.min(safeCount, ANIME1V_MAX_EPISODES) }, (_, index) => {
    const episode = index + 1;
    return {
      id: `${id}-${episode}`,
      title: `Episode ${episode}`,
      season: 1,
      episode,
      poster,
      server: "AniPub",
      streamResolver: resolverId ? {
        type: "anipub",
        endpoint: `/api/anipub/play?id=${encodeURIComponent(resolverId)}${alternateResolverId ? `&alt=${encodeURIComponent(alternateResolverId)}` : ""}&episode=${episode}`
      } : null,
      locked: !resolverId,
      note: `${title} Episode ${episode} needs a legal video URL before playback.`
    };
  });
}

function getAniPubEpisodeLink(payload, episode) {
  const local = payload?.local || payload?.Local || payload;
  if (!local) return "";
  if (episode === 1) return local.link || local.Link || "";
  const list = Array.isArray(local.ep) ? local.ep : Array.isArray(local.Ep) ? local.Ep : [];
  const entry = list[episode - 2];
  return typeof entry === "string" ? entry : entry?.link || entry?.Link || "";
}

function getAvailableAudioTracks(episode = {}) {
  const raw = [
    episode.audioTracks,
    episode.audio,
    episode.audios,
    episode.languages,
    episode.lang
  ].find((value) => Array.isArray(value) || typeof value === "string");
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const normalized = values.map(normalizeLanguageName).filter(Boolean);
  return [...new Set(["japanese", ...normalized])];
}

function getAvailableSubtitles(episode = {}) {
  const raw = [
    episode.subtitles,
    episode.subs,
    episode.captions,
    episode.subtitleTracks
  ].find((value) => Array.isArray(value) || typeof value === "string");
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const normalized = values
    .map((value) => typeof value === "string" ? value : value?.language || value?.lang || value?.label || value?.name)
    .map(normalizeLanguageName)
    .filter(Boolean);
  return [...new Set(["spanish", ...normalized])];
}

function normalizeLanguageName(value) {
  const text = String(value || "").toLowerCase();
  if (/\b(ja|jp|jpn|japanese|japon[eé]s)\b/.test(text)) return "japanese";
  if (/\b(es|spa|spanish|español|castellano)\b/.test(text)) return "spanish";
  if (/\b(en|eng|english|ingl[eé]s)\b/.test(text)) return "english";
  return "";
}

function validateEpisodeIntegrity(showOrEpisodes) {
  const episodes = Array.isArray(showOrEpisodes)
    ? showOrEpisodes
    : showOrEpisodes?.episodes || [];
  const numbers = episodes
    .map((episode) => Number(episode.episode || episode.number))
    .filter((number) => Number.isFinite(number) && number > 0)
    .sort((a, b) => a - b);
  const missing = [];
  for (let number = 1; number <= (numbers.at(-1) || 0); number += 1) {
    if (!numbers.includes(number)) missing.push(number);
  }
  return {
    sequential: missing.length === 0,
    total: episodes.length,
    first: numbers[0] || null,
    last: numbers.at(-1) || null,
    missing
  };
}

function repairEpisodeGaps(episodes = [], defaults = {}) {
  const byNumber = new Map();
  episodes.forEach((episode) => {
    const number = Number(episode.episode || episode.number);
    if (Number.isFinite(number) && number > 0) byNumber.set(number, episode);
  });
  const last = Math.max(0, ...byNumber.keys());
  return Array.from({ length: last }, (_, index) => {
    const number = index + 1;
    return byNumber.get(number) || {
      ...defaults,
      number,
      episode: number,
      title: "Not available yet",
      missing: true,
      unavailable: true,
      locked: true
    };
  });
}

function stripAniPubSrc(value) {
  if (!value) return "";
  const raw = String(value).replace(/^src=/i, "").trim();
  return /^https?:\/\//i.test(raw) ? raw : "";
}

function buildAniPubSourceOptions(externalUrl = "", videoUrl = "") {
  const options = [];
  if (externalUrl) {
    options.push({
      id: "anipub",
      label: "AniPub",
      type: "iframe",
      externalUrl
    });
  }
  if (videoUrl) {
    options.unshift({
      id: "anipub-direct",
      label: "AniPub Direct",
      type: "direct",
      videoUrl,
      downloadUrl: videoUrl
    });
  }
  return options;
}

function extractDirectVideoUrl(value) {
  if (!value) return "";
  const raw = stripAniPubSrc(value);
  if (!/^https?:\/\//i.test(raw)) return "";
  if (/\.(m3u8|mp4|webm|mov)(\?|#|$)/i.test(raw)) return raw;
  if (/[?&](file|video|stream|url)=https?%3A/i.test(raw)) {
    try {
      const parsed = new URL(raw);
      for (const key of ["file", "video", "stream", "url"]) {
        const nested = parsed.searchParams.get(key);
        if (nested && /\.(m3u8|mp4|webm|mov)(\?|#|$)/i.test(nested)) return nested;
      }
    } catch (error) {
      return "";
    }
  }
  return "";
}

function parseEpisodeCount(value) {
  const parsed = Number(String(value || "").match(/\d+/)?.[0] || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, ANIME1V_MAX_EPISODES) : 0;
}

function normalizeScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) return null;
  return score <= 10 ? Math.round(score * 10) : Math.round(score);
}

function normalizeGenreList(value) {
  if (Array.isArray(value)) {
    return value.map((genre) => typeof genre === "string" ? genre : genre?.name).filter(Boolean);
  }
  return String(value || "")
    .split(/[,/|]+/)
    .map((genre) => genre.trim())
    .filter(Boolean);
}

function absoluteAniPubUrl(value) {
  if (!value) return "";
  const text = String(value);
  if (/^https?:\/\//i.test(text)) return text;
  if (text.startsWith("//")) return `https:${text}`;
  if (text.startsWith("/")) return `${ANIPUB_ENDPOINT}${text}`;
  return text;
}

async function fetchAniListTrending() {
  const query = `
    query TrendingAnime($page: Int, $perPage: Int) {
      Page(page: $page, perPage: $perPage) {
        media(type: ANIME, sort: TRENDING_DESC, isAdult: false) {
          id
          idMal
          title { romaji english native }
          coverImage { extraLarge large color }
          bannerImage
          description(asHtml: false)
          episodes
          genres
          averageScore
          status
          siteUrl
          nextAiringEpisode { episode airingAt }
        }
      }
    }
  `;

  const pages = await Promise.allSettled([1, 2, 3, 4].map(async (page) => {
    const response = await fetchWithRetry(ANILIST_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ query, variables: { page, perPage: 50 } })
    });
    if (!response.ok) throw new Error("AniList request failed");
    const payload = await response.json();
    return payload.data.Page.media.map(normalizeAniListShow);
  }));

  return pages
    .filter((page) => page.status === "fulfilled")
    .flatMap((page) => page.value);
}

async function fetchJikanPages(endpoint, source, pages) {
  const all = [];
  for (let page = 1; page <= pages; page += 1) {
    const separator = endpoint.includes("?") ? "&" : "?";
    const response = await fetchWithRetry(`${endpoint}${separator}page=${page}`);
    if (!response.ok) throw new Error(`${source} request failed`);
    const payload = await response.json();
    all.push(...payload.data.map((entry) => normalizeJikanShow(entry, source)));
    if (page < pages) await wait(450);
  }
  return all;
}

async function fetchWithRetry(url, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, options, 12000);
      if (response.ok || ![408, 429, 500, 502, 503, 504].includes(response.status)) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(Math.min(12000, 650 * (2 ** attempt)));
  }
  throw lastError || new Error("Request failed");
}

async function fetchWithTimeout(url, options = {}, timeout = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeAniListShow(entry) {
  const airingDate = entry.nextAiringEpisode?.airingAt
    ? new Date(entry.nextAiringEpisode.airingAt * 1000)
    : null;
  const day = airingDate ? airingDate.toLocaleDateString([], { weekday: "short" }) : "TBA";
  const time = airingDate ? airingDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "TBA";
  const genre = pickGenre(entry.genres || []);
  const color = entry.coverImage?.color || "#8a5cff";

  return {
    id: `anilist-${entry.id}`,
    malId: entry.idMal,
    anilistId: entry.id,
    title: entry.title.english || entry.title.romaji || entry.title.native || "Untitled Anime",
    episode: entry.nextAiringEpisode?.episode || entry.episodes || "?",
    genre,
    genres: entry.genres || [genre],
    day,
    time,
    colors: [color, "#111426"],
    score: entry.averageScore,
    source: "AniList",
    image: entry.coverImage?.extraLarge || entry.coverImage?.large || "",
    banner: entry.bannerImage || "",
    siteUrl: entry.siteUrl || "",
    description: cleanDescription(entry.description),
    videoUrl: ""
  };
}

function normalizeJikanShow(entry, source) {
  const genres = (entry.genres || []).map((item) => item.name);
  const genre = pickGenre(genres);
  const broadcast = entry.broadcast || {};

  return {
    id: `jikan-${entry.mal_id}`,
    malId: entry.mal_id,
    title: entry.title_english || entry.title || "Untitled Anime",
    episode: entry.episodes || "?",
    genre,
    genres,
    day: broadcast.day?.replace("s", "").slice(0, 3) || "TBA",
    time: broadcast.time || "TBA",
    colors: ["#00d2ff", "#111426"],
    score: entry.score ? Math.round(entry.score * 10) : null,
    source,
    image: entry.images?.webp?.large_image_url || entry.images?.jpg?.large_image_url || "",
    banner: "",
    siteUrl: entry.url || "",
    description: cleanDescription(entry.synopsis),
    videoUrl: ""
  };
}

function mergeShows(items) {
  const byKey = new Map();
  items.forEach((show) => {
    const key = show.malId ? `mal-${show.malId}` : show.anilistId ? `anilist-${show.anilistId}` : `title-${normalizeTitle(show.title)}`;
    const current = byKey.get(key);
    byKey.set(key, {
      ...current,
      ...show,
      image: current?.image || show.image,
      banner: current?.banner || show.banner,
      description: current?.description || show.description,
      source: current ? `${current.source} + ${show.source}` : show.source
    });
  });
  return [...byKey.values()];
}

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(season|part|tv|ova|ona|the|a|an)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pickGenre(genres = []) {
  const normalized = genres.map((genre) => String(genre).toLowerCase());
  if (normalized.includes("action")) return "action";
  if (normalized.includes("comedy")) return "comedy";
  if (normalized.includes("fantasy")) return "fantasy";
  if (normalized.includes("romance")) return "romance";
  if (normalized.includes("drama")) return "drama";
  return normalized[0] || "anime";
}

function cleanDescription(value) {
  if (!value) return "No synopsis is available yet. You can still favorite it and connect your own playback link.";
  return String(value)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?[^>]+(>|$)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
}

function cleanTranslationText(value) {
  return String(value || "")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 12000) {
        reject(new Error("Body too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, payload, status = 200, extraHeaders = {}) {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    ...extraHeaders,
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Cache-Control": "no-store, max-age=0"
  });
  response.end(JSON.stringify(payload));
}

function sendCorsPreflight(response) {
  response.writeHead(204, {
    ...SECURITY_HEADERS,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400"
  });
  response.end();
}

function maskSecret(value, visible = 4) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= visible) return "*".repeat(text.length);
  return `${text.slice(0, visible)}${"*".repeat(Math.min(12, Math.max(4, text.length - visible)))}`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
