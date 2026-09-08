import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { CompositeAdultSourceAdapter } = require("../js/adult-source-adapter.js");
const client = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../animetv-server.js", import.meta.url), "utf8");
const section = (source, start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
};

test("catalog joins normalize each title once instead of scanning every pair", () => {
  const adapter = new CompositeAdultSourceAdapter();
  const primary = Array.from({ length: 2000 }, (_, i) => ({ id: `p${i}`, title: `Series ${i} Alpha` }));
  const secondary = Array.from({ length: 1000 }, (_, i) => ({ id: `s${i}`, title: `Series ${i} Alpha` }));
  let calls = 0;
  const keys = adapter._keys.bind(adapter);
  adapter._keys = item => { calls++; return keys(item); };
  const merged = adapter._mergeCatalogs(primary, secondary);
  assert.equal(merged.length, primary.length);
  assert.equal(calls, primary.length + secondary.length);
  assert.deepEqual(merged.map(item => item.id), primary.map(item => item.id));
});

test("indexed matches preserve first-source ordering across conflicting aliases", () => {
  const adapter = new CompositeAdultSourceAdapter();
  const secondary = [
    { id: "early", title: "Other Title", aliases: ["Shared Alias"] },
    { id: "late", title: "Exact Title" },
    { id: "empty", title: "" }
  ];
  adapter._mergeCatalogs([], secondary);
  for (const item of [
    { title: "Exact Title", aliases: ["Shared Alias"] },
    { title: "EXACT TITLE The Animation" },
    { title: "Missing Title" },
    { title: "" }
  ]) {
    const wanted = adapter._keys(item);
    const previous = secondary.find(candidate => adapter._keys(candidate).some(key => wanted.includes(key))) || null;
    assert.equal(adapter._findExactOceanMatch(item), previous);
  }
});

test("a refreshed source replaces the title index and retains unmatched rows", () => {
  const adapter = new CompositeAdultSourceAdapter();
  adapter._mergeCatalogs([], [{ id: "old", title: "Old Series" }]);
  const next = { id: "new", title: "New Series" };
  const merged = adapter._mergeCatalogs([{ id: "primary", title: "Primary Series" }], [next]);
  assert.deepEqual(merged.map(item => item.id), ["primary", "new"]);
  assert.equal(adapter._findExactOceanMatch({ title: "Old Series" }), null);
  assert.equal(adapter._findExactOceanMatch({ title: "New Series" }), next);
});

function loadHarness({ age = 0, empty = false, fail = false } = {}) {
  const items = [{ id: "fixture", isAdult: true }];
  const now = 1_000_000;
  let requests = 0;
  let reads = 0;
  const c = vm.createContext({
    adultCatalogLoadingPromise: null,
    adultCatalogLoadedAt: now - age,
    Date: { now: () => now },
    state: { shows: empty ? [] : items },
    AdultSourceRegistry: { isConfigured: () => true, get: () => ({ name: "Fixture", listLatest: async () => {
      requests++;
      if (fail) throw new Error("Fixture unavailable");
      return items;
    } }) },
    AdultMode: { isEnabled: () => false, isAdultContent: item => item.isAdult === true },
    isolateAdultSourceMetadata: item => item,
    render() {},
    readResponseCache: () => { reads++; return null; },
    readDurableAdultCatalog: async () => null,
    writeDurableAdultCatalog: async () => true,
    CATALOG_CACHE_TTL: 1000,
    RESPONSE_CACHE_PREFIX: "fixture:",
    localStorage: { removeItem() {} },
    console: { warn() {} }
  });
  vm.runInContext(section(client, "async function loadAdultCatalog(", "async function hydrateAdultShowDetails("), c);
  return { c, requests: () => requests, reads: () => reads, now };
}

test("a recent mode switch reuses memory without reading storage or fetching", async () => {
  const h = loadHarness();
  assert.equal((await h.c.loadAdultCatalog()).length, 1);
  assert.equal(h.requests(), 0);
  assert.equal(h.reads(), 0);
});

test("expired, empty and explicitly refreshed catalogs still fetch", async () => {
  for (const [options, force] of [[{ age: 300001 }, false], [{ empty: true }, false], [{}, true]]) {
    const h = loadHarness(options);
    assert.equal((await h.c.loadAdultCatalog(force)).length, 1);
    assert.equal(h.requests(), 1);
    assert.equal(h.c.adultCatalogLoadedAt, h.now);
  }
});

test("a failed refresh keeps existing cards and does not mark stale data fresh", async () => {
  const h = loadHarness({ age: 400000, fail: true });
  const before = h.c.adultCatalogLoadedAt;
  assert.equal((await h.c.loadAdultCatalog()).length, 1);
  assert.equal(h.c.adultCatalogLoadedAt, before);
  assert.equal(h.c.state.shows.length, 1);
});

test("an in-flight addon load cannot replace a newer full catalog", async () => {
  let releaseCatalog;
  const sourceResult = new Promise((resolve) => { releaseCatalog = resolve; });
  const state = {
    customSources: [],
    localSources: [],
    addonSections: [],
    shows: [{ id: "bootstrap" }],
    apiStatus: {}
  };
  const c = vm.createContext({
    state,
    fetch: async () => ({
      ok: true,
      json: async () => ({ sources: [{ id: "fixture", name: "Fixture", enabled: true, endpoint: "/fixture" }] })
    }),
    applySourceOverride: (source) => source,
    fetchExternalCatalogData: async () => sourceResult,
    timedRequest: async (_label, request) => request(),
    mergeShows: (items) => [...new Map(items.map((item) => [item.id, item])).values()],
    markSourceStatus() {},
    renderAddonSections() {},
    renderCarousel() {},
    renderSources() {},
    render() {},
    warmAnimeAv1SlugCatalog() {},
    warmVisibleShowMetadata() {},
    applyAnimeAv1SlugFromMap() {},
    setSourceStatus() {},
    catalogStatusLabel: () => "fixture",
    enrichCatalogAiringData() {},
    _animeAv1SlugTitleMap: null,
    console: { warn() {} }
  });
  vm.runInContext(section(client, "async function loadExternalSources(", "async function fetchLocalMetadataCatalog("), c);

  const loading = c.loadExternalSources();
  await Promise.resolve();
  state.shows = [{ id: "full", franchiseSeasons: [{ anilistId: 1 }, { anilistId: 2 }] }];
  releaseCatalog({ items: [{ id: "addon" }], page: 1, hasMore: false });
  await loading;

  assert.deepEqual(state.shows.map((show) => show.id), ["full", "addon"]);
  assert.equal(state.shows[0].franchiseSeasons.length, 2);
});

test("direct anime and watch routes bypass the deferred homepage catalog path", () => {
  const loadSource = section(client, "async function loadAnimeSources(", "function scheduleLazyAddonCatalogLoad(");
  assert.match(loadSource, /isDirectDetailRoute\s*=\s*\/\^\\\/\(\?:anime\|watch\)\\\/\//);
  assert.match(loadSource, /state\.route === "home" && !isDirectDetailRoute/);
});

test("the AnimeAV1 catalog join index is reused until the catalog changes", () => {
  let titleReads = 0;
  const state = {
    shows: [
      { id: "animeav1-alpha", title: "Alpha", aliases: [] },
      { id: "beta", title: "Beta", aliases: ["Beta Two"] }
    ]
  };
  const c = vm.createContext({
    state,
    normalizeSearchText: (value) => String(value || "").toLowerCase(),
    getShowTitle: (show) => { titleReads += 1; return show.title; }
  });
  vm.runInContext(section(client, "function av1Key(", "function makeAv1OnlyShow("), c);

  const first = c.buildCatalogKeyIndex();
  const firstReads = titleReads;
  const second = c.buildCatalogKeyIndex();
  assert.equal(second, first);
  assert.equal(titleReads, firstReads);

  state.shows = [...state.shows, { id: "gamma", title: "Gamma", aliases: [] }];
  const third = c.buildCatalogKeyIndex();
  assert.notEqual(third, first);
  assert.ok(titleReads > firstReads);
});

test("anime metadata paints the AniList result before the Jikan request settles", () => {
  const hydrate = section(client, "async function hydrateCanonicalAnimeMetadata(", "// Non-blocking TMDB image enrichment.");
  const earlyApply = hydrate.indexOf("applyCanonicalAnimeMetadata(show, { media, jikan: null })");
  const jikanFetch = hydrate.indexOf("/api/jikan/full?id=");
  assert.ok(earlyApply >= 0);
  assert.ok(jikanFetch > earlyApply);
  assert.match(hydrate, /options\.onProgress\?\.\(show\)/);
});

test("open-detail provider completions are coalesced into one render frame", () => {
  const hydrate = section(client, "async function hydrateOpenShowDetails(", "async function hydrateAnime1vEpisodes(");
  assert.match(hydrate, /let refreshQueued = false/);
  assert.match(hydrate, /if \(refreshQueued[^)]*\) return/);
  assert.match(hydrate, /window\.requestAnimationFrame/);
  assert.match(hydrate, /hydrateExtras: false/);
});

test("anime details paint before franchise and episode-list work", async () => {
  const calls = [];
  const animationFrames = [];
  const timers = [];
  const show = {
    id: "fixture",
    title: "Fixture",
    description: "Fixture description",
    animeAv1Slug: "fixture"
  };
  const episode = { episode: 1, providerAnimeSlug: "fixture" };
  const seasons = [{ season: 1, episodes: [episode] }];
  const overlay = { hidden: true };
  const episodeList = {
    hidden: false,
    replaceChildren() { calls.push("clear-episodes"); }
  };
  const c = vm.createContext({
    state: { shows: [show], addonSections: [], av1Shows: new Map() },
    overlay,
    episodeList,
    closeOverlay: { focus() {} },
    window: {
      scrollY: 0,
      pageYOffset: 0,
      setTimeout: (callback) => { timers.push(callback); }
    },
    requestAnimationFrame: (callback) => { animationFrames.push(callback); },
    document: {
      body: { classList: { add() {} } },
      querySelector: (selector) => selector === "#watchDescription"
        ? { textContent: "" }
        : selector === "#fakePlay" ? {} : null
    },
    AdultMode: { isAdultContent: () => false },
    Date,
    Promise,
    getShowKey: (value) => value.id,
    warmSkipTimes() {},
    updateRouteMeta() {},
    setWatchDetailLoading() {},
    watchDetailsReady: () => true,
    pauseVisibleMetadataWarm() {},
    warmAnimeAv1PlaybackIntent() { calls.push("warm-source"); return Promise.resolve(); },
    resetVideoFrame(value) { calls.push(value?.length ? "full-frame" : "opening-frame"); },
    syncWatchHeading(_value, _season, value) { calls.push(value?.length ? "full-heading" : "opening-heading"); },
    setFavoriteButtonState() {},
    isFavoriteShow: () => false,
    getWatchPosterArtwork: () => "",
    getWatchBackdropArtwork: () => "",
    preloadArtworkImage() {},
    preloadCinematicBackdrop() {},
    focusElement() {},
    ensureFranchiseShowsInCatalog() { calls.push("franchise"); },
    getDetailSeasons() { calls.push("seasons"); return seasons; },
    applyOpenTarget(_show, _target, value) {
      calls.push(value === seasons ? "target-shared-seasons" : "target-rebuilt-seasons");
      c.state.activeEpisode = { season: seasons[0], episode };
    },
    isScraperEnabled: () => true,
    attachAnimeAv1Sources() { calls.push("attach-source"); return Promise.resolve(); },
    warmTopEpisodeSources() { calls.push("warm-stream"); },
    renderEpisodeList(_show, options) {
      calls.push(options?.seasons === seasons ? "render-shared-seasons" : "render-rebuilt-seasons");
    },
    resetEpisodePanelScroll() {},
    refreshFocusables() {},
    scheduleSeasonArtworkWarm() {},
    hydrateOpenShowDetails() { calls.push("hydrate"); }
  });
  vm.runInContext(section(client, "async function openShow(", "async function hydrateOpenShowDetails("), c);

  await c.openShow("fixture", {
    skipHistory: true,
    playIntent: true,
    episodeNumber: 1,
    providerAnimeSlug: "fixture"
  });

  assert.equal(overlay.hidden, false);
  assert.deepEqual(calls.slice(0, 4), ["warm-source", "opening-frame", "opening-heading", "clear-episodes"]);
  assert.equal(calls.includes("franchise"), false);
  assert.equal(animationFrames.length, 1);

  animationFrames.shift()();
  assert.equal(calls.includes("franchise"), false, "heavy work must not run inside the pre-paint callback");
  assert.equal(timers.length, 1);

  timers.shift()();
  assert.ok(calls.indexOf("franchise") > calls.indexOf("opening-heading"));
  assert.ok(calls.indexOf("seasons") > calls.indexOf("franchise"));
  assert.ok(calls.includes("target-shared-seasons"));
  assert.ok(calls.includes("render-shared-seasons"));
  assert.ok(calls.indexOf("attach-source") < calls.indexOf("hydrate"));
});

test("catalog replacement enriches the live detail object instead of orphaning it", () => {
  const open = { id: "same", title: "Example", franchiseSeasons: null };
  const fresh = { id: "same", title: "Example", franchiseSeasons: [{ anilistId: 1 }, { anilistId: 2 }] };
  const state = { shows: [open], activeShow: open, activeEpisode: null, playIntent: false, catalogTier: "cached" };
  const c = vm.createContext({
    state,
    AdultMode: { isAdultContent: () => false },
    mergeShows: (items) => items.map((item) => ({ ...item })),
    reconcileAnimeAv1LatestInventory() {},
    scheduleAiringEnrichment() {},
    window: { requestAnimationFrame: (callback) => callback() },
    overlay: { hidden: true }
  });
  vm.runInContext(section(client, "function catalogShowsShareIdentity(", "function regularCatalogSnapshot("), c);
  c.replaceRegularCatalog([fresh], "full");
  assert.equal(state.activeShow, open);
  assert.equal(state.shows[0], open);
  assert.equal(open.franchiseSeasons.length, 2);
  assert.equal(state.catalogTier, "full");
});

test("full catalog arrival rebinds a colliding sequel slug to its relation identity", () => {
  const requestedSlug = "example-season-two-part-two";
  const open = {
    id: "animeav1-lightweight",
    anilistId: 100,
    animeAv1Slug: "example-season-two",
    title: "Example Season Two",
    romajiTitle: "Example Season Two Part Two"
  };
  const carrier = {
    id: "animeav1-example-season-two",
    title: "Example Season Two",
    franchiseSeasons: [{ anilistId: 200, malId: 300, title: "Example Season Two Part Two" }]
  };
  const state = {
    shows: [open],
    activeShow: open,
    activeEpisode: null,
    playIntent: false,
    catalogTier: "cached",
    addonSections: [],
    av1Shows: new Map(),
    currentRouteInfo: { name: "anime", params: { animeId: requestedSlug }, target: {} }
  };
  let reopened = null;
  const slugify = (value) => String(value || "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const c = vm.createContext({
    state,
    AdultMode: { isAdultContent: () => false },
    mergeShows: (items) => items.map((item) => ({ ...item })),
    reconcileAnimeAv1LatestInventory() {},
    scheduleAiringEnrichment() {},
    window: { requestAnimationFrame: (callback) => callback() },
    overlay: { hidden: false },
    ROUTE_SLUG_ALIASES: {},
    getShowSlug: (show = {}) => slugify(show.slug || show.routeSlug || show.romajiTitle || show.title || show.id),
    getShowKey: (show = {}) => String(show.id || ""),
    ensureFranchiseShowsInCatalog: (source) => {
      const related = source.franchiseSeasons[0];
      state.shows.push({
        id: `anilist-${related.anilistId}`,
        anilistId: related.anilistId,
        malId: related.malId,
        animeAv1Slug: "example-season-two",
        title: related.title,
        isFranchiseEntry: true
      });
    },
    updateRouteMeta() {},
    openShow: (id, target) => { reopened = { id, target }; }
  });
  vm.runInContext(section(client, "function findShowBySlugOrId(", "function ensureNotFoundSection("), c);
  vm.runInContext(section(client, "function catalogShowsShareIdentity(", "function regularCatalogSnapshot("), c);
  c.replaceRegularCatalog([open, carrier], "full");
  assert.equal(state.activeShow.id, "anilist-200");
  assert.equal(reopened.id, "anilist-200");
  assert.equal(reopened.target.skipHistory, true);
});

test("a shared provider slug never merges two canonical cours", () => {
  const c = vm.createContext({});
  vm.runInContext(
    section(client, "function catalogShowsShareIdentity(", "function replaceRegularCatalog("),
    c
  );
  const partOne = {
    id: "anilist-100",
    anilistId: 100,
    malId: 150,
    animeAv1Slug: "one-provider-page"
  };
  const partTwo = {
    id: "anilist-200",
    anilistId: 200,
    malId: 250,
    animeAv1Slug: "one-provider-page"
  };
  assert.equal(c.catalogShowsShareIdentity(partOne, partTwo), false);
  assert.equal(c.catalogShowsShareIdentity(partOne, { ...partOne }), true);
  assert.equal(c.catalogShowsShareIdentity(
    { id: "source-a", animeAv1Slug: "one-provider-page" },
    { id: "source-b", animeAv1Slug: "one-provider-page" }
  ), true);
});

test("latest cards use observed source episode counts instead of a TV fallback", () => {
  const c = vm.createContext({});
  vm.runInContext(
    section(client, "function cardEpisodeNumber(", "function getCardTarget("),
    c
  );
  const airing = { status: "RELEASING", sourceEpisodeCount: 9, totalEpisodes: 12 };
  assert.equal(c.cardEpisodeNumber(airing), 9);
  assert.equal(c.cardEpisodeLabel(airing), "EP 9");
  assert.equal(c.cardEpisodeLabel({ status: "RELEASING" }), "EP TBA");
});

test("latest feed reconciles the episode into the canonical show and season", () => {
  const state = { av1LatestAt: Date.parse("2026-09-08T20:00:00.000Z") };
  const c = vm.createContext({
    state,
    Date,
    getShowTitle: (show = {}) => show.title || "",
    av1Key: (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "")
  });
  vm.runInContext(
    section(client, "function animeAv1CatalogSlugForShow(", "function queueLiveSearch("),
    c
  );

  const show = {
    id: "animeav1-current-show",
    title: "Current Show",
    animeAv1Slug: "current-show",
    sourceEpisodeIds: Array.from({ length: 9 }, (_, index) => index + 1),
    sourceEpisodeCount: 9,
    sourcePlayableEpisodeCount: 9,
    sourceInventoryChecked: true,
    latestAiredEp: 9,
    seasons: [{ season: 1, sourceEpisodeCount: 9, episodes: [] }]
  };
  const similarlyNamed = {
    id: "animeav1-current-show-special",
    title: "Current Show Special",
    animeAv1Slug: "current-show-special",
    sourceEpisodeIds: [1],
    sourceEpisodeCount: 1,
    sourcePlayableEpisodeCount: 1,
    sourceInventoryChecked: true
  };

  assert.equal(c.reconcileAnimeAv1LatestInventory([
    { slug: "current-show", title: "Current Show", episode: 10 }
  ], [show, similarlyNamed]), 1);
  assert.deepEqual([...show.sourceEpisodeIds], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(show.sourceEpisodeCount, 10);
  assert.equal(show.latestAiredEp, 10);
  assert.equal(show.seasons[0].sourceEpisodeCount, 10);
  assert.deepEqual([...similarlyNamed.sourceEpisodeIds], [1]);
});

test("published source episodes override only stale future status metadata", () => {
  const c = vm.createContext({ Date });
  vm.runInContext(
    section(client, "function effectiveShowStatus(", "function matchesLibraryAdvancedFilters("),
    c
  );
  assert.equal(c.effectiveShowStatus({ status: "NOT_YET_RELEASED", sourceEpisodeCount: 3 }), "RELEASING");
  assert.equal(c.effectiveShowStatus({ status: "UPCOMING", lastEpisodeAt: "2026-09-01T00:00:00Z" }), "RELEASING");
  assert.equal(c.effectiveShowStatus({ status: "NOT_YET_RELEASED" }), "NOT_YET_RELEASED");
  assert.equal(c.effectiveShowStatus({ status: "FINISHED", sourceEpisodeCount: 12 }), "FINISHED");
});

test("relation-only seasons inherit a marked TMDB franchise id", () => {
  const c = vm.createContext({});
  vm.runInContext(
    section(server, "function buildArtworkIdentityIndex(", "function readScrapedRegularCatalogItems("),
    c
  );
  const artwork = {
    "anilist-108268": {
      anilistId: 108268,
      malId: 39468,
      metadataCover: "season-one.jpg",
      canonicalSeasonNumber: 1,
      meta: { year: 2019, episodes: 14 }
    },
    "anilist-171110": {
      anilistId: 171110,
      malId: 57466,
      tmdbId: 91768,
      canonicalSeasonNumber: 4
    }
  };
  const [older] = c.enrichFranchiseSeasonEntries(
    [{ anilistId: 108268, title: "Honzuki no Gekokujou", episodes: 14 }],
    artwork,
    c.buildArtworkIdentityIndex(artwork),
    artwork["anilist-171110"]
  );
  assert.equal(older.tmdbId, 91768);
  assert.equal(older.tmdbFranchiseFallback, true);
  assert.equal(older.tmdbFranchiseCarrierSeason, 4);
  assert.equal(older.image, "season-one.jpg");
});

test("late episode metadata cannot cross from one canonical season into another", () => {
  const c = vm.createContext({
    mergeAiredEpisodeMetadata() {},
    parseEpisodeNumber: (value) => Number(value),
    SeasonNormalization: { parseTitle: () => ({ seasonNumber: null }) }
  });
  vm.runInContext(
    section(client, "function usesContinuousGlobalEpisodeMetadata(", "function mergeAiredEpisodeMetadata("),
    c
  );
  const show = { anilistId: 200, malId: 300, banner: "", streamingEpisodesByNum: {} };
  const stale = {
    anilistId: 100,
    malId: 150,
    banner: "stale-season.jpg",
    episodes: [{ episode: 2, title: "Wrong season" }]
  };
  assert.equal(c.applyAniListExtras(show, stale), false);
  assert.equal(show.banner, "");
  assert.deepEqual(show.streamingEpisodesByNum, {});

  const matching = {
    anilistId: 200,
    malId: 300,
    banner: "current-season.jpg",
    episodes: [{ episode: 2, title: "Current season" }]
  };
  assert.equal(c.applyAniListExtras(show, matching), true);
  assert.equal(show.banner, "current-season.jpg");
  assert.equal(show.streamingEpisodesByNum[2].title, "Current season");
  assert.match(client, /zenkaitv:show-extras:v3:/);

  const sequel = {
    anilistId: 178789,
    malId: 59193,
    title: "Mushoku Tensei III: Isekai Ittara Honki Dasu",
    seasonNumber: 3,
    canonicalSeasonNumber: 3,
    isFranchiseEntry: true,
    streamingEpisodesByNum: { 2: { title: "Wrong Season 1 title" } }
  };
  assert.equal(c.applyAniListExtras(sequel, {
    anilistId: 178789,
    malId: 59193,
    episodes: [{ episode: 2, title: "Howl, Mad Dog" }]
  }), true);
  assert.equal(sequel.streamingEpisodesBySeasonNum[3][2].title, "Howl, Mad Dog");
  assert.equal(sequel.streamingEpisodesByNum[2].title, "Wrong Season 1 title");
});

test("cached canonical metadata cannot mutate the selected title into another season", () => {
  const c = vm.createContext({});
  vm.runInContext(
    section(client, "function canonicalMetadataIdentityMatches(", "async function hydrateCanonicalAnimeMetadata("),
    c
  );
  const selected = { anilistId: 146065, malId: 51179, title: "Season 2" };
  const staleSeason = {
    media: { id: 178789, idMal: 59193, title: { romaji: "Season 3" } },
    jikan: { mal_id: 59193 }
  };
  assert.equal(c.applyCanonicalAnimeMetadata(selected, staleSeason), false);
  assert.deepEqual(selected, { anilistId: 146065, malId: 51179, title: "Season 2" });
  assert.match(client, /zenkaitv:anime-metadata:v2:/);
});

test("local-only retired files cannot change the production catalog total", async () => {
  const results = [];
  for (const hasRetiredFile of [false, true]) {
    let retiredReads = 0;
    const c = vm.createContext({
      readUnderHentaiCatalog: () => ({ items: [{ slug: "fixture", title: "Fixture" }], excludedForSafety: 1 }),
      loadLiveUnderHentaiCatalog: async () => [],
      readVeoHentaiCatalog: () => { retiredReads++; return { items: hasRetiredFile ? [{ slug: "retired" }] : [] }; },
      prepareVeoHentaiSnapshotItem: item => item,
      decodeUnderHentaiImage: value => value,
      chooseUnderHentaiDisplayImage: value => value,
      getUnderHentaiArtwork: () => ({ screenshots: [], backgroundArtwork: "" }),
      UNDERHENTAI_LIVE_CATALOG_ENABLED: false,
      sendJson: (_response, payload) => results.push(payload),
      log() {}
    });
    vm.runInContext(section(server, "async function handleUnderHentaiCatalog(", "function readXmlValue("), c);
    await c.handleUnderHentaiCatalog(new URL("http://fixture/catalog"), {});
    assert.equal(retiredReads, 0);
  }
  assert.deepEqual(results.map(result => result.count), [1, 1]);
  assert.deepEqual(results.map(result => result.excludedForSafety), [1, 1]);
  assert.match(client, /multi-source-v10/, "retired browser snapshots must not be restored after upgrading");
});
