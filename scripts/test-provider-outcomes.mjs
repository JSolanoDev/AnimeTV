import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("../animetv-server.js", import.meta.url), "utf8");
const client = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const section = (s, a, b) => {
  const from = s.indexOf(a), to = s.indexOf(b, from);
  assert.ok(from >= 0 && to > from);
  return s.slice(from, to);
};

function directHarness(status, headers = {}, sources = []) {
  const c = vm.createContext({ URL, String, Number,
    TIOANIME_BASE: "https://tioanime.example", TIOANIME_HEADERS: {},
    fetchWithTimeout: async () => new Response("neutral html", { status, headers }),
    parseTioAnimeVideoSources: () => sources,
    upstreamHttpError: (_name, r) => Object.assign(new Error("upstream failed"), {
      status: r.status, retryAfterMs: Number(r.headers.get("retry-after") || 0) * 1000
    })
  });
  vm.runInContext(section(server, "async function fetchTioAnimeEpisodeSourcesDirect(", "function parseTioAnimeVideoSources("), c);
  return c;
}

for (const status of [403, 429, 500, 503]) {
  test("TioAnime HTTP" + status + " remains upstream failure, never a missing episode", async () => {
    const c = directHarness(status, { "Retry-After": "90" });
    await assert.rejects(c.fetchTioAnimeEpisodeSourcesDirect("neutral", 2),
      e => e.status === status && e.retryAfterMs === 90000);
  });
}
test("real upstream404 remains a bounded missing-episode outcome", async () => {
  const p = await directHarness(404).fetchTioAnimeEpisodeSourcesDirect("neutral", 2);
  assert.equal(p.ok, false);
  assert.equal(p.notFound, true);
  assert.equal(p.upstreamStatus, 404);
});
test("a200 page with no parsed source block is not cached as title absence", async () => {
  await assert.rejects(directHarness(200).fetchTioAnimeEpisodeSourcesDirect("neutral", 2),
    e => e.status === 502);
});
test("valid TioAnime sources and download-host exclusion stay intact", async () => {
  const p = await directHarness(200, {}, [
    { provider: "Neutral", url: "https://embed.example/2" },
    { provider: "Mega", url: "https://mega.nz/file/fixture" }
  ]).fetchTioAnimeEpisodeSourcesDirect("neutral", 2);
  assert.equal(p.ok, true);
  assert.equal(p.sources.length, 1);
  assert.equal(p.sources[0].provider, "Neutral");
});

function routeHarness() {
  let now = 100000, calls = 0, result, fail = null, cooldown = null;
  const cache = new Map();
  const c = vm.createContext({ Date: class extends Date { static now() { return now; } },
    String, Number, HOSTED_RUNTIME: true, TIOANIME_SERVICE: "http://localhost:5000",
    TIOANIME_CACHE_TTL_MS: 1000, TIOANIME_MISS_CACHE_TTL_MS: 1000,
    tioAnimeSourceCache: cache, tioAnimeSourceInflight: new Map(),
    REGULAR_SOURCE_SUCCESS_CACHE_HEADERS: { "Cache-Control": "public, max-age=60" },
    REGULAR_SOURCE_MISS_CACHE_HEADERS: { "Cache-Control": "public, max-age=15" },
    SOURCE_REFRESH_CACHE_HEADERS: { "Cache-Control": "private, no-store" },
    coalesceInflight: (_m, _k, fn) => fn(), playbackProviderCooldownError: () => cooldown,
    recordPlaybackProviderFailure: () => 90000,
    fetchTioAnimeEpisodeSourcesDirect: async () => {
      calls++; if (fail) throw fail;
      return { ok: false, notFound: true, sources: [] };
    },
    sendJson: (_r, data, status, headers) => { result = { data, status, headers }; }
  });
  vm.runInContext(section(server, "async function handleTioAnimeSources(", "async function findTioAnimeSlugFromCatalog("), c);
  return { cache, advance: ms => { now += ms; }, calls: () => calls,
    c, cooldown: e => { cooldown = e; }, fail: e => { fail = e; }, run: async (episode = 2, refresh = false) => {
      await c.handleTioAnimeSources(new URL("https://app.test/api/tioanime/sources?slug=neutral&episode=" + episode + (refresh ? "&refresh=1" : "")), {});
      return result;
    } };
}
test("TioAnime outage is private/no-store with Retry-After and never retained as a404", async () => {
  const h = routeHarness(); h.fail(Object.assign(new Error("blocked"), { status: 403 }));
  const r = await h.run();
  assert.equal(r.status, 503);
  assert.equal(r.data.upstreamStatus, 403);
  assert.equal(r.data.notFound, false);
  assert.match(r.headers["Cache-Control"], /no-store/);
  assert.equal(r.headers["Retry-After"], "90");
  assert.equal(h.cache.size, 0);
});
test("expired known-good TioAnime sources survive outage without becoming a public fresh success", async () => {
  const h = routeHarness();
  h.cache.set("neutral:2", { ts: 1, data: { ok: true, sources: [{ url: "https://embed.example/2" }] } });
  h.fail(Object.assign(new Error("outage"), { status: 503 }));
  const r = await h.run();
  assert.equal(r.status, 200);
  assert.equal(r.data.stale, true);
  assert.equal(r.data.sources.length, 1);
  assert.match(r.headers["Cache-Control"], /no-store/);
});
test("real TioAnime misses are retained per episode while another episode remains independent", async () => {
  const h = routeHarness(); const a = await h.run(); const b = await h.run();
  assert.equal(a.status, 404); assert.equal(b.status, 404); assert.equal(h.calls(), 1);
  await h.run(3); assert.equal(h.calls(), 2);
  h.advance(1001); await h.run(); assert.equal(h.calls(), 3);
});

test("provider cooldown skips upstream even for explicit refresh; cached good sources remain available", async () => {
  const h = routeHarness();
  h.cooldown(Object.assign(new Error("cooldown"), { status: 429, providerCooldown: true }));
  assert.equal((await h.run(2, true)).status, 503);
  assert.equal(h.calls(), 0);
  h.cache.set("neutral:3", { ts: 100000, data: { ok: true, sources: [{ url: "https://embed.example/3" }] } });
  assert.equal((await h.run(3)).status, 200);
  assert.equal(h.calls(), 0);
});

test("an old ambiguous cached failure is never replayed as a404", async () => {
  const h = routeHarness();
  h.cache.set("neutral:2", { ts: 100000, data: { ok: false, error: "old outage" } });
  h.fail(Object.assign(new Error("upstream failed"), { status: 503 }));
  assert.equal((await h.run()).status, 503);
  assert.equal(h.calls(), 1);
});

test("a recognized download-only page is not labelled missing or publicly cached", async () => {
  const h = routeHarness();
  h.c.fetchTioAnimeEpisodeSourcesDirect = async () => ({ ok: false, sources: [], mega: [] });
  const r = await h.run();
  assert.equal(r.status, 200);
  assert.match(r.headers["Cache-Control"], /no-store/);
  assert.equal(h.cache.size, 0);
});

test("a separately configured TioAnime service outage cannot enter the miss cache", async () => {
  const h = routeHarness();
  h.c.HOSTED_RUNTIME = false; h.c.isLoopbackUrl = () => false;
  h.c.upstreamHttpError = (_provider, r) => Object.assign(new Error("service unavailable"), { status: r.status });
  h.c.fetchWithTimeout = async () => new Response("{}", { status: 503 });
  h.fail(new Error("direct outage"));
  const r = await h.run();
  assert.equal(r.status, 503);
  assert.equal(r.data.upstreamStatus, 503);
  assert.equal(h.cache.size, 0);
});

function clientHarness() {
  let now = 100000, status = 404, calls = 0;
  const c = vm.createContext({ Date: class extends Date { static now() { return now; } },
    Map, Promise, Number, String, encodeURIComponent, console: { warn() {} },
    _tioAnimeEpisodeSourceCache: new Map(), _tioAnimeEpisodeSourceInflight: new Map(),
    _jkAnimeEpisodeSourceCache: new Map(), _jkAnimeEpisodeSourceInflight: new Map(),
    TIOANIME_SOURCE_TIMEOUT_MS: 500, JKANIME_SOURCE_TIMEOUT_MS: 500,
    getVerifiedFallbackSourceEpisode: () => null, hydrateTioAnimeSlug: async () => {},
    animeAv1CatalogSlugForShow: () => "neutral", tioAnimeIsDown: () => false,
    playbackProviderIsCoolingDown: () => false, markTioAnimeDown() {}, deferPlaybackProviderOnFailure() {},
    mergeTioAnimeSourcesIntoEpisode: (_s, ep, data) => {
      ep.sourceOptions = [...(ep.sourceOptions || []), ...data.sources];
    },
    fetchWithTimeout: async () => {
      calls++;
      return { status, ok: status === 200, headers: { get: () => null },
        json: async () => ({ ok: true, sources: [{ id: "backup" }] }) };
    }
  });
  vm.runInContext(section(client, "const EPISODE_SOURCE_PAYLOAD_TTL_MS", "function castBackupEpisodeNumber("), c);
  vm.runInContext(section(client, "async function attachTioAnimeSources(", "// Rank embed providers"), c);
  vm.runInContext(section(client, "function fetchJKAnimeEpisodeSourcePayload(", "async function attachJKAnimeSources("), c);
  return { c, calls: () => calls, advance: ms => { now += ms; }, status: s => { status = s; } };
}
for (const provider of ["tioanime", "jkanime"]) {
  test(provider + " duplicate misses are bounded; explicit refresh and expiry can recover", async () => {
    const h = clientHarness(), show = {}, ep = () => ({ episode: 2, sourceOptions: [{ id: "primary" }] });
    const run = options => provider === "tioanime"
      ? h.c.attachTioAnimeSources(show, ep(), options)
      : h.c.fetchJKAnimeEpisodeSourcePayload("neutral", 2, options);
    await run(); await run(); assert.equal(h.calls(), 1);
    h.advance(61000); await run(); assert.equal(h.calls(), 2);
    h.status(200); const result = await run({ forceRefresh: true }); assert.equal(h.calls(), 3);
    if (provider === "jkanime") assert.equal(result.ok, true);
  });
}
test("a guessed TioAnime slug is never promoted by a failed request", async () => {
  const h = clientHarness(), show = {};
  await h.c.attachTioAnimeSources(show, { episode: 2, sourceOptions: [] });
  assert.equal(show.tioAnimeSlug, undefined);
});

for (const provider of ["tioanime", "jkanime"]) {
  test(provider + " keeps known-good payloads during cooldown without forcing new upstream traffic", async () => {
    const h = clientHarness(); h.status(200);
    const show = { tioAnimeSlug: "neutral" }, ep = { episode: 2, sourceOptions: [{ id: "primary" }] };
    const run = (episode, options) => provider === "tioanime"
      ? h.c.attachTioAnimeSources(show, episode, options)
      : h.c.fetchJKAnimeEpisodeSourcePayload("neutral", episode.episode, options);
    await run(ep);
    h.c.playbackProviderIsCoolingDown = () => true;
    await run(ep, { forceRefresh: true });
    await run({ episode: 3, sourceOptions: [] }, { forceRefresh: true });
    assert.equal(h.calls(), 1);
    assert.equal(ep.sourceOptions[0].id, "primary");
  });
}

test("miss caching never blocks another episode/provider and stays bounded", () => {
  const h = clientHarness();
  h.c.rememberEpisodeSourceMiss("tioanime", "neutral:2", { status: 404 });
  assert.equal(h.c.episodeSourceRecentlyMissing("tioanime", "neutral:2"), true);
  assert.equal(h.c.episodeSourceRecentlyMissing("tioanime", "neutral:3"), false);
  assert.equal(h.c.episodeSourceRecentlyMissing("jkanime", "neutral:2"), false);
  h.c.rememberEpisodeSourceMiss("jkanime", "neutral:2", { status: 503 });
  assert.equal(h.c.episodeSourceRecentlyMissing("jkanime", "neutral:2"), false);
  for (let i = 0; i < 1010; i++) h.c.rememberEpisodeSourceMiss("tioanime", "neutral:" + i, { status: 404 });
  assert.equal(vm.runInContext("episodeSourceMissUntil.size", h.c), 1000);
});

test("validated source merging preserves primary sources and confirms only usable slugs", () => {
  const c = vm.createContext({ Set, String, isBlockedPlaybackSource: s => s.provider === "Blocked",
    normalizeTitle: s => s, simpleHash: s => s });
  vm.runInContext(section(client, "function embedProviderRank(", "const animeYTEpisodeCache"), c);
  const show = {}, primary = { id: "primary", videoUrl: "https://media.example/primary.mp4" };
  const ep = { sourceOptions: [primary], locked: true };
  c.mergeTioAnimeSourcesIntoEpisode(show, ep, { sources: [
    { provider: "Mega", url: "https://mega.nz/file/fixture" },
    { provider: "Blocked", url: "https://embed.example/blocked" }
  ] }, "neutral", 2);
  assert.equal(show.tioAnimeSlug, undefined);
  assert.equal(ep.sourceOptions.length, 1);
  c.mergeTioAnimeSourcesIntoEpisode(show, ep, { sources: [{ provider: "Neutral", url: "https://embed.example/2" }] }, "neutral", 2);
  assert.equal(ep.sourceOptions[0], primary);
  assert.equal(ep.sourceOptions.length, 2);
  assert.equal(show.tioAnimeSlug, "neutral");
  assert.equal(ep.locked, false);
});
