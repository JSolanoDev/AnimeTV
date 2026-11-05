import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("../animetv-server.js", import.meta.url), "utf8");
const client = readFileSync(new URL("../client.js", import.meta.url), "utf8");
function section(s, a, b) {
  const start = s.indexOf(a), end = s.indexOf(b, start);
  assert.ok(start >= 0 && end > start, a);
  return s.slice(start, end);
}
const goodEpisode = () => ({ episode: { number: 2 }, anime: { title: "Neutral", language: "Sub" },
  groups: [{ servers: [{ link: "https://embed.example/neutral-2", label: "Neutral" }] }] });

function serverHarness() {
  let now = 100000, calls = 0, respond = () => new Response(JSON.stringify(goodEpisode()));
  const context = vm.createContext({ Map, URL, Promise, Response,
    Date: class extends Date { static now() { return now; } }, HOSTED_RUNTIME: true,
    ANIMENEON_BASE: "https://provider.example", ANIMENEON_HEADERS: {},
    ANIMENEON_SOURCE_CACHE_TTL_MS: 1000, ANIMENEON_SOURCE_MISS_TTL_MS: 1000,
    ANIMENEON_SEARCH_CACHE_TTL_MS: 1000, ANIMENEON_SEARCH_MISS_TTL_MS: 1000,
    animeNeonSourceCache: new Map(), animeNeonSourceInflight: new Map(),
    animeNeonSearchCache: new Map(), animeNeonSearchInflight: new Map(),
    animeNeonDataNode: p => p,
    normalizeTitle: s => s.toLowerCase(), setAnimeNeonCache: (map, key, value) => map.set(key, value),
    isAnimeNeonMultiserverLink: () => false, log() {},
    fetchWithTimeout: async () => { calls++; return respond(); }
  });
  vm.runInContext(section(server, "function coalesceInflight(", "async function fetchAniListJson("), context);
  vm.runInContext(section(server, "async function fetchAnimeNeonSearch(", "function animeNeonMultiserverEntries("), context);
  vm.runInContext(section(server, "async function fetchAnimeNeonEpisode(", "async function handleAnimeNeonHealth("), context);
  return { c: context, calls: () => calls, respond: fn => { respond = fn; }, advance: ms => { now += ms; },
    episode: (force = false) => context.fetchAnimeNeonEpisode({ slug: "neutral", nanoid: "fixture" }, 2, force) };
}

for (const [name, body] of [["HTML instead of JSON", "<html>temporary error</html>"],
  ["invalid episode data", JSON.stringify({})],
  ["wrong episode identity", JSON.stringify({ ...goodEpisode(), episode: { number: 3 } })],
  ["missing source data", JSON.stringify({ ...goodEpisode(), groups: [] })]]) {
  test(name + " stays a transient failure and never becomes cached absence", async () => {
    const h = serverHarness(); h.respond(() => new Response(body));
    await assert.rejects(h.episode(), e => e.status === 502);
    assert.equal(h.c.animeNeonSourceCache.size, 0);
    assert.ok(h.c.playbackProviderCooldownError("animeneon"));
  });
}

test("an unrecognized search response never becomes a cached empty directory", async () => {
  const h = serverHarness(); h.respond(() => new Response("{}"));
  await assert.rejects(h.c.fetchAnimeNeonSearch("Neutral", "Sub"), e => e.status === 502);
  assert.equal(h.c.animeNeonSearchCache.size, 0);
});

test("real missing episodes remain bounded per-episode misses without a global outage", async () => {
  const h = serverHarness(); h.respond(() => new Response("missing", { status: 404 }));
  assert.equal((await h.episode()).notFound, true);
  assert.equal((await h.episode()).notFound, true);
  assert.equal(h.calls(), 1);
  assert.equal(h.c.playbackProviderCooldownError("animeneon"), null);
});

test("good exact-identity sources survive refresh outages but are explicitly stale", async () => {
  const h = serverHarness(); const good = await h.episode();
  h.advance(1001); h.respond(() => new Response("blocked", { status: 503, headers: { "Retry-After": "45" } }));
  const stale = await h.episode(true);
  assert.equal(stale.stale, true);
  assert.equal(stale.sources[0].externalUrl, good.sources[0].externalUrl);
  assert.equal(h.c.animeNeonSourceCache.get("neutral.fixture:2").ts, 100000);
  assert.equal(h.c.playbackProviderCooldownError("animeneon").retryAfterMs, 45000);
});

for (const keepDirect of [false, true]) {
  test("failed optional mirrors " + (keepDirect ? "preserve an independent source" : "do not become missing episodes"), async () => {
    const h = serverHarness();
    const payload = goodEpisode();
    payload.groups[0].servers = [
      ...(keepDirect ? payload.groups[0].servers : []),
      { link: "https://multiserver.example/fixture", label: "Mirror" }
    ];
    h.c.isAnimeNeonMultiserverLink = url => url.includes("multiserver");
    h.c.expandAnimeNeonMultiserver = async () => { throw new Error("optional mirror unavailable"); };
    h.respond(() => new Response(JSON.stringify(payload)));
    if (keepDirect) {
      const data = await h.episode();
      assert.equal(data.ok, true); assert.equal(data.sources.length, 1);
    } else {
      await assert.rejects(h.episode(), e => e.status === 502);
      assert.equal(h.c.animeNeonSourceCache.size, 0);
    }
  });
}

test("a stale source payload cannot be published as fresh CDN-cacheable success", async () => {
  let response;
  const c = vm.createContext({ Set, Number, String,
    animeNeonAnimeIdentity: () => ({ slug: "neutral", nanoid: "fixture" }),
    animeNeonStaticCandidates: () => [{ title: "Neutral", episodes: 2 }],
    fetchAnimeNeonEpisode: async () => ({ ok: true, stale: true, sources: [{ url: "https://embed.example/neutral-2" }] }),
    REGULAR_SOURCE_SUCCESS_CACHE_HEADERS: { "Cache-Control": "public, max-age=60" },
    SOURCE_REFRESH_CACHE_HEADERS: { "Cache-Control": "private, no-store" },
    sendJson: (_r, body, status, headers) => { response = { body, status, headers }; }
  });
  vm.runInContext(section(server, "async function handleAnimeNeonSources(", "async function handleAnimeOnlineHealth("), c);
  await c.handleAnimeNeonSources(new URL("https://app.example/api/animeneon/sources?title=Neutral&episode=2"), {});
  assert.equal(response.status, 200);
  assert.equal(response.body.sources.length, 1);
  assert.match(response.headers["Cache-Control"], /no-store/);
});

function clientHarness() {
  const pending = [];
  const c = vm.createContext({ Map, Promise, URL, Date, Number,
    location: { origin: "https://app.example" }, animeNeonSourceRequestSequence: 0,
    _animeNeonEpisodeSourceCache: new Map(), _animeNeonEpisodeSourceInflight: new Map(),
    ANIMENEON_CLIENT_CACHE_TTL_MS: 600000, ANIMENEON_CLIENT_MISS_TTL_MS: 60000,
    ANIMENEON_CLIENT_STALE_TTL_MS: 15000, ANIMENEON_SOURCE_TIMEOUT_MS: 8500,
    preferredWatchLanguageForEpisode: () => "sub", getCanonicalEpisodeNumber: ep => ep.number,
    animeNeonSearchCandidates: show => [show.title], normalizeTitle: s => s,
    playbackProviderIsCoolingDown: () => false, deferPlaybackProviderOnFailure() {},
    fetchWithTimeout: () => new Promise(resolve => pending.push(resolve))
  });
  vm.runInContext(section(client, "function animeNeonEpisodeSourceCacheKey(", "async function attachAnimeNeonSources("), c);
  const run = (options = {}) => c.fetchAnimeNeonEpisodeSources({ title: "Neutral" }, { number: 2 }, options);
  const finish = (index, id, status = 200) => pending[index]({ status, ok: status === 200,
    json: async () => ({ ok: true, sources: [{ id }] }) });
  return { c, pending, run, finish };
}

test("concurrent forced refreshes coalesce instead of creating duplicate source requests", async () => {
  const h = clientHarness(); const a = h.run({ forceRefresh: true }), b = h.run({ forceRefresh: true });
  assert.equal(h.pending.length, 1);
  h.finish(0, "fresh");
  assert.equal((await a).sources[0].id, "fresh");
  assert.equal((await b).sources[0].id, "fresh");
});

for (const status of [200, 404]) {
  test("late normal HTTP" + status + " cannot replace a newer successful forced refresh", async () => {
    const h = clientHarness(); const normal = h.run(), fresh = h.run({ forceRefresh: true });
    assert.equal(h.pending.length, 2);
    h.finish(1, "new"); await fresh;
    h.finish(0, "old", status); await normal;
    const read = await h.run();
    assert.equal(read.sources[0].id, "new");
    assert.equal(h.pending.length, 2);
  });
}

test("an older completion cannot remove the active forced-refresh lookup", async () => {
  const h = clientHarness(); const normal = h.run(), fresh = h.run({ forceRefresh: true });
  h.finish(0, "old"); await normal;
  const secondRefresh = h.run({ forceRefresh: true });
  assert.equal(h.pending.length, 2);
  h.finish(1, "new"); await fresh; await secondRefresh;
  assert.equal(h.c._animeNeonEpisodeSourceInflight.size, 0);
});

test("stale payloads get a short client grace period rather than a new ten-minute lifetime", async () => {
  const h = clientHarness();
  const key = h.c.animeNeonEpisodeSourceCacheKey({ title: "Neutral" }, { number: 2 }, "sub");
  h.c._animeNeonEpisodeSourceCache.set(key, { ts: Date.now() - 16000,
    data: { ok: true, stale: true, sources: [{ id: "stale" }] } });
  const result = h.run();
  assert.equal(h.pending.length, 1);
  h.finish(0, "new");
  assert.equal((await result).sources[0].id, "new");
});

test("a failed forced refresh leaves a still-valid successful payload available", async () => {
  const h = clientHarness();
  const first = h.run(); h.finish(0, "working"); await first;
  const refresh = h.run({ forceRefresh: true }); h.finish(1, "failure", 502);
  await assert.rejects(refresh, /502/);
  assert.equal((await h.run()).sources[0].id, "working");
  assert.equal(h.pending.length, 2);
});
