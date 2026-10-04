import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { gzip, gunzipSync } from "node:zlib";

const server = readFileSync(new URL("../animetv-server.js", import.meta.url), "utf8");
const client = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const section = (source, start, end) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const to = source.indexOf(end, from);
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
};

function playlistHarness(fetchWithTimeout) {
  let now = 1000;
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    Map, Object, Promise, Response, String,
    sourcePlaylistCache: new Map(),
    sourcePlaylistInflight: new Map(),
    SOURCE_PLAYLIST_MEMORY_TTL_MS: 15000,
    SOURCE_PLAYLIST_CACHE_MAX: 100,
    fetchWithTimeout
  });
  vm.runInContext(section(server, "function sourcePlaylistIsVod(", "async function handleSourceProxy("), context);
  return { context, advance: (ms) => { now += ms; } };
}

test("one hundred concurrent AnimeAV1 manifest reads share one upstream request", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const harness = playlistHarness(async () => {
    calls += 1;
    if (calls === 1) return gate;
    return new Response("#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:1,\nb.m4s\n#EXT-X-ENDLIST", {
      status: 200,
      headers: { "content-type": "application/vnd.apple.mpegurl" }
    });
  });
  const requests = Array.from({ length: 100 }, () => harness.context.fetchCoalescedSourcePlaylist(
    "https://player.zilla-networks.com/m3u8/fixture",
    { Referer: "https://player.zilla-networks.com/play/fixture" },
    "fixture"
  ));
  await Promise.resolve();
  assert.equal(calls, 1);
  release(new Response("#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:1,\na.m4s\n#EXT-X-ENDLIST", {
    status: 200,
    headers: { "content-type": "application/vnd.apple.mpegurl" }
  }));
  const responses = await Promise.all(requests);
  assert.equal(new Set(await Promise.all(responses.map((response) => response.text()))).size, 1);

  const cached = await harness.context.fetchCoalescedSourcePlaylist("ignored", {}, "fixture");
  assert.match(await cached.text(), /#EXT-X-ENDLIST/);
  assert.equal(calls, 1);

  harness.advance(15001);
  const expired = await harness.context.fetchCoalescedSourcePlaylist("ignored", {}, "fixture");
  assert.equal(calls, 2);
  assert.match(await expired.text(), /b\.m4s/);
});

test("live manifests are coalesced in flight but never retained", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const harness = playlistHarness(async () => {
    calls += 1;
    if (calls === 1) return gate;
    return new Response("#EXTM3U\n#EXTINF:1,\nlive.m4s", { status: 200 });
  });
  const first = harness.context.fetchCoalescedSourcePlaylist("live", {}, "live");
  const second = harness.context.fetchCoalescedSourcePlaylist("live", {}, "live");
  await Promise.resolve();
  assert.equal(calls, 1);
  release(new Response("#EXTM3U\n#EXTINF:1,\nlive.m4s", { status: 200 }));
  await Promise.all([first, second]);
  await harness.context.fetchCoalescedSourcePlaylist("live", {}, "live");
  assert.equal(calls, 2);
  assert.equal(harness.context.sourcePlaylistCache.size, 0);
});

test("normal playback and Cast share one AnimeAV1 source lookup", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const context = vm.createContext({
    Array, Date, Map, Promise, encodeURIComponent,
    ANIMEAV1_SOURCE_TIMEOUT_MS: 6500,
    _animeAv1EpisodeSourceCache: new Map(),
    _animeAv1EpisodeSourceInflight: new Map(),
    fetchWithTimeout: async () => {
      calls += 1;
      return gate;
    }
  });
  vm.runInContext(section(
    client,
    "const EPISODE_SOURCE_PAYLOAD_TTL_MS",
    "async function buildAnimeAv1CastCandidate("
  ), context);

  const consumers = Array.from({ length: 100 }, () =>
    context.fetchAnimeAv1EpisodeSourcePayload("fixture", 7)
  );
  await Promise.resolve();
  assert.equal(calls, 1);
  const payload = { ok: true, sources: [], castSources: [{ provider: "UPNShare" }] };
  release({ ok: true, json: async () => payload });
  assert.equal((await Promise.all(consumers)).every((value) => value === payload), true);
  assert.equal(await context.fetchAnimeAv1EpisodeSourcePayload("fixture", 7), payload);
  assert.equal(calls, 1);
});

test("AnimeAV1 HLS fragments use the CDN's reliable open-range path", () => {
  const proxy = section(server, "async function handleSourceProxy(", "function compactCatalogPayload(");
  assert.match(proxy, /refererHost\.toLowerCase\(\) === "animeav1\.uns\.bio"/);
  assert.match(proxy, /isAnimeAv1VodSegment\) headers\.Range = "bytes=0-"/);
  assert.match(proxy, /signal: relayController\.signal/);
});

test("AnimeAV1 fragment verification requires a complete response", () => {
  const probe = section(client, "async function probeMediaBytes(", "function hlsManifestChildLine(");
  assert.match(probe, /refererHost === "animeav1\.uns\.bio"/);
  assert.match(probe, /options\.cacheCompleteSegment \|\| isAnimeAv1VodSegment/);
  assert.match(probe, /completeSegmentDelivered/);
  assert.match(probe, /!deliveredEnough \|\| !completeSegmentDelivered/);
});

test("progressive health checks separate bounded startup from media throughput", () => {
  const probe = section(client, "async function probeMediaBytes(", "function hlsManifestChildLine(");
  assert.match(probe, /const startedAt = Date\.now\(\)/);
  assert.match(probe, /const bodyStartedAt = Date\.now\(\)/);
  assert.match(probe, /remainingMs = Math\.max\(0, timeoutMs - \(Date\.now\(\) - startedAt\)\)/);
  assert.match(probe, /bytesPerSecond = receivedBytes \/ Math\.max\(0\.001, \(Date\.now\(\) - bodyStartedAt\) \/ 1000\)/);
});

test("HLS verification proves two complete player-shaped fragments", () => {
  const probe = section(client, "async function probeHlsManifest(", "async function probePlayableFallback(");
  assert.match(probe, /cacheCompleteSegment: index < 2/);
  assert.doesNotMatch(probe, /cacheCompleteSegment: index === 0 && Boolean\(options\.prefetchSegment\)/);
});

test("HLS verification follows extensionless variant playlists", async () => {
  const fetched = [];
  const probed = [];
  const context = vm.createContext({
    Date,
    URL,
    fetchWithTimeout: async (url) => {
      fetched.push(url);
      if (url.includes("opaque-variant")) {
        return new Response("#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg-1.ts\n#EXTINF:6,\nseg-2.ts", {
          status: 200,
          headers: { "content-type": "application/vnd.apple.mpegurl" }
        });
      }
      return new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000\nhttps://cdn.test/opaque-variant", {
        status: 200,
        headers: { "content-type": "application/vnd.apple.mpegurl" }
      });
    },
    proxiedStreamUrl: (url) => url,
    originalStreamUrlFromProxy: (url) => url,
    probeMediaBytes: async (url) => {
      probed.push(url);
      return /seg-[12]\.ts$/.test(url);
    }
  });
  vm.runInContext(
    `${section(client, "function manifestChildUrl(", "async function probeMediaBytes(")}\n${section(client, "function hlsManifestChildLine(", "async function probePlayableFallback(")}`,
    context
  );

  const ok = await context.probeHlsManifest("https://cdn.test/master", "", 0, {
    timeoutMs: 1000
  });
  assert.equal(ok, true);
  assert.equal(fetched.some((url) => url.includes("opaque-variant")), true);
  assert.deepEqual(Array.from(probed), [
    "https://cdn.test/seg-1.ts",
    "https://cdn.test/seg-2.ts"
  ]);
});

test("hosted playback excludes worker-bound VOE, Streamwish, and AnimeAV1 UPN without removing local playback", () => {
  const policy = section(client, "function isProductionIpBoundPlaybackSource(", "function isFastPreferredPlaybackSource(");
  const admission = section(client, "function isAdFreeFallbackCandidate(", "function verifiedFallbackPreference(");
  assert.match(policy, /hostname === "localhost"/);
  assert.match(policy, /identity\.includes\("voe"\)/);
  assert.match(policy, /streamwish\|sfastwish\|playerwish\|wishfast/);
  assert.match(policy, /cdn-centaurus\\\.com/);
  assert.match(policy, /identity\.includes\("cloudwindow-route\.com"\)/);
  assert.match(policy, /identity\.includes\("upnshare"\)/);
  assert.match(policy, /identity\.includes\("animeav1\.uns\.bio"\)/);
  assert.match(admission, /if \(isProductionIpBoundPlaybackSource\(source\)\) return false/);
});

test("Streamtape media ranges refresh and share a worker-local signed token", async () => {
  let calls = 0;
  let release;
  const context = vm.createContext({
    Date,
    Error,
    Map,
    URL,
    encodeURIComponent,
    GENERIC_CRAWL_HEADERS: {},
    HOSTED_RUNTIME: true,
    STREAMTAPE_RELAY_CACHE_TTL_MS: 8000,
    STREAMTAPE_RELAY_CACHE_MAX: 50,
    streamTapeRelayCache: new Map(),
    streamTapeRelayInflight: new Map(),
    fetchWithTimeout: async () => {
      calls += 1;
      await new Promise((resolve) => { release = resolve; });
      return { ok: true, text: async () => "fixture" };
    },
    extractStreamFromEmbed: () => ({
      url: "https://streamtape.com/get_video?id=fixture&expires=2&ip=worker&token=fresh",
      type: "mp4"
    }),
    upstreamHttpError: () => new Error("upstream")
  });
  vm.runInContext(section(
    server,
    "function streamTapeRelayMediaId(",
    "async function handleSourceProxy("
  ), context);

  const stale = "https://streamtape.com/get_video?id=fixture&expires=1&ip=other&token=stale";
  const first = context.resolveStreamTapeMediaForRelay(stale);
  const second = context.resolveStreamTapeMediaForRelay(stale);
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  const results = await Promise.all([first, second]);
  assert.equal(results[0], results[1]);
  assert.equal(new URL(results[0]).searchParams.get("token"), "fresh");
  assert.equal(await context.resolveStreamTapeMediaForRelay(stale), results[0]);
  assert.equal(calls, 1);

  const proxy = section(server, "async function handleSourceProxy(", "function compactCatalogPayload(");
  assert.match(proxy, /relayTarget = await resolveStreamTapeMediaForRelay\(targetUrl\)/);
  assert.match(proxy, /fetchWithTimeout\(relayTarget, \{ headers, signal: relayController\.signal \}, 12000\)/);
});

test("verified resolver VOD fragments are briefly reused by the player", () => {
  const proxy = section(server, "async function handleSourceProxy(", "function compactCatalogPayload(");
  assert.match(proxy, /const isReusableResolverVodSegment\s*=/);
  assert.match(proxy, /isReusableResolverVodSegment[\s\S]+s-maxage=900, stale-while-revalidate=1800/);
});

test("backup discovery waits for a fast production-eligible candidate", () => {
  const sourceLookup = section(client, "async function attachPlaybackSourceOptions(", "async function attachPlaybackFailureFallbacks(");
  const failureLookup = section(client, "async function attachPlaybackFailureFallbacks(", "function playbackLookupKey(");
  assert.match(sourceLookup, /&& isAdFreeFallbackCandidate\(source\)\s*&& isFastPreferredPlaybackSource\(source\)/);
  assert.match(failureLookup, /isAdFreeFallbackCandidate\(source\)\s*&& isFastPreferredPlaybackSource\(source\)/);
});

test("portable HLS verification has time to finish without extending server timeouts", () => {
  assert.match(client, /RELIABLE_PLAYBACK_TOTAL_BUDGET_MS = 14000/);
  assert.match(client, /RELIABLE_PLAYBACK_HANDOFF_VERIFY_MS = 10000/);
  const proxy = section(server, "async function handleSourceProxy(", "function compactCatalogPayload(");
  assert.match(proxy, /fetchWithTimeout\(relayTarget, \{ headers, signal: relayController\.signal \}, 12000\)/);
});

test("JKAnime challenge pages do not become cached episode misses", () => {
  const episodeFetch = section(server, "async function fetchJkanimeEpisode(", "function buildCrawlCatalog(");
  const sourceRoute = section(server, "async function handleJKAnimeSources(", "async function fetchJKAnimeEpisodeSourcesDirect(");
  assert.match(episodeFetch, /async function fetchJkanimeEpisode\(slug, episode, attempt = 0\)/);
  assert.match(episodeFetch, /HOSTED_RUNTIME \? \(attempt === 0 \? 5000 : 8000\) : 12000/);
  assert.match(episodeFetch, /\[408, 500, 502, 503, 504\]/);
  assert.doesNotMatch(episodeFetch, /\[408, 429/);
  assert.match(episodeFetch, /if \(!embeds\.length\)/);
  assert.match(sourceRoute, /if \(status === 404\) jkAnimeSourceCache\.set/);
  assert.match(sourceRoute, /if \(cached\?\.data\?\.ok\)/);
  assert.match(sourceRoute, /stale: true/);
});

test("JKAnime retries one transient hosted abort and then returns sources", async () => {
  let calls = 0;
  const timeouts = [];
  const context = vm.createContext({
    Error,
    Number,
    Response,
    encodeURIComponent,
    JK_BASE: "https://jkanime.test",
    JK_HEADERS: {},
    HOSTED_RUNTIME: true,
    wait: async () => {},
    fetchWithTimeout: async (_url, _options, timeout) => {
      calls += 1;
      timeouts.push(timeout);
      if (calls === 1) throw Object.assign(new Error("timeout"), { name: "AbortError" });
      return new Response('<meta property="og:title" content="Example 7 Sub">');
    },
    parseJkanimeServers: () => [{ server: "Vidhide", url: "https://vidhide.test/embed/1" }],
    jkRankEmbeds: (embeds) => embeds,
    upstreamHttpError: (_label, response) => Object.assign(new Error(`HTTP ${response.status}`), { status: response.status }),
    decodeHtmlEntities: (value) => value,
    prettifyJkSlug: (value) => value
  });
  vm.runInContext(section(server, "async function fetchJkanimeEpisode(", "function buildCrawlCatalog("), context);
  const result = await context.fetchJkanimeEpisode("example", 7);
  assert.equal(calls, 2);
  assert.deepEqual(timeouts, [5000, 8000]);
  assert.equal(result.embeds.length, 1);
  assert.equal(result.title, "Example");
});

test("refreshing a provider clears stale source-family health", () => {
  const refresh = section(client, "function resetEpisodeProviderSource(", "function refreshFailedPlaybackProviders(");
  assert.match(refresh, /playbackSourceHealthCache\.delete/);
  assert.match(refresh, /playbackFamilyHealthCache\.delete\(family\)/);
});

const utils = readFileSync(new URL("../js/utils.js", import.meta.url), "utf8");

function metadataHarness(fetchImpl) {
  let now = 100000;
  const calls = [];
  const context = vm.createContext({
    URL,
    Date: class extends Date { static now() { return now; } },
    API_TIMEOUT_MS: 5000,
    location: { origin: "https://app.test", href: "https://app.test/anime/example" },
    fetchWithTimeout: async (...args) => { calls.push(args); return fetchImpl(...args); }
  });
  vm.runInContext(section(utils, "const metadataJsonCache =", "async function fetchWithRetry("), context);
  return { context, calls, advance: ms => { now += ms; } };
}

const metadataResponse = (body, control = "public, max-age=30") => new Response(JSON.stringify(body), {
  headers: { "cache-control": control }
});

test("100 metadata consumers share one HTTP request and receive independent objects", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = metadataHarness(() => gate);
  const consumers = Array.from({ length: 100 }, () => h.context.fetchMetadataJson("/api/anilist/media?id=21", 8000));
  assert.equal(h.calls.length, 1);
  release(metadataResponse({ ok: true, media: { id: 21, title: "One Piece" } }));
  const data = await Promise.all(consumers);
  data[0].media.title = "Changed by one consumer";
  assert.equal(data[1].media.title, "One Piece");
  assert.equal((await h.context.fetchMetadataJson("/api/anilist/media?id=21")).media.title, "One Piece");
  assert.equal(h.calls.length, 1);
  assert.equal(vm.runInContext("metadataJsonInflight.size", h.context), 0);
});

test("metadata reuse honors browser max-age, CDN age, no-store and explicit refresh", async () => {
  const h = metadataHarness(() => new Response('{"data":[1]}', {
    headers: { "cache-control": "public, max-age=30, s-maxage=86400", age: "20" }
  }));
  await h.context.fetchMetadataJson("/api/jikan/full?id=1");
  h.advance(9999);
  await h.context.fetchMetadataJson("/api/jikan/full?id=1");
  assert.equal(h.calls.length, 1);
  h.advance(1);
  await h.context.fetchMetadataJson("/api/jikan/full?id=1");
  assert.equal(h.calls.length, 2);
  await h.context.fetchMetadataJson("/api/jikan/full?id=1", 10000, { refresh: true });
  assert.equal(h.calls.length, 3);

  const uncached = metadataHarness(() => metadataResponse({ data: [] }, "no-store, max-age=0"));
  await uncached.context.fetchMetadataJson("/api/jikan/full?id=1");
  await uncached.context.fetchMetadataJson("/api/jikan/full?id=1");
  assert.equal(uncached.calls.length, 2);
});

test("metadata keys merge parameter order but never languages, formats, or expected episodes", async () => {
  const h = metadataHarness(() => metadataResponse({ data: [] }));
  await h.context.fetchMetadataJson("/api/tmdb/search?q=Example&year=2026");
  await h.context.fetchMetadataJson("/api/tmdb/search?year=2026&q=Example");
  assert.equal(h.calls.length, 1);
  await h.context.fetchMetadataJson("/api/tmdb/search?q=Example&year=2026&type=movie");
  await h.context.fetchMetadataJson("/api/tmdb/search?q=Example&year=2026&language=es");
  await h.context.fetchMetadataJson("/api/jikan/episodes?id=1&episode=12");
  await h.context.fetchMetadataJson("/api/jikan/episodes?id=1&episode=13");
  assert.equal(h.calls.length, 5);
  await assert.rejects(h.context.fetchMetadataJson("/api/source?url=video"));
  await assert.rejects(h.context.fetchMetadataJson("/api/language/preferences"));
  await assert.rejects(h.context.fetchMetadataJson("https://elsewhere.test/api/anilist/media?id=21"));
  assert.equal(h.calls.length, 5);
});

test("metadata rate-limit cooldown honors Retry-After and permits recovery", async () => {
  let limited = true;
  const h = metadataHarness(() => limited
    ? new Response("limited", { status: 429, headers: { "retry-after": "15" } })
    : metadataResponse({ ok: true, media: { id: 21 } }));
  await assert.rejects(h.context.fetchMetadataJson("/api/anilist/media?id=21"), { status: 429 });
  await assert.rejects(h.context.fetchMetadataJson("/api/anilist/media?id=21", 8000, { refresh: true }), { status: 429 });
  assert.equal(h.calls.length, 1);
  h.advance(15000);
  limited = false;
  assert.equal((await h.context.fetchMetadataJson("/api/anilist/media?id=21")).media.id, 21);
  assert.equal(h.calls.length, 2);
});

test("failed metadata is not pinned and the cache has a bounded entry count", async () => {
  let failed = true;
  const h = metadataHarness(() => failed
    ? new Response("outage", { status: 503 })
    : metadataResponse({ ok: true, media: { id: 21 } }));
  await assert.rejects(h.context.fetchMetadataJson("/api/anilist/media?id=21"), { status: 503 });
  failed = false;
  await h.context.fetchMetadataJson("/api/anilist/media?id=21");
  assert.equal(h.calls.length, 2);
  for (let id = 1; id <= 150; id++) await h.context.fetchMetadataJson(`/api/anilist/media?id=${id}`);
  assert.equal(vm.runInContext("metadataJsonCache.size", h.context), 128);
});

test("client retries stop immediately on 429 and never sleep after the final attempt", async () => {
  let calls = 0;
  let sleeps = 0;
  let status = 429;
  const context = vm.createContext({
    fetchWithTimeout: async () => { calls++; return new Response("failed", { status }); },
    wait: async () => { sleeps++; }
  });
  vm.runInContext(section(utils, "async function fetchWithRetry(", "function wait("), context);
  await assert.rejects(context.fetchWithRetry("https://api.test/metadata", {}, 3), { status: 429 });
  assert.equal(calls, 1);
  assert.equal(sleeps, 0);
  status = 503;
  await assert.rejects(context.fetchWithRetry("https://api.test/metadata", {}, 1), { status: 503 });
  assert.equal(calls, 2);
  assert.equal(sleeps, 0);
});

function imageHarness(fetchImpl) {
  const calls = [];
  const context = vm.createContext({
    URL, Buffer, AbortSignal,
    IMAGE_PROXY_ALLOWED_HOSTS: new Set(["image.tmdb.org", "static.underhentai.net"]),
    IMAGE_PROXY_MAX_BYTES: 5 * 1024 * 1024,
    IMAGE_PROXY_MAX_WIDTH: 3840,
    IMAGE_PROXY_MAX_HEIGHT: 3840,
    IMAGE_PROXY_DEFAULT_WIDTH: 360,
    IMAGE_PROXY_WEBP_QUALITY: 70,
    SECURITY_HEADERS: {},
    imageProxyInflight: new Map(),
    sharp: null,
    fetch: async (...args) => { calls.push(args); return fetchImpl(...args); },
    sendJson: (response, body, status) => Object.assign(response, { body, status })
  });
  vm.runInContext(section(server, "function coalesceInflight(", "function parseRetryAfterMs("), context);
  vm.runInContext(section(server, "async function handleImageProxy(", "function handleServerInfo("), context);
  return { context, calls };
}

const imageResponse = () => ({
  writeHead(status, headers) { this.status = status; this.headers = headers; },
  end(body) { this.body = body; }
});

test("100 simultaneous image cache misses share one upstream body without retaining buffers", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = imageHarness(() => gate);
  const url = new URL("https://app.test/api/image?src=https%3A%2F%2Fimage.tmdb.org%2Ft%2Fp%2Foriginal%2Fexample.jpg&w=1920&q=92");
  const responses = Array.from({ length: 100 }, imageResponse);
  const pending = responses.map(response => h.context.handleImageProxy(url, response));
  await Promise.resolve();
  assert.equal(h.calls.length, 1);
  assert.ok(h.calls[0][1].signal instanceof AbortSignal);
  release(new Response(Buffer.from("image fixture"), { headers: { "content-type": "image/jpeg" } }));
  await Promise.all(pending);
  assert.equal(responses.every(response => response.status === 200 && response.body.toString() === "image fixture"), true);
  assert.match(responses[0].headers["Cache-Control"], /immutable/);
  assert.equal(h.context.imageProxyInflight.size, 0);
});

test("different image transforms stay isolated and blocked hosts never reach the upstream", async () => {
  const h = imageHarness(() => new Response("image", { headers: { "content-type": "image/jpeg" } }));
  const image = "https://app.test/api/image?src=https%3A%2F%2Fstatic.underhentai.net%2Fexample.jpg";
  await Promise.all([
    h.context.handleImageProxy(new URL(`${image}&w=200&q=90`), imageResponse()),
    h.context.handleImageProxy(new URL(`${image}&w=400&q=90&h=600&fit=cover`), imageResponse())
  ]);
  assert.equal(h.calls.length, 2);
  const blocked = imageResponse();
  await h.context.handleImageProxy(new URL("https://app.test/api/image?src=http%3A%2F%2F127.0.0.1%2Fsecret"), blocked);
  assert.equal(blocked.status, 403);
  assert.equal(h.calls.length, 2);
});

function playbackCooldownHarness(extra = {}) {
  let now = 1000000;
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    Map, URL, Response, Promise,
    ...extra
  });
  vm.runInContext(section(server, "function coalesceInflight(", "async function fetchAniListJson("), context);
  return { context, advance: ms => { now += ms; } };
}

test("source-provider cooldowns honor Retry-After without extending on cache hits", () => {
  const h = playbackCooldownHarness();
  const limited = h.context.upstreamHttpError("fixture", new Response("limited", {
    status: 429, headers: { "retry-after": "120" }
  }));
  assert.equal(h.context.recordPlaybackProviderFailure("animeneon", limited), 120000);
  h.advance(10000);
  const cooldown = h.context.playbackProviderCooldownError("animeneon");
  assert.equal(cooldown.status, 429);
  assert.equal(h.context.recordPlaybackProviderFailure("animeneon", cooldown), 110000);
  h.advance(110000);
  assert.equal(h.context.playbackProviderCooldownError("animeneon"), null);
  assert.equal(h.context.recordPlaybackProviderFailure("jkanime", { status: 404 }), 0);
  assert.equal(h.context.playbackProviderCooldownError("jkanime"), null);
});

test("AnimeNeon blocking stops search and episode requests across titles until recovery", async () => {
  let calls = 0;
  let blocked = true;
  const h = playbackCooldownHarness({
    animeNeonSearchCache: new Map(), animeNeonSearchInflight: new Map(),
    animeNeonSourceCache: new Map(), animeNeonSourceInflight: new Map(),
    ANIMENEON_SEARCH_CACHE_TTL_MS: 60000, ANIMENEON_SEARCH_MISS_TTL_MS: 1000,
    ANIMENEON_SOURCE_CACHE_TTL_MS: 60000, ANIMENEON_SOURCE_MISS_TTL_MS: 1000,
    ANIMENEON_BASE: "https://provider.test", ANIMENEON_HEADERS: {}, HOSTED_RUNTIME: true,
    normalizeTitle: value => String(value).toLowerCase(),
    setAnimeNeonCache: (map, key, value) => map.set(key, value),
    animeNeonDataNode: value => value,
    fetchWithTimeout: async () => {
      calls++;
      return blocked
        ? new Response("blocked", { status: 403 })
        : new Response(JSON.stringify({ animes: [{ title: "Fixture" }] }));
    }
  });
  vm.runInContext(section(server, "async function fetchAnimeNeonSearch(", "function animeNeonMultiserverEntries("), h.context);
  vm.runInContext(section(server, "async function fetchAnimeNeonEpisode(", "async function handleAnimeNeonHealth("), h.context);
  await assert.rejects(h.context.fetchAnimeNeonSearch("Fixture", "Sub"), { status: 403 });
  await assert.rejects(h.context.fetchAnimeNeonSearch("Another title", "Lat", true), { status: 403 });
  await assert.rejects(h.context.fetchAnimeNeonEpisode({ slug: "fixture", nanoid: "id" }, 2, true), { status: 403 });
  assert.equal(calls, 1);
  blocked = false;
  h.advance(60000);
  assert.equal((await h.context.fetchAnimeNeonSearch("Fixture", "Sub"))[0].title, "Fixture");
  assert.equal(calls, 2);
});

test("AnimeNeon episode blocking is not cached as a missing episode", async () => {
  const h = playbackCooldownHarness({
    animeNeonSourceCache: new Map(), animeNeonSourceInflight: new Map(),
    ANIMENEON_SOURCE_CACHE_TTL_MS: 60000, ANIMENEON_SOURCE_MISS_TTL_MS: 1000,
    ANIMENEON_BASE: "https://provider.test", ANIMENEON_HEADERS: {}, HOSTED_RUNTIME: true,
    setAnimeNeonCache: (map, key, value) => map.set(key, value),
    fetchWithTimeout: async () => new Response("blocked", { status: 403 })
  });
  vm.runInContext(section(server, "async function fetchAnimeNeonEpisode(", "async function handleAnimeNeonHealth("), h.context);
  await assert.rejects(h.context.fetchAnimeNeonEpisode({ slug: "fixture", nanoid: "id" }, 2), { status: 403 });
  assert.equal(h.context.animeNeonSourceCache.size, 0);
});

test("JKAnime outages preserve errors and suppress redundant upstream calls", async () => {
  let calls = 0;
  let blocked = true;
  const h = playbackCooldownHarness({
    jkAnimeSourceCache: new Map(), jkAnimeSourceInflight: new Map(),
    JKANIME_CACHE_TTL_MS: 60000, JKANIME_MISS_CACHE_TTL_MS: 1000,
    REGULAR_SOURCE_SUCCESS_CACHE_HEADERS: { "Cache-Control": "public" },
    REGULAR_SOURCE_MISS_CACHE_HEADERS: { "Cache-Control": "public" },
    SOURCE_REFRESH_CACHE_HEADERS: { "Cache-Control": "private, no-store" },
    cleanJKAnimeSlug: value => value,
    sendJson: (response, body, status, headers) => Object.assign(response, { body, status, headers }),
    fetchJKAnimeEpisodeSourcesDirect: async () => {
      calls++;
      if (blocked) throw Object.assign(new Error("JKAnime episode HTTP 403"), { status: 403 });
      return { ok: true, sources: [{ url: "https://media.test/fixture.mp4" }] };
    }
  });
  vm.runInContext(section(server, "async function handleJKAnimeSources(", "async function fetchJKAnimeEpisodeSourcesDirect("), h.context);
  const responses = [{}, {}];
  await h.context.handleJKAnimeSources(new URL("https://app.test/api/jkanime/sources?slug=fixture&episode=1"), responses[0]);
  await h.context.handleJKAnimeSources(new URL("https://app.test/api/jkanime/sources?slug=fixture&episode=2&refresh=1"), responses[1]);
  assert.equal(calls, 1);
  assert.equal(responses.every(response => response.status === 503 && response.body.upstreamStatus === 403), true);
  assert.equal(responses[0].headers["Retry-After"], "60");
  assert.match(responses[0].headers["Cache-Control"], /no-store/);
  blocked = false;
  h.advance(60000);
  const recovered = {};
  await h.context.handleJKAnimeSources(new URL("https://app.test/api/jkanime/sources?slug=fixture&episode=2"), recovered);
  assert.equal(calls, 2);
  assert.equal(recovered.status, 200);
});

function clientPlaybackCooldownHarness(fetchImpl) {
  let now = 1000000;
  const calls = [];
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    URL, Map, Promise, Response,
    location: { origin: "https://app.test" },
    _animeNeonEpisodeSourceCache: new Map(), _animeNeonEpisodeSourceInflight: new Map(),
    ANIMENEON_CLIENT_CACHE_TTL_MS: 600000, ANIMENEON_CLIENT_MISS_TTL_MS: 60000,
    ANIMENEON_SOURCE_TIMEOUT_MS: 8500, JKANIME_SOURCE_TIMEOUT_MS: 6500,
    _jkAnimeEpisodeSourceCache: new Map(), _jkAnimeEpisodeSourceInflight: new Map(),
    preferredWatchLanguageForEpisode: () => "sub",
    getCanonicalEpisodeNumber: episode => episode.number,
    animeNeonSearchCandidates: show => [show.title], normalizeTitle: value => value.toLowerCase(),
    readEpisodeSourcePayloadCache: (map, key) => map.get(key) || null,
    writeEpisodeSourcePayloadCache: (map, key, value) => { map.set(key, value); return value; },
    fetchWithTimeout: async (...args) => { calls.push(args); return fetchImpl(...args); }
  });
  vm.runInContext(section(client, "const playbackProviderRetryAt =", "function animeNeonSearchCandidates("), context);
  vm.runInContext(section(client, "function animeNeonEpisodeSourceCacheKey(", "async function attachAnimeNeonSources("), context);
  vm.runInContext(section(client, "function fetchJKAnimeEpisodeSourcePayload(", "async function attachJKAnimeSources("), context);
  return { context, calls, advance: ms => { now += ms; } };
}

test("episode changes during an outage avoid additional Vercel source requests", async () => {
  let blocked = true;
  const h = clientPlaybackCooldownHarness(() => blocked
    ? new Response("outage", { status: 502, headers: { "retry-after": "60" } })
    : new Response(JSON.stringify({ ok: true, sources: [{ url: "https://media.test/fixture.mp4" }] })));
  await assert.rejects(h.context.fetchAnimeNeonEpisodeSources({ title: "Fixture" }, { number: 1 }));
  for (let number = 2; number <= 100; number++) {
    assert.equal(await h.context.fetchAnimeNeonEpisodeSources({ title: "Fixture" }, { number }, { forceRefresh: true }), null);
  }
  assert.equal(h.calls.length, 1);
  blocked = false;
  h.advance(60000);
  assert.equal((await h.context.fetchAnimeNeonEpisodeSources({ title: "Fixture" }, { number: 2 })).ok, true);
  assert.equal(h.calls.length, 2);
});

test("JKAnime cooldown retains cached success, isolates 404s, and expires", async () => {
  let status = 404;
  const h = clientPlaybackCooldownHarness(() => new Response("failed", {
    status, headers: { "retry-after": "30" }
  }));
  await h.context.fetchJKAnimeEpisodeSourcePayload("fixture", 1);
  assert.equal(h.context.playbackProviderIsCoolingDown("jkanime"), false);
  status = 503;
  await h.context.fetchJKAnimeEpisodeSourcePayload("fixture", 2);
  const good = { ok: true, sources: [{ url: "https://media.test/fixture.mp4" }] };
  h.context._jkAnimeEpisodeSourceCache.set("fixture:3", good);
  assert.equal(await h.context.fetchJKAnimeEpisodeSourcePayload("fixture", 3, { forceRefresh: true }), good);
  await h.context.fetchJKAnimeEpisodeSourcePayload("fixture", 4, { forceRefresh: true });
  assert.equal(h.calls.length, 2);
  h.advance(30000);
  await h.context.fetchJKAnimeEpisodeSourcePayload("fixture", 4);
  assert.equal(h.calls.length, 3);
});

test("client source cooldown understands HTTP-date Retry-After", () => {
  const h = clientPlaybackCooldownHarness(() => null);
  const date = new Date(1120000).toUTCString();
  h.context.deferPlaybackProviderOnFailure("animeneon", new Response("limited", {
    status: 429, headers: { "retry-after": date }
  }));
  h.advance(119999);
  assert.equal(h.context.playbackProviderIsCoolingDown("animeneon"), true);
  h.advance(1);
  assert.equal(h.context.playbackProviderIsCoolingDown("animeneon"), false);
});

test("catalog gzip is negotiated, coalesced, and preserves every JSON field", async () => {
  let compressions = 0;
  const payload = { ok: true, items: [{ title: "Fixture", sourceEpisodeIds: [1, 2], franchiseSeasons: [{ title: "Season 2" }] }] };
  const context = vm.createContext({
    Buffer, Map, WeakMap, Promise,
    SECURITY_HEADERS: {}, corsHeaders: () => ({}),
    CATALOG_RESPONSE_CACHE_HEADERS: { "Cache-Control": "public, s-maxage=600", Vary: "Accept-Encoding" },
    catalogResponseCache: { payload },
    gzip: (...args) => { compressions++; gzip(...args); }
  });
  vm.runInContext(section(server, "const catalogGzipCache =", "async function handleCatalog("), context);
  vm.runInContext(section(server, "function sendJson(", "function sendCorsPreflight("), context);
  const request = { headers: { "accept-encoding": "br, gzip, deflate" } };
  const responses = Array.from({ length: 100 }, imageResponse);
  await Promise.all(responses.map(response => context.sendCatalogJson(response, payload, request)));
  assert.equal(compressions, 1);
  for (const response of responses) {
    assert.equal(response.headers["Content-Encoding"], "gzip");
    assert.equal(Number(response.headers["Content-Length"]), response.body.length);
    assert.deepEqual(JSON.parse(gunzipSync(response.body)), payload);
  }
  const cached = imageResponse();
  await context.sendCatalogJson(cached, { ...payload, cached: true }, request);
  assert.equal(compressions, 2);
  assert.equal(JSON.parse(gunzipSync(cached.body)).cached, true);
  const plain = imageResponse();
  await context.sendCatalogJson(plain, payload, { headers: { "accept-encoding": "gzip;q=0, *;q=1" } });
  assert.equal(plain.headers["Content-Encoding"], undefined);
  assert.deepEqual(JSON.parse(plain.body), payload);
  assert.equal(context.acceptsCatalogGzip({ headers: { "accept-encoding": "*;q=0" } }), false);
  assert.equal(context.acceptsCatalogGzip({ headers: { "accept-encoding": "gzip;q=0.5" } }), true);
});
