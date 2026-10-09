// Keep parity with vercel.json; the migration tests reject header drift.
export const SECURITY_HEADERS = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://www.gstatic.com https://cdn.vercel-insights.com; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' data:; img-src 'self' data: blob: http: https:; media-src 'self' blob: http: https:; connect-src 'self' http: https: ws: wss:; frame-src 'self' http: https: blob:; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "autoplay=*, fullscreen=*, picture-in-picture=*, camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), xr-spatial-tracking=()"
};
const PUBLIC_CACHE_TTLS = new Map([
  ["/api/image", 86400],
  ["/api/catalog", 300],
  ["/api/skip-times", 300]
]);
const HOP_HEADERS = ["host", "connection", "keep-alive", "transfer-encoding", "upgrade",
  "proxy-authorization", "proxy-authenticate", "trailer", "te"];

function secureResponse(response, extraHeaders = {}, encodeBody = "automatic") {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries({ ...SECURITY_HEADERS,
    "X-Robots-Tag": "noindex, nofollow", ...extraHeaders })) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers, encodeBody });
}

function errorResponse(status, error, extraHeaders = {}) {
  return secureResponse(Response.json({ ok: false, error }, { status }), {
    "Cache-Control": "no-store", ...extraHeaders
  });
}

export function isScannerPath(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return true; }
  return /(?:^|\/)(?:\.env[^/]*|\.git|wp-admin|wp-includes|vendor|cgi-bin)(?:\/|$)/i.test(decoded)
    || /\/(?:wp-login\.php|xmlrpc\.php)$/i.test(decoded);
}

function backendOrigin(env, incoming) {
  const backend = new URL(env.BACKEND_ORIGIN);
  if (backend.protocol !== "https:" || backend.username || backend.password
    || backend.pathname !== "/" || backend.search || backend.hash
    || backend.hostname === incoming.hostname) throw new Error("Invalid backend origin");
  return backend;
}

function publicCacheRequest(request, url) {
  return request.method === "GET" && PUBLIC_CACHE_TTLS.has(url.pathname)
    && !["authorization", "cookie", "range", "if-none-match", "if-modified-since"].some((key) => request.headers.has(key))
    && ![...url.searchParams.keys()].some((key) => /^(?:refresh|force|nocache|no-cache|bypass)$/i.test(key));
}

export function publicCacheTtl(response, pathname) {
  if (response.status !== 200 || response.headers.has("set-cookie")) return 0;
  const policy = response.headers.get("cache-control") || "";
  if (!/(?:^|,)\s*public\b/i.test(policy) || /\b(?:private|no-store|no-cache)\b/i.test(policy)) return 0;
  const vary = (response.headers.get("vary") || "").split(",").map((value) => value.trim().toLowerCase());
  if (vary.some((value) => value && value !== "accept-encoding")) return 0;
  const type = response.headers.get("content-type") || "";
  if (pathname === "/api/image" ? !/^image\//i.test(type) : !/application\/json/i.test(type)) return 0;
  const length = Number(response.headers.get("content-length"));
  if (!response.headers.has("content-length") || !Number.isSafeInteger(length) || length <= 0 || length > 16 * 1024 * 1024) return 0;
  const maxAge = Number(policy.match(/(?:^|,)\s*(?:s-maxage)=(\d+)/i)?.[1]
    ?? policy.match(/(?:^|,)\s*max-age=(\d+)/i)?.[1] ?? 0);
  return Math.min(maxAge, PUBLIC_CACHE_TTLS.get(pathname) || 0);
}

function forwardHeaders(request) {
  const headers = new Headers(request.headers);
  const connectionHeaders = (headers.get("connection") || "").split(",").map((value) => value.trim()).filter(Boolean);
  const clientIp = request.cf ? headers.get("cf-connecting-ip") : null;
  for (const name of [...HOP_HEADERS, ...connectionHeaders,
    "forwarded", "x-forwarded-for", "x-real-ip", "x-forwarded-host", "x-forwarded-proto", "cf-connecting-ip"]) headers.delete(name);
  if (clientIp) headers.set("x-forwarded-for", clientIp);
  headers.set("x-zenkai-gateway", "cloudflare-staging");
  return headers;
}

export async function handleGateway(request, env, ctx, { fetchImpl = fetch, cache = globalThis.caches?.default, containerMedia = false } = {}) {
  const url = new URL(request.url);
  if (isScannerPath(url.pathname)) return errorResponse(404, "Not found");
  if (url.hostname === "zenkaitv.com" || url.hostname === "www.zenkaitv.com") {
    return errorResponse(503, "This configuration is staging-only");
  }
  if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) {
    return secureResponse(await env.ASSETS.fetch(request));
  }
  let backend;
  try { backend = backendOrigin(env, url); } catch { return errorResponse(503, "Staging backend is not configured safely"); }
  backend.pathname = url.pathname;
  backend.search = url.search;

  // Keep video bytes on the established media backend during the free staging phase.
  if (url.pathname === "/api/source") {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": "Range, Content-Type",
      "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
      "Cache-Control": "no-store"
    };
    if (request.method === "OPTIONS") return secureResponse(new Response(null, { status: 204 }), cors);
    if (request.method !== "GET" && request.method !== "HEAD") return errorResponse(405, "Method not allowed", { Allow: "GET, HEAD, OPTIONS" });
    if (!containerMedia) return secureResponse(new Response(null, { status: 307, headers: { Location: backend.href } }), cors);
  }
  const cacheable = publicCacheRequest(request, url);
  const keyUrl = new URL(url);
  // Cache API bodies lose fetch's compressed-stream passthrough metadata.
  // Isolate encodings and return cached bytes without compressing them twice.
  keyUrl.searchParams.append("__zenkai_gateway_encoding_v1", request.headers.get("accept-encoding") || "identity");
  const key = cacheable ? new Request(keyUrl.href, { method: "GET" }) : null;
  if (key && cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return secureResponse(hit, { "X-Zenkai-Gateway-Cache": "HIT" }, "manual");
    } catch { /* Cache availability must not block the existing API. */ }
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  const timer = setTimeout(abort, containerMedia ? 60000 : 30000);
  const cleanup = () => {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
  };
  const started = performance.now();
  let upstream;
  try {
    upstream = await fetchImpl(backend.href, {
      method: request.method, headers: forwardHeaders(request),
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual", signal: controller.signal
    });
  } catch {
    cleanup();
    return errorResponse(controller.signal.aborted ? 504 : 502, "Backend temporarily unavailable", { "Retry-After": "10" });
  } finally {
    clearTimeout(timer);
    if (!containerMedia) request.signal.removeEventListener("abort", abort);
  }
  if ((!containerMedia || url.pathname !== "/api/source") && /^(?:video\/|audio\/)|mpegurl/i.test(upstream.headers.get("content-type") || "")) {
    cleanup();
    await upstream.body?.cancel();
    return errorResponse(502, "Media delivery must use the existing media backend");
  }
  const headers = new Headers(upstream.headers);
  for (const name of HOP_HEADERS) headers.delete(name);
  const location = headers.get("location");
  if (location) {
    const redirect = new URL(location, backend);
    if (redirect.origin === backend.origin) headers.set("location", redirect.pathname + redirect.search + redirect.hash);
  }
  // Container fetches carry opaque Node bytes, not fetch's compression metadata.
  // Keep disconnect cancellation attached until the stream ends, without buffering it.
  let body = upstream.body;
  if (containerMedia && body) {
    const reader = body.getReader();
    body = new ReadableStream({
      async pull(stream) {
        try {
          const result = await reader.read();
          if (result.done) { cleanup(); stream.close(); }
          else stream.enqueue(result.value);
        } catch (error) { cleanup(); stream.error(error); }
      },
      async cancel(reason) {
        abort();
        cleanup();
        await reader.cancel(reason);
      }
    });
  } else cleanup();
  const response = secureResponse(new Response(body, { status: upstream.status, headers }), {
    "X-Zenkai-Gateway-Cache": cacheable ? "MISS" : "BYPASS",
    "Server-Timing": `gateway;dur=${Math.round(performance.now() - started)}`
  }, containerMedia ? "manual" : "automatic");
  const ttl = cacheable ? publicCacheTtl(response, url.pathname) : 0;
  if (ttl && cache && ctx?.waitUntil) {
    const cached = response.clone();
    cached.headers.set("cache-control", `public, max-age=${ttl}`);
    cached.headers.delete("server-timing");
    ctx.waitUntil(cache.put(key, cached).catch(() => {}));
  }
  return response;
}

export default { fetch: handleGateway };
