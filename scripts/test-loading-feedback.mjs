import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const client = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
function section(start, end) {
  const from = client.indexOf(start);
  const to = client.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from);
  return client.slice(from, to);
}

test("install recommendation uses the native PWA event without API work", () => {
  const feature = section(
    "const INSTALL_RECOMMENDATION_DISMISSED_KEY",
    'if ("serviceWorker" in navigator)'
  );
  assert.match(html, /id="installRecommendation"/);
  assert.match(html, /id="installRecommendationAction"/);
  assert.match(styles, /body:not\(\[data-route="home"\]\) \.install-recommendation/);
  assert.match(feature, /beforeinstallprompt/);
  assert.match(feature, /event\.preventDefault\(\)/);
  assert.match(feature, /appinstalled/);
  assert.match(feature, /!window\.ZenkaiNative/);
  assert.match(feature, /display-mode: standalone/);
  assert.doesNotMatch(feature, /\bfetch\s*\(/);
});

test("install recommendation dismissal expires after fourteen days", () => {
  const pureHelpers = section(
    "const INSTALL_RECOMMENDATION_DISMISSED_KEY",
    "function updateInstallRecommendationCopy()"
  );
  const now = 2_000_000_000_000;
  const storage = {
    value: "",
    getItem() { return this.value; }
  };
  const c = vm.createContext({
    window: { matchMedia: () => ({ matches: false }), navigator: {} },
    navigator: { userAgent: "", platform: "", maxTouchPoints: 0 },
    localStorage: storage,
    Date,
    isAndroidTV: () => false
  });
  vm.runInContext(pureHelpers, c);
  storage.value = String(now - 13 * 24 * 60 * 60 * 1000);
  assert.equal(c.installRecommendationDismissedRecently(storage, now), true);
  storage.value = String(now - 15 * 24 * 60 * 60 * 1000);
  assert.equal(c.installRecommendationDismissedRecently(storage, now), false);
});

test("returning Home leaves Continue Watching to the main render", () => {
  const sections = ["continueWatching", "continueWatchingAdult", "latest"].map((id) => {
    const classes = new Set();
    const attributes = {};
    return {
      id,
      classes,
      attributes,
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
        contains: (name) => classes.has(name)
      },
      setAttribute: (name, value) => { attributes[name] = value; }
    };
  });
  let renders = 0;
  const c = vm.createContext({
    state: { route: "home" },
    document: { querySelectorAll: (selector) => selector === "[data-section]" ? sections : [] },
    searchInputTop: null, searchInputLibrary: null, addonSections: null,
    renderContinueWatching: () => { renders += 1; }
  });
  vm.runInContext(section("function syncRouteVisibility()", "function scrollToRoute("), c);
  c.syncRouteVisibility();
  assert.equal(renders, 0);
  c.state.route = "library";
  c.syncRouteVisibility();
  assert.equal(sections[0].attributes["aria-hidden"], "true");
  assert.equal(sections[1].attributes["aria-hidden"], "true");
});

test("Latest Episodes cards target the feed episode, not the catalog episode count", () => {
  const c = vm.createContext({
    parseEpisodeNumber: (value) => Number.isFinite(Number(value)) ? Number(value) : null,
    extractSeasonNumber: () => 1,
    cardEpisodeNumber: (show) => show.sourceEpisodeCount
  });
  vm.runInContext(section("function getCardTarget(", "function cardMeta("), c);
  const target = c.getCardTarget({ _av1Episode: 7, canonicalSeasonNumber: 3, sourceEpisodeCount: 12 });
  assert.equal(target.seasonNumber, 3);
  assert.equal(target.episodeNumber, 7);
});

test("Latest Episodes click opens its selected episode without autoplay", () => {
  const listeners = new Map();
  const opened = [];
  const c = vm.createContext({
    document: { addEventListener: (name, callback) => listeners.set(name, callback) },
    episodeList: null,
    state: { pendingLatestEpisodeReveal: null },
    openShow: (id, target) => opened.push({ id, target }),
    preloadOpenShow: () => {}
  });
  vm.runInContext(section("let _openButtonsDelegated = false;", "function openCarouselShow()"), c);
  c.wireOpenButtons();
  const click = (latest) => {
    const button = {
      dataset: { openShow: "show-1", openSeason: "2", openEpisode: "11", openProviderSlug: "show-1", openProviderEpisode: "11" },
      closest: (selector) => selector === "#latestGrid" && latest ? {} : null
    };
    listeners.get("click")({ target: { closest: () => button }, preventDefault: () => {} });
    return opened.at(-1).target;
  };
  const latest = click(true);
  assert.equal(latest.revealLatestEpisode, true);
  assert.equal(latest.playIntent, false);
  assert.equal(latest.episodeNumber, "11");
  assert.equal(latest.providerEpisodeId, "11");
  assert.equal(click(false).revealLatestEpisode, false);
});

test("latest episode reveal scrolls only the compact detail panel", () => {
  const scrolls = [];
  const overlay = { scrollTop: 175 };
  const panel = {
    scrollTop: 200,
    clientHeight: 1000,
    closest: (selector) => selector === ".watch-overlay" ? overlay : null,
    getBoundingClientRect: () => ({ top: 0 }),
    scrollTo: (options) => scrolls.push(options)
  };
  const selectedRow = {
    closest: (selector) => selector === ".watch-panel" ? panel : null,
    getBoundingClientRect: () => ({ top: 800, height: 80 }),
    scrollIntoView: () => assert.fail("must not scroll both compact ancestors")
  };
  const rows = { querySelector: () => selectedRow };
  const c = vm.createContext({
    state: { pendingLatestEpisodeReveal: "open-1", activeOpenToken: "open-1", playIntent: false },
    episodeList: { querySelector: () => rows },
    getComputedStyle: (node) => ({ overflowY: node === panel ? "auto" : "visible" })
  });
  vm.runInContext(section("let _latestEpisodeRowsObserver = null;", "function observeLatestEpisodeRows()"), c);
  c.revealLatestSelectedEpisode();
  assert.equal(overlay.scrollTop, 0);
  assert.equal(scrolls.length, 1);
  assert.equal(scrolls[0].top, 540);
  assert.equal(scrolls[0].behavior, "instant");
});

test("player Back reveals episodes without scrolling the fixed overlay", () => {
  const scrolls = [];
  const overlay = { scrollTop: 140 };
  const panel = {
    scrollTop: 120,
    getBoundingClientRect: () => ({ top: 20 }),
    closest: (selector) => selector === ".watch-overlay" ? overlay : null,
    scrollTo: (options) => scrolls.push(options)
  };
  const side = {
    getBoundingClientRect: () => ({ top: 520 }),
    closest: (selector) => selector === ".watch-panel" ? panel : null,
    scrollTo: () => assert.fail("the panel is the compact layout scroller")
  };
  const c = vm.createContext({
    episodeList: { closest: (selector) => selector === ".watch-side" ? side : null },
    getComputedStyle: (node) => ({ overflowY: node === panel ? "auto" : "visible" })
  });
  vm.runInContext(section("function revealEpisodeBrowserPanel()", "function showEpisodeListTab("), c);
  c.revealEpisodeBrowserPanel();

  assert.equal(overlay.scrollTop, 0);
  assert.equal(scrolls.length, 1);
  assert.equal(scrolls[0].top, 620);
  assert.equal(scrolls[0].behavior, "auto");
});

test("the visible watch Back button exits playback before closing the anime", () => {
  let exits = 0;
  let closes = 0;
  const c = vm.createContext({
    document: {
      body: { classList: { contains: (name) => name === "player-cinema-open" } },
      querySelector: () => null
    },
    exitPlayerToSources: () => { exits += 1; },
    closeShow: () => { closes += 1; }
  });
  vm.runInContext(section("function handleWatchBack()", "function hideAdultGalleryPanel("), c);
  c.handleWatchBack();
  assert.equal(exits, 1);
  assert.equal(closes, 0);
});

test("fullscreen toggle stays usable on touch browsers and void-returning WebKit", async () => {
  const toasts = [];
  let entered = 0;
  let exited = 0;
  const document = {
    fullscreenElement: null,
    webkitFullscreenElement: null,
    webkitExitFullscreen: () => { exited += 1; }
  };
  const window = {
    innerWidth: 390,
    innerHeight: 844,
    outerWidth: 390,
    outerHeight: 844,
    matchMedia: (query) => ({ matches: query === "(pointer: coarse)" })
  };
  const c = vm.createContext({
    document,
    window,
    navigator: { maxTouchPoints: 5 },
    screen: { width: 390, height: 844 },
    showToast: (message) => toasts.push(message)
  });
  vm.runInContext(section("function isApiFullscreen()", "function getCleanHostName("), c);

  assert.equal(c.isBrowserNativeFullscreen(), false);
  await c.toggleNativeFullscreen({ webkitRequestFullscreen: () => { entered += 1; } });
  assert.equal(entered, 1);
  assert.deepEqual(toasts, []);

  document.webkitFullscreenElement = {};
  await c.toggleNativeFullscreen();
  assert.equal(exited, 1);
  assert.deepEqual(toasts, []);
});

test("Continue Watching sanitizes only the visible saved entries", () => {
  const map = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [String(index), {
    episodeKey: String(index), lastWatchedAt: index, progress: 20
  }]));
  let sanitized = 0;
  const c = vm.createContext({
    getWatchMap: () => map,
    reconcileWatchMapSeasons: () => false,
    persistWatchMap: () => {},
    isResumableWatchEntry: () => true,
    sanitizeWatchEntry: () => { sanitized += 1; }
  });
  vm.runInContext(section("function getContinueWatchingList(", "let _cwTimer"), c);
  const items = c.getContinueWatchingList(20);
  assert.equal(items.length, 20);
  assert.equal(items[0].episodeKey, "999");
  assert.equal(sanitized, 20);
});

test("indexed saved-entry matching preserves row, canonical ID, and title precedence", () => {
  const shows = [
    { id: "row-a", anilistId: 10, malId: 20, title: "First" },
    { id: "row-b", anilistId: 11, malId: 21, title: "Second" },
    { id: "row-c", anilistId: 10, malId: 22, title: "First" }
  ];
  const c = vm.createContext({
    state: { shows },
    normalizeTitle: (value) => String(value).toLowerCase(),
    getShowTitle: (show) => show.title
  });
  vm.runInContext(section("function buildWatchShowLookup(", "function resumeFromContinue("), c);
  const lookup = c.buildWatchShowLookup(shows);
  for (const entry of [
    { showId: "row-b", anilistId: 10 },
    { showId: "stale", anilistId: 10 },
    { showId: "stale", malId: 21 },
    { showId: "20" },
    { showId: "stale", title: "First" }
  ]) {
    assert.equal(c.findShowForWatchEntry(entry, lookup), c.findShowForWatchEntry(entry));
  }
});

test("artwork stays on one selected high-quality file through metadata refreshes", () => {
  const failed = new Set();
  const c = vm.createContext({
    isArtworkLowQuality: () => false,
    ImageResolver: { isImageFailed: url => failed.has(url) }
  });
  vm.runInContext(section("const stableArtworkChoices =", "function getCardPosterCandidates"), c);
  const choose = (show, urls, role = "poster") => c.stableArtworkCandidates(show, urls, role)[0];
  assert.equal(choose({ id: "show-s1" }, ["hq-original", "backup"]), "hq-original");
  assert.equal(choose({ id: "show-s1", tmdbId: 10 }, ["different-poster"]), "hq-original");
  assert.equal(choose({ id: "show-s2" }, ["season-two"]), "season-two");
  assert.equal(choose({ id: "show-s1" }, ["wide-hq"], "backdrop"), "wide-hq");
  failed.add("hq-original");
  assert.equal(choose({ id: "show-s1" }, ["hq-original", "backup"]), "backup");
  assert.equal(choose({ id: "bootstrap-one", anilistId: 1 }, ["canonical-art"]), "canonical-art");
  assert.equal(choose({ id: "provider-one", anilistId: 1 }, ["different-art"]), "canonical-art");
});

test("a decoded old hero cannot reveal or save over a new slide", async () => {
  const render = section("function renderCarousel()", "let _carouselDotsHtml");
  const start = render.indexOf("const revealBackdrop = () =>");
  const end = render.indexOf("carouselBackdropImage.onload =", start);
  let finish;
  let current = "slide-one";
  const events = [];
  const c = vm.createContext({
    art: "https://cdn.example/slide-one.jpg", deliveredArt: "slide-one", show: { id: "one" }, hasLandscapeBanner: true,
    carouselBackdropImage: { dataset: {}, naturalWidth: 1920, getAttribute: () => current, decode: () => new Promise(resolve => { finish = resolve; }) },
    carouselStage: { classList: { remove: () => events.push("reveal") } },
    clearCarouselBlurPlaceholder: () => events.push("clear"),
    signalAppLoader: () => events.push("signal"), writeHeroMemo: () => events.push("save"), getShowTitle: () => "One"
  });
  vm.runInContext(render.slice(start, end) + "revealBackdrop();", c);
  current = "slide-two";
  finish();
  await Promise.resolve();
  assert.deepEqual(events, []);
  vm.runInContext("revealBackdrop();", c);
  assert.deepEqual(events, []);
  current = "slide-one";
  vm.runInContext("revealBackdrop();", c);
  finish();
  await Promise.resolve();
  assert.deepEqual(events, ["reveal", "clear", "signal", "save"]);
});

test("same-slide metadata refreshes retain the pending blurred preview", () => {
  const render = section("function renderCarousel()", "let _carouselDotsHtml");
  const start = render.indexOf("if (_carouselPreviewShowId !==");
  const end = render.indexOf("const hiResArt =", start);
  assert.ok(start > 0 && end > start);
  let resets = 0;
  const c = vm.createContext({ show: { id: "one" }, _carouselPreviewShowId: "one", artworkShowIdentity: show => show.id, resetCarouselBlurPlaceholder: () => resets++ });
  vm.runInContext(render.slice(start, end), c);
  assert.equal(resets, 0);
  c.show = { id: "two" };
  vm.runInContext(render.slice(start, end), c);
  assert.equal(resets, 1);
});

function scheduler() {
  let now = 0;
  let id = 0;
  const timers = new Map();
  const frames = [];
  const idle = [];
  return {
    window: {
      setTimeout(fn, delay = 0) { timers.set(++id, { fn, at: now + delay }); return id; },
      clearTimeout(key) { timers.delete(key); },
      requestAnimationFrame(fn) { frames.push(fn); },
      requestIdleCallback(fn) { idle.push(fn); }
    },
    performance: { now: () => now },
    frame() { frames.splice(0).forEach(fn => fn()); },
    idle() { idle.splice(0).forEach(fn => fn()); },
    async advance(ms) {
      now += ms;
      for (const [key, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(key);
        timer.fn();
      }
      await Promise.resolve();
      await Promise.resolve();
    }
  };
}

function modeHarness(cached = false) {
  const clock = scheduler();
  const events = [];
  let enabled = true;
  let finish;
  const load = new Promise(resolve => { finish = resolve; });
  const c = vm.createContext({
    ...clock,
    state: { isLoadingCatalog: false },
    console: { warn() {} },
    AdultMode: { isEnabled: () => enabled },
    resetCatalogModeControls: () => events.push("reset"),
    syncAdultModeChrome: () => events.push("theme"),
    catalogShows: () => cached ? [{ id: "fixture" }] : [],
    refreshCatalogStatus: () => events.push("status"),
    renderNow: () => events.push("paint"),
    render: () => events.push("refresh"),
    loadAdultCatalog: () => { events.push("load"); return load; }
  });
  vm.runInContext(section("let catalogModeChangeGeneration =", "// Restore the saved 18+ mode"), c);
  return { c, clock, events, finish, disable: () => { enabled = false; c.handleCatalogModeChange(false); } };
}

test("mode switches paint cached cards before any catalog refresh starts", async () => {
  const h = modeHarness(true);
  h.c.handleCatalogModeChange(true);
  assert.deepEqual(h.events, ["reset", "theme", "status", "paint"]);
  assert.equal(h.c.state.isLoadingCatalog, false);
  h.clock.frame();
  assert.equal(h.events.includes("load"), false);
  await h.clock.advance(0);
  assert.equal(h.events.at(-1), "load");
  h.finish();
  await h.clock.advance(0);
  assert.equal(h.events.at(-1), "refresh");
});

test("a cold mode switch renders loading placeholders immediately", async () => {
  const h = modeHarness();
  h.c.handleCatalogModeChange(true);
  assert.equal(h.c.state.isLoadingCatalog, true);
  assert.equal(h.events.at(-1), "paint");
  h.clock.frame();
  await h.clock.advance(0);
  h.finish();
  await h.clock.advance(0);
  assert.equal(h.c.state.isLoadingCatalog, false);
});

test("switching back cancels a queued mode refresh", async () => {
  const h = modeHarness(true);
  h.c.handleCatalogModeChange(true);
  h.disable();
  h.clock.frame();
  await h.clock.advance(0);
  assert.equal(h.events.includes("load"), false);
});

test("an old refresh cannot repaint the newly selected mode", async () => {
  const h = modeHarness(true);
  h.c.handleCatalogModeChange(true);
  h.clock.frame();
  await h.clock.advance(0);
  h.disable();
  const count = h.events.length;
  h.finish();
  await h.clock.advance(0);
  assert.equal(h.events.length, count);
});

function libraryHarness() {
  const clock = scheduler();
  const classes = new Set();
  const c = vm.createContext({
    ...clock,
    state: { route: "library", libraryQuerySig: "regular", libraryVisibleLimit: 84 },
    LIBRARY_RENDER_STEP: 28,
    libraryGrid: { dataset: { hasMore: "true", totalCards: "140", visibleCards: "84" },
      scrollWidth: 1400, clientWidth: 1000, scrollLeft: 400,
      setAttribute(key, value) { this[key] = value; } },
    libraryAutoLoader: { hidden: true, classList: { add: key => classes.add(key), remove: key => classes.delete(key) } },
    libraryAutoLoaderStatus: { textContent: "" },
    renderNow: () => {}
  });
  vm.runInContext(section("let libraryAutoLoadObserver =", "function observeLibraryScrollSentinel("), c);
  return { c, clock, classes };
}

test("library feedback paints before appending and never delays the next batch", async () => {
  const { c, clock, classes } = libraryHarness();
  c.requestNextLibraryBatch();
  assert.equal(c.libraryAutoLoader.hidden, false);
  assert.equal(c.libraryAutoLoaderStatus.textContent, "Loading titles");
  assert.equal(c.libraryGrid["aria-busy"], "true");
  assert.equal(c.state.libraryVisibleLimit, 84);
  c.requestNextLibraryBatch();
  clock.frame();
  clock.idle();
  assert.equal(c.state.libraryVisibleLimit, 112);
  assert.equal(c.libraryGrid["aria-busy"], "false");
  assert.equal(c.libraryAutoLoaderStatus.textContent, "Titles ready");
  assert.equal(classes.has("is-complete"), true);
  await clock.advance(449);
  assert.equal(c.libraryAutoLoader.hidden, false);
  c.setLibraryAutoLoadPending(false);
  await clock.advance(1);
  assert.equal(c.libraryAutoLoader.hidden, true);
});

test("changing filters cancels stale queued batches and their indicator", () => {
  const { c, clock } = libraryHarness();
  c.requestNextLibraryBatch();
  clock.frame();
  c.cancelLibraryAutoLoad();
  c.state.libraryQuerySig = "new-filter";
  clock.idle();
  assert.equal(c.state.libraryVisibleLimit, 84);
  assert.equal(c.libraryAutoLoader.hidden, true);
  assert.equal(c.libraryGrid["aria-busy"], "false");
});

test("scrolling still requests a batch when the intersection callback fired too early", () => {
  const { c, clock } = libraryHarness();
  let intersect;
  let scroll;
  const Observer = class {
    constructor(callback) { intersect = callback; }
    observe() {}
  };
  c.IntersectionObserver = Observer;
  c.window.IntersectionObserver = Observer;
  c.libraryGrid.addEventListener = (type, listener) => { if (type === "scroll") scroll = listener; };
  c.libraryGrid.scrollWidth = 3000;
  c.libraryGrid.scrollLeft = 0;
  vm.runInContext(section("function observeLibraryScrollSentinel(", "function ensureLibraryScrollSentinel("), c);
  c.observeLibraryScrollSentinel({});
  intersect([{ isIntersecting: true }]);
  assert.equal(c.libraryAutoLoader.hidden, true);
  assert.equal(typeof scroll, "function");
  c.libraryGrid.scrollLeft = 1900;
  scroll();
  clock.frame();
  assert.equal(c.libraryAutoLoader.hidden, false);
  clock.frame();
  clock.idle();
  assert.equal(c.state.libraryVisibleLimit, 112);
});

test("the last batch finishes with no extra requests", async () => {
  const { c, clock } = libraryHarness();
  c.libraryGrid.dataset.visibleCards = "130";
  c.renderNow = () => { c.libraryGrid.dataset.hasMore = "false"; };
  c.requestNextLibraryBatch();
  clock.frame();
  clock.idle();
  assert.equal(c.state.libraryVisibleLimit, 140);
  await clock.advance(450);
  c.requestNextLibraryBatch();
  assert.equal(c.libraryAutoLoader.hidden, true);
});

test("loading feedback respects the app's reduced-motion preference", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /body\.reduce-motion \.library-auto-loader-track > span\s*\{[^}]*animation: none/);
});

test("release posters share the cached-image ready and fallback lifecycle", () => {
  const client = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  const releases = readFileSync(new URL("../js/adult-releases.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(client, /class="schedule-thumb-img release-poster-img"/);
  assert.match(client, /\.thumb-poster, \.ep-thumb-img, \.release-poster-img/);
  assert.match(client, /syncCompletedArtwork\(scheduleList\)/);
  assert.match(releases, /class="release-poster-img"/);
  assert.match(releases, /data-image-fallbacks=/);
  assert.doesNotMatch(releases, /data-fallback=/);
  assert.match(releases, /let cardIndex = 0;[\s\S]*card\(entry, cardIndex\+\+, shows\)/);
  assert.match(releases, /view\.context\.syncArtwork\?\.\(result\)/);
  assert.match(css, /\.release-poster img\.img-ready\s*\{[^}]*opacity: 1/);
});

test("carousel loading conceals incomplete artwork and its selector", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(html, /class="carousel-wait" aria-hidden="true"/);
  assert.match(css, /\.carousel-wait\s*\{[^}]*box-sizing: border-box;/);
  assert.match(css, /\.carousel-stage:is\(\.is-loading, \.is-backdrop-loading\) \.carousel-wait\s*\{[^}]*visibility: visible;[^}]*opacity: 1;/);
  assert.match(css, /\.carousel-stage\.is-backdrop-loading \.carousel-indicators\s*\{[^}]*visibility: hidden;[^}]*opacity: 0;/);
  assert.match(css, /body\.reduce-motion \.carousel-wait-track\s*\{[^}]*animation: none !important;/);
  assert.match(css, /\.carousel-wait-mark\s*\{[^}]*display: none;/);
  assert.match(css, /\.carousel-wait-track\s*\{[^}]*position: absolute;[^}]*bottom: 0;[^}]*width: 100%;/);
});

test("the anime detail view has visible, reduced-motion-safe hydration feedback", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(html, /id="watchDetailProgress"[^>]*role="status"[^>]*hidden/);
  assert.match(css, /\.watch-detail-progress > span:first-child[\s\S]*?watch-detail-progress-slide/);
  assert.match(css, /\.watch-overlay\.is-hydrating-details \.watch-summary:empty::after/);
  assert.match(css, /body\.reduce-motion \.watch-detail-progress[\s\S]*?animation: none/);
});

test("the adult phone gallery uses the watch panel scroller and compact tabs", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const tabs = css.match(/\.watch-overlay \.watch-side #episodeList\.is-adult-detail \.detail-tabs\.detail-tabs-2\s*\{[^}]+\}/g)?.at(-1) || "";
  assert.match(tabs, /margin:\s*0\.35rem 0\.25rem 0\.7rem/);
  assert.match(tabs, /background:\s*#171a2b/);
  assert.match(tabs, /backdrop-filter:\s*none/);
  assert.doesNotMatch(tabs, /margin:\s*0\s+-/);
  assert.match(css, /#episodeList\.is-adult-detail \.adult-detail-gallery\s*\{[^}]*overflow:\s*visible;[^}]*overscroll-behavior:\s*auto;[^}]*touch-action:\s*pan-y;/);
  assert.match(css, /#episodeList\.is-adult-detail \.adult-detail-gallery-group,[\s\S]*?#episodeList\.is-adult-detail \.adult-detail-gallery-thumb\s*\{[^}]*overflow:\s*clip;/);
});

// The splash coordinator, run against a fake clock that starts at time origin.
function splashHarness({ route = "home", pathname = "/" } = {}) {
  const clock = scheduler();
  const loader = {
    hidden: 0,
    removed: 0,
    classList: { add(name) { if (name === "is-hidden") loader.hidden += 1; } },
    remove() { loader.removed += 1; }
  };
  const c = vm.createContext({
    ...clock,
    appLoader: loader,
    document: { body: { dataset: { route } } },
    location: { pathname }
  });
  vm.runInContext(
    section("const APP_LOADER_MIN_MS", "const latestGrid")
      + section("function hideAppLoader()", "function setWatchDetailLoading("),
    c
  );
  return { c, clock, loader };
}

test("the splash holds for the hero on home, between a floor and a hard ceiling", async () => {
  // Nothing ever ready: it stays up, then the ceiling takes it down regardless.
  const stuck = splashHarness();
  stuck.c.maybeHideAppLoader();
  await stuck.clock.advance(3990);
  assert.equal(stuck.loader.hidden, 0);
  await stuck.clock.advance(10);
  assert.equal(stuck.loader.hidden, 1);

  // Ready early: held to the floor rather than flashed away.
  const early = splashHarness();
  await early.clock.advance(300);
  early.c.signalAppLoader("hero");
  await early.clock.advance(690);
  assert.equal(early.loader.hidden, 0);
  await early.clock.advance(10);
  assert.equal(early.loader.hidden, 1);

  // Past the floor a catalogue alone is not enough on home; the hero is.
  const late = splashHarness();
  await late.clock.advance(1500);
  late.c.signalAppLoader("catalog");
  assert.equal(late.loader.hidden, 0);
  late.c.signalAppLoader("hero");
  assert.equal(late.loader.hidden, 1);

  // Idempotent: later signals and the backstop never run the hide twice.
  late.c.signalAppLoader("hero");
  late.c.hideAppLoader();
  await late.clock.advance(5000);
  assert.equal(late.loader.hidden, 1);
  assert.equal(late.loader.removed, 1);
});

test("routes without a hero lift the splash on the first catalogue, deep links included", async () => {
  for (const [route, pathname] of [["schedule", "/schedule"], ["home", "/anime/example-show"]]) {
    const h = splashHarness({ route, pathname });
    await h.clock.advance(1200);
    h.c.signalAppLoader("catalog");
    assert.equal(h.loader.hidden, 1, `${pathname} must not wait on the carousel`);
  }
  // The Android app's asset fallback loads .../index.html, which is the home page.
  for (const pathname of ["/index.html", "/android_asset/index.html"]) {
    const h = splashHarness({ pathname });
    await h.clock.advance(1200);
    h.c.signalAppLoader("catalog");
    assert.equal(h.loader.hidden, 0, `${pathname} is home, so it waits for the hero`);
    h.c.signalAppLoader("hero");
    assert.equal(h.loader.hidden, 1);
  }
});

test("startup no longer drops the splash before there is anything to show", () => {
  const load = section("async function loadAnimeSources(", "function scheduleLazyAddonCatalogLoad(");
  assert.doesNotMatch(load, /\bhideAppLoader\(\)/);
  assert.match(load, /maybeHideAppLoader\(\)/);
  assert.doesNotMatch(client, /setTimeout\(hideAppLoader, 850\)/);
  assert.match(client, /window\.setTimeout\(hideAppLoader, APP_LOADER_MAX_MS\);/);
  assert.match(section("function replaceRegularCatalog(", "function regularCatalogSnapshot("), /signalAppLoader\("catalog"\)/);
  const render = section("function renderCarousel()", "let _carouselDotsHtml");
  assert.match(render, /const reveal = \(\) => \{[\s\S]*?clearCarouselBlurPlaceholder\(\);[\s\S]*?signalAppLoader\("hero"\);/);
  assert.match(render, /else if \(art && carouselBackdropImage\.dataset\.decodedSrc === deliveredArt\) \{[\s\S]*?signalAppLoader\("hero"\);/);
});

test("a catalog repaint cannot reveal a completed image before decode commits it", () => {
  const restore = section("(function restoreHeroBackdrop() {", "// The splash used to");
  const render = section("function renderCarousel()", "let _carouselDotsHtml");
  const preview = section("function showCarouselBlurPlaceholder(", "function renderCarousel()");

  assert.match(restore, /dataset\.decodedSrc = memo\.src;[\s\S]*?classList\.remove\("is-backdrop-loading"\)/);
  assert.match(render, /dataset\.decodedSrc = deliveredArt;[\s\S]*?classList\.remove\("is-backdrop-loading"\)/);
  assert.doesNotMatch(render, /carouselBackdropImage\.complete && carouselBackdropImage\.naturalWidth > 0/);
  assert.match(render, /else if \(art && carouselBackdropImage\.dataset\.decodedSrc === deliveredArt\)/);
  assert.match(render, /else if \(art && !memoStillBetter\) \{[\s\S]*?classList\.add\("is-backdrop-loading"\)/);
  assert.match(preview, /dataset\.decodedSrc === deliveredArt/);
  assert.doesNotMatch(preview, /carouselBackdropImage\.complete/);
});

// The carousel blur-preview helpers, with a fake stage, image and Image().
function blurHarness() {
  const clock = scheduler();
  const classes = new Set();
  const previews = [];
  const signals = [];
  const img = { dataset: {}, src: "", complete: false, naturalWidth: 0, getAttribute(name) { return name === "src" ? this.src : null; } };
  const c = vm.createContext({
    ...clock,
    carouselStage: { classList: { add: (n) => classes.add(n), remove: (n) => classes.delete(n), contains: (n) => classes.has(n) } },
    carouselBackdropBlur: { style: { backgroundImage: "" } },
    carouselBackdropImage: img,
    imageDeliveryUrl: (url, width, quality) => `/api/image?src=${encodeURIComponent(url)}&w=${width}&q=${quality}`,
    signalAppLoader: (name) => signals.push(name),
    Image: class { constructor() { previews.push(this); } }
  });
  const decl = client.match(/const CAROUSEL_BLUR_WIDTH = \d+;\s*const CAROUSEL_BLUR_QUALITY = \d+;\s*let _carouselBlurToken = 0;/);
  assert.ok(decl, "blur preview constants are declared together");
  vm.runInContext(decl[0] + section("function carouselBlurSourceUrl(", "function renderCarousel()"), c);
  return { c, clock, classes, previews, signals, img, blur: c.carouselBackdropBlur };
}

test("the carousel shows a small blurred preview only while its full image loads", async () => {
  const art = "https://cdn.example/hero.jpg";
  const delivered = "/api/image?src=hero&w=1920&q=92";
  const h = blurHarness();
  h.img.src = delivered;
  h.classes.add("is-backdrop-loading");
  h.c.showCarouselBlurPlaceholder(art, delivered);
  assert.equal(h.previews.length, 1);
  const width = Number(new URLSearchParams(h.previews[0].src.split("?")[1]).get("w"));
  assert.ok(width > 0 && width <= 342, "the preview is a small file, never the full-resolution one");
  assert.equal(h.classes.has("has-blur-placeholder"), false, "nothing shows until the preview has loaded");
  h.previews[0].onload();
  assert.equal(h.classes.has("has-blur-placeholder"), true);
  assert.ok(h.blur.style.backgroundImage.includes(h.previews[0].src));
  assert.deepEqual(h.signals, ["hero"]);

  // The full image is revealed: the preview goes once the wait surface has
  // faded, and its image is then released.
  h.classes.delete("is-backdrop-loading");
  h.c.clearCarouselBlurPlaceholder();
  assert.equal(h.classes.has("has-blur-placeholder"), true);
  await h.clock.advance(200);
  assert.equal(h.classes.has("has-blur-placeholder"), false);
  assert.notEqual(h.blur.style.backgroundImage, "");
  await h.clock.advance(420);
  assert.equal(h.blur.style.backgroundImage, "");
});

test("artwork lookup never substitutes a different provider image before the final backdrop", () => {
  const render = section("function renderCarousel()", "let _carouselDotsHtml");
  const lookupWait = render.slice(
    render.indexOf("} else if (!art && !heroMemoActive) {"),
    render.indexOf("if (art) {", render.indexOf("} else if (!art && !heroMemoActive) {"))
  );
  assert.doesNotMatch(lookupWait, /carouselArtworkOrPoster\(show\)/);
  assert.doesNotMatch(lookupWait, /showCarouselBlurPlaceholder\(/);
  assert.match(lookupWait, /carouselBackdropImage\.src = emptyBackdrop/);
});

test("regular carousel artwork waits for canonical TMDB resolution before using a fallback", () => {
  const c = vm.createContext({
    state: { catalogTier: "full" },
    isAdultCatalogShow: show => Boolean(show.adult),
    hqImage: value => value,
    isArtworkLowQuality: () => false,
    pickImage: values => values.find(Boolean) || "",
    stableArtworkCandidates: (_show, values) => values,
    carouselArtworkOrPoster: show => show.highQualityBackground || show.banner || show.image || ""
  });
  vm.runInContext(section("function carouselResolvedBackdropArtwork(", "const CAROUSEL_PROVISIONAL_HOLD_MS"), c);

  const sourceBanner = "https://source.example/soft-banner.jpg";
  const tmdbBackdrop = "https://image.tmdb.org/t/p/original/final.jpg";
  assert.equal(c.carouselResolvedBackdropArtwork({ highQualityBackground: sourceBanner }), "");
  assert.equal(c.carouselResolvedBackdropArtwork({
    highQualityBackground: sourceBanner,
    _carouselResolveTried: true,
    _carouselResolvePending: true
  }), "", "a rerender during the lookup must not expose the source banner");
  assert.equal(c.carouselResolvedBackdropArtwork({
    highQualityBackground: sourceBanner,
    _carouselResolveTried: true,
    _carouselResolvePending: false
  }), sourceBanner, "a settled no-match may use one stable fallback");
  c.state.catalogTier = "cache";
  assert.equal(c.carouselResolvedBackdropArtwork({
    highQualityBackground: sourceBanner,
    _tmdbResolved: true,
    _carouselResolveTried: true,
    _carouselResolvePending: false
  }), "", "a provisional catalog cannot promote provider art to a sharp final image");
  c.state.catalogTier = "full";
  assert.equal(c.carouselResolvedBackdropArtwork({
    highQualityBackground: sourceBanner,
    tmdbBackdrop
  }), tmdbBackdrop);
  assert.equal(c.carouselResolvedBackdropArtwork({
    adult: true,
    highQualityBackground: sourceBanner
  }), sourceBanner, "adult source-curated backdrops remain canonical");
});

test("a late or stale carousel preview never flashes over the real image", async () => {
  const art = "https://cdn.example/hero.jpg";
  const delivered = "/api/image?src=hero&w=1920&q=92";
  const next = "/api/image?src=next&w=1920&q=92";

  // A complete response which is still decoding must retain the blurred layer.
  const decoding = blurHarness();
  decoding.img.src = delivered;
  decoding.img.complete = true;
  decoding.img.naturalWidth = 1920;
  decoding.classes.add("is-backdrop-loading");
  decoding.c.showCarouselBlurPlaceholder(art, delivered);
  decoding.previews[0].onload();
  assert.equal(decoding.classes.has("has-blur-placeholder"), true);

  // Lands after the full image already decoded and was committed.
  const late = blurHarness();
  late.img.src = delivered;
  late.classes.add("is-backdrop-loading");
  late.c.showCarouselBlurPlaceholder(art, delivered);
  late.img.complete = true;
  late.img.naturalWidth = 1920;
  late.img.dataset.decodedSrc = delivered;
  late.previews[0].onload();
  assert.equal(late.classes.has("has-blur-placeholder"), false);

  // Lands after the carousel moved to another slide.
  const moved = blurHarness();
  moved.img.src = delivered;
  moved.classes.add("is-backdrop-loading");
  moved.c.showCarouselBlurPlaceholder(art, delivered);
  moved.img.src = next;
  moved.c.showCarouselBlurPlaceholder("https://cdn.example/next.jpg", next);
  moved.previews[0].onload();
  assert.equal(moved.classes.has("has-blur-placeholder"), false);
  assert.equal(moved.blur.style.backgroundImage, "");
  moved.previews[1].onload();
  assert.equal(moved.classes.has("has-blur-placeholder"), true);
  assert.match(moved.blur.style.backgroundImage, /next/);

  // A clear still pending from the previous slide must not wipe the next one's preview.
  const again = blurHarness();
  again.img.src = delivered;
  again.classes.add("is-backdrop-loading");
  again.c.showCarouselBlurPlaceholder(art, delivered);
  again.previews[0].onload();
  again.classes.delete("is-backdrop-loading");
  again.c.clearCarouselBlurPlaceholder();
  again.img.src = next;
  again.classes.add("is-backdrop-loading");
  again.c.showCarouselBlurPlaceholder("https://cdn.example/next.jpg", next);
  again.previews[1].onload();
  await again.clock.advance(1000);
  assert.equal(again.classes.has("has-blur-placeholder"), true);
  assert.match(again.blur.style.backgroundImage, /next/);

  // No preview at all when it would be the very file already being fetched.
  const same = blurHarness();
  const sameArt = "https://cdn.example/a.jpg";
  same.c.showCarouselBlurPlaceholder(sameArt, same.c.carouselBlurSourceUrl(sameArt));
  assert.equal(same.previews.length, 0);
});

test("the carousel blur layer sits under the sharp image, is inert, and never uses the full file", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(html, /id="carouselBackdrop"><\/div>\s*<div class="carousel-backdrop-blur" id="carouselBackdropBlur" aria-hidden="true"><\/div>\s*<img class="carousel-backdrop-image"/);
  assert.match(css, /\.carousel-backdrop-blur\s*\{[^}]*opacity: 0;[^}]*visibility: hidden;[^}]*pointer-events: none;/);
  assert.match(css, /\.carousel-stage\.has-blur-placeholder \.carousel-backdrop-blur\s*\{[^}]*opacity: 1;[^}]*visibility: visible;/);
  assert.match(css, /\.carousel-stage\.has-blur-placeholder \.carousel-wait\s*\{[^}]*background: transparent;/);
  assert.match(css, /body\.reduce-motion \.carousel-backdrop-blur\s*\{[^}]*transition: none !important;/);
  assert.doesNotMatch(section("function carouselBlurSourceUrl(", "function renderCarousel()"), /cinematicBackdropUrl/);
  const render = section("function renderCarousel()", "let _carouselDotsHtml");
  assert.match(render, /carouselBackdropImage\.src = deliveredArt;[\s\S]*?showCarouselBlurPlaceholder\(art, deliveredArt\);/);
  assert.doesNotMatch(render, /showCarouselBlurPlaceholder\(pendingArt/);
});

test("manual carousel selection warms only the intended final-art preview and hero", () => {
  const render = section("function renderCarousel()", "let _carouselDotsHtml");
  const indicators = section("function carouselIndicatorArtwork(", "function simpleCarouselText(");
  assert.match(render, /const hiResArt = carouselResolvedBackdropArtwork\(show\);/);
  assert.match(indicators, /return getCardPosterCandidates\(show\)\[0\] \|\| carouselArtworkOrPoster\(show\);/);
  assert.match(indicators, /imageDeliveryUrl\(carouselIndicatorArtwork\(show\), 180, 72\)/);
  assert.match(indicators, /preloadArtworkImage\(url, 180, 72, false\)/);
  assert.match(indicators, /pointerenter[\s\S]*?focus[\s\S]*?pointerdown/);
  assert.match(indicators, /warmCarouselIndicatorTarget\(targetShow, true\);[\s\S]*?state\.carouselIndex/);
  assert.match(indicators, /const art = carouselResolvedBackdropArtwork\(show\);[\s\S]*?preloadArtworkImage\(art, CAROUSEL_BLUR_WIDTH, CAROUSEL_BLUR_QUALITY, true\);[\s\S]*?preloadCinematicBackdrop\(art, true\);/);
});

test("cached latest-feed artwork stays provisional until the full catalog settles", () => {
  const load = section("async function loadAnimeSources()", "function scheduleLazyAddonCatalogLoad(");
  const apply = section("function applyServerCatalog(", "function scheduleDeferredServerCatalogRefresh(");
  const deferred = section("function scheduleDeferredServerCatalogRefresh(", "async function loadAnimeSources()");
  const render = section("function renderCarousel()", "let _carouselDotsHtml");

  assert.match(load, /replaceRegularCatalog\(cachedCatalog, "cache"\)/);
  assert.match(apply, /upgradesProvisionalArtwork[\s\S]*?_carouselPaintedId = null/);
  assert.match(deferred, /state\.catalogTier = "fallback";[\s\S]*?_carouselPaintedId = null;[\s\S]*?renderCarousel\(\)/);
  assert.match(render, /const catalogArtworkPending = !isAdultCatalogShow\(show\)[\s\S]*?\["none", "bootstrap", "cache"\]/);
  assert.match(render, /const art = hiResArt;/);
  assert.doesNotMatch(render, /hiResArt \|\| \(resolving/);
});

test("changing slide drops the previous slide's preview at once, even when no new one follows", async () => {
  const art = "https://cdn.example/hero.jpg";
  const delivered = "/api/image?src=hero&w=1920&q=92";

  // The next slide is still resolving its artwork: renderCarousel resets on the change.
  const resolving = blurHarness();
  resolving.img.src = delivered;
  resolving.classes.add("is-backdrop-loading");
  resolving.c.showCarouselBlurPlaceholder(art, delivered);
  resolving.previews[0].onload();
  assert.equal(resolving.classes.has("has-blur-placeholder"), true);
  resolving.c.resetCarouselBlurPlaceholder();
  assert.equal(resolving.classes.has("has-blur-placeholder"), false, "no fade hold: this is another anime");
  resolving.previews[0].onload();
  assert.equal(resolving.classes.has("has-blur-placeholder"), false, "a late load of the old preview cannot bring it back");
  await resolving.clock.advance(420);
  assert.equal(resolving.blur.style.backgroundImage, "");

  // The next slide's preview would be its own delivered file, so none is loaded.
  const skipped = blurHarness();
  skipped.img.src = delivered;
  skipped.classes.add("is-backdrop-loading");
  skipped.c.showCarouselBlurPlaceholder(art, delivered);
  skipped.previews[0].onload();
  const same = skipped.c.carouselBlurSourceUrl("https://cdn.example/b.jpg");
  skipped.img.src = same;
  skipped.c.showCarouselBlurPlaceholder("https://cdn.example/b.jpg", same);
  assert.equal(skipped.previews.length, 1);
  assert.equal(skipped.classes.has("has-blur-placeholder"), false);

  // Releasing the old image never wipes a new preview that landed first.
  const quick = blurHarness();
  quick.img.src = delivered;
  quick.classes.add("is-backdrop-loading");
  quick.c.showCarouselBlurPlaceholder(art, delivered);
  quick.previews[0].onload();
  const next = "/api/image?src=next&w=1920&q=92";
  quick.img.src = next;
  quick.c.showCarouselBlurPlaceholder("https://cdn.example/next.jpg", next);
  await quick.clock.advance(100);
  quick.previews[1].onload();
  await quick.clock.advance(1000);
  assert.equal(quick.classes.has("has-blur-placeholder"), true);
  assert.match(quick.blur.style.backgroundImage, /next/);

  const render = section("function renderCarousel()", "let _carouselDotsHtml");
  assert.match(render, /if \(_carouselPreviewShowId !== artworkShowIdentity\(show\)\) \{[\s\S]*?resetCarouselBlurPlaceholder\(\);/);
  // An emptied line-up shows the loading skeleton, never an old slide's preview.
  assert.match(render, /if \(!items\.length\) \{[\s\S]*?resetCarouselBlurPlaceholder\(\);[\s\S]*?return;/);
});

test("a restored hero stays blurred until its exact full image has decoded", () => {
  const restore = section("(function restoreHeroBackdrop() {", "// The splash used to");
  const memoRead = section("function readHeroMemo()", "function writeHeroMemo(");
  const render = section("function renderCarousel()", "let _carouselDotsHtml");
  assert.match(client, /const HERO_MEMO_SCHEMA = 4;/);
  assert.match(memoRead, /typeof memo\.art !== "string"/);
  assert.match(memoRead, /proxiedArt[\s\S]*?new URL\(proxiedArt\)\.href !== new URL\(memo\.art\)\.href/);
  assert.match(restore, /carouselStage\.classList\.add\("is-backdrop-loading"\);[\s\S]*?carouselBackdropImage\.src = memo\.src;[\s\S]*?showCarouselBlurPlaceholder\(memo\.art, memo\.src\);/);
  assert.match(restore, /carouselBackdropImage\.decode\(\)\.then\(reveal\)\.catch\(reveal\)/);
  assert.match(restore, /classList\.remove\("is-backdrop-loading"\);[\s\S]*?clearCarouselBlurPlaceholder\(\);[\s\S]*?signalAppLoader\("hero"\);/);
  assert.match(render, /writeHeroMemo\(\{[\s\S]*?\bart,[\s\S]*?src: deliveredArt/);
  assert.doesNotMatch(restore, /if \(heroMemoActive\) signalAppLoader/);
});
