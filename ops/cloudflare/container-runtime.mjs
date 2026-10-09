export const CONTAINER_PORT = 8080;
export const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
export const INTERNAL_ORIGIN = "https://container-backend.invalid";
const ENV_KEYS = ["TMDB_API_KEY", "TMDB_V3_API_KEY", "TMDB_READ_ACCESS_TOKEN", "TMDB_API_READ_ACCESS_TOKEN", "TMDB_V4_TOKEN",
  "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY",
  "ANIME1V_API", "ANIME1V_API_KEY", "TIOANIME_API", "CONSUMET_API", "CONSUMET_PROVIDER",
  "RAPIDAPI_ANIME_KEY", "RAPIDAPI_ANIME_HOST", "RAPIDAPI_ANIME_BASE", "X_RAPIDAPI_KEY", "X_RAPIDAPI_HOST"];

export function containerEnvironment(env) {
  const values = { NODE_ENV: "production", PORT: String(CONTAINER_PORT), HOST: "0.0.0.0",
    ZENKAI_HOSTED_RUNTIME: "1", ANIME1V_AUTO_START: "false",
    CORS_ORIGINS: "https://zenkaitv-container-staging.juankisantiago.workers.dev" };
  for (const key of ENV_KEYS) {
    if (typeof env[key] === "string" && env[key].trim()) {
      if (env[key].includes("\0")) throw new Error("Invalid container configuration");
      values[key] = env[key];
    }
  }
  for (const key of ["SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY"]) {
    if (!values[key]) continue;
    const value = values[key];
    let publicKey = value.startsWith("sb_publishable_");
    if (!publicKey && value.split(".").length === 3) {
      try {
        const payload = value.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
        publicKey = JSON.parse(atob(payload)).role === "anon";
      } catch { /* Reject an unrecognized key rather than exposing it via /api/config. */ }
    }
    if (!publicKey) throw new Error("Only public Supabase keys may reach the browser configuration");
  }
  return values;
}

function waitForCaller(promise, signal) {
  if (signal.aborted) return Promise.reject(new DOMException("Request cancelled", "AbortError"));
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Request cancelled", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export class ContainerBackend {
  constructor(container, env, { readinessTimeoutMs = 20000, probeDelayMs = 200 } = {}) {
    this.container = container;
    this.env = env;
    this.readinessTimeoutMs = readinessTimeoutMs;
    this.probeDelayMs = probeDelayMs;
    this.ready = false;
    this.startup = null;
  }

  ensureReady() {
    if (this.ready && this.container?.running) return Promise.resolve();
    if (this.startup) return this.startup;
    this.ready = false;
    this.startup = this.startAndProbe().then(() => { this.ready = true; })
      .finally(() => { this.startup = null; });
    return this.startup;
  }

  async startAndProbe() {
    if (!this.container) throw new Error("Container unavailable");
    if (!this.container.running) {
      this.container.start({ enableInternet: true, env: containerEnvironment(this.env) });
      await this.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    }
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), this.readinessTimeoutMs);
    try {
      const port = this.container.getTcpPort(CONTAINER_PORT);
      while (!controller.signal.aborted) {
        try {
          const response = await port.fetch("http://container/api/health", { signal: controller.signal });
          if (response.ok) {
            const health = await response.json();
            if (health.ok === true && health.app === "ZenkaiTV" && health.api === "ready") return;
          } else await response.body?.cancel();
        } catch { /* Probe the local listening port only, never replay a provider request. */ }
        if (!controller.signal.aborted) await new Promise((resolve) => setTimeout(resolve, this.probeDelayMs));
      }
      throw new Error("Container startup timed out");
    } finally { clearTimeout(deadline); }
  }

  async fetch(request) {
    request.signal.throwIfAborted();
    const url = new URL(request.url);
    if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) {
      return new Response(null, { status: 404 });
    }
    try { await waitForCaller(this.ensureReady(), request.signal); }
    catch (error) {
      if (error.name === "AbortError") throw error;
      return Response.json({ ok: false, error: "Backend startup temporarily unavailable" },
        { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "10" } });
    }
    request.signal.throwIfAborted();
    url.protocol = "http:";
    url.host = "container";
    // A failed playback request is never replayed here; the existing player owns fallback selection.
    try { return await this.container.getTcpPort(CONTAINER_PORT).fetch(new Request(url.href, request)); }
    catch (error) { this.ready = false; throw error; }
  }
}
