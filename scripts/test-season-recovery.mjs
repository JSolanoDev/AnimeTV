import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const utils = require("../js/utils.js");
const SeasonNormalization = require("../js/season-normalization.js");
const metadataSource = readFileSync(new URL("../js/anilist-metadata.js", import.meta.url), "utf8");
const clientSource = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const imageSource = readFileSync(new URL("../js/image-resolver.js", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../animetv-server.js", import.meta.url), "utf8");
function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing source section ${start}`);
  return source.slice(from, to);
}

function context(fetchWithTimeout = async () => ({ ok: false })) {
  const store = new Map();
  const sandbox = vm.createContext({
    console: { log() {}, warn() {}, debug() {} },
    ...utils, SeasonNormalization, URL, Date, fetchWithTimeout,
    ANILIST_META_CACHE_PREFIX: "test:", ANILIST_META_CACHE_TTL: 86400000,
    ANILIST_SEARCH_CACHE_TTL: 60000, ANILIST_MEDIA_ENDPOINT: "/api/anilist/media",
    ANILIST_SEARCH_ENDPOINT: "/api/anilist/search",
    ANILIST_FRANCHISE_RELATIONS: new Set(["SEQUEL", "PREQUEL", "SIDE_STORY", "SPIN_OFF"]),
    localStorage: { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key), key: i => [...store.keys()][i], get length() { return store.size; } },
    state: { shows: [] },
    appRouter: () => null,
    ROUTE_SLUG_ALIASES: {},
    getShowKey: show => String(show.id),
    groupEpisodesBySeason: episodes => [{ season: 1, episodes }],
    repairEpisodeGaps: episodes => episodes,
    normalizeEpisodeSourceOptions: () => [],
    getEpisodeUrl: episode => episode.videoUrl || ""
  });
  vm.runInContext(metadataSource, sandbox);
  vm.runInContext(section(clientSource, "function getShowSlug(", "function ensureNotFoundSection("), sandbox);
  vm.runInContext(section(clientSource, "function ensureFranchiseShowsInCatalog(", "function validateEpisodeIntegrity("), sandbox);
  vm.runInContext(section(clientSource, "function mergeAiredEpisodeMetadata(", "// Strip a leading"), sandbox);
  vm.runInContext(section(clientSource, "function applyTmdbEpisodeMetadata(", "function applyAniListExtras("), sandbox);
  vm.runInContext(imageSource + "\nthis.resolver = ImageResolver;", sandbox);
  vm.runInContext(section(clientSource, "function episodeMetadataForNumber(", "function episodeCandidateImage("), sandbox);
  return sandbox;
}

test("deep links match the exact season rather than a newer title prefix", () => {
  const c = context();
  const base = { id: "base", title: "Link Click", romajiTitle: "Shiguang Dailiren" };
  const sequel = { id: "sequel", title: "Link Click Season 3", romajiTitle: "Shiguang Dailiren III" };
  c.state.shows = [sequel, base];
  assert.equal(c.findShowBySlugOrId("shiguang-dailiren"), base);
  c.state.shows = [sequel];
  assert.equal(c.findShowBySlugOrId("shiguang-dailiren"), null);
  c.state.addonSections = [{ items: [base] }];
  assert.equal(c.findShowBySlugOrId("shiguang-dailiren"), base);
});

test("related seasons missing from the main catalog retain their identity across reloads", () => {
  const c = context();
  const base = { id: "anilist-126403", anilistId: 126403, malId: 44074, title: "Link Click", romajiTitle: "Shiguang Dailiren", isFranchiseEntry: true, videoUrl: "expired.mp4", episodes: [{ episode: 1 }] };
  c.rememberFranchiseRoutes([base]);
  const restored = c.findShowBySlugOrId("shiguang-dailiren");
  assert.equal(restored.anilistId, 126403);
  assert.equal(restored.malId, 44074);
  assert.equal(restored.videoUrl, "");
  assert.equal(restored.episodes.length, 0);
  assert.equal(c.findShowBySlugOrId("shiguang-dailiren"), restored);
  assert.equal(c.state.shows.length, 1);
});

test("season clicks restore related entries removed by a background catalog refresh", () => {
  const c = context();
  const show = { id: "current", anilistId: 2, title: "Example Season 2", anilistFranchise: { groups: [
    { items: [{ anilistId: 1, malId: 11, title: "Example", episodes: 12, status: "FINISHED" }] },
    { items: [{ anilistId: 2, malId: 22, title: "Example Season 2", episodes: 12, status: "FINISHED" }] }
  ] } };
  c.state.shows = [show];
  c.state.activeShow = show;
  c.buildSeasonNav = () => [{ relatedShowId: c.state.shows.find(entry => entry.anilistId === 1)?.id }];
  vm.runInContext(section(clientSource, "const liveNav = () => {", "const navTo =") + "this.getLiveNav = liveNav;", c);
  const result = c.getLiveNav();
  assert.equal(result.list[0].relatedShowId, "anilist-1");
  assert.equal(c.state.shows.length, 2);
  c.getLiveNav();
  assert.equal(c.state.shows.length, 2);
});

function media(id, number, relations = []) {
  return { mal_id: id, title: `Example${number === 1 ? "" : ` ${number}th Season`}`, type: "TV", status: "Finished Airing", episodes: 12,
    year: 2010 + number, images: { jpg: { large_image_url: `https://example.test/${id}.jpg` } },
    relations: relations.map(([relation, mal_id]) => ({ relation, entry: [{ mal_id, type: "anime", name: "Related Example" }] })) };
}

test("provider outage recovers all linked seasons without duplicating the current title", async () => {
  const fixtures = new Map([
    [104, media(104, 4, [["Prequel", 103]])], [103, media(103, 3, [["Prequel", 102], ["Sequel", 104]])],
    [102, media(102, 2, [["Prequel", 101], ["Sequel", 103]])], [101, media(101, 1, [["Sequel", 102]])]
  ]);
  const calls = [];
  const c = context(async url => {
    calls.push(url);
    const id = Number(new URL(url, "https://example.test").searchParams.get("id"));
    return { ok: true, json: async () => url.startsWith("/api/anilist") ? { ok: false, error: "AniList HTTP 403" } : { ok: true, data: fixtures.get(id) } };
  });
  const show = { id: "source-current", anilistId: 4, malId: 104, title: "Example 4th Season", totalEpisodes: 12 };
  c.state.shows = [show, { id: "source-second", malId: 102, title: "Example 2th Season", totalEpisodes: 12 }];
  await c.hydrateShowAniListFranchise(show);
  assert.deepEqual(Array.from(show.anilistFranchise.groups, group => group.seasonNumber), [1, 2, 3, 4]);
  c.ensureFranchiseShowsInCatalog(show);
  assert.equal(c.state.shows.length, 4);
  const matches = new Map(c.state.shows.flatMap(entry => [[String(entry.anilistId), entry], [`mal-${entry.malId}`, entry]]));
  const list = c.buildSeasonListFromAniListFranchise(show, matches, c.getDetailSeasons, c.makePlaceholderEpisodes);
  assert.equal(list.filter(entry => entry.isCurrentShow).length, 1);
  assert.equal(list[1].relatedShowId, "source-second");
  assert.equal(list[0].relatedShowId, "jikan-101");
  assert.equal(c.state.shows.find(entry => entry.id === "jikan-101").anilistId, null);
  assert.equal(calls.filter(url => url.startsWith("/api/anilist")).length, 1);
});

test("a failed refresh preserves existing seasons", async () => {
  const c = context();
  const franchise = { groups: [{ seasonNumber: 1 }, { seasonNumber: 2 }] };
  const show = { anilistId: 1, malId: 10, title: "Example", anilistFranchise: franchise, anilistFranchiseLoaded: true, _franchiseVersion: 1 };
  await c.hydrateShowAniListFranchise(show);
  assert.equal(show.anilistFranchise, franchise);
});

test("season metadata requests cannot exhaust the playback API budget", () => {
  const c = vm.createContext({ Date, RATE_LIMIT_WINDOW_MS: 60000, RATE_LIMIT_API_MAX_REQUESTS: 120,
    RATE_LIMIT_MAX_REQUESTS: 240, rateLimitBuckets: new Map(), getClientIp: () => "fixture", pruneRateLimitBuckets() {} });
  vm.runInContext(section(serverSource, "function checkRateLimit(", "function pruneRateLimitBuckets("), c);
  for (let i = 0; i < 250; i++) assert.equal(c.checkRateLimit({}, new URL("https://example.test/api/tmdb/season")).allowed, true);
  assert.equal(c.checkRateLimit({}, new URL("https://example.test/api/animeav1/sources")).allowed, true);
  for (let i = 0; i < 110; i++) c.checkRateLimit({}, new URL("https://example.test/api/tmdb/season"));
  assert.equal(c.checkRateLimit({}, new URL("https://example.test/api/tmdb/season")).allowed, false);
});

test("Jikan fallback ignores adaptations, manga and unrelated spin-offs", () => {
  const c = context();
  const data = media(1, 1, [["Adaptation", 2], ["Spin-Off", 3], ["Sequel", 4]]);
  data.relations.push({ relation: "Prequel", entry: [{ type: "manga", mal_id: 5 }] });
  const converted = c.jikanFranchiseMedia(data);
  assert.deepEqual(Array.from(converted.relations.edges, edge => edge.node.idMal), [4]);
});

test("an outage on another title does not skip an exact server-cached anime ID", async () => {
  const c = context(async url => ({ ok: true, json: async () => url === "/api/anilist/media?id=2"
    ? { ok: true, media: { id: 2, idMal: 22, title: { romaji: "Cached Show" } } } : { ok: false } }));
  await c._fetchAniListMedia(1, 11);
  const media = await c._fetchAniListMedia(2, 22);
  assert.equal(media.id, 2);
});

test("numbered spin-offs cannot add episodes to a mainline season", () => {
  const franchise = SeasonNormalization.normalizeFranchise([
    { anilistId: 1, title: "Link Click", format: "ONA", seasonYear: 2021, mainline: true, episodes: 11 },
    { anilistId: 2, title: "Link Click Season 2", format: "ONA", seasonYear: 2023, mainline: true, episodes: 12 },
    { anilistId: 3, title: "Shiguang Dailiren: Xiao Juchang 2", format: "ONA", seasonYear: 2026, mainline: false, episodes: 6 }
  ]);
  const second = franchise.groups.find(group => group.type === "main" && group.seasonNumber === 2);
  assert.deepEqual(second.items.map(item => item.anilistId), [2]);
});

test("aired metadata expands a partial scrape without overwriting video URLs or adding future episodes", () => {
  const c = context();
  const show = { title: "Example", episode: 50, seasons: [{ season: 1, episodes: [{ episode: 50, videoUrl: "fixture.mp4" }] }] };
  const entries = Array.from({ length: 120 }, (_, i) => ({ episode: i + 1, aired: "2020-01-01" }));
  entries.push({ episode: 121, aired: "2999-01-01" });
  c.mergeAiredEpisodeMetadata(show, entries);
  assert.equal(show.episodes.length, 120);
  assert.equal(show.latestAiredEp, 120);
  assert.equal(show.episodes[49].videoUrl, "fixture.mp4");
  assert.equal(show.episodes[0].needsResolve, true);
});

test("continuous series stay in one season with absolute episode numbering", () => {
  const c = context();
  const episodes = Array.from({ length: 120 }, (_, i) => ({ episode: i + 1, videoUrl: `fixture-${i + 1}.mp4` }));
  const show = { title: "Continuous Example", episodes, tmdbSeasons: [
    { season_number: 1, name: "Arc One", episode_count: 60 },
    { season_number: 2, name: "Arc Two", episode_count: 60 }
  ] };
  const seasons = c.getDetailSeasons(show);
  assert.equal(seasons.length, 1);
  assert.equal(seasons[0].episodes[60].episode, 61);
  assert.equal(seasons[0].episodes[60].videoUrl, "fixture-61.mp4");
  assert.equal(seasons[0].episodes.at(-1).episode, 120);
});

test("TMDB aired episodes recover the full single-season list when Jikan is unavailable", () => {
  const c = context();
  const show = { title: "Continuous Example", seasons: [{ season: 1, episodes: [{ episode: 50, videoUrl: "source.mp4" }] }],
    tmdbSeasons: [{ season_number: 1, name: "First arc", episode_count: 60 }, { season_number: 2, name: "Second arc", episode_count: 61 }],
    tmdbEpisodesByNum: Object.fromEntries(Array.from({ length: 121 }, (_, i) => [i + 1, { episode: i + 1, aired: i === 120 ? "2999-01-01" : "2020-01-01", title: `Title ${i + 1}` }])) };
  c.applyTmdbEpisodeMetadata(show);
  const seasons = c.getDetailSeasons(show);
  assert.equal(seasons.length, 1);
  assert.equal(seasons[0].episodes.at(-1).episode, 120);
  assert.equal(seasons[0].episodes[49].videoUrl, "source.mp4");
});

test("partial relation refresh cannot shrink a previous season list", async () => {
  const c = context(async url => ({ ok: true, json: async () => url.startsWith("/api/anilist")
    ? { ok: false } : { data: url.includes("id=104") ? media(104, 4, [["Prequel", 103]]) : null } }));
  const previous = { groups: [1, 2, 3, 4].map(seasonNumber => ({ seasonNumber })) };
  const show = { title: "Example 4th Season", anilistId: 4, malId: 104, anilistFranchise: previous };
  await c.hydrateShowAniListFranchise(show);
  assert.equal(show.anilistFranchise, previous);
  assert.equal(show.anilistFranchiseLoaded, false);
  assert.ok(show._franchiseNextTry > Date.now());
});

test("live-action candidates are never accepted as animation", () => {
  const c = context();
  assert.equal(c.resolver.scoreCandidate({ title: "Link Click", year: 2026 }, { name: "Link Click", first_air_date: "2026-01-01", genre_ids: [18] }).confidence, 0);
});

test("TMDB absolute numbering is not offset twice across arcs", async () => {
  const c = context(async url => {
    const parsed = new URL(url, "https://example.test");
    const n = Number(parsed.searchParams.get("season") || 1);
    const seasons = [1, 2, 3].map(season_number => ({ season_number, name: `Arc ${season_number}`, episode_count: 40 }));
    const body = url.includes("/search") ? { results: [{ id: 99, name: "Continuous Example", genre_ids: [16], first_air_date: "2000-01-01" }] }
      : url.includes("/tv?") ? { show: { number_of_episodes: 120, seasons } }
      : { season: { episodes: Array.from({ length: 40 }, (_, i) => ({ episode_number: (n - 1) * 40 + i + 1, name: `Title ${(n - 1) * 40 + i + 1}`, air_date: "2000-01-01", still_path: `/still-${n}-${i}.jpg` })) } };
    return { ok: true, json: async () => body };
  });
  const show = { id: "continuous", title: "Continuous Example", year: 2000, format: "TV" };
  await c.resolver.hydrateTmdbImages(show);
  assert.equal(Object.keys(show.tmdbEpisodesByNum).length, 120);
  assert.equal(show.tmdbEpisodesByNum[41].title, "Title 41");
  assert.equal(show.tmdbEpisodesByNum[120].title, "Title 120");
  assert.equal(show.tmdbEpisodesByNum[160], undefined);
});

test("named season mapping does not reuse the base season or confuse arc numbering", () => {
  const c = context();
  const result = c.resolver.pickTmdbSeason({ title: "Link Click Season 3", romajiTitle: "Shiguang Dailiren III", year: 2026 }, { seasons: [
    { season_number: 1, name: "Link Click", episode_count: 11 },
    { season_number: 2, name: "Link Click 2", episode_count: 12 },
    { season_number: 3, name: "Bridon Arc", episode_count: 6 },
    { season_number: 4, name: "Link Click 3", episode_count: 12 }
  ] });
  assert.equal(result.season.season_number, 4);
});

test("season-scoped titles and dates outrank stale streaming labels", () => {
  const c = context();
  const show = { tmdbEpisodesBySeasonNum: { 1: { 1: { title: "Emma", aired: "2021-04-30", thumbnail: "first.jpg" } } },
    streamingEpisodesByNum: { 1: { title: "So Time Begins to Flow Again", aired: "2023-07-14" } } };
  const result = c.episodeMetadataForNumber(show, 1, 1);
  assert.equal(result.title, "Emma");
  assert.equal(result.aired, "2021-04-30");
});

test("a corrected artwork identity replaces a wrongly pinned backdrop", async () => {
  const c = context(async () => ({ ok: true, json: async () => ({ show: { id: 123542, backdrop_path: "/right.jpg", seasons: [] } }) }));
  const show = { id: "example", title: "Link Click", tmdbId: 1, tmdbBackdrop: "https://example.test/wrong.jpg", _artworkPinned: true, _paintedCarouselArtwork: "wrong" };
  await c.resolver.hydrateTmdbImages(show);
  assert.equal(show.tmdbBackdrop, "https://image.tmdb.org/t/p/original/right.jpg");
  assert.equal(show._paintedCarouselArtwork, undefined);
});
