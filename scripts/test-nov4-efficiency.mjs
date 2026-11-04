import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { handleGateway } from "../ops/cloudflare/gateway.mjs";

const read = path => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const part = (source, from, to) => {
  const a = source.indexOf(from), b = source.indexOf(to, a);
  assert.ok(a >= 0 && b > a);
  return source.slice(a, b);
};

test("all asset configurations send nested private-file probes to the existing guard", () => {
  for (const file of ["wrangler.production.json", "wrangler.staging.json", "wrangler.container-staging.json"]) {
    const patterns = JSON.parse(read(file)).assets.run_worker_first;
    const routes = patterns.filter(p => !p.startsWith("!")).map(p =>
      new RegExp("^" + p.split("*").map(s => s.replace(/[.*+?^$\{\}()|[\]\\]/g, "\\$&")).join(".*") + "$"));
    for (const path of ["/bot/.env", "/dashboard/.env", "/deep/path/.env.local", "/foo/.git/config"]) {
      assert.ok(routes.some(r => r.test(path)), file + " misses " + path);
    }
    for (const path of ["/", "/anime/neutral-series", "/player/player.html", "/client.js"]) {
      assert.equal(routes.some(r => r.test(path)), false, file + " intercepts " + path);
    }
  }
});

test("nested scanners return a small no-store404 without assets or origin work", async () => {
  let origin = 0, assets = 0;
  for (const path of ["/bot/.env", "/dashboard/.env", "/foo/.git/config"]) {
    const response = await handleGateway(new Request("https://preview.test" + path),
      { BACKEND_ORIGIN: "https://backend.test", ASSETS: { fetch: () => { assets++; } } }, null,
      { fetchImpl: () => { origin++; } });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok((await response.text()).length < 100);
  }
  assert.equal(origin + assets, 0);
});

function searchHarness(fetch) {
  const cache = new Map(), calls = [];
  let result;
  const ctx = vm.createContext({
    TMDB_AVAILABLE: true, TMDB_CACHE_TTL_MS: 60000, tmdbSearchCache: cache,
    tmdbInflight: new Map(), TMDB_SEARCH_CACHE_HEADERS: {}, METADATA_STALE_CACHE_HEADERS: {},
    normalizeTitle: s => s.toLowerCase(), Date, String,
    tmdbFetch: async (route, params) => { calls.push({ route, params }); return fetch(route, params); },
    coalesceInflight: (_map, _key, fn) => fn(),
    sendJson: (_response, payload, status) => { result = { payload, status }; }, log() {}
  });
  vm.runInContext(part(read("animetv-server.js"), "async function handleTmdbSearch(", "async function handleTmdbTv("), ctx);
  return { calls, cache, run: async query => {
    await ctx.handleTmdbSearch(new URL("https://app.test/api/tmdb/search?" + query), {});
    return result;
  } };
}

test("year fallback is explicitly reported on cold and cached successful empty searches", async () => {
  const h = searchHarness(() => ({ results: [] }));
  for (let i = 0; i < 2; i++) {
    const r = await h.run("q=Neutral&year=2026");
    assert.equal(r.status, 200);
    assert.equal(r.payload.yearFallbackApplied, true);
    assert.equal(r.payload.results.length, 0);
  }
  assert.equal(h.calls.length, 2, "one year query plus one fallback, cached thereafter");
});

test("successful fallback still returns its exact matches and preserves media type", async () => {
  const h = searchHarness((_r, p) => ({ results: p.primary_release_year ? [] : [{ id: 7, title: "Neutral Film" }] }));
  const r = await h.run("q=Neutral&year=2026&type=movie");
  assert.equal(r.payload.yearFallbackApplied, true);
  assert.equal(r.payload.results[0].id, 7);
  assert.equal(r.payload.results[0].media_type, "movie");
  assert.ok(h.calls.every(c => c.route === "/search/movie"));
});

test("year hits and no-year queries never claim a fallback occurred", async () => {
  const h = searchHarness(() => ({ results: [{ id: 4 }] }));
  assert.notEqual((await h.run("q=Neutral&year=2026")).payload.yearFallbackApplied, true);
  assert.notEqual((await h.run("q=Neutral")).payload.yearFallbackApplied, true);
  assert.equal(h.calls.length, 2);
});

function resolverHarness(payloadFor) {
  const calls = [], storage = new Map();
  const ctx = vm.createContext({
    console: { debug() {}, warn() {} }, URL, setTimeout, clearTimeout,
    localStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v),
      removeItem: k => storage.delete(k) },
    fetchMetadataJson: async url => { calls.push(url); return payloadFor(new URL(url, "https://app.test")); }
  });
  vm.runInContext(read("js/image-resolver.js") + "\nthis.resolver = ImageResolver;", ctx);
  return { calls, run: (format = "TV") => ctx.resolver.hydrateTmdbImages({
    id: "neutral-efficiency-fixture", title: "Neutral", year: 2026, format
  }) };
}

test("confirmed successful server fallback avoids a duplicate no-year HTTP lookup", async () => {
  const h = resolverHarness(() => ({ ok: true, configured: true, yearFallbackApplied: true, results: [] }));
  const show = await h.run();
  assert.equal(h.calls.length, 1);
  assert.equal(show._tmdbResolved, true);
});

for (const invalid of [
  { ok: true, configured: true },
  { ok: false, configured: true, yearFallbackApplied: true },
  { ok: true, configured: true, yearFallbackApplied: true, stale: true }
]) {
  test("legacy/error/stale payload retains the existing fallback: " + JSON.stringify(invalid), async () => {
    const h = resolverHarness(() => ({ results: [], ...invalid }));
    await h.run();
    assert.equal(h.calls.length, 2);
    assert.ok(!new URL(h.calls[1], "https://app.test").searchParams.has("year"));
  });
}

test("movie-to-TV fallback survives the optimization", async () => {
  const h = resolverHarness(() => ({ ok: true, configured: true, yearFallbackApplied: true, results: [] }));
  await h.run("MOVIE");
  assert.equal(h.calls.length, 2);
  assert.equal(new URL(h.calls[0], "https://app.test").searchParams.get("type"), "movie");
  assert.equal(new URL(h.calls[1], "https://app.test").searchParams.get("type"), null);
});
