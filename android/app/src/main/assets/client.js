// Constants, translations, and pure utilities are loaded from:
// js/constants.js → js/translations.js → js/utils.js → js/normalize.js

installAdBlockGuards();

function installAdBlockGuards() {
  const blockedOpen = (url = "") => {
    console.warn("ZenkaiTV blocked a popup/ad window.", url);
    if (typeof showToast === "function") showToast("Popup blocked");
    return null;
  };

  try {
    window.open = blockedOpen;
  } catch (error) {
    console.warn("Popup guard could not replace window.open:", error);
  }

  document.addEventListener("click", (event) => {
    const target = event.target?.closest?.("a[target='_blank'], a[href^='javascript:']");
    if (!target) return;
    if (target.classList.contains("player-download-action")) return;
    event.preventDefault();
    event.stopPropagation();
    blockedOpen(target.href || target.getAttribute("href") || "");
  }, true);
}

// TRANSLATIONS is defined in js/translations.js

let anipubCatalogCache = readResponseCache("anipub-full-catalog");
let anipubCatalogLoadingPromise = null;
const anipubEpisodesCache = new Map();
if (!localStorage.getItem(LANGUAGE_PREFERENCES_KEY)) setDefaultLanguage("japanese", "spanish");

// readUiPreferences is defined in js/utils.js

const LOCAL_FINDER_SOURCE_ID = "local-finder";
const LOCAL_FINDER_SOURCE = {
  id: LOCAL_FINDER_SOURCE_ID,
  name: "Local Finder",
  enabled: true,
  type: "playback-addon",
  endpoint: "/api/scraped-catalog?limit=500&page=1",
  pageSize: 500,
  paginated: true,
  hidden: true,
  playbackOnly: true,
  noCache: true
};

const fallbackShows = [
  ["Sky Guard Returns", 9, "action", "Mon", "7:00 PM", "#68d8ff", "#1a2458"],
  ["Second Crown Chronicle", 8, "fantasy", "Tue", "8:30 PM", "#efb25f", "#402060"],
  ["Kind Gal Next Door", 7, "romance", "Wed", "6:30 PM", "#ffc6df", "#5b3155"],
  ["Vending Hero Maze", 8, "comedy", "Thu", "7:45 PM", "#fbdf74", "#3b5e94"],
  ["Masked City Season 2", 10, "action", "Fri", "9:00 PM", "#57d28f", "#18322c"],
  ["Zero World Memory", 7, "fantasy", "Sat", "8:00 PM", "#77b7ff", "#272266"],
  ["Rental Summer Fifth", 7, "romance", "Sun", "5:30 PM", "#ff9bc5", "#704154"],
  ["Elite Classroom IV", 11, "drama", "Mon", "10:00 PM", "#d9a05c", "#241f30"],
  ["Tiny Dragon Errand", 7, "comedy", "Tue", "5:00 PM", "#f8c2bd", "#674864"],
  ["Left-Handed Rogue", 7, "action", "Wed", "9:30 PM", "#92a9ff", "#161c3d"]
].map((item, index) => ({
  id: `demo-${index}`,
  title: item[0],
  episode: item[1],
  genre: item[2],
  genres: [item[2]],
  day: item[3],
  time: item[4],
  colors: [item[5], item[6]],
  score: null,
  source: "Demo",
  image: "",
  banner: "",
  siteUrl: "",
  description: "Temporary offline placeholder while ZenkaiTV reconnects to metadata sources.",
  videoUrl: ""
}));

// Known playback server definitions — used by the source picker to show all server slots
// even when only some resolve. `match` identifies a sourceOption belonging to this server.
// AnimeAV1 is listed FIRST (most reliable; its HLS is the top pick). The picker
// also re-orders by source preference, so the card holding AnimeAV1-HLS leads.
const KNOWN_SOURCE_SERVERS = [
  {
    key: "animeav1",
    label: "AnimeAV1",
    desc: "Fast AnimeAV1 scraper (HLS)",
    match: (s) =>
      (s.id || "").includes("animeav1") ||
      (s.label || "").toLowerCase().includes("animeav1") ||
      (s.externalUrl || s.videoUrl || "").includes("animeav1.com")
  },
  {
    key: "tioanime",
    label: "TioAnime",
    desc: "Live scraper sources",
    match: (s) =>
      (s.id || "").includes("tioanime") ||
      (s.label || "").toLowerCase().includes("tioanime")
  },
  {
    key: "anipub",
    label: "AniPub",
    desc: "AniPub catalog",
    match: (s) =>
      s.id === "anipub" || (s.id || "").startsWith("anipub") ||
      (s.label || "").toLowerCase() === "anipub"
  }
];

// Built-in playback scrapers shown on the Sources tab as toggleable cards.
// (AniPub already appears via its catalog source card.)
const PLAYBACK_SCRAPERS = [
  {
    id: "animeav1",
    name: "AnimeAV1",
    desc: "Direct HLS / Mega / MP4Upload scraper — fast, ad-free playback.",
    endpoint: "./api/animeav1/sources",
    health: "./api/animeav1/info?slug=one-piece"
  },
  {
    id: "tioanime",
    name: "TioAnime",
    desc: "Live episode source scraper (Spanish-subbed mirrors).",
    endpoint: "./api/tioanime/sources",
    health: "./api/tioanime/health"
  }
];

function isScraperEnabled(id) {
  return state.scraperEnabled[id] !== false;
}

function setScraperEnabled(id, enabled) {
  state.scraperEnabled = { ...state.scraperEnabled, [id]: enabled };
  try { localStorage.setItem("zenkaitv-scrapers", JSON.stringify(state.scraperEnabled)); } catch { /* ignore */ }
}

const state = {
  route: "home",
  filter: "all",
  search: "",
  activeShow: null,
  activeEpisodeUrl: "",
  activeEpisode: null,
  preferredSource: localStorage.getItem("animetv-preferred-playback-source") || "auto",
  activeDetailTab: "episodes",
  activeSettingsTab: "general",
  activeLegalTab: "terms",
  activeSeasonIndex: 0,
  carouselIndex: 0,
  shows: [],
  isLoadingCatalog: true,
  addonSections: [],
  addonVisible: {},
  externalSourcesLoaded: false,
  anipubLoading: false,
  anipubFallbackCache: readAniPubFallbackCache(),
  localSources: [],
  customSources: JSON.parse(localStorage.getItem("animetv-custom-sources") || "[]"),
  // Built-in playback scrapers the user can toggle on/off (default all on).
  scraperEnabled: { animeav1: true, tioanime: true, ...JSON.parse(localStorage.getItem("zenkaitv-scrapers") || "{}") },
  // Compact (collapsed) icon rail is the DEFAULT; expand to reveal labels.
  sidebarCollapsed: localStorage.getItem("animetv-sidebar-collapsed") !== "false",
  apiStatus: {
    metadata: "Checking",
    direct: "Checking",
    local: "No local sources loaded"
  },
  sourceOverrides: JSON.parse(localStorage.getItem("animetv-source-overrides") || "{}"),
  favorites: JSON.parse(localStorage.getItem("anime-tv-favorites") || "[]"),
  appLanguage: localStorage.getItem(APP_LANGUAGE_KEY) || "en",
  theme: localStorage.getItem(APP_THEME_KEY) || "dark",
  uiPreferences: readUiPreferences()
};

const TITLE_LANGUAGE_ROMAJI_MIGRATION_KEY = "animetv-title-language-romaji-v1";
if (localStorage.getItem(TITLE_LANGUAGE_ROMAJI_MIGRATION_KEY) !== "done") {
  state.uiPreferences.titleLanguage = "romaji";
  localStorage.setItem(APP_UI_PREFS_KEY, JSON.stringify(state.uiPreferences));
  localStorage.setItem(TITLE_LANGUAGE_ROMAJI_MIGRATION_KEY, "done");
}

const appLoader = document.querySelector("#appLoader");
const latestGrid = document.querySelector("#latestGrid");
const libraryGrid = document.querySelector("#libraryGrid");
const anipubGrid = document.querySelector("#anipubGrid");
const anipubSummary = document.querySelector("#anipubSummary");
const favoritesGrid = document.querySelector("#favoritesGrid");
const scheduleList = document.querySelector("#scheduleList");
const sourcesGrid = document.querySelector("#sourcesGrid");
const sourceSummary = document.querySelector("#sourceSummary");
const settingsGrid = document.querySelector("#settingsGrid");
const addonSections = document.querySelector("#addonSections");
const searchInput = document.querySelector("#searchInput");
const searchInputTop = document.querySelector("#searchInputTop");
const searchInputLibrary = document.querySelector("#searchInputLibrary");
const searchInputAniPub = document.querySelector("#searchInputAniPub");
const sidebarToggle = document.querySelector("#sidebarToggle");
const overlay = document.querySelector("#watchOverlay");
const closeOverlay = document.querySelector("#closeOverlay");
const favoriteButton = document.querySelector("#favoriteButton");
const fakePlay = document.querySelector("#fakePlay");
const trailerButton = document.querySelector("#trailerButton");
const shareButton = document.querySelector("#shareButton");
const castButton = document.querySelector("#castButton");
const episodeList = document.querySelector("#episodeList");
const sections = document.querySelectorAll("[data-section]");
const carouselBackdrop = document.querySelector("#carouselBackdrop");
const carouselTitle = document.querySelector("#carouselTitle");
const carouselText = document.querySelector("#carouselText");
const carouselMeta = document.querySelector("#carouselMeta");
const carouselOpen = document.querySelector("#carouselOpen");
const carouselStage = document.querySelector("#carouselStage");
const carouselIndicators = document.querySelector("#carouselIndicators");
let carouselTimer = null;
let lastInputWasPointer = false;

function hideAppLoader() {
  if (!appLoader) return;
  appLoader.classList.add("is-hidden");
  window.setTimeout(() => appLoader.remove(), 260);
}

function applySidebarState() {
  document.body.classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
  if (sidebarToggle) {
    sidebarToggle.setAttribute("aria-pressed", String(state.sidebarCollapsed));
    sidebarToggle.setAttribute("aria-label", state.sidebarCollapsed ? "Show sidebar labels" : "Hide sidebar labels");
    // Keep a constant chevron glyph; CSS rotates it smoothly on collapse.
    const icon = sidebarToggle.querySelector("span");
    if (icon && icon.textContent !== "‹") icon.textContent = "‹";
  }
}

function applyUiPreferences() {
  const resolvedTheme = state.theme === "system"
    ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
    : state.theme;
  document.body.dataset.theme = resolvedTheme;
  document.body.classList.toggle("reduce-motion", !state.uiPreferences.motion);
  document.body.classList.toggle("soft-focus", !state.uiPreferences.focusGlow);
  document.body.classList.toggle("hero-paused", !state.uiPreferences.autoplayHero);
}

function saveUiPreferences(next = {}) {
  state.uiPreferences = { ...state.uiPreferences, ...next };
  localStorage.setItem(APP_UI_PREFS_KEY, JSON.stringify(state.uiPreferences));
  applyUiPreferences();
}

let _sidebarToggleTimer = null;
function toggleSidebar() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  localStorage.setItem("animetv-sidebar-collapsed", String(state.sidebarCollapsed));
  // Fire a transient class so the logo can play a one-shot reaction that's
  // synced with the sidebar slide (see .is-toggling rules in styles.css).
  // Remove ALL transient classes first — otherwise rapid/alternating clicks
  // leave both is-collapsing AND is-expanding on the body at once, which runs
  // conflicting animations and makes the toggle look broken after a few uses.
  document.body.classList.remove("is-toggling", "is-collapsing", "is-expanding");
  // force reflow so re-adding the class restarts the animation even on rapid clicks
  void document.body.offsetWidth;
  document.body.classList.add("is-toggling", state.sidebarCollapsed ? "is-collapsing" : "is-expanding");
  clearTimeout(_sidebarToggleTimer);
  _sidebarToggleTimer = window.setTimeout(() => {
    document.body.classList.remove("is-toggling", "is-collapsing", "is-expanding");
  }, 640);
  applySidebarState();
  refreshFocusables();
}

function t(key) {
  return TRANSLATIONS[state.appLanguage]?.[key] || TRANSLATIONS.en[key] || key;
}

function applyAppLanguage() {
  document.documentElement.lang = state.appLanguage;
  document.querySelector('[data-route="home"]:not(.brand)')?.lastChild && (document.querySelector('[data-route="home"]:not(.brand)').lastChild.textContent = ` ${t("navHome")}`);
  document.querySelector('[data-route="library"]')?.lastChild && (document.querySelector('[data-route="library"]').lastChild.textContent = ` ${t("navSearch")}`);
  document.querySelector('[data-route="schedule"]')?.lastChild && (document.querySelector('[data-route="schedule"]').lastChild.textContent = ` ${t("navSchedule")}`);
  document.querySelector('[data-route="favorites"]')?.lastChild && (document.querySelector('[data-route="favorites"]').lastChild.textContent = ` ${t("navFavorites")}`);
  document.querySelector('[data-route="sources"]')?.lastChild && (document.querySelector('[data-route="sources"]').lastChild.textContent = ` ${t("navSources")}`);
  document.querySelector('[data-route="settings"]')?.lastChild && (document.querySelector('[data-route="settings"]').lastChild.textContent = ` ${t("navSettings")}`);
  setText(".carousel-info .eyebrow", "featuredNow");
  if (!carouselTitle.textContent || /loading|cargando/i.test(carouselTitle.textContent)) carouselTitle.textContent = t("loadingAnime");
  if (!carouselText.textContent || /fetching|buscando/i.test(carouselText.textContent)) carouselText.textContent = t("fetchingAnime");
  if (!carouselMeta.textContent || /loading|cargando/i.test(carouselMeta.textContent)) carouselMeta.textContent = t("loading");
  carouselOpen.querySelector("span:last-child").textContent = t("play");
  setText("#latest .section-heading h2", "latestEpisodes");
  setText("#library .section-heading h2", "animeLibrary");
  setText("#schedule .section-heading h2", "weeklySchedule");
  setText("#anipubSummary", "anipubSummary");
  setText("#favorites .section-heading h2", "favorites");
  setText("#emptyFavorites", "emptyFavorites");
  setText("#sources .section-heading h2", "sourcesAddons");
  setText("#settings .section-heading h2", "settingsTitle");
  setText("#settingsSummary", "settingsSummary");
  setPlaceholder(searchInput, "searchShort");
  setPlaceholder(searchInputTop, "searchLong");
  setPlaceholder(searchInputLibrary, "searchAnime");
  setPlaceholder(searchInputAniPub, "searchAniPub");
  ["all", "action", "comedy", "fantasy", "romance"].forEach((filter) => {
    document.querySelectorAll(`[data-filter="${filter}"]`).forEach((button) => {
      button.textContent = filter === "all" ? t("all") : t(filter);
    });
  });
  if (fakePlay) fakePlay.textContent = t("play");
  if (castButton) castButton.textContent = t("cast");
  setFavoriteButtonState(Boolean(state.activeShow && state.favorites.includes(state.activeShow.id)));
  document.querySelector("#videoFrame [data-i18n-placeholder]")?.removeAttribute("data-i18n-placeholder");
}

function setText(selector, key) {
  const node = document.querySelector(selector);
  if (node) node.textContent = t(key);
}

function setPlaceholder(input, key) {
  if (input) input.placeholder = t(key);
}

async function loadAnimeSources() {
  setSourceStatus("Loading ZenkaiTV metadata API...");
  render();
  hideAppLoader();

  const cachedCatalog = readResponseCache("main-catalog");
  if (cachedCatalog?.length) {
    state.shows = cachedCatalog;
    state.isLoadingCatalog = false;
    state.carouselIndex = 0;
    setSourceStatus(catalogStatusLabel("Cached ZenkaiTV catalog", cachedCatalog));
    render();
    warmTioAnimeSlugCatalog(state.shows);
    warmAnimeAv1SlugCatalog(state.shows);
  }

  const serverCatalog = await timedRequest("ZenkaiTV metadata API", () => fetchLocalMetadataCatalog()).catch(() => []);
  if (serverCatalog.length) {
    state.shows = mergeShows(serverCatalog);
    state.isLoadingCatalog = false;
    state.carouselIndex = 0;
    state.apiStatus.metadata = "Online";
    state.apiStatus.direct = "Standby";
    writeResponseCache("main-catalog", state.shows);
    setSourceStatus(catalogStatusLabel("ZenkaiTV API", state.shows));
    render();
    warmTioAnimeSlugCatalog(state.shows);
    warmAnimeAv1SlugCatalog(state.shows);
    scheduleExternalSourcesLoad();
    return;
  }

  state.apiStatus.metadata = "Unavailable";
  state.apiStatus.direct = "Loading";
  setSourceStatus("Loading AniList and Jikan directly...");

  const cachedDirect = readResponseCache("direct-catalog");
  if (!state.shows.length && cachedDirect?.length) {
    state.shows = cachedDirect;
    state.isLoadingCatalog = false;
    state.carouselIndex = 0;
    setSourceStatus(catalogStatusLabel("Cached AniList + Jikan", cachedDirect));
    render();
  }

  const [anilist, jikanTop, jikanSeason, jikanPopular] = await Promise.allSettled([
    timedRequest("AniList", () => fetchAniListTrending()),
    timedRequest("Jikan Airing", () => fetchJikanPages(JIKAN_TOP_ENDPOINT, "Jikan Airing", 3)),
    timedRequest("Jikan Season", () => fetchJikanPages(JIKAN_SEASON_ENDPOINT, "Jikan Season", 3)),
    timedRequest("Jikan Popular", () => fetchJikanPages(JIKAN_POPULAR_ENDPOINT, "Jikan Popular", 3))
  ]);

  const loaded = [
    ...(anilist.status === "fulfilled" ? anilist.value : []),
    ...(jikanTop.status === "fulfilled" ? jikanTop.value : []),
    ...(jikanSeason.status === "fulfilled" ? jikanSeason.value : []),
    ...(jikanPopular.status === "fulfilled" ? jikanPopular.value : [])
  ];

  const merged = mergeShows(loaded);
  if (merged.length) {
    state.shows = merged;
    state.isLoadingCatalog = false;
    state.carouselIndex = 0;
    state.apiStatus.direct = "Online";
    writeResponseCache("direct-catalog", merged);
    writeResponseCache("main-catalog", merged);
    setSourceStatus(catalogStatusLabel("AniList + Jikan", merged));
    warmTioAnimeSlugCatalog(state.shows);
    warmAnimeAv1SlugCatalog(state.shows);
  } else {
    state.apiStatus.direct = "Offline";
    if (!state.shows.length) state.shows = fallbackShows;
    state.isLoadingCatalog = false;
    setSourceStatus("Offline catalog");
  }

  render();
  // Always patch in authoritative airing data (latest-aired episode, ids) from
  // the server catalog — regardless of whether shows came from cache, the live
  // merge, or the offline fallback.
  enrichCatalogAiringData();
  scheduleExternalSourcesLoad();
  // Mirror AnimeAV1's "Últimos Episodios" order in the Home Latest Episodes rail.
  loadAnimeAv1Latest();
}

// The client builds its catalog from AniList trending + Jikan directly, but some
// airing shows arrive Jikan-only (no AniList airing fields), so their cards would
// fall back to "TV". The server's /api/catalog cross-enriches every entry with
// AniList data, so pull the authoritative latest-aired / status / ids from there
// and patch the in-memory catalog, then re-render.
async function enrichCatalogAiringData(attempt = 0) {
  try {
    const res = await fetchWithTimeout("./api/catalog", { cache: "no-store" }, 12000);
    if (!res.ok) throw new Error("catalog unavailable");
    const json = await res.json();
    const items = Array.isArray(json.items) ? json.items : [];
    if (!items.length) throw new Error("catalog empty");
    const byAni = new Map();
    const byMal = new Map();
    items.forEach((it) => {
      if (it.anilistId) byAni.set(String(it.anilistId), it);
      if (it.malId) byMal.set(String(it.malId), it);
    });
    let changed = false;
    // Patch the live catalog (state.shows) so later array swaps don't lose this.
    (state.shows || []).forEach((s) => {
      const it = (s.anilistId && byAni.get(String(s.anilistId)))
              || (s.malId && byMal.get(String(s.malId)));
      if (!it) return;
      if (it.latestAiredEp != null) s.latestAiredEp = it.latestAiredEp;
      if (it.nextAiringEpisodeNumber != null) s.nextAiringEpisodeNumber = it.nextAiringEpisodeNumber;
      if (it.nextAiringAt != null && s.nextAiringAt == null) s.nextAiringAt = it.nextAiringAt;
      if (it.totalEpisodes != null) s.totalEpisodes = it.totalEpisodes;
      if (it.status) s.status = it.status;
      if (it.episode != null && it.episode !== "?") s.episode = it.episode;
      if (!s.anilistId && it.anilistId) s.anilistId = it.anilistId;
      changed = true;
    });
    if (changed) {
      writeResponseCache("direct-catalog", state.shows);
      render();
    }
  } catch {
    // /api/catalog may still be warming up — retry a few times.
    if (attempt < 5) window.setTimeout(() => enrichCatalogAiringData(attempt + 1), 3000);
  }
}

function scheduleExternalSourcesLoad() {
  const run = () => loadExternalSources();
  const delayMs = state.route === "home" ? 1200 : 700;
  if ("requestIdleCallback" in window) {
    window.setTimeout(() => window.requestIdleCallback(run, { timeout: 1600 }), delayMs);
    return;
  }
  window.setTimeout(run, delayMs);
}

async function loadExternalSources() {
  try {
    state.externalSourcesLoaded = false; // mark loading in progress for skeleton
    renderAddonSections();               // show "Loading sources…" hint immediately
    const response = await fetch("./sources.json", { cache: "no-store" });
    if (!response.ok) throw new Error("sources.json unavailable");
    const config = await response.json();
    const configuredSources = Array.isArray(config.sources) ? config.sources : [];
    const sources = configuredSources.some((source) => source.id === LOCAL_FINDER_SOURCE_ID)
      ? [...configuredSources, ...state.customSources]
      : [...configuredSources, LOCAL_FINDER_SOURCE, ...state.customSources];
    state.localSources = sources.map(applySourceOverride).filter((source) => !source.deleted);
    renderSources();

    state.externalSourcesLoaded = true; // sources.json parsed — fan-out begins
    const enabledSources = state.localSources.filter(
      (source) => source.enabled && source.endpoint && source.id !== "anipub-catalog"
    );

    // Snapshot the show list so incremental merges are idempotent
    const baseShows = [...state.shows];
    const addonSections = [];
    const allLoaded = [];

    // Each source renders as soon as it arrives — no waiting for others.
    await Promise.allSettled(enabledSources.map(async (source) => {
      try {
        const catalog = await timedRequest(
          `External source ${source.name || source.id}`,
          () => fetchExternalCatalogData(source)
        );
        const items = catalog.items;
        markSourceStatus(
          source.name,
          items.length
            ? `${items.length}${catalog.totalResults ? ` of ${catalog.totalResults}` : ""} titles`
            : "Connected, no playable items"
        );
        if (!items.length) return;

        // Remove any prior entry for this source, then push the fresh one
        const existingIdx = addonSections.findIndex((s) => s.id === source.id);
        const section = {
          id: source.id,
          name: source.name || source.id,
          type: source.type || "addon",
          items,
          source,
          page: catalog.page,
          nextPage: catalog.nextPage,
          hasMore: catalog.hasMore,
          totalResults: catalog.totalResults,
          paginated: Boolean(source.paginated || catalog.nextPage || catalog.hasMore)
        };
        if (existingIdx >= 0) addonSections[existingIdx] = section;
        else addonSections.push(section);

        if (!source.playbackOnly) allLoaded.push(...items);

        // Update global state and re-render addon rails right away
        state.addonSections = [...addonSections];
      state.shows = mergeShows([...baseShows, ...allLoaded]);
      if (_tioAnimeSlugTitleMap) state.shows.forEach((show) => applyTioAnimeSlugFromMap(show, _tioAnimeSlugTitleMap));
      if (_animeAv1SlugTitleMap) state.shows.forEach((show) => applyAnimeAv1SlugFromMap(show, _animeAv1SlugTitleMap));
      if (!source.playbackOnly) {
          renderAddonSections();
          renderCarousel();
        }
      } catch (error) {
        markSourceStatus(source.name, "Server offline or wrong URL");
      }
    }));

    // Final consolidated state + full render
    state.addonSections = addonSections;
    if (allLoaded.length || addonSections.length) {
      state.shows = mergeShows([...baseShows, ...allLoaded]);
      warmTioAnimeSlugCatalog(state.shows);
      warmAnimeAv1SlugCatalog(state.shows);
      const addonCount = addonSections.reduce((t, s) => t + (s.items?.length || 0), 0);
      state.apiStatus.local = allLoaded.length
        ? `${allLoaded.length} local titles`
        : `${addonCount} addon titles`;
      setSourceStatus(catalogStatusLabel("AniList + Jikan + Sources", state.shows));
      render();
      // Re-apply authoritative airing data — this merge rebuilt the show objects
      // and dropped the earlier enrichment.
      enrichCatalogAiringData();
    } else {
      state.apiStatus.local = enabledSources.length ? "No titles loaded" : "No enabled sources";
      state.addonSections = [];
      renderAddonSections();
      renderSources();
    }
  } catch (error) {
    state.localSources = [];
    state.addonSections = [];
    state.apiStatus.local = "sources.json unavailable";
    renderAddonSections();
    renderSources();
  }
}

async function fetchLocalMetadataCatalog() {
  if (location.protocol === "file:") return [];
  const response = await fetchWithTimeout(LOCAL_METADATA_ENDPOINT, { cache: "no-store" });
  if (!response.ok) throw new Error("ZenkaiTV metadata API unavailable");
  const payload = await response.json();
  const rawItems = Array.isArray(payload)
    ? payload
    : payload.items || payload.results || payload.anime || payload.catalog || payload.data || [];
  const source = { id: "animetv-api", name: payload.source || "ZenkaiTV API" };
  return rawItems.map((item, index) => normalizeExternalShow(item, source, index)).filter(Boolean);
}

async function fetchExternalCatalog(source) {
  const catalog = await fetchExternalCatalogData(source);
  return catalog.items;
}

async function fetchExternalCatalogData(source, page = null) {
  // Crawled / direct-video sources carry their catalog inline — no endpoint to hit.
  if (Array.isArray(source.catalog)) {
    return {
      items: source.catalog.map((item, index) => normalizeExternalShow(item, source, index)).filter(Boolean),
      page: 1,
      nextPage: null,
      hasMore: false,
      totalResults: source.catalog.length
    };
  }
  const cacheKey = `external:${source.id || source.name}:${page || getSourcePage(source) || 1}`;
  const useCache = !source.noCache && !source.playbackOnly;
  const cached = useCache ? readResponseCache(cacheKey) : null;
  if (cached) return cached;
  const response = await fetchCatalogResponse(source);
  if (!response.ok) throw new Error(`${source.name} failed`);
  const payload = await response.json();
  const rawItems = Array.isArray(payload)
    ? payload
    : payload.items || payload.results || payload.anime || payload.catalog || payload.data || [];
  const items = Array.isArray(rawItems) ? rawItems : [];
  const catalog = {
    items: items.map((item, index) => normalizeExternalShow(item, source, index)).filter(Boolean),
    page: Number(payload.page || page || getSourcePage(source) || 1),
    nextPage: payload.nextPage || null,
    hasMore: Boolean(payload.hasMore || payload.nextPage),
    totalResults: Number(payload.totalResults || payload.total || payload.count || 0) || null
  };
  if (useCache) writeResponseCache(cacheKey, catalog);
  return catalog;
}

async function fetchCatalogResponse(source) {
  const endpoint = withAnime1vApiKey(resolveSourceEndpoint(source.endpoint), source);
  try {
    return await fetchWithTimeout(endpoint, { cache: "no-store" });
  } catch (error) {
    if (location.protocol === "file:") throw error;
    const proxyUrl = `${LOCAL_SOURCE_PROXY_ENDPOINT}?url=${encodeURIComponent(endpoint)}`;
    return fetchWithTimeout(proxyUrl, { cache: "no-store" });
  }
}

function getAnime1vApiKey() {
  return localStorage.getItem(ANIME1V_API_KEY_STORAGE) || "";
}

function withAnime1vApiKey(endpoint, source = null) {
  if (!endpoint || !(source?.id === "anime1v-spanish" || /\/api\/anime1v\//i.test(endpoint))) return endpoint;
  const apiKey = getAnime1vApiKey();
  if (!apiKey) return endpoint;
  try {
    const url = new URL(endpoint, location.href);
    url.searchParams.set("apiKey", apiKey);
    return url.toString();
  } catch (error) {
    return endpoint;
  }
}

function getSourcePage(source) {
  try {
    return Number(new URL(resolveSourceEndpoint(source.endpoint)).searchParams.get("page") || 1);
  } catch (error) {
    return 1;
  }
}

function withSourcePage(source, page) {
  const endpoint = resolveSourceEndpoint(source.endpoint);
  try {
    const url = new URL(endpoint);
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", String(source.pageSize || url.searchParams.get("limit") || 50));
    return { ...source, endpoint: url.toString() };
  } catch (error) {
    return source;
  }
}

function resolveSourceEndpoint(endpoint) {
  if (!endpoint || location.protocol === "file:") return endpoint;
  if (String(endpoint).startsWith("/")) return new URL(endpoint, location.origin).toString();
  try {
    const url = new URL(endpoint);
    const appHost = location.hostname;
    const sourceIsLoopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
    const appIsLoopback = ["127.0.0.1", "localhost", "::1"].includes(appHost);
    if (sourceIsLoopback && !appIsLoopback) {
      if (url.pathname.startsWith("/api/")) {
        return new URL(`${url.pathname}${url.search}${url.hash}`, location.origin).toString();
      }
      url.hostname = appHost;
      url.port = location.port;
      url.protocol = location.protocol;
    }
    return url.toString();
  } catch (error) {
    return endpoint;
  }
}

function getAniPubSource() {
  return state.localSources.find((source) => source.id === "anipub-catalog")
    || state.customSources.find((source) => source.id === "anipub-catalog")
    || { id: "anipub-catalog", name: "AniPub", endpoint: "./api/anipub/catalog/all?limit=100&page=1", pageSize: 100, paginated: true };
}

function getLocalFinderSource() {
  return state.localSources.find((source) => source.id === LOCAL_FINDER_SOURCE_ID)
    || state.customSources.find((source) => source.id === LOCAL_FINDER_SOURCE_ID)
    || LOCAL_FINDER_SOURCE;
}

async function ensureLocalFinderSectionLoaded() {
  const existing = state.addonSections.find((section) => section.id === LOCAL_FINDER_SOURCE_ID && section.items?.length);
  if (existing) return existing;
  const source = applySourceOverride(getLocalFinderSource());
  if (!source?.enabled || !source.endpoint || source.deleted) return null;
  try {
    const catalog = await fetchExternalCatalogData(source);
    if (!catalog.items?.length) return null;
    const section = {
      id: source.id,
      name: source.name || source.id,
      type: source.type || "playback-addon",
      items: catalog.items,
      source,
      page: catalog.page,
      nextPage: catalog.nextPage,
      hasMore: catalog.hasMore,
      totalResults: catalog.totalResults,
      paginated: Boolean(source.paginated || catalog.nextPage || catalog.hasMore)
    };
    state.addonSections = [
      ...state.addonSections.filter((entry) => entry.id !== source.id),
      section
    ];
    return section;
  } catch (error) {
    console.warn("Local Finder catalog unavailable:", error);
    return null;
  }
}

function getAniPubSection() {
  return state.addonSections.find((section) => section.id === "anipub-catalog")
    || { id: "anipub-catalog", name: "AniPub", items: [], page: 0, hasMore: true, source: getAniPubSource() };
}

// readAniPubFallbackCache, saveAniPubFallbackCache, readResponseCache, writeResponseCache,
// timedRequest, and fetchWithTimeout are defined in js/utils.js

// normalizeExternalShow, normalizeSeasons, normalizeEpisodes, groupEpisodesBySeason,
// pickPlayableUrl, normalizeEpisodeSourceOptions, cleanPlaybackSourceLabel, isAnime1vEpisode,
// sourceLabelFromResolver, comparePlaybackSources, playbackSourceRank, addEpisodeSourceOption,
// normalizeSubtitleTracks, getEpisodeUrl are defined in js/normalize.js

function markSourceStatus(name, status) {
  state.localSources = state.localSources.map((source) =>
    source.name === name ? { ...source, status } : source
  );
  renderSources();
}

function applySourceOverride(source) {
  const override = state.sourceOverrides[source.id] || {};
  return {
    ...source,
    ...override,
    status: override.enabled ?? source.enabled ? "Ready" : "Disabled"
  };
}

function saveSourceOverride(sourceId, patch) {
  state.sourceOverrides[sourceId] = {
    ...(state.sourceOverrides[sourceId] || {}),
    ...patch
  };
  localStorage.setItem("animetv-source-overrides", JSON.stringify(state.sourceOverrides));
}

function saveCustomSources() {
  localStorage.setItem("animetv-custom-sources", JSON.stringify(state.customSources));
}

// "Add Source" now opens the Smart Source modal (analyzes the pasted link and
// decides what to do). The old direct-add logic is kept as addBasicAddonSource,
// used by the API / addon strategies and as a fallback.
function addCustomSource() {
  if (typeof openSmartSourceModal === "function") return openSmartSourceModal();
  return addBasicAddonSource(window.prompt("Paste a catalog/addon URL.") || "");
}

function addBasicAddonSource(endpoint, opts = {}) {
  const normalizedEndpoint = normalizeSourceUrl(endpoint);
  if (!normalizedEndpoint) throw new Error("Use a valid http:// or https:// URL.");
  const isOnline = isOnlineSource(normalizedEndpoint);
  const name = opts.name || (isOnline ? "Online Anime Addon" : "My Anime Addon");
  const source = {
    id: opts.id || `custom-${Date.now()}`,
    name,
    enabled: true,
    custom: true,
    type: opts.type || (isOnline ? "online-addon" : "local-addon"),
    endpoint: normalizedEndpoint,
    description: opts.description || (isOnline
      ? "Online addon added from ZenkaiTV. It should return normalized catalog JSON from a source you are allowed to use."
      : "Local addon added from ZenkaiTV. It should return normalized catalog JSON.")
  };
  persistSmartSource(source);
  return source;
}

// Persist any source (basic addon, crawled, direct video) into the live list.
function persistSmartSource(source) {
  state.customSources = [...state.customSources.filter((s) => s.id !== source.id), source];
  saveCustomSources();
  saveSourceOverride(source.id, { enabled: true });
  state.localSources = [...state.localSources.filter((s) => s.id !== source.id), applySourceOverride(source)];
  renderSources();
  loadExternalSources();
}

// normalizeSourceUrl and isOnlineSource are defined in js/utils.js

function removeSource(sourceId) {
  const source = state.localSources.find((item) => item.id === sourceId);
  if (!source) return;
  const confirmed = window.confirm(`Remove "${source.name || "this source"}" from ZenkaiTV?`);
  if (!confirmed) return;

  if (source.custom) {
    state.customSources = state.customSources.filter((item) => item.id !== sourceId);
    delete state.sourceOverrides[sourceId];
    saveCustomSources();
  } else {
    saveSourceOverride(sourceId, { deleted: true, enabled: false });
  }

  localStorage.setItem("animetv-source-overrides", JSON.stringify(state.sourceOverrides));
  state.localSources = state.localSources.filter((item) => item.id !== sourceId);
  state.addonSections = state.addonSections.filter((section) => section.id !== sourceId);
  renderAddonSections();
  renderSources();
}

// Remove a source without the confirm() prompt (used by the merge resolver).
function removeSourceSilent(sourceId) {
  state.customSources = state.customSources.filter((item) => item.id !== sourceId);
  delete state.sourceOverrides[sourceId];
  saveCustomSources();
  localStorage.setItem("animetv-source-overrides", JSON.stringify(state.sourceOverrides));
  state.localSources = state.localSources.filter((item) => item.id !== sourceId);
  state.addonSections = state.addonSections.filter((section) => section.id !== sourceId);
}

// ── Smart Source integration ─────────────────────────────────────────────────
// Analyze a pasted link and add it the right way: direct video, single episode,
// anime series, full-site crawl, API catalog, or addon. Crawling is delegated to
// the user's scraper via window.ZenkaiScraper.crawl(...) or a POST crawl endpoint.

function smartCrawlEndpoint() {
  try { return localStorage.getItem("zenkaitv-crawl-endpoint") || "./api/crawl"; }
  catch { return "./api/crawl"; }
}

// kind: "site" | "anime" | "episode". Returns { name, catalog, totalEpisodes, playableCount, duration }.
async function smartCrawlBackend(kind, url, onProgress = () => {}) {
  onProgress({ stage: "connect", message: "Connecting to crawler…" });
  // 1) In-page scraper hook the user can wire up.
  if (window.ZenkaiScraper && typeof window.ZenkaiScraper.crawl === "function") {
    return await window.ZenkaiScraper.crawl({ kind, url, onProgress });
  }
  // 2) HTTP crawl endpoint (POST {kind, url}).
  let res;
  try {
    res = await fetchWithTimeout(smartCrawlEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, url })
    }, 180000);
  } catch {
    const e = new Error("CRAWLER_UNAVAILABLE"); e.code = "CRAWLER_UNAVAILABLE"; throw e;
  }
  if (res.status === 404 || res.status === 501) {
    const e = new Error("CRAWLER_UNAVAILABLE"); e.code = "CRAWLER_UNAVAILABLE"; throw e;
  }
  if (!res.ok) throw new Error(`Crawler returned HTTP ${res.status}`);
  const data = await res.json();
  if (!data || data.ok === false) throw new Error(data?.error || "Crawl failed.");
  return data;
}

function buildCrawledSource(kind, url, data) {
  const catalog = Array.isArray(data.catalog) ? data.catalog : [];
  const totalEpisodes = Number(
    data.totalEpisodes ?? catalog.reduce((n, a) => n + ((a.episodes && a.episodes.length) || 0), 0)
  ) || 0;
  const playableCount = Number(data.playableCount ?? totalEpisodes) || 0;
  const domain = SmartSource.domainOf(url);
  const name = data.name
    || (kind === "site" ? SmartSource.domainName(url)
        : (catalog[0]?.title || SmartSource.domainName(url)));
  return {
    id: `crawl-${Date.now()}`,
    name: kind === "site" ? `${name} (${catalog.length} anime, ${playableCount} playable)` : name,
    enabled: true,
    custom: true,
    type: kind === "site" ? "full-site-crawl" : kind === "anime" ? "single-anime" : "single-episode",
    url,
    endpoint: url,
    catalog,
    metadata: {
      totalAnime: catalog.length,
      totalEpisodes,
      playableCount,
      lastCrawled: new Date().toISOString(),
      crawlDuration: data.duration || null,
      crawlKind: kind
    },
    status: `${catalog.length} anime · ${playableCount} playable`,
    description: `Crawled from ${domain || "a site"} · ${catalog.length} anime · ${playableCount} playable`
  };
}

function addDirectVideoSource(analysis) {
  const url = analysis.url;
  let name = "Direct Video";
  try { name = decodeURIComponent(url.split("/").pop().split("?")[0]) || name; } catch { /* keep default */ }
  const id = `video-${Date.now()}`;
  const source = {
    id, name, enabled: true, custom: true,
    type: "single-video", url, endpoint: url,
    catalog: [{
      id, title: name, romajiTitle: name, episode: 1, totalEpisodes: 1,
      genre: "anime", status: "", image: "",
      description: "Direct video added via Smart Source.",
      videoUrl: url,
      episodes: [{ episode: 1, season: 1, title: name, videoUrl: url }]
    }],
    metadata: { totalAnime: 1, totalEpisodes: 1, playableCount: 1, lastCrawled: new Date().toISOString() },
    status: "1 playable",
    description: `Single video from ${SmartSource.domainOf(url) || "a direct link"}`
  };
  persistSmartSource(source);
  return source;
}

function findDuplicateSource(url) {
  const domain = SmartSource.domainOf(url);
  if (!domain) return null;
  return state.localSources.find((s) =>
    s.custom && (SmartSource.domainOf(s.url || s.endpoint || "") === domain)
  ) || null;
}

async function runCrawlStrategy(kind, analysis, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const dup = findDuplicateSource(analysis.url);
  if (dup && opts.resolveMerge) {
    const choice = await opts.resolveMerge(dup);   // "replace" | "separate" | "cancel"
    if (choice === "cancel") { const e = new Error("CANCELLED"); e.code = "CANCELLED"; throw e; }
    if (choice === "replace") removeSourceSilent(dup.id);
  }
  onProgress({ stage: "crawl", message: `Crawling ${SmartSource.domainOf(analysis.url) || analysis.url}…` });
  const data = await smartCrawlBackend(kind, analysis.url, onProgress);
  const source = buildCrawledSource(kind, analysis.url, data);
  onProgress({ stage: "done", message: `${source.metadata.totalAnime} anime · ${source.metadata.playableCount} playable` });
  persistSmartSource(source);
  return source;
}

const smartIntegrator = (typeof SmartSourceIntegrator === "function")
  ? new SmartSourceIntegrator({
      addDirectVideo: (a) => addDirectVideoSource(a),
      addApi: (a) => addBasicAddonSource(a.url, { type: "online-addon", name: `${SmartSource.domainName(a.url)} API`, description: "JSON catalog endpoint added via Smart Source." }),
      addAddon: (a) => addBasicAddonSource(a.url, { type: "online-addon", name: `${SmartSource.domainName(a.url)} Addon`, description: "Addon manifest added via Smart Source." }),
      crawl: (kind, a, opts) => runCrawlStrategy(kind, a, opts)
    })
  : null;

// Periodically refresh full-site crawls older than 7 days (best-effort, silent).
async function checkSourceRefreshes() {
  const now = Date.now();
  for (const source of state.localSources) {
    if (source.type !== "full-site-crawl" || !source.metadata?.lastCrawled) continue;
    const ageDays = (now - new Date(source.metadata.lastCrawled).getTime()) / 86400000;
    if (ageDays < 7) continue;
    try {
      const data = await smartCrawlBackend(source.metadata.crawlKind || "site", source.url, () => {});
      const fresh = buildCrawledSource("site", source.url, data);
      fresh.id = source.id;                         // keep the same id
      const before = source.metadata.totalEpisodes || 0;
      persistSmartSource(fresh);
      const added = (fresh.metadata.totalEpisodes || 0) - before;
      if (added > 0) showToast(`${SmartSource.domainOf(source.url)} updated (${added} new episodes)`);
    } catch { /* crawler offline — try again next time */ }
  }
}

// The Smart Source modal: paste a link, see what ZenkaiTV will do, then confirm.
function openSmartSourceModal() {
  if (!smartIntegrator) { addBasicAddonSource(window.prompt("Paste a catalog/addon URL.") || ""); return; }
  document.querySelector(".ss-modal-backdrop")?.remove();

  const backdrop = document.createElement("div");
  backdrop.className = "ss-modal-backdrop";
  backdrop.innerHTML = `
    <div class="ss-modal" role="dialog" aria-modal="true" aria-label="Add a source">
      <button class="ss-modal-close focusable" type="button" aria-label="Close">✕</button>
      <h3>Add a Source</h3>
      <p class="ss-modal-sub">Paste any link — a website, an episode page, a direct video, or an API. ZenkaiTV figures out what to do.</p>
      <input class="ss-modal-input focusable" type="url" inputmode="url" autocomplete="off" spellcheck="false"
             placeholder="anime site, episode URL, .mp4 / .m3u8, or API endpoint…">
      <div class="ss-modal-detect" hidden></div>
      <div class="ss-modal-progress" hidden></div>
      <div class="ss-modal-actions">
        <button class="ss-btn ss-btn-ghost focusable" type="button" data-ss-cancel>Cancel</button>
        <button class="ss-btn ss-btn-primary focusable" type="button" data-ss-confirm disabled>Add</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const input = backdrop.querySelector(".ss-modal-input");
  const detect = backdrop.querySelector(".ss-modal-detect");
  const progress = backdrop.querySelector(".ss-modal-progress");
  const confirmBtn = backdrop.querySelector("[data-ss-confirm]");
  const cancelBtn = backdrop.querySelector("[data-ss-cancel]");
  const closeBtn = backdrop.querySelector(".ss-modal-close");
  let current = null;
  let busy = false;

  const close = () => { if (!busy) backdrop.remove(); };
  closeBtn.addEventListener("click", close);
  cancelBtn.addEventListener("click", close);
  backdrop.addEventListener("click", (event) => { if (event.target === backdrop) close(); });
  const onEsc = (event) => {
    if (event.key === "Escape") { close(); if (!document.body.contains(backdrop)) document.removeEventListener("keydown", onEsc); }
  };
  document.addEventListener("keydown", onEsc);

  const updateDetect = () => {
    const value = input.value.trim();
    if (!value) { detect.hidden = true; confirmBtn.disabled = true; current = null; return; }
    const analysis = smartIntegrator.analyzeInput(value);
    const plan = smartIntegrator.describePlan(analysis);
    current = analysis;
    detect.hidden = false;
    detect.className = `ss-modal-detect ss-type-${analysis.type}`;
    detect.innerHTML = `<span class="ss-detect-icon">${plan.icon}</span><span class="ss-detect-text"><strong>${escapeHtml(plan.title)}</strong><small>${escapeHtml(plan.detail)}</small></span>`;
    const blocked = analysis.type === "unsupported" || analysis.type === "unknown";
    confirmBtn.disabled = blocked;
    confirmBtn.textContent = analysis.type === "full_website_domain" ? "Crawl & Add"
      : (analysis.type === "anime_series_page" || analysis.type === "anime_episode_page") ? "Fetch & Add" : "Add";
  };
  input.addEventListener("input", updateDetect);

  const setProgress = (entry) => {
    progress.hidden = false;
    const line = typeof entry === "string" ? entry : (entry && entry.message) || "";
    if (!line) return;
    const div = document.createElement("div");
    div.className = "ss-progress-line";
    div.textContent = line;
    progress.appendChild(div);
    progress.scrollTop = progress.scrollHeight;
  };

  const resolveMerge = (dup) => new Promise((resolve) => {
    detect.hidden = true;
    progress.hidden = false;
    progress.innerHTML = `<div class="ss-merge">
      <p>“${escapeHtml(dup.name || SmartSource.domainOf(dup.url || ""))}” already exists for this site.</p>
      <div class="ss-merge-actions">
        <button class="ss-btn ss-btn-primary focusable" data-ss-merge="replace">Replace</button>
        <button class="ss-btn ss-btn-ghost focusable" data-ss-merge="separate">Add separate</button>
        <button class="ss-btn ss-btn-ghost focusable" data-ss-merge="cancel">Cancel</button>
      </div></div>`;
    progress.querySelectorAll("[data-ss-merge]").forEach((button) => button.addEventListener("click", () => {
      progress.innerHTML = "";
      resolve(button.dataset.ssMerge);
    }));
  });

  confirmBtn.addEventListener("click", async () => {
    if (!current || busy) return;
    busy = true;
    confirmBtn.disabled = true; cancelBtn.disabled = true; closeBtn.disabled = true;
    input.disabled = true; detect.hidden = true;
    progress.hidden = false; progress.innerHTML = "";
    setProgress("Working…");
    try {
      const source = await smartIntegrator.addSmartSource(input.value.trim(), { onProgress: setProgress, resolveMerge });
      setProgress(`✅ Added “${source?.name || "source"}”.`);
      showToast(`Added ${source?.name || "source"}`);
      window.setTimeout(() => backdrop.remove(), 800);
    } catch (err) {
      busy = false;
      input.disabled = false; closeBtn.disabled = false; cancelBtn.disabled = false; confirmBtn.disabled = false;
      if (err.code === "CANCELLED") { progress.hidden = true; updateDetect(); return; }
      if (err.code === "CRAWLER_UNAVAILABLE") {
        setProgress("⚠️ Crawler backend isn't connected yet.");
        setProgress("Set localStorage 'zenkaitv-crawl-endpoint' to your scraper URL, or define window.ZenkaiScraper.crawl().");
        const offer = document.createElement("button");
        offer.className = "ss-btn ss-btn-primary focusable ss-offer";
        offer.textContent = "Add as basic catalog source instead";
        offer.addEventListener("click", () => {
          try { addBasicAddonSource(current.url); showToast("Source added"); backdrop.remove(); }
          catch (e2) { setProgress(`❌ ${e2.message}`); }
        });
        progress.appendChild(offer);
        return;
      }
      setProgress(`❌ ${err.message || "Could not add this source."}`);
    }
  });

  window.setTimeout(() => input.focus(), 50);
}

async function fetchAniListTrending() {
  const query = `
    query TrendingAnime($page: Int, $perPage: Int) {
      Page(page: $page, perPage: $perPage) {
        media(type: ANIME, sort: TRENDING_DESC, isAdult: false) {
          id
          idMal
          title { romaji english native }
          coverImage { extraLarge large color }
          bannerImage
          description(asHtml: false)
          episodes
          genres
          averageScore
          format
          duration
          seasonYear
          startDate { year month day }
          status
          siteUrl
          nextAiringEpisode { episode airingAt }
        }
      }
    }
  `;

  const pages = await Promise.allSettled([1, 2, 3, 4, 5, 6].map(async (page) => {
    const response = await fetchWithRetry(ANILIST_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ query, variables: { page, perPage: 50 } })
    });

    if (!response.ok) throw new Error("AniList request failed");
    const payload = await response.json();
    return payload.data.Page.media.map(normalizeAniListShow);
  }));

  return pages
    .filter((page) => page.status === "fulfilled")
    .flatMap((page) => page.value);
}

async function fetchJikanList(endpoint, source) {
  const response = await fetchWithRetry(endpoint);
  if (!response.ok) throw new Error(`${source} request failed`);
  const payload = await response.json();
  return payload.data.map((entry) => normalizeJikanShow(entry, source));
}

async function fetchJikanPages(endpoint, source, pages) {
  const pageRequests = [];
  for (let page = 1; page <= pages; page += 1) {
    const separator = endpoint.includes("?") ? "&" : "?";
    pageRequests.push(fetchJikanList(`${endpoint}${separator}page=${page}`, source));
  }
  const results = await Promise.allSettled(pageRequests);
  return results
    .filter((result) => result.status === "fulfilled")
    .flatMap((result) => result.value);
}

// fetchWithRetry and wait are defined in js/utils.js

// normalizeAniListShow, normalizeJikanShow, mergeShows, mergeEpisodes, mergeSeasons,
// getShowKey, normalizeTitle, getFranchiseKey, extractSeasonNumber, romanToNumber,
// wordSeasonToNumber, pickGenre, cleanDescription are defined in js/normalize.js and js/utils.js


function setSourceStatus(message) {
  // Catalog totals now live in Settings (not on the Home hero). Keep the latest
  // string in state so the Settings panel can show it whenever it's opened, and
  // update the live element if Settings is currently rendered.
  state.catalogStatus = message;
  const el = document.querySelector("#settingsCatalogStatus");
  if (el) el.textContent = message;
}

function catalogStatusLabel(sourceLabel, shows = []) {
  const titleCount = Array.isArray(shows) ? shows.length : 0;
  const episodeCount = countLoadedEpisodes(shows);
  return `${sourceLabel} | ${formatCount(titleCount, "title")} | ${formatCount(episodeCount, "episode")}`;
}

// formatCount, countLoadedEpisodes, getLoadedEpisodeCount, sortCarouselQuality, setDefaultLanguage
// are defined in js/utils.js and js/normalize.js




function visibleShows() {
  return state.shows.filter((show) => {
    const matchesSearch = matchesShowSearch(show);
    const matchesFilter = state.filter === "all" || show.genre === state.filter;
    return matchesSearch && matchesFilter;
  });
}

// Lowercase + strip accents so search is case/diacritic-insensitive.
function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesShowSearch(show) {
  if (!state.search) return true;
  const query = normalizeSearchText(state.search);
  if (!query) return true;
  // Search EVERY title variant (English, Romaji, Native, the title shown in the
  // UI) plus aliases/source/genre — so typing "yomi" finds "Yomi no Tsugai" even
  // though its English title is "Daemons of the Shadow Realm".
  const haystack = normalizeSearchText([
    getShowTitle(show),
    show.title,
    show.romajiTitle,
    show.nativeTitle,
    show.source,
    show.genre,
    ...(show.genres || []),
    ...(show.aliases || [])
  ].filter(Boolean).join(" "));
  // Each token must appear (partial match) so "yomi", "yomi no" and
  // "yomi tsugai" all match.
  return query.split(" ").every((token) => haystack.includes(token));
}

// ── Live AniList search ───────────────────────────────────────────────────────
// The local catalog only holds ~trending shows, so searching for anything niche
// (e.g. "Super no Ura de Yani Suu Futari") finds nothing. When the user types a
// query we also ask AniList directly and fold any new matches into the catalog so
// they show up as openable, favouritable cards — letting the user add ANY anime.
let _liveSearchTimer = null;
let _liveSearchSeq = 0;
const _liveSearchDone = new Set(); // queries already fetched this session

function queueLiveSearch(query) {
  const q = normalizeSearchText(query);
  if (q.length < 3 || _liveSearchDone.has(q)) return;
  clearTimeout(_liveSearchTimer);
  _liveSearchTimer = window.setTimeout(() => liveSearchAniList(query), 350);
}

async function liveSearchAniList(query) {
  const raw = String(query || "").trim();
  const q = normalizeSearchText(raw);
  if (q.length < 3 || _liveSearchDone.has(q)) return;
  const seq = ++_liveSearchSeq;
  try {
    const res = await fetchWithTimeout(`./api/anilist/search?q=${encodeURIComponent(raw)}`, { cache: "no-store" }, 9000);
    if (!res.ok) return;
    const json = await res.json();
    const results = Array.isArray(json.results) && json.results.length
      ? json.results
      : (json.media ? [json.media] : []);
    _liveSearchDone.add(q);                 // don't refetch the same query
    if (!results.length || seq !== _liveSearchSeq) return;
    const byKey = new Map(state.shows.map((s) => [getShowKey(s), s]));
    const added = [];
    let upgraded = false;
    for (const media of results) {
      let show;
      try { show = normalizeAniListShow(media); } catch { continue; }
      const key = getShowKey(show);
      if (!key) continue;
      const existing = byKey.get(key);
      if (existing) {
        // Repair an entry added earlier while AniList was rate-limited (no art /
        // description) by filling in the freshly-fetched high-res fields.
        if (!existing.image && show.image) { existing.image = show.image; upgraded = true; }
        if (!existing.banner && show.banner) { existing.banner = show.banner; upgraded = true; }
        if ((!existing.description || existing.description.length < 8) && show.description) { existing.description = show.description; upgraded = true; }
        continue;
      }
      byKey.set(key, show);
      show.fromSearch = true;
      added.push(show);
    }
    if (added.length) state.shows = [...state.shows, ...added];
    if ((added.length || upgraded) && state.search) render();   // surface matches immediately
    if (added.length || upgraded) {
      if (state.activeShow && getShowKey(state.activeShow)) {
        // If the open overlay shows one of these, refresh its poster too.
        const fresh = byKey.get(getShowKey(state.activeShow));
        if (fresh && !state.activeShow.image && fresh.image) state.activeShow.image = fresh.image;
      }
    }
  } catch (_) {
    // Offline / rate-limited — keep the local results already shown.
  }
}

/**
 * Absolute timestamp (ms) of when a show's most-recently-released episode aired,
 * or null if the show has no usable airing signal / nothing has aired yet.
 *
 * Prefers AniList's exact `nextAiringAt` instant (the next episode's air time) and
 * steps it back by the weekly cadence to the most recent PAST airing. Because that
 * instant is absolute (UTC-based), it is correct in the viewer's own timezone —
 * fixing late-night shows that Jikan labels "Wed 01:59" (JST) when they actually
 * drop on Tuesday for most of the world. Falls back to reconstructing from the
 * broadcast day + time strings when no airing timestamp is known.
 */
function lastEpisodeAiredMs(show, nowMs = Date.now()) {
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  // Precise path: walk the next-episode instant back to the last past airing.
  const nextAt = Number(show.nextAiringAt || 0);
  if (nextAt > 0) {
    // Nothing has aired yet if the next episode is #1.
    if (Number(show.nextAiringEpisodeNumber) === 1) return null;
    let t = nextAt;
    while (t > nowMs) t -= WEEK_MS;
    return t;
  }

  // Fallback: reconstruct from the broadcast day + time (viewer-local).
  if (!show.day || show.day === "TBA" || show.day === "Local") return null;
  const DAY_IDX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const dayNum = DAY_IDX[show.day.toLowerCase().slice(0, 3)];
  if (dayNum === undefined) return null;

  let airH = 0, airM = 0;
  if (show.time && show.time !== "TBA") {
    const m = show.time.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    if (m) {
      airH = parseInt(m[1], 10);
      airM = parseInt(m[2], 10);
      const ap = m[3]?.toLowerCase();
      if (ap === "pm" && airH !== 12) airH += 12;
      if (ap === "am" && airH === 12)  airH  = 0;
    }
  }
  const now = new Date(nowMs);
  const daysBack = (now.getDay() - dayNum + 7) % 7;
  const d = new Date(now);
  d.setDate(d.getDate() - daysBack);
  d.setHours(airH, airM, 0, 0);
  if (d.getTime() > nowMs) d.setDate(d.getDate() - 7);
  return d.getTime();
}

/**
 * Return the most recently aired shows for the carousel (up to `limit`).
 * Only currently-airing shows are considered, ranked by when their latest episode
 * actually dropped (timezone-correct via lastEpisodeAiredMs), most recent first.
 */
function recentlyAiredShows(limit = 8) {
  const nowMs = Date.now();
  const seenTitles = new Set();

  const candidates = state.shows
    .filter((show) => {
      if (!getCarouselArtwork(show)) return false;
      const status = (show.status || "").toUpperCase();
      if (status === "FINISHED" || status === "CANCELLED") return false;
      return true;
    })
    .map((show) => ({ show, lastAiredMs: lastEpisodeAiredMs(show, nowMs) }))
    // Keep only shows with a real recent airing (within ~3 weeks, generous for gaps).
    .filter((x) => x.lastAiredMs != null && (nowMs - x.lastAiredMs) <= 21 * 24 * 60 * 60 * 1000);

  // Sort most-recent first, then by score. Every candidate already has a
  // dedicated landscape banner, so portrait covers never enter the hero.
  candidates.sort((a, b) => {
    const timeDiff = b.lastAiredMs - a.lastAiredMs;
    if (timeDiff !== 0) return timeDiff;
    return Number(b.show.score || 0) - Number(a.show.score || 0);
  });

  // Deduplicate by normalised title and collect up to `limit` shows
  const result = [];
  for (const { show } of candidates) {
    const key = normalizeTitle(show.title);
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    result.push(show);
    if (result.length >= limit) break;
  }

  // If we still don't have enough, pad with high-quality airing shows
  if (result.length < limit) {
    const pad = sortCarouselQuality(
      state.shows.filter((s) => getCarouselArtwork(s) && !seenTitles.has(normalizeTitle(s.title)))
    ).slice(0, limit - result.length);
    result.push(...pad);
  }

  return result;
}

// Keep the old name as an alias so nothing else breaks
function todayShows() {
  return recentlyAiredShows(8);
}

/**
 * Shows for the Home "Latest Episodes" rail — the newest episode releases, sorted
 * so today's drops lead and the rest of the week follows in recency order. Uses
 * each currently-airing show's broadcast day + time to work out when its latest
 * episode actually dropped. Unlike the carousel pool this only needs a poster
 * (not a landscape banner), so the rail can be filled with real recent releases.
 * Honours the active search/genre filter, and pads with the rest of the catalog
 * only if there genuinely aren't enough airing titles to fill the rail.
 */
function latestEpisodeReleases(limit = HOME_CARD_LIMIT) {
  const nowMs = Date.now();
  const seenTitles = new Set();

  const ranked = state.shows
    .filter((show) => {
      if (!matchesShowSearch(show)) return false;
      if (state.filter !== "all" && show.genre !== state.filter) return false;
      if (!(show.image || show.poster || show.cover)) return false;
      const status = (show.status || "").toUpperCase();
      if (status === "FINISHED" || status === "CANCELLED" || status.includes("FINISH")) return false;
      return true;
    })
    .map((show) => ({ show, lastAiredMs: lastEpisodeAiredMs(show, nowMs) }))
    .filter((x) => x.lastAiredMs != null)
    .sort((a, b) => (b.lastAiredMs - a.lastAiredMs) || (Number(b.show.score || 0) - Number(a.show.score || 0)));

  const result = [];
  for (const { show } of ranked) {
    const key = normalizeTitle(show.title);
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    result.push(show);
    if (result.length >= limit) break;
  }

  // Pad with the rest of the (filtered) catalog so the rail is never sparse, while
  // keeping the genuinely-recent releases up front.
  if (result.length < limit) {
    for (const show of visibleShows()) {
      const key = normalizeTitle(show.title);
      if (seenTitles.has(key)) continue;
      seenTitles.add(key);
      result.push(show);
      if (result.length >= limit) break;
    }
  }

  return result;
}

// ── AnimeAV1 "Últimos Episodios" feed ─────────────────────────────────────────
// The Home "Latest Episodes" rail mirrors AnimeAV1's homepage list (same order,
// same items). Catalog shows supply rich art/metadata where the title matches;
// AnimeAV1-only entries (niche shows the AniList catalog lacks) get a lightweight
// card so the full list matches. Falls back to the airing-based order if the
// AnimeAV1 feed is unavailable.

// Compact alphanumeric key for fuzzy title/slug matching.
function av1Key(value) {
  return normalizeSearchText(String(value || "")).replace(/[^a-z0-9]+/g, "");
}

function buildCatalogKeyIndex() {
  const idx = new Map();
  for (const show of state.shows) {
    [getShowTitle(show), show.title, show.romajiTitle, show.nativeTitle, ...(show.aliases || [])]
      .filter(Boolean)
      .forEach((t) => { const k = av1Key(t); if (k && !idx.has(k)) idx.set(k, show); });
  }
  return idx;
}

function makeAv1OnlyShow(item) {
  return {
    id: `animeav1-${item.slug}`,
    title: item.title,
    romajiTitle: item.title,
    image: item.image || "",
    episode: item.episode,
    latestAiredEp: item.episode,
    nextAiringEpisodeNumber: (Number(item.episode) || 0) + 1,
    status: "RELEASING",
    source: "AnimeAV1",
    genre: "anime",
    genres: ["anime"],
    colors: ["#8a5cff", "#211942"],
    description: "",
    animeAv1Slug: item.slug,
    _av1Slug: item.slug,
    _av1Episode: item.episode
  };
}

function registerAv1Show(show) {
  if (!state.av1Shows) state.av1Shows = new Map();
  if (!state.av1Shows.has(show.id)) state.av1Shows.set(show.id, show);
}

function buildLatestEpisodesList(limit = HOME_CARD_LIMIT) {
  const av1 = state.av1Latest || [];
  if (!av1.length) return latestEpisodeReleases(limit);   // AnimeAV1 feed not loaded yet

  const idx = buildCatalogKeyIndex();
  const list = [];
  const usedIds = new Set();

  for (const item of av1) {
    const match = idx.get(av1Key(item.title)) || idx.get(av1Key(item.slug));
    let card;
    if (match) {
      // Reuse the rich catalog card but show AnimeAV1's episode number + open target.
      card = {
        ...match,
        episode: item.episode,
        latestAiredEp: item.episode,
        nextAiringEpisodeNumber: (Number(item.episode) || 0) + 1,
        status: match.status || "RELEASING",
        _av1Slug: item.slug,
        _av1Episode: item.episode
      };
    } else {
      card = makeAv1OnlyShow(item);
      registerAv1Show(card);
    }
    if (usedIds.has(card.id)) continue;
    if (!matchesShowSearch(card)) continue;
    if (state.filter !== "all" && card.genre !== state.filter) continue;
    usedIds.add(card.id);
    list.push(card);
    if (list.length >= limit) break;
  }

  // Top up with the airing-based list if the feed is short (and not searching).
  if (list.length < limit && !state.search) {
    for (const show of latestEpisodeReleases(limit)) {
      if (usedIds.has(show.id)) continue;
      usedIds.add(show.id);
      list.push(show);
      if (list.length >= limit) break;
    }
  }
  return list;
}

async function loadAnimeAv1Latest(force = false) {
  if (state.av1LatestLoading) return;
  const fresh = state.av1Latest?.length && Date.now() - (state.av1LatestAt || 0) < 5 * 60 * 1000;
  if (fresh && !force) return;
  state.av1LatestLoading = true;
  try {
    const res = await fetchWithTimeout("./api/animeav1/latest", { cache: "no-store" }, 9000);
    if (!res.ok) throw new Error(`AnimeAV1 latest HTTP ${res.status}`);
    const json = await res.json();
    if (Array.isArray(json.items) && json.items.length) {
      state.av1Latest = json.items;
      state.av1LatestAt = Date.now();
      render();   // repaint the rail in AnimeAV1 order
    }
  } catch (_) {
    // Keep the airing-based fallback ordering already on screen.
  } finally {
    state.av1LatestLoading = false;
  }
}

// Serve the best AniList cover variant. IMPORTANT: AniList's largest cover is
// served at `/cover/large/` (the `extraLarge` field returns that same URL) — there
// is NO `/cover/extraLarge/` path, so forcing it 404s every cover. We only upgrade
// the small `medium` thumbnail to `large`, which always exists.
function hqImage(url) {
  const u = String(url || "").trim();
  if (!u) return u;
  if (u.includes("anilist.co") || u.includes("anilistcdn")) {
    return u.replace("/cover/medium/", "/cover/large/");
  }
  // AnimeAV1: the /covers/ image is ~2x the resolution of the /thumbnails/ still.
  if (u.includes("cdn.animeav1.com")) {
    return u.replace("/thumbnails/", "/covers/");
  }
  return u;
}

function getCarouselArtwork(show = {}) {
  const poster = String(show.image || show.poster || show.cover || "").trim();
  const candidates = [
    show.banner,
    show.backdrop,
    show.heroImage,
    show.wideImage,
    show.landscapeImage
  ];
  return hqImage(candidates
    .map((value) => String(value || "").trim())
    .find((value) => value && value !== poster) || "");
}

// Stable hero line-up. Once a healthy set of featured shows is chosen we keep it
// fixed across background re-renders (trailers resolving, airing-data enrichment)
// so the hero never visibly reshuffles — that reshuffle was what made the title
// appear to "blink" on load and during updates.
let _carouselStableIds = [];
let _carouselPaintedId = null;

function buildStableCarouselItems(pool) {
  const MAX = 8;
  const byId = new Map(pool.map((s) => [String(s.id), s]));
  const prev = _carouselStableIds.map((id) => byId.get(id)).filter(Boolean);

  // Keep the existing line-up while most of it is still valid.
  if (prev.length >= Math.min(MAX, pool.length) && prev.length >= 3) {
    const items = prev.slice(0, MAX);
    _carouselStableIds = items.map((s) => String(s.id));
    return items;
  }

  // (Re)build: keep still-valid previous items first (so the current slide never
  // jumps), then prefer shows whose trailer has resolved, then the rest of pool.
  const withTrailer = pool.filter((s) => {
    const tr = s.anilistId ? _readTrailerCache(String(s.anilistId)) : null;
    return tr && tr.id;
  });
  const ordered = [];
  const seen = new Set();
  for (const s of [...prev, ...withTrailer, ...pool]) {
    const id = String(s.id);
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(s);
    if (ordered.length >= MAX) break;
  }
  _carouselStableIds = ordered.map((s) => String(s.id));
  return ordered;
}

// Hero backdrop: prefer a dedicated landscape banner, fall back to the poster so
// the carousel still shows real artwork when banners are missing.
function carouselArtworkOrPoster(show = {}) {
  return getCarouselArtwork(show) || String(show.image || show.poster || show.cover || "").trim();
}

function renderCarousel() {
  // On-air / recently-aired pool only (these already have landscape artwork).
  let pool = recentlyAiredShows(24).filter((s) => getCarouselArtwork(s));
  // Resilience: if nothing has a landscape banner yet (slow/rate-limited load),
  // fall back to the best poster-bearing shows so the hero never gets stuck on
  // "Loading…" while the catalog actually has content.
  if (!pool.length) {
    pool = sortCarouselQuality(state.shows.filter((s) => carouselArtworkOrPoster(s))).slice(0, 12);
  }
  // Kick off trailer lookups for the pool; re-renders when they resolve.
  ensureCarouselTrailers(pool);
  // Stable line-up so the hero doesn't reshuffle/blink when trailers or airing
  // data resolve in the background.
  const items = buildStableCarouselItems(pool);
  if (!items.length) {
    stopCarouselTrailer();
    _carouselPaintedId = null;
    carouselStage.classList.add("is-loading");
    carouselBackdrop.classList.remove("has-banner");
    carouselBackdrop.style.backgroundImage = "linear-gradient(135deg, #121733 0%, #1b1a3b 38%, #0b2637 100%)";
    carouselTitle.textContent = "Loading ZenkaiTV...";
    carouselText.textContent = "Getting the catalog ready.";
    carouselMeta.textContent = "Please wait";
    carouselOpen.removeAttribute("data-open-show");
    carouselOpen.disabled = true;
    if (carouselIndicators) carouselIndicators.innerHTML = "";
    return;
  }
  carouselStage.classList.remove("is-loading");
  carouselOpen.disabled = false;
  if (state.carouselIndex >= items.length) state.carouselIndex = 0;
  if (state.carouselIndex < 0) state.carouselIndex = items.length - 1;
  const show = items[state.carouselIndex];

  // Keep the indicator strip in sync (cheap), but skip the heavy title / backdrop
  // / trailer repaint when the displayed anime hasn't actually changed. Repainting
  // identical content on every background render is what made the hero "blink".
  renderCarouselIndicators(items);
  if (String(show.id || "") === _carouselPaintedId) return;
  _carouselPaintedId = String(show.id || "");

  const art = carouselArtworkOrPoster(show);
  carouselBackdrop.classList.toggle("has-banner", Boolean(art));
  carouselBackdrop.style.backgroundImage = art
    ? `url("${art}")`
    : "linear-gradient(135deg, #121733 0%, #1b1a3b 38%, #0b2637 100%)";
  carouselTitle.textContent = getShowTitle(show);
  carouselText.textContent = simpleCarouselText(show);
  carouselMeta.textContent = [show.day, show.time, (show.genre || "").toUpperCase()].filter(Boolean).join(" | ");
  const target = getCardTarget(show);
  carouselOpen.dataset.openShow = String(show.id || "");
  carouselOpen.dataset.openSeason = String(target.seasonNumber || "");
  carouselOpen.dataset.openEpisode = String(target.episodeNumber || "");
  carouselStage.dataset.openShow = String(show.id || "");
  // Show the cover for a beat, then play this anime's trailer (stops on move).
  scheduleCarouselTrailer(show);
}

function renderCarouselIndicators(items) {
  if (!carouselIndicators) return;
  carouselIndicators.innerHTML = items.slice(0, 8).map((show, index) => `
    <button class="carousel-dot focusable ${index === state.carouselIndex ? "is-selected" : ""}" data-carousel-index="${index}" aria-label="Show ${escapeHtml(getShowTitle(show))}">
      ${carouselArtworkOrPoster(show) ? `<img src="${carouselArtworkOrPoster(show)}" alt="">` : "<span></span>"}
    </button>
  `).join("");

  carouselIndicators.querySelectorAll("[data-carousel-index]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      state.carouselIndex = Number(button.dataset.carouselIndex);
      carouselStage.classList.add("is-changing");
      window.setTimeout(() => carouselStage.classList.remove("is-changing"), 420);
      renderCarousel();
      restartCarouselTimer();
    });
  });
}

function simpleCarouselText(show) {
  const clean = show.description || "Featured pick from today's anime lineup.";
  // Word-safe truncation (no mid-word cuts like "...No").
  return cleanDescription(clean, 150);
}

// Never show a broken-image icon. When a poster/backdrop/watch image fails to
// load (404, hotlink-blocked, stale URL), hide it so the card's colour gradient
// shows through, and drop a clean placeholder into the watch overlay. Uses the
// capture phase because `error` events don't bubble.
document.addEventListener("error", (event) => {
  const img = event.target;
  if (!(img instanceof HTMLImageElement) || img.dataset.imgFallback) return;
  img.dataset.imgFallback = "1";
  if (img.classList.contains("watch-poster")) {
    img.style.display = "none";
    const wrap = img.closest(".watch-ready-poster-wrap");
    if (wrap && !wrap.querySelector(".watch-poster-placeholder")) {
      const ph = document.createElement("div");
      ph.className = "watch-poster-placeholder";
      ph.innerHTML = '<div class="play-symbol" aria-hidden="true"></div>';
      wrap.appendChild(ph);
    }
  } else if (img.classList.contains("thumb-poster") || img.classList.contains("thumb-backdrop") || img.closest(".carousel-dot")) {
    img.style.visibility = "hidden";   // reveal the card's gradient placeholder
  }
}, true);

function moveCarousel(step) {
  state.carouselIndex += step;
  carouselStage.classList.remove("is-changing", "is-prev", "is-next");
  window.requestAnimationFrame(() => {
    carouselStage.classList.add("is-changing", step < 0 ? "is-prev" : "is-next");
    window.setTimeout(() => carouselStage.classList.remove("is-changing", "is-prev", "is-next"), 520);
  });
  renderCarousel();
  restartCarouselTimer();
}

function restartCarouselTimer() {
  window.clearInterval(carouselTimer);
  if (!state.uiPreferences.autoplayHero) return;
  // Longer dwell so each slide can show its cover, then play a chunk of the
  // trailer before auto-advancing to the next anime.
  carouselTimer = window.setInterval(() => {
    if (!overlay.hidden) return;
    if (state.route !== "home") return;
    moveCarousel(1);
  }, CAROUSEL_ADVANCE_MS);
}

// ── Hero trailer playback ────────────────────────────────────────────────────
// Each carousel slide shows the cover image for a beat, then auto-plays the
// anime's trailer (muted) over the backdrop. Any slide change / leaving home /
// opening a show stops the current trailer. Trailers come from AniList and are
// only fetched for the on-air carousel pool (≤ a couple dozen ids), then cached.

const CAROUSEL_IMAGE_HOLD_MS = 2600;   // show the cover this long before the video
const CAROUSEL_ADVANCE_MS    = 15000;  // auto-advance dwell per slide
const _trailerCache = new Map();       // anilistId(str) -> {id, site} | null | undefined
const _TRAILER_LS_PREFIX = "zenkaitv-trailer:";
let _carouselTrailerTimer = null;
let _carouselTrailerEl = null;
let _trailerFetchInFlight = false;

function _readTrailerCache(id) {
  const key = String(id);
  if (_trailerCache.has(key)) return _trailerCache.get(key);
  try {
    const raw = localStorage.getItem(_TRAILER_LS_PREFIX + key);
    if (raw !== null) { const v = JSON.parse(raw); _trailerCache.set(key, v); return v; }
  } catch { /* storage may be unavailable */ }
  return undefined; // not yet known
}

function _writeTrailerCache(id, value) {
  const key = String(id);
  _trailerCache.set(key, value);
  try { localStorage.setItem(_TRAILER_LS_PREFIX + key, JSON.stringify(value)); } catch { /* ignore */ }
}

async function fetchAniListTrailers(ids) {
  const need = [...new Set(ids.map(String))].filter((id) => _readTrailerCache(id) === undefined);
  if (!need.length || _trailerFetchInFlight) return;
  _trailerFetchInFlight = true;
  const query = `query($ids:[Int]){ Page(perPage:50){ media(id_in:$ids, type:ANIME){ id trailer{ id site } } } }`;
  try {
    const res = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ query, variables: { ids: need.map(Number) } })
    });
    if (!res.ok) { need.forEach((id) => _writeTrailerCache(id, null)); return; }
    const json = await res.json();
    const media = json?.data?.Page?.media || [];
    const seen = new Set();
    media.forEach((m) => {
      seen.add(String(m.id));
      const tr = m.trailer && m.trailer.id
        ? { id: m.trailer.id, site: String(m.trailer.site || "youtube").toLowerCase() }
        : null;
      _writeTrailerCache(m.id, tr);
    });
    need.forEach((id) => { if (!seen.has(id)) _writeTrailerCache(id, null); });
  } catch {
    need.forEach((id) => _writeTrailerCache(id, null));
  } finally {
    _trailerFetchInFlight = false;
  }
}

function ensureCarouselTrailers(pool) {
  const ids = pool.filter((s) => s.anilistId).map((s) => String(s.anilistId));
  const unknown = ids.filter((id) => _readTrailerCache(id) === undefined);
  if (!unknown.length) return;
  fetchAniListTrailers(unknown).then(() => {
    if (state.route === "home" && overlay.hidden) renderCarousel();
  });
}

function trailerEmbedUrl(trailer) {
  if (!trailer || !trailer.id) return "";
  if (trailer.site === "dailymotion") {
    return `https://www.dailymotion.com/embed/video/${encodeURIComponent(trailer.id)}?autoplay=1&mute=1&controls=0&ui-logo=0&ui-start-screen-info=0&queue-enable=0`;
  }
  // default: YouTube (privacy-enhanced, muted, looping, chrome-free).
  // enablejsapi lets us listen for onError so non-embeddable videos fall back
  // to the cover image instead of showing YouTube's error screen.
  const id = encodeURIComponent(trailer.id);
  return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=1&controls=0&loop=1&playlist=${id}&modestbranding=1&playsinline=1&rel=0&iv_load_policy=3&disablekb=1&fs=0&enablejsapi=1`;
}

let _carouselTrailerMsgHandler = null;
let _carouselTrailerRevealTimer = null;

function stopCarouselTrailer() {
  if (_carouselTrailerTimer) { window.clearTimeout(_carouselTrailerTimer); _carouselTrailerTimer = null; }
  if (_carouselTrailerRevealTimer) { window.clearTimeout(_carouselTrailerRevealTimer); _carouselTrailerRevealTimer = null; }
  if (_carouselTrailerMsgHandler) { window.removeEventListener("message", _carouselTrailerMsgHandler); _carouselTrailerMsgHandler = null; }
  if (_carouselTrailerEl) { _carouselTrailerEl.remove(); _carouselTrailerEl = null; }
  carouselStage?.classList.remove("is-trailer-playing");
}

function scheduleCarouselTrailer(show) {
  stopCarouselTrailer();
  if (!state.uiPreferences.autoplayHero) return;      // "Hero autoplay" setting governs this
  if (!state.uiPreferences.motion) return;            // respect reduce-motion preference
  if (!show || !show.anilistId) return;
  const trailer = _readTrailerCache(String(show.anilistId));
  if (!trailer || !trailer.id) return;
  const slideId = String(show.id || "");
  _carouselTrailerTimer = window.setTimeout(() => {
    // Only start if we're still on the same slide, on home, with no show open.
    if (state.route !== "home" || !overlay.hidden) return;
    if (String(carouselStage?.dataset.openShow || "") !== slideId) return;
    const url = trailerEmbedUrl(trailer);
    if (!url || !carouselBackdrop) return;
    const wrap = document.createElement("div");
    wrap.className = "carousel-trailer";
    wrap.setAttribute("aria-hidden", "true");
    const frame = document.createElement("iframe");
    frame.src = url;
    frame.title = "";
    frame.tabIndex = -1;
    frame.setAttribute("frameborder", "0");
    frame.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture");
    wrap.appendChild(frame);
    carouselBackdrop.insertAdjacentElement("afterend", wrap);
    _carouselTrailerEl = wrap;

    // IMPORTANT: do NOT reveal the iframe yet — a loading YouTube/Dailymotion
    // iframe paints solid black, and fading that in over the hero is the
    // "whole screen blinks black" glitch. Keep it invisible (opacity 0) until
    // the video is actually playing, then fade in.
    const reveal = () => {
      if (_carouselTrailerEl !== wrap) return;            // slide changed already
      carouselStage.classList.add("is-trailer-playing");
    };

    if (trailer.site !== "dailymotion") {
      frame.addEventListener("load", () => {
        try {
          frame.contentWindow.postMessage(
            JSON.stringify({ event: "listening", id: 1, channel: "widget" }), "*"
          );
        } catch { /* cross-origin handshake best-effort */ }
      });
      _carouselTrailerMsgHandler = (e) => {
        if (typeof e.origin !== "string" || !/youtube\.com|youtube-nocookie\.com/.test(e.origin)) return;
        let data;
        try { data = typeof e.data === "string" ? JSON.parse(e.data) : e.data; } catch { return; }
        if (!data) return;
        if (data.event === "onError") { stopCarouselTrailer(); return; }
        // playerState 1 = PLAYING → safe to fade in (real frames are showing).
        const playerState = data.event === "onStateChange" ? data.info
          : (data.event === "infoDelivery" ? data.info?.playerState : undefined);
        if (playerState === 1) reveal();
      };
      window.addEventListener("message", _carouselTrailerMsgHandler);
    }

    // Fallback reveal in case playback events never arrive (Dailymotion, blocked
    // postMessage, etc.) — by now the iframe has had time to render real frames.
    _carouselTrailerRevealTimer = window.setTimeout(reveal, 2200);
  }, CAROUSEL_IMAGE_HOLD_MS);
}

function cardTemplate(show, index = 0) {
  const isFavorite = state.favorites.includes(show.id);
  const colors = Array.isArray(show.colors) && show.colors.length >= 2 ? show.colors : ["#00d2ff", "#251d47"];
  const title = escapeHtml(getShowTitle(show));
  const artStyle = `--thumb-a: ${colors[0]}; --thumb-b: ${colors[1]}`;
  const meta = cardMeta(show, isFavorite);
  const target = getCardTarget(show);
  const rawPoster = show.image || "";
  const posterUrl = hqImage(rawPoster);
  // If the upgraded URL 404s, fall back to the original before giving up.
  const onErr = posterUrl && posterUrl !== rawPoster
    ? ` onerror="this.onerror=null;this.src='${escapeHtml(rawPoster)}'"`
    : "";
  const image = posterUrl
    ? `
        <img class="thumb-backdrop" src="${escapeHtml(posterUrl)}" alt="" loading="lazy"${onErr}>
        <img class="thumb-poster" src="${escapeHtml(posterUrl)}" alt="" loading="lazy"${onErr}>
      `
    : "";
  return `
    <button class="show-card focusable" style="--card-index: ${index}" data-open-show="${escapeHtml(show.id)}" data-open-season="${target.seasonNumber}" data-open-episode="${target.episodeNumber}" aria-label="Open ${title}">
      <span class="thumb-art" style="${artStyle}">
        ${image}
        <span class="episode-pill">${cardEpisodeLabel(show)}</span>
      </span>
      <span>
        <span class="show-title">${title}</span>
        <span class="show-meta">${escapeHtml(meta)}</span>
      </span>
    </button>
  `;
}

// Episode number to SHOW on a card/badge: for airing series this is the latest
// AIRED episode (not the planned total — Jikan overwrites that in the merge),
// for finished series it's the real total. Falls back gracefully.
function cardEpisodeNumber(show = {}) {
  const status = String(show.status || "").toUpperCase();
  // "RELEASING" (AniList) / "Currently Airing" (Jikan) = airing. Must NOT match
  // "Finished Airing", so don't use a loose includes("AIRING").
  const airing = status.includes("RELEASING") || status.includes("CURRENTLY AIRING") || status === "AIRING";
  const latest = Number(show.latestAiredEp || show.latestAiredEpisode || 0);
  const next   = Number(show.nextAiringEpisodeNumber || show.nextAiringEp || 0);
  const total  = Number(show.totalEpisodes || show.episodeCount || show.episodesCount || 0);
  const ep     = Number(show.episode);
  if (airing) {
    if (Number.isFinite(latest) && latest > 0) return latest;
    if (Number.isFinite(next) && next > 1) return next - 1;
    return 0; // aired count unknown — don't show the planned total
  }
  if (Number.isFinite(total) && total > 0) return total;
  if (Number.isFinite(ep) && ep > 0) return ep;
  if (Number.isFinite(latest) && latest > 0) return latest;
  return 0;
}

function cardEpisodeLabel(show = {}) {
  const n = cardEpisodeNumber(show);
  return n > 0 ? `EP ${n}` : "TV";
}

function getCardTarget(show) {
  const seasonNumber = extractSeasonNumber(show.title, 1);
  const episodeNumber = cardEpisodeNumber(show);
  return {
    seasonNumber,
    episodeNumber: episodeNumber > 0 ? episodeNumber : ""
  };
}

function cardMeta(show, isFavorite = false) {
  const pieces = [show.genre?.toUpperCase()].filter(Boolean);
  if (show.score) pieces.push(`${show.score}%`);
  const epLabel = cardEpisodeLabel(show);
  if (epLabel !== "TV") pieces.push(epLabel);
  if (isFavorite) pieces.push("FAVORITE");
  return pieces.join(" | ");
}

function renderCards(container, list) {
  if (!container) return;
  // Skip redundant repaints. render() runs on many background events (catalog
  // enrichment, trailer lookups, route syncs); re-writing identical cards replays
  // the staggered entrance animation and reloads every <img>, which reads as a
  // flash/"blink". Only touch the DOM when the cards (order + badge + favourite
  // state) actually change.
  const signature = list
    .map((show) => `${show.id}:${cardEpisodeLabel(show)}:${state.favorites.includes(show.id) ? 1 : 0}`)
    .join("|");
  if (container.dataset.cardsSig === signature) return;
  container.dataset.cardsSig = signature;
  container.classList.remove("is-skeleton-loading");
  container.innerHTML = list.map((show, index) => cardTemplate(show, index)).join("");
}

function renderSkeletonCards(container, count = 7) {
  if (!container) return;
  container.dataset.cardsSig = "";   // force the next real render to repaint
  container.classList.add("is-skeleton-loading");
  container.innerHTML = Array.from({ length: count }, (_, index) => `
    <div class="show-card skeleton-card" style="--card-index: ${index}" aria-hidden="true">
      <span class="thumb-art"></span>
      <span>
        <span class="show-title"></span>
        <span class="show-meta"></span>
      </span>
    </div>
  `).join("");
}

function renderSchedule() {
  // Fixed Mon → Sun order
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  // Only shows with a confirmed weekly broadcast day AND an active airing status.
  // Exclude anything AniList/Jikan marks as FINISHED or CANCELLED — these are
  // completed series that still have a stored broadcast day (e.g. Naruto, HxH).
  const airingShows = (() => {
    const seen = new Map();
    [...state.shows]
      .filter((show) => {
        if (!show.day || show.day === "TBA" || show.day === "Local") return false;
        const status = (show.status || "").toUpperCase();
        // Exclude shows that have definitively ended
        if (status === "FINISHED" || status === "CANCELLED") return false;
        if (status.includes("FINISH")) return false; // catches "Finished Airing" from MAL
        return true;
      })
      .sort((a, b) => {
        const hasEp = (s) => s.episode && s.episode !== "?" ? 1 : 0;
        return hasEp(b) - hasEp(a);
      })
      .forEach((show) => {
        const key = normalizeTitle(show.title);
        if (!seen.has(key)) {
          seen.set(key, show);
        } else {
          const existing = seen.get(key);
          const betterTime = show.time && !existing.time;
          const betterImg = show.image && !existing.image;
          if (betterTime || betterImg) seen.set(key, { ...existing, ...show, id: existing.id });
        }
      });
    return [...seen.values()];
  })();

  // Highlight the current weekday. getDay() is 0=Sun..6=Sat; our columns run
  // Mon..Sun, so shift by 6 to line up.
  const todayIdx = (new Date().getDay() + 6) % 7;

  scheduleList.innerHTML = days.map((day, idx) => {
    const isToday = idx === todayIdx;
    const shows = airingShows
      .filter((show) => show.day?.toLowerCase().startsWith(day.toLowerCase()))
      .slice(0, 12);
    return `
      <section class="schedule-day-column${isToday ? " is-today" : ""}"${isToday ? ' aria-current="date"' : ""}>
        <h3>${fullDayName(day)}${isToday ? '<span class="schedule-today-badge">Today</span>' : ""}</h3>
        <div class="schedule-day-rail">
          ${shows.length ? shows.map((show) => `
            <button class="schedule-item focusable" data-open-show="${escapeHtml(show.id)}" data-open-season="${getCardTarget(show).seasonNumber}" data-open-episode="${getCardTarget(show).episodeNumber}">
              <span class="schedule-thumb">
                ${show.image ? `<img src="${escapeHtml(show.image)}" alt="" loading="lazy">` : ""}
                <span>${cardEpisodeLabel(show)}</span>
              </span>
              <span class="schedule-copy">
                <span class="schedule-title">${escapeHtml(getShowTitle(show))}</span>
                <span class="show-meta">${show.time ? escapeHtml(show.time) : "TBA"}${show.source ? ` · ${escapeHtml(show.source)}` : ""}</span>
              </span>
            </button>
          `).join("") : `<p class="schedule-empty">No new episodes</p>`}
        </div>
      </section>
    `;
  }).join("");
}

function renderAniPubCatalog() {
  if (!anipubGrid) return;
  const section = getAniPubSection();
  const filtered = (section.items || []).filter((show) => {
    const matchesSearch = matchesShowSearch(show);
    const matchesFilter = state.filter === "all" || show.genre === state.filter;
    return matchesSearch && matchesFilter;
  });
  renderCards(anipubGrid, filtered);
  if (anipubSummary) {
    const total = section.totalResults || filtered.length;
    anipubSummary.textContent = `${filtered.length}${total ? ` of ${total}` : ""} available`;
  }
}

async function ensureAniPubCatalogLoaded() {
  const section = getAniPubSection();
  if (state.anipubLoading || section.items?.length) return section;
  state.anipubLoading = true;
  if (anipubGrid) renderSkeletonCards(anipubGrid, 14);
  if (anipubSummary) anipubSummary.textContent = "Loading AniPub...";
  try {
    const source = getAniPubSource();
    const catalog = await timedRequest("AniPub catalog", () => fetchExternalCatalogData(source));
    const loadedSection = {
      id: source.id,
      name: source.name || source.id,
      type: source.type || "online-addon",
      items: catalog.items,
      source,
      page: catalog.page,
      nextPage: catalog.nextPage,
      hasMore: catalog.hasMore,
      totalResults: catalog.totalResults,
      paginated: Boolean(source.paginated || catalog.nextPage || catalog.hasMore)
    };
    state.addonSections = [
      ...state.addonSections.filter((entry) => entry.id !== loadedSection.id),
      loadedSection
    ];
    render();
    return loadedSection;
  } catch (error) {
    if (anipubSummary) anipubSummary.textContent = "AniPub unavailable";
    return section;
  } finally {
    state.anipubLoading = false;
  }
}

function anipubCatalogItems() {
  const sectionItems = getAniPubSection().items || [];
  const cachedItems = Array.isArray(anipubCatalogCache?.items)
    ? anipubCatalogCache.items
    : Array.isArray(anipubCatalogCache)
      ? anipubCatalogCache
      : [];
  return sectionItems.length >= cachedItems.length ? sectionItems : cachedItems;
}

function animeTitleCandidates(showOrTitle) {
  if (typeof showOrTitle === "string") return [showOrTitle];
  // Cross-match on EVERY title variant — a show opened under its English title
  // ("Behind the Supermarket, Smoking") must still match a source listed under its
  // romaji ("Super no Ura de Yani Suu Futari"), so playback servers from added
  // sources (jkanime crawl, AniPub, etc.) attach regardless of which title shows.
  return [
    showOrTitle?.title,
    showOrTitle?.romajiTitle,
    showOrTitle?.nativeTitle,
    showOrTitle?.englishTitle,
    showOrTitle?.romaji,
    showOrTitle?.name,
    ...(showOrTitle?.aliases || [])
  ].filter(Boolean);
}

function normalizeMatchTitle(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(season|part|cour)\s*\d+\b/g, " ")
    .replace(/\b\d+(st|nd|rd|th)\s*season\b/g, " ")
    .replace(/\bseason\s*[ivxlcdm]+\b/g, " ")
    .replace(/\b(that time i got reincarnated as a slime)\b/g, "tensei shitara slime datta ken")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchAnimeTitle(mainTitle, anipubTitle) {
  const normalizedMain = normalizeMatchTitle(mainTitle);
  const normalizedAnipub = normalizeMatchTitle(anipubTitle);
  if (!normalizedMain || !normalizedAnipub) return false;
  return normalizedMain.includes(normalizedAnipub)
    || normalizedAnipub.includes(normalizedMain)
    || normalizedMain.split(" ").slice(0, 3).join(" ") === normalizedAnipub.split(" ").slice(0, 3).join(" ");
}

function titleMatchScore(show, candidate) {
  const mainTitles = animeTitleCandidates(show);
  const candidateTitles = animeTitleCandidates(candidate);
  const mainSeason = extractSeasonNumber(show.title, 1);
  const candidateSeason = extractSeasonNumber(candidate.title, 1);
  let best = 0;
  mainTitles.forEach((mainTitle) => {
    candidateTitles.forEach((candidateTitle) => {
      const main = normalizeMatchTitle(mainTitle);
      const ani = normalizeMatchTitle(candidateTitle);
      if (!main || !ani) return;
      if (main === ani) best = Math.max(best, 100);
      else if (main.includes(ani) || ani.includes(main)) best = Math.max(best, 80);
      else if (matchAnimeTitle(mainTitle, candidateTitle)) best = Math.max(best, 60);
    });
  });
  if (best && mainSeason === candidateSeason) best += 12;
  if (best && mainSeason !== candidateSeason && /season|part|\d+(st|nd|rd|th)/i.test(show.title)) best -= 18;
  return best;
}

function findAniPubShowForTitle(showOrTitle) {
  const items = anipubCatalogItems();
  const ranked = items
    .map((item) => ({ item, score: titleMatchScore(typeof showOrTitle === "string" ? { title: showOrTitle } : showOrTitle, item) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.item || null;
}

function debugAniPubMatch(showOrTitle) {
  const sourceShow = typeof showOrTitle === "string" ? { title: showOrTitle } : showOrTitle;
  return anipubCatalogItems()
    .map((item) => ({ title: item.title, id: item.id, score: titleMatchScore(sourceShow, item) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

async function loadAnipubCatalogInBackground() {
  if (anipubCatalogCache || anipubCatalogLoadingPromise) return anipubCatalogLoadingPromise;
  anipubCatalogLoadingPromise = (async () => {
    try {
      const source = { ...getAniPubSource(), endpoint: ANIPUB_FULL_CATALOG_ENDPOINT, pageSize: 12000 };
      const catalog = await timedRequest("AniPub full catalog", () => fetchExternalCatalogData(source));
      anipubCatalogCache = catalog;
      writeResponseCache("anipub-full-catalog", catalog);
      if (!getAniPubSection().items?.length) {
        state.addonSections = [
          ...state.addonSections.filter((entry) => entry.id !== source.id),
          {
            id: source.id,
            name: source.name || "AniPub",
            type: source.type || "online-addon",
            items: catalog.items,
            source,
            page: catalog.page,
            nextPage: catalog.nextPage,
            hasMore: catalog.hasMore,
            totalResults: catalog.totalResults,
            paginated: Boolean(catalog.hasMore || catalog.nextPage)
          }
        ];
        if (state.route === "anipub") render();
      }
      console.log(`AniPub catalog loaded: ${catalog.items.length} anime`);
    } catch (error) {
      console.warn("Failed to load AniPub catalog:", error);
    } finally {
      anipubCatalogLoadingPromise = null;
    }
  })();
  return anipubCatalogLoadingPromise;
}

async function loadAniPubUntilMatch(title, maxPages = 10) {
  await waitForAniPubCatalog(2000);
  await ensureAniPubCatalogLoaded();
  let match = findAniPubShowForTitle(title);
  if (match) return match;
  const section = getAniPubSection();
  for (let attempt = 0; section.hasMore && attempt < maxPages; attempt += 1) {
    await loadMoreAddonSection(section);
    match = findAniPubShowForTitle(title);
    if (match) return match;
  }
  return null;
}

async function waitForAniPubCatalog(timeoutMs = 2000) {
  if (anipubCatalogCache) return;
  if (!anipubCatalogLoadingPromise) loadAnipubCatalogInBackground();
  const start = Date.now();
  while (!anipubCatalogCache && Date.now() - start < timeoutMs) {
    await wait(100);
  }
}

function getAniPubEpisodeFallbackKey(show, episode, seasonNumber = 1) {
  const title = normalizeMatchTitle(show?.title || show || "unknown");
  const episodeNumber = Number(episode?.episode || episode?.number || episode || 1) || 1;
  return `${ANIPUB_EPISODE_FALLBACK_PREFIX}${title}:s${Number(seasonNumber) || 1}:e${episodeNumber}`;
}

function readAniPubEpisodeFallback(key) {
  try {
    const cached = JSON.parse(localStorage.getItem(key) || "null");
    if (!cached || cached.expiry <= Date.now()) {
      localStorage.removeItem(key);
      return null;
    }
    return cached;
  } catch (error) {
    localStorage.removeItem(key);
    return null;
  }
}

function writeAniPubEpisodeFallback(key, payload) {
  localStorage.setItem(key, JSON.stringify({
    ...payload,
    catalogSize: anipubCatalogItems().length,
    expiry: Date.now() + ANIPUB_EPISODE_FALLBACK_TTL
  }));
}

function getAniPubEpisodeCache(id) {
  const key = String(id || "");
  const memory = anipubEpisodesCache.get(key);
  if (memory?.expiry > Date.now()) return memory.payload;
  if (memory) anipubEpisodesCache.delete(key);
  try {
    const cached = JSON.parse(localStorage.getItem(`${ANIPUB_EPISODE_FALLBACK_PREFIX}list:${key}`) || "null");
    if (!cached?.expiry || cached.expiry <= Date.now()) {
      localStorage.removeItem(`${ANIPUB_EPISODE_FALLBACK_PREFIX}list:${key}`);
      return null;
    }
    anipubEpisodesCache.set(key, cached);
    return cached.payload;
  } catch (error) {
    localStorage.removeItem(`${ANIPUB_EPISODE_FALLBACK_PREFIX}list:${key}`);
    return null;
  }
}

function setAniPubEpisodeCache(id, payload) {
  const key = String(id || "");
  const cached = {
    payload,
    expiry: Date.now() + ANIPUB_EPISODE_FALLBACK_TTL
  };
  anipubEpisodesCache.set(key, cached);
  try {
    localStorage.setItem(`${ANIPUB_EPISODE_FALLBACK_PREFIX}list:${key}`, JSON.stringify(cached));
  } catch (error) {
    // Offline fallback is best-effort on TV browsers.
  }
}


function getLanguagePreferences() {
  try {
    const preferences = JSON.parse(localStorage.getItem(LANGUAGE_PREFERENCES_KEY) || "null");
    return {
      audio: preferences?.audio || "japanese",
      subtitles: preferences?.subtitles || "spanish"
    };
  } catch (error) {
    return { audio: "japanese", subtitles: "spanish" };
  }
}

function getAvailableAudioTracks(episode = {}) {
  const values = [
    episode.audioTracks,
    episode.audio,
    episode.audios,
    episode.languages
  ].find((value) => Array.isArray(value) || typeof value === "string");
  const tracks = Array.isArray(values) ? values : values ? [values] : [];
  const normalized = tracks.map(normalizeLanguagePreference).filter(Boolean);
  return [...new Set(["japanese", ...normalized, "spanish", "english"])];
}

function getAvailableSubtitles(episode = {}) {
  const tracks = normalizeSubtitleTracks(episode);
  const normalized = tracks
    .map((track) => normalizeLanguagePreference(track.language || track.label))
    .filter(Boolean);
  const extra = [episode.subtitles, episode.subs, episode.captions]
    .flatMap((value) => Array.isArray(value) ? value : value ? [value] : [])
    .map((value) => normalizeLanguagePreference(typeof value === "string" ? value : value.language || value.lang || value.label || value.name))
    .filter(Boolean);
  return [...new Set(["spanish", "spanish-translated", ...normalized, ...extra, "english", "none"])];
}

function normalizeLanguagePreference(value) {
  const text = String(value || "").toLowerCase();
  if (/\b(ja|jp|jpn|japanese|japon[eé]s)\b/.test(text)) return "japanese";
  if (/\b(es|spa|spanish|español|castellano)\b/.test(text)) return "spanish";
  if (/spanish-translated|translated-spanish|es-translated/.test(text)) return "spanish-translated";
  if (/\b(en|eng|english|ingl[eé]s)\b/.test(text)) return "english";
  if (text === "none") return "none";
  return "";
}

function languageOptionLabel(value, type = "audio") {
  const names = {
    japanese: type === "audio" ? t("japaneseAudio") : "Japanese Subtitles",
    spanish: type === "audio" ? t("spanishAudio") : t("spanishSubtitles"),
    "spanish-translated": t("translatedSpanishSubtitles"),
    english: type === "audio" ? t("englishAudio") : t("englishSubtitles"),
    none: t("noSubtitles")
  };
  return names[value] || value;
}

function getAniPubEpisodeList(matched) {
  if (!matched) return [];
  const cacheKey = matched.aniPubId || matched.id;
  const cached = getAniPubEpisodeCache(cacheKey);
  if (cached?.length) return cached;
  if (!anipubEpisodesCache.has(cacheKey)) {
    const seasons = matched.seasons?.length ? matched.seasons : groupEpisodesBySeason(matched.episodes || []);
    const episodes = seasons.flatMap((season) =>
      (season.episodes || []).map((episode) => ({
        ...episode,
        season: episode.season || season.season || 1
      }))
    );
    setAniPubEpisodeCache(cacheKey, episodes);
  }
  return anipubEpisodesCache.get(cacheKey)?.payload || [];
}

function findAniPubEpisode(matched, episodeNumber, seasonNumber = 1) {
  const episodes = getAniPubEpisodeList(matched);
  const exact = episodes.find((entry) =>
    Number(entry.episode || entry.number) === Number(episodeNumber)
    && Number(entry.season || 1) === Number(seasonNumber || 1)
  );
  return exact || episodes.find((entry) => Number(entry.episode || entry.number) === Number(episodeNumber));
}

async function resolveEpisodeWithAniPubFallback(show, episode) {
  if (!show || !episode) return null;
  await waitForAniPubCatalog(5000);
  let matched = findAniPubShowForTitle(show);
  if (!matched) matched = await loadAniPubUntilMatch(show.title);
  console.log(`Searching AniPub for: "${show.title}"`);
  console.log(`Found match: ${matched?.title || "none"}`);
  if (!matched) return null;

  const episodeNumber = Number(episode.episode || episode.number);
  const targetEpisode = findAniPubEpisode(matched, episodeNumber, episode.season || 1);
  console.log(`Episode ${episodeNumber} externalUrl: ${targetEpisode?.externalUrl || targetEpisode?.streamResolver?.endpoint || ""}`);
  if (!targetEpisode?.streamResolver && !targetEpisode?.externalUrl) return null;
  return {
    streamResolver: targetEpisode.streamResolver,
    externalUrl: targetEpisode.externalUrl,
    externalType: targetEpisode.externalType || (targetEpisode.externalUrl ? "iframe" : ""),
    source: "AniPub",
    match: matched
  };
}

async function resolveEpisodeWithFallback(show, episode, seasonNumber = 1) {
  const directUrl = getEpisodeUrl(episode);
  if (directUrl) return { type: "direct", url: directUrl };
  if (!show || !episode || isAniPubShow(show)) return { type: "none" };

  const cacheKey = getAniPubEpisodeFallbackKey(show, episode, seasonNumber);
  const cached = readAniPubEpisodeFallback(cacheKey);
  if (cached) {
    if (cached.found && cached.externalUrl) {
      episode.externalUrl = cached.externalUrl;
      episode.externalType = "iframe";
      episode.server = "via AniPub";
      episode.viaAniPub = true;
      episode.locked = false;
      addEpisodeSourceOption(episode, {
        id: "anipub",
        label: "AniPub",
        type: "iframe",
        externalUrl: cached.externalUrl
      });
      return { type: "iframe", externalUrl: cached.externalUrl, source: "AniPub" };
    }
    const currentCatalogSize = anipubCatalogItems().length;
    if (cached.catalogSize >= 1000 && currentCatalogSize <= cached.catalogSize) return { type: "none" };
    localStorage.removeItem(cacheKey);
  }

  await waitForAniPubCatalog(anipubCatalogItems().length >= 1000 ? 1000 : 9000);
  let matched = findAniPubShowForTitle(show);
  if (!matched) matched = await loadAniPubUntilMatch(show.title, 20);
  console.log(`Searching AniPub for: "${show.title}"`);
  console.log(`Found match: ${matched?.title || "none"}`);
  if (!matched) console.log("AniPub top candidates:", debugAniPubMatch(show));
  if (!matched) {
    if (anipubCatalogCache || getAniPubSection().items?.length) writeAniPubEpisodeFallback(cacheKey, { found: false });
    const anime1vFallback = await resolveEpisodeWithAnime1vFallback(show, episode, seasonNumber);
    return anime1vFallback.type !== "none" ? anime1vFallback : { type: "none" };
  }

  const episodeNumber = Number(episode.episode || episode.number || 1);
  const targetEpisode = findAniPubEpisode(matched, episodeNumber, seasonNumber);
  console.log(`Episode ${episodeNumber} externalUrl: ${targetEpisode?.externalUrl || targetEpisode?.streamResolver?.endpoint || ""}`);
  if (!targetEpisode) {
    writeAniPubEpisodeFallback(cacheKey, { found: false });
    const anime1vFallback = await resolveEpisodeWithAnime1vFallback(show, episode, seasonNumber);
    return anime1vFallback.type !== "none" ? anime1vFallback : { type: "none" };
  }

  if (targetEpisode.externalUrl) {
    episode.externalUrl = targetEpisode.externalUrl;
    episode.externalType = targetEpisode.externalType || "iframe";
    episode.server = "via AniPub";
    episode.viaAniPub = true;
    episode.locked = false;
    addEpisodeSourceOption(episode, {
      id: "anipub",
      label: "AniPub",
      type: "iframe",
      externalUrl: targetEpisode.externalUrl
    });
    writeAniPubEpisodeFallback(cacheKey, { found: true, externalUrl: targetEpisode.externalUrl });
    return { type: "iframe", externalUrl: targetEpisode.externalUrl, source: "AniPub" };
  }

  if (targetEpisode.streamResolver) {
    episode.streamResolver = targetEpisode.streamResolver;
    episode.server = "via AniPub";
    episode.viaAniPub = true;
    episode.locked = false;
    const resolvedDirectUrl = await resolveEpisodeStream(episode);
    if (resolvedDirectUrl) return { type: "direct", url: resolvedDirectUrl };
    if (episode.externalUrl) {
      writeAniPubEpisodeFallback(cacheKey, { found: true, externalUrl: episode.externalUrl });
      return { type: "iframe", externalUrl: episode.externalUrl, source: "AniPub" };
    }
  }

  writeAniPubEpisodeFallback(cacheKey, { found: false });
  const anime1vFallback = await resolveEpisodeWithAnime1vFallback(show, episode, seasonNumber);
  if (anime1vFallback.type !== "none") return anime1vFallback;
  return { type: "none" };
}

async function resolveEpisodeWithAnime1vFallback(show, episode, seasonNumber = 1) {
  if (!show || !episode || isAnime1vShow(show)) return { type: "none" };
  const episodeNumber = Number(episode.episode || episode.number || 1);
  const cacheKey = `${ANIME1V_FALLBACK_PREFIX}${normalizeTitle(show.title)}:s${seasonNumber}:e${episodeNumber}`;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
    if (cached?.expiry > Date.now()) {
      if (!cached.found) return { type: "none" };
      if (cached.videoUrl) {
        episode.videoUrl = cached.videoUrl;
        episode.locked = false;
        addEpisodeSourceOption(episode, {
          id: "anime1v",
          label: "Anime1v",
          type: "direct",
          videoUrl: cached.videoUrl
        });
        return { type: "direct", url: cached.videoUrl, source: "Anime1v" };
      }
      if (cached.externalUrl) {
        episode.externalUrl = cached.externalUrl;
        episode.externalType = "iframe";
        episode.locked = false;
        addEpisodeSourceOption(episode, {
          id: "anime1v",
          label: "Anime1v",
          type: "iframe",
          externalUrl: cached.externalUrl
        });
        return { type: "iframe", externalUrl: cached.externalUrl, source: "Anime1v" };
      }
    }
  } catch (error) {
    localStorage.removeItem(cacheKey);
  }

  try {
    const searchUrl = withAnime1vApiKey(`./api/anime1v/search?q=${encodeURIComponent(stripSeasonFromTitle(show.title))}`);
    const searchResponse = await fetchWithTimeout(searchUrl, { cache: "no-store" }, 12000);
    if (!searchResponse.ok) throw new Error("Anime1v search unavailable");
    const searchPayload = await searchResponse.json();
    const candidates = Array.isArray(searchPayload.items) ? searchPayload.items : [];
    const matched = candidates
      .map((candidate) => ({ candidate, score: titleMatchScore(show, candidate) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.candidate;
    if (!matched?.anime1vUrl) {
      localStorage.setItem(cacheKey, JSON.stringify({ found: false, expiry: Date.now() + ANIME1V_FALLBACK_TTL }));
      return { type: "none" };
    }

    const episodeUrl = new URL(withAnime1vApiKey("./api/anime1v/episodes"), location.href);
    episodeUrl.searchParams.set("url", matched.anime1vUrl);
    if (matched.provider) episodeUrl.searchParams.set("provider", matched.provider);
    const episodeResponse = await fetchWithTimeout(episodeUrl.toString(), { cache: "no-store" }, 16000);
    if (!episodeResponse.ok) throw new Error("Anime1v episode list unavailable");
    const episodePayload = await episodeResponse.json();
    const episodes = Array.isArray(episodePayload.episodes) ? episodePayload.episodes : [];
    const targetEpisode = episodes.find((entry) => Number(entry.episode || entry.number) === episodeNumber);
    if (!targetEpisode) {
      localStorage.setItem(cacheKey, JSON.stringify({ found: false, expiry: Date.now() + ANIME1V_FALLBACK_TTL }));
      return { type: "none" };
    }

    Object.assign(episode, targetEpisode, {
      server: targetEpisode.server || "via Anime1v",
      locked: false
    });
    const directUrl = getEpisodeUrl(episode);
    if (directUrl) {
      localStorage.setItem(cacheKey, JSON.stringify({ found: true, videoUrl: directUrl, expiry: Date.now() + ANIME1V_FALLBACK_TTL }));
      addEpisodeSourceOption(episode, {
        id: "anime1v",
        label: "Anime1v",
        type: "direct",
        videoUrl: directUrl
      });
      return { type: "direct", url: directUrl, source: "Anime1v" };
    }
    if (episode.streamResolver) {
      const resolvedUrl = await resolveEpisodeStream(episode);
      if (resolvedUrl) {
        localStorage.setItem(cacheKey, JSON.stringify({ found: true, videoUrl: resolvedUrl, expiry: Date.now() + ANIME1V_FALLBACK_TTL }));
        addEpisodeSourceOption(episode, {
          id: "anime1v",
          label: "Anime1v",
          type: "direct",
          videoUrl: resolvedUrl
        });
        return { type: "direct", url: resolvedUrl, source: "Anime1v" };
      }
    }
    if (episode.externalUrl) {
      episode.externalType = episode.externalType || "iframe";
      localStorage.setItem(cacheKey, JSON.stringify({ found: true, externalUrl: episode.externalUrl, expiry: Date.now() + ANIME1V_FALLBACK_TTL }));
      addEpisodeSourceOption(episode, {
        id: "anime1v",
        label: "Anime1v",
        type: "iframe",
        externalUrl: episode.externalUrl
      });
      return { type: "iframe", externalUrl: episode.externalUrl, source: "Anime1v" };
    }
  } catch (error) {
    console.warn("Anime1v fallback failed:", error);
  }
  return { type: "none" };
}

async function resolveEpisodeWithJimovFallback(show, episode, seasonNumber = 1) {
  if (!show || !episode || isJimovShow(show)) return { type: "none" };
  const episodeNumber = Number(episode.episode || episode.number || 1);
  const cacheKey = `${JIMOV_FALLBACK_PREFIX}${normalizeTitle(show.title)}:s${seasonNumber}:e${episodeNumber}`;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
    if (cached?.expiry > Date.now()) {
      if (!cached.found) return { type: "none" };
      (cached.sourceOptions || []).forEach((option) => addEpisodeSourceOption(episode, option));
      if (cached.videoUrl) episode.videoUrl = episode.videoUrl || cached.videoUrl;
      if (cached.externalUrl) {
        episode.externalUrl = episode.externalUrl || cached.externalUrl;
        episode.externalType = episode.externalType || "iframe";
      }
      episode.locked = false;
      if (cached.videoUrl) return { type: "direct", url: cached.videoUrl, source: "JIMOV TioAnime" };
      if (cached.externalUrl) return { type: "iframe", externalUrl: cached.externalUrl, source: "JIMOV TioAnime" };
    }
  } catch (error) {
    localStorage.removeItem(cacheKey);
  }

  try {
    const catalogUrl = new URL("./api/jimov/tioanime/catalog", location.href);
    catalogUrl.searchParams.set("q", stripSeasonFromTitle(show.title));
    catalogUrl.searchParams.set("limit", "12");
    const catalogResponse = await fetchWithTimeout(catalogUrl.toString(), { cache: "no-store" }, 12000);
    if (!catalogResponse.ok) throw new Error("JIMOV catalog unavailable");
    const catalogPayload = await catalogResponse.json();
    const candidates = Array.isArray(catalogPayload.items) ? catalogPayload.items : [];
    const matched = candidates
      .map((candidate) => ({ candidate, score: titleMatchScore(show, candidate) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.candidate;
    if (!matched?.jimovUrl && !matched?.siteUrl) {
      localStorage.setItem(cacheKey, JSON.stringify({ found: false, expiry: Date.now() + JIMOV_FALLBACK_TTL }));
      return { type: "none" };
    }

    const infoUrl = new URL("./api/jimov/tioanime/info", location.href);
    infoUrl.searchParams.set("url", matched.jimovUrl || matched.siteUrl);
    const infoResponse = await fetchWithTimeout(infoUrl.toString(), { cache: "no-store" }, 16000);
    if (!infoResponse.ok) throw new Error("JIMOV episode list unavailable");
    const infoPayload = await infoResponse.json();
    const episodes = Array.isArray(infoPayload.episodes) ? infoPayload.episodes : [];
    const targetEpisode = episodes.find((entry) => Number(entry.episode || entry.number) === episodeNumber);
    if (!targetEpisode) {
      localStorage.setItem(cacheKey, JSON.stringify({ found: false, expiry: Date.now() + JIMOV_FALLBACK_TTL }));
      return { type: "none" };
    }

    const sourceOptions = normalizeEpisodeSourceOptions(targetEpisode).map((option) => ({
      ...option,
      id: option.id?.startsWith("jimov") ? option.id : `jimov-${option.id || option.label || "source"}`,
      label: option.label || "JIMOV TioAnime"
    }));
    sourceOptions.forEach((option) => addEpisodeSourceOption(episode, option));
    const directUrl = getEpisodeUrl(targetEpisode);
    const externalUrl = targetEpisode.externalUrl || "";
    if (directUrl && !getEpisodeUrl(episode)) episode.videoUrl = directUrl;
    if (externalUrl && !episode.externalUrl) {
      episode.externalUrl = externalUrl;
      episode.externalType = targetEpisode.externalType || "iframe";
    }
    episode.server = episode.server || "JIMOV TioAnime";
    episode.locked = false;
    localStorage.setItem(cacheKey, JSON.stringify({
      found: Boolean(directUrl || externalUrl || sourceOptions.length),
      videoUrl: directUrl,
      externalUrl,
      sourceOptions,
      expiry: Date.now() + JIMOV_FALLBACK_TTL
    }));
    if (directUrl) return { type: "direct", url: directUrl, source: "JIMOV TioAnime" };
    if (externalUrl) return { type: "iframe", externalUrl, source: "JIMOV TioAnime" };
  } catch (error) {
    console.warn("JIMOV fallback failed:", error);
  }
  return { type: "none" };
}

const ALLANIME_FALLBACK_PREFIX = "animetv-allanime-fallback:";
const ALLANIME_FALLBACK_TTL = 1000 * 60 * 45;

async function resolveEpisodeWithAllAnimeFallback(show, episode, seasonNumber = 1) {
  if (!show || !episode) return { type: "none" };
  const episodeNumber = Number(episode.episode || episode.number || 1);
  const cacheKey = `${ALLANIME_FALLBACK_PREFIX}${normalizeTitle(show.title)}:s${seasonNumber}:e${episodeNumber}`;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
    if (cached?.expiry > Date.now()) {
      if (!cached.found) return { type: "none" };
      (cached.sourceOptions || []).forEach((option) => addEpisodeSourceOption(episode, option));
      if (cached.videoUrl) episode.videoUrl = episode.videoUrl || cached.videoUrl;
      if (cached.externalUrl && !episode.externalUrl) {
        episode.externalUrl = cached.externalUrl;
        episode.externalType = cached.externalType || "iframe";
      }
      episode.locked = false;
      if (cached.videoUrl) return { type: "direct", url: cached.videoUrl, source: "AllAnime" };
      if (cached.externalUrl) return { type: "iframe", externalUrl: cached.externalUrl, source: "AllAnime" };
    }
  } catch (error) {
    localStorage.removeItem(cacheKey);
  }

  try {
    // 1. Search AllAnime for this show
    const searchUrl = new URL("./api/allanime/search", location.href);
    searchUrl.searchParams.set("q", stripSeasonFromTitle(show.title));
    searchUrl.searchParams.set("limit", "8");
    const searchResponse = await fetchWithTimeout(searchUrl.toString(), { cache: "no-store" }, 10000);
    if (!searchResponse.ok) throw new Error("AllAnime search unavailable");
    const searchPayload = await searchResponse.json();
    const candidates = Array.isArray(searchPayload.items) ? searchPayload.items : [];
    const matched = candidates
      .map((candidate) => ({ candidate, score: titleMatchScore(show, candidate) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.candidate;
    if (!matched?.allAnimeId && !matched?.id) {
      localStorage.setItem(cacheKey, JSON.stringify({ found: false, expiry: Date.now() + ALLANIME_FALLBACK_TTL }));
      return { type: "none" };
    }

    // 2. Get stream URLs for this episode
    const watchUrl = new URL("./api/allanime/watch", location.href);
    watchUrl.searchParams.set("id", matched.allAnimeId || matched.id);
    watchUrl.searchParams.set("ep", String(episodeNumber));
    watchUrl.searchParams.set("lang", "sub");
    const watchResponse = await fetchWithTimeout(watchUrl.toString(), { cache: "no-store" }, 10000);
    if (!watchResponse.ok) throw new Error("AllAnime watch unavailable");
    const watchPayload = await watchResponse.json();
    const streamItems = Array.isArray(watchPayload.sources) ? watchPayload.sources : [];
    if (!streamItems.length) {
      localStorage.setItem(cacheKey, JSON.stringify({ found: false, expiry: Date.now() + ALLANIME_FALLBACK_TTL }));
      return { type: "none" };
    }

    // 3. Build source options from stream items
    const sourceOptions = streamItems.slice(0, 6).map((item, index) => ({
      id: `allanime-${item.sourceName || index}`,
      label: `AllAnime · ${item.sourceName || `Source ${index + 1}`}`,
      type: item.type === "direct" ? "direct" : "iframe",
      videoUrl: item.type === "direct" ? item.url : "",
      externalUrl: item.type !== "direct" ? item.url : "",
      externalType: "iframe"
    })).filter((option) => option.videoUrl || option.externalUrl);

    if (!sourceOptions.length) {
      localStorage.setItem(cacheKey, JSON.stringify({ found: false, expiry: Date.now() + ALLANIME_FALLBACK_TTL }));
      return { type: "none" };
    }

    sourceOptions.forEach((option) => addEpisodeSourceOption(episode, option));
    const directOption = sourceOptions.find((option) => option.videoUrl);
    const iframeOption = sourceOptions.find((option) => option.externalUrl);
    if (directOption) episode.videoUrl = episode.videoUrl || directOption.videoUrl;
    if (iframeOption && !episode.externalUrl) {
      episode.externalUrl = iframeOption.externalUrl;
      episode.externalType = "iframe";
    }
    episode.server = episode.server || "AllAnime";
    episode.locked = false;

    const saveVideoUrl = directOption?.videoUrl || "";
    const saveExternalUrl = iframeOption?.externalUrl || "";
    const saveExternalType = saveExternalUrl ? "iframe" : "";
    localStorage.setItem(cacheKey, JSON.stringify({
      found: true,
      videoUrl: saveVideoUrl,
      externalUrl: saveExternalUrl,
      externalType: saveExternalType,
      sourceOptions,
      expiry: Date.now() + ALLANIME_FALLBACK_TTL
    }));
    if (saveVideoUrl) return { type: "direct", url: saveVideoUrl, source: "AllAnime" };
    if (saveExternalUrl) return { type: "iframe", externalUrl: saveExternalUrl, source: "AllAnime" };
  } catch (error) {
    console.warn("AllAnime fallback failed:", error);
  }
  return { type: "none" };
}

async function resolveEpisodeWithRapidAnimeFallback(show, episode, seasonNumber = 1) {
  if (!show || !episode || isRapidAnimeShow(show)) return { type: "none" };
  const episodeNumber = Number(episode.episode || episode.number || 1);
  const cacheKey = `animetv-rapid-fallback:${normalizeTitle(show.title)}:s${seasonNumber}:e${episodeNumber}`;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
    if (cached?.expiry > Date.now()) {
      if (!cached.found) return { type: "none" };
      if (cached.sourceOptions?.length) cached.sourceOptions.forEach((option) => addEpisodeSourceOption(episode, option));
      if (cached.videoUrl) episode.videoUrl = episode.videoUrl || cached.videoUrl;
      episode.locked = false;
      if (cached.videoUrl) return { type: "direct", url: cached.videoUrl, source: "RapidAPI" };
    }
  } catch (error) {
    localStorage.removeItem(cacheKey);
  }

  try {
    const searchUrl = new URL("./api/rapid-anime/search", location.href);
    searchUrl.searchParams.set("q", stripSeasonFromTitle(show.title));
    const searchResponse = await fetchWithTimeout(searchUrl.toString(), { cache: "no-store" }, 28000);
    if (!searchResponse.ok) throw new Error("RapidAPI search unavailable");
    const searchPayload = await searchResponse.json();
    const candidates = Array.isArray(searchPayload.items) ? searchPayload.items : [];
    const matched = candidates
      .map((candidate) => ({ candidate, score: titleMatchScore(show, candidate) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.candidate;
    const rapidId = matched?.rapidAnimeId || String(matched?.id || "").replace(/^rapid-anime-/, "");
    if (!rapidId) {
      localStorage.setItem(cacheKey, JSON.stringify({ found: false, expiry: Date.now() + RESPONSE_CACHE_TTL }));
      return { type: "none" };
    }

    const infoUrl = new URL("./api/rapid-anime/info", location.href);
    infoUrl.searchParams.set("id", rapidId);
    const infoResponse = await fetchWithTimeout(infoUrl.toString(), { cache: "no-store" }, 28000);
    if (!infoResponse.ok) throw new Error("RapidAPI episode list unavailable");
    const infoPayload = await infoResponse.json();
    const episodes = Array.isArray(infoPayload.episodes) ? infoPayload.episodes : [];
    const targetEpisode = episodes.find((entry) =>
      Number(entry.episode || entry.number) === episodeNumber
      && Number(entry.season || 1) === Number(seasonNumber || 1)
    ) || episodes.find((entry) => Number(entry.episode || entry.number) === episodeNumber);
    if (!targetEpisode) {
      localStorage.setItem(cacheKey, JSON.stringify({ found: false, expiry: Date.now() + RESPONSE_CACHE_TTL }));
      return { type: "none" };
    }

    const rapidOptions = normalizeEpisodeSourceOptions(targetEpisode).map((option) => ({
      ...option,
      id: option.id?.startsWith("rapid") ? option.id : `rapid-${option.id || normalizeTitle(option.label || "source")}`,
      label: option.label || "RapidAPI"
    }));
    rapidOptions.forEach((option) => addEpisodeSourceOption(episode, option));
    if (targetEpisode.streamResolver) addEpisodeSourceOption(episode, {
      id: "rapid-resolver",
      label: "RapidAPI",
      type: "resolver",
      streamResolver: targetEpisode.streamResolver
    });
    const directUrl = getEpisodeUrl(targetEpisode);
    if (directUrl && !getEpisodeUrl(episode)) episode.videoUrl = directUrl;
    episode.locked = false;
    localStorage.setItem(cacheKey, JSON.stringify({
      found: Boolean(directUrl || rapidOptions.length || targetEpisode.streamResolver),
      videoUrl: directUrl,
      sourceOptions: rapidOptions,
      expiry: Date.now() + RESPONSE_CACHE_TTL
    }));
    if (directUrl) return { type: "direct", url: directUrl, source: "RapidAPI" };
  } catch (error) {
    console.warn("RapidAPI fallback failed:", error);
  }
  return { type: "none" };
}

async function resolveEpisodeWithConsumetFallback(show, episode, seasonNumber = 1) {
  const episodeNumber = Number(episode?.episode || episode?.number || 1);
  const cacheKey = `${RESPONSE_CACHE_PREFIX}consumet-kickassanime:${normalizeTitle(show.title)}:s${seasonNumber}:e${episodeNumber}`;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
    if (cached?.expiry > Date.now()) {
      if (cached.sourceOptions?.length) cached.sourceOptions.forEach((option) => addEpisodeSourceOption(episode, option));
      if (cached.videoUrl && !getEpisodeUrl(episode)) episode.videoUrl = cached.videoUrl;
      if (cached.found) return cached.videoUrl ? { type: "direct", url: cached.videoUrl, source: "KickAssAnime" } : { type: "resolver", source: "KickAssAnime" };
      return { type: "none" };
    }
  } catch (error) {
    localStorage.removeItem(cacheKey);
  }

  try {
    const searchUrl = new URL("./api/consumet/kickassanime/search", location.href);
    searchUrl.searchParams.set("q", getFranchiseKey(show.title) || show.title);
    searchUrl.searchParams.set("limit", "24");
    searchUrl.searchParams.set("pages", "2");
    const searchResponse = await fetchWithTimeout(searchUrl.toString(), { cache: "no-store" }, 18000);
    if (!searchResponse.ok) throw new Error("Consumet search unavailable");
    const searchPayload = await searchResponse.json();
    const candidates = Array.isArray(searchPayload.items) ? searchPayload.items : [];
    const matched = candidates
      .map((candidate) => ({ candidate, score: titleMatchScore(show, candidate) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.candidate;
    if (!matched?.consumetId) {
      localStorage.setItem(cacheKey, JSON.stringify({ found: false, expiry: Date.now() + RESPONSE_CACHE_TTL }));
      return { type: "none" };
    }

    const infoUrl = new URL("./api/consumet/kickassanime/info", location.href);
    infoUrl.searchParams.set("id", matched.consumetId);
    const infoResponse = await fetchWithTimeout(infoUrl.toString(), { cache: "no-store" }, 20000);
    if (!infoResponse.ok) throw new Error("Consumet episode list unavailable");
    const infoPayload = await infoResponse.json();
    const episodes = Array.isArray(infoPayload.episodes) ? infoPayload.episodes : [];
    const targetEpisode = episodes.find((entry) =>
      Number(entry.episode || entry.number) === episodeNumber
      && Number(entry.season || 1) === Number(seasonNumber || 1)
    ) || episodes.find((entry) => Number(entry.episode || entry.number) === episodeNumber);
    if (!targetEpisode) {
      localStorage.setItem(cacheKey, JSON.stringify({ found: false, expiry: Date.now() + RESPONSE_CACHE_TTL }));
      return { type: "none" };
    }

    const sourceOptions = normalizeEpisodeSourceOptions(targetEpisode).map((option) => ({
      ...option,
      id: option.id?.startsWith("consumet") ? option.id : `consumet-${option.id || normalizeTitle(option.label || "source")}`,
      label: option.label || "KickAssAnime"
    }));
    sourceOptions.forEach((option) => addEpisodeSourceOption(episode, option));
    if (targetEpisode.streamResolver) addEpisodeSourceOption(episode, {
      id: "consumet-kickassanime-resolver",
      label: "KickAssAnime",
      type: "resolver",
      streamResolver: targetEpisode.streamResolver
    });
    const directUrl = getEpisodeUrl(targetEpisode);
    if (directUrl && !getEpisodeUrl(episode)) episode.videoUrl = directUrl;
    episode.locked = false;
    localStorage.setItem(cacheKey, JSON.stringify({
      found: Boolean(directUrl || sourceOptions.length || targetEpisode.streamResolver),
      videoUrl: directUrl,
      sourceOptions,
      expiry: Date.now() + RESPONSE_CACHE_TTL
    }));
    if (directUrl) return { type: "direct", url: directUrl, source: "KickAssAnime" };
  } catch (error) {
    console.warn("Consumet KickAssAnime fallback failed:", error);
  }
  return { type: "none" };
}

async function attachLoadedAddonFallbacks(show, episode, seasonNumber = 1) {
  if (!show || !episode) return;
  const episodeNumber = Number(episode.episode || episode.number || 1);
  await ensureLocalFinderSectionLoaded();
  const sections = state.addonSections.filter((section) =>
    section?.items?.length
    && !["anipub-catalog", "consumet-kickassanime", "anime1v-spanish", "jimov-tioanime", "rapidapi-anime-streaming"].includes(section.id)
  );
  sections.forEach((section) => {
    const matched = section.items
      .map((candidate) => ({ candidate, score: titleMatchScore(show, candidate) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.candidate;
    if (!matched) return;
    const seasons = matched.seasons?.length ? matched.seasons : groupEpisodesBySeason(matched.episodes || []);
    const targetSeason = seasons.find((season) => Number(season.season || 1) === Number(seasonNumber || 1)) || seasons[0];
    const targetEpisode = (targetSeason?.episodes || []).find((entry) => Number(entry.episode || entry.number) === episodeNumber);
    if (!targetEpisode) return;
    let foundPlayable = false;
    const scrapedLabel = scrapedPlaybackLabel(targetEpisode, matched, section);
    const scrapedIdBase = `${section.id}-${normalizeTitle(scrapedLabel) || "scraped"}`;
    const sourceOptions = normalizeEpisodeSourceOptions(targetEpisode);
    sourceOptions.forEach((option) => addEpisodeSourceOption(episode, {
      ...option,
      id: `${scrapedIdBase}-${option.id || normalizeTitle(option.label || "source")}`,
      label: option.label && !/^external|direct|source\s*\d+$/i.test(option.label) ? option.label : scrapedLabel
    }));
    if (sourceOptions.length) foundPlayable = true;
    if (targetEpisode.streamResolver) addEpisodeSourceOption(episode, {
      id: `${scrapedIdBase}-resolver`,
      label: scrapedLabel,
      type: "resolver",
      streamResolver: targetEpisode.streamResolver
    });
    if (targetEpisode.streamResolver) foundPlayable = true;
    const directUrl = getEpisodeUrl(targetEpisode);
    if (directUrl) {
      foundPlayable = true;
      if (!getEpisodeUrl(episode)) episode.videoUrl = directUrl;
      addEpisodeSourceOption(episode, {
        id: `${scrapedIdBase}-direct`,
        label: scrapedLabel,
        type: "direct",
        videoUrl: directUrl,
        downloadUrl: targetEpisode.downloadUrl || targetEpisode.download || targetEpisode.download_url || directUrl
      });
    }
    if (targetEpisode.externalUrl) {
      foundPlayable = true;
      if (!episode.externalUrl) {
        episode.externalUrl = targetEpisode.externalUrl;
        episode.externalType = targetEpisode.externalType || "iframe";
      }
      addEpisodeSourceOption(episode, {
        id: `${scrapedIdBase}-embed`,
        label: scrapedLabel,
        type: "iframe",
        externalUrl: targetEpisode.externalUrl,
        externalType: targetEpisode.externalType || "iframe",
        downloadUrl: targetEpisode.downloadUrl || targetEpisode.download || targetEpisode.download_url || ""
      });
    }
    if (foundPlayable) {
      episode.locked = false;
      episode.server = episode.server || scrapedLabel;
      episode.serverChecks = episode.serverChecks || {};
    }
  });
}

function scrapedPlaybackLabel(targetEpisode = {}, matched = {}, section = {}) {
  const directLabel = targetEpisode.server || targetEpisode.source || targetEpisode.provider || matched.source || "";
  if (directLabel) return cleanPlaybackSourceLabel(directLabel);
  const url = targetEpisode.siteUrl || targetEpisode.externalUrl || matched.siteUrl || "";
  if (/tioanime/i.test(url)) return "TioAnime";
  if (/animeflv/i.test(url)) return "AnimeFLV";
  if (/mega\\.nz/i.test(url)) return "MEGA";
  return cleanPlaybackSourceLabel(section.name || "Scraped Link");
}

function getShowAnilistId(show) {
  if (!show) return "";
  if (show.anilistId) return String(show.anilistId);
  const match = (show.id || "").match(/apk-1anime-(\d+)/);
  if (match) return match[1];
  if (show.anime1vUrl && /^\d+$/.test(String(show.anime1vUrl))) return String(show.anime1vUrl);
  return "";
}

function playbackLookupWithTimeout(label, promise, timeoutMs = 6500) {
  return Promise.race([
    Promise.resolve(promise),
    wait(timeoutMs).then(() => {
      console.warn(`${label} lookup timed out after ${timeoutMs}ms`);
      return { type: "none", timeout: true };
    })
  ]);
}

async function attachPlaybackSourceOptions(show, episode, seasonNumber = 1) {
  if (!show || !episode) return episode;
  const episodeNumber = Number(episode.episode || episode.number || 1);
  const lookupKey = `${normalizeTitle(show.title)}:s${seasonNumber}:e${episodeNumber}`;
  if (episode.sourceOptionsChecked === lookupKey && episode.tioAnimeSourcesChecked && episode.animeAv1SourcesChecked) return episode;

  // Initialize per-server status tracking (undefined = still pending; "found" / "notfound")
  episode.serverChecks = {};

  const beforeCount = getEpisodePlaybackSources(episode).length;

  const refreshPicker = () => {
    const frame = document.querySelector("#videoFrame");
    if (frame?.querySelector(".source-picker")) {
      renderSourcePickerIn(frame);
    }
  };

  const updateServerCheck = (key, match) => {
    episode.sourceOptions = normalizeEpisodeSourceOptions(episode);
    const found = getEpisodePlaybackSources(episode).some(match);
    episode.serverChecks[key] = found ? "found" : "notfound";
    // Record when each server first became ready, so the picker can float the
    // first-ready scraper (TioAnime / AnimeAV1) to the top.
    if (found) {
      episode.serverReadyAt = episode.serverReadyAt || {};
      if (!episode.serverReadyAt[key]) episode.serverReadyAt[key] = Date.now();
    }
    refreshPicker();
  };

  // Respect the user's per-scraper enable toggles (Sources tab).
  const lookups = [
    playbackLookupWithTimeout("AniPub", attachAniPubFallback(show, episode), 2600)
      .then(() => updateServerCheck("anipub", KNOWN_SOURCE_SERVERS[0].match)),
    playbackLookupWithTimeout("Loaded addons", attachLoadedAddonFallbacks(show, episode, seasonNumber), 1800)
      .then(() => refreshPicker())
  ];
  if (isScraperEnabled("tioanime")) {
    lookups.push(playbackLookupWithTimeout("TioAnime scraper", attachTioAnimeSources(show, episode), 6500)
      .then(() => updateServerCheck("tioanime", getKnownSourceServer("tioanime").match)));
  } else { episode.tioAnimeSourcesChecked = true; episode.serverChecks.tioanime = "notfound"; }
  if (isScraperEnabled("animeav1")) {
    lookups.push(playbackLookupWithTimeout("AnimeAV1 scraper", attachAnimeAv1Sources(show, episode), 6500)
      .then(() => updateServerCheck("animeav1", getKnownSourceServer("animeav1").match)));
  } else { episode.animeAv1SourcesChecked = true; episode.serverChecks.animeav1 = "notfound"; }
  await Promise.allSettled(lookups);

  // Ensure any timed-out servers are marked not-found after every source has had a chance.
  for (const def of KNOWN_SOURCE_SERVERS) {
    if (!episode.serverChecks[def.key]) episode.serverChecks[def.key] = "notfound";
  }

  episode.sourceOptionsChecked = lookupKey;
  if (episode.sourceOptions.length > beforeCount) {
    console.info(`Loaded ${episode.sourceOptions.length} playback server option(s) for ${show.title} episode ${episodeNumber}.`);
  }
  return episode;
}

function playbackLookupKey(show, episode, seasonNumber = 1) {
  if (!show || !episode) return "";
  const episodeNumber = Number(episode.episode || episode.number || 1);
  return `${normalizeTitle(show.title)}:s${seasonNumber}:e${episodeNumber}`;
}

function getKnownSourceServer(key) {
  return KNOWN_SOURCE_SERVERS.find((def) => def.key === key) || { match: () => false };
}

function schedulePlaybackSourceOptions(show, episode, seasonNumber = 1, options = {}) {
  const lookupKey = playbackLookupKey(show, episode, seasonNumber);
  if (!lookupKey || (episode.sourceOptionsChecked === lookupKey && episode.tioAnimeSourcesChecked && episode.animeAv1SourcesChecked)) return Promise.resolve(episode);
  if (pendingSourceLookups.has(lookupKey)) return pendingSourceLookups.get(lookupKey);

  episode.sourceOptionsPending = true;
  const promise = attachPlaybackSourceOptions(show, episode, seasonNumber)
    .catch((error) => {
      console.warn("Playback source lookup failed:", error);
      return episode;
    })
    .finally(() => {
      episode.sourceOptionsPending = false;
      pendingSourceLookups.delete(lookupKey);
      const selected = state.activeEpisode;
      if (selected?.episode === episode && state.activeShow === show) {
        renderEpisodeList(show);
        if (options.autoReplay) playActiveShow({ allowSourceLookup: false });
        // Refresh source picker if it's currently open (user pressed ✕ and sees picker)
        const frame = document.querySelector("#videoFrame");
        if (frame?.querySelector(".source-picker")) {
          renderSourcePickerIn(frame);
        }
      }
      refreshFocusables();
    });

  pendingSourceLookups.set(lookupKey, promise);
  return promise;
}

function stripSeasonFromTitle(title = "") {
  return String(title)
    .replace(/\bseason\s*\d+\b/ig, "")
    .replace(/\bpart\s*\d+\b/ig, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function attachAniPubFallback(show, episode) {
  if (!show || !episode || isAniPubShow(show)) return;
  const cacheKey = normalizeTitle(show.title);
  const cachedId = state.anipubFallbackCache[cacheKey];
  const cachedItems = anipubCatalogItems();
  let aniPubShow = cachedId ? cachedItems.find((item) => item.id === cachedId) : null;
  const fallback = aniPubShow
    ? await resolveEpisodeWithAniPubFallback(aniPubShow, episode)
    : await resolveEpisodeWithAniPubFallback(show, episode);
  if (!fallback?.streamResolver && !fallback?.externalUrl) return;
  aniPubShow = fallback.match || aniPubShow;
  state.anipubFallbackCache[cacheKey] = aniPubShow.id;
  saveAniPubFallbackCache();
  if (fallback.externalUrl) {
    episode.externalUrl = fallback.externalUrl;
    episode.externalType = fallback.externalType || "iframe";
    addEpisodeSourceOption(episode, {
      id: "anipub",
      label: "AniPub",
      type: "iframe",
      externalUrl: fallback.externalUrl
    });
  }
  if (fallback.streamResolver) episode.streamResolver = fallback.streamResolver;
  episode.server = "via AniPub";
  episode.viaAniPub = true;
  episode.locked = false;
}

function isAniPubShow(show) {
  return String(show?.source || "").toLowerCase().includes("anipub") || String(show?.id || "").includes("anipub");
}

function renderAddonSections() {
  if (!addonSections) return;

  const loadedSections = state.addonSections
    .filter((section) =>
      section.id !== "anipub-catalog"
      && !section.source?.hidden
      && !section.source?.playbackOnly
      && section.items?.length
    );

  // Show loading skeleton while sources are still being fetched
  if (!state.externalSourcesLoaded && !loadedSections.length && state.route === "home") {
    addonSections.innerHTML = `<div class="addon-loading-hint">Loading sources…</div>`;
    addonSections.hidden = false;
    return;
  }

  const sections = loadedSections
    .map((section) => {
      const railId = `addonRail-${cssSafeId(section.id)}`;
      const matchingItems = section.items.filter((show) => {
        const matchesSearch = matchesShowSearch(show);
        const matchesFilter = state.filter === "all" || show.genre === state.filter;
        return matchesSearch && matchesFilter;
      });
      const visibleLimit = state.search
        ? SEARCH_CARD_LIMIT
        : state.addonVisible[section.id] || ADDON_CARD_LIMIT;
      const items = matchingItems.slice(0, visibleLimit).map(resolveAddonShow);
      if (!items.length) return "";
      const totalLabel = section.totalResults
        ? `${matchingItems.length} of ${section.totalResults}`
        : `${matchingItems.length}`;
      return `
        <section class="content-band addon-band" data-addon-source="${section.id}">
          <div class="section-heading">
            <span class="addon-dot" aria-hidden="true"></span>
            <h2>${escapeHtml(section.name)}</h2>
            <small>${totalLabel} available</small>
          </div>
          <div class="rail-shell">
            <button class="rail-arrow rail-arrow-left focusable" data-scroll-rail="${railId}" data-scroll-dir="-1" aria-label="Scroll ${escapeHtml(section.name)} left">‹</button>
            <div class="poster-grid" id="${railId}">${items.map((show, index) => cardTemplate(show, index)).join("")}</div>
            <button class="rail-arrow rail-arrow-right focusable" data-scroll-rail="${railId}" data-scroll-dir="1" aria-label="Scroll ${escapeHtml(section.name)} right">›</button>
          </div>
          ${(section.hasMore || matchingItems.length > items.length) && !state.search && !/anipub/i.test(section.name || section.id) ? `
            <button class="addon-more focusable" data-addon-more="${section.id}">
              ${section.hasMore ? `Load More ${escapeHtml(section.name)}` : `Show More ${escapeHtml(section.name)}`}
            </button>
          ` : ""}
        </section>
      `;
    })
    .join("");
  addonSections.innerHTML = sections;
  addonSections.hidden = state.route !== "home" || !sections;
  wireAddonMoreButtons();
}

function wireAddonMoreButtons() {
  addonSections?.querySelectorAll("[data-addon-more]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.addonMore;
      const section = state.addonSections.find((entry) => entry.id === id);
      if (section?.hasMore && section.source) {
        await loadMoreAddonSection(section, button);
        return;
      }
      state.addonVisible[id] = (state.addonVisible[id] || ADDON_CARD_LIMIT) + ADDON_CARD_LIMIT;
      renderAddonSections();
      wireOpenButtons();
      wireRailButtons();
      refreshFocusables();
    });
  });
}

async function loadMoreAddonSection(section, button) {
  if (button) {
    button.disabled = true;
    button.textContent = "Loading...";
  }
  try {
    const nextPage = section.nextPage || (section.page || 1) + 1;
    const catalog = await fetchExternalCatalogData(withSourcePage(section.source, nextPage), nextPage);
    const existingKeys = new Set(section.items.map(getShowKey));
    const newItems = catalog.items.filter((item) => !existingKeys.has(getShowKey(item)));
    section.items.push(...newItems);
    section.page = catalog.page;
    section.nextPage = catalog.nextPage;
    section.hasMore = catalog.hasMore;
    section.totalResults = catalog.totalResults || section.totalResults;
    if (!state.addonSections.some((entry) => entry.id === section.id)) {
      state.addonSections.push(section);
    }
    if (section.id !== "anipub-catalog") {
      state.shows = mergeShows([...state.shows, ...newItems]);
    }
    state.apiStatus.local = `${section.items.length}${section.totalResults ? ` of ${section.totalResults}` : ""} ${section.name} titles`;
    render();
  } catch (error) {
    if (button) {
      button.disabled = false;
      button.textContent = "Load Failed";
      window.setTimeout(() => renderAddonSections(), 1100);
    }
  }
}

function resolveAddonShow(show) {
  const key = getShowKey(show);
  return state.shows.find((entry) => entry.id === show.id || getShowKey(entry) === key) || show;
}

// cssSafeId, escapeHtml, fullDayName are defined in js/utils.js




// A source/connector is "working" if it's enabled and its status doesn't report
// a failure. Non-working ones are hidden from the Sources page.
function isSourceWorking(source) {
  if (!source || !source.enabled) return false;
  const status = String(source.status || "").toLowerCase();
  if (!status) return true;
  return !/(offline|wrong url|unavailable|error|no titles|no playable|no enabled|disabled|quota|degraded|blocked|failed|not found)/.test(status);
}

function buildSourceCardsHtml() {
  const metadataOnline = /online|standby|ready/i.test(String(state.apiStatus.metadata || ""));
  const workingSources = state.localSources.filter((s) =>
    isSourceWorking(s) && !s.hidden && s.id !== LOCAL_FINDER_SOURCE_ID);
  return `
    <article class="source-card source-card-add">
      <div>
        <strong>Add Server or Online Addon</strong>
        <span>Local or HTTPS</span>
      </div>
      <p>Paste a local server URL or online HTTPS addon that returns anime JSON. ZenkaiTV will merge it with AniList/Jikan and unlock episodes when items include videoUrl, streamUrl, or file.</p>
      <button class="primary-action focusable" data-source-add>Add Source</button>
    </article>
    ${metadataOnline ? `
    <article class="source-card source-card-feature">
      <div>
        <strong>ZenkaiTV Metadata API</strong>
        <span>${escapeHtml(state.apiStatus.metadata)}</span>
      </div>
      <p>Local server endpoint that merges AniList and Jikan before the TV app renders. If it is unavailable, the app falls back to direct public API calls.</p>
      <code>${location.origin && location.protocol !== "file:" ? `${location.origin}/api/catalog` : "Run animetv-local.js to enable /api/catalog"}</code>
    </article>` : ""}
    <article class="source-card source-card-feature">
      <div>
        <strong>AniList + Jikan Direct</strong>
        <span>${escapeHtml(state.apiStatus.direct)}</span>
      </div>
      <p>Public legal metadata APIs for posters, banners, schedules, genres, and episode counts. These do not provide copyrighted video files.</p>
      <code>${ANILIST_ENDPOINT} + api.jikan.moe</code>
    </article>
    ${workingSources.map((source) => `
    <article class="source-card ${source.enabled ? "is-enabled" : ""}">
      <div>
        <strong>${escapeHtml(source.name || "Unnamed Source")}</strong>
        <span>${escapeHtml(source.type || "catalog")} | ${escapeHtml(source.status || "Disabled")}</span>
      </div>
      <p>${escapeHtml(source.description || "Local catalog connector.")}</p>
      <code>${escapeHtml(resolveSourceEndpoint(source.endpoint) || "No endpoint configured")}</code>
      ${source.id === "anime1v-spanish" ? `
        <label class="source-key-field">
          <span>Anime1v API key</span>
          <input class="focusable" type="password" value="${escapeHtml(getAnime1vApiKey())}" placeholder="Paste API key if Anime1v returns 401" data-anime1v-key>
        </label>
      ` : ""}
      <div class="source-actions">
        <button class="secondary-action focusable" data-source-toggle="${escapeHtml(source.id)}">
          ${source.enabled ? "Disable" : "Enable"}
        </button>
        <button class="secondary-action focusable" data-source-test="${escapeHtml(source.id)}">Test</button>
        <button class="secondary-action source-remove-action focusable" data-source-remove="${escapeHtml(source.id)}">Remove</button>
      </div>
    </article>
  `).join("")}
    ${PLAYBACK_SCRAPERS.map((scraper) => {
      const on = isScraperEnabled(scraper.id);
      return `
    <article class="source-card ${on ? "is-enabled" : ""}">
      <div>
        <strong>${escapeHtml(scraper.name)}</strong>
        <span>playback scraper | ${on ? "Online" : "Disabled"}</span>
      </div>
      <p>${escapeHtml(scraper.desc)}</p>
      <code>${escapeHtml(scraper.endpoint)}</code>
      <div class="source-actions">
        <button class="secondary-action focusable" data-scraper-toggle="${escapeHtml(scraper.id)}">${on ? "Disable" : "Enable"}</button>
        <button class="secondary-action focusable" data-scraper-test="${escapeHtml(scraper.id)}">Test</button>
      </div>
    </article>`;
    }).join("")}`;
}

function renderSources() {
  if (!sourcesGrid || !sourceSummary) return;
  const working = state.localSources.filter((s) =>
    isSourceWorking(s) && !s.hidden && s.id !== LOCAL_FINDER_SOURCE_ID).length;
  sourceSummary.textContent = `${working} active source${working === 1 ? "" : "s"} · Catalog: ${state.apiStatus.direct}`;
  sourcesGrid.innerHTML = buildSourceCardsHtml();
  wireSourceButtons(sourcesGrid);
}

function renderTermsHtml() {
  return `<div class="settings-legal-section">
    <h4>Terms of Service</h4>
    <p>Last updated: May 2026</p>
    <h4>1. Acceptance of Terms</h4>
    <p>By using ZenkaiTV you agree to these Terms of Service. If you do not agree, please stop using the application immediately.</p>
    <h4>2. Purpose of the Application</h4>
    <p>ZenkaiTV is a personal media organizer and catalog browser. It aggregates publicly available metadata from third-party APIs (AniList, Jikan, and configured external addons) to help you discover, track, and play anime content.</p>
    <h4>3. Content & Copyright</h4>
    <p>ZenkaiTV does not host, store, or distribute any copyrighted video content. All video streams are provided by third-party sources that you configure. You are solely responsible for ensuring that your use of any linked content complies with applicable copyright laws in your jurisdiction.</p>
    <h4>4. Third-Party Sources</h4>
    <p>You may connect external addons and catalog endpoints. ZenkaiTV is not responsible for the content, availability, or legality of any third-party source. By adding a source you confirm that you have the right to access it.</p>
    <h4>5. No Warranty</h4>
    <p>ZenkaiTV is provided "as is" without warranties of any kind. We do not guarantee uninterrupted access, accuracy of metadata, or availability of any streaming endpoint. Catalog data depends entirely on third-party APIs that may change or become unavailable.</p>
    <h4>6. Limitation of Liability</h4>
    <p>To the fullest extent permitted by law, the developers of ZenkaiTV are not liable for any indirect, incidental, or consequential damages arising from your use of this application.</p>
    <h4>7. Changes to Terms</h4>
    <p>These terms may be updated at any time. Continued use of the application after changes are posted constitutes acceptance of the revised terms.</p>
    <h4>8. Governing Law</h4>
    <p>These terms are governed by the laws of the jurisdiction in which the application developer resides, without regard to conflict-of-law principles.</p>
  </div>`;
}

function renderPrivacyHtml() {
  return `<div class="settings-legal-section">
    <h4>Privacy Policy</h4>
    <p>Last updated: May 2026</p>
    <h4>1. Data We Collect</h4>
    <p>ZenkaiTV stores all user data locally on your device using <code>localStorage</code>. This includes:</p>
    <ul>
      <li>Your favorite shows and watch history</li>
      <li>UI preferences (language, theme, volume, motion)</li>
      <li>Configured source endpoints and API keys</li>
      <li>Cached API responses (metadata, episode lists)</li>
    </ul>
    <h4>2. Data We Do NOT Collect</h4>
    <p>We do not collect, transmit, or store any of your personal data on external servers. ZenkaiTV has no analytics, no telemetry, no accounts, and no login system.</p>
    <h4>3. Third-Party API Requests</h4>
    <p>When you use ZenkaiTV, the app makes requests to third-party APIs (AniList, Jikan, and any sources you configure). These services have their own privacy policies. Your IP address may be visible to those services as part of normal internet traffic.</p>
    <h4>4. Local Storage</h4>
    <p>All cached metadata and preferences are stored in your browser's <code>localStorage</code>. You can clear this data at any time from Settings → Player → Clear Cache, or through your browser's developer tools. Cache entries expire automatically based on their configured TTL.</p>
    <h4>5. API Keys</h4>
    <p>Any API keys you enter (e.g., for Anime1v) are stored locally in your browser only. They are never transmitted to the ZenkaiTV developers or any third party other than the specific service the key belongs to.</p>
    <h4>6. Children's Privacy</h4>
    <p>ZenkaiTV is not directed at children under 13. We do not knowingly collect information from children. If you believe a child is using the application inappropriately, please refer to your device's parental controls.</p>
    <h4>7. Changes to This Policy</h4>
    <p>We may update this Privacy Policy from time to time. The "last updated" date at the top reflects when changes were last made. Continued use of the application constitutes acceptance.</p>
    <h4>8. Contact</h4>
    <p>For privacy-related questions, please open an issue in the project repository or contact the developer directly.</p>
  </div>`;
}

function renderSettings() {
  if (!settingsGrid) return;
  const language = state.appLanguage;
  const preferences = getLanguagePreferences();
  const ui = state.uiPreferences;
  const tabs = ["general", "player", "sources", "shortcuts", "legal"];
  const activeTab = tabs.includes(state.activeSettingsTab) ? state.activeSettingsTab : "general";
  const activeLegalTab = state.activeLegalTab || "terms";
  const tc = (tab) => `settings-rail-item focusable ${activeTab === tab ? "is-selected" : ""}`;
  const pa = (tab) => `class="settings-panel ${activeTab === tab ? "is-active" : ""}" id="settings-${tab}" data-settings-panel="${tab}" ${activeTab === tab ? "" : "hidden"}`;
  const enabled = state.localSources.filter((s) => s.enabled).length;

  settingsGrid.innerHTML = `
    <aside class="settings-rail" aria-label="Settings categories">
      <button class="${tc("general")}" data-settings-nav="general" type="button">
        <span class="rail-icon" aria-hidden="true">⚙</span> General
      </button>
      <button class="${tc("player")}" data-settings-nav="player" type="button">
        <span class="rail-icon" aria-hidden="true">▶</span> Player
      </button>
      <button class="${tc("sources")}" data-settings-nav="sources" type="button">
        <span class="rail-icon" aria-hidden="true">◉</span> Sources
      </button>
      <button class="${tc("shortcuts")}" data-settings-nav="shortcuts" type="button">
        <span class="rail-icon" aria-hidden="true">⌨</span> Shortcuts
      </button>
      <button class="${tc("legal")}" data-settings-nav="legal" type="button">
        <span class="rail-icon" aria-hidden="true">⚖</span> Legal
      </button>
      <span class="settings-version">ZenkaiTV 2.0<br>Web / Android TV</span>
    </aside>

    <div class="settings-console">

      <!-- ── General ── -->
      <section ${pa("general")}>
        <div class="settings-panel-head">
          <span class="settings-icon" aria-hidden="true">⚙</span>
          <div>
            <h3>General</h3>
            <p>Language, layout, and app behavior.</p>
          </div>
        </div>

        <div class="settings-group-label">Interface</div>
        <div class="settings-line">
          <span>${t("appLanguage")}</span>
          <div class="settings-row settings-segment">
            <button class="settings-choice focusable ${language === "en" ? "is-selected" : ""}" data-app-language="en">${t("english")}</button>
            <button class="settings-choice focusable ${language === "es" ? "is-selected" : ""}" data-app-language="es">${t("spanish")}</button>
          </div>
        </div>
        <div class="settings-line">
          <span>${t("compactSidebar")} <small>Collapse navigation to icon-only</small></span>
          <button class="settings-switch focusable ${state.sidebarCollapsed ? "is-on" : ""}" data-toggle-sidebar-setting type="button"><b></b></button>
        </div>
        <div class="settings-line">
          <span>Anime title language <small>How titles appear across the app</small></span>
          <div class="settings-row settings-segment">
            <button class="settings-choice focusable ${ui.titleLanguage !== "romaji" ? "is-selected" : ""}" data-title-language="english">English</button>
            <button class="settings-choice focusable ${ui.titleLanguage === "romaji" ? "is-selected" : ""}" data-title-language="romaji">Romaji</button>
          </div>
        </div>

        <div class="settings-divider"></div>
        <div class="settings-group-label">Accessibility</div>
        <div class="settings-line">
          <span>${t("tvFocus")} <small>Highlight ring on focused elements</small></span>
          <button class="settings-switch focusable ${ui.focusGlow ? "is-on" : ""}" data-toggle-pref="focusGlow" type="button"><b></b></button>
        </div>
        <div class="settings-line">
          <span>${t("motion")} <small>Enable UI animations and transitions</small></span>
          <button class="settings-switch focusable ${ui.motion ? "is-on" : ""}" data-toggle-pref="motion" type="button"><b></b></button>
        </div>

        <div class="settings-divider"></div>
        <div class="settings-group-label">Catalog</div>
        <div class="settings-line">
          <span>Loaded catalog <small>Live source / title / episode totals</small></span>
          <span class="settings-stat" id="settingsCatalogStatus">${escapeHtml(state.catalogStatus || "Syncing anime metadata…")}</span>
        </div>

        <div class="settings-divider"></div>
        <div class="settings-group-label">Data</div>
        <div class="settings-actions">
          <button class="secondary-action focusable" data-clear-cache>${t("clearCache")}</button>
          <button class="secondary-action focusable" data-reset-settings>${t("resetSettings")}</button>
        </div>
      </section>

      <!-- ── Player ── -->
      <section ${pa("player")}>
        <div class="settings-panel-head">
          <span class="settings-icon" aria-hidden="true">▶</span>
          <div>
            <h3>${t("playback")}</h3>
            <p>Player engine, quality, and autoplay behavior.</p>
          </div>
        </div>

        <div class="settings-group-label">Playback</div>
        <div class="settings-line">
          <span>Player engine <small>Use the APK-style video.js player for direct streams</small></span>
          <div class="settings-row settings-segment">
            <button class="settings-choice focusable ${ui.playerEngine !== "native" ? "is-selected" : ""}" data-player-engine="apk" type="button">APK</button>
            <button class="settings-choice focusable ${ui.playerEngine === "native" ? "is-selected" : ""}" data-player-engine="native" type="button">Native</button>
          </div>
        </div>
        <div class="settings-line">
          <span>Video fit <small>Same contain, cover, and fill modes as the APK player</small></span>
          <div class="settings-row settings-segment">
            ${["contain", "cover", "fill"].map((fit) => `
              <button class="settings-choice focusable ${ui.playerFit === fit ? "is-selected" : ""}" data-player-fit-setting="${fit}" type="button">${fit}</button>
            `).join("")}
          </div>
        </div>
        <label class="settings-line">
          <span>Stream quality <small>Auto or fixed HLS quality rank when available</small></span>
          <select class="language-select focusable settings-select" id="settingsQuality">
            <option value="0" ${Number(ui.playerQuality || 0) === 0 ? "selected" : ""}>Auto</option>
            <option value="1" ${Number(ui.playerQuality || 0) === 1 ? "selected" : ""}>Highest</option>
            <option value="2" ${Number(ui.playerQuality || 0) === 2 ? "selected" : ""}>Second</option>
            <option value="3" ${Number(ui.playerQuality || 0) === 3 ? "selected" : ""}>Third</option>
          </select>
        </label>
        <div class="settings-line">
          <span>Hero autoplay <small>Auto-play featured trailer on home screen</small></span>
          <button class="settings-switch focusable ${ui.autoplayHero ? "is-on" : ""}" data-toggle-pref="autoplayHero" type="button"><b></b></button>
        </div>
        <div class="settings-line">
          <span>Live subtitle translation <small>Translate available subtitle files to Spanish during playback</small></span>
          <button class="settings-switch focusable ${ui.subtitleTranslation ? "is-on" : ""}" data-toggle-pref="subtitleTranslation" type="button"><b></b></button>
        </div>
        <div class="settings-line">
          <span>Rich metadata <small>Show AniList/MAL IDs, status, score, and source info in anime details</small></span>
          <button class="settings-switch focusable ${ui.metadataDetail ? "is-on" : ""}" data-toggle-pref="metadataDetail" type="button"><b></b></button>
        </div>
      </section>

      <!-- ── Sources ── -->
      <section ${pa("sources")}>
        <div class="settings-panel-head">
          <span class="settings-icon" aria-hidden="true">◉</span>
          <div>
            <h3>Sources &amp; Addons</h3>
            <p>Manage catalog connectors, APIs, and streaming endpoints.</p>
          </div>
        </div>
        <p class="settings-source-summary">${
          state.localSources.length
            ? `${enabled} enabled source${enabled === 1 ? "" : "s"} · Metadata: ${escapeHtml(state.apiStatus.metadata)} · Direct: ${escapeHtml(state.apiStatus.direct)}`
            : t("sourceSummaryDefault")
        }</p>
        <div class="settings-sources-grid" id="settingsSourcesGrid">
          ${buildSourceCardsHtml()}
        </div>
      </section>

      <!-- ── Shortcuts ── -->
      <section ${pa("shortcuts")}>
        <div class="settings-panel-head">
          <span class="settings-icon" aria-hidden="true">⌨</span>
          <div>
            <h3>Shortcuts</h3>
            <p>Keyboard and remote control actions.</p>
          </div>
        </div>

        <div class="settings-group-label">Player Controls</div>
        ${[
          ["Play / Pause", "Space"],
          ["Seek back 10 s", "←"],
          ["Seek forward 10 s", "→"],
          ["Volume up", "↑"],
          ["Volume down", "↓"],
          ["Toggle fullscreen", "F"],
          ["Exit / Back", "Esc"],
        ].map(([label, keys]) => `
          <div class="settings-shortcut-row">
            <span>${label}</span>
            <kbd>${keys}</kbd>
          </div>
        `).join("")}

        <div class="settings-divider"></div>
        <div class="settings-group-label">Navigation</div>
        ${[
          ["Previous episode", "Shift + P"],
          ["Next episode", "Shift + N"],
          ["Open settings", "Ctrl + ,"],
          ["Search", "Ctrl + K"],
        ].map(([label, keys]) => `
          <div class="settings-shortcut-row">
            <span>${label}</span>
            <kbd>${keys}</kbd>
          </div>
        `).join("")}
      </section>

      <!-- ── Legal ── -->
      <section ${pa("legal")}>
        <div class="settings-panel-head">
          <span class="settings-icon" aria-hidden="true">⚖</span>
          <div>
            <h3>Legal</h3>
            <p>Terms of Service and Privacy Policy.</p>
          </div>
        </div>
        <div class="settings-legal-tabs">
          <button class="settings-choice focusable ${activeLegalTab === "terms" ? "is-selected" : ""}" data-legal-tab="terms" type="button">${t("terms")}</button>
          <button class="settings-choice focusable ${activeLegalTab === "privacy" ? "is-selected" : ""}" data-legal-tab="privacy" type="button">${t("privacy")}</button>
        </div>
        <div class="settings-legal-content" id="legalContent">
          ${activeLegalTab === "terms" ? renderTermsHtml() : renderPrivacyHtml()}
        </div>
      </section>

    </div>
  `;
  wireSettingsButtons();
}

function wireSettingsButtons() {
  if (!settingsGrid) return;

  // Tab navigation
  settingsGrid.querySelectorAll("[data-settings-nav]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeSettingsTab = button.dataset.settingsNav || "general";
      renderSettings();
      refreshFocusables();
    });
  });

  // Language picker
  settingsGrid.querySelectorAll("[data-app-language]").forEach((button) => {
    button.addEventListener("click", () => {
      state.appLanguage = button.dataset.appLanguage;
      localStorage.setItem(APP_LANGUAGE_KEY, state.appLanguage);
      applyAppLanguage();
      renderSettings();
      refreshFocusables();
    });
  });

  // Title language toggle (English ↔ Romaji)
  settingsGrid.querySelectorAll("[data-title-language]").forEach((button) => {
    button.addEventListener("click", () => {
      saveUiPreferences({ titleLanguage: button.dataset.titleLanguage });
      render();          // re-render cards, schedule, carousel
      renderSettings();
      showToast(`Title language set to ${button.dataset.titleLanguage}`);
    });
  });

  settingsGrid.querySelectorAll("[data-player-engine]").forEach((button) => {
    button.addEventListener("click", () => {
      saveUiPreferences({ playerEngine: button.dataset.playerEngine || "apk" });
      renderSettings();
      showToast("Player setting saved");
    });
  });

  settingsGrid.querySelectorAll("[data-player-fit-setting]").forEach((button) => {
    button.addEventListener("click", () => {
      saveUiPreferences({ playerFit: button.dataset.playerFitSetting || "contain" });
      renderSettings();
      showToast("Video fit saved");
    });
  });

  settingsGrid.querySelector("#settingsQuality")?.addEventListener("change", (event) => {
    saveUiPreferences({ playerQuality: Number(event.target.value) || 0 });
    showToast("Quality preference saved");
  });

  // Sidebar collapse toggle
  settingsGrid.querySelector("[data-toggle-sidebar-setting]")?.addEventListener("click", () => {
    toggleSidebar();
    renderSettings();
  });

  // Boolean pref toggles (switches)
  settingsGrid.querySelectorAll("[data-toggle-pref]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.togglePref;
      saveUiPreferences({ [key]: !state.uiPreferences[key] });
      if (key === "autoplayHero") {
        if (state.uiPreferences.autoplayHero) restartCarouselTimer();
        else window.clearInterval(carouselTimer);
      }
      renderSettings();
      refreshFocusables();
    });
  });

  // Volume slider
  const volSlider = settingsGrid.querySelector("[data-settings-volume]");
  const volDisplay = settingsGrid.querySelector("#volDisplay");
  if (volSlider) {
    const updateVol = () => {
      const pct = Number(volSlider.value);
      const raw = pct / 100;
      volSlider.style.setProperty("--vol-pct", `${pct}%`);
      if (volDisplay) volDisplay.textContent = `${pct}%`;
      saveUiPreferences({ defaultVolume: raw });
      const livePlayer = document.querySelector("#animePlayer");
      if (livePlayer) livePlayer.volume = raw;
    };
    volSlider.addEventListener("input", updateVol);
    volSlider.addEventListener("change", updateVol);
  }

  // Clear cache
  settingsGrid.querySelector("[data-clear-cache]")?.addEventListener("click", () => {
    Object.keys(localStorage)
      .filter((key) => key.startsWith(RESPONSE_CACHE_PREFIX) || key.startsWith(ANIPUB_EPISODE_FALLBACK_PREFIX))
      .forEach((key) => localStorage.removeItem(key));
    anipubCatalogCache = null;
    anipubEpisodesCache.clear();
    showToast(t("cacheCleared"));
  });

  // Reset settings
  settingsGrid.querySelector("[data-reset-settings]")?.addEventListener("click", () => {
    localStorage.removeItem(APP_THEME_KEY);
    localStorage.removeItem(APP_UI_PREFS_KEY);
    state.theme = "dark";
    state.uiPreferences = readUiPreferences();
    applyUiPreferences();
    renderSettings();
    refreshFocusables();
    showToast(t("settingsSaved"));
  });

  // Legal sub-tabs
  settingsGrid.querySelectorAll("[data-legal-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeLegalTab = button.dataset.legalTab || "terms";
      const content = settingsGrid.querySelector("#legalContent");
      if (content) {
        content.innerHTML = state.activeLegalTab === "terms" ? renderTermsHtml() : renderPrivacyHtml();
      }
      settingsGrid.querySelectorAll("[data-legal-tab]").forEach((btn) => {
        btn.classList.toggle("is-selected", btn.dataset.legalTab === state.activeLegalTab);
      });
    });
  });

  // Source buttons scoped to settings panel
  const settingsSourcesGrid = settingsGrid.querySelector("#settingsSourcesGrid");
  if (settingsSourcesGrid) wireSourceButtons(settingsSourcesGrid);
}

function wireSourceButtons(root = document) {
  root.querySelector("[data-source-add]")?.addEventListener("click", addCustomSource);

  root.querySelectorAll("[data-source-remove]").forEach((button) => {
    button.onclick = () => removeSource(button.dataset.sourceRemove);
  });

  root.querySelectorAll("[data-source-toggle]").forEach((button) => {
    button.onclick = () => {
      const source = state.localSources.find((item) => item.id === button.dataset.sourceToggle);
      if (!source) return;
      saveSourceOverride(source.id, { enabled: !source.enabled });
      state.localSources = state.localSources.map((item) =>
        item.id === source.id ? applySourceOverride({ ...item, enabled: !source.enabled }) : item
      );
      renderSources();
      if (state.route === "settings") renderSettings();
      loadExternalSources();
    };
  });

  root.querySelectorAll("[data-source-test]").forEach((button) => {
    button.onclick = async () => {
      const source = state.localSources.find((item) => item.id === button.dataset.sourceTest);
      if (!source) return;
      button.disabled = true;
      markSourceStatus(source.name, "Testing...");
      try {
        if (source.healthEndpoint) {
          const healthResponse = await fetchWithTimeout(withAnime1vApiKey(resolveSourceEndpoint(source.healthEndpoint), source), { cache: "no-store" }, 9000);
          const health = await healthResponse.json().catch(() => ({}));
          if (!healthResponse.ok || health.ok === false) throw new Error(health.note || health.error || "Health check failed");
          markSourceStatus(source.name, health.sampleCount ? `Ready (${health.sampleCount} sample titles)` : "Ready");
          return;
        }
        const items = await fetchExternalCatalog(source);
        markSourceStatus(source.name, `${items.length} titles`);
      } catch (error) {
        markSourceStatus(source.name, "Server offline or wrong URL");
      } finally {
        button.disabled = false;
      }
    };
  });

  root.querySelector("[data-anime1v-key]")?.addEventListener("change", (event) => {
    const value = event.target.value.trim();
    if (value) localStorage.setItem(ANIME1V_API_KEY_STORAGE, value);
    else localStorage.removeItem(ANIME1V_API_KEY_STORAGE);
    markSourceStatus("Anime1v (Japanese + Spanish Subs)", value ? "API key saved" : "API key cleared");
  });

  // Built-in playback scraper toggles (AnimeAV1 / TioAnime).
  root.querySelectorAll("[data-scraper-toggle]").forEach((button) => {
    button.onclick = () => {
      const id = button.dataset.scraperToggle;
      setScraperEnabled(id, !isScraperEnabled(id));
      renderSources();
      showToast(`${id} ${isScraperEnabled(id) ? "enabled" : "disabled"}`);
    };
  });

  root.querySelectorAll("[data-scraper-test]").forEach((button) => {
    button.onclick = async () => {
      const scraper = PLAYBACK_SCRAPERS.find((s) => s.id === button.dataset.scraperTest);
      if (!scraper) return;
      button.disabled = true;
      const original = button.textContent;
      button.textContent = "Testing…";
      try {
        const res = await fetchWithTimeout(scraper.health, { cache: "no-store" }, 9000);
        const ok = res.ok;
        showToast(ok ? `${scraper.name} is online ✓` : `${scraper.name} returned HTTP ${res.status}`);
      } catch {
        showToast(`${scraper.name} is offline`);
      } finally {
        button.disabled = false;
        button.textContent = original;
      }
    };
  });
}

function render() {
  const filtered = visibleShows();
  if (state.isLoadingCatalog && !filtered.length) {
    renderSkeletonCards(latestGrid, 14);
    renderSkeletonCards(libraryGrid, 14);
  } else {
    renderCards(latestGrid, buildLatestEpisodesList(HOME_CARD_LIMIT));
    renderCards(libraryGrid, filtered.slice(0, state.search ? SEARCH_CARD_LIMIT : LIBRARY_CARD_LIMIT));
  }
  renderContinueWatching();
  renderAniPubCatalog();
  renderCards(favoritesGrid, filtered.filter((show) => state.favorites.includes(show.id)));
  const emptyFavorites = document.querySelector("#emptyFavorites");
  if (emptyFavorites && favoritesGrid) emptyFavorites.hidden = favoritesGrid.children.length > 0;
  renderSchedule();
  renderAddonSections();
  if (state.route === "settings") renderSettings();
  renderCarousel();
  applyAppLanguage();
  wireOpenButtons();
  wireRailButtons();
  syncRouteVisibility();
  refreshFocusables();
}

function wireRailButtons() {
  document.querySelectorAll("[data-scroll-rail]").forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      const rail = document.getElementById(button.dataset.scrollRail);
      if (!rail) return;
      const direction = Number(button.dataset.scrollDir || 1);
      const amount = Math.max(rail.clientWidth * 0.82, 420);
      rail.scrollBy({ left: amount * direction, behavior: "smooth" });
    };
  });
}

function setRoute(route) {
  state.route = route;
  document.body.dataset.route = route;
  // Returning Home starts fresh: clear any active search so Home shows the full
  // Latest Episodes instead of a filtered leftover from the Search tab.
  const clearedSearch = route === "home" && Boolean(state.search);
  if (clearedSearch) {
    state.search = "";
    [searchInput, searchInputTop, searchInputLibrary, searchInputAniPub].forEach((el) => {
      if (el) el.value = "";
    });
    document.querySelectorAll(".search-box .search-clear").forEach((c) => { c.hidden = true; });
  }
  document.querySelectorAll(".nav-link").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.route === route);
  });

  if (clearedSearch) render();   // refresh the now-unfiltered Home grids
  syncRouteVisibility();
  // The hero trailer only runs on Home — stop it elsewhere, restart on return.
  if (route === "home") { renderCarousel(); loadAnimeAv1Latest(); }
  else stopCarouselTrailer();
  if (route === "anipub") ensureAniPubCatalogLoaded();
  if (route === "settings") renderSettings();
  if (route === "sources") renderSources();
  if ((route === "sources" || route === "search") && !state.externalSourcesLoaded) {
    scheduleExternalSourcesLoad();
  }
  scrollToRoute(route);
  refreshFocusables();
}

function syncRouteVisibility() {
  sections.forEach((section) => {
    const isHomeExtra = state.route === "home" && section.id === "latest";
    const isTarget = section.id === state.route;
    const hidden = !(isHomeExtra || isTarget);
    section.classList.toggle("is-hidden", hidden);
    section.setAttribute("aria-hidden", hidden ? "true" : "false");
  });
  if (searchInputTop) searchInputTop.closest(".stremio-search").hidden = state.route !== "home";
  if (searchInputLibrary) searchInputLibrary.closest(".library-search").hidden = state.route !== "library";
  if (addonSections) addonSections.hidden = state.route !== "home" || !addonSections.innerHTML.trim();
}

function scrollToRoute(route) {
  window.requestAnimationFrame(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

async function openShow(id, target = {}) {
  stopCarouselTrailer();   // never leave a hero trailer running behind the overlay
  const wantedId = String(id || "");
  let show = state.shows.find((entry) => String(entry.id) === wantedId || getShowKey(entry) === wantedId);
  if (!show) {
    const addonShow = state.addonSections.flatMap((section) => section.items || []).find((entry) => String(entry.id) === wantedId || getShowKey(entry) === wantedId);
    if (addonShow) {
      show = addonShow;
      if (!state.shows.some((entry) => entry.id === addonShow.id || getShowKey(entry) === getShowKey(addonShow))) {
        state.shows = [...state.shows, addonShow];
      }
    }
  }
  // AnimeAV1-only "Latest Episodes" cards (niche shows not in the AniList catalog)
  // live in a side registry — promote into the catalog so the open flow can run.
  if (!show && state.av1Shows?.has(wantedId)) {
    show = state.av1Shows.get(wantedId);
    if (!state.shows.some((entry) => entry.id === show.id)) state.shows = [...state.shows, show];
  }
  if (!show) return;
  state.activeShow = show;
  state.activeEpisodeUrl = "";
  state.activeEpisode = null;
  // Metadata now lives on the cinematic left column, so the right panel opens
  // straight to the episode list (matches the reference composition).
  state.activeDetailTab = "episodes";
  state.activeSeasonIndex = 0;
  const openToken = `${show.id || getShowKey(show)}:${Date.now()}`;
  state.activeOpenToken = openToken;

  // ── Show the overlay shell INSTANTLY (poster + title) so opening feels snappy.
  resetVideoFrame();
  syncWatchHeading(show);
  document.querySelector("#watchDescription").textContent = show.description;
  setFavoriteButtonState(state.favorites.includes(show.id));
  overlay.hidden = false;
  // Land focus on the Play action (remote-friendly) so OK plays and D-pad reaches
  // the episode list — instead of the easily-missed close button.
  const playBtn = document.querySelector("#fakePlay");
  if (playBtn) focusElement(playBtn); else closeOverlay.focus();

  // ── Defer the heavier episode-list / season build to the next frame so the
  //    browser can paint the overlay first (avoids the "couple seconds" lag).
  requestAnimationFrame(() => {
    if (state.activeOpenToken !== openToken) return; // user already closed/navigated
    applyOpenTarget(show, target);
    renderEpisodeList(show);
    refreshFocusables();
    hydrateOpenShowDetails(show, target, openToken);
  });
}

async function hydrateOpenShowDetails(show, target = {}, openToken = "") {
  try {
    // For metadata-only shows (scrapled, AniList/Jikan, etc.) that have no
    // native episode endpoint, run ALL source hydrators in parallel so the
    // episode list fills in from whichever provider matches the title fastest.
    const isNativeSource = isAniPubShow(show) || isJimovShow(show);
    await Promise.allSettled([
      isAniPubShow(show)  ? hydrateAniPubEpisodes(show)  : Promise.resolve(show),
      isJimovShow(show)   ? hydrateJimovEpisodes(show)   : Promise.resolve(show),
      // For scrapled/metadata-only shows, fan out title search to all sources
      !isNativeSource     ? enrichShowFromAllSources(show) : Promise.resolve(show),
      // AniList franchise/relations — non-blocking, enriches the Seasons tab
      hydrateShowAniListFranchise(show),
      // TioAnime slug resolution — stores show.tioAnimeSlug for episode playback
      hydrateTioAnimeSlug(show)
    ]);
    if (state.activeOpenToken !== openToken || state.activeShow?.id !== show.id) return;
    // Ensure every franchise entry (movies, OVAs, related seasons) has a minimal
    // show object in state.shows so openShow() can navigate to them on click.
    ensureFranchiseShowsInCatalog(show);
    // Only re-apply the open target if no episode was selected yet (e.g. episodes
    // weren't loaded at openShow time). Skip if the user already navigated manually.
    if (!state.activeEpisode) {
      applyOpenTarget(show, target);
    }
    if (state.activeEpisode?.episode) {
      await attachPlaybackSourceOptions(show, state.activeEpisode.episode, state.activeEpisode?.season?.season || state.activeSeasonIndex + 1 || 1);
      if (state.activeOpenToken !== openToken || state.activeShow?.id !== show.id) return;
    }
    renderEpisodeList(show);
    syncWatchHeading(show);
    const descriptionNode = document.querySelector("#watchDescription");
    if (descriptionNode) descriptionNode.textContent = show.description;
    setFavoriteButtonState(state.favorites.includes(show.id));
    // Pre-fetch sources in the background so they're ready, but only OPEN the
    // source picker when the user explicitly intends to play (Play button or an
    // episode click). Opening a show from a card/poster lands on the detail view.
    if (state.activeEpisode) {
      const ep = state.activeEpisode;
      schedulePlaybackSourceOptions(show, ep.episode, ep.season?.season || ep.seasonIndex + 1 || 1);
      if (target.playIntent) {
        const frame = document.querySelector("#videoFrame");
        if (frame && !document.body.classList.contains("player-cinema-open")) {
          const background = show.banner || show.image || "";
          frame.style.setProperty("--watch-bg", background ? `url("${background}")` : "none");
          renderSourcePickerIn(frame);
        }
      }
    }
    refreshFocusables();
  } catch (error) {
    console.warn("Anime details continued without remote episode hydration:", error);
  }
}

async function hydrateAnime1vEpisodes(show) {
  if (!show || show.anime1vEpisodesLoaded) return show;
  const animeUrl = show.anime1vUrl || show.siteUrl;
  const provider = show.provider || inferAnime1vProvider(animeUrl);
  const endpoint = show.episodeEndpoint || "./api/anime1v/episodes";
  if (!animeUrl || !endpoint) return show;
  try {
    const url = new URL(resolveSourceEndpoint(endpoint), location.href);
    url.searchParams.set("url", animeUrl);
    if (provider) url.searchParams.set("provider", provider);
    if (getAnime1vApiKey()) url.searchParams.set("apiKey", getAnime1vApiKey());
    const response = await fetchWithTimeout(url.toString(), { cache: "no-store" }, 20000);
    if (!response.ok) throw new Error("Anime1v episode endpoint unavailable");
    const payload = await response.json();
    if (!payload.ok || !Array.isArray(payload.episodes) || !payload.episodes.length) return show;
    const mergedImage = payload.image || payload.poster || payload.cover || payload.thumbnail || show.image || "";
    const mergedDescription = payload.description || payload.synopsis || show.description || "";
    if (mergedImage && !show.image) show.image = mergedImage;
    if (payload.banner || payload.backdrop || mergedImage) show.banner = payload.banner || payload.backdrop || show.banner || mergedImage;
    if (mergedDescription) show.description = cleanDescription(mergedDescription);
    const seasonNumber = extractSeasonNumber(payload.title || show.title, extractSeasonNumber(show.title, 1));
    const episodes = repairEpisodeGaps(payload.episodes.map((episode) => ({
      ...episode,
      id: episode.id || `${show.id}-anime1v-${episode.episode || episode.number}`,
      title: episode.title || `Episode ${episode.episode || episode.number}`,
      season: episode.season || seasonNumber,
      episode: episode.episode || episode.number,
      server: episode.server || provider || "Anime1v",
      sourceOptions: normalizeEpisodeSourceOptions(episode),
      locked: episode.locked ?? !(getEpisodeUrl(episode) || episode.externalUrl || episode.streamResolver),
      availableAudio: episode.availableAudio || ["japanese"],
      availableSubs: episode.availableSubs || ["spanish", "none"],
      defaultAudio: episode.defaultAudio || "japanese",
      defaultSubs: episode.defaultSubs || "spanish"
    })), seasonNumber);
    show.episode = episodes.length;
    show.episodes = episodes;
    show.seasons = [{
      season: seasonNumber,
      title: `Season ${seasonNumber}`,
      sourceTitle: show.title,
      image: show.image || mergedImage,
      playable: true,
      episodes
    }];
    show.anime1vEpisodesLoaded = true;
    state.shows = state.shows.map((entry) => entry.id === show.id ? show : entry);
    state.addonSections = state.addonSections.map((section) => ({
      ...section,
      items: (section.items || []).map((entry) => entry.id === show.id ? show : entry)
    }));
  } catch (error) {
    console.warn("Anime1v episodes could not load:", error);
    show.anime1vError = error.message;
  }
  return show;
}

function isAnime1vShow(show) {
  return /anime1v/i.test(String(show?.source || ""))
    || /anime1v/i.test(String(show?.id || ""))
    || Boolean(show?.anime1vUrl);
}

async function hydrateConsumetEpisodes(show) {
  if (!show || show.consumetEpisodesLoaded) return show;
  const consumetId = show.consumetId || show.consumetUrl || show.siteUrl;
  const endpoint = show.episodeEndpoint || "./api/consumet/kickassanime/info";
  if (!consumetId || !endpoint) return show;
  try {
    const url = new URL(resolveSourceEndpoint(endpoint), location.href);
    url.searchParams.set("id", consumetId);
    const response = await fetchWithTimeout(url.toString(), { cache: "no-store" }, 20000);
    if (!response.ok) throw new Error("Consumet KickAssAnime episode endpoint unavailable");
    const payload = await response.json();
    if (!payload.ok || !Array.isArray(payload.episodes) || !payload.episodes.length) return show;
    if (payload.image && !show.image) show.image = payload.image;
    if (payload.banner && !show.banner) show.banner = payload.banner;
    if (payload.description) show.description = cleanDescription(payload.description);
    const seasonNumber = extractSeasonNumber(payload.title || show.title, extractSeasonNumber(show.title, 1));
    const episodes = repairEpisodeGaps(payload.episodes.map((episode) => ({
      ...episode,
      id: episode.id || `${show.id}-consumet-${episode.episode || episode.number}`,
      season: episode.season || seasonNumber,
      episode: episode.episode || episode.number,
      server: episode.server || "Consumet KickAssAnime",
      sourceOptions: normalizeEpisodeSourceOptions(episode),
      locked: episode.locked ?? !(getEpisodeUrl(episode) || episode.externalUrl || episode.streamResolver),
      availableAudio: episode.availableAudio || ["japanese"],
      availableSubs: episode.availableSubs || ["spanish", "spanish-translated", "english", "none"],
      defaultAudio: episode.defaultAudio || "japanese",
      defaultSubs: episode.defaultSubs || "spanish"
    })), seasonNumber);
    show.episode = episodes.length;
    show.episodes = episodes;
    show.seasons = [{
      season: seasonNumber,
      title: `Season ${seasonNumber}`,
      sourceTitle: show.title,
      image: show.image,
      playable: true,
      episodes
    }];
    show.consumetEpisodesLoaded = true;
    state.shows = state.shows.map((entry) => entry.id === show.id ? show : entry);
    state.addonSections = state.addonSections.map((section) => ({
      ...section,
      items: (section.items || []).map((entry) => entry.id === show.id ? show : entry)
    }));
  } catch (error) {
    console.warn("Consumet KickAssAnime episodes could not load:", error);
    show.consumetError = error.message;
  }
  return show;
}

function isConsumetShow(show) {
  return /consumet|kickassanime/i.test(String(show?.source || ""))
    || /consumet-kaa/i.test(String(show?.id || ""))
    || Boolean(show?.consumetId || show?.consumetUrl);
}

async function hydrateRapidAnimeEpisodes(show) {
  if (!show || show.rapidAnimeEpisodesLoaded) return show;
  const animeId = show.rapidAnimeId || show.aliases?.[0] || show.siteUrl || show.id;
  const endpoint = show.episodeEndpoint || "./api/rapid-anime/info";
  if (!animeId || !endpoint) return show;
  try {
    const url = new URL(resolveSourceEndpoint(endpoint), location.href);
    url.searchParams.set("id", String(animeId).replace(/^rapid-anime-/, ""));
    const response = await fetchWithTimeout(url.toString(), { cache: "no-store" }, 20000);
    if (!response.ok) throw new Error("RapidAPI episode endpoint unavailable");
    const payload = await response.json();
    if (!payload.ok || !Array.isArray(payload.episodes) || !payload.episodes.length) return show;
    if (payload.image && !show.image) show.image = payload.image;
    if (payload.banner && !show.banner) show.banner = payload.banner;
    if (payload.description) show.description = cleanDescription(payload.description);
    const seasonNumber = extractSeasonNumber(payload.title || show.title, extractSeasonNumber(show.title, 1));
    const episodes = repairEpisodeGaps(payload.episodes.map((episode) => ({
      ...episode,
      id: episode.id || `${show.id}-rapid-${episode.episode || episode.number}`,
      title: episode.title || `Episode ${episode.episode || episode.number}`,
      season: episode.season || seasonNumber,
      episode: episode.episode || episode.number,
      server: episode.server || "RapidAPI Anime Streaming",
      sourceOptions: normalizeEpisodeSourceOptions(episode),
      locked: episode.locked ?? !(getEpisodeUrl(episode) || episode.externalUrl || episode.streamResolver),
      availableAudio: episode.availableAudio || ["japanese"],
      availableSubs: episode.availableSubs || ["spanish", "spanish-translated", "english", "none"],
      defaultAudio: episode.defaultAudio || "japanese",
      defaultSubs: episode.defaultSubs || "spanish"
    })), seasonNumber);
    show.episode = episodes.length;
    show.episodes = episodes;
    show.seasons = [{
      season: seasonNumber,
      title: `Season ${seasonNumber}`,
      sourceTitle: show.title,
      image: show.image,
      playable: true,
      episodes
    }];
    show.rapidAnimeEpisodesLoaded = true;
    state.shows = state.shows.map((entry) => entry.id === show.id ? show : entry);
    state.addonSections = state.addonSections.map((section) => ({
      ...section,
      items: (section.items || []).map((entry) => entry.id === show.id ? show : entry)
    }));
  } catch (error) {
    console.warn("RapidAPI Anime Streaming episodes could not load:", error);
    show.rapidAnimeError = error.message;
  }
  return show;
}

function isRapidAnimeShow(show) {
  return /rapidapi anime streaming|rapid-anime/i.test(String(show?.source || ""))
    || /rapid-anime/i.test(String(show?.id || ""))
    || Boolean(show?.rapidAnimeId);
}

async function hydrateJimovEpisodes(show) {
  if (!show || show.jimovEpisodesLoaded) return show;
  const jimovUrl = show.jimovUrl || show.siteUrl;
  const endpoint = show.episodeEndpoint || "./api/jimov/tioanime/info";
  if (!jimovUrl || !endpoint) return show;
  try {
    const url = new URL(resolveSourceEndpoint(endpoint), location.href);
    url.searchParams.set("url", jimovUrl);
    const response = await fetchWithTimeout(url.toString(), { cache: "no-store" }, 20000);
    if (!response.ok) throw new Error("JIMOV episode endpoint unavailable");
    const payload = await response.json();
    if (!payload.ok || !Array.isArray(payload.episodes) || !payload.episodes.length) return show;
    if (payload.image && !show.image) show.image = payload.image;
    if (payload.banner && !show.banner) show.banner = payload.banner;
    if (payload.description) show.description = cleanDescription(payload.description);
    const episodes = repairEpisodeGaps(payload.episodes.map((episode) => ({
      ...episode,
      id: episode.id || `${show.id}-jimov-${episode.episode || episode.number}`,
      season: episode.season || 1,
      episode: episode.episode || episode.number,
      server: episode.server || "JIMOV TioAnime",
      sourceOptions: normalizeEpisodeSourceOptions(episode),
      locked: episode.locked ?? !(getEpisodeUrl(episode) || episode.externalUrl || episode.streamResolver),
      availableAudio: episode.availableAudio || ["japanese"],
      availableSubs: episode.availableSubs || ["spanish", "none"],
      defaultAudio: episode.defaultAudio || "japanese",
      defaultSubs: episode.defaultSubs || "spanish"
    })), 1);
    show.episode = episodes.length;
    show.episodes = episodes;
    show.seasons = [{
      season: 1,
      title: "Season 1",
      sourceTitle: show.title,
      image: show.image,
      playable: true,
      episodes
    }];
    show.jimovEpisodesLoaded = true;
    state.shows = state.shows.map((entry) => entry.id === show.id ? show : entry);
    state.addonSections = state.addonSections.map((section) => ({
      ...section,
      items: (section.items || []).map((entry) => entry.id === show.id ? show : entry)
    }));
  } catch (error) {
    console.warn("JIMOV episodes could not load:", error);
    show.jimovError = error.message;
  }
  return show;
}

function isJimovShow(show) {
  return /jimov/i.test(String(show?.source || ""))
    || /jimov/i.test(String(show?.id || ""))
    || Boolean(show?.jimovUrl);
}

// Enrich a metadata-only show (scrapled-catalog, AniList/Jikan) by searching
// all available sources by title in parallel. Each successful hit patches the
// show's image/banner/description and unlocks the matching episode objects so
// they are playable without re-fetching.
async function enrichShowFromAllSources(show) {
  if (!show || show.enriched) return show;
  show.enriched = true;
  const title = normalizeTitle(show.title);
  if (!title) return show;

  // Search each addon section for a title match and copy metadata + episode URLs
  const addonMatches = state.addonSections.flatMap((section) =>
    (section.items || []).filter((item) => {
      const score = titleMatchScore(item, show);
      return score >= 80;
    })
  );
  addonMatches.forEach((match) => {
    if (!show.image && match.image) show.image = match.image;
    if (!show.banner && match.banner) show.banner = match.banner;
    if (show.description?.length < 60 && match.description?.length > show.description?.length) {
      show.description = match.description;
    }
    // Copy any direct video URL or externalUrl from matched episode 0
    const matchEp = match.episodes?.[0] || {};
    const existingEp = show.episodes?.[0];
    if (existingEp && !getEpisodeUrl(existingEp) && getEpisodeUrl(matchEp)) {
      existingEp.videoUrl = getEpisodeUrl(matchEp);
      existingEp.locked = false;
    }
    if (existingEp && !existingEp.externalUrl && matchEp.externalUrl) {
      existingEp.externalUrl = matchEp.externalUrl;
      existingEp.externalType = matchEp.externalType || "iframe";
      existingEp.locked = false;
    }
  });

  // Sync updated show back into state
  state.shows = state.shows.map((entry) => entry.id === show.id ? show : entry);
  return show;
}

function inferAnime1vProvider(url = "") {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host) return host;
  } catch (error) {
    return "";
  }
  return "";
}

async function hydrateAniPubEpisodes(show) {
  const aniPubId = show.aniPubId || String(show.id || "").replace(/^source-anipub-catalog-anipub-/, "").replace(/^anipub-/, "");
  if (!aniPubId || show.aniPubEpisodesLoaded) return show;
  try {
    let payload = getAniPubEpisodeCache(aniPubId);
    if (!payload) {
      const response = await fetchWithTimeout(`./api/anipub/episodes/${encodeURIComponent(aniPubId)}`, { cache: "no-store" }, 12000);
      if (!response.ok) throw new Error("AniPub episode endpoint unavailable");
      payload = await response.json();
      setAniPubEpisodeCache(aniPubId, payload);
    }
    if (!payload.ok || !Array.isArray(payload.episodes) || !payload.episodes.length) return show;
    const seasonNumber = extractSeasonNumber(payload.title || show.title, extractSeasonNumber(show.title, 1));
    const episodes = repairEpisodeGaps(payload.episodes.map((episode) => ({
      id: `${show.id}-${episode.number || episode.episode}`,
      title: episode.title || `Episode ${episode.number || episode.episode}`,
      season: seasonNumber,
      episode: episode.number || episode.episode,
      externalUrl: episode.externalUrl,
      externalType: episode.externalType || "iframe",
      sourceOptions: normalizeEpisodeSourceOptions({ ...episode, viaAniPub: true }),
      audioTracks: episode.audioTracks || ["japanese"],
      subtitles: episode.subtitles || ["spanish"],
      server: "AniPub",
      viaAniPub: true,
      locked: false
    })), seasonNumber);
    show.episode = episodes.length;
    show.episodes = episodes;
    show.seasons = [{
      season: seasonNumber,
      title: `Season ${seasonNumber}`,
      sourceTitle: show.title,
      image: show.image,
      playable: true,
      episodes
    }];
    show.integrity = validateEpisodeIntegrity(show);
    show.aniPubEpisodesLoaded = true;
    state.shows = state.shows.map((entry) => entry.id === show.id ? show : entry);
    state.addonSections = state.addonSections.map((section) => ({
      ...section,
      items: (section.items || []).map((entry) => entry.id === show.id ? show : entry)
    }));
  } catch (error) {
    console.warn("AniPub episodes could not load:", error);
  }
  return show;
}

function applyOpenTarget(show, target = {}) {
  const seasonNumber = Number(target.seasonNumber || extractSeasonNumber(show.title, 1));
  const episodeNumber = Number(target.episodeNumber || show.episode);
  const hasEpisodeTarget = Number.isFinite(episodeNumber) && episodeNumber > 0;
  const hasSeasonTarget = Number.isFinite(seasonNumber) && seasonNumber > 1;
  if (!hasEpisodeTarget && !hasSeasonTarget) return;

  const seasons = getDetailSeasons(show);
  const seasonIndex = Math.max(0, seasons.findIndex((season) => Number(season.season) === seasonNumber));
  const activeSeason = seasons[seasonIndex] || seasons[0];
  state.activeSeasonIndex = seasonIndex;
  state.activeDetailTab = "episodes";

  if (!hasEpisodeTarget || !activeSeason?.episodes?.length) return;
  const episodeIndex = activeSeason.episodes.findIndex((episode) => Number(episode.episode) === episodeNumber);
  const safeEpisodeIndex = episodeIndex >= 0
    ? episodeIndex
    : Math.min(Math.max(episodeNumber - 1, 0), activeSeason.episodes.length - 1);
  const episode = activeSeason.episodes[safeEpisodeIndex];
  if (!episode) return;
  state.activeEpisode = { season: activeSeason, episode, seasonIndex, episodeIndex: safeEpisodeIndex };
  state.activeEpisodeUrl = getEpisodeUrl(episode);
}

function closeShow() {
  stopActivePlayback();
  overlay.hidden = true;
  state.activeShow = null;
  state.activeEpisodeUrl = "";
  state.activeEpisode = null;
  state.activeDetailTab = "episodes";
  state.activeSeasonIndex = 0;
  if (episodeList) {
    episodeList.hidden = true;
    episodeList.innerHTML = "";
  }
  refreshFocusables();
  const firstCard = document.querySelector(".show-card:not([hidden])");
  if (firstCard) focusElement(firstCard);
  // Returning to Home — resume the hero cover→trailer cycle.
  if (state.route === "home") renderCarousel();
}

function stopActivePlayback() {
  const frame = document.querySelector("#videoFrame");
  if (!frame) return;
  frame.querySelectorAll("video").forEach((video) => {
    try {
      video.pause();
      video.removeAttribute("src");
      video.load();
    } catch (error) {
      console.warn("Video could not be stopped cleanly:", error);
    }
  });
  frame.querySelectorAll("iframe").forEach((iframe) => {
    iframe.src = "about:blank";
    iframe.removeAttribute("src");
  });
  frame.innerHTML = "";
}

function toggleFavorite() {
  if (!state.activeShow) return;
  const id = state.activeShow.id;
  state.favorites = state.favorites.includes(id)
    ? state.favorites.filter((favorite) => favorite !== id)
    : [...state.favorites, id];
  localStorage.setItem("anime-tv-favorites", JSON.stringify(state.favorites));
  setFavoriteButtonState(state.favorites.includes(id));
  render();
}

function resetVideoFrame() {
  stopActivePlayback();
  const show = state.activeShow;
  const background = show?.banner || show?.image || "";
  const poster = show?.image || show?.banner || "";
  const frame = document.querySelector("#videoFrame");
  frame.style.setProperty("--watch-bg", background ? `url("${background}")` : "none");

  // Count available episodes across all seasons for the hint text
  const seasons = show ? getDetailSeasons(show) : [];
  const totalEps = seasons.reduce((sum, s) => sum + (s.episodes?.length || 0), 0);
  const sourceCount = show ? getEpisodePlaybackSources(show.episodes?.[0] || {}).length : 0;

  const hintLine = totalEps
    ? `${totalEps} episode${totalEps === 1 ? "" : "s"} · select one below to watch`
    : "Select an episode below to load playback sources";

  const sourceLine = sourceCount
    ? `${sourceCount} source${sourceCount === 1 ? "" : "s"} ready`
    : show?.source
      ? `Source: ${escapeHtml(show.source)}`
      : "";

  frame.innerHTML = `
    <div class="watch-ready-state" id="watchArt">
      <div class="watch-ready-poster-wrap">
        ${
          poster
            ? `<img class="watch-poster" src="${escapeHtml(poster)}" alt="${escapeHtml(getShowTitle(show))}" loading="lazy">`
            : `<div class="watch-poster-placeholder"><div class="play-symbol" aria-hidden="true"></div></div>`
        }
      </div>
      <div class="watch-ready-cta">
        ${sourceLine ? `<span class="watch-ready-source">${sourceLine}</span>` : ""}
        <p class="watch-ready-hint">${hintLine}</p>
        <div class="watch-ready-arrow" aria-hidden="true">↓</div>
      </div>
    </div>
  `;
}

function currentEpisodeLabel() {
  const selected = state.activeEpisode;
  if (!selected) return getShowTitle(state.activeShow) || "Selected anime";
  return `${selected.season?.title || `Season ${selected.season?.season || selected.seasonIndex + 1}`} Episode ${selected.episode?.episode || selected.episodeIndex + 1}`;
}

function baseSeasonTitle(title) {
  return String(title || "")
    .replace(/\s*[-:]\s*(season|part|cour)\s*\d+\s*$/i, "")
    .replace(/\s+(season|part|cour)\s*\d+\s*$/i, "")
    .replace(/\s+\d+(st|nd|rd|th)\s*season\s*$/i, "")
    .replace(/\s+season\s+[ivxlcdm]+\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getSeasonDisplayTitle(show, season) {
  const seasonNumber = Number(season?.season || state.activeSeasonIndex + 1 || 1);
  const exactSeasonTitle = season?.sourceTitle && extractSeasonNumber(season.sourceTitle, seasonNumber) === seasonNumber
    ? season.sourceTitle
    : "";
  if (exactSeasonTitle && exactSeasonTitle !== show?.title) return exactSeasonTitle;
  // Respect romaji preference for the watch-overlay heading
  const titleSource = getShowTitle(show) || show?.title || exactSeasonTitle || "Selected anime";
  // If the title already encodes this season number don't append "Season N" again
  if (seasonNumber > 1 && extractSeasonNumber(titleSource, 0) === seasonNumber) return titleSource;
  const baseTitle = baseSeasonTitle(titleSource);
  return seasonNumber > 1 ? `${baseTitle} Season ${seasonNumber}` : baseTitle;
}

// Keep the heart icon intact while reflecting favorite state via class/aria
// (the button is now an icon button, so we must not overwrite its textContent).
function setFavoriteButtonState(isFav) {
  if (!favoriteButton) return;
  favoriteButton.classList.toggle("is-active", Boolean(isFav));
  favoriteButton.setAttribute("aria-pressed", isFav ? "true" : "false");
  const label = isFav ? t("favorited") : t("favorite");
  favoriteButton.setAttribute("aria-label", label);
  favoriteButton.dataset.tip = label;
}

function detailFormatLabel(format) {
  if (!format) return "";
  const map = {
    TV: "TV", TV_SHORT: "TV Short", MOVIE: "Movie", SPECIAL: "Special",
    OVA: "OVA", ONA: "ONA", MUSIC: "Music"
  };
  const key = String(format).toUpperCase();
  return map[key] || String(format).replace(/_/g, " ");
}

function detailStatusLabel(status) {
  if (!status) return "";
  const map = {
    RELEASING: "Airing", FINISHED: "Finished", NOT_YET_RELEASED: "Upcoming",
    CANCELLED: "Cancelled", HIATUS: "Hiatus", CURRENTLY_AIRING: "Airing",
    FINISHED_AIRING: "Finished"
  };
  const key = String(status).toUpperCase();
  return map[key] || String(status).replace(/_/g, " ");
}

function trailerWatchUrl(tr) {
  if (!tr || !tr.id) return "";
  const site = String(tr.site || "youtube").toLowerCase();
  if (site === "dailymotion") return `https://www.dailymotion.com/video/${tr.id}`;
  return `https://www.youtube.com/watch?v=${tr.id}`;
}

// Reveal the Trailer action only when AniList actually has one for this show.
function updateTrailerButton(show) {
  if (!trailerButton || !show) return;
  const cached = show.anilistId ? _readTrailerCache(show.anilistId) : null;
  if (cached && cached.id) {
    trailerButton.hidden = false;
    trailerButton.dataset.trailerUrl = trailerWatchUrl(cached);
    return;
  }
  trailerButton.hidden = true;
  trailerButton.dataset.trailerUrl = "";
  // Look the trailer up at most ONCE per show. We must not recurse into
  // updateTrailerButton from the .then(): fetchAniListTrailers() returns early
  // (without writing the cache) whenever another fetch is already in flight, so
  // re-checking an undefined cache would spin an unbounded microtask loop that
  // starves the main thread and crashes the (TV) WebView.
  if (show.anilistId && cached === undefined && !show._trailerTried && typeof fetchAniListTrailers === "function") {
    show._trailerTried = true;
    Promise.resolve(fetchAniListTrailers([show.anilistId])).then(() => {
      if (state.activeShow?.id !== show.id) return;
      const tr = _readTrailerCache(show.anilistId);
      if (tr && tr.id) {
        trailerButton.hidden = false;
        trailerButton.dataset.trailerUrl = trailerWatchUrl(tr);
      }
    }).catch(() => {});
  }
}

// Fill the cinematic left column: meta row, genre pills, cast (when available).
function renderDetailMeta(show) {
  if (!show) return;
  const metaRow = document.querySelector("#watchMetaRow");
  if (metaRow) {
    const chips = [];
    const fmt = detailFormatLabel(show.format);
    const year = show.year ? String(show.year) : "";
    const dur = Number(show.duration) ? `${show.duration} min` : "";
    const status = detailStatusLabel(show.status);
    [fmt, year, dur, status].filter(Boolean).forEach((txt) => {
      chips.push(`<span class="watch-meta-chip">${escapeHtml(txt)}</span>`);
    });
    if (show.score) chips.push(`<span class="watch-meta-chip watch-meta-score">★ ${escapeHtml(String(show.score))}%</span>`);
    metaRow.innerHTML = chips.join("");
    metaRow.hidden = chips.length === 0;
  }

  const genresWrap = document.querySelector("#watchGenres");
  if (genresWrap) {
    const genres = (show.genres && show.genres.length ? show.genres : (show.genre ? [show.genre] : []))
      .map((g) => (typeof g === "string" ? g : g?.name))
      .filter(Boolean)
      .filter((g, i, arr) => arr.indexOf(g) === i)
      .slice(0, 4);
    genresWrap.innerHTML = genres.map((g) => `<span class="watch-pill">${escapeHtml(String(g))}</span>`).join("");
    genresWrap.hidden = genres.length === 0;
  }

  // Cast — hidden gracefully when no data source provides it.
  const castWrap = document.querySelector("#watchCast");
  if (castWrap) {
    const cast = (show.cast || show.actors || show.characters || [])
      .map((c) => (typeof c === "string" ? c : c?.name))
      .filter(Boolean)
      .slice(0, 3);
    castWrap.innerHTML = cast.map((c) => `<span class="watch-pill watch-pill-cast">${escapeHtml(String(c))}</span>`).join("");
    castWrap.hidden = cast.length === 0;
  }

  updateTrailerButton(show);
}

function syncWatchHeading(show = state.activeShow, season = null) {
  if (!show) return;
  const seasons = getDetailSeasons(show);
  const activeSeason = season || seasons[state.activeSeasonIndex] || seasons[0];
  const title = getSeasonDisplayTitle(show, activeSeason);
  const titleNode = document.querySelector("#watchTitle");
  const metaNode = document.querySelector("#watchMeta");
  if (titleNode) titleNode.textContent = title;
  if (metaNode) {
    metaNode.textContent = compactMetadataLine(show);
  }
  renderDetailMeta(show);
  // Cinematic backdrop: prefer a wide banner, fall back to the poster.
  const backdrop = document.querySelector("#watchBackdrop");
  if (backdrop) {
    const art = getCarouselArtwork(show) || hqImage(show.banner || show.backdrop || show.image || "");
    backdrop.style.backgroundImage = art ? `url("${art}")` : "";
    backdrop.classList.toggle("has-art", Boolean(art));
    // Always cinematic; .has-art only switches image-backdrop vs gradient fallback.
    overlay?.classList.add("cinematic");
    overlay?.classList.toggle("has-backdrop-art", Boolean(art));
  }
}

function compactMetadataLine(show = {}) {
  return [
    show.genre ? String(show.genre).toUpperCase() : "",
    show.status ? String(show.status).replace(/_/g, " ") : "",
    show.score ? `${show.score}%` : "",
    show.source || ""
  ].filter(Boolean).join(" | ");
}

// Episode title without the redundant "Episode N" when that's all there is.
function episodeEntryTitle(episode = {}, index = 0) {
  const raw = String(episode.title || "").trim();
  const num = episode.episode || index + 1;
  if (raw && !/^(episode|ep|cap[ií]tulo)\s*\d+$/i.test(raw)) return raw;
  return `Episode ${num}`;
}

// Human air date ("May 25, 2026") from whatever date field the source provides.
function episodeAirDateLabel(episode = {}) {
  const dv = episode.airingAt || episode.releaseDate || episode.availableAt ||
             episode.airDate || episode.date || episode.aired || episode.released;
  if (!dv) return "";
  let ms;
  if (typeof dv === "number" || /^\d+$/.test(String(dv))) {
    const n = Number(dv);
    ms = n < 100000000000 ? n * 1000 : n; // seconds → ms
  } else {
    ms = Date.parse(dv);
  }
  if (!ms || Number.isNaN(ms)) return "";
  return new Date(ms).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

function episodeThumb(episode = {}, season = {}, show = {}) {
  return hqImage(episode.image || episode.thumbnail || episode.still || episode.snapshot ||
         season.image || show.image || show.banner || "");
}

// Linear list of seasons for the dropdown + Prev/Next, spanning the franchise
// (so split seasons like Iruma Temporada 1–4 appear together). Each entry knows
// how to navigate: a related show opens it; an own season just switches index.
function buildSeasonNav(show, seasons) {
  const franchise = getFranchiseSeasonList(show) || [];
  const list = (franchise.length ? franchise : seasons).map((entry, i) => {
    const related = entry.relatedShowId && !entry.isCurrentShow ? String(entry.relatedShowId) : "";
    let localIndex = -1;
    if (!related) {
      localIndex = seasons.indexOf(entry);
      if (localIndex < 0) localIndex = seasons.findIndex((s) => Number(s.season) === Number(entry.season));
      if (localIndex < 0 && !franchise.length) localIndex = i;
    }
    // Dropdown reads cleanest as "Season N" (the full title lives on the left);
    // movies/OVAs keep their own name.
    const label = entry.formatBadge
      ? (entry.title || entry.formatBadge)
      : `Season ${entry.season || i + 1}`;
    return {
      label,
      epCount: entry.episodes?.length || 0,
      badge: entry.formatBadge || "",
      relatedShowId: related,
      localIndex
    };
  });
  return list.length ? list : seasons.map((s, i) => ({
    label: s.title || `Season ${s.season || i + 1}`, epCount: s.episodes.length, badge: "", relatedShowId: "", localIndex: i
  }));
}

function renderEpisodeList(show) {
  if (!episodeList) return;
  const seasons = getDetailSeasons(show);
  if (state.activeSeasonIndex >= seasons.length) state.activeSeasonIndex = 0;
  const activeSeason = seasons[state.activeSeasonIndex] || seasons[0];
  const seasonTitle = getSeasonDisplayTitle(show, activeSeason);
  syncWatchHeading(show, activeSeason);

  const seasonNav = buildSeasonNav(show, seasons);
  let activeNavIndex = seasonNav.findIndex((s) => s.localIndex === state.activeSeasonIndex);
  if (activeNavIndex < 0) activeNavIndex = 0;
  const activeNav = seasonNav[activeNavIndex] || { label: activeSeason?.title || "Season 1" };
  const multiSeason = seasonNav.length > 1;

  const episodes = activeSeason?.episodes || [];
  const tab = state.activeDetailTab === "seasons" ? "seasons" : "episodes";
  const franchiseList = getFranchiseSeasonList(show) || [];
  const cardSeasons = franchiseList.length ? franchiseList : seasons;

  episodeList.hidden = false;
  episodeList.innerHTML = `
    <div class="detail-tabs detail-tabs-2" role="tablist" aria-label="Anime details">
      <button class="detail-tab focusable ${tab === "seasons" ? "is-selected" : ""}" data-detail-tab="seasons" role="tab" aria-selected="${tab === "seasons"}">Seasons</button>
      <button class="detail-tab focusable ${tab === "episodes" ? "is-selected" : ""}" data-detail-tab="episodes" role="tab" aria-selected="${tab === "episodes"}">Episodes</button>
    </div>

    <section class="detail-pane ${tab === "episodes" ? "is-active" : ""}" data-detail-pane="episodes">
      <div class="ep-panel-head">
        <button class="ep-nav-btn focusable" data-season-step="-1" ${activeNavIndex <= 0 ? "disabled" : ""} aria-label="Previous season">
          <span aria-hidden="true">‹</span><span class="ep-nav-label">Prev</span>
        </button>
        <div class="ep-season-select">
          <button class="ep-season-btn focusable" data-season-toggle type="button" aria-haspopup="listbox" aria-expanded="false">
            <span class="ep-season-name">${escapeHtml(activeNav.label)}</span>
            <span class="ep-season-caret" aria-hidden="true">▾</span>
          </button>
          ${multiSeason ? `
          <div class="ep-season-menu" role="listbox" hidden>
            ${seasonNav.map((s, i) => `
              <button class="ep-season-option focusable ${i === activeNavIndex ? "is-selected" : ""}" role="option" data-season-nav="${i}" type="button">
                <span>${escapeHtml(s.label)}</span>
                <small>${s.badge ? escapeHtml(s.badge) : `${s.epCount} eps`}</small>
              </button>
            `).join("")}
          </div>` : ""}
        </div>
        <button class="ep-nav-btn focusable" data-season-step="1" ${activeNavIndex >= seasonNav.length - 1 ? "disabled" : ""} aria-label="Next season">
          <span class="ep-nav-label">Next</span><span aria-hidden="true">›</span>
        </button>
      </div>

      ${(() => {
        const sNum = activeSeason?.season || state.activeSeasonIndex + 1;
        const stats = getSeasonStats(show, activeSeason, sNum);
        if (!stats.total || !stats.watched) return "";
        return `
        <div class="ep-stats" aria-label="Season progress">
          <span class="ep-stats-text"><b>${stats.watched}</b>/${stats.total} watched · ${stats.remaining} left</span>
          <span class="ep-stats-pct">${stats.percent}%</span>
          <span class="ep-stats-bar"><span style="width:${stats.percent}%"></span></span>
        </div>`;
      })()}

      <div class="ep-rows" id="epRows">
        ${episodes.length ? episodes.map((episode, episodeIndex) => {
          const num = episode.episode || episodeIndex + 1;
          const title = episodeEntryTitle(episode, episodeIndex);
          const thumb = episodeThumb(episode, activeSeason, show);
          const date = episodeAirDateLabel(episode);
          const locked = isEpisodeUnavailable(episode);
          const selected = isActiveEpisode(state.activeSeasonIndex, episodeIndex);
          const metaLine = date || episodeDisplaySubtitle(episode);
          const search = `${num} ${title}`.toLowerCase();
          // Local watch state → WATCHED / CONTINUE badge + progress bar.
          const sNum = activeSeason?.season || state.activeSeasonIndex + 1;
          const watch = getEpisodeWatchState(show, sNum, num);
          const pct = watch ? watch.progress : 0;
          const watchCls = watch?.watched ? "is-watched" : (pct > 0 ? "is-inprogress" : "");
          const badge = watch?.watched
            ? `<span class="ep-badge ep-badge-watched">WATCHED</span>`
            : (pct > 0 ? `<span class="ep-badge ep-badge-continue">CONTINUE</span>` : "");
          const progressBar = (pct > 0 || watch?.watched)
            ? `<span class="ep-progress"><span style="width:${watch?.watched ? 100 : pct}%"></span></span>`
            : "";
          return `
          <button class="ep-row focusable ${locked ? "is-locked" : ""} ${selected ? "is-selected" : ""} ${watchCls}"
                  data-season-index="${state.activeSeasonIndex}" data-episode-index="${episodeIndex}"
                  data-ep-search="${escapeHtml(search)}">
            <span class="ep-thumb">
              ${thumb ? `<img class="ep-thumb-img" src="${escapeHtml(thumb)}" alt="" loading="lazy" onerror="this.style.display='none'">` : ""}
              <span class="ep-thumb-num">${escapeHtml(String(num))}</span>
              <span class="ep-thumb-play" aria-hidden="true">▶</span>
              ${progressBar}
            </span>
            <span class="ep-row-body">
              <strong class="ep-row-title">${escapeHtml(String(num))}. ${escapeHtml(title)}</strong>
              <small class="ep-row-meta">${escapeHtml(metaLine)}</small>
            </span>
            ${badge}
          </button>`;
        }).join("") : `
          <p class="ep-empty">${activeSeason?.playable === false
            ? "Episodes are listed from metadata. Playback servers load when a matching source is available."
            : "No episodes found for this season yet."}</p>`}
      </div>
    </section>

    <section class="detail-pane ${tab === "seasons" ? "is-active" : ""}" data-detail-pane="seasons">
      <div class="season-card-grid">
        ${cardSeasons.map((season, i) => {
          const nav = seasonNav[i] || {};
          const epc = season.episodes?.length || 0;
          const badge = season.formatBadge ? `<span class="season-format-badge">${escapeHtml(season.formatBadge)}</span>` : "";
          const yr = season.year ? `<span class="season-year">${season.year}</span>` : "";
          const epLabel = epc ? `${epc} episode${epc === 1 ? "" : "s"}` : "";
          const selected = nav.localIndex === state.activeSeasonIndex && !nav.relatedShowId;
          return `
          <button class="season-card focusable ${selected ? "is-selected" : ""}" data-season-card="${i}">
            ${season.image ? `<img src="${escapeHtml(season.image)}" alt="" loading="lazy">` : ""}
            <strong>${escapeHtml(nav.label || season.title || `Season ${i + 1}`)}</strong>
            <small>${escapeHtml(season.sourceTitle || getSeasonDisplayTitle(show, season))}</small>
            <span>${epLabel}${badge}${yr}</span>
          </button>`;
        }).join("")}
      </div>
    </section>
  `;

  // ── Detail tabs (Seasons / Episodes) ────────────────────────────────────
  episodeList.querySelectorAll("[data-detail-tab]").forEach((tabBtn) => {
    tabBtn.addEventListener("click", () => {
      state.activeDetailTab = tabBtn.dataset.detailTab;
      renderEpisodeList(show);
      refreshFocusables();
    });
  });

  // ── Season dropdown toggle ──────────────────────────────────────────────
  const seasonBtn = episodeList.querySelector("[data-season-toggle]");
  const seasonMenu = episodeList.querySelector(".ep-season-menu");
  const closeSeasonMenu = () => {
    if (!seasonMenu) return;
    seasonMenu.hidden = true;
    seasonBtn?.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", _onSeasonDocClick, true);
  };
  function _onSeasonDocClick(event) {
    // Close when clicking anywhere outside the season selector.
    if (!event.target.closest(".ep-season-select")) closeSeasonMenu();
  }
  if (seasonBtn && seasonMenu) {
    seasonBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      const willOpen = seasonMenu.hidden;
      seasonMenu.hidden = !willOpen;
      seasonBtn.setAttribute("aria-expanded", willOpen ? "true" : "false");
      if (willOpen) {
        document.addEventListener("pointerdown", _onSeasonDocClick, true);
        episodeList.querySelector(".ep-season-option")?.focus?.();
      } else {
        document.removeEventListener("pointerdown", _onSeasonDocClick, true);
      }
      refreshFocusables();
    });
  }

  const navTo = (navIndex) => {
    const target = seasonNav[navIndex];
    if (!target) return;
    closeSeasonMenu();   // always dismiss the dropdown on a selection
    if (target.relatedShowId) { openShow(target.relatedShowId); return; }
    state.activeSeasonIndex = Math.max(0, target.localIndex);
    state.activeEpisode = null;
    state.activeEpisodeUrl = "";
    renderEpisodeList(show);
    resetVideoFrame();
    refreshFocusables();
  };

  episodeList.querySelectorAll("[data-season-nav]").forEach((option) => {
    option.addEventListener("click", () => navTo(Number(option.dataset.seasonNav)));
  });
  episodeList.querySelectorAll("[data-season-step]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.hasAttribute("disabled")) return;
      navTo(activeNavIndex + Number(button.dataset.seasonStep));
    });
  });

  // ── Season cards (Seasons tab) → switch season and jump to Episodes ──────
  episodeList.querySelectorAll("[data-season-card]").forEach((card) => {
    card.addEventListener("click", () => {
      state.activeDetailTab = "episodes";
      navTo(Number(card.dataset.seasonCard));
    });
  });

  // ── Episode selection ────────────────────────────────────────────────────
  episodeList.querySelectorAll("[data-season-index][data-episode-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const season = seasons[Number(button.dataset.seasonIndex)];
      const episode = season?.episodes?.[Number(button.dataset.episodeIndex)];
      if (!season || !episode) return;
      selectEpisodeByPosition(Number(button.dataset.seasonIndex), Number(button.dataset.episodeIndex), true);
    });
  });
}

function episodeDisplaySubtitle(episode = {}) {
  if (episode.sourceOptionsPending) return "Checking servers...";
  if (isEpisodeUnavailable(episode)) return episodeAvailabilityText(episode);
  // Aired but not yet resolved (servers load on click) — invite a tap instead of
  // implying the episode is missing/locked.
  if (!getEpisodePlaybackSources(episode).length && !getEpisodeUrl(episode)) return "▶ Play";
  return episode.server || episode.title || "Episode";
}

function isEpisodeUnavailable(episode = {}) {
  return Boolean(episode.missing || episode.unavailable || episode.future || episode.notAired || episode.airingAt || episode.releaseDate || episode.availableAt);
}

function episodeAvailabilityText(episode = {}) {
  const dateValue = episode.airingAt || episode.releaseDate || episode.availableAt || episode.airDate || episode.date;
  const date = Number(dateValue) > 1000000000
    ? new Date(Number(dateValue) * (Number(dateValue) < 100000000000 ? 1000 : 1))
    : dateValue ? new Date(dateValue) : null;
  if (date && !Number.isNaN(date.getTime())) {
    return `Not available yet - ${date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} at ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }
  return "Not available yet";
}

// Provider group for source ordering: scraper sources (TioAnime/AnimeAV1) on top,
// then AniPub, then anything else.
function _sourceGroupPriority(source = {}) {
  const id = (source.id || "").toLowerCase();
  const label = (source.label || "").toLowerCase();
  if (id.includes("tioanime") || id.includes("animeav1") ||
      label.includes("tioanime") || label.includes("animeav1")) return 0;
  if (KNOWN_SOURCE_SERVERS.find(d => d.key === "anipub")?.match(source)) return 1;
  return 2;
}

// Fine-grained "best server" preference. Lower = shown / auto-selected first.
// AnimeAV1 is the most reliable provider — its HLS stream is the #1 pick.
function sourcePreferenceScore(source = {}) {
  const id    = (source.id || "").toLowerCase();
  const label = (source.label || "").toLowerCase();
  const url   = (source.videoUrl || source.externalUrl || "").toLowerCase();
  const isDirect = source.type === "direct";
  const isHls    = /\.m3u8(\?|#|$)/i.test(url) || /\bhls\b/.test(label);
  const isAnimeAv1 = id.includes("animeav1") || label.includes("animeav1");
  const isMega = /\bmega\b/.test(label) || /mega\.nz/.test(url);
  const isMp4  = /mp4\s*upload|mp4upload/.test(label) || /mp4upload/.test(url);
  const isAdFree = /yourupload|you\s*upload|youupload|ok\.?ru|okru|streamwish|filelions/.test(label);
  const isAdWalled = /\bvoe\b|netu|hqq|streamsb|embedsb|\bsb\b|dood|filemoon|vidhide|mixdrop/.test(label);

  // ── AnimeAV1 first (most reliable) — HLS is the very top pick ────────────
  if (isAnimeAv1 && isHls)              return 0; // AnimeAV1 — HLS  (best)
  if (isAnimeAv1 && isDirect)           return 1; // AnimeAV1 — other direct
  if (isAnimeAv1 && (isMega || isMp4))  return 2; // AnimeAV1 — Mega / MP4Upload
  if (isAnimeAv1 && !isAdWalled)        return 3; // AnimeAV1 — other ad-free embed
  // ── Then the other dependable, ad-free servers ─────────────────────────
  if (isHls || isDirect)               return 4; // any other direct / HLS stream
  if (isMega || isMp4)                 return 5; // Mega / MP4Upload (TioAnime etc.)
  if (isAdFree)                        return 6; // YourUpload / Ok.ru / …
  // ── Ad-walled hosts sink to the bottom ─────────────────────────────────
  if (isAdWalled)                      return 9;
  return 7;                                       // neutral / unknown
}

// Order sources so the auto-selected one (index 0) is the best playable pick:
//   1. preference tier   → AnimeAV1-HLS / Mega / MP4Upload float to the very top
//   2. scraper group     → TioAnime/AnimeAV1 before AniPub before others
//   3. ad-free rank      → ad-walled hosts sink (no "Sandbox not allowed" wall)
//   4. stable arrival    → first server that resolved wins on a tie
function orderSourceOptions(sources = []) {
  return sources
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const pa = sourcePreferenceScore(a.s), pb = sourcePreferenceScore(b.s);
      if (pa !== pb) return pa - pb;
      const ga = _sourceGroupPriority(a.s), gb = _sourceGroupPriority(b.s);
      if (ga !== gb) return ga - gb;
      const ra = Number.isFinite(a.s.sourceRank) ? a.s.sourceRank : 1;
      const rb = Number.isFinite(b.s.sourceRank) ? b.s.sourceRank : 1;
      if (ra !== rb) return ra - rb;
      return a.i - b.i;
    })
    .map(o => o.s);
}

function getEpisodePlaybackSources(episode = {}) {
  return orderSourceOptions(normalizeEpisodeSourceOptions(episode));
}

function getSelectedEpisodeSource(episode = {}) {
  const sources = getEpisodePlaybackSources(episode);
  if (!sources.length) return null;
  const explicit = episode.selectedSourceId || state.preferredSource;
  return explicit && explicit !== "auto"
    ? sources.find((source) => source.id === explicit) || sources[0]
    : sources[0];
}

function renderPlayerSourceOptions(episode = {}, selectedSource = null) {
  const sources = getEpisodePlaybackSources(episode);
  if (!sources.length) return "";
  return `
    <div class="player-server-options" aria-label="Playback servers">
      <div class="player-source-heading">
        <strong>Watch options</strong>
        <span>${sources.length} source${sources.length === 1 ? "" : "s"} found</span>
      </div>
      ${sources.map((source, index) => `
        <button class="player-server-option focusable ${selectedSource?.id === source.id ? "is-selected" : ""}" data-player-source="${escapeHtml(source.id)}" type="button">
          <span>Option ${index + 1}</span>
          <strong>${escapeHtml(source.label || source.id || "Server")}</strong>
          <small>${source.type === "direct" ? "Direct video" : source.type === "resolver" ? "Resolver" : "Embedded player"}</small>
        </button>
      `).join("")}
    </div>
  `;
}

function getEpisodeNavigationTargets() {
  const selected = state.activeEpisode;
  const seasons = getDetailSeasons(state.activeShow || {});
  if (!selected || !seasons.length) return { previous: null, next: null, total: 0 };
  const seasonIndex = Number(selected.seasonIndex || 0);
  const episodeIndex = Number(selected.episodeIndex || 0);
  const season = seasons[seasonIndex];
  const episodes = season?.episodes || [];
  return {
    previous: episodeIndex > 0 ? { seasonIndex, episodeIndex: episodeIndex - 1 } : null,
    next: episodeIndex < episodes.length - 1 ? { seasonIndex, episodeIndex: episodeIndex + 1 } : null,
    total: episodes.length
  };
}

function renderPlayerEpisodeActions(url = "") {
  const nav = getEpisodeNavigationTargets();
  const downloadUrl = getActiveDownloadUrl(url);
  const canDownload = downloadUrl && !isEmbedUrl(downloadUrl) && /^https?:/i.test(String(downloadUrl));
  const epLabel = state.activeEpisode
    ? `S${state.activeEpisode.seasonIndex + 1} E${state.activeEpisode.episode?.episode || state.activeEpisode.episodeIndex + 1}`
    : "Episodes";
  return `
    <div class="player-episode-actions" aria-label="Episode controls">
      <button class="player-nav-action focusable" type="button" data-player-prev ${nav.previous ? "" : "disabled"}>
        <span aria-hidden="true">⏮</span>
        Prev
      </button>
      <button class="player-nav-action focusable is-list" type="button" data-player-list>
        <span aria-hidden="true">☰</span>
        ${escapeHtml(epLabel)}
        ${nav.total ? `<small>${nav.total}</small>` : ""}
      </button>
      <button class="player-nav-action focusable" type="button" data-player-next ${nav.next ? "" : "disabled"}>
        Next
        <span aria-hidden="true">⏭</span>
      </button>
      ${canDownload
        ? `<a class="player-download-action focusable" href="${escapeHtml(downloadUrl)}" download>↓ Save</a>`
        : ""}
    </div>
  `;
}

function formatPlayerTime(value = 0) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${minutes}:${String(rest).padStart(2, "0")}`;
}

function renderVidstreamTopbar(label = "") {
  const nav = getEpisodeNavigationTargets();
  return `
    <div class="vid-topbar">
      <button class="vid-icon-button vid-topbar-nav focusable" type="button"
        data-player-prev ${nav.previous ? "" : "disabled"}
        aria-label="Previous episode" title="Previous episode">⏮</button>
      <strong>${escapeHtml(label || currentEpisodeLabel())}</strong>
      <button class="vid-icon-button vid-topbar-nav focusable" type="button"
        data-player-next ${nav.next ? "" : "disabled"}
        aria-label="Next episode" title="Next episode">⏭</button>
      <button class="vid-icon-button vid-exit-button focusable" type="button"
        data-player-exit aria-label="Close player">✕</button>
    </div>
  `;
}

function renderPlayerPopupMessage(frame, title = "Loading episode", message = "Preparing the player.", stateClass = "is-loading") {
  if (!frame) return;
  frame.innerHTML = `
    <div class="video-player-shell vidstream-player is-popup-message">
      <div class="vid-player-stage">
        <div class="episode-video-empty ${escapeHtml(stateClass)}">
          <div class="play-symbol" aria-hidden="true"></div>
          <strong>${escapeHtml(title)}</strong>
          <p>${escapeHtml(message)}</p>
        </div>
        ${renderVidstreamTopbar(currentEpisodeLabel())}
      </div>
      ${renderPlayerEpisodeActions("")}
    </div>
  `;
  const shell = frame.querySelector(".vidstream-player");
  setPlayerCinema(shell, true, { silent: true });
  frame.querySelector("[data-player-exit]")?.addEventListener("click", exitPlayerToSources);
  frame.querySelector("[data-player-back]")?.addEventListener("click", () => showEpisodeListTab());
  wirePlayerChrome(frame);
  refreshFocusables();
}

function renderVidstreamControls() {
  const nav = getEpisodeNavigationTargets();
  const fit = state.uiPreferences.playerFit || "contain";
  return `
    <div class="vid-controls" aria-label="Video controls">
      <input class="vid-seek focusable" id="playerSeek" type="range" min="0" max="1000" value="0" aria-label="Seek">
      <div class="vid-control-row">
        <button class="vid-icon-button focusable" type="button" data-player-prev ${nav.previous ? "" : "disabled"} aria-label="Previous episode" title="Previous episode">⏮</button>
        <button class="vid-icon-button focusable" type="button" data-player-toggle aria-label="Play or pause">▶</button>
        <button class="vid-icon-button focusable" type="button" data-player-next ${nav.next ? "" : "disabled"} aria-label="Next episode" title="Next episode">⏭</button>
        <button class="vid-icon-button focusable" type="button" data-player-volume aria-label="Mute or unmute">▸</button>
        <span class="vid-time" id="playerTime">0:00 / 0:00</span>
        <span class="vid-spacer"></span>
        <button class="vid-tool-button focusable" type="button" data-player-fit aria-label="Video fit mode">${fit === "cover" ? "□" : fit === "fill" ? "▣" : "▭"}</button>
        <button class="vid-tool-button focusable" type="button" data-player-panel="speed" aria-label="Playback speed">◴</button>
        <button class="vid-tool-button focusable" type="button" data-player-panel="subtitles" aria-label="Subtitles">▤</button>
        <button class="vid-tool-button focusable" type="button" data-player-cast aria-label="Cast">▱</button>
        <button class="vid-tool-button focusable" type="button" data-player-fullscreen aria-label="Fullscreen (F)">⛶</button>
        <button class="vid-tool-button focusable" type="button" data-player-panel="more" aria-label="More options">⋮</button>
      </div>
      <div class="vid-panel" id="playerPanel" hidden></div>
    </div>
  `;
}

function setPlayerCinema(container, enabled, options = {}) {
  if (!container) return;
  container.classList.toggle("is-cinema", enabled);
  document.body.classList.toggle("player-cinema-open", enabled);
  if (!options.silent) showToast(enabled ? "Cinema mode" : "Normal player");
}

function toggleNativeFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else {
    // Always use documentElement — avoids traversing compositing layers from
    // nested elements and eliminates the lag caused by ancestor CSS animations
    document.documentElement.requestFullscreen({ navigationUI: "hide" }).catch(() =>
      showToast("Fullscreen blocked by this browser.")
    );
  }
}

// Called when the ✕ button is clicked — exits cinema mode and shows the
// source picker so the user can choose a different server without any
// broken player content in the way.
function renderSourcePickerIn(frame) {
  const episode = state.activeEpisode?.episode || {};
  const allSources = getEpisodePlaybackSources(episode);
  const serverChecks = episode.serverChecks || {};
  const isPending = Boolean(episode.sourceOptionsPending);
  const show = state.activeShow;
  const poster = show?.image || show?.banner || "";
  const epLabel = state.activeEpisode
    ? `S${state.activeEpisode.season?.season || state.activeEpisode.seasonIndex + 1} E${(episode.episode || episode.number || 1)} · ${escapeHtml(episode.title || `Episode ${episode.episode || 1}`)}`
    : "";

  // Track which source IDs are covered by known server definitions
  const claimedIds = new Set();

  // Order server slots dynamically: ready servers first (earliest-ready on top),
  // then still-checking, then unavailable. Ties keep the KNOWN order (scrapers
  // before AniPub). This makes whichever of TioAnime/AnimeAV1 resolves first
  // appear at the very top.
  const readyAt = episode.serverReadyAt || {};
  const orderedServers = KNOWN_SOURCE_SERVERS
    .map((def, knownIndex) => {
      const matching = allSources.filter(def.match);
      const hasSources = matching.length > 0;
      const status = serverChecks[def.key];
      const stateRank = hasSources ? 0 : (isPending && status === undefined ? 1 : 2);
      // Best (lowest) preference score among this server's sources — lets a server
      // holding an AnimeAV1-HLS / Mega / MP4Upload (tier 0) float to the top card.
      const bestPref = hasSources
        ? Math.min(...matching.map(sourcePreferenceScore))
        : 99;
      return { def, knownIndex, stateRank, bestPref, ready: readyAt[def.key] || Infinity };
    })
    .sort((a, b) =>
      a.stateRank - b.stateRank ||
      a.bestPref - b.bestPref ||
      a.ready - b.ready ||
      a.knownIndex - b.knownIndex
    )
    .map(o => o.def);

  // Build a card for each known server (in readiness order)
  const serverCards = orderedServers.map((def) => {
    const matchingSources = allSources.filter(def.match);
    matchingSources.forEach((s) => claimedIds.add(s.id));

    const status = serverChecks[def.key]; // "found" | "notfound" | undefined

    if (matchingSources.length > 0) {
      // ── Found: one clickable button per matching source option ──────────
      return matchingSources.map((source) => `
        <button class="source-picker-option source-picker-option-found focusable" data-player-source="${escapeHtml(source.id)}" type="button">
          <span class="source-picker-slot-icon source-picker-slot-play-icon" aria-hidden="true">▶</span>
          <span class="source-picker-slot-body">
            <strong>${escapeHtml(source.label || def.label)}</strong>
            <small>${source.type === "direct" ? "Direct video" : source.type === "resolver" ? "Resolver" : "Embedded player"}</small>
          </span>
          <span class="source-picker-slot-play-badge">Play</span>
        </button>
      `).join("");
    }

    if (isPending && status === undefined) {
      // ── Still checking ────────────────────────────────────────────────
      return `
        <div class="source-picker-option source-picker-option-checking">
          <span class="source-picker-slot-icon source-picker-slot-checking-icon" aria-hidden="true">
            <span class="source-picker-spinner"></span>
          </span>
          <span class="source-picker-slot-body">
            <strong>${escapeHtml(def.label)}</strong>
            <small>${escapeHtml(def.desc)} · Checking…</small>
          </span>
        </div>
      `;
    }

    // ── Not available ─────────────────────────────────────────────────
    return `
      <div class="source-picker-option source-picker-option-unavail">
        <span class="source-picker-slot-icon source-picker-slot-off-icon" aria-hidden="true">—</span>
        <span class="source-picker-slot-body">
          <strong>${escapeHtml(def.label)}</strong>
          <small>${escapeHtml(def.desc)} · Not available</small>
        </span>
      </div>
    `;
  }).join("");

  // Extra sources from addons that don't belong to a known server
  const extraCards = allSources
    .filter((s) => !claimedIds.has(s.id))
    .map((source) => `
      <button class="source-picker-option source-picker-option-found focusable" data-player-source="${escapeHtml(source.id)}" type="button">
        <span class="source-picker-slot-icon source-picker-slot-play-icon" aria-hidden="true">▶</span>
        <span class="source-picker-slot-body">
          <strong>${escapeHtml(source.label || source.id || "Server")}</strong>
          <small>${source.type === "direct" ? "Direct video" : source.type === "resolver" ? "Resolver" : "Embedded player"}</small>
        </span>
        <span class="source-picker-slot-play-badge">Play</span>
      </button>
    `).join("");

  const foundCount = allSources.length;

  frame.innerHTML = `
    <div class="source-picker-shell vidstream-player is-source-picker">
      <div class="vid-player-stage">
        <div class="source-picker">
          <div class="source-picker-hero">
            ${poster
              ? `<img class="source-picker-art" src="${escapeHtml(poster)}" alt="${escapeHtml(getShowTitle(show))}" loading="lazy">`
              : `<div class="source-picker-art source-picker-art-placeholder"></div>`
            }
            <div class="source-picker-hero-text">
              <strong class="source-picker-show-title">${escapeHtml(getShowTitle(show))}</strong>
              ${epLabel ? `<span class="source-picker-ep-label">${epLabel}</span>` : ""}
            </div>
          </div>

          <div class="source-picker-heading">
            <strong>${foundCount > 0 ? `${foundCount} server${foundCount === 1 ? "" : "s"} found` : isPending ? "Scanning servers…" : "No servers found"}</strong>
            <span>${foundCount > 0 ? "Choose a server to play" : isPending ? "Checking all providers, please wait…" : "Try another episode or add a source in Settings"}</span>
          </div>

          <div class="source-picker-options">
            ${serverCards}
            ${extraCards}
          </div>
        </div>
        ${renderVidstreamTopbar(currentEpisodeLabel())}
      </div>
      ${renderPlayerEpisodeActions("")}
    </div>
  `;
  const shell = frame.querySelector(".vidstream-player");
  setPlayerCinema(shell, true, { silent: true });
  frame.querySelector("[data-player-exit]")?.addEventListener("click", exitPlayerToSources);
  frame.querySelector("[data-player-back]")?.addEventListener("click", () => showEpisodeListTab());
  wirePlayerChrome(frame);
  refreshFocusables();
}

function exitPlayerToSources() {
  stopActivePlayback();
  document.body.classList.remove("player-cinema-open");
  document.body.classList.remove("has-embedded-player");

  const frame = document.querySelector("#videoFrame");
  if (!frame) return;

  resetVideoFrame();
  showEpisodeListTab();
}

let hlsScriptPromise = null;

function loadHlsScript() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (!hlsScriptPromise) {
    hlsScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js";
      script.async = true;
      script.onload = () => resolve(window.Hls);
      script.onerror = () => reject(new Error("hls.js failed to load"));
      document.head.appendChild(script);
    });
  }
  return hlsScriptPromise;
}

function streamTypeFromUrl(url = "") {
  const value = String(url || "").split("?")[0].split("#")[0].toLowerCase();
  if (value.endsWith(".m3u8")) return "hls";
  if (value.endsWith(".mpd")) return "dash";
  if (value.endsWith(".mp4") || value.endsWith(".m4v") || value.endsWith(".webm") || value.endsWith(".mov")) return "file";
  return "";
}

function streamProxyHost(url = "") {
  try {
    const host = new URL(url).host.toLowerCase();
    if (/owocdn\.top|uwucdn\.top|kwik\.cx/i.test(host)) return "kwik.cx";
    if (/mewstream\.buzz|prxy\.miruro\.to|ultracloud\.cc/i.test(host)) return "www.miruro.tv";
    if (/cinewave|streamzone/i.test(host)) return "megaplay.buzz";
    if (/anime-dunya/i.test(host)) return "anime-dunya.com";
    if (/watching\.onl|vidwish\.live|anivideo\.sbs|cloudbuzz\.lol|trycloud\.pro/i.test(host)) return "vidwish.live";
    if (/mp4upload\.com/i.test(host)) return "mp4upload.com";
    return host;
  } catch (error) {
    return "";
  }
}

function isProxyableStreamUrl(url = "") {
  return /^https?:\/\//i.test(String(url || ""));
}

function proxiedStreamUrl(url = "") {
  const resolved = resolveSourceEndpoint(url);
  if (!isProxyableStreamUrl(resolved) || location.protocol === "file:") return resolved;
  const proxyHost = streamProxyHost(resolved);
  const proxy = new URL(LOCAL_SOURCE_PROXY_ENDPOINT, location.href);
  proxy.searchParams.set("url", resolved);
  if (proxyHost) proxy.searchParams.set("refererHost", proxyHost);
  return proxy.toString();
}

function playerFitScaleValue(fit = state.uiPreferences.playerFit || "contain") {
  if (fit === "cover") return 1;
  if (fit === "fill") return 2;
  return 0;
}

function buildApkPlayerUrl(url = "") {
  const playerUrl = new URL("./player/player.html", location.href);
  playerUrl.searchParams.set("src", resolveSourceEndpoint(url));
  playerUrl.searchParams.set("audio", getLanguagePreferences().audio || "");
  playerUrl.searchParams.set("quality", String(Number(state.uiPreferences.playerQuality || 0)));
  const hash = streamTypeFromUrl(url) === "dash"
    ? "#dash"
    : streamTypeFromUrl(url) === "file"
      ? "#file"
      : "";
  return `${playerUrl.toString()}${hash}`;
}

function createApkPlayerController(iframe, options = {}) {
  const events = document.createDocumentFragment();
  const controller = {
    duration: 0,
    currentTime: 0,
    bufferedEnd: 0,
    paused: true,
    muted: false,
    volume: Number(state.uiPreferences.defaultVolume ?? 0.1),
    playbackRate: 1,
    resolution: "",
    qualities: [],
    audioLanguages: [],
    isApkPlayer: true,
    addEventListener: (...args) => events.addEventListener(...args),
    removeEventListener: (...args) => events.removeEventListener(...args),
    dispatchEvent: (...args) => events.dispatchEvent(...args),
    play() {
      this.paused = false;
      postApkPlayerCommand(iframe, "play", 1);
      events.dispatchEvent(new Event("play"));
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
      postApkPlayerCommand(iframe, "pause", 0);
      events.dispatchEvent(new Event("pause"));
    }
  };

  Object.defineProperty(controller, "currentTime", {
    get() { return this._currentTime || 0; },
    set(value) {
      this._currentTime = Number(value) || 0;
      postApkPlayerCommand(iframe, "seek", this._currentTime);
    }
  });
  Object.defineProperty(controller, "playbackRate", {
    get() { return this._playbackRate || 1; },
    set(value) {
      this._playbackRate = Number(value) || 1;
      postApkPlayerCommand(iframe, "speed", this._playbackRate);
    }
  });
  Object.defineProperty(controller, "volume", {
    get() { return Number.isFinite(this._volume) ? this._volume : Number(state.uiPreferences.defaultVolume ?? 0.1); },
    set(value) {
      this._volume = Math.max(0, Math.min(1, Number(value) || 0));
      postApkPlayerCommand(iframe, "volume", this._volume);
    }
  });
  Object.defineProperty(controller, "muted", {
    get() { return Boolean(this._muted); },
    set(value) {
      this._muted = Boolean(value);
      postApkPlayerCommand(iframe, "muted", this._muted);
    }
  });

  function emit(type) {
    events.dispatchEvent(new Event(type));
  }

  function onMessage(event) {
    if (event.source !== iframe.contentWindow) return;
    let data = event.data;
    try {
      if (typeof data === "string") data = JSON.parse(data);
    } catch (error) {
      return;
    }
    if (!data?.vcmd) return;
    const command = data.vcmd;
    const value = data.val;
    if (value && typeof value === "object") {
      controller._currentTime = Number(value.position || 0);
      controller.duration = Number(value.duration || 0);
      controller.bufferedEnd = Number(value.buffer || 0);
    }
    if (command === "ready" || command === "loadedmetadata") {
      emit("loadedmetadata");
      postApkPlayerCommand(iframe, "scale", playerFitScaleValue());
      postApkPlayerCommand(iframe, "quality", Number(state.uiPreferences.playerQuality || 0));
      postApkPlayerCommand(iframe, "audiolang", getLanguagePreferences().audio || "");
      controller.volume = Number(state.uiPreferences.defaultVolume ?? 0.1);
    } else if (command === "play") {
      controller.paused = false;
      emit("play");
    } else if (command === "pause") {
      controller.paused = true;
      emit("pause");
    } else if (command === "time") {
      emit("timeupdate");
    } else if (command === "waiting" || command === "initializing") {
      emit("waiting");
    } else if (command === "canplay" || command === "playing") {
      controller.paused = false;
      emit("canplay");
      emit("playing");
    } else if (command === "complete") {
      emit("ended");
    } else if (command === "error") {
      emit("error");
    } else if (command === "resolution") {
      controller.resolution = String(value || "");
      options.onResolution?.(controller.resolution);
    } else if (command === "qualities") {
      controller.qualities = Array.isArray(value) ? value : [];
      options.onQualities?.(controller.qualities);
    } else if (command === "langavail") {
      controller.audioLanguages = String(value || "").split(",").filter(Boolean);
    }
  }

  window.addEventListener("message", onMessage);
  controller.destroy = () => window.removeEventListener("message", onMessage);
  iframe.addEventListener("load", () => {
    postApkPlayerCommand(iframe, "scale", playerFitScaleValue());
    postApkPlayerCommand(iframe, "quality", Number(state.uiPreferences.playerQuality || 0));
    postApkPlayerCommand(iframe, "audiolang", getLanguagePreferences().audio || "");
    controller.volume = Number(state.uiPreferences.defaultVolume ?? 0.1);
  });
  return controller;
}

function postApkPlayerCommand(iframe, command, value) {
  iframe?.contentWindow?.postMessage(JSON.stringify({ vcmd: command, val: value }), "*");
}

// True if the native Android ExoPlayer bridge exists and accepted the stream.
// In the browser there is no bridge, so this is a no-op and the WebView player
// runs as before.
function playInNativeAndroidPlayer(streamUrl, streamType) {
  try {
    const bridge = window.ZenkaiNative;
    if (!streamUrl || !bridge || typeof bridge.play !== "function") return false;
    const abs = new URL(streamUrl, location.origin).href;   // ExoPlayer needs an absolute URL
    const show = state.activeShow ? getShowTitle(state.activeShow) : "";
    const epObj = state.activeEpisode?.episode;
    const epNum = (epObj && (epObj.episode || epObj.number)) || "";
    const title = [show, epNum ? `Episode ${epNum}` : ""].filter(Boolean).join(" — ");
    bridge.play(abs, title, streamType || "auto", "{}");
    showToast("Opening native player…");
    return true;
  } catch (_) {
    return false;
  }
}

async function setupVideoSource(video, url) {
  if (!video || !url) return;
  const sourceUrl = proxiedStreamUrl(url);
  const streamType = streamTypeFromUrl(sourceUrl) || streamTypeFromUrl(url);
  // Android TV app: hand HLS/MP4 streams to the native ExoPlayer (the WebView's
  // <video>/hls.js path can't reliably play them on a TV WebView).
  if (playInNativeAndroidPlayer(sourceUrl, streamType)) return;
  if (video._animeTvHls) {
    try {
      video._animeTvHls.destroy();
    } catch (error) {
      // Ignore stale hls.js cleanup failures.
    }
    video._animeTvHls = null;
  }
  if (streamType === "hls" && !video.canPlayType("application/vnd.apple.mpegurl")) {
    const Hls = await loadHlsScript();
    if (Hls?.isSupported?.()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 60,
        xhrSetup: (xhr) => {
          const proxyHost = streamProxyHost(url);
          if (proxyHost) xhr.setRequestHeader("X-Stream-Prox", proxyHost);
        }
      });
      hls.loadSource(sourceUrl);
      hls.attachMedia(video);
      video._animeTvHls = hls;
      return;
    }
  }
  video.src = sourceUrl;
}

function renderPlayerPanelContent(type, episode, url, tracks = []) {
  const buffered = document.querySelector("#animePlayer")?.buffered;
  const duration = document.querySelector("#animePlayer")?.duration || 0;
  const bufferedEnd = buffered?.length ? buffered.end(buffered.length - 1) : 0;
  if (type === "network") {
    const percent = duration ? Math.round((bufferedEnd / duration) * 100) : 0;
    return `
      <strong>Network status</strong>
      <p>Buffered: ${Number.isFinite(percent) ? percent : 0}%</p>
      <p>Playback uses the selected server directly when possible.</p>
    `;
  }
  if (type === "speed") {
    return `
      <strong>Playback speed</strong>
      <div class="vid-panel-grid">
        ${[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((rate) => `
          <button class="focusable vid-panel-choice" type="button" data-rate="${rate}">x${rate}</button>
        `).join("")}
      </div>
    `;
  }
  if (type === "subtitles") {
    const subtitleTracks = getAvailableSubtitles(episode);
    return `
      <strong>Subtitles</strong>
      <div class="vid-panel-grid">
        ${subtitleTracks.map((track) => `
          <button class="focusable vid-panel-choice" type="button" data-sub-choice="${track}">${languageOptionLabel(track, "subtitles")}</button>
        `).join("")}
      </div>
      ${tracks.length ? `<p>${tracks.length} subtitle file${tracks.length === 1 ? "" : "s"} connected.</p>` : `<p>No subtitle file is connected for this server.</p>`}
    `;
  }
  return `
    <strong>More options</strong>
    <div class="vid-panel-grid">
      <button class="focusable vid-panel-choice" type="button" data-copy-url>Copy stream link</button>
      <a class="focusable vid-panel-choice" href="${escapeHtml(getActiveDownloadUrl(url) || url)}" download>Download video</a>
      <button class="focusable vid-panel-choice" type="button" data-reload-player>Reload player</button>
    </div>
  `;
}

function openPlayerPanel(frame, type, video, episode, url, tracks = []) {
  const panel = frame.querySelector("#playerPanel");
  if (!panel) return;
  if (!panel.hidden && panel.dataset.panelType === type) {
    panel.hidden = true;
    panel.innerHTML = "";
    panel.dataset.panelType = "";
    return;
  }
  panel.dataset.panelType = type;
  panel.innerHTML = renderPlayerPanelContent(type, episode, url, tracks);
  panel.hidden = false;
  panel.querySelectorAll("[data-rate]").forEach((button) => {
    button.addEventListener("click", () => {
      video.playbackRate = Number(button.dataset.rate) || 1;
      showToast(`Speed x${video.playbackRate}`);
    });
  });
  panel.querySelectorAll("[data-sub-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      setDefaultLanguage(getLanguagePreferences().audio, button.dataset.subChoice);
      setupSpanishSubtitles(episode, tracks, video);
      showToast(`Subtitles: ${button.dataset.subChoice === "none" ? "off" : button.dataset.subChoice}`);
    });
  });
  panel.querySelector("[data-copy-url]")?.addEventListener("click", () => copyExternalUrl(url));
  panel.querySelector("[data-reload-player]")?.addEventListener("click", () => playActiveShow({ allowSourceLookup: false }));
  refreshFocusables();
}

function wireVidstreamControls(frame, video, episode, url, tracks = []) {
  const shell = frame.querySelector(".vidstream-player");
  const seek = frame.querySelector("#playerSeek");
  const time = frame.querySelector("#playerTime");
  const toggle = frame.querySelector("[data-player-toggle]");
  const volume = frame.querySelector("[data-player-volume]");
  const loader = frame.querySelector(".vid-loader");

  const updateTime = () => {
    const duration = video.duration || 0;
    const current = video.currentTime || 0;
    if (time) time.textContent = `${formatPlayerTime(current)} / ${formatPlayerTime(duration)}`;
    if (seek && duration && !seek.matches(":active")) {
      seek.value = String(Math.round((current / duration) * 1000));
    }
  };

  const updateToggle = () => {
    if (toggle) toggle.textContent = video.paused ? "▶" : "Ⅱ";
  };

  const updateVolume = () => {
    if (volume) volume.textContent = video.muted || video.volume === 0 ? "○" : "▸";
  };

  toggle?.addEventListener("click", () => {
    if (video.paused) video.play().catch(() => showToast("Tap play again if the browser blocked autoplay."));
    else video.pause();
  });
  volume?.addEventListener("click", () => {
    video.muted = !video.muted;
    updateVolume();
  });
  seek?.addEventListener("input", () => {
    if (!video.duration) return;
    video.currentTime = (Number(seek.value) / 1000) * video.duration;
  });
  frame.querySelector("[data-player-exit]")?.addEventListener("click", exitPlayerToSources);
  frame.querySelector("[data-player-back]")?.addEventListener("click", () => showEpisodeListTab());
  frame.querySelector("[data-player-cast]")?.addEventListener("click", () => castActiveEpisode());
  frame.querySelector("[data-player-fullscreen]")?.addEventListener("click", () => toggleNativeFullscreen());
  frame.querySelector("[data-player-fit]")?.addEventListener("click", () => {
    const modes = ["contain", "cover", "fill"];
    const current = state.uiPreferences.playerFit || "contain";
    const next = modes[(modes.indexOf(current) + 1) % modes.length] || "contain";
    saveUiPreferences({ playerFit: next });
    shell?.classList.remove("fit-contain", "fit-cover", "fit-fill");
    shell?.classList.add(`fit-${next}`);
    if (video?.isApkPlayer) {
      postApkPlayerCommand(frame.querySelector("#animePlayerFrame"), "scale", playerFitScaleValue(next));
    }
    const fitButton = frame.querySelector("[data-player-fit]");
    if (fitButton) fitButton.textContent = next === "cover" ? "□" : next === "fill" ? "▣" : "▭";
    showToast(`Video fit: ${next}`);
  });
  frame.querySelectorAll("[data-player-panel]").forEach((button) => {
    button.addEventListener("click", () => openPlayerPanel(frame, button.dataset.playerPanel, video, episode, url, tracks));
  });
  video.addEventListener("loadedmetadata", updateTime);
  video.addEventListener("timeupdate", updateTime);
  video.addEventListener("play", updateToggle);
  video.addEventListener("pause", updateToggle);
  video.addEventListener("waiting", () => loader && (loader.hidden = false));
  video.addEventListener("canplay", () => loader && (loader.hidden = true));
  video.addEventListener("playing", () => loader && (loader.hidden = true));
  updateToggle();
  updateVolume();
  updateTime();
}

function getActiveDownloadUrl(currentUrl = "") {
  const episode = state.activeEpisode?.episode || {};
  const selectedSource = getSelectedEpisodeSource(episode);
  const sources = getEpisodePlaybackSources(episode);
  const sourceDownload = selectedSource?.downloadUrl || selectedSource?.videoUrl || "";
  const bestDirectSource = sources.find((source) => source.downloadUrl || source.videoUrl);
  return selectedSource?.downloadUrl
    || sourceDownload
    || episode.downloadUrl
    || episode.download
    || episode.download_url
    || bestDirectSource?.downloadUrl
    || bestDirectSource?.videoUrl
    || currentUrl
    || "";
}

function selectEpisodeByPosition(seasonIndex, episodeIndex, shouldPlay = true) {
  const seasons = getDetailSeasons(state.activeShow || {});
  const season = seasons[seasonIndex];
  const episode = season?.episodes?.[episodeIndex];
  if (!season || !episode) return;
  state.activeSeasonIndex = seasonIndex;
  state.activeDetailTab = "episodes";
  state.activeEpisode = { season, episode, seasonIndex, episodeIndex };
  state.activeEpisodeUrl = getEpisodeUrl(episode);
  renderEpisodeList(state.activeShow);
  if (shouldPlay) {
    const frame = document.querySelector("#videoFrame");
    const show = state.activeShow;
    if (frame && show) {
      stopActivePlayback();
      document.body.classList.remove("player-cinema-open");
      const background = show.banner || show.image || "";
      frame.style.setProperty("--watch-bg", background ? `url("${background}")` : "none");
      schedulePlaybackSourceOptions(show, episode, season?.season || seasonIndex + 1 || 1);
      renderSourcePickerIn(frame);
    }
  }
  refreshFocusables();
}

function showEpisodeListTab() {
  // If in cinema / fullscreen mode, exit it first so the episode panel is visible
  if (document.body.classList.contains("player-cinema-open")) {
    const container = document.querySelector(".vidstream-player");
    if (container) {
      container.classList.remove("is-cinema");
      document.body.classList.remove("player-cinema-open");
    }
  }
  state.activeDetailTab = "episodes";
  renderEpisodeList(state.activeShow);
  // Scroll the right source/episode panel to the episode list
  window.setTimeout(() => {
    const sidePanel = document.querySelector(".watch-side");
    if (sidePanel) sidePanel.scrollTo({ top: sidePanel.scrollHeight, behavior: "smooth" });
    episodeList?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, 80);
  refreshFocusables();
}

function wirePlayerChrome(frame) {
  frame.querySelectorAll("[data-player-source]").forEach((button) => {
    button.addEventListener("click", () => {
      const selectedEpisode = state.activeEpisode?.episode;
      if (!selectedEpisode) return;
      selectedEpisode.selectedSourceId = button.dataset.playerSource;
      state.preferredSource = selectedEpisode.selectedSourceId;
      try {
        localStorage.setItem(PREFERRED_SOURCE_KEY, state.preferredSource);
      } catch (error) {
        console.warn("Preferred source could not be saved:", error);
      }
      playActiveShow();
    });
  });

  // When the source picker is open, prev/next jump to the adjacent episode's
  // SOURCE SELECTOR. When actually playing, they play the adjacent episode.
  const goAdjacent = (target) => {
    if (!target) return;
    const inPicker = Boolean(frame.querySelector(".source-picker"));
    if (inPicker) selectEpisodeByPosition(target.seasonIndex, target.episodeIndex, true);
    else playEpisodeByPosition(target.seasonIndex, target.episodeIndex);
  };

  frame.querySelectorAll("[data-player-prev]").forEach((button) => {
    button.addEventListener("click", () => goAdjacent(getEpisodeNavigationTargets().previous));
  });

  frame.querySelectorAll("[data-player-next]").forEach((button) => {
    button.addEventListener("click", () => goAdjacent(getEpisodeNavigationTargets().next));
  });

  frame.querySelectorAll("[data-player-list]").forEach((button) => {
    button.addEventListener("click", () => showEpisodeListTab());
  });
}

// Stable per-anime id used for watch tracking (animeId in episodeKey).
function getAnimeTrackId(show = {}) {
  return String(show.id || show.anilistId || show.malId || normalizeTitle(show.title) || "anime");
}

// episodeKey = animeId-season-episode (e.g. "21-1-5"). Kept colon-formatted
// internally for back-compat with previously saved data.
function buildWatchKey(show, seasonNumber, episodeNumber) {
  if (!show) return "";
  return `${getAnimeTrackId(show)}:s${seasonNumber || 1}:e${episodeNumber || 1}`;
}

function getWatchKey(show = state.activeShow, episode = state.activeEpisode?.episode) {
  if (!show || !episode) return "";
  const seasonNumber = episode.season || state.activeEpisode?.season?.season || (state.activeSeasonIndex + 1) || 1;
  return buildWatchKey(show, seasonNumber, episode.episode || episode.number || 1);
}

function readStoredMap(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "{}");
  } catch (error) {
    return {};
  }
}

// In-memory cache of the resume/progress map so reads (badges, stats, continue
// watching) are cheap and survive metadata refreshes. Loaded once, written through.
let _watchMapCache = null;
let _activeProgressPlayer = null;   // { player, episode } for save-on-close
let _nativePlayContext = null;      // { show, season, episode, key } for native player callbacks
function getWatchMap() {
  if (!_watchMapCache) _watchMapCache = readStoredMap(RESUME_POSITIONS_KEY);
  return _watchMapCache;
}
function persistWatchMap() {
  try { localStorage.setItem(RESUME_POSITIONS_KEY, JSON.stringify(_watchMapCache || {})); } catch { /* quota / disabled */ }
}

// Single source of truth for writing a progress record. Used by the web <video>,
// the native Android bridge, and manual mark-watched.
function recordWatchProgress({ show, season, episode, positionSec, durationSec, episodeTitle, thumb, completed }) {
  if (!show) return;
  const seasonNumber = Number(season) || 1;
  const episodeNumber = Number(episode) || 1;
  const key = buildWatchKey(show, seasonNumber, episodeNumber);
  if (!key) return;
  const map = getWatchMap();
  const prev = map[key] || {};
  const dur = Math.floor(durationSec || prev.duration || 0);
  let pos = Math.max(0, Math.floor(positionSec || 0));
  let progress = dur > 0 ? Math.min(100, Math.round((pos / dur) * 100)) : (prev.progress || 0);
  if (completed) { progress = 100; pos = dur || pos; }
  map[key] = {
    episodeKey: key,
    animeId: getAnimeTrackId(show),
    showId: show.id || null,
    title: getShowTitle(show) || show.title || prev.title || "",
    season: seasonNumber,
    episode: episodeNumber,
    episodeTitle: episodeTitle || prev.episodeTitle || "",
    thumb: thumb || prev.thumb || show.image || show.banner || "",
    poster: show.image || prev.poster || "",
    progress,
    lastPosition: pos,
    position: pos,
    duration: dur,
    watched: progress >= 90,
    lastWatchedAt: Date.now(),
    updatedAt: Date.now()
  };
  persistWatchMap();
  scheduleContinueWatchingRefresh();
}

// Throttled writer wired to the web player's timeupdate (saves ~every 10s);
// force=true for pause/exit/ended so we never lose the final position.
function saveWatchProgress(video, episode, opts = {}) {
  if (!video || !Number.isFinite(video.currentTime)) return;
  const now = Date.now();
  if (!opts.force && now - (saveWatchProgress._last || 0) < 9500) return;
  saveWatchProgress._last = now;
  const ep = episode || state.activeEpisode?.episode || {};
  const seasonObj = state.activeEpisode?.season || {};
  const seasonNumber = ep.season || seasonObj.season || (state.activeSeasonIndex + 1) || 1;
  recordWatchProgress({
    show: state.activeShow,
    season: seasonNumber,
    episode: ep.episode || ep.number || 1,
    positionSec: video.currentTime,
    durationSec: video.duration,
    episodeTitle: ep.title || "",
    thumb: episodeThumb(ep, seasonObj, state.activeShow || {}),
    completed: opts.completed
  });
}

function getResumePosition(episode) {
  const key = getWatchKey(state.activeShow, episode);
  const item = key ? getWatchMap()[key] : null;
  return item?.lastPosition > 8 ? item.lastPosition : 0;
}

// ── Watch-state readers (badges / stats / continue-watching) ────────────────
function getEpisodeWatchState(show, seasonNumber, episodeNumber) {
  const key = buildWatchKey(show, seasonNumber, episodeNumber);
  return key ? getWatchMap()[key] || null : null;
}

function getSeasonStats(show, season, seasonNumber) {
  const episodes = season?.episodes || [];
  let watched = 0;
  episodes.forEach((ep, i) => {
    const st = getEpisodeWatchState(show, seasonNumber, ep.episode || i + 1);
    if (st?.watched) watched += 1;
  });
  const total = episodes.length;
  return {
    watched,
    remaining: Math.max(0, total - watched),
    total,
    percent: total ? Math.round((watched / total) * 100) : 0
  };
}

// Most-recent in-progress episodes (progress 1–89%), newest first.
function getContinueWatchingList(limit = 20) {
  const map = getWatchMap();
  return Object.values(map)
    .filter((e) => e && e.progress > 0 && e.progress < 90 && !e.watched)
    .sort((a, b) => (b.lastWatchedAt || 0) - (a.lastWatchedAt || 0))
    .slice(0, limit);
}

let _cwTimer = null;
function scheduleContinueWatchingRefresh() {
  if (_cwTimer) return;
  _cwTimer = setTimeout(() => { _cwTimer = null; renderContinueWatching(); }, 300);
}

function renderContinueWatching() {
  const section = document.querySelector("#continueWatching");
  const grid = document.querySelector("#continueGrid");
  if (!section || !grid) return;
  const list = getContinueWatchingList(20);
  if (!list.length) {
    section.classList.add("is-hidden");
    grid.dataset.cardsSig = "";
    grid.innerHTML = "";
    return;
  }
  section.classList.remove("is-hidden");
  const sig = list.map((e) => `${e.episodeKey}:${e.progress}`).join("|");
  if (grid.dataset.cardsSig === sig) return; // skip identical repaint
  grid.dataset.cardsSig = sig;
  grid.innerHTML = list.map((e) => {
    const img = e.thumb || e.poster || "";
    const sub = `S${e.season}E${e.episode} · ${e.progress}%`;
    return `
    <button class="show-card continue-card focusable" type="button"
            data-continue-key="${escapeHtml(e.episodeKey)}" data-show-id="${escapeHtml(String(e.showId || e.animeId))}">
      <span class="continue-thumb">
        ${img ? `<img src="${escapeHtml(img)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : ""}
        <span class="continue-play" aria-hidden="true">▶</span>
        <span class="continue-bar"><span style="width:${e.progress}%"></span></span>
      </span>
      <strong class="continue-card-title">${escapeHtml(e.title)}</strong>
      <small class="continue-card-sub">${escapeHtml(sub)}</small>
    </button>`;
  }).join("");
  grid.querySelectorAll("[data-continue-key]").forEach((card) => {
    card.addEventListener("click", () => resumeFromContinue(card.dataset.showId, card.dataset.continueKey));
  });
}

function resumeFromContinue(showId, key) {
  const m = /:s(\d+):e(\d+)$/.exec(key || "");
  const seasonNumber = m ? Number(m[1]) : 1;
  const episodeNumber = m ? Number(m[2]) : 1;
  if (!showId) return;
  openShow(showId, { seasonNumber, episodeNumber, playIntent: true });
}

// ── Native (Android) player → web bridge ────────────────────────────────────
// The TV ExoPlayer plays outside the WebView, so it calls these to persist
// progress and refresh the home rail when the user returns. No-ops on desktop.
window.ZenkaiTrackProgress = function (episodeKey, posMs, durMs, completed) {
  try {
    const posSec = Math.floor((Number(posMs) || 0) / 1000);
    const durSec = Math.floor((Number(durMs) || 0) / 1000);
    const ctx = _nativePlayContext;
    if (ctx && ctx.key === episodeKey && ctx.show) {
      recordWatchProgress({
        show: ctx.show, season: ctx.season, episode: ctx.episode,
        positionSec: posSec, durationSec: durSec,
        episodeTitle: ctx.episodeTitle, thumb: ctx.thumb, completed: Boolean(completed)
      });
      return;
    }
    // Fallback: reconstruct the show from the key (animeId:sN:eM).
    const parts = /^(.+):s(\d+):e(\d+)$/.exec(String(episodeKey || ""));
    if (!parts) return;
    const animeId = parts[1];
    const show = state.shows.find((s) => getAnimeTrackId(s) === animeId);
    if (!show) return;
    recordWatchProgress({
      show, season: Number(parts[2]), episode: Number(parts[3]),
      positionSec: posSec, durationSec: durSec, completed: Boolean(completed)
    });
  } catch (error) {
    console.warn("ZenkaiTrackProgress failed:", error);
  }
};

window.ZenkaiRefreshHome = function () {
  try { renderContinueWatching(); } catch (error) { /* ignore */ }
};

function isActiveEpisode(seasonIndex, episodeIndex) {
  return state.activeEpisode?.seasonIndex === seasonIndex && state.activeEpisode?.episodeIndex === episodeIndex;
}

async function selectEpisode(season, episode, seasonIndex, episodeIndex) {
  if (!episode) return;
  state.activeSeasonIndex = seasonIndex;
  state.activeDetailTab = "episodes";
  state.activeEpisode = { season, episode, seasonIndex, episodeIndex };
  state.activeEpisodeUrl = getEpisodeUrl(episode);
  renderEpisodeList(state.activeShow);
  const frame = document.querySelector("#videoFrame");
  const show = state.activeShow;
  if (frame && show) {
    stopActivePlayback();
    document.body.classList.remove("player-cinema-open");
    const background = show.banner || show.image || "";
    frame.style.setProperty("--watch-bg", background ? `url("${background}")` : "none");
    schedulePlaybackSourceOptions(show, episode, season?.season || seasonIndex + 1 || 1);
    renderSourcePickerIn(frame);
  }
  refreshFocusables();
}

function getPlayableUrl(show) {
  if (!show) return "";
  if (state.activeEpisode) return getEpisodeUrl(state.activeEpisode.episode);
  return state.activeEpisodeUrl || show.videoUrl || getEpisodeUrl(show.seasons?.[0]?.episodes?.[0]) || getEpisodeUrl(show.episodes?.[0]) || "";
}

function _buildShowsByAniListId() {
  const map = new Map();
  for (const s of state.shows) {
    if (s.anilistId) map.set(String(s.anilistId), s);
  }
  return map;
}

function getFranchiseSeasonList(show) {
  // ── AniList-powered franchise (most accurate) ────────────────────────────
  if (show.anilistFranchise) {
    const showsMap = _buildShowsByAniListId();
    const list = buildSeasonListFromAniListFranchise(
      show, showsMap, getDetailSeasons, makePlaceholderEpisodes
    );
    if (list && list.length > 0) return list;
  }

  // ── No relation-based franchise available ────────────────────────────────
  // Do NOT group different shows just because they share a normalized title —
  // that merged separate adaptations/remakes (Doraemon 1973/1979/2005) into
  // fake seasons. Real seasons only come from AniList SEQUEL/PREQUEL above.
  // Otherwise show just this entry's own episodes.
  return getDetailSeasons(show);
}

// ── TioAnime source integration ───────────────────────────────────────────────

const _tioAnimeSlugCache = new Map(); // anilistId/showKey → slug
const _tioAnimeMissCache = new Set();
const _tioAnimeEpisodeSourceCache = new Map();
let _tioAnimeSlugCatalogPromise = null;
let _tioAnimeSlugTitleMap = null;
let _tioAnimeWarmStarted = false;
const TIOANIME_SEARCH_TIMEOUT_MS = 4200;
const TIOANIME_SOURCE_TIMEOUT_MS = 6500;

function tioAnimeSearchCandidates(show = {}) {
  const candidates = [
    show.title,
    getShowTitle(show),
    show.romajiTitle,
    show.nativeTitle,
    show.englishTitle,
    show.sourceTitle,
    ...(show.aliases || []),
    ...(show.alternativeTitles || []),
    ...(show.synonyms || [])
  ];
  const withCleaned = [];
  candidates.filter(Boolean).forEach((title) => {
    withCleaned.push(title);
    withCleaned.push(String(title).replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim());
    withCleaned.push(stripSeasonFromTitle(title));
    tioAnimeSeasonTitleVariants(title).forEach((variant) => withCleaned.push(variant));
  });

  const seen = new Set();
  return withCleaned
    .map((title) => String(title || "").trim())
    .filter((title) => {
      if (title.length < 2) return false;
      const key = normalizeTitle(title);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}

function tioAnimeSeasonTitleVariants(title = "") {
  const text = String(title || "").trim();
  if (!text) return [];
  const variants = new Set();
  const add = (value) => {
    const clean = String(value || "").replace(/\s+/g, " ").trim();
    if (clean) variants.add(clean);
  };
  const base = stripSeasonFromTitle(text);
  const seasonMatch = text.match(/\bseason\s*(\d+)\b/i) || text.match(/\b(\d+)(?:st|nd|rd|th)\s*season\b/i);
  const partMatch = text.match(/\bpart\s*(\d+)\b/i);
  if (base && seasonMatch) {
    const num = Number(seasonMatch[1]);
    const ordinal = ordinalSeasonLabel(num);
    add(`${base} ${num}`);
    add(`${base} season ${num}`);
    add(`${base} ${ordinal}`);
    add(`${base} ${ordinal} season`);
  }
  if (base && partMatch) {
    const num = Number(partMatch[1]);
    add(`${base} part ${num}`);
    add(`${base} ${num}`);
  }
  return [...variants];
}

function ordinalSeasonLabel(value) {
  const num = Number(value) || 0;
  const mod100 = num % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${num}th`;
  const suffix = num % 10 === 1 ? "st" : num % 10 === 2 ? "nd" : num % 10 === 3 ? "rd" : "th";
  return `${num}${suffix}`;
}

function tioAnimeSlugFromSearchPayload(data = {}) {
  return data.slug
    || data.anime?.slug
    || data.result?.slug
    || data.item?.slug
    || data.results?.[0]?.slug
    || data.items?.[0]?._slug
    || data.items?.[0]?.slug
    || "";
}

async function fetchTioAnimeSlugSearch(paramName, value, cacheKey) {
  if (!value || _tioAnimeMissCache.has(cacheKey)) return "";
  if (_tioAnimeSlugCache.has(cacheKey)) return _tioAnimeSlugCache.get(cacheKey);
  const qs = `${paramName}=${encodeURIComponent(value)}`;
  const res = await fetchWithTimeout(`./api/tioanime/search?${qs}`, { cache: "no-store" }, TIOANIME_SEARCH_TIMEOUT_MS);
  if (!res.ok) return "";
  const data = await res.json();
  const slug = data.ok ? tioAnimeSlugFromSearchPayload(data) : "";
  if (slug) {
    _tioAnimeSlugCache.set(cacheKey, slug);
    return slug;
  }
  _tioAnimeMissCache.add(cacheKey);
  return "";
}

async function ensureTioAnimeSlugCatalog() {
  if (_tioAnimeSlugTitleMap) return _tioAnimeSlugTitleMap;
  if (!_tioAnimeSlugCatalogPromise) {
    _tioAnimeSlugCatalogPromise = fetchWithTimeout(TIOANIME_SLUGS_ENDPOINT, { cache: "no-store" }, 18000)
      .then((res) => res.ok ? res.json() : null)
      .then((payload) => {
        _tioAnimeSlugTitleMap = payload?.ok && payload.byTitle ? payload.byTitle : {};
        Object.entries(_tioAnimeSlugTitleMap).forEach(([key, slug]) => {
          if (key && slug) _tioAnimeSlugCache.set(`t:${key}`, slug);
        });
        return _tioAnimeSlugTitleMap;
      })
      .catch((error) => {
        console.warn("TioAnime slug catalog unavailable:", error);
        _tioAnimeSlugTitleMap = {};
        return _tioAnimeSlugTitleMap;
      });
  }
  return _tioAnimeSlugCatalogPromise;
}

function applyTioAnimeSlugFromMap(show, slugMap = _tioAnimeSlugTitleMap || {}) {
  if (!show || !slugMap) return null;
  if (show.tioAnimeSlug) return { slug: show.tioAnimeSlug, matchedTitle: show.tioAnimeSlugSource || show.title || "", key: "cached-show" };
  for (const title of tioAnimeSearchCandidates(show)) {
    const key = normalizeTitle(title);
    const slug = slugMap[key];
    if (slug) {
      show.tioAnimeSlug = slug;
      show.tioAnimeSlugSource = title;
      _tioAnimeSlugCache.set(`t:${key}`, slug);
      return { slug, matchedTitle: title, key };
    }
    const strippedKey = normalizeTitle(stripSeasonFromTitle(title));
    if (strippedKey && slugMap[strippedKey]) {
      show.tioAnimeSlug = slugMap[strippedKey];
      show.tioAnimeSlugSource = title;
      _tioAnimeSlugCache.set(`t:${strippedKey}`, show.tioAnimeSlug);
      return { slug: show.tioAnimeSlug, matchedTitle: title, key: strippedKey };
    }
  }
  return null;
}

async function resolveTioAnimeSlugFromCatalog(show) {
  const slugMap = await ensureTioAnimeSlugCatalog();
  return applyTioAnimeSlugFromMap(show, slugMap);
}

function warmTioAnimeSlugCatalog(shows = state.shows) {
  if (_tioAnimeSlugTitleMap) {
    (shows || []).forEach((show) => applyTioAnimeSlugFromMap(show, _tioAnimeSlugTitleMap));
    return;
  }
  if (_tioAnimeWarmStarted) return;
  _tioAnimeWarmStarted = true;
  ensureTioAnimeSlugCatalog()
    .then((slugMap) => {
      const currentShows = state.shows?.length ? state.shows : shows;
      (currentShows || []).forEach((show) => applyTioAnimeSlugFromMap(show, slugMap));
      const matched = (currentShows || []).filter((show) => show.tioAnimeSlug).length;
      if (matched) console.info(`Prepared TioAnime source matching for ${matched} anime.`);
    })
    .catch((error) => {
      _tioAnimeWarmStarted = false;
      console.warn("TioAnime slug warmup failed:", error);
    });
}

/**
 * Resolve and store show.tioAnimeSlug by calling the Python service.
 * Never throws — silently skips if the service is offline.
 */
async function hydrateTioAnimeSlug(show, options = {}) {
  if (!show || (show.tioAnimeSlugChecked && !options.force)) return show;
  try {
    const catalogMatch = await resolveTioAnimeSlugFromCatalog(show);
    if (catalogMatch?.slug) {
      show.tioAnimeSlug = catalogMatch.slug;
      show.tioAnimeSlugSource = catalogMatch.matchedTitle;
      _tioAnimeSlugCache.set(`t:${catalogMatch.key}`, catalogMatch.slug);
      show.tioAnimeSlugChecked = true;
      return show;
    }

    if (show.anilistId) {
      const idKey = `al:${show.anilistId}`;
      const idSlug = await fetchTioAnimeSlugSearch("id", show.anilistId, idKey);
      if (idSlug) {
        show.tioAnimeSlug = idSlug;
        show.tioAnimeSlugChecked = true;
        return show;
      }
    }

    for (const title of tioAnimeSearchCandidates(show)) {
      const titleKey = `t:${normalizeTitle(title)}`;
      const slug = await fetchTioAnimeSlugSearch("title", title, titleKey);
      if (slug) {
        show.tioAnimeSlug = slug;
        show.tioAnimeSlugSource = title;
        show.tioAnimeSlugChecked = true;
        return show;
      }
    }
  } catch (error) {
    console.warn("TioAnime search unavailable:", error);
  }
  show.tioAnimeSlugChecked = true;
  return show;
}

/**
 * Fetch TioAnime sources for a specific episode and merge them into the
 * episode's sourceOptions array so they appear in the source picker.
 */
async function attachTioAnimeSources(show, episode) {
  if (!show || !episode) return;
  if (!show.tioAnimeSlug) await hydrateTioAnimeSlug(show, { force: true });
  const slug = show.tioAnimeSlug;
  if (!slug) {
    episode.tioAnimeSourcesChecked = true;
    return;
  }
  const epNum = episode.episode || episode.number;
  if (!epNum) {
    episode.tioAnimeSourcesChecked = true;
    return;
  }
  const cacheKey = `${slug}:${epNum}`;
  const cached = _tioAnimeEpisodeSourceCache.get(cacheKey);
  if (cached) {
    mergeTioAnimeSourcesIntoEpisode(show, episode, cached, slug, epNum);
    episode.tioAnimeSourcesChecked = true;
    return;
  }
  try {
    const res = await fetchWithTimeout(
      `./api/tioanime/sources?slug=${encodeURIComponent(slug)}&episode=${encodeURIComponent(epNum)}`,
      { cache: "no-store" }, TIOANIME_SOURCE_TIMEOUT_MS
    );
    if (!res.ok) {
      episode.tioAnimeSourcesChecked = true;
      return;
    }
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.sources)) {
      episode.tioAnimeSourcesChecked = true;
      return;
    }
    _tioAnimeEpisodeSourceCache.set(cacheKey, data);
    mergeTioAnimeSourcesIntoEpisode(show, episode, data, slug, epNum);
  } catch (error) {
    console.warn("TioAnime episode sources unavailable:", error);
  }
  episode.tioAnimeSourcesChecked = true;
}

// Rank embed providers by ad behaviour so the player auto-selects ad-free hosts.
//   0 = ad-free / plays under iframe sandbox (no "Sandbox not allowed" wall)
//   1 = neutral / usually fine
//   2 = ad-walled (VOE, Netu/hqq, StreamSB) — block sandbox to force ads
function embedProviderRank(provider = "") {
  const p = String(provider).toLowerCase().replace(/[^a-z0-9]/g, "");
  const adFree  = ["mega", "mp4upload", "yourupload", "youupload", "okru", "ok", "streamwish", "filelions"];
  const adWalled = ["voe", "netu", "hqq", "streamsb", "embedsb", "sb", "dood", "doodstream", "filemoon", "vidhide", "mixdrop"];
  if (adFree.some(k => p.includes(k)))   return 0;
  if (adWalled.some(k => p.includes(k))) return 2;
  return 1;
}

function mergeTioAnimeSourcesIntoEpisode(show, episode, data, slug, epNum) {
  if (!episode || !Array.isArray(data?.sources)) return;
  const existing = new Set((episode.sourceOptions || []).map(s => s.videoUrl || s.externalUrl));
  const newOptions = data.sources
    .filter(s => s.url && !existing.has(s.url))
    .map((s, index) => {
      const rank = embedProviderRank(s.provider);
      return {
        id:          `tioanime-${normalizeTitle(s.provider || "source")}-${simpleHash(`${slug}:${epNum}:${s.provider || index}:${s.url}`)}`,
        label:       `TioAnime - ${s.provider || `Source ${index + 1}`}${rank === 2 ? " (ads)" : ""}`,
        type:        "iframe",
        externalUrl: s.url,
        videoUrl:    "",
        downloadUrl: "",
        streamResolver: null,
        sourceRank:  rank,
        adWalled:    rank === 2,
      };
    })
    // Ad-free first, ad-walled last; keep scraper order within a rank
    .sort((a, b) => a.sourceRank - b.sourceRank);

  if (newOptions.length > 0) {
    episode.sourceOptions = [...(episode.sourceOptions || []), ...newOptions];
    episode.locked = false;
    episode.server = episode.server || "TioAnime";
  }

  if (data.mega?.length && !episode.downloadUrl) {
    episode.downloadUrl = data.mega[0];
  }
}

// ── AnimeAV1 source integration ──────────────────────────────────────────────

const _animeAv1SlugCache = new Map();
const _animeAv1MissCache = new Set();
const _animeAv1EpisodeSourceCache = new Map();
let _animeAv1SlugCatalogPromise = null;
let _animeAv1SlugTitleMap = null;
let _animeAv1WarmStarted = false;
const ANIMEAV1_SEARCH_TIMEOUT_MS = 4200;
const ANIMEAV1_SOURCE_TIMEOUT_MS = 6500;

function animeAv1SearchCandidates(show = {}) {
  return tioAnimeSearchCandidates(show);
}

function animeAv1SlugFromSearchPayload(data = {}) {
  return data.slug
    || data.anime?.slug
    || data.result?.slug
    || data.item?.slug
    || data.results?.[0]?.slug
    || data.items?.[0]?._slug
    || data.items?.[0]?.slug
    || "";
}

async function fetchAnimeAv1SlugSearch(paramName, value, cacheKey) {
  if (!value || _animeAv1MissCache.has(cacheKey)) return "";
  if (_animeAv1SlugCache.has(cacheKey)) return _animeAv1SlugCache.get(cacheKey);
  const qs = `${paramName}=${encodeURIComponent(value)}`;
  const res = await fetchWithTimeout(`./api/animeav1/search?${qs}`, { cache: "no-store" }, ANIMEAV1_SEARCH_TIMEOUT_MS);
  if (!res.ok) {
    _animeAv1MissCache.add(cacheKey);
    return "";
  }
  const data = await res.json();
  const slug = data.ok ? animeAv1SlugFromSearchPayload(data) : "";
  if (slug) {
    _animeAv1SlugCache.set(cacheKey, slug);
    return slug;
  }
  _animeAv1MissCache.add(cacheKey);
  return "";
}

async function ensureAnimeAv1SlugCatalog() {
  if (_animeAv1SlugTitleMap) return _animeAv1SlugTitleMap;
  if (!_animeAv1SlugCatalogPromise) {
    _animeAv1SlugCatalogPromise = fetchWithTimeout(ANIMEAV1_SLUGS_ENDPOINT, { cache: "no-store" }, 16000)
      .then((res) => res.ok ? res.json() : null)
      .then((payload) => {
        _animeAv1SlugTitleMap = payload?.ok && payload.byTitle ? payload.byTitle : {};
        Object.entries(_animeAv1SlugTitleMap).forEach(([key, slug]) => {
          if (key && slug) _animeAv1SlugCache.set(`t:${key}`, slug);
        });
        return _animeAv1SlugTitleMap;
      })
      .catch((error) => {
        console.warn("AnimeAV1 slug catalog unavailable:", error);
        _animeAv1SlugTitleMap = {};
        return _animeAv1SlugTitleMap;
      });
  }
  return _animeAv1SlugCatalogPromise;
}

function applyAnimeAv1SlugFromMap(show, slugMap = _animeAv1SlugTitleMap || {}) {
  if (!show || !slugMap) return null;
  if (show.animeAv1Slug) return { slug: show.animeAv1Slug, matchedTitle: show.animeAv1SlugSource || show.title || "", key: "cached-show" };
  for (const title of animeAv1SearchCandidates(show)) {
    const key = normalizeTitle(title);
    const slug = slugMap[key];
    if (slug) {
      show.animeAv1Slug = slug;
      show.animeAv1SlugSource = title;
      _animeAv1SlugCache.set(`t:${key}`, slug);
      return { slug, matchedTitle: title, key };
    }
    const strippedKey = normalizeTitle(stripSeasonFromTitle(title));
    if (strippedKey && slugMap[strippedKey]) {
      show.animeAv1Slug = slugMap[strippedKey];
      show.animeAv1SlugSource = title;
      _animeAv1SlugCache.set(`t:${strippedKey}`, show.animeAv1Slug);
      return { slug: show.animeAv1Slug, matchedTitle: title, key: strippedKey };
    }
  }
  return null;
}

async function resolveAnimeAv1SlugFromCatalog(show) {
  const slugMap = await ensureAnimeAv1SlugCatalog();
  return applyAnimeAv1SlugFromMap(show, slugMap);
}

function warmAnimeAv1SlugCatalog(shows = state.shows) {
  if (_animeAv1SlugTitleMap) {
    (shows || []).forEach((show) => applyAnimeAv1SlugFromMap(show, _animeAv1SlugTitleMap));
    return;
  }
  if (_animeAv1WarmStarted) return;
  _animeAv1WarmStarted = true;
  ensureAnimeAv1SlugCatalog()
    .then((slugMap) => {
      const currentShows = state.shows?.length ? state.shows : shows;
      (currentShows || []).forEach((show) => applyAnimeAv1SlugFromMap(show, slugMap));
      const matched = (currentShows || []).filter((show) => show.animeAv1Slug).length;
      if (matched) console.info(`Prepared AnimeAV1 source matching for ${matched} anime.`);
    })
    .catch((error) => {
      _animeAv1WarmStarted = false;
      console.warn("AnimeAV1 slug warmup failed:", error);
    });
}

async function hydrateAnimeAv1Slug(show, options = {}) {
  if (!show || (show.animeAv1SlugChecked && !options.force)) return show;
  try {
    const catalogMatch = await resolveAnimeAv1SlugFromCatalog(show);
    if (catalogMatch?.slug) {
      show.animeAv1Slug = catalogMatch.slug;
      show.animeAv1SlugSource = catalogMatch.matchedTitle;
      _animeAv1SlugCache.set(`t:${catalogMatch.key}`, catalogMatch.slug);
      show.animeAv1SlugChecked = true;
      return show;
    }

    if (show.anilistId) {
      const idKey = `al:${show.anilistId}`;
      const idSlug = await fetchAnimeAv1SlugSearch("id", show.anilistId, idKey);
      if (idSlug) {
        show.animeAv1Slug = idSlug;
        show.animeAv1SlugChecked = true;
        return show;
      }
    }

    for (const title of animeAv1SearchCandidates(show)) {
      const titleKey = `t:${normalizeTitle(title)}`;
      const slug = await fetchAnimeAv1SlugSearch("title", title, titleKey);
      if (slug) {
        show.animeAv1Slug = slug;
        show.animeAv1SlugSource = title;
        show.animeAv1SlugChecked = true;
        return show;
      }
    }
  } catch (error) {
    console.warn("AnimeAV1 search unavailable:", error);
  }
  show.animeAv1SlugChecked = true;
  return show;
}

async function attachAnimeAv1Sources(show, episode) {
  if (!show || !episode) return;
  if (!show.animeAv1Slug) await hydrateAnimeAv1Slug(show, { force: true });
  const slug = show.animeAv1Slug;
  if (!slug) {
    episode.animeAv1SourcesChecked = true;
    return;
  }
  const epNum = episode.episode || episode.number;
  if (!epNum) {
    episode.animeAv1SourcesChecked = true;
    return;
  }
  const cacheKey = `${slug}:${epNum}:SUB`;
  const cached = _animeAv1EpisodeSourceCache.get(cacheKey);
  if (cached) {
    mergeAnimeAv1SourcesIntoEpisode(show, episode, cached, slug, epNum);
    episode.animeAv1SourcesChecked = true;
    return;
  }
  try {
    const res = await fetchWithTimeout(
      `./api/animeav1/sources?slug=${encodeURIComponent(slug)}&episode=${encodeURIComponent(epNum)}&variant=SUB`,
      { cache: "no-store" }, ANIMEAV1_SOURCE_TIMEOUT_MS
    );
    if (!res.ok) {
      episode.animeAv1SourcesChecked = true;
      return;
    }
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.sources)) {
      episode.animeAv1SourcesChecked = true;
      return;
    }
    _animeAv1EpisodeSourceCache.set(cacheKey, data);
    mergeAnimeAv1SourcesIntoEpisode(show, episode, data, slug, epNum);
  } catch (error) {
    console.warn("AnimeAV1 episode sources unavailable:", error);
  }
  episode.animeAv1SourcesChecked = true;
}

function mergeAnimeAv1SourcesIntoEpisode(show, episode, data, slug, epNum) {
  if (!episode || !Array.isArray(data?.sources)) return;
  const existing = new Set((episode.sourceOptions || []).map(s => s.videoUrl || s.externalUrl));
  const newOptions = data.sources
    .filter(s => (s.url || s.videoUrl || s.externalUrl) && !existing.has(s.url || s.videoUrl || s.externalUrl))
    .map((s, index) => {
      const url = s.videoUrl || s.externalUrl || s.url || "";
      const direct = s.type === "direct" || /\.(m3u8|mp4|webm|m4v)(?:$|[?#])/i.test(url);
      // Direct streams are always ad-free (rank 0); otherwise rank by provider
      const rank = direct ? 0 : embedProviderRank(s.provider);
      return {
        id:          `animeav1-${normalizeTitle(s.provider || "source")}-${simpleHash(`${slug}:${epNum}:${s.provider || index}:${url}`)}`,
        label:       `AnimeAV1 - ${s.provider || `Source ${index + 1}`}${rank === 2 ? " (ads)" : ""}`,
        type:        direct ? "direct" : "iframe",
        externalUrl: direct ? "" : url,
        videoUrl:    direct ? url : "",
        downloadUrl: "",
        streamResolver: null,
        sourceRank:  rank,
        adWalled:    rank === 2,
      };
    })
    .sort((a, b) => a.sourceRank - b.sourceRank);

  if (newOptions.length > 0) {
    episode.sourceOptions = [...(episode.sourceOptions || []), ...newOptions];
    episode.locked = false;
    episode.server = episode.server || "AnimeAV1";
  }

  const download = (data.downloads || []).find((item) => item.downloadUrl || item.url);
  if (download && !episode.downloadUrl) {
    episode.downloadUrl = download.downloadUrl || download.url;
  }
}

/**
 * After AniList franchise hydration, make sure every franchise entry
 * (movie, OVA, related TV seasons) has a minimal show object in state.shows.
 * This allows openShow() to find them when the user clicks a season card.
 */
function ensureFranchiseShowsInCatalog(show) {
  const franchise = show.anilistFranchise;
  if (!franchise) return;

  const allEntries = [
    ...franchise.tvSeasons,
    ...franchise.movies,
    ...franchise.ovas,
    ...franchise.onas,
    ...franchise.specials,
  ];

  const added = [];
  for (const entry of allEntries) {
    const aniId   = String(entry.anilistId || "");
    const extraId = String(entry.extraAnilistId || "");
    if (!aniId) continue;

    const syntheticId = `anilist-${aniId}`;
    const alreadyIn = state.shows.some(s =>
      s.id === syntheticId ||
      (s.anilistId && String(s.anilistId) === aniId) ||
      (extraId && s.anilistId && String(s.anilistId) === extraId)
    );
    if (alreadyIn) continue;

    const epCount = getSeasonEpisodeLimit(entry);
    added.push({
      id:           syntheticId,
      anilistId:    Number(aniId),
      malId:        entry.malId || null,
      title:        entry.title || syntheticId,
      romajiTitle:  entry.romajiTitle || "",
      nativeTitle:  entry.nativeTitle || "",
      episode:      epCount || "?",
      totalEpisodes: entry.episodes || null,
      latestAiredEp: entry.latestAiredEp || null,
      nextAiringEp: entry.nextAiringEp || null,
      nextAiringEpisodeNumber: entry.nextAiringEp || null,
      genre:        show.genre || "anime",
      genres:       entry.genres?.length ? entry.genres : (show.genres || []),
      format:       entry.format || "",
      status:       entry.status || "",
      year:         entry.seasonYear || "",
      source:       "AniList",
      image:        entry.image || show.image || "",
      banner:       show.banner || "",
      description:  entry.description || show.description || "",
      videoUrl:     "",
      seasons:      [],
      episodes:     [],
      colors:       show.colors || ["#40dfc2", "#251d47"],
      day:          "TBA",
      time:         "",
      score:        entry.score || null,
    });
  }

  if (added.length > 0) {
    state.shows = [...state.shows, ...added];
  }
}

function getDetailSeasons(show) {
  const inferredSeason = extractSeasonNumber(show?.title || show?.romajiTitle || show?.nativeTitle || "", 1);
  const sourceSeasons = (show.seasons?.length ? show.seasons : groupEpisodesBySeason(show.episodes || []))
    .map((season, index) => ({
      ...season,
      season: Number(season.season || season.seasonNumber || index + 1) || index + 1
    }))
    .sort((a, b) => Number(a.season || 0) - Number(b.season || 0));
  if (sourceSeasons.length) {
    return sourceSeasons.map((season, index) => {
      const seasonNumber = sourceSeasons.length === 1 && inferredSeason > 1
        ? inferredSeason
        : season.season || index + 1;
      return {
        ...season,
        season: seasonNumber,
        title: `Season ${seasonNumber}`,
        sourceTitle: show.title,
        image: show.image,
        episodes: clampSeasonEpisodes(repairEpisodeGaps(season.episodes || [], seasonNumber), show, season),
        playable: (season.episodes || []).some((episode) => getEpisodeUrl(episode) || isExternalIframeEpisode(episode) || episode.streamResolver)
      };
    });
  }

  // No real per-source seasons → this entry is one continuous anime. Never pull
  // in same-titled remakes/adaptations as extra "seasons" (Doraemon bug). Show a
  // single "Episodes" group with only this show's own episodes.
  const seasonNumber = extractSeasonNumber(show.title, 1);
  return [{
    season: seasonNumber,
    title: seasonNumber > 1 ? `Season ${seasonNumber}` : "Episodes",
    sourceTitle: show.title,
    image: show.image,
    source: show.source,
    score: show.score,
    playable: false,
    episodes: makePlaceholderEpisodes(show, seasonNumber)
  }];
}

function makePlaceholderEpisodes(show, seasonNumber) {
  const knownCount = getSeasonEpisodeLimit(show);
  if (knownCount === 0) return [];
  const count = Number.isFinite(knownCount) && knownCount > 0 ? knownCount : 12;
  // Cap high enough for long-running shounen (Naruto 220, Bleach 366,
  // One Piece 1100+) so their episode lists are never truncated.
  // These are aired episodes — playable on click (servers resolve then), so we
  // mark them resolvable rather than "Not available".
  return Array.from({ length: Math.min(count, 2000) }, (_, index) => ({
    season: seasonNumber,
    episode: index + 1,
    title: "",
    needsResolve: true,
    // Stable provenance so totals never combine across different anime IDs.
    animeId: show.anilistId ?? show.id ?? null,
    anilistId: show.anilistId ?? null,
    malId: show.malId ?? null,
    startYear: show.year ?? show.seasonYear ?? show.startDate?.year ?? null
  }));
}

function getSeasonEpisodeLimit(show = {}, season = {}) {
  const status = String(season.status || season.anilistStatus || show.anilistStatus || show.status || "").toUpperCase();
  const format = String(season.format || show.format || "").toUpperCase();
  if (format === "MOVIE") return 1;

  const latestAired = Number(
    season.latestAiredEp
    || season.latestAiredEpisode
    || show.latestAiredEp
    || show.latestAiredEpisode
    || show.latestEpisode
    || 0
  );
  const nextAiring = Number(
    season.nextAiringEp
    || season.nextAiringEpisodeNumber
    || show.nextAiringEp
    || show.nextAiringEpisodeNumber
    || 0
  );
  const displayedEpisode = Number(season.episode || show.episode || 0);
  const numericShowEpisodes = Number(show.episodes);
  const plannedTotal = Number(
    season.totalEpisodes
    || season.episodesCount
    || show.totalEpisodes
    || show.episodeCount
    || show.episodesCount
    || (Number.isFinite(numericShowEpisodes) ? numericShowEpisodes : 0)
    || 0
  );
  const isAiring = status === "RELEASING" || status === "AIRING";
  const isFuture = status === "NOT_YET_RELEASED" || status === "UPCOMING";

  // Authoritative override: if AniList still has a NEXT episode scheduled, the
  // season is mid-air — cap at the last aired episode (= nextAiring - 1) no
  // matter how the catalog spelled the status. This keeps "till today" correct
  // for every airing anime, even when the status string isn't recognized.
  if (Number.isFinite(nextAiring) && nextAiring > 1) {
    return Number.isFinite(latestAired) && latestAired > 0 ? latestAired : nextAiring - 1;
  }

  if (isFuture) return 0;
  if (isAiring) {
    if (Number.isFinite(latestAired) && latestAired > 0) return latestAired;
    if (Number.isFinite(nextAiring) && nextAiring > 1) return nextAiring - 1;
    if (Number.isFinite(displayedEpisode) && displayedEpisode > 0) return displayedEpisode;
    return 0;
  }

  if (Number.isFinite(plannedTotal) && plannedTotal > 0) return plannedTotal;
  if (Number.isFinite(latestAired) && latestAired > 0) return latestAired;
  if (Number.isFinite(displayedEpisode) && displayedEpisode > 0) return displayedEpisode;
  return null;
}

function clampSeasonEpisodes(episodes = [], show = {}, season = {}) {
  if (!Array.isArray(episodes) || !episodes.length) return [];
  const limit = getSeasonEpisodeLimit(show, season);
  if (limit === null || limit === undefined) return episodes;
  if (!Number.isFinite(limit) || limit <= 0) return [];
  return episodes.filter((episode) => Number(episode.episode || episode.number || 0) <= limit);
}

function validateEpisodeIntegrity(show) {
  const episodes = (show.seasons?.length ? show.seasons.flatMap((season) => season.episodes || []) : show.episodes || [])
    .filter(Boolean);
  const numbersBySeason = new Map();
  episodes.forEach((episode) => {
    const season = Number(episode.season || 1);
    if (!numbersBySeason.has(season)) numbersBySeason.set(season, []);
    const number = Number(episode.episode || episode.number);
    if (Number.isFinite(number) && number > 0) numbersBySeason.get(season).push(number);
  });
  const missing = [];
  numbersBySeason.forEach((numbers, season) => {
    const sorted = [...new Set(numbers)].sort((a, b) => a - b);
    for (let number = 1; number <= (sorted.at(-1) || 0); number += 1) {
      if (!sorted.includes(number)) missing.push({ season, episode: number });
    }
  });
  return { ok: missing.length === 0, missing, seasons: numbersBySeason.size };
}

function repairEpisodeGaps(episodes = [], seasonNumber = 1) {
  const normalizedSeason = Number(seasonNumber) || 1;
  const byNumber = new Map();
  episodes.filter(Boolean).forEach((episode) => {
    const number = Number(episode.episode || episode.number);
    if (!Number.isFinite(number) || number < 1) return;
    const existing = byNumber.get(number);
    byNumber.set(number, {
      ...existing,
      ...episode,
      videoUrl: getEpisodeUrl(episode) || existing?.videoUrl || "",
      sourceOptions: normalizeEpisodeSourceOptions({
        ...existing,
        ...episode,
        sourceOptions: [
          ...(existing?.sourceOptions || []),
          ...(episode.sourceOptions || [])
        ]
      }),
      episode: number,
      season: normalizedSeason
    });
  });
  const maxEpisode = Math.max(0, ...byNumber.keys());
  if (!maxEpisode) return [];
  return Array.from({ length: maxEpisode }, (_, index) => {
    const episode = index + 1;
    if (!byNumber.has(episode)) console.warn(`Missing episode ${episode} detected`);
    return byNumber.get(episode) || {
      id: `missing-s${seasonNumber}-e${episode}`,
      title: "Not available yet",
      season: normalizedSeason,
      episode,
      locked: true,
      missing: true,
      unavailable: true,
      server: "Missing from source"
    };
  });
}

async function playActiveShow(options = {}) {
  const allowSourceLookup = options.allowSourceLookup !== false;
  const show = state.activeShow;
  const frame = document.querySelector("#videoFrame");
  if (!show || !frame) return;
  if (!state.activeEpisode) {
    const seasons = getDetailSeasons(show);
    const seasonIndex = Math.max(0, Math.min(state.activeSeasonIndex || 0, seasons.length - 1));
    const season = seasons[seasonIndex] || seasons[0];
    const episodeIndex = (season?.episodes || []).findIndex((episode) => !episode.locked);
    const resolvedEpisodeIndex = episodeIndex >= 0 ? episodeIndex : 0;
    if (season?.episodes?.[resolvedEpisodeIndex]) {
      state.activeSeasonIndex = seasonIndex;
      state.activeDetailTab = "episodes";
      state.activeEpisode = {
        season,
        episode: season.episodes[resolvedEpisodeIndex],
        seasonIndex,
        episodeIndex: resolvedEpisodeIndex
      };
      state.activeEpisodeUrl = getEpisodeUrl(state.activeEpisode.episode);
      renderEpisodeList(show);
    }
  }
  const activeEpisode = state.activeEpisode?.episode;
  const seasonNumber = state.activeEpisode?.season?.season || state.activeSeasonIndex + 1 || activeEpisode?.season || 1;
  // A playable source already chosen/available? Then the background server sweep
  // must NOT re-render the player when it finishes — re-rendering reloads the
  // iframe and resets playback, which is why a video used to need a 2nd click.
  const alreadyPlayable = Boolean(
    activeEpisode
    && (getSelectedEpisodeSource(activeEpisode)
        || getEpisodePlaybackSources(activeEpisode).length
        || getPlayableUrl(show))
  );
  if (activeEpisode) {
    // Clean, minimal loading state (no "- loading" / "Opening the episode…" tags).
    renderPlayerPopupMessage(frame, currentEpisodeLabel(), "");
  }
  if (
    allowSourceLookup
    && activeEpisode
    && (
      activeEpisode.sourceOptionsChecked !== playbackLookupKey(show, activeEpisode, seasonNumber)
      || !activeEpisode.tioAnimeSourcesChecked
      || !activeEpisode.animeAv1SourcesChecked
    )
  ) {
    // Only auto-replay (re-render to start playback) when nothing is playable yet.
    schedulePlaybackSourceOptions(show, activeEpisode, seasonNumber, { autoReplay: !alreadyPlayable });
    if (!getEpisodePlaybackSources(activeEpisode).length) {
      await playbackLookupWithTimeout("AniPub quick start", attachAniPubFallback(show, activeEpisode), 1500);
    }
    renderEpisodeList(show);
  }
  let source = getSelectedEpisodeSource(activeEpisode);
  let url = "";
  if (!source || source.type === "direct") {
    url = source?.videoUrl || getPlayableUrl(show);
  }

  if (!url && source?.type === "iframe" && source.externalUrl) {
    renderEmbeddedAniPubPlayer(show, source.externalUrl);
    return;
  }

  const resolver = source?.streamResolver || activeEpisode?.streamResolver;
  if (!url && resolver) {
    activeEpisode.streamResolver = resolver;
    renderPlayerPopupMessage(
      frame,
      `Loading ${source?.label || "episode"}...`,
      `Checking ${activeEpisode.server || "the addon"} for a direct stream or external playback option.`
    );
    url = await resolveEpisodeStream(activeEpisode);
    source = getSelectedEpisodeSource(activeEpisode);
  }

  if (!url && source?.type === "iframe" && source.externalUrl) {
    renderEmbeddedAniPubPlayer(show, source.externalUrl);
    return;
  }

  if (!url && isExternalIframeEpisode(activeEpisode)) {
    renderEmbeddedAniPubPlayer(show, activeEpisode.externalUrl);
    return;
  }

  if (!url && activeEpisode && activeEpisode.sourceOptionsPending) {
    renderPlayerPopupMessage(
      frame,
      "Checking servers...",
      "Finding every available playback source for this episode."
    );
    return;
  }

  if (!url) {
    const selected = state.activeEpisode;
    const label = selected
      ? `${selected.season?.title || `Season ${selected.seasonIndex + 1}`} Episode ${selected.episode?.episode || selected.episodeIndex + 1}`
      : getShowTitle(show) || "Selected episode";
    renderPlayerPopupMessage(
      frame,
      label,
      isEpisodeUnavailable(activeEpisode) ? episodeAvailabilityText(activeEpisode) : "No playable server was found for this episode yet. Check your connection or try another source.",
      ""
    );
    frame.querySelector(".episode-video-empty")?.insertAdjacentHTML(
      "beforeend",
      `<button class="external-play-button focusable" type="button" data-retry-episode>Retry Episode</button>`
    );
    frame.querySelector("[data-retry-episode]")?.addEventListener("click", () => playActiveShow());
    refreshFocusables();
    return;
  }

  // Android TV: route EVERY source through the native ExoPlayer. Direct streams
  // play immediately; embed hosts are resolved by the player's in-app WebView
  // stream-sniffer. In a normal browser there's no bridge, so nothing changes.
  if (window.ZenkaiNative && typeof window.ZenkaiNative.play === "function") {
    const title = getShowTitle(show) || "";
    // Build the watch-tracking context so the native player can resume from the
    // saved position and report progress back into localStorage.
    const ae = state.activeEpisode || {};
    const seasonNum = ae.season?.season || (ae.seasonIndex + 1) || (state.activeSeasonIndex + 1) || 1;
    const epNum = ae.episode?.episode || ae.episode?.number || (ae.episodeIndex + 1) || 1;
    const epKey = buildWatchKey(show, seasonNum, epNum);
    const startMs = (getResumePosition(ae.episode) || 0) * 1000;
    _nativePlayContext = {
      show, season: seasonNum, episode: epNum, key: epKey,
      episodeTitle: ae.episode?.title || "",
      thumb: episodeThumb(ae.episode || {}, ae.season || {}, show)
    };
    const tracked = typeof window.ZenkaiNative.playTracked === "function";
    if (isEmbedUrl(url)) {
      const host = (url.match(/^https?:\/\/([^/]+)/) || [])[1] || "";
      const ref = host ? `https://${host}/` : "";
      if (tracked) window.ZenkaiNative.playTracked(url, title, "embed", "{}", ref, startMs, epKey);
      else window.ZenkaiNative.play(url, title, "embed", "{}", ref);
    } else {
      const abs = new URL(proxiedStreamUrl(url), location.origin).href;
      const type = streamTypeFromUrl(abs) || streamTypeFromUrl(url) || "auto";
      if (tracked) window.ZenkaiNative.playTracked(abs, title, type, "{}", "", startMs, epKey);
      else window.ZenkaiNative.play(abs, title, type, "{}", "");
    }
    showToast("Opening native player…");
    return;
  }

  if (isEmbedUrl(url)) {
    renderExternalPlaybackOption(show, url);
  } else {
    renderDirectVideoPlayer(frame, url, activeEpisode);
  }
}

function isExternalIframeEpisode(episode) {
  return Boolean(episode?.externalUrl && (episode.externalType || "iframe") === "iframe");
}

function renderDirectVideoPlayer(frame, url, episode) {
  const tracks = normalizeSubtitleTracks(episode);
  const preferences = getLanguagePreferences();
  const preferredTrack = tracks.find((track) => normalizeLanguagePreference(track.language || track.label) === preferences.subtitles);
  const spanishTrack = preferences.subtitles === "spanish-translated"
    ? null
    : preferredTrack || tracks.find((track) => isSpanishLanguage(track.language || track.label));
  const selectedSource = getSelectedEpisodeSource(episode);
  const streamType = streamTypeFromUrl(url);
  const useApkPlayer = state.uiPreferences.playerEngine !== "native";
  if (useApkPlayer && (!state.uiPreferences.playerFit || state.uiPreferences.playerFit === "contain")) {
    saveUiPreferences({ playerFit: "cover" });
  }
  const fit = state.uiPreferences.playerFit || "cover";
  frame.innerHTML = `
    <div class="video-player-shell vidstream-player fit-${escapeHtml(fit)}" data-stream-type="${escapeHtml(streamType || "direct")}">
      <div class="vid-player-stage">
        ${useApkPlayer
          ? `<iframe id="animePlayerFrame" class="apk-video-frame" src="${escapeHtml(buildApkPlayerUrl(url))}" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="no-referrer" sandbox="allow-same-origin allow-scripts allow-forms allow-presentation" title="ZenkaiTV video player"></iframe>`
          : `<video id="animePlayer" autoplay playsinline x-webkit-airplay="allow" crossorigin="anonymous">
              ${spanishTrack ? `<track kind="subtitles" srclang="es" label="Español" src="${escapeHtml(spanishTrack.url)}" default>` : ""}
            </video>`}
        <div class="vid-loader" aria-live="polite">
          <div class="play-symbol" aria-hidden="true"></div>
          <span>Loading stream...</span>
        </div>
        ${renderVidstreamTopbar(currentEpisodeLabel())}
        <div class="translated-caption" id="translatedCaption" hidden></div>
        <div class="subtitle-status" id="subtitleStatus">${streamType ? streamType.toUpperCase() : "Direct"} stream · Spanish subtitles preferred</div>
        ${renderVidstreamControls()}
      </div>
      ${renderPlayerEpisodeActions(url)}
    </div>
  `;
  const shell = frame.querySelector(".vidstream-player");
  setPlayerCinema(shell, true, { silent: true });
  const iframe = frame.querySelector("#animePlayerFrame");
  const player = useApkPlayer
    ? createApkPlayerController(iframe, {
        onResolution: (resolution) => {
          const status = document.querySelector("#subtitleStatus");
          if (status && resolution && state.uiPreferences.metadataDetail) {
            status.textContent = `${streamType ? streamType.toUpperCase() : "Direct"} stream · ${resolution}`;
          }
        }
      })
    : frame.querySelector("#animePlayer");
  // Apply the saved default volume (factory default is 10% so it's not jarring)
  if (player) {
    const savedVol = Number(state.uiPreferences.defaultVolume ?? 0.1);
    player.volume = Math.min(1, Math.max(0, Number.isFinite(savedVol) ? savedVol : 0.1));
  }
  if (!useApkPlayer) {
    setupVideoSource(player, url).then(() => {
      const attempt = player?.play?.();
      if (attempt && typeof attempt.catch === "function") {
        attempt.catch(() => {
          // The browser blocked autoplay because the click gesture was spent
          // during async source setup — which is why playback used to need a
          // SECOND click. Recover by starting muted (always allowed), then
          // unmute on the next interaction. One click now starts the video.
          if (!player) return;
          player.muted = true;
          player.play().then(() => {
            const unmute = () => {
              player.muted = false;
              document.removeEventListener("pointerdown", unmute);
              document.removeEventListener("keydown", unmute);
            };
            document.addEventListener("pointerdown", unmute, { once: true });
            document.addEventListener("keydown", unmute, { once: true });
          }).catch(() => {
            frame.querySelector(".vid-loader")?.setAttribute("hidden", "");
            showToast("Press play to start this episode.");
          });
        });
      }
    }).catch((error) => {
      console.error("Video source setup failed", { url, error });
    });
  }
  player?.addEventListener("error", () => {
    console.error("Direct video playback failed", { url, episode });
    if (isExternalIframeEpisode(episode)) {
      renderEmbeddedAniPubPlayer(state.activeShow || { title: "AniPub" }, episode.externalUrl);
      return;
    }
    frame.innerHTML = `
      <div class="episode-video-empty">
        <div class="play-symbol" aria-hidden="true"></div>
        <strong>Playback failed</strong>
        <p>The direct video stream could not play. If an AniPub embed is available, ZenkaiTV will use the embedded player; otherwise retry this episode.</p>
        <button class="external-play-button focusable" type="button" data-retry-episode>Retry Episode</button>
      </div>
    `;
    frame.querySelector("[data-retry-episode]")?.addEventListener("click", () => playActiveShow());
    refreshFocusables();
  });
  const resumeAt = getResumePosition(episode);
  if (player && resumeAt) {
    player.addEventListener("loadedmetadata", () => {
      if (resumeAt < (player.duration || resumeAt + 1) - 5) player.currentTime = resumeAt;
    }, { once: true });
  }
  // Progress is saved ~every 10s while playing (self-throttled), and forced on
  // pause / exit / completion so the resume point is never lost.
  player?.addEventListener("timeupdate", () => saveWatchProgress(player, episode));
  player?.addEventListener("pause", () => saveWatchProgress(player, episode, { force: true }));
  if (player) _activeProgressPlayer = { player, episode };
  player?.addEventListener("ended", () => {
    saveWatchProgress(player, episode, { force: true, completed: true });
    const nav = getEpisodeNavigationTargets();
    if (!nav.next) {
      showToast("You've reached the last episode.");
      return;
    }
    const seasons = getDetailSeasons(state.activeShow || {});
    const nextSeason = seasons[nav.next.seasonIndex];
    const nextEpisode = nextSeason?.episodes?.[nav.next.episodeIndex];
    if (!nextSeason || !nextEpisode) return;
    state.activeSeasonIndex = nav.next.seasonIndex;
    state.activeDetailTab = "episodes";
    state.activeEpisode = {
      season: nextSeason,
      episode: nextEpisode,
      seasonIndex: nav.next.seasonIndex,
      episodeIndex: nav.next.episodeIndex
    };
    state.activeEpisodeUrl = getEpisodeUrl(nextEpisode);
    renderEpisodeList(state.activeShow);
    playActiveShow();
  });
  setupSpanishSubtitles(episode, tracks, player);
  wireVidstreamControls(frame, player, episode, url, tracks);
  wirePlayerChrome(frame);
  refreshFocusables();
}

function playEpisodeByPosition(seasonIndex, episodeIndex) {
  const seasons = getDetailSeasons(state.activeShow || {});
  const season = seasons[seasonIndex];
  const episode = season?.episodes?.[episodeIndex];
  if (!season || !episode) return;
  const wasCinema = document.body.classList.contains("player-cinema-open");
  state.activeSeasonIndex = seasonIndex;
  state.activeDetailTab = "episodes";
  state.activeEpisode = { season, episode, seasonIndex, episodeIndex };
  state.activeEpisodeUrl = getEpisodeUrl(episode);
  renderEpisodeList(state.activeShow);
  playActiveShow().then(() => {
    if (wasCinema) {
      const shell = document.querySelector(".vidstream-player");
      if (shell) setPlayerCinema(shell, true, { silent: true });
    }
  });
}

async function setupSpanishSubtitles(episode, tracks = [], media = null) {
  const status = document.querySelector("#subtitleStatus");
  const video = media || document.querySelector("#animePlayer");
  const caption = document.querySelector("#translatedCaption");
  if (!video || !caption || !status) return;
  const preferences = getLanguagePreferences();
  if (video.textTracks) {
    Array.from(video.textTracks || []).forEach((track) => {
      const language = normalizeLanguagePreference(track.language || track.label);
      track.mode = preferences.subtitles !== "none" && language === preferences.subtitles ? "showing" : "disabled";
    });
  }
  caption.hidden = true;
  caption.textContent = "";
  if (preferences.subtitles === "none") {
    status.textContent = "Subtitles off";
    return;
  }
  if (!tracks.length) {
    status.textContent = "No subtitle track connected";
    return;
  }

  const spanishTrack = tracks.find((track) => isSpanishLanguage(track.language || track.label));
  if (spanishTrack && preferences.subtitles !== "spanish-translated" && !video.isApkPlayer) {
    status.textContent = "Spanish subtitles available";
    return;
  }

  if (!state.uiPreferences.subtitleTranslation && preferences.subtitles === "spanish-translated") {
    status.textContent = "Subtitle translation disabled in Settings";
    return;
  }

  const sourceTrack = tracks.find((track) => normalizeLanguagePreference(track.language || track.label) === "english") || tracks[0];
  status.textContent = `Translating ${languageName(sourceTrack.language) || "available"} subtitles to Spanish...`;
  try {
    const sourceText = await fetchSubtitleText(sourceTrack.url);
    const cues = parseSubtitleCues(sourceText);
    if (!cues.length) {
      status.textContent = "Subtitle file could not be read";
      return;
    }
    status.textContent = "Spanish live translation enabled";
    const translatedCueCache = new Map();
    video.addEventListener("timeupdate", async () => {
      const cue = cues.find((item) => video.currentTime >= item.start && video.currentTime <= item.end);
      if (!cue) {
        caption.hidden = true;
        caption.textContent = "";
        return;
      }
      caption.hidden = false;
      if (translatedCueCache.has(cue.key)) {
        caption.textContent = translatedCueCache.get(cue.key);
        return;
      }
      caption.textContent = cue.text;
      const translated = await translateSubtitleLine(cue.text, sourceTrack.language || "en");
      translatedCueCache.set(cue.key, translated || cue.text);
      if (video.currentTime >= cue.start && video.currentTime <= cue.end) {
        caption.textContent = translated || cue.text;
      }
    });
  } catch (error) {
    status.textContent = "Subtitle translation unavailable";
  }
}

async function fetchSubtitleText(url) {
  const resolved = resolveSourceEndpoint(url);
  try {
    const response = await fetchWithTimeout(resolved, { cache: "force-cache" }, 5000);
    if (response.ok) return response.text();
  } catch (error) {
    if (location.protocol === "file:") throw error;
  }
  const proxyUrl = `${LOCAL_SOURCE_PROXY_ENDPOINT}?url=${encodeURIComponent(resolved)}`;
  const proxied = await fetchWithTimeout(proxyUrl, { cache: "force-cache" }, 8000);
  if (!proxied.ok) throw new Error("Subtitle unavailable");
  return proxied.text();
}

function parseSubtitleCues(text) {
  const blocks = String(text || "")
    .replace(/^WEBVTT[^\n]*\n+/i, "")
    .split(/\n\s*\n/g);
  return blocks.map((block, index) => {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) return null;
    const [startRaw, endRaw] = lines[timingIndex].split("-->").map((part) => part.trim().split(/\s+/)[0]);
    const textLines = lines.slice(timingIndex + 1)
      .map((line) => line.replace(/<[^>]+>/g, ""))
      .filter(Boolean);
    return {
      key: `${index}-${startRaw}`,
      start: parseSubtitleTime(startRaw),
      end: parseSubtitleTime(endRaw),
      text: textLines.join(" ")
    };
  }).filter((cue) => cue && cue.text && Number.isFinite(cue.start) && Number.isFinite(cue.end));
}

function parseSubtitleTime(value) {
  const parts = String(value || "").replace(",", ".").split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(value);
}

async function translateSubtitleLine(text, from = "en") {
  const cacheKey = `${SUBTITLE_TRANSLATION_CACHE_PREFIX}${simpleHash(`${from}:es:${text}`)}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) return cached;
  const response = await fetchWithTimeout(TRANSLATE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, from: from || "en", to: "es" })
  }, 8000);
  if (!response.ok) return text;
  const payload = await response.json();
  const translated = payload.translatedText || text;
  localStorage.setItem(cacheKey, translated);
  return translated;
}

// isSpanishLanguage, languageName, simpleHash are defined in js/utils.js




async function resolveEpisodeStream(episode) {
  const endpoint = withAnime1vApiKey(episode?.streamResolver?.endpoint || "");
  if (!endpoint) return "";
  try {
    const response = await fetch(endpoint, { cache: "no-store" });
    if (!response.ok) return "";
    const payload = await response.json();
    const url = pickPlayableUrl(payload);
    const subtitles = normalizeSubtitleTracks(payload);
    if (subtitles.length) episode.subtitles = subtitles;
    if (payload.availableAudio?.length) episode.availableAudio = payload.availableAudio;
    if (payload.availableSubs?.length) episode.availableSubs = payload.availableSubs;
    if (payload.defaultAudio) episode.defaultAudio = payload.defaultAudio;
    if (payload.defaultSubs || payload.defaultSubtitles) episode.defaultSubs = payload.defaultSubs || payload.defaultSubtitles;
    if (payload.hasSpanishSubtitles !== undefined) episode.hasSpanishSubtitles = payload.hasSpanishSubtitles;
    if (payload.subtitleWarning) episode.subtitleWarning = payload.subtitleWarning;
    const resolvedSources = normalizeEpisodeSourceOptions({
      ...episode,
      sourceOptions: [
        ...(episode.sourceOptions || []),
        ...(Array.isArray(payload.sourceOptions) ? payload.sourceOptions : []),
        ...(Array.isArray(payload.sources) ? payload.sources : []),
        ...(Array.isArray(payload.streams) ? payload.streams : []),
        ...(Array.isArray(payload.files) ? payload.files : [])
      ]
    });
    if (resolvedSources.length) episode.sourceOptions = resolvedSources;
    if (!url && payload.externalUrl) {
      episode.externalUrl = payload.externalUrl;
      episode.externalType = payload.externalType || "iframe";
      episode.locked = false;
      return "";
    }
    if (!url) return "";
    episode.videoUrl = url;
    episode.locked = false;
    state.activeEpisodeUrl = url;
    return url;
  } catch (error) {
    return "";
  }
}

function isEmbedUrl(url) {
  return /youtube\.com\/embed|player\.vimeo\.com|\/embed\//i.test(url);
}

function renderExternalPlaybackOption(show, externalUrl) {
  renderEmbeddedAniPubPlayer(show, externalUrl);
}

function renderEmbeddedAniPubPlayer(show, externalUrl) {
  const frame = document.querySelector("#videoFrame");
  const selected = state.activeEpisode;
  const episode = selected?.episode || {};
  const selectedSource = selected ? getSelectedEpisodeSource(episode) : null;
  const label = selected
    ? `${selected.season?.title || `Season ${selected.seasonIndex + 1}`} Episode ${selected.episode?.episode || selected.episodeIndex + 1}`
    : getShowTitle(show);
  frame.innerHTML = `
    <div class="embedded-player-container anipub-embedded vidstream-player is-iframe">
      <div class="vid-player-stage iframe-wrapper">
        <iframe
          id="anipubEmbeddedPlayer"
          class="embedded-iframe"
          src="${escapeHtml(externalUrl)}"
          frameborder="0"
          allowfullscreen
          allow="autoplay; fullscreen; picture-in-picture; encrypted-media; web-share"
          referrerpolicy="no-referrer"
          sandbox="allow-same-origin allow-scripts allow-forms allow-presentation"
        ></iframe>
        ${renderVidstreamTopbar(label)}
      </div>
      ${renderPlayerEpisodeActions("")}
    </div>
  `;

  const iframe = frame.querySelector("#anipubEmbeddedPlayer");
  const shell = frame.querySelector(".vidstream-player");

  document.body.classList.add("has-embedded-player");
  setPlayerCinema(shell, true, { silent: true });
  frame.querySelector("[data-player-exit]")?.addEventListener("click", exitPlayerToSources);
  frame.querySelector("[data-player-back]")?.addEventListener("click", () => showEpisodeListTab());

  window.setTimeout(() => {
    const latest = getLanguagePreferences();
    applyAniPubPreferences(iframe, latest.audio, latest.subtitles);
  }, 1500);

  wirePlayerChrome(frame);
  refreshFocusables();
}

async function prepareIframeCast(frame) {
  const wrapper = frame?.querySelector(".iframe-wrapper");
  const iframe = frame?.querySelector("#anipubEmbeddedPlayer");
  if (!wrapper || !iframe) {
    showToast("Open the embedded player first, then use Cast.");
    return;
  }
  wrapper.querySelector(".iframe-cast-guide")?.remove();
  const guide = document.createElement("div");
  guide.className = "iframe-cast-guide";
  guide.innerHTML = `
    <div class="iframe-cast-icon" aria-hidden="true">▣</div>
    <div>
      <strong>Cast from this player</strong>
      <p>Use the Cast or fullscreen button inside the video controls when this server provides it.</p>
    </div>
    <button class="focusable" type="button" data-iframe-fullscreen>Fullscreen</button>
    <button class="focusable" type="button" data-iframe-guide-close>Done</button>
  `;
  wrapper.appendChild(guide);
  guide.querySelector("[data-iframe-fullscreen]")?.addEventListener("click", async () => {
    try {
      if (wrapper.requestFullscreen) await wrapper.requestFullscreen();
      showToast("Fullscreen ready. Use the player's Cast button if it appears.");
    } catch (error) {
      showToast("Fullscreen is blocked by this browser. Use the iframe controls directly.");
    }
  });
  guide.querySelector("[data-iframe-guide-close]")?.addEventListener("click", () => guide.remove());
  window.setTimeout(() => guide.remove(), 9000);
  refreshFocusables();
}

function applyAniPubPreferences(iframe, audioLang, subLang) {
  if (!iframe) return;

  try {
    const url = new URL(iframe.src);
    const audioCode = audioLang === "japanese" ? "ja" : audioLang === "spanish" ? "es" : "en";
    const subCode = subLang === "spanish" || subLang === "spanish-translated" ? "es" : subLang === "english" ? "en" : "";
    const audioParams = ["audio", "audio_lang", "lang", "language", "audio_track"];
    const subParams = ["sub", "subs", "subtitle", "subtitles", "sub_lang", "subtitle_lang"];

    audioParams.forEach((param) => {
      if (url.searchParams.has(param)) url.searchParams.set(param, audioCode);
    });

    subParams.forEach((param) => {
      if (subCode && url.searchParams.has(param)) url.searchParams.set(param, subCode);
      if (!subCode && url.searchParams.has(param)) url.searchParams.delete(param);
    });

    if (!audioParams.some((param) => url.searchParams.has(param))) {
      url.searchParams.set("audio_lang", audioCode);
    }
    if (subCode && !subParams.some((param) => url.searchParams.has(param))) {
      url.searchParams.set("sub_lang", subCode);
    }

    if (url.toString() !== iframe.src) iframe.src = url.toString();
  } catch (error) {
    // Some iframe URLs cannot be parsed or modified; the native player controls still work.
  }

  try {
    iframe.contentWindow?.postMessage({
      type: "setPreferences",
      audio: audioLang,
      subtitles: subLang
    }, "*");
  } catch (error) {
    // Cross-origin players may ignore preference messages.
  }
}

function showToast(message, duration = 3000) {
  document.querySelector(".custom-toast")?.remove();
  const toast = document.createElement("div");
  toast.className = "custom-toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  window.setTimeout(() => {
    toast.classList.add("fade-out");
    window.setTimeout(() => toast.remove(), 300);
  }, duration);
}

async function castActiveEpisode() {
  const show = state.activeShow;
  const frame = document.querySelector("#videoFrame");
  const activeEpisode = state.activeEpisode?.episode;
  if (!show || !frame) return;

  const selectedSource = getSelectedEpisodeSource(activeEpisode);
  let url = selectedSource?.type === "direct" ? selectedSource.videoUrl : getPlayableUrl(show);
  const selectedIframeUrl = selectedSource?.type === "iframe" ? selectedSource.externalUrl : "";
  if (selectedIframeUrl || isExternalIframeEpisode(activeEpisode)) {
    renderEmbeddedAniPubPlayer(show, selectedIframeUrl || activeEpisode.externalUrl);
    window.setTimeout(() => prepareIframeCast(frame), 180);
    return;
  }

  if (!url && activeEpisode?.streamResolver) {
    frame.innerHTML = `
      <div class="episode-video-empty is-loading">
        <div class="play-symbol" aria-hidden="true"></div>
        <strong>Preparing Cast...</strong>
        <p>Checking this episode for a direct full-quality stream.</p>
      </div>
    `;
    url = await resolveEpisodeStream(activeEpisode);
  }

  if (!url && isExternalIframeEpisode(activeEpisode)) {
    renderEmbeddedAniPubPlayer(show, activeEpisode.externalUrl);
    window.setTimeout(() => prepareIframeCast(frame), 180);
    return;
  }

  if (!url && selectedSource?.type === "iframe" && selectedSource.externalUrl) {
    renderEmbeddedAniPubPlayer(show, selectedSource.externalUrl);
    window.setTimeout(() => prepareIframeCast(frame), 180);
    return;
  }

  if (!url || isEmbedUrl(url)) {
    renderCastMessage("No Cast Stream", "Cast needs a direct .mp4 or .m3u8 URL. This episode does not have one connected yet.");
    return;
  }

  let video = document.querySelector("#animePlayer");
  if (!video || video.getAttribute("src") !== url) {
    renderDirectVideoPlayer(frame, url, activeEpisode);
    video = document.querySelector("#animePlayer");
  }

  try {
    if (video.remote?.prompt) {
      await video.remote.prompt();
      renderCastToast("Choose your TV from the browser Cast picker.");
      return;
    }
    if (video.webkitShowPlaybackTargetPicker) {
      video.webkitShowPlaybackTargetPicker();
      renderCastToast("Choose your TV from the AirPlay picker.");
      return;
    }
    renderCastMessage("Cast Not Available", "Your current browser does not expose a Cast picker for this player. Try Chrome on PC/Android or Safari AirPlay on iPhone.");
  } catch (error) {
    renderCastMessage("Cast Cancelled", "The Cast picker closed or no TV was selected. The episode is still ready in the main player.");
  }
}

function renderCastMessage(title, message) {
  const frame = document.querySelector("#videoFrame");
  if (!frame) return;
  const poster = state.activeShow?.image || state.activeShow?.banner || "";
  frame.innerHTML = `
    <div class="episode-video-empty cast-message">
      ${poster ? `<img class="cast-mini-poster" src="${poster}" alt="">` : `<div class="play-symbol" aria-hidden="true"></div>`}
      <strong>${title}</strong>
      <p>${message}</p>
      <button class="external-play-button focusable" type="button" data-cast-play>Play Here</button>
    </div>
  `;
  frame.querySelector("[data-cast-play]")?.addEventListener("click", () => playActiveShow());
  refreshFocusables();
}

function renderCastToast(message) {
  const frame = document.querySelector("#videoFrame");
  if (!frame || frame.querySelector(".cast-toast")) return;
  const toast = document.createElement("div");
  toast.className = "cast-toast";
  toast.textContent = message;
  frame.appendChild(toast);
  window.setTimeout(() => toast.remove(), 3600);
}

function isAndroidTV() {
  const agent = navigator.userAgent || "";
  return /Android/i.test(agent) && (/TV|AFT|BRAVIA|SHIELD|MiBOX|Leanback/i.test(agent) || Math.max(screen.width, screen.height) >= 1280);
}

function openExternalPlaybackUrl(externalUrl, errorPanel) {
  console.info("Embedding external playback inside ZenkaiTV instead of opening a new window.", externalUrl);
  renderEmbeddedAniPubPlayer(state.activeShow || { title: "AniPub" }, externalUrl);
}

function showExternalOpenFailure(errorPanel) {
  if (!errorPanel) return;
  errorPanel.hidden = false;
  refreshFocusables();
}

async function copyExternalUrl(externalUrl) {
  try {
    await navigator.clipboard.writeText(externalUrl);
  } catch (error) {
    window.prompt("Copy this link", externalUrl);
  }
}

function wireOpenButtons() {
  document.querySelectorAll("[data-open-show]").forEach((button) => {
    button.onclick = () => openShow(button.dataset.openShow, {
      seasonNumber: button.dataset.openSeason,
      episodeNumber: button.dataset.openEpisode
    });
  });
}

function openCarouselShow() {
  const current = todayShows()[state.carouselIndex] || state.shows.find((show) => String(show.id) === String(carouselOpen.dataset.openShow));
  if (!current) return;
  const target = getCardTarget(current);
  openShow(current.id, {
    seasonNumber: carouselOpen.dataset.openSeason || target.seasonNumber,
    episodeNumber: carouselOpen.dataset.openEpisode || target.episodeNumber,
    // Carousel "Play" is an explicit play action — allow the source picker to open.
    playIntent: true
  });
}

function getFocusableItems() {
  // Trap remote focus inside the watch overlay while it's open, so D-pad can't
  // wander onto the cards behind it. Otherwise navigate the whole page.
  const root = (overlay && !overlay.hidden) ? overlay : document;
  return [...root.querySelectorAll(".focusable")]
    .filter((element) => !element.disabled && element.offsetParent !== null);
}

function refreshFocusables() {
  getFocusableItems().forEach((element) => element.classList.remove("is-tv-focused"));
}

function setTvFocus(element) {
  refreshFocusables();
  element?.classList.add("is-tv-focused");
}

// Focus an element for D-pad/remote use: move real focus, paint the TV ring, and
// scroll it into view (centered so rails/lists track the selection nicely).
function focusElement(element) {
  if (!element) return;
  try { element.focus({ preventScroll: true }); } catch (_) { element.focus(); }
  setTvFocus(element);
  element.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
}

// 1-D overlap of two boxes on an axis ("x" or "y"); >0 means they line up there.
function axisOverlap(a, b, axis) {
  const aStart = axis === "x" ? a.left : a.top;
  const aEnd = axis === "x" ? a.right : a.bottom;
  const bStart = axis === "x" ? b.left : b.top;
  const bEnd = axis === "x" ? b.right : b.bottom;
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

// Directional spatial navigation. Among focusables strictly in `direction`, prefer
// the one that lines up on the cross-axis (directly beside/above/below) and is
// closest along the travel axis — so grids/lists/sidebars move predictably.
function moveFocus(direction) {
  const items = getFocusableItems();
  if (!items.length) return;
  const active = document.activeElement;
  const current = items.indexOf(active);

  // Nothing focused yet → start on the first sensible on-screen control.
  if (current < 0) {
    focusElement(initialFocusTarget(items));
    return;
  }

  const r = items[current].getBoundingClientRect();
  const horizontal = direction === "left" || direction === "right";
  const crossAxis = horizontal ? "y" : "x";

  let best = null;
  let bestScore = Infinity;
  for (const el of items) {
    if (el === items[current]) continue;
    const b = el.getBoundingClientRect();
    if (!b.width && !b.height) continue;

    // "along" = distance travelled in the requested direction (must be positive).
    let along;
    if (direction === "right")      along = b.left - r.right;
    else if (direction === "left")  along = r.left - b.right;
    else if (direction === "down")  along = b.top - r.bottom;
    else                            along = r.top - b.bottom;
    // Allow slightly-overlapping neighbours (e.g. cards in the same rail) through.
    const center = horizontal
      ? (b.left + b.right) / 2 - (r.left + r.right) / 2
      : (b.top + b.bottom) / 2 - (r.top + r.bottom) / 2;
    const movingForward = direction === "right" || direction === "down";
    if (along < -2 && (movingForward ? center <= 4 : center >= -4)) continue;

    const overlap = axisOverlap(r, b, crossAxis);
    const crossDist = horizontal
      ? Math.abs((b.top + b.bottom) / 2 - (r.top + r.bottom) / 2)
      : Math.abs((b.left + b.right) / 2 - (r.left + r.right) / 2);

    // Aligned candidates (cross-axis overlap) win big; otherwise penalise the
    // off-axis drift heavily so focus never leaps diagonally across the screen.
    const travel = Math.max(0, along);
    const score = travel + (overlap > 0 ? crossDist * 0.15 : crossDist * 6 + 800);
    if (score < bestScore) { bestScore = score; best = el; }
  }

  if (best) focusElement(best);
}

// First control to focus when entering a view with the remote: prefer the active
// content area (a card/play button in the visible section) over the sidebar/brand.
function initialFocusTarget(items) {
  const inActiveSection = items.find((el) => {
    const sec = el.closest("section, .watch-panel, .source-picker");
    if (!sec) return false;
    if (sec.classList.contains("is-hidden") || sec.hidden) return false;
    const rect = el.getBoundingClientRect();
    return rect.top >= 0 && rect.top < window.innerHeight && !el.closest(".main-nav, .topbar");
  });
  return inActiveSection || items.find((el) => !el.closest(".main-nav, .brand, .topbar")) || items[0];
}

document.addEventListener("focusin", (event) => {
  if (event.target.classList?.contains("focusable")) {
    if (lastInputWasPointer) {
      event.target.classList.remove("is-tv-focused");
      return;
    }
    setTvFocus(event.target);
  }
});

document.addEventListener("pointerdown", () => {
  lastInputWasPointer = true;
});

document.querySelectorAll("[data-route]").forEach((element) => {
  element.addEventListener("click", (event) => {
    event.preventDefault();
    setRoute(element.dataset.route);
  });
});

document.querySelectorAll("[data-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach((chip) => chip.classList.toggle("is-selected", chip === button));
    render();
  });
});

document.querySelector("[data-open-first]")?.addEventListener("click", () => openShow(visibleShows()[0]?.id));
carouselOpen.addEventListener("click", (event) => {
  event.stopPropagation();
  openCarouselShow();
});
carouselStage.addEventListener("click", (event) => {
  if (event.target.closest("button")) return;
  openCarouselShow();
});
function handleSearchInput(event) {
  state.search = event.target.value.trim();
  if (searchInput && searchInput !== event.target) searchInput.value = state.search;
  if (searchInputLibrary && searchInputLibrary !== event.target) searchInputLibrary.value = state.search;
  if (searchInputTop && searchInputTop !== event.target) searchInputTop.value = state.search;
  if (searchInputAniPub && searchInputAniPub !== event.target) searchInputAniPub.value = state.search;
  // Keep every search box's custom clear (×) button in sync with its value.
  document.querySelectorAll(".search-box").forEach((box) => {
    const i = box.querySelector("input");
    const c = box.querySelector(".search-clear");
    if (i && c) c.hidden = !i.value;
  });
  render();
  // Also search AniList directly so niche titles not in the local catalog still
  // turn up (debounced; folds new matches into the catalog as openable cards).
  if (event.target !== searchInputAniPub) queueLiveSearch(state.search);
  // Only jump to the results tab when there's actually something to search for.
  // Clearing the home search (× button / deleting the text) must NOT bounce the
  // user to an empty Library — they stay on Home.
  if (state.route === "home" && state.search) {
    const goAniPub = event.target === searchInputAniPub;
    setRoute(goAniPub ? "anipub" : "library");
    // Typing on the home search switches to Library/AniPub, which hides the home
    // input and would drop focus. Re-focus the now-visible search box and put the
    // caret at the end so the user can keep typing seamlessly.
    const nextInput = goAniPub ? searchInputAniPub : searchInputLibrary;
    if (nextInput && nextInput !== event.target) {
      nextInput.focus();
      const end = nextInput.value.length;
      try { nextInput.setSelectionRange(end, end); } catch (_) {}
    }
  }
}

searchInput?.addEventListener("input", handleSearchInput);
searchInputTop?.addEventListener("input", handleSearchInput);
searchInputLibrary?.addEventListener("input", handleSearchInput);
searchInputAniPub?.addEventListener("input", handleSearchInput);

// Make the magnifying-glass icon clickable: focus its search box and, if there's
// already a query, run the search (switches to results).
document.querySelectorAll(".search-box").forEach((box) => {
  const icon = box.querySelector("span:last-child");
  const input = box.querySelector("input");
  if (!input) return;

  if (icon) {
    icon.setAttribute("role", "button");
    icon.setAttribute("aria-label", "Search");
    icon.setAttribute("tabindex", "0");
    const runSearch = () => {
      input.focus();
      if (input.value.trim()) handleSearchInput({ target: input });
    };
    icon.addEventListener("click", (event) => { event.preventDefault(); runSearch(); });
    icon.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); runSearch(); }
    });
  }

  // Cross-browser clear (×) button — Firefox has no ::-webkit-search-cancel-button.
  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "search-clear";
  clearBtn.setAttribute("aria-label", "Clear search");
  clearBtn.textContent = "✕";
  clearBtn.hidden = !input.value;
  clearBtn.addEventListener("click", (event) => {
    event.preventDefault();
    input.value = "";
    handleSearchInput({ target: input });
    input.focus();
  });
  input.insertAdjacentElement("afterend", clearBtn);
  const syncClear = () => { clearBtn.hidden = !input.value; };
  input.addEventListener("input", syncClear);
  input.addEventListener("search", syncClear); // Esc / native clear
});

sidebarToggle?.addEventListener("click", toggleSidebar);

closeOverlay.addEventListener("click", closeShow);
favoriteButton.addEventListener("click", toggleFavorite);
fakePlay.addEventListener("click", () => {
  const ep = state.activeEpisode;
  const frame = document.querySelector("#videoFrame");
  const show = state.activeShow;
  if (frame && show && ep) {
    // If already in cinema mode, just play
    if (document.body.classList.contains("player-cinema-open")) {
      playActiveShow();
      return;
    }
    stopActivePlayback();
    const background = show.banner || show.image || "";
    frame.style.setProperty("--watch-bg", background ? `url("${background}")` : "none");
    schedulePlaybackSourceOptions(show, ep.episode, ep.season?.season || ep.seasonIndex + 1 || 1);
    renderSourcePickerIn(frame);
  } else if (show) {
    // No episode selected — select the first one
    const seasons = getDetailSeasons(show);
    const firstEpisode = seasons[0]?.episodes?.[0];
    if (firstEpisode) selectEpisodeByPosition(0, 0);
  }
});
castButton?.addEventListener("click", () => {
  castActiveEpisode();
});

trailerButton?.addEventListener("click", () => {
  const url = trailerButton.dataset.trailerUrl;
  if (!url) return;
  // Android WebView routes this through onCreateWindow → external app/browser.
  window.open(url, "_blank", "noopener");
});

shareButton?.addEventListener("click", async () => {
  const show = state.activeShow;
  if (!show) return;
  const title = getShowTitle(show) || show.title || "ZenkaiTV";
  const shareData = { title, text: `Watch ${title} on ZenkaiTV`, url: "https://zenkaitv.com" };
  try {
    if (navigator.share) {
      await navigator.share(shareData);
    } else if (navigator.clipboard) {
      await navigator.clipboard.writeText(shareData.url);
      showToast("Link copied to clipboard");
    } else {
      showToast("Sharing isn't available here");
    }
  } catch (error) {
    if (error?.name !== "AbortError") console.warn("Share failed:", error);
  }
});

// Global fullscreen toggle (top-right, every screen). Reuses the player's
// document-level fullscreen helper; the icon swaps via the body class below.
const fullscreenToggle = document.querySelector("#fullscreenToggle");
fullscreenToggle?.addEventListener("click", toggleNativeFullscreen);
["fullscreenchange", "webkitfullscreenchange"].forEach((evt) =>
  document.addEventListener(evt, () => {
    const active = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
    document.body.classList.toggle("is-fullscreen", active);
    if (fullscreenToggle) {
      fullscreenToggle.setAttribute("aria-label", active ? "Exit fullscreen" : "Toggle fullscreen");
      fullscreenToggle.dataset.tip = active ? "Exit fullscreen" : "Fullscreen";
      // Replay the pulse animation on each toggle.
      fullscreenToggle.classList.remove("fs-pulse");
      void fullscreenToggle.offsetWidth; // reflow so the animation restarts
      fullscreenToggle.classList.add("fs-pulse");
      window.setTimeout(() => fullscreenToggle.classList.remove("fs-pulse"), 480);
    }
  })
);

// Flush the current playback position when the tab is hidden or the app closes,
// so an abrupt exit (TV home button, tab close) still records where you were.
["pagehide", "visibilitychange"].forEach((evt) =>
  window.addEventListener(evt, () => {
    if (evt === "visibilitychange" && document.visibilityState !== "hidden") return;
    const ctx = _activeProgressPlayer;
    if (ctx?.player) saveWatchProgress(ctx.player, ctx.episode, { force: true });
  })
);

// TV remote: make search boxes read-only by default (Android app only) so spatial
// focus can pass over them without popping the on-screen keyboard. OK enters edit
// mode (see keydown); leaving the field re-locks it. Desktop is untouched.
function setupTvTextInputs() {
  if (!window.ZenkaiNative) return;
  // The TV WebView runs on a weak GPU (often at 4K). Flag it so the stylesheet can
  // drop expensive backdrop-filter blurs and the continuous backdrop zoom, which
  // can OOM/crash the renderer.
  document.body.classList.add("is-tv");
  document.querySelectorAll(".search-box input").forEach((input) => {
    if (input.dataset.tvLocked) return;
    input.dataset.tvLocked = "1";
    input.setAttribute("readonly", "readonly");
    input.addEventListener("blur", () => input.setAttribute("readonly", "readonly"));
  });
}

document.addEventListener("keydown", (event) => {
  lastInputWasPointer = false;
  const keyMap = {
    ArrowRight: "right",
    ArrowLeft: "left",
    ArrowDown: "down",
    ArrowUp: "up"
  };

  // TV: search boxes are read-only so the remote can pass over them without
  // popping the on-screen keyboard. OK enters edit mode (keyboard); the field
  // re-locks on blur (Back closes the keyboard and exits editing).
  const ae = document.activeElement;
  if (ae && ae.matches?.(".search-box input[readonly]") && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    ae.removeAttribute("readonly");
    ae.focus();
    return;
  }
  // Don't hijack arrows for spatial navigation while actually typing in a field.
  const editingText = !!ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA") && !ae.readOnly;

  // Hero carousel: when the stage is focused (Android TV D-pad / arrow keys),
  // Left/Right cycle slides instead of moving spatial focus. Up/Down still move
  // focus out of the carousel as usual.
  if ((event.key === "ArrowLeft" || event.key === "ArrowRight") &&
      state.route === "home" && overlay.hidden &&
      document.activeElement === carouselStage) {
    event.preventDefault();
    moveCarousel(event.key === "ArrowRight" ? 1 : -1);
    return;
  }

  if (keyMap[event.key] && !editingText) {
    event.preventDefault();
    moveFocus(keyMap[event.key]);
  }

  if ((event.key === "Enter" || event.key === " ") && document.activeElement === carouselStage) {
    event.preventDefault();
    openCarouselShow();
  }

  if (event.key === "Escape" || event.key === "Backspace") {
    if (!overlay.hidden) {
      event.preventDefault();
      closeShow();
    }
  }

  if ((event.key === "f" || event.key === "F") && !event.ctrlKey && !event.metaKey && !event.altKey) {
    const cinema = document.querySelector(".vidstream-player.is-cinema");
    if (cinema && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
      event.preventDefault();
      toggleNativeFullscreen(cinema);
    }
  }
});

if ("scrollRestoration" in history) {
  history.scrollRestoration = "manual";
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
    navigator.serviceWorker.ready.then((registration) => {
      registration.sync?.register("animetv-update-check").catch(() => {});
    }).catch(() => {});
  });
}

render();
// Deep-link support: open the route named in the URL hash (e.g. #settings).
const VALID_ROUTES = ["home", "library", "schedule", "favorites", "settings", "anipub", "sources"];
const _hashRoute = (location.hash || "").replace(/^#/, "");
setRoute(VALID_ROUTES.includes(_hashRoute) ? _hashRoute : "home");
window.addEventListener("hashchange", () => {
  const r = (location.hash || "").replace(/^#/, "");
  if (VALID_ROUTES.includes(r) && r !== state.route) setRoute(r);
});
applySidebarState();
applyUiPreferences();
setupTvTextInputs();
renderSources();
loadAnimeSources();
restartCarouselTimer();
if (window.UpdateManager) {
  window.animeTVUpdater = new window.UpdateManager({ currentVersion: "1.3.0" });
  window.animeTVUpdater.start();
}
window.setTimeout(hideAppLoader, 850);
// Best-effort background refresh of stale full-site crawls (if a crawler is wired).
window.setTimeout(() => { try { checkSourceRefreshes(); } catch { /* ignore */ } }, 9000);
