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
    mergeShows, mergeSeasons,
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
  const state = { episodeChunkByContext: {} };
  const sandbox = vm.createContext({
    state,
    getShowKey: (show = {}) => show.id || show.slug || show.title || "show",
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
  vm.runInContext(section(clientSource, "function episodeChunkContextKey(", "function renderEpisodeList("), sandbox);
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

function searchContext(shows, query) {
  const sourceSearchMatches = new Map();
  const sandbox = vm.createContext({
    state: { shows, search: query },
    getShowTitle: (show = {}) => show.englishTitle || show.title || "",
    _animeAv1CatalogSearchMatches: sourceSearchMatches,
    animeAv1CatalogSlugForShow: (show = {}) => {
      const idSlug = String(show.id || "").match(/^animeav1-(.+)$/i)?.[1] || "";
      return String(show.animeAv1Slug || show._av1Slug || idSlug).trim().toLowerCase();
    }
  });
  vm.runInContext(
    section(clientSource, "function normalizeSearchText(", "// ── Live AniList search"),
    sandbox
  );
  sandbox.sourceSearchMatches = sourceSearchMatches;
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

test("2. Season 2 Episode 1 survives a provider season numbered 1", () => {
  const { pipeline } = normalizationContext();
  const show = pipeline.normalizeExternalShow({
    id: "second",
    title: "Example Season 2",
    canonicalSeasonNumber: 2,
    canonicalSeasonPart: 1,
    normalizedSeasonTitle: "Season 2 Part 1",
    providerEpisodeOffset: 12,
    seasons: [{
      season: 1,
      title: "Season 1",
      episodes: [{ episode: 1, season: 1, providerEpisodeId: 13 }]
    }]
  }, { id: "animeav1", name: "AnimeAV1", provider: "AnimeAV1" }, 0);
  const [season] = show.seasons;
  const [episode] = season.episodes;
  assert.equal(show.canonicalSeasonNumber, 2);
  assert.equal(show.canonicalSeasonPart, 1);
  assert.equal(show.providerEpisodeOffset, 12);
  assert.equal(season.season, 2);
  assert.equal(season.part, 1);
  assert.equal(episode.canonicalSeason, 2);
  assert.equal(episode.canonicalEpisode, 1);
  assert.equal(episode.providerEpisodeId, 13);

  const topLevel = pipeline.normalizeExternalShow({
    id: "second-flat",
    title: "Example Season 2",
    seasonNumber: 2,
    episodes: [{ episode: 1, season: 1, providerEpisodeId: 1 }]
  }, { id: "animeav1", name: "AnimeAV1", provider: "AnimeAV1" }, 0);
  assert.equal(topLevel.seasons[0].season, 2);
  assert.equal(topLevel.seasons[0].episodes[0].canonicalSeason, 2);
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

test("6b. catalog search tolerates a one-letter title typo without dropping another token", () => {
  const liarGame = { title: "Liar Game", aliases: ["LIAR GAME"] };
  const unrelated = { title: "Darling in the Franxx" };
  const context = searchContext([liarGame, unrelated], "lier game");
  assert.equal(context.matchesShowSearch(liarGame), true);
  assert.equal(context.matchesShowSearch(unrelated), false);
  context.state.search = "liar game";
  assert.equal(context.matchesShowSearch(liarGame), true);
});

test("6c. AnimeAV1 source results expand matches beyond visible local titles", () => {
  const sourceOnlyMatch = { id: "animeav1-dragon-ball-daima", title: "Daima" };
  const context = searchContext([sourceOnlyMatch], "Dragon Ball");
  context.sourceSearchMatches.set("dragon ball", new Set(["dragon-ball-daima"]));
  assert.equal(context.matchesShowSearch(sourceOnlyMatch), true);
});

test("13b. Hentai Ocean remains behind the UnderHentai primary source", () => {
  const underHentai = {
    id: "underhentai-release",
    label: "UnderHentai",
    type: "resolver",
    streamResolver: { type: "underhentai", endpoint: "/api/adult/underhentai/stream?episode=1" }
  };
  const hentaiOcean = {
    id: "hentaiocean-av01-sample-1",
    label: "Hentai Ocean AV1",
    provider: "Hentai Ocean",
    type: "direct",
    videoUrl: "/api/source?url=https%3A%2F%2Fw2.hentaiocean.com%2Fvideo%2Fsample.mp4",
    codec: "av01"
  };
  assert.ok(
    sourceClassification.sourcePreferenceScore(underHentai) < sourceClassification.sourcePreferenceScore(hentaiOcean),
    "secondary direct media must not displace the primary resolver"
  );
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

test("phone gallery lightboxes stay disabled at 760px and below", () => {
  const isDisabledAt = (innerWidth, clientWidth = innerWidth) => {
    const sandbox = vm.createContext({
      Math,
      Number,
      window: { innerWidth },
      document: { documentElement: { clientWidth } }
    });
    vm.runInContext(
      section(clientSource, "function isPhoneGalleryPopupDisabled(", "function stopActivePlayback("),
      sandbox
    );
    return sandbox.isPhoneGalleryPopupDisabled();
  };

  assert.equal(isDisabledAt(390), true);
  assert.equal(isDisabledAt(760), true);
  assert.equal(isDisabledAt(761), false);
  assert.equal(isDisabledAt(390, 1024), false);
  assert.equal(
    (clientSource.match(/if \(isPhoneGalleryPopupDisabled\(\)\) return;/g) || []).length,
    2,
    "both adult gallery thumbnail handlers must block phone lightboxes"
  );
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

test("19. stale provider season routes use the canonical sequel and cour identity", () => {
  const state = { activeShow: null, activeEpisode: null, activeSeasonIndex: 0 };
  const sandbox = vm.createContext({
    state,
    SeasonNormalization,
    appRouter: () => ({
      episodeSlug: (season, episode, part) => `s${season}${part ? `-part-${part}` : ""}-e${episode}`
    }),
    getShowSlug: (show = {}) => show.slug || "example"
  });
  vm.runInContext(section(clientSource, "function episodePathForShow(", "const FRANCHISE_ROUTE_CACHE_KEY"), sandbox);
  vm.runInContext(section(clientSource, "function selectedSeasonIdentity(", "function selectedSeasonLabel("), sandbox);
  const show = {
    slug: "example-season-2",
    canonicalSeasonNumber: 2,
    canonicalSeasonPart: 1,
    seasons: [{ season: 1, episodes: [{ season: 1, episode: 3 }] }]
  };
  assert.equal(
    sandbox.episodePathForShow(show, 1, 3, ""),
    "/watch/example-season-2/s2-part-1-e3"
  );

  const chainOnlyShow = {
    slug: "example-season-2",
    anilistId: 2,
    canonicalSeasonNumber: 2,
    canonicalSeasonPart: null,
    isFranchiseEntry: true,
    franchiseSeasons: [
      { anilistId: 1, title: "Example", format: "TV", episodes: 12, seasonYear: 2021 },
      { anilistId: 2, title: "Example II", format: "TV", episodes: 12, seasonYear: 2022 },
      { anilistId: 3, title: "Example II Part 2", format: "TV", episodes: 12, seasonYear: 2023 }
    ],
    seasons: [
      { season: 1, title: "Season 1", episodes: [{ season: 1, episode: 3 }] },
      { season: 1, title: "Season 1", episodes: [] }
    ]
  };
  const selected = {
    season: chainOnlyShow.seasons[0],
    episode: chainOnlyShow.seasons[0].episodes[0],
    seasonIndex: 0,
    episodeIndex: 0
  };
  state.activeShow = chainOnlyShow;
  state.activeEpisode = selected;
  vm.runInContext(section(clientSource, "function selectedSeasonLabel(", "function normalizeDisplayText("), sandbox);
  assert.equal(
    sandbox.episodePathForShow(chainOnlyShow, 1, 3, ""),
    "/watch/example-season-2/s2-part-1-e3"
  );
  assert.equal(sandbox.selectedSeasonLabel(selected), "Season 2 Part 1");
});

test("20. a resolved URL mounts after the first episode-row click", async () => {
  let plays = 0;
  const episode = { id: "show-s2-e3", videoUrl: "https://media.example/episode.m3u8" };
  const frame = { querySelector: () => null };
  const sandbox = vm.createContext({
    state: { playIntent: true, activeEpisode: { episode }, activeEpisodeUrl: "" },
    location: { hostname: "example.test" },
    console: { debug() {} },
    document: { querySelector: (selector) => selector === "#videoFrame" ? frame : null },
    getEpisodeUrl: (value) => value.videoUrl || "",
    getSelectedEpisodeSource: () => null,
    playActiveShow: async () => { plays += 1; }
  });
  vm.runInContext(section(clientSource, "function debugPromotion(", "function getSelectedEpisodeSource("), sandbox);
  assert.equal(sandbox.promoteResolvedEpisodeSource(episode), true);
  await Promise.resolve();
  assert.equal(plays, 1);
  assert.equal(sandbox.state.activeEpisodeUrl, episode.videoUrl);

  frame.querySelector = () => ({ id: "animePlayerFrame" });
  assert.equal(sandbox.promoteResolvedEpisodeSource(episode), false);
  await Promise.resolve();
  assert.equal(plays, 1);
});

test("21. an episode-row click reaches source scheduling with canonical season identity", () => {
  let scheduled = null;
  const episode = { id: "show-s2-e3", episode: 3, canonicalEpisode: 3 };
  const season = { season: 2, part: 1, episodes: [episode] };
  const state = {
    activeShow: { id: "show", slug: "show", canonicalSeasonNumber: 2, canonicalSeasonPart: 1 },
    activeEpisode: null,
    activeSeasonIndex: 0,
    episodeChunkByContext: {},
    currentRouteInfo: null
  };
  const frame = { style: { setProperty() {} } };
  const sandbox = vm.createContext({
    state,
    getDetailSeasons: () => [season],
    getEpisodeUrl: () => "",
    selectedSeasonIdentity: () => ({ seasonNumber: 2, seasonPart: 1 }),
    getCanonicalEpisodeNumber: (value, fallback) => value.canonicalEpisode ?? fallback,
    episodePathForShow: (_show, s, e, p) => `/watch/show/s${s}-part-${p}-e${e}`,
    appRouter: () => ({
      replace: (path) => { sandbox.location.pathname = path; },
      parsePath: (path) => ({ path })
    }),
    location: { pathname: "/anime/show" },
    updateRouteMeta() {},
    document: {
      body: { classList: { remove() {} } },
      querySelector: (selector) => selector === "#videoFrame" ? frame : null
    },
    stopActivePlayback() {},
    getWatchBackdropArtwork: () => "",
    schedulePlaybackSourceOptions: (_show, value, canonicalSeason, options) => {
      scheduled = { value, canonicalSeason, options };
    },
    renderEpisodeList() {},
    refreshFocusables() {},
    Math
  });
  vm.runInContext(section(clientSource, "function episodeChunkContextKey(", "function renderEpisodeList("), sandbox);
  vm.runInContext(section(clientSource, "function selectEpisodeByPosition(", "function showEpisodeListTab("), sandbox);
  sandbox.selectEpisodeByPosition(0, 0, true);
  assert.equal(scheduled.value, episode);
  assert.equal(scheduled.canonicalSeason, 2);
  assert.equal(scheduled.options.autoReplay, true);
  assert.equal(sandbox.location.pathname, "/watch/show/s2-part-1-e3");
});

test("22. catalog dedupe cannot erase a baked franchise chain", () => {
  const { pipeline } = normalizationContext();
  const chain = [
    { anilistId: 1, title: "Example", episodes: 12 },
    { anilistId: 2, title: "Example Season 2", episodes: 12 }
  ];
  const [merged] = pipeline.mergeShows([
    {
      id: "animeav1-example-season-2",
      anilistId: 2,
      title: "Example Season 2",
      source: "AnimeAV1",
      animeAv1Slug: "example-season-2",
      canonicalSeasonNumber: 2,
      canonicalSeasonPart: 1,
      franchiseSeasons: chain,
      seasons: [{ season: 2, part: 1, episodes: [{ season: 2, episode: 1 }] }]
    },
    {
      id: "anilist-2",
      anilistId: 2,
      title: "Example Season 2",
      source: "AniList",
      animeAv1Slug: "",
      canonicalSeasonNumber: null,
      canonicalSeasonPart: null,
      franchiseSeasons: null,
      seasons: []
    }
  ]);
  assert.equal(merged.franchiseSeasons.length, 2);
  assert.equal(merged.canonicalSeasonNumber, 2);
  assert.equal(merged.canonicalSeasonPart, 1);
  assert.equal(merged.animeAv1Slug, "example-season-2");
  assert.equal(merged.seasons[0].canonicalSeasonNumber, 2);
  assert.equal(merged.seasons[0].part, 1);
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
    repairEpisodeGaps: (episodes, seasonNumber) => episodes.map((episode) => ({
      ...episode,
      season: seasonNumber,
      canonicalSeason: seasonNumber
    })),
    seasonAiredFloor: () => 0,
    extractSeasonNumber: utils.extractSeasonNumber
  });
  vm.runInContext(section(clientSource, "function bakedChainFor(", "// ── TioAnime source integration"), sandbox);
  vm.runInContext(section(clientSource, "function ensureFranchiseShowsInCatalog(", "function validateEpisodeIntegrity("), sandbox);
  vm.runInContext(section(clientSource, "function selectedSeasonIdentity(", "function selectedSeasonLabel("), sandbox);

  const chain = [
    { anilistId: 108465, malId: 39535, title: "Mushoku Tensei: Isekai Ittara Honki Dasu", format: "TV", seasonYear: 2021, episodes: 11, status: "FINISHED" },
    { anilistId: 127720, malId: 45576, title: "Mushoku Tensei: Isekai Ittara Honki Dasu Part 2", format: "TV", seasonYear: 2021, episodes: 12, status: "FINISHED" },
    { anilistId: 146065, malId: 51179, title: "Mushoku Tensei II: Isekai Ittara Honki Dasu", format: "TV", seasonYear: 2023, episodes: 12, status: "FINISHED" },
    {
      anilistId: 166873,
      malId: 55888,
      title: "Mushoku Tensei II: Isekai Ittara Honki Dasu Part 2",
      format: "TV",
      seasonYear: 2024,
      episodes: 12,
      status: "FINISHED",
      image: "https://images.test/season-two-part-two-poster.jpg",
      banner: "https://images.test/season-two-part-two-background.jpg",
      description: "Season two part two description."
    },
    { anilistId: 178789, malId: 59284, title: "Mushoku Tensei III: Isekai Ittara Honki Dasu", format: "TV", seasonYear: 2026, episodes: 14, status: "RELEASING" }
  ];
  const current = {
    id: "source-animeav1-s3",
    anilistId: 178789,
    malId: 59284,
    title: chain[4].title,
    animeAv1Slug: "mushoku-tensei-iii-isekai-ittara-honki-dasu",
    franchiseSeasons: chain,
    canonicalSeasonPart: 1,
    anilistFranchise: {
      groups: [
        {
          seasonNumber: 3,
          partNumber: 1,
          title: "Season 3 Part 1",
          episodeCount: 14,
          items: [{ ...chain[4] }]
        },
        {
          seasonNumber: 3,
          partNumber: 2,
          title: "Season 3 Part 2",
          episodeCount: 12,
          items: [{ ...chain[3] }]
        }
      ]
    },
    // AnimeAV1 publishes each sequel as a standalone page whose top-level
    // episodes still carry local Season 1. Relation data must canonicalize this
    // before detail rendering.
    seasons: [],
    episodes: Array.from({ length: 14 }, (_, index) => ({ season: 1, canonicalSeason: 1, episode: index + 1 }))
  };
  const catalogTwin = {
    id: "animeav1-s3",
    anilistId: 178789,
    malId: 59284,
    title: chain[4].title,
    franchiseSeasons: chain,
    canonicalSeasonPart: 1,
    seasons: []
  };
  // The bootstrap/detail object can follow a full-catalog twin with the same
  // AniList ID. Both must receive the relation identity before episode rows are
  // built; stamping only Array.find()'s first match recreates the production bug.
  state.shows = [catalogTwin, current];
  sandbox.ensureFranchiseShowsInCatalog(current);
  const [canonicalDetailSeason] = sandbox.getDetailSeasons(current);
  assert.equal(catalogTwin.canonicalSeasonNumber, 3);
  assert.equal(current.canonicalSeasonNumber, 3);
  assert.equal(catalogTwin.canonicalSeasonPart, null);
  assert.equal(current.canonicalSeasonPart, null);
  const relatedSeason = state.shows.find((entry) => entry.id === "anilist-166873");
  assert.equal(relatedSeason.anilistId, 166873);
  assert.equal(relatedSeason.malId, 55888);
  assert.equal(relatedSeason.image, "https://images.test/season-two-part-two-poster.jpg");
  assert.equal(relatedSeason.banner, "https://images.test/season-two-part-two-background.jpg");
  assert.equal(relatedSeason.description, "Season two part two description.");
  assert.notEqual(relatedSeason.image, current.image);
  assert.equal(canonicalDetailSeason.season, 3);
  assert.equal(canonicalDetailSeason.part, null);
  assert.deepEqual(
    { ...sandbox.selectedSeasonIdentity(current, {
      season: { season: 3, part: 1, canonicalSeasonPart: 1 },
      episode: { season: 3, episode: 2 }
    }, 2) },
    { seasonNumber: 3, seasonPart: "" }
  );
  assert.equal(canonicalDetailSeason.episodes[0].canonicalSeason, 3);
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

test("related-season direct URLs rebuild from relations and reject corrupt route caches", () => {
  const stale = [{
    savedAt: Date.now(),
    show: {
      id: "anilist-166873",
      anilistId: 178789,
      title: "Mushoku Tensei II: Isekai Ittara Honki Dasu Part 2",
      isFranchiseEntry: true
    }
  }];
  const state = {
    shows: [
      {
        id: "animeav1-colliding-lightweight-row",
        anilistId: 146065,
        title: "Mushoku Tensei II: Isekai Ittara Honki Dasu",
        romajiTitle: "Mushoku Tensei II: Isekai Ittara Honki Dasu Part 2"
      },
      {
        id: "animeav1-mushoku-tensei-ii-isekai-ittara-honki-dasu",
        title: "Mushoku Tensei II: Isekai Ittara Honki Dasu",
        franchiseSeasons: [{
          anilistId: 166873,
          title: "Mushoku Tensei II: Isekai Ittara Honki Dasu Part 2"
        }]
      }
    ],
    addonSections: [],
    av1Shows: new Map()
  };
  const slugify = (value) => String(value || "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const sandbox = vm.createContext({
    state,
    getShowKey: (show = {}) => show.id || show.slug || "show",
    Date,
    Map,
    ROUTE_SLUG_ALIASES: {},
    localStorage: { getItem: () => JSON.stringify(stale), setItem() {} },
    getShowSlug: (show = {}) => slugify(show.slug || show.title || show.id),
    getShowKey: (show = {}) => String(show.id || ""),
    ensureFranchiseShowsInCatalog: (carrier) => {
      const related = carrier.franchiseSeasons[0];
      if (!state.shows.some((show) => show.anilistId === related.anilistId)) {
        state.shows.push({
          id: `anilist-${related.anilistId}`,
          anilistId: related.anilistId,
          title: related.title,
          isFranchiseEntry: true
        });
      }
    }
  });
  vm.runInContext(section(clientSource, "const FRANCHISE_ROUTE_CACHE_KEY", "function ensureNotFoundSection("), sandbox);

  assert.equal(sandbox.readFranchiseRoutes().length, 0);
  const resolved = sandbox.findShowBySlugOrId("mushoku-tensei-ii-isekai-ittara-honki-dasu-part-2");
  assert.equal(resolved.id, "anilist-166873");
  assert.equal(resolved.anilistId, 166873);
});

test("stale Continue Watching seasons reconcile against authoritative catalog seasons", () => {
  const thunder = {
    id: "animeav1-thunder-3",
    anilistId: 207254,
    malId: 62805,
    title: "Thunder 3",
    image: "https://images.test/thunder-3-poster.jpg",
    seasonNumber: 1,
    seasons: [{
      season: 1,
      episodes: [{ episode: 1, title: "SMALL THREE", thumbnail: "https://images.test/thunder-3-e1.jpg" }]
    }]
  };
  const state = { shows: [thunder] };
  const sandbox = vm.createContext({
    state,
    Date,
    findShowForWatchEntry: () => thunder,
    parseEpisodeNumber: (value, fallback = null) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    buildWatchKey: (show, season, episode) => `${show.id}:s${season}:e${episode}`,
    getDetailSeasons: (show) => show.seasons,
    getCanonicalEpisodeNumber: (episode, fallback = null) => Number(episode?.episode ?? fallback),
    getAnimeTrackId: (show) => show.id,
    getShowTitle: (show) => show.title,
    episodeThumb: (episode) => episode.thumbnail,
    sanitizeWatchEntry() {}
  });
  vm.runInContext(
    section(clientSource, "function authoritativeWatchSeason(", "function getContinueWatchingList("),
    sandbox
  );

  const map = {
    "animeav1-thunder-3:s3:e1": {
      episodeKey: "animeav1-thunder-3:s3:e1",
      showId: "animeav1-thunder-3",
      title: "Thunder 3",
      season: 3,
      episode: 1,
      progress: 42,
      lastWatchedAt: 10
    }
  };
  assert.equal(sandbox.reconcileWatchMapSeasons(map), true);
  assert.equal(map["animeav1-thunder-3:s3:e1"], undefined);
  assert.equal(map["animeav1-thunder-3:s1:e1"].season, 1);
  assert.equal(map["animeav1-thunder-3:s1:e1"].progress, 42);
  assert.equal(map["animeav1-thunder-3:s1:e1"].episodeTitle, "SMALL THREE");
  assert.equal(map["animeav1-thunder-3:s1:e1"].thumb, "https://images.test/thunder-3-e1.jpg");
  assert.equal(
    sandbox.authoritativeWatchSeason({ seasons: [{ season: 1 }, { season: 2 }] }, 3),
    3
  );
});
