import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { buildHomepageBootstrap } from "./build-homepage-bootstrap.mjs";

const client = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const normalizer = readFileSync(new URL("../js/normalize.js", import.meta.url), "utf8");
const section = (start, end) => {
  const from = client.indexOf(start);
  const to = client.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from);
  return client.slice(from, to);
};

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
  assert.equal(payload.items[0].studios[0], "Studio");
  assert.ok(payload.items[0].description.length <= 321);
  assert.equal(payload.items[1].episodes, undefined);
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
  assert.match(client, /fetchWithTimeout\(HOMEPAGE_BOOTSTRAP_ENDPOINT, \{ cache: "default" \}, 2500\)/);
  const load = section("async function loadAnimeSources(", "function scheduleLazyAddonCatalogLoad(");
  assert.match(load, /!preferBootstrap && installCachedCatalog\(\)/);
  assert.match(load, /!hasInitialCatalog && preferBootstrap\) hasInitialCatalog = installCachedCatalog\(\)/);
  const latest = section("function scheduleAnimeAv1LatestLoad(", "function applyServerCatalog(");
  assert.doesNotMatch(latest, /addEventListener\("load"/);
  const warm = section("function warmVisibleShowMetadata(", "function scheduleVisibleMetadataWarm(");
  assert.match(warm, /const warmLimit = Math\.min\(limit, state\.route === "home" \? 2 : 4\)/);
});
