// Constants, translations, and pure utilities are loaded from:
// js/constants.js → js/translations.js → js/utils.js → js/normalize.js

installAdBlockGuards();

function installAdBlockGuards() {
  const blockedOpen = (url = "") => {
    console.warn("AnimeTV blocked a popup/ad window.", url);
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
  description:
    "Demo title shown when AniList or Jikan is offline. The app is ready for your own local or uploaded video URL.",
  videoUrl: ""
}));

const state = {
  route: "home",
  filter: "all",
  search: "",
  activeShow: null,
  activeEpisodeUrl: "",
  activeEpisode: null,
  preferredSource: localStorage.getItem("animetv-preferred-playback-source") || "auto",
  activeDetailTab: "anime",
  activeSeasonIndex: 0,
  carouselIndex: 0,
  shows: [],
  isLoadingCatalog: true,
  addonSections: [],
  addonVisible: {},
  anipubLoading: false,
  anipubFallbackCache: readAniPubFallbackCache(),
  localSources: [],
  customSources: JSON.parse(localStorage.getItem("animetv-custom-sources") || "[]"),
  sidebarCollapsed: localStorage.getItem("animetv-sidebar-collapsed") === "true",
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
const castButton = document.querySelector("#castButton");
const episodeList = document.querySelector("#episodeList");
const sections = document.querySelectorAll("[data-section]");
const carouselPoster = document.querySelector("#carouselPoster");
const carouselBackdrop = document.querySelector("#carouselBackdrop");
const carouselTitle = document.querySelector("#carouselTitle");
const carouselText = document.querySelector("#carouselText");
const carouselMeta = document.querySelector("#carouselMeta");
const carouselOpen = document.querySelector("#carouselOpen");
const carouselStage = document.querySelector("#carouselStage");
const carouselPosterWrap = document.querySelector("#carouselPosterWrap");
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
    const icon = sidebarToggle.querySelector("span");
    if (icon) icon.textContent = state.sidebarCollapsed ? "›" : "‹";
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

function toggleSidebar() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  localStorage.setItem("animetv-sidebar-collapsed", String(state.sidebarCollapsed));
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
  if (favoriteButton && state.activeShow) favoriteButton.textContent = state.favorites.includes(state.activeShow.id) ? t("favorited") : t("favorite");
  if (favoriteButton && !state.activeShow) favoriteButton.textContent = t("favorite");
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
  setSourceStatus("Loading AnimeTV metadata API...");
  render();
  hideAppLoader();

  const cachedCatalog = readResponseCache("main-catalog");
  if (cachedCatalog?.length) {
    state.shows = cachedCatalog;
    state.isLoadingCatalog = false;
    state.carouselIndex = 0;
    setSourceStatus(catalogStatusLabel("Cached AnimeTV catalog", cachedCatalog));
    render();
  }

  const serverCatalog = await timedRequest("AnimeTV metadata API", () => fetchLocalMetadataCatalog()).catch(() => []);
  if (serverCatalog.length) {
    state.shows = mergeShows(serverCatalog);
    state.isLoadingCatalog = false;
    state.carouselIndex = 0;
    state.apiStatus.metadata = "Online";
    state.apiStatus.direct = "Standby";
    writeResponseCache("main-catalog", state.shows);
    setSourceStatus(catalogStatusLabel("AnimeTV API", state.shows));
    render();
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
  } else {
    state.apiStatus.direct = "Offline";
    if (!state.shows.length) state.shows = fallbackShows;
    state.isLoadingCatalog = false;
    setSourceStatus("Offline catalog");
  }

  render();
  scheduleExternalSourcesLoad();
}

function scheduleExternalSourcesLoad() {
  const run = () => loadExternalSources();
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(run, { timeout: 1800 });
    return;
  }
  window.setTimeout(run, 650);
}

async function loadExternalSources() {
  try {
    const response = await fetch("./sources.json", { cache: "no-store" });
    if (!response.ok) throw new Error("sources.json unavailable");
    const config = await response.json();
    const sources = [...(Array.isArray(config.sources) ? config.sources : []), ...state.customSources];
    state.localSources = sources.map(applySourceOverride).filter((source) => !source.deleted);
    renderSources();

    const enabledSources = state.localSources.filter((source) => source.enabled && source.endpoint && source.id !== "anipub-catalog");
    const sourceResults = await Promise.allSettled(enabledSources.map(async (source) => {
      const catalog = await timedRequest(`External source ${source.name || source.id}`, () => fetchExternalCatalogData(source));
      return { source, catalog };
    }));
    const loaded = [];
    const addonSections = [];
    sourceResults.forEach((result, index) => {
      const source = enabledSources[index];
      try {
        if (result.status === "rejected") throw result.reason;
        const { catalog } = result.value;
        const items = catalog.items;
        const isAniPubCatalog = source.id === "anipub-catalog";
        if (!isAniPubCatalog) loaded.push(...items);
        if (items.length) {
          addonSections.push({
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
          });
        }
        markSourceStatus(source.name, items.length ? `${items.length}${catalog.totalResults ? ` of ${catalog.totalResults}` : ""} titles` : "Connected, no playable items");
      } catch (error) {
        markSourceStatus(source.name, "Server offline or wrong URL");
      }
    });
    state.addonSections = addonSections;

    if (loaded.length || addonSections.length) {
      if (loaded.length) state.shows = mergeShows([...state.shows, ...loaded]);
      const addonCount = addonSections.reduce((total, section) => total + (section.items?.length || 0), 0);
      state.apiStatus.local = loaded.length
        ? `${loaded.length} local titles`
        : `${addonCount} addon titles`;
      setSourceStatus(catalogStatusLabel("AniList + Jikan + Local", state.shows));
      render();
    } else {
      state.apiStatus.local = enabledSources.length ? "No local titles loaded" : "No enabled local sources";
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
  if (!response.ok) throw new Error("AnimeTV metadata API unavailable");
  const payload = await response.json();
  const rawItems = Array.isArray(payload)
    ? payload
    : payload.items || payload.results || payload.anime || payload.catalog || payload.data || [];
  const source = { id: "animetv-api", name: payload.source || "AnimeTV API" };
  return rawItems.map((item, index) => normalizeExternalShow(item, source, index)).filter(Boolean);
}

async function fetchExternalCatalog(source) {
  const catalog = await fetchExternalCatalogData(source);
  return catalog.items;
}

async function fetchExternalCatalogData(source, page = null) {
  const cacheKey = `external:${source.id || source.name}:${page || getSourcePage(source) || 1}`;
  const cached = readResponseCache(cacheKey);
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
  writeResponseCache(cacheKey, catalog);
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

function addCustomSource() {
  const endpoint = window.prompt("Paste a catalog/addon URL. It can be local or online HTTPS.");
  if (!endpoint) return;
  const normalizedEndpoint = normalizeSourceUrl(endpoint);
  if (!normalizedEndpoint) {
    window.alert("Please use a valid http:// or https:// catalog/addon URL.");
    return;
  }
  const isOnline = isOnlineSource(normalizedEndpoint);
  const name = window.prompt("Name for this source", isOnline ? "Online Anime Addon" : "My Anime Addon") || (isOnline ? "Online Anime Addon" : "My Anime Addon");
  const id = `custom-${Date.now()}`;
  const source = {
    id,
    name,
    enabled: true,
    custom: true,
    type: isOnline ? "online-addon" : "local-addon",
    endpoint: normalizedEndpoint,
    description: isOnline
      ? "Online addon added from AnimeTV. It should return normalized catalog JSON from a source you are allowed to use."
      : "Local addon added from AnimeTV. It should return normalized catalog JSON."
  };
  state.customSources = [...state.customSources, source];
  saveCustomSources();
  saveSourceOverride(id, { enabled: true });
  state.localSources = [...state.localSources, applySourceOverride(source)];
  renderSources();
  loadExternalSources();
}

// normalizeSourceUrl and isOnlineSource are defined in js/utils.js

function removeSource(sourceId) {
  const source = state.localSources.find((item) => item.id === sourceId);
  if (!source) return;
  const confirmed = window.confirm(`Remove "${source.name || "this source"}" from AnimeTV?`);
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
  const status = document.querySelector("#sourceStatus");
  if (status) status.textContent = message;
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

function matchesShowSearch(show) {
  if (!state.search) return true;
  const query = state.search.toLowerCase();
  return [
    show.title,
    show.source,
    show.genre,
    ...(show.genres || []),
    ...(show.aliases || [])
  ].some((value) => String(value || "").toLowerCase().includes(query));
}

function todayShows() {
  const today = new Date().toLocaleDateString([], { weekday: "short" }).toLowerCase();
  const scheduled = state.shows.filter((show) => show.day?.toLowerCase().startsWith(today));
  const withBanners = scheduled.filter((show) => show.banner);
  if (withBanners.length) return sortCarouselQuality(withBanners);
  const anyBanners = state.shows.filter((show) => show.banner);
  if (anyBanners.length) return sortCarouselQuality(anyBanners).slice(0, 16);
  return sortCarouselQuality(scheduled.length ? scheduled : state.shows.slice(0, 10));
}


function renderCarousel() {
  const items = todayShows();
  if (!items.length) {
    carouselPosterWrap.innerHTML = `<div class="carousel-poster carousel-poster-skeleton" aria-hidden="true"></div>`;
    carouselBackdrop.classList.remove("has-banner", "is-poster-backdrop");
    carouselBackdrop.style.backgroundImage = "linear-gradient(135deg, #121733 0%, #1b1a3b 38%, #0b2637 100%)";
    carouselTitle.textContent = "Loading AnimeTV...";
    carouselText.textContent = "Getting the catalog ready.";
    carouselMeta.textContent = "Please wait";
    carouselOpen.removeAttribute("data-open-show");
    if (carouselIndicators) carouselIndicators.innerHTML = "";
    return;
  }
  if (state.carouselIndex >= items.length) state.carouselIndex = 0;
  if (state.carouselIndex < 0) state.carouselIndex = items.length - 1;
  const show = items[state.carouselIndex];
  const art = show.banner || "";
  const fallbackArt = show.image || "";
  const poster = show.image || show.banner || "";

  carouselPosterWrap.innerHTML = `
    <img class="carousel-poster" id="carouselPoster" src="${poster}" alt="" decoding="async" fetchpriority="high" ${poster ? "" : "hidden"}>
  `;
  carouselBackdrop.classList.toggle("has-banner", Boolean(art));
  carouselBackdrop.classList.toggle("is-poster-backdrop", !art && Boolean(fallbackArt));
  carouselBackdrop.style.backgroundImage = art
    ? `url("${art}")`
    : fallbackArt
      ? `url("${fallbackArt}")`
      : "linear-gradient(135deg, #121733 0%, #1b1a3b 38%, #0b2637 100%)";
  carouselTitle.textContent = show.title;
  carouselText.textContent = simpleCarouselText(show);
  carouselMeta.textContent = [show.day, show.time, show.genre.toUpperCase()].filter(Boolean).join(" | ");
  const target = getCardTarget(show);
  carouselOpen.dataset.openShow = String(show.id || "");
  carouselOpen.dataset.openSeason = String(target.seasonNumber || "");
  carouselOpen.dataset.openEpisode = String(target.episodeNumber || "");
  carouselStage.dataset.openShow = String(show.id || "");
  renderCarouselIndicators(items);
}

function renderCarouselIndicators(items) {
  if (!carouselIndicators) return;
  carouselIndicators.innerHTML = items.slice(0, 8).map((show, index) => `
    <button class="carousel-dot focusable ${index === state.carouselIndex ? "is-selected" : ""}" data-carousel-index="${index}" aria-label="Show ${show.title}">
      ${show.image ? `<img src="${show.image}" alt="">` : "<span></span>"}
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
  if (clean.length <= 150) return clean;
  return `${clean.slice(0, 147).trim()}...`;
}

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
  carouselTimer = window.setInterval(() => {
    if (!overlay.hidden) return;
    moveCarousel(1);
  }, 6500);
}

function cardTemplate(show, index = 0) {
  const isFavorite = state.favorites.includes(show.id);
  const colors = Array.isArray(show.colors) && show.colors.length >= 2 ? show.colors : ["#00d2ff", "#251d47"];
  const title = escapeHtml(show.title || "Untitled Anime");
  const artStyle = `--thumb-a: ${colors[0]}; --thumb-b: ${colors[1]}`;
  const meta = cardMeta(show, isFavorite);
  const target = getCardTarget(show);
  const image = show.image
    ? `
        <img class="thumb-backdrop" src="${escapeHtml(show.image)}" alt="" loading="lazy">
        <img class="thumb-poster" src="${escapeHtml(show.image)}" alt="" loading="lazy">
      `
    : "";
  return `
    <button class="show-card focusable" style="--card-index: ${index}" data-open-show="${escapeHtml(show.id)}" data-open-season="${target.seasonNumber}" data-open-episode="${target.episodeNumber}" aria-label="Open ${title}">
      <span class="thumb-art" style="${artStyle}">
        ${image}
        <span class="episode-pill">${show.episode === "?" ? "TV" : `EP ${show.episode}`}</span>
      </span>
      <span>
        <span class="show-title">${title}</span>
        <span class="show-meta">${escapeHtml(meta)}</span>
      </span>
    </button>
  `;
}

function getCardTarget(show) {
  const seasonNumber = extractSeasonNumber(show.title, 1);
  const episodeNumber = Number(show.episode);
  return {
    seasonNumber,
    episodeNumber: Number.isFinite(episodeNumber) && episodeNumber > 0 ? episodeNumber : ""
  };
}

function cardMeta(show, isFavorite = false) {
  const pieces = [show.genre?.toUpperCase()].filter(Boolean);
  if (show.score) pieces.push(`${show.score}%`);
  if (show.episode && show.episode !== "?") pieces.push(`EP ${show.episode}`);
  if (isFavorite) pieces.push("FAVORITE");
  return pieces.join(" | ");
}

function renderCards(container, list) {
  if (!container) return;
  container.innerHTML = list.map((show, index) => cardTemplate(show, index)).join("");
}

function renderSkeletonCards(container, count = 12) {
  if (!container) return;
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
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const fallback = state.shows.filter((show) => show.day === "TBA").slice(0, 14);
  scheduleList.innerHTML = days.map((day) => {
    const shows = state.shows
      .filter((show) => show.day?.toLowerCase().startsWith(day.toLowerCase()))
      .slice(0, 10);
    const dayShows = shows.length ? shows : fallback.splice(0, 2);
    return `
      <section class="schedule-day-column">
        <h3>${fullDayName(day)}</h3>
        <div class="schedule-day-rail">
          ${dayShows.map((show) => `
            <button class="schedule-item focusable" data-open-show="${escapeHtml(show.id)}" data-open-season="${getCardTarget(show).seasonNumber}" data-open-episode="${getCardTarget(show).episodeNumber}">
              <span class="schedule-thumb">
                ${show.image ? `<img src="${show.image}" alt="" loading="lazy">` : ""}
                <span>${show.episode === "?" ? "TV" : `EP ${show.episode}`}</span>
              </span>
              <span class="schedule-copy">
                <span class="schedule-title">${show.title}</span>
                <span class="show-meta">${show.time || "TBA"} | ${show.source}</span>
              </span>
            </button>
          `).join("")}
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
  return [showOrTitle?.title, ...(showOrTitle?.aliases || [])].filter(Boolean);
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

async function attachLoadedAddonFallbacks(show, episode, seasonNumber = 1) {
  if (!show || !episode) return;
  const episodeNumber = Number(episode.episode || episode.number || 1);
  const sections = state.addonSections.filter((section) =>
    section?.items?.length
    && !["anipub-catalog", "anime1v-spanish", "jimov-tioanime", "rapidapi-anime-streaming"].includes(section.id)
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
    normalizeEpisodeSourceOptions(targetEpisode).forEach((option) => addEpisodeSourceOption(episode, {
      ...option,
      id: `${section.id}-${option.id || normalizeTitle(option.label || "source")}`,
      label: option.label || section.name || section.id
    }));
    if (targetEpisode.streamResolver) addEpisodeSourceOption(episode, {
      id: `${section.id}-resolver`,
      label: section.name || section.id,
      type: "resolver",
      streamResolver: targetEpisode.streamResolver
    });
    const directUrl = getEpisodeUrl(targetEpisode);
    if (directUrl && !getEpisodeUrl(episode)) episode.videoUrl = directUrl;
    if (targetEpisode.externalUrl && !episode.externalUrl) {
      episode.externalUrl = targetEpisode.externalUrl;
      episode.externalType = targetEpisode.externalType || "iframe";
    }
  });
}

async function attachPlaybackSourceOptions(show, episode, seasonNumber = 1) {
  if (!show || !episode) return episode;
  const episodeNumber = Number(episode.episode || episode.number || 1);
  const lookupKey = `${normalizeTitle(show.title)}:s${seasonNumber}:e${episodeNumber}`;
  if (episode.sourceOptionsChecked === lookupKey) return episode;
  const beforeCount = getEpisodePlaybackSources(episode).length;
  await Promise.allSettled([
    attachAniPubFallback(show, episode),
    resolveEpisodeWithAnime1vFallback(show, episode, seasonNumber),
    resolveEpisodeWithJimovFallback(show, episode, seasonNumber),
    resolveEpisodeWithRapidAnimeFallback(show, episode, seasonNumber),
    attachLoadedAddonFallbacks(show, episode, seasonNumber)
  ]);
  episode.sourceOptions = normalizeEpisodeSourceOptions(episode);
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

function schedulePlaybackSourceOptions(show, episode, seasonNumber = 1, options = {}) {
  const lookupKey = playbackLookupKey(show, episode, seasonNumber);
  if (!lookupKey || episode.sourceOptionsChecked === lookupKey) return Promise.resolve(episode);
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
  const sections = state.addonSections
    .filter((section) => section.id !== "anipub-catalog" && section.items?.length)
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
      return `
        <section class="content-band addon-band" data-addon-source="${section.id}">
          <div class="section-heading">
            <span class="addon-dot" aria-hidden="true"></span>
            <h2>${escapeHtml(section.name)}</h2>
            <small>${matchingItems.length} available</small>
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




function renderSources() {
  if (!sourcesGrid || !sourceSummary) return;
  const count = state.localSources.length;
  const enabled = state.localSources.filter((source) => source.enabled).length;
  sourceSummary.textContent = count
    ? `${enabled} enabled source/addon${enabled === 1 ? "" : "s"} | Metadata API: ${state.apiStatus.metadata} | Direct APIs: ${state.apiStatus.direct}`
    : t("sourceSummaryDefault");

  sourcesGrid.innerHTML = `
    <article class="source-card source-card-add">
      <div>
        <strong>Add Server or Online Addon</strong>
        <span>Local or HTTPS</span>
      </div>
      <p>Paste a local server URL or online HTTPS addon that returns anime JSON. AnimeTV will merge it with AniList/Jikan and unlock episodes when items include videoUrl, streamUrl, or file.</p>
      <button class="primary-action focusable" data-source-add>Add Source</button>
    </article>
    <article class="source-card source-card-feature">
      <div>
        <strong>AnimeTV Metadata API</strong>
        <span>${state.apiStatus.metadata}</span>
      </div>
      <p>Local server endpoint that merges AniList and Jikan before the TV app renders. If it is unavailable, the app falls back to direct public API calls.</p>
      <code>${location.origin && location.protocol !== "file:" ? `${location.origin}/api/catalog` : "Run animetv-local.js to enable /api/catalog"}</code>
    </article>
    <article class="source-card source-card-feature">
      <div>
        <strong>AniList + Jikan Direct</strong>
        <span>${state.apiStatus.direct}</span>
      </div>
      <p>Public legal metadata APIs for posters, banners, schedules, genres, and episode counts. These do not provide copyrighted video files.</p>
      <code>${ANILIST_ENDPOINT} + api.jikan.moe</code>
    </article>
    ${state.localSources.map((source) => `
    <article class="source-card ${source.enabled ? "is-enabled" : ""}">
      <div>
        <strong>${source.name || "Unnamed Source"}</strong>
        <span>${source.type || "catalog"} | ${source.status || "Disabled"}</span>
      </div>
      <p>${source.description || "Local catalog connector."}</p>
      <code>${resolveSourceEndpoint(source.endpoint) || "No endpoint configured"}</code>
      ${source.id === "anime1v-spanish" ? `
        <label class="source-key-field">
          <span>Anime1v API key</span>
          <input class="focusable" type="password" value="${escapeHtml(getAnime1vApiKey())}" placeholder="Paste API key if Anime1v returns 401" data-anime1v-key>
        </label>
      ` : ""}
      <div class="source-actions">
        <button class="secondary-action focusable" data-source-toggle="${source.id}">
          ${source.enabled ? "Disable" : "Enable"}
        </button>
        <button class="secondary-action focusable" data-source-test="${source.id}">Test</button>
        <button class="secondary-action source-remove-action focusable" data-source-remove="${source.id}">Remove</button>
      </div>
    </article>
  `).join("")}`;
  wireSourceButtons();
}

function renderSettings() {
  if (!settingsGrid) return;
  const language = state.appLanguage;
  const preferences = getLanguagePreferences();
  const theme = state.theme;
  const ui = state.uiPreferences;
  settingsGrid.innerHTML = `
    <article class="settings-card settings-card-wide">
      <div class="settings-card-head">
        <span class="settings-icon" aria-hidden="true">◐</span>
        <div>
          <strong>${t("appearance")}</strong>
          <span>${t("theme")} + ${t("appLanguage")}</span>
        </div>
      </div>
      <div class="settings-row settings-segment">
        <button class="settings-choice focusable ${theme === "dark" ? "is-selected" : ""}" data-theme-choice="dark">${t("darkMode")}</button>
        <button class="settings-choice focusable ${theme === "light" ? "is-selected" : ""}" data-theme-choice="light">${t("lightMode")}</button>
        <button class="settings-choice focusable ${theme === "system" ? "is-selected" : ""}" data-theme-choice="system">${t("systemMode")}</button>
      </div>
      <div class="settings-row settings-segment">
        <button class="settings-choice focusable ${language === "en" ? "is-selected" : ""}" data-app-language="en">${t("english")}</button>
        <button class="settings-choice focusable ${language === "es" ? "is-selected" : ""}" data-app-language="es">${t("spanish")}</button>
      </div>
    </article>
    <article class="settings-card">
      <div class="settings-card-head">
        <span class="settings-icon" aria-hidden="true">▶</span>
        <div>
          <strong>${t("playback")}</strong>
          <span>${t("playerDefaults")}</span>
        </div>
      </div>
      <label class="settings-field">
        <span>${t("defaultAudio")}</span>
        <select class="language-select focusable settings-select" id="settingsAudio">
          <option value="japanese" ${preferences.audio === "japanese" ? "selected" : ""}>${t("japaneseAudio")}</option>
          <option value="spanish" ${preferences.audio === "spanish" ? "selected" : ""}>${t("spanishAudio")}</option>
          <option value="english" ${preferences.audio === "english" ? "selected" : ""}>${t("englishAudio")}</option>
        </select>
      </label>
      <label class="settings-field">
        <span>${t("defaultSubtitles")}</span>
        <select class="language-select focusable settings-select" id="settingsSubtitles">
          <option value="spanish" ${preferences.subtitles === "spanish" ? "selected" : ""}>${t("spanishSubtitles")}</option>
          <option value="spanish-translated" ${preferences.subtitles === "spanish-translated" ? "selected" : ""}>${t("translatedSpanishSubtitles")}</option>
          <option value="english" ${preferences.subtitles === "english" ? "selected" : ""}>${t("englishSubtitles")}</option>
          <option value="none" ${preferences.subtitles === "none" ? "selected" : ""}>${t("noSubtitles")}</option>
        </select>
      </label>
    </article>
    <article class="settings-card">
      <div class="settings-card-head">
        <span class="settings-icon" aria-hidden="true">▦</span>
        <div>
          <strong>${t("layout")}</strong>
          <span>${state.sidebarCollapsed ? t("compactSidebar") : t("expandedSidebar")}</span>
        </div>
      </div>
      <button class="settings-toggle focusable ${state.sidebarCollapsed ? "is-on" : ""}" data-toggle-sidebar-setting>
        <span>${t("compactSidebar")}</span>
        <b>${state.sidebarCollapsed ? t("on") : t("off")}</b>
      </button>
      <button class="settings-toggle focusable ${ui.focusGlow ? "is-on" : ""}" data-toggle-pref="focusGlow">
        <span>${t("tvFocus")}</span>
        <b>${ui.focusGlow ? t("on") : t("off")}</b>
      </button>
    </article>
    <article class="settings-card">
      <div class="settings-card-head">
        <span class="settings-icon" aria-hidden="true">✦</span>
        <div>
          <strong>${t("behavior")}</strong>
          <span>${t("motion")} + ${t("autoplayHero")}</span>
        </div>
      </div>
      <button class="settings-toggle focusable ${ui.motion ? "is-on" : ""}" data-toggle-pref="motion">
        <span>${t("motion")}</span>
        <b>${ui.motion ? t("motionOn") : t("motionOff")}</b>
      </button>
      <button class="settings-toggle focusable ${ui.autoplayHero ? "is-on" : ""}" data-toggle-pref="autoplayHero">
        <span>${t("autoplayHero")}</span>
        <b>${ui.autoplayHero ? t("on") : t("off")}</b>
      </button>
    </article>
    <article class="settings-card">
      <div class="settings-card-head">
        <span class="settings-icon" aria-hidden="true">↻</span>
        <div>
          <strong>${t("dataTools")}</strong>
          <span>${t("cache")}</span>
        </div>
      </div>
      <div class="settings-row">
        <button class="secondary-action focusable" data-clear-cache>${t("clearCache")}</button>
        <button class="secondary-action focusable" data-reset-settings>${t("resetSettings")}</button>
      </div>
    </article>
    <article class="settings-card settings-card-legal">
      <div class="settings-card-head">
        <span class="settings-icon" aria-hidden="true">§</span>
        <div>
          <strong>Legal</strong>
          <span>App terms and privacy notes</span>
        </div>
      </div>
      <div class="settings-row">
        <a class="secondary-action focusable settings-link" href="#terms">${t("terms")}</a>
        <a class="secondary-action focusable settings-link" href="#privacy">${t("privacy")}</a>
      </div>
    </article>
  `;
  wireSettingsButtons();
}

function wireSettingsButtons() {
  settingsGrid?.querySelectorAll("[data-app-language]").forEach((button) => {
    button.addEventListener("click", () => {
      state.appLanguage = button.dataset.appLanguage;
      localStorage.setItem(APP_LANGUAGE_KEY, state.appLanguage);
      applyAppLanguage();
      renderSettings();
      refreshFocusables();
    });
  });

  settingsGrid?.querySelectorAll("[data-theme-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      state.theme = button.dataset.themeChoice;
      localStorage.setItem(APP_THEME_KEY, state.theme);
      applyUiPreferences();
      renderSettings();
      refreshFocusables();
    });
  });

  settingsGrid?.querySelectorAll("#settingsAudio, #settingsSubtitles").forEach((select) => {
    select.addEventListener("change", () => {
      const audio = document.querySelector("#settingsAudio")?.value || "japanese";
      const subtitles = document.querySelector("#settingsSubtitles")?.value || "spanish";
      setDefaultLanguage(audio, subtitles);
      showToast(t("settingsSaved"));
    });
  });

  settingsGrid?.querySelector("[data-toggle-sidebar-setting]")?.addEventListener("click", () => {
    toggleSidebar();
    renderSettings();
  });

  settingsGrid?.querySelectorAll("[data-toggle-pref]").forEach((button) => {
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

  settingsGrid?.querySelector("[data-clear-cache]")?.addEventListener("click", () => {
    Object.keys(localStorage)
      .filter((key) => key.startsWith(RESPONSE_CACHE_PREFIX) || key.startsWith(ANIPUB_EPISODE_FALLBACK_PREFIX))
      .forEach((key) => localStorage.removeItem(key));
    anipubCatalogCache = null;
    anipubEpisodesCache.clear();
    showToast(t("cacheCleared"));
  });

  settingsGrid?.querySelector("[data-reset-settings]")?.addEventListener("click", () => {
    localStorage.removeItem(APP_THEME_KEY);
    localStorage.removeItem(APP_UI_PREFS_KEY);
    state.theme = "dark";
    state.uiPreferences = readUiPreferences();
    applyUiPreferences();
    renderSettings();
    refreshFocusables();
    showToast(t("settingsSaved"));
  });
}

function wireSourceButtons() {
  document.querySelector("[data-source-add]")?.addEventListener("click", addCustomSource);

  document.querySelectorAll("[data-source-remove]").forEach((button) => {
    button.onclick = () => removeSource(button.dataset.sourceRemove);
  });

  document.querySelectorAll("[data-source-toggle]").forEach((button) => {
    button.onclick = () => {
      const source = state.localSources.find((item) => item.id === button.dataset.sourceToggle);
      if (!source) return;
      saveSourceOverride(source.id, { enabled: !source.enabled });
      state.localSources = state.localSources.map((item) =>
        item.id === source.id ? applySourceOverride({ ...item, enabled: !source.enabled }) : item
      );
      renderSources();
      loadExternalSources();
    };
  });

  document.querySelectorAll("[data-source-test]").forEach((button) => {
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

  document.querySelector("[data-anime1v-key]")?.addEventListener("change", (event) => {
    const value = event.target.value.trim();
    if (value) localStorage.setItem(ANIME1V_API_KEY_STORAGE, value);
    else localStorage.removeItem(ANIME1V_API_KEY_STORAGE);
    markSourceStatus("Anime1v (Japanese + Spanish Subs)", value ? "API key saved" : "API key cleared");
  });
}

function render() {
  const filtered = visibleShows();
  if (state.isLoadingCatalog && !filtered.length) {
    renderSkeletonCards(latestGrid, 12);
    renderSkeletonCards(libraryGrid, 18);
  } else {
    renderCards(latestGrid, filtered.slice(0, HOME_CARD_LIMIT));
    renderCards(libraryGrid, filtered.slice(0, state.search ? SEARCH_CARD_LIMIT : LIBRARY_CARD_LIMIT));
  }
  renderAniPubCatalog();
  renderCards(favoritesGrid, filtered.filter((show) => state.favorites.includes(show.id)));
  const emptyFavorites = document.querySelector("#emptyFavorites");
  if (emptyFavorites && favoritesGrid) emptyFavorites.hidden = favoritesGrid.children.length > 0;
  renderSchedule();
  renderAddonSections();
  renderSettings();
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
  document.querySelectorAll(".nav-link").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.route === route);
  });

  syncRouteVisibility();
  if (route === "anipub") ensureAniPubCatalogLoaded();
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
  if (!show) return;
  state.activeShow = show;
  state.activeEpisodeUrl = "";
  state.activeEpisode = null;
  state.activeDetailTab = "anime";
  state.activeSeasonIndex = 0;
  const openToken = `${show.id || getShowKey(show)}:${Date.now()}`;
  state.activeOpenToken = openToken;
  resetVideoFrame();
  applyOpenTarget(show, target);
  renderEpisodeList(show);
  syncWatchHeading(show);
  document.querySelector("#watchDescription").textContent = show.description;
  favoriteButton.textContent = state.favorites.includes(show.id) ? t("favorited") : t("favorite");
  overlay.hidden = false;
  refreshFocusables();
  closeOverlay.focus();
  hydrateOpenShowDetails(show, target, openToken);
}

async function hydrateOpenShowDetails(show, target = {}, openToken = "") {
  try {
    await Promise.allSettled([
      isAniPubShow(show) ? hydrateAniPubEpisodes(show) : Promise.resolve(show),
      isAnime1vShow(show) ? hydrateAnime1vEpisodes(show) : Promise.resolve(show),
      isJimovShow(show) ? hydrateJimovEpisodes(show) : Promise.resolve(show),
      isRapidAnimeShow(show) ? hydrateRapidAnimeEpisodes(show) : Promise.resolve(show)
    ]);
    if (state.activeOpenToken !== openToken || state.activeShow?.id !== show.id) return;
    applyOpenTarget(show, target);
    if (state.activeEpisode?.episode) {
      await attachPlaybackSourceOptions(show, state.activeEpisode.episode, state.activeEpisode?.season?.season || state.activeSeasonIndex + 1 || 1);
      if (state.activeOpenToken !== openToken || state.activeShow?.id !== show.id) return;
    }
    renderEpisodeList(show);
    syncWatchHeading(show);
    const descriptionNode = document.querySelector("#watchDescription");
    if (descriptionNode) descriptionNode.textContent = show.description;
    favoriteButton.textContent = state.favorites.includes(show.id) ? t("favorited") : t("favorite");
    if (state.activeEpisode) playActiveShow();
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
      sourceOptions: normalizeEpisodeSourceOptions(episode),
      audioTracks: episode.audioTracks || ["japanese"],
      subtitles: episode.subtitles || ["spanish"],
      server: "AniPub",
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
  state.activeDetailTab = "anime";
  state.activeSeasonIndex = 0;
  if (episodeList) {
    episodeList.hidden = true;
    episodeList.innerHTML = "";
  }
  refreshFocusables();
  const firstCard = document.querySelector(".show-card:not([hidden])");
  if (firstCard) firstCard.focus();
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
  favoriteButton.textContent = state.favorites.includes(id) ? t("favorited") : t("favorite");
  render();
}

function resetVideoFrame() {
  stopActivePlayback();
  const show = state.activeShow;
  const background = show?.banner || show?.image || "";
  const poster = show?.image || show?.banner || "";
  const frame = document.querySelector("#videoFrame");
  frame.style.setProperty("--watch-bg", background ? `url("${background}")` : "none");
  frame.innerHTML = `
    <div class="watch-art" id="watchArt">
      ${
        poster
          ? `<img class="watch-poster" src="${poster}" alt="">`
          : `<div class="watch-poster-placeholder"><div class="play-symbol" aria-hidden="true"></div></div>`
      }
    </div>
    <p>${getPlayableUrl(show) ? "Ready to play." : "Choose an episode to load available playback servers."}</p>
  `;
}

function currentEpisodeLabel() {
  const selected = state.activeEpisode;
  if (!selected) return state.activeShow?.title || "Selected anime";
  return `${selected.season?.title || `Season ${selected.seasonIndex + 1}`} Episode ${selected.episode?.episode || selected.episodeIndex + 1}`;
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
  const baseTitle = baseSeasonTitle(show?.title || exactSeasonTitle || "Selected anime");
  return seasonNumber > 1 ? `${baseTitle} Season ${seasonNumber}` : baseTitle;
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
    metaNode.textContent = `${show.genre.toUpperCase()} | ${show.source}${show.score ? ` | ${show.score}%` : ""}`;
  }
}

function renderEpisodeList(show) {
  if (!episodeList) return;
  const seasons = getDetailSeasons(show);
  if (state.activeSeasonIndex >= seasons.length) state.activeSeasonIndex = 0;
  const activeSeason = seasons[state.activeSeasonIndex] || seasons[0];
  const seasonTitle = getSeasonDisplayTitle(show, activeSeason);
  syncWatchHeading(show, activeSeason);

  episodeList.hidden = false;
  episodeList.innerHTML = `
    <div class="detail-tabs" role="tablist" aria-label="Anime details">
      ${["anime", "seasons", "episodes"].map((tab) => `
        <button class="detail-tab focusable ${state.activeDetailTab === tab ? "is-selected" : ""}" data-detail-tab="${tab}" role="tab">
          ${tab === "anime" ? "Anime" : tab === "seasons" ? "Seasons" : "Episodes"}
        </button>
      `).join("")}
    </div>

    <section class="detail-pane ${state.activeDetailTab === "anime" ? "is-active" : ""}" data-detail-pane="anime">
      <span>Anime</span>
      <div class="anime-detail-card">
        ${show.image ? `<img class="anime-detail-poster" src="${show.image}" alt="">` : ""}
        <div>
          <h3>${seasonTitle}</h3>
          <p>${show.genre.toUpperCase()} | ${show.source}${show.score ? ` | ${show.score}%` : ""}</p>
          <p>${show.description}</p>
        </div>
      </div>
    </section>

    <section class="detail-pane ${state.activeDetailTab === "seasons" ? "is-active" : ""}" data-detail-pane="seasons">
      <span>Seasons</span>
      <div class="season-tab-list">
        ${seasons.map((season, seasonIndex) => `
          <button class="season-tab focusable ${state.activeSeasonIndex === seasonIndex ? "is-selected" : ""}" data-season-tab="${seasonIndex}">
            ${season.title || `Season ${season.season || seasonIndex + 1}`}
            <small>${season.episodes.length} eps</small>
          </button>
        `).join("")}
      </div>
      <div class="season-card-grid">
        ${seasons.map((season, seasonIndex) => `
          <button class="season-card focusable ${state.activeSeasonIndex === seasonIndex ? "is-selected" : ""}" data-season-card="${seasonIndex}">
            ${season.image ? `<img src="${season.image}" alt="">` : ""}
            <strong>${season.title || `Season ${season.season || seasonIndex + 1}`}</strong>
            <small>${getSeasonDisplayTitle(show, season)}</small>
            <span>${season.episodes.length} episode${season.episodes.length === 1 ? "" : "s"}</span>
          </button>
        `).join("")}
      </div>
    </section>

    <section class="detail-pane ${state.activeDetailTab === "episodes" ? "is-active" : ""}" data-detail-pane="episodes">
      <span>Episodes</span>
      <div class="season-tab-list">
        ${seasons.map((season, seasonIndex) => `
          <button class="season-tab focusable ${state.activeSeasonIndex === seasonIndex ? "is-selected" : ""}" data-season-tab="${seasonIndex}">
            ${season.title || `Season ${season.season || seasonIndex + 1}`}
            <small>${season.episodes.length} eps</small>
          </button>
        `).join("")}
      </div>
      <section class="season-block ${activeSeason?.playable ? "" : "is-empty"}">
        <div class="season-head">
          ${activeSeason?.image ? `<img class="season-poster-mini" src="${activeSeason.image}" alt="">` : ""}
          <div class="season-copy">
            <h3>${activeSeason?.title || "Season 1"}</h3>
            <p>${seasonTitle}</p>
          </div>
          <span class="season-count">${activeSeason?.episodes.length || 0} episode${activeSeason?.episodes.length === 1 ? "" : "s"}</span>
        </div>
        ${activeSeason?.playable ? "" : `<p class="episode-empty">Episodes are listed from metadata. Playback servers load when a matching source is available.</p>`}
        ${renderSelectedEpisodePanel(activeSeason)}
        <div class="episode-buttons">
          ${(activeSeason?.episodes || []).map((episode, episodeIndex) => `
            <button class="episode-button focusable ${episode.locked ? "is-locked" : ""} ${isActiveEpisode(state.activeSeasonIndex, episodeIndex) ? "is-selected" : ""}" data-season-index="${state.activeSeasonIndex}" data-episode-index="${episodeIndex}">
              <strong>${episode.episode || episodeIndex + 1}</strong>
              <small>${episodeDisplaySubtitle(episode)}</small>
            </button>
          `).join("")}
        </div>
      </section>
    </section>
  `;

  episodeList.querySelectorAll("[data-detail-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeDetailTab = button.dataset.detailTab;
      renderEpisodeList(show);
      refreshFocusables();
    });
  });

  episodeList.querySelectorAll("[data-season-tab], [data-season-card]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeSeasonIndex = Number(button.dataset.seasonTab ?? button.dataset.seasonCard);
      state.activeDetailTab = button.dataset.seasonCard ? "episodes" : state.activeDetailTab;
      state.activeEpisode = null;
      state.activeEpisodeUrl = "";
      renderEpisodeList(show);
      resetVideoFrame();
      refreshFocusables();
    });
  });

  episodeList.querySelector("[data-play-selected]")?.addEventListener("click", () => playActiveShow());

  episodeList.querySelectorAll("[data-season-index][data-episode-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const season = seasons[Number(button.dataset.seasonIndex)];
      const episode = season?.episodes?.[Number(button.dataset.episodeIndex)];
      selectEpisode(season, episode, Number(button.dataset.seasonIndex), Number(button.dataset.episodeIndex));
    });
  });
}

function renderSelectedEpisodePanel(activeSeason) {
  const selected = state.activeEpisode;
  if (!selected || selected.seasonIndex !== state.activeSeasonIndex) {
    return `
      <div class="episode-player-card">
        <strong>Select an episode</strong>
        <span>Choose an episode below to load its player space.</span>
      </div>
    `;
  }

  const episode = selected.episode;
  const canPlay = Boolean(getEpisodeUrl(episode));
  const hasExternal = isExternalIframeEpisode(episode);
  const canResolveAniPub = episode.streamResolver?.type === "anipub";
  const pending = Boolean(episode.sourceOptionsPending);
  const unavailable = isEpisodeUnavailable(episode);
  const statusText = pending
    ? "Checking available servers..."
    : canPlay || hasExternal || canResolveAniPub
      ? "Ready to play in the video area."
      : unavailable
        ? episodeAvailabilityText(episode)
        : "No playback server is available for this episode yet.";
  return `
    <div class="episode-player-card ${canPlay ? "is-ready" : hasExternal || canResolveAniPub ? "is-external" : pending ? "is-loading" : "is-missing"}">
      <strong>${activeSeason?.title || `Season ${selected.seasonIndex + 1}`} - Episode ${episode.episode || selected.episodeIndex + 1}</strong>
      <span>${statusText}</span>
      <button class="episode-play-inline focusable" data-play-selected ${unavailable && !pending ? "disabled" : ""}>${canPlay || hasExternal || canResolveAniPub ? "Play Episode" : pending ? "Checking..." : "Try Episode"}</button>
    </div>
  `;
}

function episodeDisplaySubtitle(episode = {}) {
  if (episode.sourceOptionsPending) return "Checking servers...";
  if (isEpisodeUnavailable(episode)) return episodeAvailabilityText(episode);
  return episode.title || episode.server || "Episode";
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

function getEpisodePlaybackSources(episode = {}) {
  return normalizeEpisodeSourceOptions(episode);
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
      ${sources.map((source, index) => `
        <button class="player-server-option focusable ${selectedSource?.id === source.id ? "is-selected" : ""}" data-player-source="${escapeHtml(source.id)}" type="button">
          <span>Server</span>
          <strong>${index + 1}</strong>
          <small>${escapeHtml(source.label || source.id)}</small>
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
  return `
    <div class="player-episode-actions" aria-label="Episode controls">
      <button class="player-nav-action focusable" type="button" data-player-prev ${nav.previous ? "" : "disabled"}>
        <span aria-hidden="true">‹</span>
        Previous episode
      </button>
      <button class="player-nav-action focusable is-list" type="button" data-player-list>
        <span aria-hidden="true">☰</span>
        Episode list
        ${nav.total ? `<small>${nav.total}</small>` : ""}
      </button>
      <button class="player-nav-action focusable" type="button" data-player-next ${nav.next ? "" : "disabled"}>
        Next episode
        <span aria-hidden="true">›</span>
      </button>
      ${canDownload
        ? `<a class="player-download-action focusable" href="${escapeHtml(downloadUrl)}" download>Download</a>`
        : `<button class="player-download-action focusable" type="button" disabled title="No direct download file is available from this server">Download</button>`}
    </div>
  `;
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
  if (shouldPlay) playActiveShow();
  refreshFocusables();
}

function showEpisodeListTab() {
  state.activeDetailTab = "episodes";
  renderEpisodeList(state.activeShow);
  episodeList?.scrollIntoView({ behavior: "smooth", block: "start" });
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

  frame.querySelector("[data-player-prev]")?.addEventListener("click", () => {
    const nav = getEpisodeNavigationTargets();
    if (nav.previous) selectEpisodeByPosition(nav.previous.seasonIndex, nav.previous.episodeIndex);
  });

  frame.querySelector("[data-player-next]")?.addEventListener("click", () => {
    const nav = getEpisodeNavigationTargets();
    if (nav.next) selectEpisodeByPosition(nav.next.seasonIndex, nav.next.episodeIndex);
  });

  frame.querySelector("[data-player-list]")?.addEventListener("click", () => showEpisodeListTab());
}

function getWatchKey(show = state.activeShow, episode = state.activeEpisode?.episode) {
  if (!show || !episode) return "";
  return `${show.id || normalizeTitle(show.title)}:s${episode.season || state.activeEpisode?.season?.season || 1}:e${episode.episode || episode.number || 1}`;
}

function readStoredMap(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "{}");
  } catch (error) {
    return {};
  }
}

function saveWatchProgress(video, episode) {
  const key = getWatchKey(state.activeShow, episode);
  if (!key || !Number.isFinite(video.currentTime)) return;
  const positions = readStoredMap(RESUME_POSITIONS_KEY);
  positions[key] = {
    position: Math.floor(video.currentTime),
    duration: Math.floor(video.duration || 0),
    updatedAt: Date.now()
  };
  localStorage.setItem(RESUME_POSITIONS_KEY, JSON.stringify(positions));
  const history = readStoredMap(WATCH_HISTORY_KEY);
  history[state.activeShow.id || normalizeTitle(state.activeShow.title)] = {
    showId: state.activeShow.id,
    title: state.activeShow.title,
    episode: episode.episode || episode.number,
    season: episode.season || state.activeEpisode?.season?.season || 1,
    updatedAt: Date.now()
  };
  localStorage.setItem(WATCH_HISTORY_KEY, JSON.stringify(history));
}

function getResumePosition(episode) {
  const key = getWatchKey(state.activeShow, episode);
  const item = key ? readStoredMap(RESUME_POSITIONS_KEY)[key] : null;
  return item?.position > 8 ? item.position : 0;
}

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
  playActiveShow();
  schedulePlaybackSourceOptions(state.activeShow, episode, season?.season || seasonIndex + 1 || 1, { autoReplay: true });
  refreshFocusables();
}

function getPlayableUrl(show) {
  if (!show) return "";
  if (state.activeEpisode) return getEpisodeUrl(state.activeEpisode.episode);
  return state.activeEpisodeUrl || show.videoUrl || getEpisodeUrl(show.seasons?.[0]?.episodes?.[0]) || getEpisodeUrl(show.episodes?.[0]) || "";
}

function getDetailSeasons(show) {
  const sourceSeasons = show.seasons?.length ? show.seasons : groupEpisodesBySeason(show.episodes || []);
  if (sourceSeasons.length) {
    return sourceSeasons.map((season, index) => ({
      ...season,
      season: season.season || index + 1,
      title: season.title || `Season ${season.season || index + 1}`,
      sourceTitle: show.title,
      image: show.image,
      episodes: repairEpisodeGaps(season.episodes || [], season.season || index + 1),
      playable: (season.episodes || []).some((episode) => getEpisodeUrl(episode) || isExternalIframeEpisode(episode) || episode.streamResolver)
    }));
  }

  const franchiseKey = getFranchiseKey(show.title);
  const related = state.shows
    .filter((entry) => getFranchiseKey(entry.title) === franchiseKey)
    .sort((a, b) => extractSeasonNumber(a.title, 1) - extractSeasonNumber(b.title, 1));

  const seasonShows = related.length ? related : [show];
  const usedNumbers = new Set();
  return seasonShows.map((entry, index) => {
    let seasonNumber = extractSeasonNumber(entry.title, index + 1);
    while (usedNumbers.has(seasonNumber)) seasonNumber += 1;
    usedNumbers.add(seasonNumber);
    return {
      season: seasonNumber,
      title: seasonNumber === 1 && seasonShows.length === 1 ? "Season 1" : `Season ${seasonNumber}`,
      sourceTitle: entry.title,
      image: entry.image,
      source: entry.source,
      score: entry.score,
      playable: false,
      episodes: makePlaceholderEpisodes(entry, seasonNumber)
    };
  });
}

function makePlaceholderEpisodes(show, seasonNumber) {
  const knownCount = Number(show.episode);
  const count = Number.isFinite(knownCount) && knownCount > 0 ? knownCount : 12;
  return Array.from({ length: Math.min(count, 200) }, (_, index) => ({
    season: seasonNumber,
    episode: index + 1,
    title: "Not available yet",
    server: "Not available yet",
    locked: true,
    unavailable: true
  }));
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
  const byNumber = new Map();
  episodes.filter(Boolean).forEach((episode) => {
    const number = Number(episode.episode || episode.number);
    if (!Number.isFinite(number) || number < 1) return;
    byNumber.set(number, {
      ...episode,
      episode: number,
      season: episode.season || seasonNumber
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
      season: seasonNumber,
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
  if (allowSourceLookup && activeEpisode && activeEpisode.sourceOptionsChecked !== playbackLookupKey(show, activeEpisode, seasonNumber)) {
    schedulePlaybackSourceOptions(show, activeEpisode, seasonNumber, { autoReplay: true });
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
    frame.innerHTML = `
      <div class="episode-video-empty is-loading">
        <div class="play-symbol" aria-hidden="true"></div>
        <strong>Loading ${source?.label || "episode"}...</strong>
        <p>Checking ${activeEpisode.server || "the addon"} for a direct stream or external playback option.</p>
      </div>
    `;
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
    frame.innerHTML = `
      <div class="episode-video-empty is-loading">
        <div class="play-symbol" aria-hidden="true"></div>
        <strong>Checking servers...</strong>
        <p>Finding every available playback source for this episode.</p>
      </div>
    `;
    return;
  }

  if (!url) {
    const selected = state.activeEpisode;
    const label = selected
      ? `${selected.season?.title || `Season ${selected.seasonIndex + 1}`} Episode ${selected.episode?.episode || selected.episodeIndex + 1}`
      : show?.title || "Selected episode";
    frame.innerHTML = `
      <div class="episode-video-empty">
        <div class="play-symbol" aria-hidden="true"></div>
        <strong>${label}</strong>
        <p>${isEpisodeUnavailable(activeEpisode) ? episodeAvailabilityText(activeEpisode) : "No playable server was found for this episode yet. Check your connection or try another source."}</p>
        <button class="external-play-button focusable" type="button" data-retry-episode>Retry Episode</button>
      </div>
    `;
    frame.querySelector("[data-retry-episode]")?.addEventListener("click", () => playActiveShow());
    refreshFocusables();
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
  const audioTracks = getAvailableAudioTracks(episode);
  const subtitleTracks = getAvailableSubtitles(episode);
  const selectedSource = getSelectedEpisodeSource(episode);
  frame.innerHTML = `
    <div class="video-player-shell">
      ${renderPlayerSourceOptions(episode, selectedSource)}
      <div class="player-controls-bar direct-player-controls">
        <div class="episode-info">
          <strong>${escapeHtml(currentEpisodeLabel())}</strong>
          <span class="source-badge">Direct</span>
        </div>
        <div class="language-selector">
          <select id="directAudioLang" class="language-select focusable">
            ${audioTracks.map((track) => `<option value="${track}" ${track === preferences.audio ? "selected" : ""}>${languageOptionLabel(track, "audio")}</option>`).join("")}
          </select>
          <select id="directSubtitleLang" class="language-select focusable">
            ${subtitleTracks.map((track) => `<option value="${track}" ${track === preferences.subtitles ? "selected" : ""}>${languageOptionLabel(track, "subtitles")}</option>`).join("")}
          </select>
        </div>
      </div>
      <video id="animePlayer" controls autoplay playsinline x-webkit-airplay="allow" src="${url}">
        ${spanishTrack ? `<track kind="subtitles" srclang="es" label="Español" src="${escapeHtml(spanishTrack.url)}" default>` : ""}
      </video>
      ${renderPlayerEpisodeActions(url)}
      <div class="translated-caption" id="translatedCaption" hidden></div>
      <div class="subtitle-status" id="subtitleStatus">Spanish subtitles preferred</div>
    </div>
  `;
  frame.querySelector("#directAudioLang")?.addEventListener("change", (event) => {
    setDefaultLanguage(event.target.value, getLanguagePreferences().subtitles);
    showToast(`Audio: ${event.target.value}`);
  });
  frame.querySelector("#directSubtitleLang")?.addEventListener("change", (event) => {
    setDefaultLanguage(getLanguagePreferences().audio, event.target.value);
    showToast(`Subtitles: ${event.target.value === "none" ? "off" : event.target.value}`);
    setupSpanishSubtitles(episode, tracks);
  });
  frame.querySelector("#animePlayer")?.addEventListener("error", () => {
    console.error("Direct video playback failed", { url, episode });
    if (isExternalIframeEpisode(episode)) {
      renderEmbeddedAniPubPlayer(state.activeShow || { title: "AniPub" }, episode.externalUrl);
      return;
    }
    frame.innerHTML = `
      <div class="episode-video-empty">
        <div class="play-symbol" aria-hidden="true"></div>
        <strong>Playback failed</strong>
        <p>The direct video stream could not play. If an AniPub embed is available, AnimeTV will use the embedded player; otherwise retry this episode.</p>
        <button class="external-play-button focusable" type="button" data-retry-episode>Retry Episode</button>
      </div>
    `;
    frame.querySelector("[data-retry-episode]")?.addEventListener("click", () => playActiveShow());
    refreshFocusables();
  });
  const player = frame.querySelector("#animePlayer");
  const resumeAt = getResumePosition(episode);
  if (player && resumeAt) {
    player.addEventListener("loadedmetadata", () => {
      if (resumeAt < (player.duration || resumeAt + 1) - 5) player.currentTime = resumeAt;
    }, { once: true });
  }
  player?.addEventListener("timeupdate", () => {
    if (Math.floor(player.currentTime) % 5 === 0) saveWatchProgress(player, episode);
  });
  player?.addEventListener("pause", () => saveWatchProgress(player, episode));
  setupSpanishSubtitles(episode, tracks);
  wirePlayerChrome(frame);
  refreshFocusables();
}

async function setupSpanishSubtitles(episode, tracks = []) {
  const status = document.querySelector("#subtitleStatus");
  const video = document.querySelector("#animePlayer");
  const caption = document.querySelector("#translatedCaption");
  if (!video || !caption || !status) return;
  const preferences = getLanguagePreferences();
  Array.from(video.textTracks || []).forEach((track) => {
    const language = normalizeLanguagePreference(track.language || track.label);
    track.mode = preferences.subtitles !== "none" && language === preferences.subtitles ? "showing" : "disabled";
  });
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
  if (spanishTrack && preferences.subtitles !== "spanish-translated") {
    status.textContent = "Spanish subtitles available";
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
  const preferences = getLanguagePreferences();
  const episode = selected?.episode || {};
  const selectedSource = selected ? getSelectedEpisodeSource(episode) : null;
  const audioTracks = getAvailableAudioTracks(episode);
  const subtitleTracks = getAvailableSubtitles(episode);
  const label = selected
    ? `${selected.season?.title || `Season ${selected.seasonIndex + 1}`} Episode ${selected.episode?.episode || selected.episodeIndex + 1}`
    : show.title;
  frame.innerHTML = `
    <div class="embedded-player-container anipub-embedded">
      ${renderPlayerSourceOptions(episode, selectedSource)}
      <div class="iframe-wrapper">
        <iframe
          id="anipubEmbeddedPlayer"
          class="embedded-iframe"
          src="${escapeHtml(externalUrl)}"
          frameborder="0"
          allowfullscreen
          allow="autoplay; fullscreen; picture-in-picture; encrypted-media; web-share"
          referrerpolicy="no-referrer"
          sandbox="allow-same-origin allow-scripts allow-forms"
        ></iframe>
      </div>
      <div class="player-language-bar" aria-label="Episode playback settings">
        <div class="episode-info">
          <strong>${escapeHtml(label)}</strong>
        </div>
        <div class="language-selector">
          <select id="anipubAudioLang" class="language-select focusable">
            ${audioTracks.map((track) => `<option value="${track}" ${track === preferences.audio ? "selected" : ""}>${languageOptionLabel(track, "audio")}</option>`).join("")}
          </select>
          <select id="anipubSubtitleLang" class="language-select focusable">
            ${subtitleTracks.map((track) => `<option value="${track}" ${track === preferences.subtitles ? "selected" : ""}>${languageOptionLabel(track, "subtitles")}</option>`).join("")}
          </select>
          <button class="player-cast-action focusable" type="button" data-iframe-cast>Cast</button>
        </div>
      </div>
      ${renderPlayerEpisodeActions("")}
    </div>
  `;

  const audioSelect = frame.querySelector("#anipubAudioLang");
  const subSelect = frame.querySelector("#anipubSubtitleLang");
  const iframe = frame.querySelector("#anipubEmbeddedPlayer");

  audioSelect?.addEventListener("change", () => {
    setDefaultLanguage(audioSelect.value, subSelect?.value || "spanish");
    applyAniPubPreferences(iframe, audioSelect.value, subSelect?.value || "spanish");
    showToast(`Audio: ${audioSelect.value}`);
  });

  subSelect?.addEventListener("change", () => {
    setDefaultLanguage(audioSelect?.value || "japanese", subSelect.value);
    applyAniPubPreferences(iframe, audioSelect?.value || "japanese", subSelect.value);
    showToast(`Subtitles: ${subSelect.value === "none" ? "off" : subSelect.value}`);
  });

  frame.querySelector("[data-iframe-cast]")?.addEventListener("click", () => prepareIframeCast(frame));

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
  console.info("Embedding external playback inside AnimeTV instead of opening a new window.", externalUrl);
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
    episodeNumber: carouselOpen.dataset.openEpisode || target.episodeNumber
  });
}

function getFocusableItems() {
  return [...document.querySelectorAll(".focusable")]
    .filter((element) => !element.disabled && element.offsetParent !== null);
}

function refreshFocusables() {
  getFocusableItems().forEach((element) => element.classList.remove("is-tv-focused"));
}

function setTvFocus(element) {
  refreshFocusables();
  element?.classList.add("is-tv-focused");
}

function moveFocus(direction) {
  const items = getFocusableItems();
  const active = document.activeElement;
  const current = Math.max(0, items.indexOf(active));
  const rect = items[current]?.getBoundingClientRect();

  if (!rect) {
    items[0]?.focus();
    setTvFocus(items[0]);
    return;
  }

  const candidates = items
    .map((element, index) => ({ element, index, box: element.getBoundingClientRect() }))
    .filter(({ index }) => index !== current)
    .filter(({ box }) => {
      if (direction === "right") return box.left > rect.left + rect.width * 0.55;
      if (direction === "left") return box.right < rect.right - rect.width * 0.55;
      if (direction === "down") return box.top > rect.top + rect.height * 0.45;
      return box.bottom < rect.bottom - rect.height * 0.45;
    })
    .map((candidate) => {
      const dx = candidate.box.left + candidate.box.width / 2 - (rect.left + rect.width / 2);
      const dy = candidate.box.top + candidate.box.height / 2 - (rect.top + rect.height / 2);
      const primary = direction === "left" || direction === "right" ? Math.abs(dx) : Math.abs(dy);
      const secondary = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
      return { ...candidate, score: primary + secondary * 2.2 };
    })
    .sort((a, b) => a.score - b.score);

  const next = candidates[0]?.element || items[current + (direction === "right" || direction === "down" ? 1 : -1)];
  if (next) {
    next.focus();
    setTvFocus(next);
    next.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
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
  render();
  if (state.route === "home") setRoute(event.target === searchInputAniPub ? "anipub" : "library");
}

searchInput?.addEventListener("input", handleSearchInput);
searchInputTop?.addEventListener("input", handleSearchInput);
searchInputLibrary?.addEventListener("input", handleSearchInput);
searchInputAniPub?.addEventListener("input", handleSearchInput);
sidebarToggle?.addEventListener("click", toggleSidebar);

closeOverlay.addEventListener("click", closeShow);
favoriteButton.addEventListener("click", toggleFavorite);
fakePlay.addEventListener("click", () => {
  playActiveShow();
});
castButton?.addEventListener("click", () => {
  castActiveEpisode();
});

document.addEventListener("keydown", (event) => {
  lastInputWasPointer = false;
  const keyMap = {
    ArrowRight: "right",
    ArrowLeft: "left",
    ArrowDown: "down",
    ArrowUp: "up"
  };

  if (keyMap[event.key]) {
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
setRoute("home");
applySidebarState();
applyUiPreferences();
renderSources();
loadAnimeSources();
restartCarouselTimer();
if (window.UpdateManager) {
  window.animeTVUpdater = new window.UpdateManager({ currentVersion: "1.3.0" });
  window.animeTVUpdater.start();
}
window.setTimeout(hideAppLoader, 850);
