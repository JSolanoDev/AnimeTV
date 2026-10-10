import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { buildHomepageBootstrap } from "./build-homepage-bootstrap.mjs";

const client = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const normalizer = readFileSync(new URL("../js/normalize.js", import.meta.url), "utf8");
const constants = readFileSync(new URL("../js/constants.js", import.meta.url), "utf8");
const section = (start, end) => {
  const from = client.indexOf(start);
  const to = client.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from);
  return client.slice(from, to);
};

test("homepage snapshot revalidates as a static file without a Function call", () => {
  const fetchSource = section("async function fetchHomepageBootstrapCatalog(", "let _latestLoadTimer");
  assert.match(fetchSource, /HOMEPAGE_BOOTSTRAP_ENDPOINT, \{ cache: "no-cache" \}/);
  assert.match(fetchSource, /state\.bootstrapReleases = normalized/);
  assert.doesNotMatch(fetchSource, /\/api\//);
});

test("home bootstrap follows recent playable releases and includes baked artwork", () => {
  const catalog = {
    scrapedAt: "2026-09-17T11:00:00Z",
    items: [
      { id: "animeav1-old", title: "Older", episode: 8, sourcePlayableEpisodeCount: 8, episodes: [{ episode: 1 }] },
      { id: "animeav1-new", title: "Newest", episode: 12, sourcePlayableEpisodeCount: 12, siteUrl: "https://animeav1.com/media/new" },
      { id: "animeav1-dead", title: "Unavailable", sourcePlayableEpisodeCount: 0 }
    ]
  };
  const artwork = { generatedAt: "2026-09-17T12:00:00Z", entries: {
    "animeav1-new": {
      anilistId: 7, malId: 8, tmdbId: 9,
      tmdbBackdrop: "https://image.tmdb.org/t/p/original/new.jpg",
      tmdbPoster: "https://image.tmdb.org/t/p/original/poster.jpg",
      episodeThumbnailFallback: "https://cdn.myanimelist.net/images/anime/examplel.jpg",
      meta: { year: 2026, score: 82, genres: ["Action"], studio: "Studio", description: "A complete synopsis. ".repeat(30) }
    }
  } };
  const airing = { generatedAt: "2026-09-17T10:00:00Z", entries: {
    "animeav1-new": { lastEpisodeAt: "2026-09-17T09:00:00Z" },
    "animeav1-old": { lastEpisodeAt: "2026-09-10T09:00:00Z" }
  } };
  const payload = buildHomepageBootstrap(catalog, artwork, airing);
  assert.deepEqual(payload.items.map((row) => row.id), ["animeav1-new", "animeav1-old"]);
  assert.equal(payload.generatedAt, "2026-09-17T12:00:00.000Z");
  assert.equal(payload.items[0].tmdbBackdrop, artwork.entries["animeav1-new"].tmdbBackdrop);
  assert.equal(payload.items[0].episodeThumbnailFallback, artwork.entries["animeav1-new"].episodeThumbnailFallback);
  assert.equal(payload.items[0].studios[0], "Studio");
  assert.ok(payload.items[0].description.length <= 321);
  assert.equal(payload.items[1].episodes, undefined);
});

test("provider release observations override stale completed-stage metadata", () => {
  const catalog = { items: [{
    id: "animeav1-steel-ball-run", title: "Steel Ball Run", episode: 2,
    totalEpisodes: 2, sourceEpisodeCount: 2, sourcePlayableEpisodeCount: 2,
    sourceEpisodeIds: [1, 2], sourceInventoryChecked: true, status: ""
  }] };
  const artwork = { entries: { "animeav1-steel-ball-run": {
    meta: { episodes: 1, airingStatus: "FINISHED", format: "ONA" }
  } } };
  const airing = { entries: { "animeav1-steel-ball-run": {
    airingStatus: "RELEASING", sourceEpisodeCount: 2,
    lastEpisodeAt: "2026-09-25T13:33:03.015Z"
  } } };

  const [row] = buildHomepageBootstrap(catalog, artwork, airing).items;
  assert.equal(row.status, "RELEASING");
  assert.equal(row.episode, 2);
  assert.deepEqual(row.sourceEpisodeIds, [1, 2]);
  assert.equal(row.lastEpisodeAt, "2026-09-25T13:33:03.015Z");
});

test("an hourly episode observation outranks last week's schedule in the offline starter", () => {
  const catalog = { items: [{ id: "animeav1-neutral", title: "Neutral", episode: 4,
    sourceEpisodeCount: 4, sourcePlayableEpisodeCount: 4, sourceEpisodeIds: [1, 2, 3, 4],
    lastEpisodeAt: "2026-10-09T12:30:30.205Z" },
  { id: "animeav1-other", title: "Other", episode: 1, sourcePlayableEpisodeCount: 1 }] };
  const airing = { entries: { "animeav1-neutral": { lastEpisodeAt: "2026-10-02T12:30:00Z" },
    "animeav1-other": { lastEpisodeAt: "2026-10-08T12:30:00Z" } } };
  const payload = buildHomepageBootstrap(catalog, {}, airing);
  assert.equal(payload.items[0].id, "animeav1-neutral");
  assert.equal(payload.items[0].episode, 4);
  assert.equal(payload.items[0].lastEpisodeAt, catalog.items[0].lastEpisodeAt);
  assert.deepEqual(payload.items[0].sourceEpisodeIds, [1, 2, 3, 4]);
});

test("starter inventories stay partial when exact long-series ids are deliberately omitted", () => {
  const sourceEpisodeIds = Array.from({ length: 40 }, (_, index) => index + 1);
  const [row] = buildHomepageBootstrap({ items: [{
    id: "animeav1-long-show", title: "Long Show", sourceInventoryChecked: true,
    sourceEpisodeCount: 40, sourcePlayableEpisodeCount: 40, sourceEpisodeIds
  }] }, {}, {}).items;
  assert.equal(row.sourceEpisodeIds, undefined);
  assert.equal(row.sourceInventoryPartial, true);
  assert.equal(row.sourceEpisodeCount, 40);
});

test("current homepage snapshot retains recent specials behind newer releases", () => {
  const payload = JSON.parse(readFileSync(new URL("../homepage-bootstrap.json", import.meta.url), "utf8"));
  const narumiIndex = payload.items.findIndex((row) => /narumi-no-heijitsu/i.test(String(row.id || "")));
  const jojoIndex = payload.items.findIndex((row) => /steel-ball-run/i.test(String(row.id || "")));

  assert.ok(narumiIndex >= 0);
  assert.ok(jojoIndex >= 0);
  assert.ok(payload.items[narumiIndex].episode >= 4);
  assert.ok(payload.items[jojoIndex].episode >= 2);
  const dated = payload.items.map(row => Date.parse(row.lastEpisodeAt || "") || 0);
  for (let i = 1; i < dated.length; i++) assert.ok(dated[i - 1] >= dated[i]);
  assert.match(constants, /const HOME_INITIAL_CARD_LIMIT = 24;/);
});

test("latest-release ranking uses an exact provider publication timestamp", () => {
  const c = vm.createContext({
    Date,
    navigator: { languages: ["en-US"], language: "en-US" },
    Intl,
    Map,
    Set
  });
  vm.runInContext(section("let _weekdayIndexByName = null;", "function recentlyAiredShows"), c);
  const releasedAt = Date.parse("2026-09-25T13:33:03.015Z");
  assert.equal(c.lastEpisodeAiredMs({ lastEpisodeAt: "2026-09-25T13:33:03.015Z" }, releasedAt + 1000), releasedAt);
});

test("catalog placeholders are deferred while embedded episodes stay available", () => {
  let normalized = 0;
  const c = vm.createContext({
    animeAv1ArtworkVariant: () => "",
    pickGenre: () => "Action",
    normalizeSeasons: () => { normalized += 1; return []; },
    pickPlayableUrl: () => "",
    getEpisodeUrl: () => "",
    cleanDescription: (value) => value
  });
  vm.runInContext(normalizer.slice(0, normalizer.indexOf("function normalizeSeasons(")), c);
  const item = { id: "animeav1-one-piece", title: "One Piece", episode: 1178 };
  assert.equal(c.normalizeExternalShow(item, { id: "homepage-bootstrap" }, 0).seasons.length, 0);
  assert.equal(normalized, 0);
  c.normalizeExternalShow(item, { id: "animetv-api" }, 0);
  assert.equal(normalized, 0);
  c.normalizeExternalShow({ ...item, episodes: [{ episode: 1 }] }, { id: "animetv-api" }, 0);
  assert.equal(normalized, 1);
});

test("complete baked title metadata avoids redundant AniList and Jikan lookups", () => {
  const c = vm.createContext({});
  vm.runInContext(section("function hasBakedCanonicalMetadata(", "async function hydrateCanonicalAnimeMetadata("), c);
  const rich = {
    catalogAnimeId: "animeav1-new", anilistId: 7, malId: 8, tmdbId: 9,
    _artworkPinned: true, description: "A complete catalog synopsis. ".repeat(5),
    year: 2026, score: 82, genres: ["Action"], studios: ["Studio"]
  };
  assert.equal(c.hasBakedCanonicalMetadata(rich), true);
  assert.equal(c.hasBakedCanonicalMetadata({ ...rich, description: "Short" }), false);
  assert.equal(c.hasBakedCanonicalMetadata({ ...rich, catalogAnimeId: "other-provider" }), false);
});

test("full synopsis lookup uses the original AnimeAV1 catalog id", async () => {
  let requested = "";
  const show = {
    id: "source-animetv-api-animeav1-new",
    catalogAnimeId: "animeav1-new",
    description: "A brief preview…"
  };
  const c = vm.createContext({
    URLSearchParams,
    show,
    state: { activeShow: show },
    overlay: { hidden: false },
    fetchWithTimeout: async (url) => {
      requested = url;
      return { ok: true, json: async () => ({ description: "A complete synopsis with the ending." }) };
    },
    cleanDescription: (value) => value,
    renderWatchDescription: () => {}
  });
  vm.runInContext(section("async function hydrateFullShowDescription(", "const ANIME_METADATA_CACHE_TTL_MS"), c);
  await c.hydrateFullShowDescription(show);
  assert.match(requested, /id=animeav1-new/);
  assert.equal(show.description, "A complete synopsis with the ending.");
  assert.equal(show._fullDescriptionResolved, true);
});

test("home release and metadata warmups stay ahead of background work", () => {
  assert.match(client, /const CAROUSEL_PROVISIONAL_HOLD_MS = 1500;/);
  assert.match(client, /fetchWithTimeout\(HOMEPAGE_BOOTSTRAP_ENDPOINT, \{ cache: "no-cache" \}, 2500\)/);
  const load = section("async function loadAnimeSources(", "function scheduleLazyAddonCatalogLoad(");
  assert.match(load, /!preferBootstrap && installCachedCatalog\(\)/);
  assert.match(load, /!hasInitialCatalog && preferBootstrap\) hasInitialCatalog = installCachedCatalog\(\)/);
  const latest = section("function scheduleAnimeAv1LatestLoad(", "function applyServerCatalog(");
  assert.doesNotMatch(latest, /addEventListener\("load"/);
  const warm = section("function warmVisibleShowMetadata(", "function scheduleVisibleMetadataWarm(");
  assert.match(warm, /const warmLimit = Math\.min\(limit, state\.route === "home" \? 2 : 4\)/);
});
