import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const utils = require("../js/utils.js");
const SeasonNormalization = require("../js/season-normalization.js");
const sourceClassification = require("../js/source-classification.js");
const normalizeSource = readFileSync(new URL("../js/normalize.js", import.meta.url), "utf8");
const routerSource = readFileSync(new URL("../js/router.js", import.meta.url), "utf8");
const clientSource = readFileSync(new URL("../client.js", import.meta.url), "utf8");

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing source section ${start}`);
  return source.slice(from, to);
}

function normalizationContext() {
  const sandbox = vm.createContext({
    console: { log() {}, warn() {}, debug() {} },
    ...utils,
    SeasonNormalization,
    Date,
    URL,
    pickGenre: (genres) => genres[0] || "",
    pickPlayableUrl: (item = {}) => item.videoUrl || item.streamUrl || item.file || item.url || "",
    getEpisodeUrl: (episode = {}) => episode.videoUrl || episode.streamUrl || episode.file || "",
    normalizeSubtitleTracks: (item = {}) => Array.isArray(item.subtitles) ? item.subtitles : [],
    cleanPlaybackSourceLabel: (value) => String(value || ""),
    isAnime1vEpisode: () => false,
    sourceLabelFromResolver: (resolver = {}) => resolver.type || "Resolver",
    languageName: (value) => value || "",
    isSafeAdultMetadata: () => true
  });
  vm.runInContext(`${normalizeSource}\nthis.pipeline = {
    normalizeExternalShow, normalizeSeasons, normalizeEpisodes,
    normalizeEpisodeSourceOptions, groupEpisodesBySeason, mergeEpisodes,
    parseEpisodeNumber, getCanonicalEpisodeNumber, getProviderEpisodeId,
    canonicalEpisodeIdentity
  };`, sandbox);
  return sandbox;
}

function routerContext(pathname = "/") {
  const sandbox = vm.createContext({
    URL,
    location: { pathname, search: "", hash: "" },
    history: { pushState() {}, replaceState() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    window: { addEventListener() {}, dispatchEvent() {} }
  });
  vm.runInContext(routerSource, sandbox);
  return sandbox.window.ZenkaiRouter;
}

function applyTargetContext(seasons) {
  const state = {};
  const sandbox = vm.createContext({
    state,
    extractSeasonNumber: utils.extractSeasonNumber,
    parseEpisodeNumber: (value, fallback = null) => {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
      const match = String(value ?? "").match(/^\d+(?:\.\d+)?$/);
      return match ? Number(match[0]) : fallback;
    },
    getCanonicalEpisodeNumber: (episode = {}, fallback = null) => {
      for (const value of [episode.canonicalEpisode, episode.episode, episode.number]) {
        const number = Number(value);
        if (value !== "" && value != null && Number.isFinite(number) && number >= 0) return number;
      }
      return fallback;
    },
    getDetailSeasons: () => seasons,
    getEpisodeUrl: (episode = {}) => episode.videoUrl || ""
  });
  vm.runInContext(section(clientSource, "function applyOpenTarget(", "function closeShow("), sandbox);
  return sandbox;
}

function navigationContext(seasons, selected) {
  const sandbox = vm.createContext({
    state: { activeShow: { id: "show" }, activeEpisode: selected },
    getDetailSeasons: () => seasons,
    getCanonicalEpisodeNumber: (episode = {}, fallback = null) => {
      const value = episode.canonicalEpisode ?? episode.episode ?? episode.number;
      return value == null ? fallback : Number(value);
    }
  });
  vm.runInContext(section(clientSource, "function getEpisodeNavigationTargets(", "function renderPlayerEpisodeActions("), sandbox);
  return sandbox;
}

test("1. single-season episode selection retains canonical identity", () => {
  const { pipeline } = normalizationContext();
  const seasons = pipeline.normalizeSeasons({
    id: "single",
    title: "Single Example",
    episodes: [{ id: "single-e1", episode: 1, videoUrl: "https://video.test/1.mp4" }]
  });
  assert.equal(seasons.length, 1);
  assert.equal(seasons[0].season, 1);
  assert.equal(seasons[0].episodes[0].canonicalEpisode, 1);
});

test("2. Season 2 Episode 1 is not relabeled as Season 1", () => {
  const { pipeline } = normalizationContext();
  const [episode] = pipeline.normalizeEpisodes({
    id: "second",
    title: "Example Season 2",
    episodes: [{ episode: 1, season: 2 }]
  });
  assert.equal(episode.canonicalSeason, 2);
  assert.equal(episode.canonicalEpisode, 1);
});

test("3. switching Season 1 to Season 2 selects that season's object", () => {
  const seasons = [
    { season: 1, episodes: [{ id: "s1e1", episode: 1 }] },
    { season: 2, episodes: [{ id: "s2e1", episode: 1 }] }
  ];
  const c = applyTargetContext(seasons);
  c.applyOpenTarget({ title: "Example" }, { seasonNumber: 2, episodeNumber: 1 });
  assert.equal(c.state.activeSeasonIndex, 1);
  assert.equal(c.state.activeEpisode.episode.id, "s2e1");
});

test("4. direct Season 2 URLs parse deterministically", () => {
  const route = routerContext("/watch/example/s2-e1").parsePath("/watch/example/s2-e1");
  assert.equal(route.target.seasonNumber, 2);
  assert.equal(route.target.episodeNumber, 1);
  assert.equal(route.target.watchRoute, true);
});

test("5. provider episode ID remains separate from display number", () => {
  const { pipeline } = normalizationContext();
  const [episode] = pipeline.normalizeEpisodes({
    id: "split-cour",
    episodes: [{ episode: 1, providerEpisodeId: 13, sourceEpisodeNumber: 13 }]
  });
  assert.equal(episode.canonicalEpisode, 1);
  assert.equal(pipeline.getProviderEpisodeId(episode), 13);
});

test("6. decimal episode numbers are not truncated", () => {
  const { pipeline } = normalizationContext();
  assert.equal(pipeline.parseEpisodeNumber("Episode 12.5"), 12.5);
  const [episode] = pipeline.normalizeEpisodes({ episodes: [{ episode: "12.5" }] });
  assert.equal(episode.canonicalEpisode, 12.5);
});

test("7. episode zero is a valid identity", () => {
  const { pipeline } = normalizationContext();
  assert.equal(pipeline.parseEpisodeNumber(0), 0);
  const [episode] = pipeline.normalizeEpisodes({ episodes: [{ episode: 0, providerEpisodeId: 0 }] });
  assert.equal(episode.canonicalEpisode, 0);
  assert.equal(pipeline.getProviderEpisodeId(episode), 0);
});

test("8. missing episode numbers are explicitly position-derived", () => {
  const { pipeline } = normalizationContext();
  const episodes = pipeline.normalizeEpisodes({ episodes: [{ title: "Pilot" }, { title: "Second" }] });
  assert.equal(episodes[0].canonicalEpisode, null);
  assert.equal(episodes[0].displayEpisodeNumber, 1);
  assert.equal(episodes[0].episodeNumberSource, "position");
  assert.equal(episodes[1].providerEpisodeId, null);
});

test("9. duplicate provider results merge by provider identity", () => {
  const { pipeline } = normalizationContext();
  const merged = pipeline.mergeEpisodes(
    [{ provider: "AnimeAV1", providerAnimeId: "example", providerEpisodeId: 7, season: 1, episode: 7, title: "Episode 7" }],
    [{ provider: "AnimeAV1", providerAnimeId: "example", providerEpisodeId: 7, season: 1, episode: 7, videoUrl: "https://video.test/7.mp4" }]
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].videoUrl, "https://video.test/7.mp4");
  assert.equal(merged[0].title, "Episode 7");
});

test("10. multiple source normalization preserves transport metadata", () => {
  const { pipeline } = normalizationContext();
  const sources = pipeline.normalizeEpisodeSourceOptions({
    providerEpisodeId: 4,
    sourceOptions: [
      { id: "hls", provider: "AnimeAV1", url: "https://video.test/a.m3u8", mimeType: "application/vnd.apple.mpegurl", codec: "avc1.42E01E", resolution: "1080p", bitrate: 4000000, headers: { Referer: "https://animeav1.com/" } },
      { id: "mp4", provider: "AnimeAV1", url: "https://video.test/a.mp4", mimeType: "video/mp4", codec: "h264" }
    ]
  });
  assert.equal(sources.length, 2);
  assert.equal(sources[0].resolution, "1080p");
  assert.equal(sources[0].headers.Referer, "https://animeav1.com/");
  assert.equal(sources[0].providerEpisodeId, 4);
});

test("11. a failed first source advances once to the next untried source", () => {
  const sandbox = vm.createContext({
    state: { preferredSource: "auto", activeEpisodeUrl: "" },
    getEpisodePlaybackSources: (episode) => episode.sourceOptions,
    isPreferredAdultSource: () => false,
    isAdultFallbackSource: () => false,
    sourcePreferenceScore: (source) => source.rank
  });
  vm.runInContext(section(clientSource, "function getSelectedEpisodeSource(", "function selectEpisodePlaybackSource("), sandbox);
  const episode = {
    sourceOptions: [{ id: "first", rank: 0 }, { id: "second", rank: 1 }],
    selectedSourceId: "first",
    _failedSourceIds: new Set(["first"])
  };
  assert.equal(sandbox.getSelectedEpisodeSource(episode).id, "second");
  episode._failedSourceIds.add("second");
  assert.equal(sandbox.getSelectedEpisodeSource(episode), null);
});

test("12. HLS sources retain manifest MIME and container", () => {
  const { pipeline } = normalizationContext();
  const [source] = pipeline.normalizeEpisodeSourceOptions({
    sourceOptions: [{ id: "hls", provider: "AnimeAV1", url: "https://video.test/master.m3u8", mimeType: "application/vnd.apple.mpegurl", container: "hls" }]
  });
  assert.equal(source.videoUrl, "https://video.test/master.m3u8");
  assert.equal(source.mimeType, "application/vnd.apple.mpegurl");
  assert.equal(source.container, "hls");
});

test("13. AV1 remains available but ranks behind supported H264 when unsupported", () => {
  const previous = globalThis.MediaSource;
  globalThis.MediaSource = { isTypeSupported: (mime) => !mime.includes("av01") };
  try {
    const av1 = { provider: "AnimeAV1", type: "direct", videoUrl: "https://video.test/a.m3u8", codec: "av01" };
    const h264 = { provider: "AnimeAV1", type: "direct", videoUrl: "https://video.test/b.m3u8", codec: "avc1.42E01E" };
    assert.equal(sourceClassification.declaredVideoCodec(av1), "av1");
    assert.ok(sourceClassification.sourcePreferenceScore(h264) < sourceClassification.sourcePreferenceScore(av1));
  } finally {
    if (previous === undefined) delete globalThis.MediaSource;
    else globalThis.MediaSource = previous;
  }
});

test("14. next episode follows 12 to 12.5 instead of adding one", () => {
  const season = { season: 1, episodes: [{ id: "e12", episode: 12 }, { id: "e12-5", episode: 12.5 }, { id: "e13", episode: 13 }] };
  const c = navigationContext([season], { season, episode: season.episodes[0], seasonIndex: 0, episodeIndex: 0 });
  const target = c.getEpisodeNavigationTargets().next;
  assert.deepEqual({ seasonIndex: target.seasonIndex, episodeIndex: target.episodeIndex }, { seasonIndex: 0, episodeIndex: 1 });
});

test("15. the final episode advances only to the next real season", () => {
  const seasons = [
    { season: 1, episodes: [{ id: "s1e1", episode: 1 }] },
    { season: 2, episodes: [{ id: "s2e1", episode: 1 }] }
  ];
  const c = navigationContext(seasons, { season: seasons[0], episode: seasons[0].episodes[0], seasonIndex: 0, episodeIndex: 0 });
  const target = c.getEpisodeNavigationTargets().next;
  assert.deepEqual({ seasonIndex: target.seasonIndex, episodeIndex: target.episodeIndex }, { seasonIndex: 1, episodeIndex: 0 });
});

test("16. refresh persistence retains split-cour provider offsets", () => {
  const store = new Map();
  const sandbox = vm.createContext({
    Date,
    localStorage: { getItem: (key) => store.get(key) || null, setItem: (key, value) => store.set(key, value) }
  });
  const cacheSection = section(clientSource, "const FRANCHISE_ROUTE_CACHE_KEY", "function findShowBySlugOrId(");
  vm.runInContext(`${cacheSection}\nthis.routeCache = { readFranchiseRoutes, rememberFranchiseRoutes };`, sandbox);
  sandbox.routeCache.rememberFranchiseRoutes([{
    id: "anilist-127720",
    anilistId: 127720,
    title: "Mushoku Tensei Part 2",
    isFranchiseEntry: true,
    canonicalSeasonNumber: 1,
    canonicalSeasonPart: 2,
    providerEpisodeOffset: 11,
    providerBaseTitle: "Mushoku Tensei",
    franchiseSeasons: [{ anilistId: 108465 }, { anilistId: 127720 }]
  }]);
  const restored = sandbox.routeCache.readFranchiseRoutes()[0].show;
  assert.equal(restored.canonicalSeasonNumber, 1);
  assert.equal(restored.canonicalSeasonPart, 2);
  assert.equal(restored.providerEpisodeOffset, 11);
});

test("17. mobile route application preserves Season 2 Episode 3", () => {
  const seasons = [
    { season: 1, episodes: [{ id: "s1e1", episode: 1 }] },
    { season: 2, episodes: [{ id: "s2e1", episode: 1 }, { id: "s2e2", episode: 2 }, { id: "s2e3", episode: 3 }] }
  ];
  const c = applyTargetContext(seasons);
  c.state.mobileViewport = true;
  c.applyOpenTarget({ title: "Example Season 2" }, { seasonNumber: 2, episodeNumber: 3 });
  assert.equal(c.state.activeSeasonIndex, 1);
  assert.equal(c.state.activeEpisode.episode.id, "s2e3");
});

test("18. Cast candidates start with the selected source from the active episode", () => {
  const episode = {
    selectedSourceId: "selected",
    videoUrl: "https://video.test/active.m3u8",
    sourceOptions: [
      { id: "active", label: "Active", videoUrl: "https://video.test/active.m3u8" },
      { id: "selected", label: "Selected", videoUrl: "https://video.test/selected.m3u8" }
    ]
  };
  const sandbox = vm.createContext({
    state: { activeEpisode: { episode } },
    getEpisodePlaybackSources: (value) => value.sourceOptions,
    getSelectedEpisodeSource: (value) => value.sourceOptions.find((source) => source.id === value.selectedSourceId),
    isActivePlaybackSource: (source, value) => source.videoUrl === value.videoUrl,
    isLocalSourceProxyUrl: () => false,
    localSourceProxyPath: (url) => url,
    resolveSourceEndpoint: (url) => url,
    streamTypeFromUrl: () => "hls"
  });
  vm.runInContext(section(clientSource, "function buildCastCandidateList(", "// The poster travels"), sandbox);
  const candidates = sandbox.buildCastCandidateList();
  assert.equal(candidates[0].label, "Selected");
  assert.equal(candidates.length, 2);
});

test("Mushoku Tensei relation chain is ordered into three canonical seasons", () => {
  const getCanonicalEpisodeNumber = (episode = {}, fallback = null) => {
    const value = episode.canonicalEpisode ?? episode.episode ?? episode.number;
    return value == null ? fallback : Number(value);
  };
  const state = { shows: [] };
  const sandbox = vm.createContext({
    console: { warn() {}, log() {} },
    state,
    SeasonNormalization,
    catalogShows: () => state.shows,
    rememberFranchiseRoutes() {},
    franchiseEntryKey: (entry) => String(entry.anilistId || entry.malId || ""),
    cleanDescription: (value) => String(value || ""),
    getCanonicalEpisodeNumber,
    getEpisodeUrl: (episode = {}) => episode.videoUrl || "",
    groupEpisodesBySeason: (episodes) => [{ season: 1, episodes }],
    repairEpisodeGaps: (episodes) => episodes,
    seasonAiredFloor: () => 0,
    extractSeasonNumber: utils.extractSeasonNumber
  });
  vm.runInContext(section(clientSource, "function bakedChainFor(", "// ── TioAnime source integration"), sandbox);
  vm.runInContext(section(clientSource, "function ensureFranchiseShowsInCatalog(", "function validateEpisodeIntegrity("), sandbox);

  const chain = [
    { anilistId: 108465, malId: 39535, title: "Mushoku Tensei: Isekai Ittara Honki Dasu", format: "TV", seasonYear: 2021, episodes: 11, status: "FINISHED" },
    { anilistId: 127720, malId: 45576, title: "Mushoku Tensei: Isekai Ittara Honki Dasu Part 2", format: "TV", seasonYear: 2021, episodes: 12, status: "FINISHED" },
    { anilistId: 146065, malId: 51179, title: "Mushoku Tensei II: Isekai Ittara Honki Dasu", format: "TV", seasonYear: 2023, episodes: 12, status: "FINISHED" },
    { anilistId: 166873, malId: 55888, title: "Mushoku Tensei II: Isekai Ittara Honki Dasu Part 2", format: "TV", seasonYear: 2024, episodes: 12, status: "FINISHED" },
    { anilistId: 178789, malId: 59284, title: "Mushoku Tensei III: Isekai Ittara Honki Dasu", format: "TV", seasonYear: 2026, episodes: 14, status: "RELEASING" }
  ];
  const current = {
    id: "source-animeav1-s3",
    anilistId: 178789,
    malId: 59284,
    title: chain[4].title,
    animeAv1Slug: "mushoku-tensei-iii-isekai-ittara-honki-dasu",
    franchiseSeasons: chain,
    seasons: [{ season: 3, episodes: Array.from({ length: 14 }, (_, index) => ({ episode: index + 1 })) }]
  };
  state.shows = [current];
  sandbox.ensureFranchiseShowsInCatalog(current);
  const showsMap = new Map();
  state.shows.forEach((show) => {
    if (show.anilistId) showsMap.set(String(show.anilistId), show);
    if (show.malId) showsMap.set(`mal-${show.malId}`, show);
  });
  const list = sandbox.buildSeasonListFromBakedChain(current, showsMap);
  assert.deepEqual(Array.from(list, (group) => group.title), [
    "Season 1 Part 1",
    "Season 1 Part 2",
    "Season 2 Part 1",
    "Season 2 Part 2",
    "Season 3"
  ]);
  assert.equal(list[1].episodes[0].providerEpisodeId, 12);
  assert.equal(list[3].episodes[0].providerEpisodeId, 13);
  assert.equal(list[4].episodes[0].providerEpisodeId, 1);
});
