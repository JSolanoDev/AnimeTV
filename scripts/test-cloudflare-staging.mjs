import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";
import { handleGateway, isScannerPath, publicCacheTtl, SECURITY_HEADERS } from "../ops/cloudflare/gateway.mjs";

const ENV = { BACKEND_ORIGIN: "https://backend.example" };
const request = (path, init) => new Request("https://staging.example" + path, init);
const json = (status = 200, headers = {}) => new Response('{"ok":true}', { status, headers: {
  "Content-Type": "application/json", "Content-Length": "11", "Cache-Control": "public, max-age=300", ...headers
} });
function cacheFixture() {
  const entries = new Map();
  const tasks = [];
  return {
    entries,
    cache: { match: async (key) => entries.get(key.url)?.clone(),
      put: async (key, value) => { entries.set(key.url, value.clone()); } },
    ctx: { waitUntil: (task) => tasks.push(task) },
    flush: async () => { for (const task of tasks) await task; }
  };
}

test("API target stays fixed; path, query, body and authentication contracts survive", async () => {
  let call;
  const response = await handleGateway(request("/api/language/preferences?next=https%3A%2F%2Fother.example", {
    method: "POST", body: "language=sub", headers: { Authorization: "Bearer fixture", Cookie: "session=fixture" }
  }), ENV, null, { fetchImpl: async (url, init) => {
    call = { url, init };
    return json(200, { "Cache-Control": "private, no-store", "Set-Cookie": "session=fresh; Secure; Path=/" });
  } });
  assert.equal(new URL(call.url).origin, ENV.BACKEND_ORIGIN);
  assert.equal(new URL(call.url).searchParams.get("next"), "https://other.example");
  assert.equal(call.init.method, "POST");
  assert.equal(await new Response(call.init.body).text(), "language=sub");
  assert.equal(call.init.headers.get("authorization"), "Bearer fixture");
  assert.equal(call.init.headers.get("cookie"), "session=fixture");
  assert.equal(call.init.redirect, "manual");
  assert.equal(response.headers.get("set-cookie"), "session=fresh; Secure; Path=/");
  assert.equal(response.headers.get("x-zenkai-gateway-cache"), "BYPASS");
});

test("security headers match the live configuration; player framing and Cast SDK stay allowed", async () => {
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  const original = Object.fromEntries(config.headers.find((rule) => rule.source === "/(.*)").headers
    .filter((header) => header.key.toLowerCase() !== "cache-control").map((header) => [header.key, header.value]));
  assert.deepEqual(SECURITY_HEADERS, original);
  const response = await handleGateway(request("/api/health"), ENV, null, { fetchImpl: async () => json() });
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(response.headers.get(name), value);
  assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.match(response.headers.get("content-security-policy"), /https:\/\/www\.gstatic\.com/);
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
});

test("safe catalog GETs reuse a response, including the full query in the cache key", async () => {
  const fixture = cacheFixture();
  let count = 0;
  const opts = { cache: fixture.cache, fetchImpl: async () => { count++; return json(); } };
  assert.equal((await handleGateway(request("/api/catalog?page=1"), ENV, fixture.ctx, opts)).headers.get("x-zenkai-gateway-cache"), "MISS");
  await fixture.flush();
  assert.equal((await handleGateway(request("/api/catalog?page=1"), ENV, fixture.ctx, opts)).headers.get("x-zenkai-gateway-cache"), "HIT");
  await handleGateway(request("/api/catalog?page=2"), ENV, fixture.ctx, opts);
  assert.equal(count, 2);
});

test("cache hits preserve origin browser policy, validators and age despite a zone TTL override", async () => {
  const fixture = cacheFixture();
  const policy = "public, max-age=120, s-maxage=600, stale-while-revalidate=900";
  const opts = { cache: fixture.cache, fetchImpl: async () => json(200, {
    "Cache-Control": policy, ETag: '"fixture-v1"', "Last-Modified": "Sun, 11 Oct 2026 00:00:00 GMT"
  }) };
  await handleGateway(request("/api/catalog"), ENV, fixture.ctx, opts);
  await fixture.flush();
  const cached = [...fixture.entries.values()][0];
  assert.equal(cached.headers.get("cache-control"), "public, max-age=300, s-maxage=300");
  cached.headers.set("cache-control", "public, max-age=14400");
  cached.headers.set("x-zenkai-cache-stored-at", String(Date.now() - 5000));
  const hit = await handleGateway(request("/api/catalog"), ENV, fixture.ctx, opts);
  assert.equal(hit.headers.get("x-zenkai-gateway-cache"), "HIT");
  assert.equal(hit.headers.get("cache-control"), policy);
  assert.ok(Number(hit.headers.get("age")) >= 5);
  assert.equal(hit.headers.get("etag"), '"fixture-v1"');
  assert.equal(hit.headers.get("last-modified"), "Sun, 11 Oct 2026 00:00:00 GMT");
  for (const name of ["policy", "stored-at", "expires-at"]) assert.equal(hit.headers.has("x-zenkai-cache-" + name), false);
});

test("explicit expiry rejects stale entries even if zone settings keep them in cache", async () => {
  const fixture = cacheFixture();
  let count = 0;
  const opts = { cache: fixture.cache, fetchImpl: async () => { count++; return json(); } };
  await handleGateway(request("/api/catalog"), ENV, fixture.ctx, opts);
  await fixture.flush();
  [...fixture.entries.values()][0].headers.set("x-zenkai-cache-expires-at", String(Date.now() - 1));
  const response = await handleGateway(request("/api/catalog"), ENV, fixture.ctx, opts);
  assert.equal(response.headers.get("x-zenkai-gateway-cache"), "MISS");
  assert.equal(count, 2);
});

test("a cached response carries upstream Age forward instead of resetting its freshness", async () => {
  const fixture = cacheFixture();
  const opts = { cache: fixture.cache, fetchImpl: async () => json(200, { Age: "100" }) };
  await handleGateway(request("/api/catalog"), ENV, fixture.ctx, opts);
  await fixture.flush();
  const hit = await handleGateway(request("/api/catalog"), ENV, fixture.ctx, opts);
  assert.ok(Number(hit.headers.get("age")) >= 100);
});

function metadata(payload, headers = {}, status = 200) {
  const body = JSON.stringify(payload);
  return new Response(body, { status, headers: { "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body)), "Cache-Control": "public, max-age=120, s-maxage=3600", ...headers } });
}

test("small successful anonymous metadata uses short route-specific TTLs, without changing payloads", async () => {
  const cases = [
    ["/api/tmdb/search?q=fixture", { ok: true, configured: true, results: [{ id: 1 }] }, 300],
    ["/api/tmdb/tv?id=1&lang=es", { ok: true, configured: true, show: { id: 1 } }, 300],
    ["/api/tmdb/season?id=1&season=2", { ok: true, configured: true, season: { episodes: [{ id: 1 }] } }, 300],
    ["/api/anilist/airing", { ok: true, items: [{ airingAt: 1791763200 }] }, 120],
    ["/api/animeav1/latest", { ok: true, items: [{ id: "fixture" }] }, 60]
  ];
  for (const [path, payload, ttl] of cases) {
    const fixture = cacheFixture();
    let count = 0;
    const opts = { cache: fixture.cache, fetchImpl: async () => { count++; return metadata(payload); } };
    const first = await handleGateway(request(path), ENV, fixture.ctx, opts);
    assert.deepEqual(await first.json(), payload);
    await fixture.flush();
    assert.equal([...fixture.entries.values()][0].headers.get("cache-control"), `public, max-age=${ttl}, s-maxage=${ttl}`);
    const hit = await handleGateway(request(path), ENV, fixture.ctx, opts);
    assert.equal(hit.headers.get("x-zenkai-gateway-cache"), "HIT");
    assert.deepEqual(await hit.json(), payload);
    assert.equal(count, 1);
  }
});

test("equivalent parameter order reuses metadata; year, language, season and adult flags stay isolated", async () => {
  const fixture = cacheFixture();
  let count = 0;
  const opts = { cache: fixture.cache, fetchImpl: async () => { count++; return metadata({ ok: true, results: [{ id: count }] }); } };
  await (await handleGateway(request("/api/tmdb/search?q=fixture&type=tv&year=2026&adult=0"), ENV, fixture.ctx, opts)).text();
  await fixture.flush();
  const same = await handleGateway(request("/api/tmdb/search?adult=0&year=2026&type=tv&q=fixture"), ENV, fixture.ctx, opts);
  assert.equal(same.headers.get("x-zenkai-gateway-cache"), "HIT");
  for (const query of ["year=2025&adult=0", "year=2026&adult=1", "year=2026&adult=0&lang=es", "year=2026&adult=0&season=2"]) {
    await (await handleGateway(request("/api/tmdb/search?q=fixture&type=tv&" + query), ENV, fixture.ctx, opts)).text();
    await fixture.flush();
  }
  assert.equal(count, 5);
});

test("unavailable, stale, unconfigured, missing, empty and oversized metadata never become cached successes", async () => {
  const cases = [
    metadata({ ok: false, results: [{ id: 1 }] }),
    metadata({ ok: true, configured: false, results: [] }),
    metadata({ ok: true, unavailable: true, results: [{ id: 1 }] }),
    metadata({ ok: true, stale: true, results: [{ id: 1 }] }),
    metadata({ ok: true, notFound: true, results: [] }),
    metadata({ ok: true, results: [] }),
    metadata({ ok: true, results: "not an array" }),
    metadata({ ok: true, results: [{ id: 1 }] }, {}, 429),
    metadata({ ok: true, results: [{ id: 1 }] }, {}, 502),
    metadata({ ok: true, results: [{ id: 1 }] }, { "Content-Length": "262145" }),
    metadata({ ok: true, results: [{ id: "x".repeat(262145) }] }, { "Content-Length": "11" })
  ];
  for (const upstream of cases) {
    const fixture = cacheFixture();
    const response = await handleGateway(request("/api/tmdb/search?q=fixture"), ENV, fixture.ctx,
      { cache: fixture.cache, fetchImpl: async () => upstream });
    await response.text();
    await fixture.flush();
    assert.equal(fixture.entries.size, 0);
  }
});

test("cached compression variants stay isolated and preserve exactly one encoded representation", async () => {
  const fixture = cacheFixture();
  const compressed = gzipSync('{"ok":true}');
  let count = 0;
  const opts = { cache: fixture.cache, fetchImpl: async (url, init) => {
    count++;
    return init.headers.get("accept-encoding") === "gzip"
      ? new Response(compressed, { headers: { "Content-Type": "application/json",
        "Content-Encoding": "gzip", "Content-Length": String(compressed.length), "Cache-Control": "public, max-age=300" } })
      : json();
  } };
  const gzipRequest = () => request("/api/catalog", { headers: { "Accept-Encoding": "gzip" } });
  await handleGateway(gzipRequest(), ENV, fixture.ctx, opts);
  await fixture.flush();
  const hit = await handleGateway(gzipRequest(), ENV, fixture.ctx, opts);
  assert.equal(hit.headers.get("x-zenkai-gateway-cache"), "HIT");
  assert.equal(hit.headers.get("content-encoding"), "gzip");
  assert.equal(gunzipSync(Buffer.from(await hit.arrayBuffer())).toString(), '{"ok":true}');
  const identity = await handleGateway(request("/api/catalog"), ENV, fixture.ctx, opts);
  assert.equal(identity.headers.get("x-zenkai-gateway-cache"), "MISS");
  assert.equal(identity.headers.has("content-encoding"), false);
  assert.equal(await identity.text(), '{"ok":true}');
  assert.equal(count, 2);
  const source = readFileSync(new URL("../ops/cloudflare/gateway.mjs", import.meta.url), "utf8");
  assert.match(source, /secureResponse\(hit,\s*\{[^}]+\},\s*"manual"\)/);
});

test("private, conditional, ranged, refresh and source requests never share the public cache", async () => {
  const cases = [
    ["/api/catalog", { headers: { Authorization: "Bearer fixture" } }],
    ["/api/catalog", { headers: { Cookie: "session=fixture" } }],
    ["/api/catalog", { headers: { Range: "bytes=0-10" } }],
    ["/api/catalog", { headers: { "If-None-Match": "fixture" } }],
    ["/api/catalog", { headers: { "If-Modified-Since": "Thu, 08 Oct 2026 00:00:00 GMT" } }],
    ["/api/catalog?refresh=1", {}],
    ["/api/catalog?FORCE=true", {}],
    ["/api/catalog", { headers: { "Cache-Control": "no-cache" } }],
    ["/api/catalog", { headers: { "Cache-Control": "no-store" } }],
    ["/api/catalog", { headers: { "Cache-Control": "max-age=0" } }],
    ["/api/catalog", { headers: { Pragma: "no-cache" } }],
    ["/api/animeyt/sources?id=fixture", {}],
    ["/api/catalog", { method: "POST", body: "fixture" }]
  ];
  for (const [path, init] of cases) {
    const response = await handleGateway(request(path, init), ENV, {
      waitUntil: () => assert.fail("Should not cache")
    }, { cache: { match: () => assert.fail("Should not read cache") }, fetchImpl: async () => json() });
    assert.equal(response.headers.get("x-zenkai-gateway-cache"), "BYPASS");
  }
});

test("only correctly typed, bounded public responses are cached; errors and cookies stay fresh", () => {
  assert.equal(publicCacheTtl(json(), "/api/catalog"), 300);
  assert.equal(publicCacheTtl(json(200, { "Cache-Control": "public, max-age=20" }), "/api/catalog"), 20);
  assert.equal(publicCacheTtl(json(200, { Age: "290" }), "/api/catalog"), 10);
  assert.equal(publicCacheTtl(json(200, { Age: "300" }), "/api/catalog"), 0);
  assert.equal(publicCacheTtl(json(200, { "Content-Type": "image/webp", "Cache-Control": "public, max-age=31536000, immutable" }), "/api/image"), 86400);
  const bad = [json(502), json(200, { "Set-Cookie": "fixture=1" }),
    json(200, { "Cache-Control": "private, max-age=300" }), json(200, { "Cache-Control": "public, no-store" }),
    json(200, { "Content-Type": "text/html" }), json(200, { Vary: "Cookie" }),
    json(200, { Vary: "Origin" }), json(200, { "Content-Length": "20000000" })];
  const missingLength = json();
  missingLength.headers.delete("content-length");
  bad.push(missingLength);
  for (const response of bad) assert.equal(publicCacheTtl(response, "/api/catalog"), 0);
});

test("cache failures do not take the API down", async () => {
  const fixture = cacheFixture();
  const response = await handleGateway(request("/api/catalog"), ENV, fixture.ctx, {
    fetchImpl: async () => json(), cache: {
      match: async () => { throw new Error("fixture cache outage"); },
      put: async () => { throw new Error("fixture cache outage"); }
    }
  });
  await fixture.flush();
  assert.equal(response.status, 200);
});

test("HLS/MP4 and byte-range HEAD requests go to the existing media backend, not a free Worker relay", async () => {
  for (const method of ["GET", "HEAD"]) {
    const response = await handleGateway(request("/api/source?url=https%3A%2F%2Fmedia.example%2Fepisode.m3u8&referer=fixture", {
      method, headers: { Range: "bytes=50-100" }
    }), ENV, null, { fetchImpl: () => assert.fail("Worker must not fetch media") });
    assert.equal(response.status, 307);
    assert.equal(response.headers.get("location"), "https://backend.example/api/source?url=https%3A%2F%2Fmedia.example%2Fepisode.m3u8&referer=fixture");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const preflight = await handleGateway(request("/api/source", { method: "OPTIONS" }), ENV, null);
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("access-control-allow-headers"), /Range/);
});

test("upstream errors/429 preserve status and Retry-After without retries or a fake success", async () => {
  for (const status of [403, 429, 502, 503]) {
    let count = 0;
    const response = await handleGateway(request("/api/animeyt/sources?id=fixture"), ENV, null, {
      fetchImpl: async () => { count++; return json(status, { "Retry-After": "60", "Cache-Control": "no-store" }); }
    });
    assert.equal(response.status, status);
    assert.equal(response.headers.get("retry-after"), "60");
    assert.equal(count, 1);
  }
});

test("network failures and cancellation return a no-store failure and make one upstream call", async () => {
  let signal;
  const response = await handleGateway(request("/api/health"), ENV, null, { fetchImpl: async (url, init) => {
    signal = init.signal;
    throw new Error("fixture network outage");
  } });
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(signal.aborted, false);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await handleGateway(request("/api/health", { signal: controller.signal }), ENV, null, {
    fetchImpl: async (url, init) => { assert.equal(init.signal.aborted, true); throw new Error("aborted"); }
  });
  assert.equal(cancelled.status, 504);
});

test("backend-origin loops, credentials and non-HTTPS configuration fail closed", async () => {
  for (const BACKEND_ORIGIN of ["https://staging.example", "http://backend.example", "https://user:fixture@backend.example", "https://backend.example/api", "not-a-url"]) {
    const response = await handleGateway(request("/api/health"), { BACKEND_ORIGIN }, null, { fetchImpl: () => assert.fail("Unsafe backend") });
    assert.equal(response.status, 503);
  }
  const production = await handleGateway(new Request("https://zenkaitv.com/api/health"), ENV, null, { fetchImpl: () => assert.fail("Staging on production") });
  assert.equal(production.status, 503);
});

test("scanner paths are blocked before any backend call", async () => {
  for (const path of ["/.env", "/.env.production", "/.git/config", "/wp-login.php", "/xmlrpc.php", "/vendor/phpunit", "/cgi-bin/fixture", "/%2eenv"]) {
    assert.equal(isScannerPath(path), true);
    const response = await handleGateway(request(path), ENV, null, { fetchImpl: () => assert.fail("Scanner reached backend") });
    assert.equal(response.status, 404);
  }
  assert.equal(isScannerPath("/anime/example"), false);
});

test("forwarded-IP spoofing is stripped; only the Cloudflare-provided client address is trusted", async () => {
  for (const trusted of [false, true]) {
    const req = request("/api/health", { headers: { "X-Forwarded-For": "spoofed", "CF-Connecting-IP": "203.0.113.7", "X-Real-IP": "spoofed" } });
    if (trusted) Object.defineProperty(req, "cf", { value: { colo: "FIX" } });
    await handleGateway(req, ENV, null, { fetchImpl: async (url, init) => {
      assert.equal(init.headers.get("x-forwarded-for"), trusted ? "203.0.113.7" : null);
      assert.equal(init.headers.has("x-real-ip"), false);
      return json();
    } });
  }
});

test("same-backend redirects become same-origin; external redirects are not followed", async () => {
  for (const location of ["https://backend.example/api/next?fixture=1", "https://external.example/login"]) {
    const response = await handleGateway(request("/api/redirect"), ENV, null, {
      fetchImpl: async (url, init) => { assert.equal(init.redirect, "manual"); return new Response(null, { status: 302, headers: { Location: location } }); }
    });
    assert.equal(response.headers.get("location"), location.startsWith(ENV.BACKEND_ORIGIN) ? "/api/next?fixture=1" : location);
  }
});

test("staging deployment has no production routes, cron, paid bindings or app framework replacement", () => {
  const config = JSON.parse(readFileSync(new URL("../wrangler.staging.json", import.meta.url), "utf8"));
  assert.equal(config.name, "zenkaitv-staging");
  assert.ok(!config.routes && !config.route && !config.triggers && !config.crons && !config.r2_buckets && !config.durable_objects);
  assert.equal(config.assets.not_found_handling, "single-page-application");
  assert.equal(config.assets.html_handling, "none");
  assert.deepEqual(config.assets.run_worker_first.slice(0, 2), ["/api", "/api/*"]);
  assert.ok(!config.assets.run_worker_first.includes("/*"), "Static content should not invoke Worker code");
});

test("the pinned CLI verifies deployment artifacts and does not load existing backend dotenv secrets", () => {
  const cli = readFileSync(new URL("./cloudflare-cli.mjs", import.meta.url), "utf8");
  assert.match(cli, /CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:\s*"false"/);
  assert.match(cli, /WRANGLER_SEND_METRICS:\s*"false"/);
  assert.match(cli, /verifyCloudflareStaging\(\)/);
  assert.match(cli, /wrangler@4\.149\.0/);
  assert.doesNotMatch(cli, /shell:\s*true/);
  assert.match(cli, /login:\s*\["login",\s*"--scopes",\s*"account:read",\s*"user:read",\s*"workers_scripts:write"\]/);
});
