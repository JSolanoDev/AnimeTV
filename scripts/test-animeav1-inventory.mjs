import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  animeAv1Slug,
  applyAnimeAv1EpisodeInventory,
  expandAnimeAv1PaginatedInventory,
  excludeUnavailableEpisodeIds,
  fetchInventory,
  markAnimeAv1InventoryUnavailable,
  parseAnimeAv1DirectMediaUrls,
  parseAnimeAv1EpisodeInventory,
  parseAnimeAv1PageMetadata,
  preserveVerifiedEpisodeRange,
  probeAnimeAv1Episode,
  retainAnimeAv1EpisodeInventory
} from "./build-animeav1-inventory.mjs";
import { requiresEmbedResolution, resolutionFailureStatus } from "./source-probe-policy.mjs";

const require = createRequire(import.meta.url);
const server = require("../animetv-server.js");
const {
  animeAv1CachedSourceStatus,
  animeAv1SourceResponseHeaders,
  shouldCacheAnimeAv1SourceStatus,
  applyRegularSourceFallback,
  applyAnimeAv1LatestInventory,
  hasVerifiedRegularSourceFallback,
  parseAnimeAv1Info,
  resolvedEmbedPlaybackUrl
} = server;

function requestServer(pathname, forwardedFor = "127.0.0.90") {
  return new Promise((resolve, reject) => {
    const response = {
      headersSent: false,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
        this.headersSent = true;
      },
      end(body = "") {
        resolve({ status: this.status, headers: this.headers, body: String(body) });
      }
    };
    try {
      server({
        method: "GET",
        url: pathname,
        headers: { host: "localhost", "x-forwarded-for": forwardedFor }
      }, response);
    } catch (error) {
      reject(error);
    }
  });
}

test("movie episode zero maps to one playable catalog item", () => {
  const parsed = parseAnimeAv1EpisodeInventory(
    'episodesCount:1,episodes:[{id:10,number:0}] <a href="/media/example-movie/0">Play</a>',
    "example-movie"
  );
  assert.deepEqual(parsed.sourceEpisodeIds, [0]);
  assert.equal(parsed.sourceEpisodeCount, 1);
  assert.equal(parsed.sourcePlayableEpisodeCount, 1);
});

test("episode zero is retained beside a contiguous television run", () => {
  const html = 'episodesCount:3 <a href="/media/example/0"></a><a href="/media/example/1"></a>'
    + '<a href="/media/example/2"></a><a href="/media/example/3"></a>';
  const parsed = parseAnimeAv1EpisodeInventory(html, "example");
  assert.deepEqual(parsed.sourceEpisodeIds, [0, 1, 2, 3]);
  assert.equal(parsed.sourceEpisodeCount, 3);
  assert.equal(parsed.sourcePlayableEpisodeCount, 4);
});

test("a confirmed dead episode zero is excluded without shrinking the TV run", () => {
  const parsed = parseAnimeAv1EpisodeInventory(
    'episodesCount:3 <a href="/media/example/0"></a><a href="/media/example/1"></a>'
      + '<a href="/media/example/2"></a><a href="/media/example/3"></a>',
    "example"
  );
  const filtered = excludeUnavailableEpisodeIds(parsed, [0]);
  assert.deepEqual(filtered.sourceEpisodeIds, [1, 2, 3]);
  assert.deepEqual(filtered.sourceUnavailableEpisodeIds, [0]);
  assert.equal(filtered.sourceEpisodeCount, 3);
  assert.equal(filtered.sourcePlayableEpisodeCount, 3);
});

test("AnimeAV1 player links normalize to directly probeable HLS URLs", () => {
  const html = 'embeds:{SUB:[{server:"HLS",url:"https://player.zilla-networks.com/play/0123456789abcdef0123456789abcdef"},'
    + '{server:"Voe",url:"https://voe.sx/e/example"}]},downloads:{}';
  assert.deepEqual(parseAnimeAv1DirectMediaUrls(html), [
    "https://player.zilla-networks.com/m3u8/0123456789abcdef0123456789abcdef"
  ]);
});

test("direct AnimeAV1 HLS is not mistaken for an unresolved iframe", () => {
  assert.equal(requiresEmbedResolution({
    type: "direct",
    externalType: "iframe",
    videoUrl: "/api/source?url=https%3A%2F%2Fplayer.zilla-networks.com%2Fm3u8%2Fexample",
    container: "hls"
  }), false);
  assert.equal(requiresEmbedResolution({
    type: "iframe",
    externalType: "iframe",
    videoUrl: "https://www.yourupload.com/embed/example"
  }), true);
});

test("media probe failures take precedence over a successful resolver response", () => {
  assert.equal(resolutionFailureStatus({
    resolverStatus: 200,
    media: { usable: false, httpStatus: 502 }
  }), 502);
});

test("YourUpload embed streams retain their required media referer", () => {
  const result = resolvedEmbedPlaybackUrl(
    "https://vidcache.net:8161/example/video.mp4",
    "https://www.yourupload.com/embed/example"
  );
  assert.match(result, /^\/api\/source\?/);
  const params = new URLSearchParams(result.split("?")[1]);
  assert.equal(params.get("url"), "https://vidcache.net:8161/example/video.mp4");
  assert.equal(params.get("refererHost"), "www.yourupload.com");
});

test("exact slug routes cannot absorb episode links from a related title", () => {
  const html = 'episodesCount:2 <a href="/media/example/1"></a><a href="/media/example/2"></a>'
    + '<a href="/media/example-season-2/12"></a>';
  assert.deepEqual(parseAnimeAv1EpisodeInventory(html, "example").sourceEpisodeIds, [1, 2]);
});

test("a latest-only rendered card merges its title-owned serialized inventory", () => {
  const html = 'anime:{episodesCount:2,slug:"current",category:{slug:"tv-anime"},'
    + 'episodes:[{number:1},{number:2}],relations:[{slug:"related",episodes:[{number:90}]}]}'
    + '<a href="/media/current/2"></a><a href="/media/related/90"></a>';
  assert.deepEqual(parseAnimeAv1EpisodeInventory(html, "current").sourceEpisodeIds, [1, 2]);
  assert.deepEqual(parseAnimeAv1Info(html, "current").sourceEpisodeIds, [1, 2]);
});

test("missing title-owned data cannot read a sibling title's inventory", () => {
  const html = 'anime:{episodesCount:2,slug:"current",category:{slug:"tv-anime"}},'
    + 'related:{slug:"related",episodes:[{number:90}]} <a href="/media/current/2"></a>';
  assert.deepEqual(parseAnimeAv1EpisodeInventory(html, "current").sourceEpisodeIds, [2]);
  assert.deepEqual(parseAnimeAv1Info(html, "current").sourceEpisodeIds, [2]);
});

test("daily inventories retain older routes omitted by a latest-only or empty page", () => {
  const previous = {
    sourceEpisodeIds: [1, 2], sourceEpisodeCount: 2,
    sourcePlayableEpisodeCount: 2, sourceInventoryChecked: true
  };
  const latestOnly = parseAnimeAv1EpisodeInventory('episodesCount:3 <a href="/media/current/3"></a>', "current");
  const merged = retainAnimeAv1EpisodeInventory(latestOnly, previous);
  assert.deepEqual(merged.sourceEpisodeIds, [1, 2, 3]);
  assert.equal(merged.sourceInventoryRetainedEpisodeCount, 2);
  assert.equal(merged.sourcePlayableEpisodeCount, 3);
  assert.deepEqual(retainAnimeAv1EpisodeInventory({
    sourceEpisodeIds: [], sourceEpisodeCount: 0, sourcePlayableEpisodeCount: 0
  }, previous).sourceEpisodeIds, [1, 2]);
});

test("retention respects confirmed removals, movie zero, and genuine sparse routes", () => {
  const previous = { sourceInventoryChecked: true, sourceEpisodeIds: [0, 1, 3], sourceUnavailableEpisodeIds: [2] };
  const inventory = { sourceEpisodeIds: [3, 5], sourceUnavailableEpisodeIds: [0] };
  const merged = retainAnimeAv1EpisodeInventory(inventory, previous);
  assert.deepEqual(merged.sourceEpisodeIds, [1, 3, 5]);
  assert.deepEqual(merged.sourceUnavailableEpisodeIds, [0, 2]);
  assert.deepEqual(retainAnimeAv1EpisodeInventory({ sourceEpisodeIds: [] }, {
    sourceInventoryChecked: true, sourceEpisodeIds: [0]
  }).sourceEpisodeIds, [0]);
});

test("a completed daily inventory clears feed-only partial provenance", () => {
  const item = { sourceInventoryPartial: true, sourceInventoryRefreshError: "previous failure" };
  applyAnimeAv1EpisodeInventory(item, {
    sourceEpisodeIds: [1, 2], sourceEpisodeCount: 2, sourcePlayableEpisodeCount: 2
  }, "2026-10-03T00:00:00Z");
  assert.equal(item.sourceInventoryPartial, false);
  assert.equal(item.sourceInventoryRefreshError, undefined);
});

test("an embed-only movie does not lose its published episode-zero route", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    'embeds:{SUB:[{server:"UPNShare",url:"https://animeav1.uns.bio/#published"}]}', { status: 200 }
  );
  try {
    assert.equal(await probeAnimeAv1Episode("https://animeav1.com", "movie", 0, 2500), null);
  } finally { globalThis.fetch = originalFetch; }
});

test("confirmed deleted episode pages remain unavailable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("missing", { status: 404 });
  try {
    assert.equal(await probeAnimeAv1Episode("https://animeav1.com", "movie", 0, 2500), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("a dead direct mirror cannot remove a listed episode with an embed fallback", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).includes("animeav1.com/media/")
    ? new Response('embeds:{SUB:[{server:"Direct",url:"https://video.test/movie.mp4"},'
      + '{server:"UPNShare",url:"https://animeav1.uns.bio/#published"}]}', { status: 200 })
    : new Response("deleted mirror", { status: 404 });
  try {
    assert.equal(await probeAnimeAv1Episode("https://animeav1.com", "movie", 0, 2500), null);
  } finally { globalThis.fetch = originalFetch; }
});

test("an explicitly dead direct-only mirror remains unavailable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).includes("animeav1.com/media/")
    ? new Response('server:"Direct",url:"https://video.test/movie.mp4"', { status: 200 })
    : new Response("deleted mirror", { status: 410 });
  try {
    assert.equal(await probeAnimeAv1Episode("https://animeav1.com", "movie", 0, 2500), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("inventory refreshes never retry a provider 429", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("rate limited", {
    status: 429, headers: { "Retry-After": "60" }
  }); };
  try {
    await assert.rejects(fetchInventory("https://animeav1.com", "current", 2500), (error) =>
      error.status === 429 && error.retryAfter === "60");
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("failed refreshes never clear an existing saved inventory or its verified date", () => {
  const item = { sourceInventoryChecked: true, sourceEpisodeIds: [1, 2],
    sourceEpisodeCount: 2, sourcePlayableEpisodeCount: 2, sourceInventoryCheckedAt: "saved-date" };
  markAnimeAv1InventoryUnavailable(item, new Error("HTTP 503"), "new-date");
  assert.deepEqual(item.sourceEpisodeIds, [1, 2]);
  assert.equal(item.sourceInventoryCheckedAt, "saved-date");
  assert.equal(item.sourceInventoryRefreshError, "HTTP 503");
});

test("the daily builder retains saved catalogs and stops its crawl after a provider 429", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "catalog-inventory-retention-"));
  const catalogPath = path.join(temp, "catalog.json");
  const previousPath = path.join(temp, "previous.json");
  let calls = 0;
  const provider = createServer((_request, response) => {
    calls += 1;
    response.writeHead(429, { "Retry-After": "60" });
    response.end("rate limited");
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  try {
    const saved = { id: "animeav1-saved", sourceInventoryChecked: true, sourceInventoryCheckedAt: "saved-date",
      sourceEpisodeIds: [1, 2], sourceEpisodeCount: 2, sourcePlayableEpisodeCount: 2 };
    await writeFile(catalogPath, JSON.stringify({ items: [saved, { id: "animeav1-previous-only" }] }));
    await writeFile(previousPath, JSON.stringify({ items: [{ ...saved, id: "animeav1-previous-only" }] }));
    await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL("./build-animeav1-inventory.mjs", import.meta.url)),
      `--catalog=${catalogPath}`, `--previous=${previousPath}`,
      `--base=http://127.0.0.1:${provider.address().port}`, "--concurrency=1", "--write"
    ]);
    const result = JSON.parse(await readFile(catalogPath, "utf8"));
    assert.equal(calls, 1);
    assert.equal(result.sourceInventory.rateLimited, true);
    assert.equal(result.sourceInventory.retryAfter, "60");
    assert.equal(result.items.length, 2);
    for (const item of result.items) {
      assert.deepEqual(item.sourceEpisodeIds, [1, 2]);
      assert.equal(item.sourceInventoryCheckedAt, "saved-date");
    }
  } finally {
    await new Promise(resolve => provider.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});

test("a boundary-verified paginated inventory restores the hidden episode tail", () => {
  const parsed = parseAnimeAv1EpisodeInventory(
    'episodesCount:53 <a href="/media/long-show/1"></a><a href="/media/long-show/3"></a>'
      + Array.from({ length: 47 }, (_, index) => `<a href="/media/long-show/${index + 4}"></a>`).join(""),
    "long-show"
  );
  assert.equal(parsed.sourceEpisodeCount, 50);
  const expanded = expandAnimeAv1PaginatedInventory(parsed);
  assert.equal(expanded.sourceEpisodeCount, 53);
  assert.equal(expanded.sourcePlayableEpisodeCount, 52);
  assert.equal(expanded.sourceEpisodeIds.includes(2), false);
  assert.deepEqual(expanded.sourceEpisodeIds.slice(-3), [51, 52, 53]);
  assert.equal(expanded.sourceInventoryRangeVerified, true);
});

test("an inconclusive refresh preserves a previously verified long-series range", () => {
  const current = {
    sourceEpisodeIds: [1, 2, 3],
    sourceEpisodeCount: 3,
    sourcePlayableEpisodeCount: 3,
    sourceDeclaredEpisodeCount: 5,
    sourceInventoryRangeProbeStatus: "inconclusive"
  };
  const previous = {
    sourceEpisodeIds: [1, 2, 3, 4, 5],
    sourceEpisodeCount: 5,
    sourcePlayableEpisodeCount: 5,
    sourceDeclaredEpisodeCount: 5,
    sourceInventoryRangeVerified: true
  };
  const preserved = preserveVerifiedEpisodeRange(current, previous);
  assert.deepEqual(preserved.sourceEpisodeIds, [1, 2, 3, 4, 5]);
  assert.equal(preserved.sourceInventoryRangeVerified, true);
  assert.equal(preserved.sourceInventoryRangeProbeStatus, "restored");
});

test("a confirmed range rejection does not preserve stale hidden episodes", () => {
  const current = {
    sourceEpisodeIds: [1, 2, 3],
    sourceEpisodeCount: 3,
    sourcePlayableEpisodeCount: 3,
    sourceDeclaredEpisodeCount: 5,
    sourceInventoryRangeProbeStatus: "rejected"
  };
  const previous = {
    sourceEpisodeIds: [1, 2, 3, 4, 5],
    sourcePlayableEpisodeCount: 5,
    sourceDeclaredEpisodeCount: 5,
    sourceInventoryRangeVerified: true
  };
  assert.equal(preserveVerifiedEpisodeRange(current, previous), current);
});

test("transient AnimeAV1 failures are never cached as missing episodes", () => {
  assert.equal(shouldCacheAnimeAv1SourceStatus(404), true);
  assert.equal(shouldCacheAnimeAv1SourceStatus(503), false);
  assert.equal(animeAv1CachedSourceStatus({ status: 503, data: { ok: false } }), 503);
  assert.equal(animeAv1CachedSourceStatus({ data: { ok: false } }), 404);
});

test("only successful AnimeAV1 source maps are shared through HTTP caches", () => {
  assert.match(animeAv1SourceResponseHeaders(200)["Cache-Control"], /public/);
  assert.match(animeAv1SourceResponseHeaders(200)["Cache-Control"], /s-maxage=300/);
  assert.equal(animeAv1SourceResponseHeaders(404)["Cache-Control"], "no-store, max-age=0");
  assert.equal(animeAv1SourceResponseHeaders(503)["Cache-Control"], "no-store, max-age=0");
});

test("concurrent cold AnimeAV1 requests share one provider fetch", async () => {
  const originalFetch = globalThis.fetch;
  let providerFetches = 0;
  let releaseProvider;
  const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("animeav1.com/media/coalesce-fixture/7")) {
      providerFetches += 1;
      await providerGate;
      return new Response(
        'embeds:{SUB:[{server:"HLS",url:"https://player.zilla-networks.com/play/0123456789abcdef0123456789abcdef"},{server:"Voe",url:"https://voe.sx/e/coalesce"}]},downloads:{}',
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }
    return originalFetch(input, init);
  };

  try {
    const endpoint = "/api/animeav1/sources?slug=coalesce-fixture&episode=7&variant=SUB";
    const first = requestServer(endpoint, "127.0.0.91");
    const second = requestServer(endpoint, "127.0.0.92");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(providerFetches, 1);
    releaseProvider();
    const responses = await Promise.all([first, second]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    assert.ok(responses.every((response) => /s-maxage=300/.test(response.headers["Cache-Control"])));
    const payload = JSON.parse(responses[0].body);
    assert.equal(payload.sources.length, 1);
    assert.equal(payload.castSources.length, 2);
    assert.equal(payload.castSources[1].provider, "Voe");
    assert.equal(payload.castSources[1].type, "iframe");
  } finally {
    globalThis.fetch = originalFetch;
    releaseProvider?.();
  }
});

test("inventory fields are applied without replacing catalog identity", () => {
  const item = { id: "animeav1-example", title: "Example" };
  const inventory = parseAnimeAv1EpisodeInventory('episodesCount:1,episodes:[{id:1,number:0}]', "example");
  applyAnimeAv1EpisodeInventory(item, inventory, "2026-09-07T00:00:00.000Z");
  assert.equal(animeAv1Slug(item), "example");
  assert.equal(item.title, "Example");
  assert.deepEqual(item.sourceEpisodeIds, [0]);
  assert.equal(item.sourceInventoryChecked, true);
});

test("latest feed advances the exact catalog slug before the daily inventory build", () => {
  const [updated, unrelated] = applyAnimeAv1LatestInventory([
    {
      id: "animeav1-current-show",
      title: "Current Show",
      animeAv1Slug: "current-show",
      sourceEpisodeIds: Array.from({ length: 9 }, (_, index) => index + 1),
      sourceEpisodeCount: 9,
      sourcePlayableEpisodeCount: 9,
      sourceInventoryChecked: true
    },
    {
      id: "animeav1-current-show-special",
      title: "Current Show Special",
      animeAv1Slug: "current-show-special",
      sourceEpisodeIds: [1],
      sourceEpisodeCount: 1,
      sourcePlayableEpisodeCount: 1,
      sourceInventoryChecked: true
    }
  ], [{ slug: "current-show", title: "Current Show", episode: 10 }], "2026-09-08T20:00:00.000Z");

  assert.deepEqual(updated.sourceEpisodeIds, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(updated.sourceEpisodeCount, 10);
  assert.equal(updated.sourcePlayableEpisodeCount, 10);
  assert.equal(updated.latestAiredEp, 10);
  assert.deepEqual(unrelated.sourceEpisodeIds, [1]);
});

test("latest feed records an exact non-contiguous provider id without inventing gaps", () => {
  const [updated] = applyAnimeAv1LatestInventory([{
    id: "animeav1-gapped-show",
    animeAv1Slug: "gapped-show",
    sourceEpisodeIds: [1, 2, 3],
    sourceEpisodeCount: 3,
    sourcePlayableEpisodeCount: 3,
    sourceInventoryChecked: true
  }], [{ slug: "gapped-show", title: "Gapped Show", episode: 6 }]);

  assert.deepEqual(updated.sourceEpisodeIds, [1, 2, 3, 6]);
  assert.equal(updated.sourceEpisodeCount, 6);
  assert.equal(updated.sourcePlayableEpisodeCount, 4);
});

test("latest movie route zero remains provider zero while displaying episode one", () => {
  const [movie] = applyAnimeAv1LatestInventory([], [{
    slug: "example-movie",
    title: "Example Movie",
    image: "movie.jpg",
    episode: 0
  }], "2026-09-08T20:00:00.000Z");

  assert.equal(movie.episode, 1);
  assert.equal(movie.format, "MOVIE");
  assert.deepEqual(movie.sourceEpisodeIds, [0]);
  assert.equal(movie.sourceEpisodeCount, 1);
});

test("feed-only catalog rows retain partial inventory provenance on repeated merges", () => {
  const latest = { slug: "new-second-season", title: "New Second Season", episode: 2 };
  const [initial] = applyAnimeAv1LatestInventory([], [latest]);
  assert.equal(initial.sourceInventoryPartial, true);
  assert.deepEqual(initial.sourceEpisodeIds, [2]);
  assert.equal(initial.sourceEpisodeCount, 2);
  const [merged] = applyAnimeAv1LatestInventory([initial], [latest]);
  assert.equal(merged.sourceInventoryPartial, true);
  assert.deepEqual(merged.sourceEpisodeIds, [2]);

  const [complete] = applyAnimeAv1LatestInventory([{
    ...initial, sourceInventoryPartial: false,
    sourceEpisodeIds: [1, 2], sourcePlayableEpisodeCount: 2
  }], [latest]);
  assert.equal(complete.sourceInventoryPartial, false);
  assert.deepEqual(complete.sourceEpisodeIds, [1, 2]);
});

test("provider route casing survives inventory lookup", () => {
  assert.equal(animeAv1Slug({
    id: "animeav1-castlevania",
    siteUrl: "https://animeav1.com/media/Castlevania"
  }), "Castlevania");
});

test("a listing with no published routes is explicitly unavailable", () => {
  const item = { id: "animeav1-empty", title: "Empty" };
  markAnimeAv1InventoryUnavailable(item, new Error("episode inventory missing from page"), "2026-09-08T00:00:00.000Z");
  assert.deepEqual(item.sourceEpisodeIds, []);
  assert.equal(item.sourcePlayableEpisodeCount, 0);
  assert.equal(item.sourceInventoryChecked, true);
  assert.match(item.sourceInventoryUnavailableReason, /inventory missing/);
});

test("verified fallback mapping keeps canonical and provider episode ids separate", () => {
  const item = applyRegularSourceFallback({
    id: "animeav1-deadman-wonderland-akai-knife-tsukai",
    title: "Deadman Wonderland: Akai Knife Tsukai",
    source: "AnimeAV1",
    sourceInventoryChecked: true,
    sourceEpisodeIds: [],
    sourcePlayableEpisodeCount: 0
  }, {
    "animeav1-deadman-wonderland-akai-knife-tsukai": {
      provider: "TioAnime",
      providerAnimeSlug: "deadman-wonderland",
      episodeMap: { "1": 13 },
      verified: true,
      verifiedAt: "2026-09-08T18:45:00.000Z"
    }
  });
  assert.equal(hasVerifiedRegularSourceFallback(item), true);
  assert.deepEqual(item.fallbackEpisodeIds, [1]);
  assert.deepEqual(item.fallbackEpisodeMap, { 1: 13 });
  assert.equal(item.episode, 1);
  assert.equal(item.sourcePlayableEpisodeCount, 0);
});

test("provider page metadata supplies identity, date, runtime, and type", () => {
  const html = 'anime:{title:"Example",runtime:24,startDate:"2020-04-01",endDate:"2020-06-01",'
    + 'episodesCount:12,score:7.42,slug:"Example-Path",malId:12345,'
    + 'category:{id:1,name:"TV Anime",slug:"tv-anime",malId:"TV"},episodes:[{id:1,number:1}]}'
    + ' <a href="/media/Example-Path/1"></a>';
  assert.deepEqual(parseAnimeAv1PageMetadata(html, "Example-Path"), {
    sourceMalId: 12345,
    sourceRuntime: 24,
    sourceScore: 7.42,
    sourceStartDate: "2020-04-01",
    sourceEndDate: "2020-06-01",
    sourceType: "TV"
  });
});
