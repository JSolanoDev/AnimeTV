import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRegularArtwork, prepareRegularArtworkFiles } from "./prepare-regular-artwork.mjs";
import { regularArtworkPriority } from "./lib/regular-artwork-priority.mjs";
import { buildHomepageBootstrap } from "./build-homepage-bootstrap.mjs";

const POSTER = "https://image.tmdb.org/t/p/original/neutral-poster.jpg";
const BACKGROUND = "https://image.tmdb.org/t/p/original/neutral-background.jpg";
const COVER = "https://cdn.animeav1.com/covers/100.jpg";
const STRIP = "https://cdn.animeav1.com/backdrops/100.jpg";
const imageResponse = () => new Response(null, { headers: { "Content-Type": "image/jpeg", "Content-Length": "4096" } });
function fixture(id = "animeav1-neutral") {
  return {
    catalog: { items: [{ id, title: "Neutral series", poster: COVER, image: COVER, banner: STRIP,
      sourceEpisodeIds: [1, 2, 3], sourcePlayableEpisodeCount: 3, totalEpisodes: 3,
      episodes: [{ episode: 1, siteUrl: "https://animeav1.com/media/neutral/1" }],
      seasons: [{ season: 1, episodes: [{ episode: 1 }] }] }] },
    artwork: { count: 1, entries: { [id]: { status: "ok", anilistId: 17, tmdbId: 27,
      tmdbPoster: POSTER, tmdbBackdrop: BACKGROUND, meta: { description: "A complete neutral synopsis." } } } }
  };
}
const prepare = (data, options = {}) => prepareRegularArtwork({ ...data, intervalMs: 0,
  fetchImpl: async () => imageResponse(), ...options });

test("new regular titles check unique CDN assets once and have artwork at first homepage paint", async () => {
  const data = fixture();
  const requests = [];
  const result = await prepare(data, { fetchImpl: async (url, options) => {
    requests.push({ url, method: options.method });
    return imageResponse();
  } });
  assert.equal(result.stats.checkedUrls, 4);
  assert.equal(new Set(requests.map(request => request.url)).size, 4);
  assert.ok(requests.every(request => request.method === "HEAD" && !request.url.includes("/api/")));
  const home = buildHomepageBootstrap(result.catalog, result.artwork, {});
  assert.equal(home.items[0].image, POSTER);
  assert.equal(home.items[0].tmdbBackdrop, BACKGROUND);
  assert.equal(home.items[0].description, data.artwork.entries["animeav1-neutral"].meta.description);
});

test("unchanged regular catalog artwork adds zero upstream requests and zero payload changes", async () => {
  const data = fixture();
  const before = structuredClone(data);
  const result = await prepare(data, { previousCatalog: data.catalog, previousArtwork: data.artwork,
    fetchImpl: () => { throw new Error("Unexpected request"); } });
  assert.deepEqual({ catalog: result.catalog, artwork: result.artwork }, before);
  assert.deepEqual(data, before);
  assert.deepEqual(result.stats, { checkedUrls: 0, rejectedUrls: 0, repairedTitles: 0 });
});

test("failed replacement backgrounds retain the same exact title's saved background", async () => {
  const prior = fixture();
  const data = fixture();
  data.artwork.entries["animeav1-neutral"].tmdbBackdrop = "https://image.tmdb.org/t/p/original/new-dead.jpg";
  const result = await prepare(data, { previousCatalog: prior.catalog, previousArtwork: prior.artwork,
    fetchImpl: async () => new Response(null, { status: 404 }) });
  assert.equal(result.artwork.entries["animeav1-neutral"].tmdbBackdrop, BACKGROUND);
  assert.equal(result.stats.checkedUrls, 1);
  assert.equal(result.stats.rejectedUrls, 1);
  assert.equal(result.stats.repairedTitles, 1);
});

test("existing source rows keep sparse fields while the artwork map supplies their ready background", async () => {
  const data = fixture();
  data.catalog.items[0].banner = null;
  const before = structuredClone(data);
  const result = await prepare(data, { previousCatalog: data.catalog, previousArtwork: data.artwork,
    fetchImpl: () => { throw new Error("Unexpected request"); } });
  assert.deepEqual({ catalog: result.catalog, artwork: result.artwork }, before);
  assert.equal(result.stats.repairedTitles, 0);
  assert.equal(buildHomepageBootstrap(result.catalog, result.artwork, {}).items[0].tmdbBackdrop, BACKGROUND);
});

test("dead or HTML metadata posters use the exact AniList cover without pretending it is TMDB", async () => {
  for (const status of [404, 200]) {
    const data = fixture();
    const exactCover = "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/neutral.jpg";
    data.artwork.entries["animeav1-neutral"].anilistCover = exactCover;
    const result = await prepare(data, { fetchImpl: async url => url === POSTER
      ? new Response(null, { status, headers: { "Content-Type": "text/html" } }) : imageResponse() });
    const art = result.artwork.entries["animeav1-neutral"];
    assert.equal(art.tmdbPoster, "");
    assert.equal(art.anilistCover, exactCover);
    assert.equal(art.tmdbBackdrop, BACKGROUND);
    assert.equal(art.status, "artwork-fallback");
    assert.equal(buildHomepageBootstrap(result.catalog, result.artwork, {}).items[0].image, exactCover);
  }
});

test("an unresolved new title gets its exact provider cover, never another title's artwork", async () => {
  const data = fixture();
  data.artwork = { entries: { "animeav1-unrelated": { status: "ok", tmdbPoster: POSTER } } };
  const result = await prepare(data);
  assert.equal(result.artwork.entries["animeav1-neutral"].metadataCover, COVER);
  assert.equal(result.artwork.entries["animeav1-neutral"].tmdbPoster, undefined);
  assert.equal(result.artwork.entries["animeav1-neutral"].status, "artwork-fallback");
  assert.equal(result.artwork.entries["animeav1-unrelated"].tmdbPoster, POSTER);
});

test("provider source covers recover from the already-supported exact backdrop variant", async () => {
  const data = fixture();
  data.catalog.items[0].poster = "https://cdn.animeav1.com/covers/dead.jpg";
  data.catalog.items[0].image = data.catalog.items[0].poster;
  data.artwork = { entries: {} };
  const result = await prepare(data, { fetchImpl: async url => url.includes("dead.jpg")
    ? new Response(null, { status: 404 }) : imageResponse() });
  assert.equal(result.catalog.items[0].image, COVER);
  assert.equal(result.artwork.entries["animeav1-neutral"].metadataCover, COVER);
});

test("static episode-thumbnail replacements keep a previous exact fallback without changing episodes", async () => {
  const prior = fixture();
  prior.artwork.entries["animeav1-neutral"].episodeThumbnailFallback = BACKGROUND;
  const data = structuredClone(prior);
  data.artwork.entries["animeav1-neutral"].episodeThumbnailFallback = "https://cdn.myanimelist.net/images/anime/dead.jpg";
  const result = await prepare(data, { previousCatalog: prior.catalog, previousArtwork: prior.artwork,
    fetchImpl: async () => new Response(null, { status: 404 }) });
  assert.equal(result.artwork.entries["animeav1-neutral"].episodeThumbnailFallback, BACKGROUND);
  assert.deepEqual(result.catalog.items[0].episodes, prior.catalog.items[0].episodes);
  assert.equal(result.stats.checkedUrls, 1);
});

test("multiple new title records sharing an asset still perform just one check per URL", async () => {
  const data = fixture();
  const second = fixture("animeav1-neutral-second");
  data.catalog.items.push(...second.catalog.items);
  Object.assign(data.artwork.entries, second.artwork.entries);
  const calls = [];
  const result = await prepare(data, { fetchImpl: async url => { calls.push(url); return imageResponse(); } });
  assert.equal(result.stats.checkedUrls, 4);
  assert.equal(calls.length, new Set(calls).size);
});

test("changed metadata identities cannot reuse a different season's previous artwork", async () => {
  const data = fixture();
  data.catalog.items = [];
  data.artwork.entries["animeav1-neutral"].anilistId = 18;
  const previousArtwork = fixture().artwork;
  // Use different, unpublished asset URLs so the previous URL cache cannot certify them.
  data.artwork.entries["animeav1-neutral"].tmdbPoster = "https://image.tmdb.org/t/p/original/new-season.jpg";
  data.artwork.entries["animeav1-neutral"].tmdbBackdrop = "";
  await assert.rejects(prepare(data, { previousArtwork,
    fetchImpl: async () => new Response(null, { status: 404 }) }), /refusing partial publication/);
});

test("new titles with no available artwork fail without changing the catalog or episode inventories", async () => {
  const data = fixture();
  const before = structuredClone(data);
  await assert.rejects(prepare(data, { fetchImpl: async () => new Response(null, { status: 404 }) }), /refusing partial publication/);
  assert.deepEqual(data, before);
  const result = await prepare(data);
  assert.deepEqual(result.catalog.items[0].episodes, before.catalog.items[0].episodes);
  assert.deepEqual(result.catalog.items[0].seasons, before.catalog.items[0].seasons);
  assert.deepEqual(result.catalog.items[0].sourceEpisodeIds, [1, 2, 3]);
  assert.equal(result.catalog.items[0].totalEpisodes, 3);
});

test("regular artwork provider blocks, rate limits, server failures and deadlines do not retry", async () => {
  for (const status of [403, 429, 503, "timeout"]) {
    let calls = 0;
    await assert.rejects(prepare(fixture(), { timeoutMs: 5, fetchImpl: async (_url, options) => {
      calls++;
      if (status === "timeout") return new Promise((_, reject) => options.signal.addEventListener("abort",
        () => reject(new DOMException("aborted", "AbortError"))));
      return new Response(null, { status, headers: { "Retry-After": "120" } });
    } }), error => error.code === "ARTWORK_UPSTREAM_UNAVAILABLE" && (status === "timeout" || error.retryAfter === "120"));
    assert.equal(calls, 1);
  }
});

test("new regular artwork redirects cannot reach a private host, and checks have a hard budget", async () => {
  const data = fixture();
  const calls = [];
  await assert.rejects(prepare(data, { fetchImpl: async url => {
    calls.push(url);
    return new Response(null, { status: 302, headers: { Location: "https://127.0.0.1/private" } });
  } }), /refusing partial publication/);
  assert.ok(calls.every(url => !url.includes("127.0.0.1")));
  await assert.rejects(prepare(data, { maxChecks: 1 }), /budget exhausted/);
});

test("newly seeded offline identities have priority over repeated old artwork misses", () => {
  const entries = { new: { status: "offline-db" }, old: { status: "rejected" }, repair: { status: "identity-repaired" } };
  const published = new Set(["old", "repair"]);
  assert.ok(regularArtworkPriority({ id: "new" }, entries, published) > regularArtworkPriority({ id: "old" }, entries, published));
  assert.ok(regularArtworkPriority({ id: "repair" }, entries, published) > regularArtworkPriority({ id: "new" }, entries, published));
  assert.equal(regularArtworkPriority({ id: "new" }, entries, null), 0);
});

test("daily regular workflow makes artwork readiness a required gate before sync, validation and publication", async () => {
  const workflow = await readFile(new URL("../.github/workflows/scrape-catalog.yml", import.meta.url), "utf8");
  const gate = workflow.indexOf("name: Prepare and verify new regular title artwork before publication");
  assert.ok(gate > workflow.indexOf("name: Refresh high-quality related season artwork"));
  assert.ok(gate < workflow.indexOf("name: Sync regular catalog assets to Android"));
  assert.ok(gate < workflow.indexOf("name: Validate regular catalog, playback identity, and seasons"));
  assert.ok(gate < workflow.indexOf("name: Refresh homepage starter catalog"));
  const step = workflow.slice(gate, workflow.indexOf("- name:", gate + 6));
  assert.doesNotMatch(step, /continue-on-error/);
});

test("file publishing checks leave every file untouched on failure and synchronize successful repairs", async t => {
  const root = await mkdtemp(join(tmpdir(), "zenkai-regular-artwork-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scraper"));
  await mkdir(join(root, "android/app/src/main/assets/scraper"), { recursive: true });
  const data = fixture();
  const catalogPath = join(root, "scraper/anime_metadata.json");
  const artPath = join(root, "scraper/artwork-map.json");
  const mirrorPath = join(root, "android/app/src/main/assets/scraper/artwork-map.json");
  await writeFile(catalogPath, JSON.stringify(data.catalog));
  await writeFile(artPath, JSON.stringify(data.artwork));
  await writeFile(mirrorPath, JSON.stringify(data.artwork));
  const git = args => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git(["init", "-q"]);
  git(["add", "."]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "neutral baseline"]);
  data.artwork.entries["animeav1-neutral"].tmdbPoster = "https://image.tmdb.org/t/p/original/replacement.jpg";
  await writeFile(artPath, JSON.stringify(data.artwork));
  const before = await Promise.all([catalogPath, artPath, mirrorPath].map(file => readFile(file)));
  await assert.rejects(prepareRegularArtworkFiles({ root, fetchImpl: async () => new Response(null, { status: 429 }) }),
    { code: "ARTWORK_UPSTREAM_UNAVAILABLE" });
  assert.deepEqual(await Promise.all([catalogPath, artPath, mirrorPath].map(file => readFile(file))), before);
  const stats = await prepareRegularArtworkFiles({ root, fetchImpl: async () => new Response(null, { status: 404 }) });
  assert.equal(stats.repairedTitles, 1);
  assert.deepEqual(await readFile(artPath), await readFile(mirrorPath));
  assert.equal(JSON.parse(await readFile(artPath)).entries["animeav1-neutral"].tmdbPoster, POSTER);
});
