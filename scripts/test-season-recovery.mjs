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
const utilsSource = readFileSync(new URL("../js/utils.js", import.meta.url), "utf8");
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
    location: { origin: "https://app.test", href: "https://app.test/" },
    ANILIST_META_CACHE_PREFIX: "test:", ANILIST_META_CACHE_TTL: 86400000,
    ANILIST_SEARCH_CACHE_TTL: 60000, ANILIST_MEDIA_ENDPOINT: "/api/anilist/media",
    ANILIST_SEARCH_ENDPOINT: "/api/anilist/search",
    ANILIST_FRANCHISE_RELATIONS: new Set(["SEQUEL", "PREQUEL", "SIDE_STORY", "SPIN_OFF"]),
    localStorage: { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key), key: i => [...store.keys()][i], get length() { return store.size; } },
    state: { shows: [] },
    appRouter: () => null,
    ROUTE_SLUG_ALIASES: {},
    getShowKey: show => String(show.id),
    isSyntheticFranchiseRow: row => /^(anilist|jikan)-\d+$/.test(String(row?.id || "")),
    bakedChainFor: () => null,
    parseEpisodeNumber: (value, fallback = null) => {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
      const match = String(value ?? "").match(/\d+(?:\.\d+)?/);
      return match ? Number(match[0]) : fallback;
    },
    getCanonicalEpisodeNumber: (episode = {}, fallback = null) => {
      for (const value of [episode.canonicalEpisode, episode.episode, episode.number, episode.episodeNumber]) {
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
        if (/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(String(value ?? ""))) return Number(value);
      }
      return fallback;
    },
    groupEpisodesBySeason: episodes => [{ season: 1, episodes }],
    repairEpisodeGaps: episodes => episodes,
    // getDetailSeasons asks how many episodes a season is known to have so the
    // list can be repaired up to that count. These tests stub repairEpisodeGaps
    // to a pass-through, so no floor is wanted here.
    seasonAiredFloor: () => 0,
    normalizeEpisodeSourceOptions: () => [],
    getEpisodeUrl: episode => episode.videoUrl || ""
  });
  sandbox.catalogShows = () => sandbox.state.shows;
  vm.runInContext(section(utilsSource, "const metadataJsonCache =", "async function fetchWithRetry("), sandbox);
  vm.runInContext(metadataSource, sandbox);
  vm.runInContext(section(clientSource, "function getShowSlug(", "function ensureNotFoundSection("), sandbox);
  vm.runInContext(section(clientSource, "const bakedChainCache =", "function getFranchiseSeasonList("), sandbox);
  vm.runInContext(section(clientSource, "const materializedFranchiseCache =", "function validateEpisodeIntegrity("), sandbox);
  vm.runInContext(section(clientSource, "function mergeAiredEpisodeMetadata(", "// Strip a leading"), sandbox);
  vm.runInContext(section(clientSource, "function usesContinuousGlobalEpisodeMetadata(", "function applyAniListExtras("), sandbox);
  vm.runInContext(imageSource + "\nthis.resolver = ImageResolver;", sandbox);
  vm.runInContext(section(clientSource, "function episodeMetadataForNumber(", "function episodeCandidateImage("), sandbox);
  return sandbox;
}

const stoneOceanSeasons = [
  { season_number: 1, episode_count: 26, name: "Earlier Arc", air_date: "2012-10-06" },
  { season_number: 5, episode_count: 38, name: "STONE OCEAN", air_date: "2022-01-08" },
  { season_number: 6, episode_count: 12, name: "STEEL BALL RUN", air_date: "2026-03-19" }
];
const stoneOceanEpisodes = Array.from({ length: 38 }, (_, i) => ({
  episode_number: i + 1, name: `Correct Arc ${i + 1}`, overview: "Neutral fixture",
  air_date: i < 24 ? "2022-01-08" : "2023-01-07", still_path: `/correct-arc-${i + 1}.jpg`
}));

function jojoChain() {
  return [
    [14719, "JoJo no Kimyou na Bouken (TV)", "TV", 2012, 26],
    [20474, "JoJo no Kimyou na Bouken: Stardust Crusaders", "TV", 2014, 24],
    [20799, "JoJo no Kimyou na Bouken: Stardust Crusaders - Egypt-hen", "TV", 2015, 24],
    [21450, "JoJo no Kimyou na Bouken: Diamond wa Kudakenai", "TV", 2016, 39],
    [102883, "JoJo no Kimyou na Bouken: Ougon no Kaze", "TV", 2018, 39],
    [131942, "JoJo no Kimyou na Bouken: Stone Ocean", "ONA", 2021, 12],
    [146722, "JoJo no Kimyou na Bouken: Stone Ocean Part 2", "ONA", 2022, 26],
    [190327, "JoJo no Kimyou na Bouken: Steel Ball Run - 1st STAGE", "ONA", 2026, 1],
    [210482, "JoJo no Kimyou na Bouken: Steel Ball Run - 2nd & 3rd STAGE", "ONA", 2026, 11]
  ].map(([anilistId, title, format, seasonYear, episodes]) => ({ anilistId, title, format, seasonYear, episodes,
    ...([190327, 210482].includes(anilistId) ? { malId: 61469 } : {}), status: "FINISHED" }));
}

test("JoJo uses official TV season labels while preserving existing internal route seasons", () => {
  const { groups } = SeasonNormalization.normalizeFranchise(jojoChain());
  assert.deepEqual(groups.map(g => g.seasonNumber), [1, 2, 3, 4, 5, 6, 6, 6, 7, 7]);
  assert.deepEqual(groups.map(g => g.title.match(/^Season (\d+)/)[1]), ["1", "2", "2", "3", "4", "5", "5", "5", "6", "6"]);
  assert.deepEqual(groups.map(g => g.episodeCount), [26, 24, 24, 39, 39, 12, 12, 14, 1, 11]);
  assert.ok(groups.every(g => g.type === "main"), "ONA mainline arcs are not filed under OVAs");
  assert.ok(groups[7].title.endsWith("Part 3"));
  const input = jojoChain();
  const snapshot = JSON.stringify(input);
  SeasonNormalization.normalizeFranchise(input);
  assert.equal(JSON.stringify(input), snapshot, "normalization does not mutate the baked inventory");
});

test("separate MAL Stone Ocean batches remain 12+12+14 without overlapping a combined AniList entry", () => {
  const chain = jojoChain();
  chain.push({ anilistId: "mal-53273", malId: 53273, title: "JoJo no Kimyou na Bouken Part 6: Stone Ocean Part 3", format: "ONA", seasonYear: 2022, episodes: 14 });
  const stone = SeasonNormalization.normalizeFranchise(chain).groups.filter(g => g.seasonNumber === 6);
  assert.deepEqual(stone.map(g => g.episodeCount), [12, 12, 14]);
  assert.deepEqual(stone.map(g => g.partNumber), [1, 2, 3]);
});

function jojoCatalog(c) {
  const chain = jojoChain();
  c.state.shows = chain.map(entry => ({ ...entry, id: `anilist-${entry.anilistId}`,
    totalEpisodes: entry.episodes, episodes: [], franchiseSeasons: chain }));
  for (const [id, count] of [[131942, 38], [190327, 3]]) {
    Object.assign(c.state.shows.find(show => show.anilistId === id), {
      id: `animeav1-neutral-${id}`, animeAv1Slug: `neutral-${id}`, sourceInventoryChecked: true,
      sourceEpisodeCount: count, sourceEpisodeIds: Array.from({ length: count }, (_, i) => i + 1)
    });
  }
  return c.state.shows;
}

test("JoJo library cards stay in the named batch while explicit releases retain absolute episode routing", () => {
  const c = context();
  const shows = jojoCatalog(c);
  c.extractSeasonNumber = () => 1;
  vm.runInContext(section(clientSource, "function cardEpisodeNumber(", "function cardMeta("), c);
  for (const [index, expected] of [[5, 12], [6, 12], [7, 1]]) {
    const target = c.getCardTarget(shows[index]);
    assert.equal(target.episodeNumber, expected);
    assert.equal(c.resolveJojoOpenTarget(shows[index], target), null);
  }
  assert.equal(c.getCardTarget({ title: "Neutral series", sourceEpisodeCount: 100 }).episodeNumber, 100);
  const release = { ...shows[5], _av1Episode: 38 };
  const target = c.getCardTarget(release);
  assert.equal(target.episodeNumber, 38);
  assert.equal(c.resolveJojoOpenTarget(release, target).target.seasonPart, 3);
});

test("every JoJo selector entry keeps its exact episode range and original provider IDs", () => {
  const c = context();
  const shows = jojoCatalog(c);
  const map = new Map(shows.map(show => [String(show.anilistId), show]));
  for (const show of shows) {
    c.ensureFranchiseShowsInCatalog(show);
    const seasons = c.buildSeasonListFromBakedChain(show, map);
    assert.deepEqual(Array.from(seasons, s => s.episodes.length), [26, 24, 24, 39, 39, 12, 12, 14, 1, 2]);
    const stone = seasons.filter(s => s.season === 6);
    const providerIds = stone.flatMap(s => Array.from(s.episodes, ep => ep.providerEpisodeId));
    assert.deepEqual(Array.from(providerIds), Array.from({ length: 38 }, (_, i) => i + 1));
    assert.equal(stone[1].episodes[0].canonicalEpisode, 1);
    assert.equal(stone[1].episodes[0].providerAnimeSlug, "neutral-131942");
    assert.deepEqual(Array.from(seasons.filter(s => s.season === 7).flatMap(s => Array.from(s.episodes, ep => ep.providerEpisodeId))), [1, 2, 3]);
  }
  assert.equal(shows.find(s => s.anilistId === 131942).sourceEpisodeIds.length, 38);
});

test("Steel Ball Run release cards use absolute numbering while Stone Ocean keeps its batch", () => {
  const c = context();
  const shows = jojoCatalog(c);
  c.extractSeasonNumber = () => 1;
  vm.runInContext(section(clientSource, "function jojoLatestReleaseCard(", "function buildAnimeAv1ReleaseCards("), c);
  vm.runInContext(section(clientSource, "function cardEpisodeNumber(", "function cardMeta("), c);
  const first = shows[7];
  const before = JSON.stringify(first);
  const card = c.jojoLatestReleaseCard({ ...first, episode: 4, _av1Episode: 4,
    _av1ProviderEpisode: 4, _av1Slug: "neutral-190327", lastEpisodeAt: "2026-10-09T12:30:00Z" });
  assert.equal(card.anilistId, 190327);
  assert.match(card.title, /Steel Ball Run$/);
  assert.equal(card._av1Episode, 4);
  assert.equal(card._av1ProviderEpisode, 4);
  assert.equal(c.cardEpisodeNumber(card), 4);
  assert.equal(c.getCardTarget(card).seasonNumber, 7);
  assert.equal(c.getCardTarget(card).episodeNumber, 4);
  assert.equal(c.resolveJojoOpenTarget(card, c.getCardTarget(card)).target.episodeNumber, 4);
  assert.equal(c.jojoLatestReleaseCard(card)._av1Episode, 4, "repeated rendering is idempotent");
  assert.equal(first.title, JSON.parse(before).title);
  assert.deepEqual(first.sourceEpisodeIds, JSON.parse(before).sourceEpisodeIds);
  assert.equal(c.getCardTarget(first).episodeNumber, 1);
  const next = c.jojoLatestReleaseCard({ ...card, episode: 5, _av1Episode: 5, _av1ProviderEpisode: 5 });
  assert.equal(next._av1Episode, 5);
  assert.equal(next._av1ProviderEpisode, 5);
  const cached = c.jojoLatestReleaseCard({ ...first, episode: 4 });
  assert.equal(cached.anilistId, 190327);
  assert.equal(cached._av1Episode, 4);
  assert.equal(cached._av1ProviderEpisode, 4);
  const stone = c.jojoLatestReleaseCard({ ...shows[5], episode: 25, _av1ProviderEpisode: 25 });
  assert.equal(SeasonNormalization.jojoEntryScope(stone).partNumber, 3);
  assert.equal(stone._av1Episode, 1);
  assert.equal(stone._av1ProviderEpisode, 25);
});

test("live JoJo relation lists apply the same inventory boundaries as baked lists", () => {
  const c = context();
  const shows = jojoCatalog(c);
  const map = new Map(shows.map(show => [String(show.anilistId), show]));
  for (const show of shows.filter(s => [131942, 146722, 190327, 210482].includes(s.anilistId))) {
    c.ensureFranchiseShowsInCatalog(show);
    show.anilistFranchise = SeasonNormalization.normalizeFranchise(jojoChain());
    const list = c.buildSeasonListFromAniListFranchise(show, map, c.getDetailSeasons, c.makePlaceholderEpisodes);
    assert.deepEqual(Array.from(list.filter(s => s.season === 6), s => s.episodes.length), [12, 12, 14]);
    assert.deepEqual(Array.from(list.filter(s => s.season === 7), s => s.episodes.length), [1, 2]);
  }
});

test("stale live JoJo airing metadata cannot hide measured episodes in a borrowed provider inventory", () => {
  const c = context();
  const shows = jojoCatalog(c);
  const map = new Map(shows.map(show => [String(show.anilistId), show]));
  const chain = jojoChain();
  Object.assign(chain.at(-1), { status: "RELEASING", latestAiredEp: 1 });
  for (const show of [shows[7], shows[8]]) {
    show.anilistFranchise = SeasonNormalization.normalizeFranchise(chain);
    const list = c.buildSeasonListFromAniListFranchise(show, map, c.getDetailSeasons, c.makePlaceholderEpisodes);
    const stages = list.filter(season => season.season === 7);
    assert.deepEqual(Array.from(stages, season => season.episodes.length), [1, 2]);
    assert.deepEqual(Array.from(stages[1].episodes, episode => episode.providerEpisodeId), [2, 3]);
  }
});

test("Steel Ball Run stages sharing a MAL ID retain separate identities and episode ranges", () => {
  const c = context();
  const shows = jojoCatalog(c);
  c.state.shows = shows.filter(show => show.anilistId !== 210482);
  const first = shows[7];
  c.ensureFranchiseShowsInCatalog(first);
  const second = c.state.shows.find(show => show.anilistId === 210482);
  assert.ok(second);
  assert.notEqual(second.id, first.id);
  assert.equal(first.canonicalSeasonPart, 1);
  assert.equal(second.canonicalSeasonPart, 2);
  assert.equal(c.franchiseEntryMatches(first, second), false);
  const map = new Map(c.state.shows.map(show => [String(show.anilistId), show]));
  for (const show of [first, second]) {
    const seasons = c.buildSeasonListFromBakedChain(show, map).filter(season => season.season === 7);
    assert.deepEqual(Array.from(seasons, season => season.episodes.length), [1, 2]);
    assert.deepEqual(Array.from(seasons[1].episodes, episode => episode.providerEpisodeId), [2, 3]);
  }
});

test("JoJo detail panels render the same scoped counts as their selectors without losing provider inventory", () => {
  const c = context();
  const shows = jojoCatalog(c);
  c.ensureFranchiseShowsInCatalog(shows[5]);
  const parts = c.state.shows.filter(show => SeasonNormalization.jojoEntryScope(show)?.seasonNumber === 6);
  assert.deepEqual(Array.from(parts, show => c.getDetailSeasons(show)[0].episodes.length), [12, 12, 14]);
  assert.deepEqual(Array.from(parts).flatMap(show => Array.from(c.getDetailSeasons(show)[0].episodes, ep => ep.providerEpisodeId)), Array.from({ length: 38 }, (_, i) => i + 1));
  assert.equal(c.getDetailSeasons(parts[1])[0].episodes[0].canonicalEpisode, 1);
  assert.equal(c.getDetailSeasons(parts[2])[0].episodes[0].providerAnimeSlug, "neutral-131942");
  assert.equal(shows[5].sourceEpisodeIds.length, 38);
  assert.equal(c.getDetailSeasons(shows[7])[0].episodes.length, 3);
  assert.equal(c.getDetailSeasons(shows[8])[0].episodes.length, 3);
});

test("legacy combined Stone Ocean watch links resolve to the correct batch and provider episode", () => {
  const c = context();
  const shows = jojoCatalog(c);
  for (const [show, episode, part, canonical, absolute] of [
    [shows[5], 13, 2, 1, 13], [shows[5], 38, 3, 14, 38],
    [shows[6], 13, 3, 1, 25], [shows[6], 26, 3, 14, 38]
  ]) {
    const resolved = c.resolveJojoOpenTarget(show, { seasonNumber: 6, episodeNumber: episode, playIntent: true });
    assert.equal(resolved.target.seasonPart, part);
    assert.equal(resolved.target.episodeNumber, canonical);
    const row = c.getDetailSeasons(resolved.show)[0].episodes[canonical - 1];
    assert.equal(row.providerEpisodeId, absolute);
  }
  assert.equal(c.resolveJojoOpenTarget(shows[5], { episodeNumber: 39 }), null);
  assert.equal(c.resolveJojoOpenTarget(shows[6], { episodeNumber: 1 }), null);
});

test("legacy Steel Ball Run episode links and adjacent controls preserve the measured provider sequence", () => {
  const c = context();
  const shows = jojoCatalog(c);
  c.ensureFranchiseShowsInCatalog(shows[7]);
  for (const episode of [2, 3]) {
    const resolved = c.resolveJojoOpenTarget(shows[8], { seasonNumber: 7, seasonPart: 2, episodeNumber: episode - 1 });
    assert.equal(resolved.show, shows[7]);
    assert.equal(resolved.target.seasonPart, "");
    assert.equal(resolved.target.seasonNumber, 7);
    assert.equal(resolved.target.episodeNumber, episode);
    assert.equal(c.getDetailSeasons(resolved.show)[0].episodes[episode - 1].providerEpisodeId, episode);
    assert.equal(c.resolveJojoOpenTarget(shows[7], { seasonNumber: 7, episodeNumber: episode }), null);
  }
  vm.runInContext(section(clientSource, "function getEpisodeNavigationTargets(", "function renderPlayerEpisodeActions("), c);
  for (const show of [shows[7], shows[8]]) {
    const season = c.getDetailSeasons(show)[0];
    c.state.activeShow = show;
    c.state.activeEpisode = { season, episode: season.episodes[0], seasonIndex: 0, episodeIndex: 0 };
    const nav = c.getEpisodeNavigationTargets();
    assert.equal(nav.previous, null);
    assert.equal(nav.next.episodeIndex, 1);
    c.state.activeEpisode = { season, episode: season.episodes.at(-1), seasonIndex: 0, episodeIndex: season.episodes.length - 1 };
    assert.equal(c.getEpisodeNavigationTargets().next, null, "no wrap back to another batch at the last release");
  }
});

test("borrowed JoJo provider lists retain the target batch identity for real detail metadata hydration", async () => {
  const c = context(async () => ({ ok: true, json: async () => ({ season: { episodes: stoneOceanEpisodes } }) }));
  const shows = jojoCatalog(c);
  c.ensureFranchiseShowsInCatalog(shows[5]);
  for (const show of c.state.shows.filter(row => SeasonNormalization.jojoEntryScope(row)?.seasonNumber === 6)) {
    show.tmdbId = 45790;
    show.tmdbSeasons = stoneOceanSeasons;
    const season = c.getDetailSeasons(show)[0];
    assert.equal(season.anilistId, show.anilistId);
    assert.equal(season.malId, show.malId);
    await c.resolver.ensureSeasonStills(show, 6, season);
    const scope = SeasonNormalization.jojoEntryScope(show);
    assert.equal(c.resolver.getSeasonEpisodeMeta(show, 6, 1).title, `Correct Arc ${scope.offset + 1}`);
    assert.equal(Object.keys(show.tmdbEpisodesBySeasonNum[6]).length, scope.count);
  }
});

test("JoJo relation enrichment preserves the verified TMDB identity while episode metadata is in flight", async () => {
  let show;
  let requests = 0;
  const c = context(async () => {
    requests++;
    c.ensureFranchiseShowsInCatalog(show);
    assert.equal(show.tmdbId, 45790);
    return { ok: true, json: async () => ({ season: { episodes: stoneOceanEpisodes } }) };
  });
  show = jojoCatalog(c)[6];
  show.anilistFranchise = SeasonNormalization.normalizeFranchise(jojoChain());
  show.tmdbId = 45790;
  show.tmdbSeasons = stoneOceanSeasons;
  await c.resolver.ensureSeasonStills(show, 6, c.getDetailSeasons(show)[0]);
  assert.equal(requests, 1);
  assert.equal(c.resolver.getSeasonEpisodeMeta(show, 6, 1)?.title, "Correct Arc 13");
  assert.equal(Object.keys(show.tmdbEpisodesBySeasonNum[6]).length, 12);
});

test("splitting Stone Ocean preserves saved positions without overwriting newer canonical progress", () => {
  const c = context();
  const shows = jojoCatalog(c);
  const map = { [`${shows[5].id}:s6:e13`]: { lastPosition: 123, progress: 10 } };
  c.buildWatchKey = (show, season, episode) => `${show.id}:s${season}:e${episode}`;
  c.getAnimeTrackId = show => show.id;
  c.getWatchMap = () => map;
  let writes = 0;
  c.persistWatchMap = () => writes++;
  const resolved = c.resolveJojoOpenTarget(shows[5], { seasonNumber: 6, episodeNumber: 13 });
  const key = `${resolved.show.id}:s6:e1`;
  assert.equal(map[key].lastPosition, 123);
  map[key].lastPosition = 456;
  c.resolveJojoOpenTarget(shows[5], { seasonNumber: 6, episodeNumber: 13 });
  assert.equal(map[key].lastPosition, 456);
  assert.equal(writes, 1);
});

test("next and previous continue across Stone Ocean batch boundaries", () => {
  const c = context();
  const shows = jojoCatalog(c);
  c.ensureFranchiseShowsInCatalog(shows[5]);
  vm.runInContext(section(clientSource, "function getEpisodeNavigationTargets(", "function renderPlayerEpisodeActions("), c);
  for (const show of c.state.shows.filter(row => SeasonNormalization.jojoEntryScope(row)?.seasonNumber === 6)) {
    const season = c.getDetailSeasons(show)[0];
    c.state.activeShow = show;
    c.state.activeEpisode = { season, episode: season.episodes.at(-1), seasonIndex: 0, episodeIndex: season.episodes.length - 1 };
    const next = c.getEpisodeNavigationTargets().next;
    assert.equal(next?.seasonPart || null, season.part < 3 ? season.part + 1 : null);
    c.state.activeEpisode = { season, episode: season.episodes[0], seasonIndex: 0, episodeIndex: 0 };
    const previous = c.getEpisodeNavigationTargets().previous;
    assert.equal(previous?.seasonPart || null, season.part > 1 ? season.part - 1 : null);
  }
});

test("JoJo direct-route warmup fetches the absolute provider ID once instead of warming another batch", async () => {
  const c = context();
  const shows = jojoCatalog(c);
  c.ensureFranchiseShowsInCatalog(shows[5]);
  const warmed = [];
  c.prefetchPlayerShell = () => {};
  c.isScraperEnabled = provider => provider === "animeav1";
  c.shouldPreferUpnShareLookup = () => true;
  c.warmAnimeAv1PlaybackIntent = (show, target) => { warmed.push(target); return Promise.resolve(null); };
  vm.runInContext(section(clientSource, "function warmPrimaryPlaybackIntent(", "async function attachAnimeAv1Sources("), c);
  await c.warmPrimaryPlaybackIntent(shows[6], { episodeNumber: 1 });
  assert.equal(warmed.length, 1);
  assert.equal(warmed[0].providerEpisodeId, 13);
  assert.equal(warmed[0].providerAnimeSlug, "neutral-131942");
});

test("all JoJo arcs select the correct TMDB season, including both Stardust cours", async () => {
  const tmdbSeasons = Array.from({ length: 6 }, (_, i) => ({ season_number: i + 1, episode_count: [26, 48, 39, 39, 38, 12][i], name: `Arc ${i + 1}` }));
  const c = context(async () => ({ ok: true, json: async () => ({ season: { episodes: Array.from({ length: 48 }, (_, i) => ({ episode_number: i + 1, name: `Neutral ${i + 1}`, still_path: `/neutral-${i + 1}.jpg` })) } }) }));
  for (const entry of jojoChain()) {
    const scope = SeasonNormalization.jojoEntryScope(entry);
    const anime = { ...entry, id: `anilist-${entry.anilistId}`, tmdbId: 45790, tmdbSeasons };
    assert.equal(c.resolver.pickTmdbSeason(anime, { seasons: tmdbSeasons }).season.season_number, scope.tmdbSeasonNumber);
    await c.resolver.ensureSeasonStills(anime, scope.seasonNumber, { ...entry, part: scope.partNumber, episodeCount: scope.count });
    assert.equal(c.resolver.getSeasonEpisodeMeta(anime, scope.seasonNumber, 1).title, `Neutral ${scope.seasonNumber === 7 ? 1 : scope.offset + 1}`);
    assert.equal(Object.keys(anime.tmdbEpisodesBySeasonNum[scope.seasonNumber]).length, scope.seasonNumber === 7 ? 12 : scope.count);
  }
});

test("MAL-only Stone Ocean Part 3 maps episode 25, never the latest JoJo arc", async () => {
  const c = context(async () => ({ ok: true, json: async () => ({ season: { episodes: stoneOceanEpisodes } }) }));
  const anime = { id: "jikan-53273", malId: 53273, title: "Neutral catalog label", tmdbId: 45790, tmdbSeasons: stoneOceanSeasons };
  await c.resolver.ensureSeasonStills(anime, 6, { malId: 53273, part: 3, episodeCount: 14 });
  assert.equal(c.resolver.getSeasonEpisodeMeta(anime, 6, 1).title, "Correct Arc 25");
  assert.equal(Object.keys(anime.tmdbEpisodesBySeasonNum[6]).length, 14);
});
function stoneOceanFixture(anilistId = 131942) {
  return { id: `anilist-${anilistId}`, anilistId, tmdbId: 45790,
    title: anilistId === 131942 ? "JoJo no Kimyou na Bouken: Stone Ocean" : "JoJo no Kimyou na Bouken: Stone Ocean Part 2",
    seasonNumber: 6, canonicalSeasonNumber: 6, isFranchiseEntry: true, year: anilistId === 131942 ? 2021 : 2022,
    totalEpisodes: 12, tmdbSeasons: stoneOceanSeasons };
}

test("Stone Ocean selects its named arc rather than manga Part 6 or the latest JoJo season", () => {
  const c = context();
  for (const anime of [stoneOceanFixture(), stoneOceanFixture(146722),
    { malId: 48661, title: "Neutral catalog label", seasonNumber: 6 },
    { title: "JoJo's Bizarre Adventure: Stone Ocean Part 3", seasonNumber: 6 }]) {
    assert.equal(c.resolver.pickTmdbSeason(anime, { seasons: stoneOceanSeasons }).season.season_number, 5);
  }
  assert.equal(c.resolver.pickTmdbSeason(stoneOceanFixture(), { seasons: [stoneOceanSeasons[2]] }).season, null);
  assert.equal(c.resolver.pickTmdbSeason({ title: "STEEL BALL RUN", seasonNumber: 6 }, { seasons: stoneOceanSeasons }).season.season_number, 6);
});

test("Stone Ocean hydration repairs old snapshots, scopes both entries, and reuses the corrected cache", async () => {
  for (const [anilistId, offset, count] of [[131942, 0, 12], [146722, 12, 12]]) {
    const requests = [];
    const c = context(async url => {
      requests.push(url);
      return { ok: true, json: async () => url.includes("/api/tmdb/tv?")
        ? { show: { seasons: stoneOceanSeasons, number_of_episodes: 200, poster_path: "/parent.jpg" } }
        : { season: { episodes: stoneOceanEpisodes } } };
    });
    const anime = { ...stoneOceanFixture(anilistId), _tmdbResolved: true,
      sourceEpisodeIds: [1, count], sourceEpisodeCount: count,
      tmdbEpisodesByNum: { 1: { title: "Leaked Latest Arc" } },
      tmdbEpisodeStills: { 1: "https://fixture.test/leaked.jpg" },
      tmdbEpisodesBySeasonNum: { 6: { 1: { title: "Leaked Latest Arc" } } },
      tmdbStillsBySeason: { 6: { 1: "https://fixture.test/leaked.jpg" } } };
    c.localStorage.setItem(`zenkaitv:tmdb-match:v18:${anilistId}`, JSON.stringify({ savedAt: Date.now(), data: {
      tmdbId: 45790, confidence: 100, episodeStills: { 1: "https://fixture.test/leaked.jpg" },
      episodesByNum: { 1: { title: "Leaked Latest Arc" }, [count]: { title: "Leaked Final" } }, seasons: stoneOceanSeasons
    } }));
    assert.equal(c.resolver.getSeasonEpisodeMeta(anime, 6, 1), null, "old in-memory metadata must not paint before repair");
    assert.equal(c.resolver.getEpisodeStill(anime, { episode: 1 }, 6), "");
    await c.resolver.hydrateTmdbImages(anime);
    assert.equal(anime.tmdbEpisodesByNum[1].title, `Correct Arc ${offset + 1}`);
    assert.equal(anime.tmdbEpisodesByNum[count].title, `Correct Arc ${offset + count}`);
    assert.equal(Object.keys(anime.tmdbEpisodesByNum).length, count);
    assert.ok(Object.values(anime.tmdbEpisodeStills).every(url => url.includes("correct-arc-")));
    assert.deepEqual(requests.map(url => new URL(url, "https://fixture.test").pathname), ["/api/tmdb/tv", "/api/tmdb/season"]);
    assert.ok(requests[1].endsWith("season=5"));
    assert.deepEqual(anime.sourceEpisodeIds, [1, count], "playback inventory is untouched");
    const restored = stoneOceanFixture(anilistId);
    await c.resolver.hydrateTmdbImages(restored);
    assert.equal(requests.length, 2, "validated match cache avoids repeat functions");
    assert.equal(restored.tmdbEpisodesByNum[1].title, `Correct Arc ${offset + 1}`);
  }
});

test("Stone Ocean parts reject same-season wrong-range caches and deduplicate season lookups", async () => {
  const requests = [];
  const c = context(async url => {
    requests.push(url);
    return { ok: true, json: async () => ({ season: { episodes: stoneOceanEpisodes, poster_path: "/arc-poster.jpg" } }) };
  });
  for (const [anilistId, offset, count] of [[131942, 0, 12], [146722, 12, 12]]) {
    const anime = stoneOceanFixture(anilistId);
    c.localStorage.setItem(`zenkaitv:tmdb-season-art:v8:${anilistId}:s6`, JSON.stringify({ savedAt: Date.now(), data: {
      tmdbId: "45790", anilistId: String(anilistId), tmdbSeasonNumber: 5, requestedEpisodeCount: count,
      metas: { 1: { title: "Wrong Cour" } }, stills: { 1: "https://fixture.test/wrong-cour.jpg" }
    } }));
    const season = { season: 6, anilistId, year: anime.year, episodeCount: count, providerEpisodeOffset: 999 };
    const before = requests.length;
    await Promise.all([c.resolver.ensureSeasonStills(anime, 6, season), c.resolver.ensureSeasonStills(anime, 6, season)]);
    assert.equal(requests.length, before + 1);
    assert.ok(requests.at(-1).endsWith("season=5"));
    assert.equal(Object.keys(anime.tmdbEpisodesBySeasonNum[6]).length, count);
    assert.equal(c.resolver.getSeasonEpisodeMeta(anime, 6, 1).title, `Correct Arc ${offset + 1}`);
    assert.equal(c.resolver.getSeasonEpisodeMeta(anime, 6, count).title, `Correct Arc ${offset + count}`);
    assert.equal(c.resolver.getSeasonEpisodeMeta(anime, 6, count + 1), null);
    assert.ok(c.resolver.getEpisodeStill(anime, { episode: count }, 6).includes(`correct-arc-${offset + count}.jpg`));
    await c.resolver.ensureSeasonStills(anime, 6, season);
    await c.resolver.ensureSeasonStills(stoneOceanFixture(anilistId), 6, season);
    assert.equal(requests.length, before + 1, "memory and persisted range caches remain reusable");
  }
});

test("a failed Stone Ocean metadata request remains bounded instead of retrying every render", async () => {
  let requests = 0;
  const c = context(async () => { requests += 1; return { ok: false, status: 503 }; });
  const anime = stoneOceanFixture();
  for (let i = 0; i < 5; i += 1) await c.resolver.ensureSeasonStills(anime, 6, { episodeCount: 12 });
  assert.equal(requests, 1);
});

test("the complete Stone Ocean provider page retains all 38 episode titles and source IDs", async () => {
  const c = context(async () => ({ ok: true, json: async () => ({ season: { episodes: stoneOceanEpisodes } }) }));
  const anime = { ...stoneOceanFixture(), sourceEpisodeCount: 38,
    sourceEpisodeIds: Array.from({ length: 38 }, (_, i) => i + 1) };
  const originalIds = [...anime.sourceEpisodeIds];
  await c.resolver.ensureSeasonStills(anime, 6, { anilistId: 131942, episodeCount: 38 });
  assert.equal(Object.keys(anime.tmdbEpisodesBySeasonNum[6]).length, 38);
  for (let episode = 1; episode <= 38; episode += 1) {
    assert.equal(c.resolver.getSeasonEpisodeMeta(anime, 6, episode).title, `Correct Arc ${episode}`);
    assert.ok(c.resolver.getEpisodeStill(anime, { episode }, 6).includes(`correct-arc-${episode}.jpg`));
  }
  assert.deepEqual(anime.sourceEpisodeIds, originalIds);
});

test("a new season seen first at episode two retains both episode rows", () => {
  const c = context();
  vm.runInContext(section(clientSource, "function animeAv1CatalogSlugForShow(", "function queueLiveSearch("), c);
  vm.runInContext(section(clientSource, "function makeAv1OnlyShow(", "function registerAv1Show("), c);
  const show = c.makeAv1OnlyShow({
    slug: "yasei-no-last-boss-ga-arawareta-2nd-season",
    title: "Yasei no Last Boss ga Arawareta! 2nd Season",
    episode: 2
  });
  const [season] = c.getDetailSeasons(show);
  assert.equal(season.season, 2);
  assert.deepEqual(Array.from(season.episodes, episode => episode.providerEpisodeId), [1, 2]);
  assert.ok(season.episodes.every(episode => episode.needsResolve));
  assert.deepEqual(Array.from(show.sourceEpisodeIds), [2], "observed IDs are not fabricated");
  assert.equal(show.sourceInventoryPartial, true);

  c.applyAnimeAv1LatestEpisodeToShow(show, { episode: 3 });
  assert.equal(show.sourceInventoryPartial, true, "a later feed update is still not a full inventory");
  assert.deepEqual(Array.from(c.getDetailSeasons(show)[0].episodes, episode => episode.providerEpisodeId), [1, 2, 3]);
});

test("a complete sparse provider inventory keeps its real gaps after a feed update", () => {
  const c = context();
  vm.runInContext(section(clientSource, "function animeAv1CatalogSlugForShow(", "function queueLiveSearch("), c);
  const show = {
    id: "animeav1-sparse", title: "Sparse Season", animeAv1Slug: "sparse",
    sourceInventoryChecked: true, sourceEpisodeCount: 3,
    sourceEpisodeIds: [1, 3], sourcePlayableEpisodeCount: 2
  };
  c.applyAnimeAv1LatestEpisodeToShow(show, { episode: 4 });
  assert.equal(show.sourceInventoryPartial, false);
  assert.deepEqual(Array.from(c.makePlaceholderEpisodes(show, 1), episode => episode.providerEpisodeId), [1, 3, 4]);
});

test("a feed movie at provider episode zero still opens as display episode one", () => {
  const c = context();
  vm.runInContext(section(clientSource, "function animeAv1CatalogSlugForShow(", "function queueLiveSearch("), c);
  vm.runInContext(section(clientSource, "function makeAv1OnlyShow(", "function registerAv1Show("), c);
  const show = c.makeAv1OnlyShow({ slug: "movie", title: "Movie", episode: 0 });
  const [episode] = c.makePlaceholderEpisodes(show, 1);
  assert.equal(episode.providerEpisodeId, 0);
  assert.equal(episode.canonicalEpisode, 1);
});

test("catalog normalization preserves partial inventories until a complete inventory arrives", () => {
  const c = context();
  vm.runInContext(readFileSync(new URL("../js/normalize.js", import.meta.url), "utf8"), c);
  const partial = c.normalizeExternalShow({
    id: "animeav1-new-second-season", title: "New Second Season", episode: 2,
    source: "AnimeAV1", sourceInventoryChecked: true, sourceInventoryPartial: true,
    sourceEpisodeIds: [2], sourceEpisodeCount: 2, sourcePlayableEpisodeCount: 1
  }, { id: "animetv-api", name: "AnimeAV1" }, 0);
  assert.equal(partial.sourceInventoryPartial, true);
  assert.deepEqual(Array.from(c.makePlaceholderEpisodes(partial, 2), episode => episode.providerEpisodeId), [1, 2]);
  const complete = { ...partial, sourceInventoryPartial: false, sourceEpisodeIds: [1, 2], sourcePlayableEpisodeCount: 2 };
  for (const [current, incoming] of [[partial, complete], [complete, partial]]) {
    const merged = c.mergeClientCatalogShow(current, incoming);
    assert.equal(merged.sourceInventoryPartial, false);
    assert.deepEqual(Array.from(merged.sourceEpisodeIds), [1, 2]);
  }
});

test("older same-title catalog responses cannot remove already loaded episode routes", () => {
  const c = context();
  vm.runInContext(readFileSync(new URL("../js/normalize.js", import.meta.url), "utf8"), c);
  const newest = { id: "animeav1-example", title: "Example", animeAv1Slug: "example",
    sourceInventoryChecked: true, sourceEpisodeIds: [1, 2], sourceEpisodeCount: 2, sourcePlayableEpisodeCount: 2 };
  const older = { ...newest, sourceEpisodeIds: [1], sourceEpisodeCount: 1, sourcePlayableEpisodeCount: 1 };
  const feed = { ...newest, sourceInventoryPartial: true, sourceEpisodeIds: [3], sourceEpisodeCount: 3, sourcePlayableEpisodeCount: 1 };
  for (const [current, incoming] of [[newest, older], [older, newest], [newest, feed], [feed, newest]]) {
    const merged = c.mergeClientCatalogShow(current, incoming);
    const expected = current === feed || incoming === feed ? [1, 2, 3] : [1, 2];
    assert.deepEqual(Array.from(merged.sourceEpisodeIds), expected);
    assert.equal(merged.sourcePlayableEpisodeCount, expected.length);
    assert.deepEqual(Array.from(c.makePlaceholderEpisodes(merged, 1), episode => episode.providerEpisodeId), expected);
  }
});

test("a long-series starter row does not become latest-episode-only after the live feed arrives", () => {
  const c = context();
  vm.runInContext(readFileSync(new URL("../js/normalize.js", import.meta.url), "utf8"), c);
  vm.runInContext(section(clientSource, "function animeAv1CatalogSlugForShow(", "function queueLiveSearch("), c);
  const starter = c.normalizeExternalShow({ id: "animeav1-example", title: "Example",
    sourceInventoryChecked: true, sourceEpisodeCount: 40, sourcePlayableEpisodeCount: 40
  }, { id: "animetv-api", name: "AnimeAV1" }, 0);
  assert.equal(starter.sourceInventoryPartial, true);
  c.applyAnimeAv1LatestEpisodeToShow(starter, { episode: 41 });
  assert.equal(c.makePlaceholderEpisodes(starter, 1).length, 41);
});

test("newer explicit removals are respected and different provider slugs never combine inventories", () => {
  const c = context();
  vm.runInContext(readFileSync(new URL("../js/normalize.js", import.meta.url), "utf8"), c);
  const old = { id: "animeav1-example", animeAv1Slug: "example", sourceInventoryChecked: true,
    sourceEpisodeIds: [1, 2], sourceEpisodeCount: 2, sourcePlayableEpisodeCount: 2, sourceInventoryCheckedAt: "2026-10-01" };
  const updated = { ...old, sourceEpisodeIds: [1], sourceEpisodeCount: 1, sourcePlayableEpisodeCount: 1,
    sourceUnavailableEpisodeIds: [2], sourceInventoryCheckedAt: "2026-10-03" };
  for (const pair of [[old, updated], [updated, old]]) {
    const merged = c.mergeClientCatalogShow(...pair);
    assert.deepEqual(Array.from(merged.sourceEpisodeIds), [1]);
    assert.equal(merged.sourcePlayableEpisodeCount, 1);
  }
  const anotherSeason = { ...updated, animeAv1Slug: "example-season-two", sourceEpisodeIds: [5] };
  assert.deepEqual(Array.from(c.mergeClientCatalogShow(old, anotherSeason).sourceEpisodeIds), [5]);
});

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

test("Steel Ball Run has one Season 6 selector and four observed episodes on either title", () => {
  const c = context();
  const shows = jojoCatalog(c);
  Object.assign(shows[7], { sourceEpisodeIds: [1, 2, 3, 4], sourceEpisodeCount: 4 });
  const map = new Map(shows.map(show => [String(show.anilistId), show]));
  vm.runInContext(section(clientSource, "function buildSeasonNav(", "function resetEpisodePanelScroll("), c);
  vm.runInContext(section(clientSource, "function selectedSeasonIdentity(", "function normalizeDisplayText("), c);
  for (const show of [shows[7], shows[8], shows[5]]) {
    c.ensureFranchiseShowsInCatalog(show);
    const raw = c.buildSeasonListFromBakedChain(show, map);
    const list = c.combineSteelBallRunSeasonList(raw, show);
    const steel = list.filter(season => season.season === 7);
    assert.equal(steel.length, 1);
    assert.equal(steel[0].title, "Season 6: Steel Ball Run");
    assert.equal(steel[0].part, null);
    assert.deepEqual(Array.from(steel[0].episodes, episode => episode.episode), [1, 2, 3, 4]);
    assert.deepEqual(Array.from(list.filter(season => season.season === 6), season => season.episodes.length), [12, 12, 14]);
    const nav = c.buildSeasonNav(show, c.getDetailSeasons(show), list);
    assert.equal(nav.filter(entry => entry.label === "Season 6: Steel Ball Run").length, 1);
    if (show !== shows[5]) {
      assert.equal(nav.at(-1).isCurrent, true);
      assert.deepEqual({ ...c.selectedSeasonIdentity(show) }, { seasonNumber: 7, seasonPart: "" });
    }
  }
});

test("the combined Steel Ball Run list preserves inventory holes and expands when a real release arrives", () => {
  const c = context();
  const shows = jojoCatalog(c);
  Object.assign(shows[7], { sourceEpisodeIds: [1, 3, 4], sourceEpisodeCount: 4 });
  assert.deepEqual(Array.from(c.getDetailSeasons(shows[8])[0].episodes, ep => ep.episode), [1, 3, 4]);
  shows[7].sourceEpisodeIds.push(5);
  shows[7].sourceEpisodeCount = 5;
  assert.deepEqual(Array.from(c.getDetailSeasons(shows[7])[0].episodes, ep => ep.providerEpisodeId), [1, 3, 4, 5]);
  shows[7].sourceEpisodeIds.push(13);
  shows[7].sourceEpisodeCount = 13;
  assert.deepEqual(Array.from(c.getDetailSeasons(shows[7])[0].episodes, ep => ep.providerEpisodeId), [1, 3, 4, 5, 13],
    "observed future releases are not capped to an old planned total");
});

test("legacy Steel Ball Run progress and links become absolute without overwriting newer saved positions", () => {
  const c = context();
  const shows = jojoCatalog(c);
  const key = (show, season, episode) => `${show.id}:s${season}:e${episode}`;
  const map = { [key(shows[8], 7, 3)]: { lastPosition: 123, progress: 10 } };
  c.buildWatchKey = key;
  c.getAnimeTrackId = show => show.id;
  c.getWatchMap = () => map;
  let writes = 0;
  c.persistWatchMap = () => writes++;
  const resolved = c.resolveJojoOpenTarget(shows[8], { seasonNumber: 7, seasonPart: 2, episodeNumber: 3 });
  assert.equal(resolved.show, shows[7]);
  assert.equal(resolved.target.episodeNumber, 4);
  assert.equal(map[key(shows[7], 7, 4)].lastPosition, 123);
  assert.equal(map[key(shows[8], 7, 3)].lastPosition, 123, "legacy data remains available");
  map[key(shows[7], 7, 4)].lastPosition = 222;
  assert.equal(c.resolveJojoOpenTarget(shows[7], { seasonNumber: 7, episodeNumber: 4 }), null);
  assert.equal(map[key(shows[7], 7, 4)].lastPosition, 222);
  assert.equal(writes, 1);
  c.reconcileWatchMapSeasons = () => false;
  c.isResumableWatchEntry = entry => !!entry.progress;
  c.sanitizeWatchEntry = () => {};
  vm.runInContext(section(clientSource, "function getContinueWatchingList(", "let _cwTimer ="), c);
  assert.equal(c.getContinueWatchingList().length, 1, "a migrated episode does not appear twice in Continue Watching");
  assert.equal(c.resolveJojoOpenTarget(shows[7], { seasonNumber: 7, seasonPart: 1, episodeNumber: 4 }).target.episodeNumber, 4);
  assert.equal(c.resolveJojoOpenTarget(shows[8], { seasonNumber: 7, episodeNumber: 3 }).target.episodeNumber, 4);
  assert.equal(c.resolveJojoOpenTarget(shows[8], {}).show, shows[7]);
});

test("Steel Ball Run progress ignores a provider's Season 1 wrapper", () => {
  const c = context();
  const shows = jojoCatalog(c);
  vm.runInContext(section(clientSource, "function authoritativeWatchSeason(", "// Catalog corrections"), c);
  const anchor = { ...shows[7], seasons: [{ season: 1 }] };
  assert.equal(c.authoritativeWatchSeason(anchor, 7), 7);
  assert.equal(c.authoritativeWatchSeason(anchor, 1), 7);
  assert.equal(c.authoritativeWatchSeason({ title: "Neutral series", seasons: [{ season: 1 }] }, 7), 1);
});

test("separate Steel Ball Run source pages combine without changing their provider episode IDs", () => {
  const c = context();
  const shows = jojoCatalog(c);
  Object.assign(shows[7], { sourceEpisodeIds: [1], sourceEpisodeCount: 1 });
  Object.assign(shows[8], { id: "animeav1-neutral-stages", animeAv1Slug: "neutral-stages",
    sourceInventoryChecked: true, sourceEpisodeIds: [1, 2, 3], sourceEpisodeCount: 3 });
  const season = c.getDetailSeasons(shows[7])[0];
  assert.deepEqual(Array.from(season.episodes, ep => ep.episode), [1, 2, 3, 4]);
  assert.deepEqual(Array.from(season.episodes, ep => ep.providerEpisodeId), [1, 1, 2, 3]);
  assert.equal(season.episodes[3].providerAnimeSlug, "neutral-stages");
});

test("combined Steel Ball Run metadata repairs old rebased titles and stills without repeated requests", async () => {
  let requests = 0;
  const c = context(async () => {
    requests++;
    return { ok: true, json: async () => ({ season: { episodes: Array.from({ length: 4 }, (_, i) => ({
      episode_number: i + 1, name: `Neutral Stage ${i + 1}`, still_path: `/neutral-stage-${i + 1}.jpg`
    })) } }) };
  });
  const shows = jojoCatalog(c);
  Object.assign(shows[7], { sourceEpisodeIds: [1, 2, 3, 4], sourceEpisodeCount: 4 });
  for (const show of [shows[7], shows[8]]) {
    Object.assign(show, { tmdbId: 45790, tmdbSeasons: stoneOceanSeasons,
      _tmdbEpisodeScope: "jojo:7:1:11", tmdbEpisodesByNum: { 1: { title: "Old rebased title" } } });
    const season = c.getDetailSeasons(show)[0];
    await c.resolver.ensureSeasonStills(show, 7, season);
    assert.equal(c.resolver.getSeasonEpisodeMeta(show, 7, 4).title, "Neutral Stage 4");
    assert.ok(c.resolver.getEpisodeStill(show, { episode: 4 }, 7).includes("neutral-stage-4.jpg"));
    assert.equal(Object.keys(show.tmdbEpisodesBySeasonNum[7]).length, 4);
    assert.equal(c.getDetailSeasons(show)[0].episodes.length, 4);
    await c.resolver.ensureSeasonStills(show, 7, season);
  }
  assert.equal(requests, 2, "each identity requests metadata once, not on every render");
});

test("a fresh Steel Ball Run continuation URL never selects the premiere sharing its MAL ID", () => {
  const c = context();
  const routerSource = readFileSync(new URL("../js/router.js", import.meta.url), "utf8");
  vm.runInContext(section(routerSource, "function slugify(", "function safeDecode("), c);
  c.appRouter = () => ({ slugify: c.slugify });
  const chain = jojoChain();
  const anchor = { ...chain.find(entry => entry.anilistId === 190327),
    id: "animeav1-steel-ball-run-jojo-no-kimyou-na-bouken",
    animeAv1Slug: "steel-ball-run-jojo-no-kimyou-na-bouken", franchiseSeasons: chain,
    sourceInventoryChecked: true, sourceEpisodeIds: [1, 2, 3, 4], sourceEpisodeCount: 4 };
  c.state.shows = [anchor];
  const slug = "jojo-no-kimyou-na-bouken-steel-ball-run-2nd-and-3rd-stage";
  const continuation = c.findShowBySlugOrId(slug);
  assert.equal(continuation.anilistId, 210482);
  assert.equal(continuation.malId, anchor.malId);
  assert.equal(SeasonNormalization.jojoEntryScope(continuation).partNumber, 2);
  const season = c.getDetailSeasons(continuation)[0];
  assert.deepEqual(Array.from(season.episodes, episode => episode.providerEpisodeId), [1, 2, 3, 4]);
  assert.equal(c.findShowBySlugOrId(slug), continuation);
  assert.equal(c.findShowBySlugOrId(anchor.animeAv1Slug), anchor);
});

test("a bare number in a standalone title is not invented as a season", () => {
  const c = context();
  const [normalizedThunder] = SeasonNormalization.normalizeFranchise([{
    anilistId: 207254,
    title: "Thunder 3",
    format: "TV",
    seasonYear: 2026
  }]).groups;
  assert.equal(normalizedThunder.seasonNumber, 1);
  assert.equal(normalizedThunder.title, "Season 1");

  const [normalizedExplicit] = SeasonNormalization.normalizeFranchise([{
    title: "Example Season 3",
    format: "TV"
  }]).groups;
  assert.equal(normalizedExplicit.seasonNumber, 3);
  assert.equal(normalizedExplicit.title, "Season 3");

  const [thunder] = c.getDetailSeasons({
    id: "animeav1-thunder-3",
    title: "Thunder 3",
    sourceEpisodeCount: 9
  });
  assert.equal(thunder.season, 1);
  assert.equal(thunder.title, "Episodes");
  assert.equal(thunder.episodes.length, 9);

  const [explicit] = c.getDetailSeasons({
    id: "animeav1-example-season-3",
    title: "Example Season 3",
    sourceEpisodeCount: 1
  });
  assert.equal(explicit.season, 3);
  assert.equal(explicit.title, "Season 3");
});

test("the richest relation carrier preserves every Bleach season on a direct visit", () => {
  const c = context();
  const chain = [
    { anilistId: 269, malId: 269, title: "Bleach", episodes: 366 },
    { anilistId: 116674, malId: 41467, title: "Bleach: Sennen Kessen-hen", episodes: 13 },
    { anilistId: 159322, malId: 53998, title: "Bleach: Sennen Kessen-hen - Ketsubetsu-tan", episodes: 13 },
    { anilistId: 169755, malId: 56784, title: "Bleach: Sennen Kessen-hen - Soukoku-tan", episodes: 14 },
    { anilistId: 182379, malId: 60217, title: "Bleach: Sennen Kessen-hen - Kashin-tan", episodes: 7 }
  ];
  const base = {
    id: "animeav1-bleach",
    anilistId: 269,
    malId: 269,
    franchiseSeasons: [chain[0]]
  };
  const carrier = {
    id: "animeav1-bleach-sennen-kessen-hen-kashin-tan",
    anilistId: 182379,
    malId: 60217,
    franchiseSeasons: chain
  };
  const unrelated = {
    id: "animeav1-unrelated",
    anilistId: 999,
    franchiseSeasons: Array.from({ length: 8 }, (_, index) => ({ anilistId: 900 + index }))
  };
  c.state.shows = [base, carrier, unrelated];
  const resolved = c.bakedChainFor(base);
  assert.equal(resolved.chain.length, 5);
  assert.deepEqual(Array.from(resolved.chain, entry => entry.episodes), [366, 13, 13, 14, 7]);
  assert.equal(resolved.selfAniListId, 269);
  assert.equal(resolved.selfMalId, 269);
});

test("baked franchise lookup refreshes when a richer catalog arrives", () => {
  const c = context();
  const show = { id: "animeav1-example", anilistId: 10, franchiseSeasons: [{ anilistId: 10 }] };
  c.state.shows = [show];
  assert.equal(c.bakedChainFor(show).chain.length, 1);
  const carrier = { id: "animeav1-example-sequel", anilistId: 11, franchiseSeasons: [{ anilistId: 10 }, { anilistId: 11 }] };
  c.state.shows = [show, carrier];
  assert.equal(c.bakedChainFor(show).chain.length, 2);
});

test("baked franchise lookup refreshes when the open title gains its canonical id", () => {
  const c = context();
  const show = { id: "direct-show" };
  const carrier = { id: "source-carrier", anilistId: 11,
    franchiseSeasons: [{ anilistId: 10 }, { anilistId: 11 }] };
  c.state.shows = [show, carrier];
  assert.equal(c.bakedChainFor(show), null);
  show.anilistId = 10;
  assert.equal(c.bakedChainFor(show).chain.length, 2);
});

test("one absolute provider inventory is partitioned across released franchise seasons", () => {
  const c = context();
  const show = {
    id: "animeav1-kinnikuman-kanpeki-choujin-shiso-hen",
    animeAv1Slug: "kinnikuman-kanpeki-choujin-shiso-hen",
    anilistId: 162796,
    malId: 54730,
    title: "Kinnikuman: Kanpeki Choujin Shiso-hen",
    sourceInventoryChecked: true,
    sourceEpisodeIds: Array.from({ length: 23 }, (_, index) => index),
    sourceEpisodeCount: 22,
    sourcePlayableEpisodeCount: 23,
    franchiseSeasons: []
  };
  const chain = [
    { anilistId: 162796, malId: 54730, title: show.title, episodes: 11, seasonYear: 2024, startedAt: 1, order: 1 },
    { anilistId: 181886, malId: 59914, title: `${show.title} Season 2`, episodes: 11, seasonYear: 2025, startedAt: 2, order: 2 },
    { anilistId: 196893, malId: 62206, title: `${show.title} Season 3`, episodes: 12, status: "NOT_YET_RELEASED", startedAt: 3, order: 3 }
  ];
  show.franchiseSeasons = chain;
  const showsMap = new Map([[String(show.anilistId), show], [`mal-${show.malId}`, show]]);
  c.fixtureShow = show;
  c.fixtureShowsMap = showsMap;
  const seasons = vm.runInContext("buildSeasonListFromBakedChain(fixtureShow, fixtureShowsMap)", c);
  assert.equal(seasons.length, 3);
  assert.deepEqual(Array.from(seasons[0].episodes, (episode) => episode.canonicalEpisode), [0, ...Array.from({ length: 11 }, (_, index) => index + 1)]);
  assert.deepEqual(Array.from(seasons[1].episodes, (episode) => episode.canonicalEpisode), Array.from({ length: 11 }, (_, index) => index + 1));
  assert.deepEqual(Array.from(seasons[1].episodes, (episode) => episode.providerEpisodeId), Array.from({ length: 11 }, (_, index) => index + 12));
  assert.equal(seasons[1].playable, true);
  assert.equal(seasons[2].episodes.length, 0);
  assert.equal(seasons[2].playable, false);
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
    { items: [{ anilistId: 1, malId: 11, tmdbId: 99, tmdbFranchiseFallback: true, title: "Example", episodes: 12, status: "FINISHED" }] },
    { items: [{ anilistId: 2, malId: 22, title: "Example Season 2", episodes: 12, status: "FINISHED" }] }
  ] } };
  c.state.shows = [show];
  c.state.activeShow = show;
  c.buildSeasonNav = () => [{ relatedShowId: c.state.shows.find(entry => entry.anilistId === 1)?.id }];
  vm.runInContext(section(clientSource, "const liveNav = () => {", "const navTo =") + "this.getLiveNav = liveNav;", c);
  const result = c.getLiveNav();
  assert.equal(result.list[0].relatedShowId, "anilist-1");
  assert.equal(c.state.shows.length, 2);
  assert.equal(c.state.shows.find(entry => entry.id === "anilist-1").tmdbId, 99);
  assert.equal(c.state.shows.find(entry => entry.id === "anilist-1").tmdbFranchiseFallback, true);
  assert.equal(c.state.shows.find(entry => entry.id === "anilist-1").tmdbFranchiseCarrierSeason, 2);
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
    RATE_LIMIT_MAX_REQUESTS: 240, RATE_LIMIT_MEDIA_MAX_REQUESTS: 1800,
    rateLimitBuckets: new Map(), getClientIp: () => "fixture", pruneRateLimitBuckets() {} });
  vm.runInContext(section(serverSource, "function checkRateLimit(", "function pruneRateLimitBuckets("), c);
  for (let i = 0; i < 250; i++) assert.equal(c.checkRateLimit({}, new URL("https://example.test/api/tmdb/season")).allowed, true);
  assert.equal(c.checkRateLimit({}, new URL("https://example.test/api/animeav1/sources")).allowed, true);
  for (let i = 0; i < 110; i++) c.checkRateLimit({}, new URL("https://example.test/api/tmdb/season"));
  assert.equal(c.checkRateLimit({}, new URL("https://example.test/api/tmdb/season")).allowed, false);
  for (let i = 0; i < 1000; i++) assert.equal(c.checkRateLimit({}, new URL("https://example.test/api/source")).allowed, true);
  assert.equal(c.checkRateLimit({}, new URL("https://example.test/api/source")).limit, 1800);
});

test("catalog responses vary by both CORS origin and compression", () => {
  const c = vm.createContext({
    JSON,
    SECURITY_HEADERS: {},
    corsHeaders: () => ({ "Access-Control-Allow-Origin": "*", "Vary": "Origin" })
  });
  vm.runInContext(section(serverSource, "function sendJson(", "function sendCorsPreflight("), c);
  let captured = null;
  c.sendJson({
    writeHead: (status, headers) => { captured = { status, headers }; },
    end() {}
  }, { ok: true }, 200, { "Vary": "Accept-Encoding" });
  assert.equal(captured.status, 200);
  assert.equal(captured.headers.Vary, "Origin, Accept-Encoding");
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

test("TMDB refreshes a fresh cache that is missing the newest playable episode", async () => {
  const calls = [];
  const c = context(async url => {
    calls.push(url);
    const body = url.includes("/tv?")
      ? { show: { id: 99, poster_path: "/poster.jpg", seasons: [{ season_number: 1, name: "Season 1", episode_count: 2 }] } }
      : { season: { episodes: [
          { episode_number: 1, name: "First", air_date: "2026-01-01", still_path: "/first.jpg" },
          { episode_number: 2, name: "Fresh title", air_date: "2026-01-08", still_path: "/fresh.jpg" }
        ] } };
    return { ok: true, json: async () => body };
  });
  c.localStorage.setItem("zenkaitv:tmdb-match:v18:123", JSON.stringify({
    savedAt: Date.now(),
    data: {
      tmdbId: 99,
      confidence: 100,
      showPoster: "https://image.test/poster.jpg",
      episodeStills: { 1: "https://image.test/first.jpg" },
      episodesByNum: { 1: { episode: 1, title: "First" } },
      seasons: [{ season_number: 1, name: "Season 1", episode_count: 2 }]
    }
  }));
  const show = {
    id: "latest-show",
    anilistId: 123,
    tmdbId: 99,
    title: "Latest Show",
    format: "TV",
    sourceEpisodeCount: 2,
    sourceEpisodeIds: [1, 2]
  };
  await c.resolver.hydrateTmdbImages(show);
  assert.ok(calls.some(url => url.includes("/api/tmdb/season")));
  assert.equal(show.tmdbEpisodesByNum[2].title, "Fresh title");
  assert.match(show.tmdbEpisodesByNum[2].thumbnail, /fresh\.jpg$/);
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
