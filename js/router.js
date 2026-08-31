(function () {
  "use strict";

  const MAIN_ROUTES = new Map([
    ["/", { name: "home", appRoute: "home", title: "ZenkaiTV - Watch Anime Online", description: "Watch anime online in HD on ZenkaiTV." }],
    ["/search", { name: "search", appRoute: "library", title: "Search Anime - ZenkaiTV", description: "Search anime, seasons, and episodes on ZenkaiTV." }],
    ["/browse", { name: "browse", appRoute: "library", title: "Anime Library - ZenkaiTV", description: "Browse the full ZenkaiTV anime library." }],
    ["/latest", { name: "latest", appRoute: "home", focus: "latest", title: "Latest Episodes - ZenkaiTV", description: "Watch the latest anime episodes on ZenkaiTV." }],
    ["/schedule", { name: "schedule", appRoute: "schedule", title: "Weekly Schedule - ZenkaiTV", description: "See the weekly anime release schedule on ZenkaiTV." }],
    ["/continue-watching", { name: "continue-watching", appRoute: "home", focus: "continueWatching", title: "Continue Watching - ZenkaiTV", description: "Resume your anime on ZenkaiTV." }],
    ["/favorites", { name: "favorites", appRoute: "favorites", title: "Favorites - ZenkaiTV", description: "Your ZenkaiTV favorites and watchlist." }],
    ["/settings", { name: "settings", appRoute: "settings", title: "Settings - ZenkaiTV", description: "Adjust ZenkaiTV playback and app settings." }],
    ["/sources", { name: "sources", appRoute: "sources", title: "Sources and Addons - ZenkaiTV", description: "Manage ZenkaiTV sources and addons." }],
    ["/login", { name: "login", appRoute: "profile", title: "Login - ZenkaiTV", description: "Login to your ZenkaiTV profile." }],
    ["/profile", { name: "profile", appRoute: "profile", title: "User Profile - ZenkaiTV", description: "Manage your ZenkaiTV profile." }]
  ]);

  const HASH_MIGRATIONS = new Map([
    ["home", "/"],
    ["search", "/search"],
    ["browse", "/browse"],
    ["library", "/browse"],
    ["favorites", "/favorites"],
    ["continue-watching", "/continue-watching"],
    ["settings", "/settings"],
    ["sources", "/sources"],
    ["schedule", "/schedule"],
    ["profile", "/profile"]
  ]);

  function slugify(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96) || "anime";
  }

  function safeDecode(value) {
    try { return decodeURIComponent(value || ""); }
    catch { return value || ""; }
  }

  function episodeSlug(seasonNumber, episodeNumber, seasonPart) {
    const season = String(seasonNumber || 1).replace(/^s/i, "");
    const part = seasonPart ? `-part-${String(seasonPart).replace(/^part-?/i, "")}` : "";
    const episode = String(episodeNumber || 1).replace(/^e/i, "");
    return `s${season}${part}-e${episode}`;
  }

  function parseEpisodeSlug(value) {
    const raw = String(value || "").toLowerCase();
    const match = raw.match(/^s(\d+)(?:-part-?(\d+))?-e(\d+)$/);
    if (match) {
      return {
        seasonNumber: Number(match[1]),
        seasonPart: match[2] ? Number(match[2]) : "",
        episodeNumber: Number(match[3])
      };
    }
    const justEpisode = raw.match(/^(?:episode-|ep-|e)?(\d+)$/);
    return justEpisode ? { seasonNumber: 1, seasonPart: "", episodeNumber: Number(justEpisode[1]) } : null;
  }

  function parsePath(pathname) {
    // "/index.html" is the home page, not a route. The installed PWA used to
    // launch there (manifest start_url was "./index.html"), and since no route
    // matches that path it fell through to not-found - opening the installed app
    // showed "Page Not Found". The manifest now starts at "/", but shortcuts
    // already on people's machines keep the old URL until the browser refreshes
    // the manifest, so this normalises it either way. Direct /index.html links
    // and bookmarks get the same treatment.
    const withoutIndex = (pathname || "/").replace(/\/index\.html?$/i, "/");
    const clean = withoutIndex.replace(/\/+$/, "") || "/";
    if (MAIN_ROUTES.has(clean)) return { ...MAIN_ROUTES.get(clean), path: clean, params: {} };

    let m = clean.match(/^\/anime\/([^/]+)$/);
    if (m) return {
      name: "anime",
      appRoute: "home",
      path: clean,
      title: "Watch Anime - ZenkaiTV",
      description: "Anime details and episodes on ZenkaiTV.",
      params: { animeId: safeDecode(m[1]) }
    };

    m = clean.match(/^\/anime\/([^/]+)\/seasons$/);
    if (m) return {
      name: "anime-seasons",
      appRoute: "home",
      path: clean,
      title: "Anime Seasons - ZenkaiTV",
      description: "Browse anime seasons on ZenkaiTV.",
      params: { animeId: safeDecode(m[1]) },
      target: { tab: "seasons" }
    };

    m = clean.match(/^\/anime\/([^/]+)\/season\/([^/]+)$/);
    if (m) {
      const seasonRaw = safeDecode(m[2]);
      const partMatch = String(seasonRaw).match(/^(\d+)(?:-part-?(\d+))?$/i);
      return {
        name: "anime-season",
        appRoute: "home",
        path: clean,
        title: "Anime Season - ZenkaiTV",
        description: "Browse this anime season on ZenkaiTV.",
        params: { animeId: safeDecode(m[1]), seasonNumber: seasonRaw },
        target: {
          tab: "episodes",
          seasonNumber: partMatch ? Number(partMatch[1]) : Number(seasonRaw),
          seasonPart: partMatch && partMatch[2] ? Number(partMatch[2]) : ""
        }
      };
    }

    m = clean.match(/^\/anime\/([^/]+)\/episode\/([^/]+)$/);
    if (m) {
      const parsed = parseEpisodeSlug(safeDecode(m[2])) || { seasonNumber: 1, episodeNumber: Number(safeDecode(m[2])) || 1 };
      return {
        name: "anime-episode",
        appRoute: "home",
        path: clean,
        title: "Anime Episode - ZenkaiTV",
        description: "Anime episode details on ZenkaiTV.",
        params: { animeId: safeDecode(m[1]), episodeNumber: safeDecode(m[2]) },
        target: { ...parsed, tab: "episodes" }
      };
    }

    m = clean.match(/^\/watch\/([^/]+)\/([^/]+)$/);
    if (m) {
      const parsed = parseEpisodeSlug(safeDecode(m[2])) || { seasonNumber: 1, episodeNumber: Number(safeDecode(m[2])) || 1 };
      return {
        name: "watch",
        appRoute: "home",
        path: clean,
        title: "Watch Episode - ZenkaiTV",
        description: "Watch this anime episode on ZenkaiTV.",
        params: { animeId: safeDecode(m[1]), episode: safeDecode(m[2]) },
        target: { ...parsed, tab: "episodes", playIntent: true, watchRoute: true }
      };
    }

    m = clean.match(/^\/genre\/([^/]+)$/);
    if (m) return { name: "genre", appRoute: "library", path: clean, params: { genreName: safeDecode(m[1]) }, title: `${safeDecode(m[1])} Anime - ZenkaiTV`, description: `Browse ${safeDecode(m[1])} anime on ZenkaiTV.` };
    m = clean.match(/^\/year\/(\d{4})$/);
    if (m) return { name: "year", appRoute: "library", path: clean, params: { year: m[1] }, title: `${m[1]} Anime - ZenkaiTV`, description: `Browse ${m[1]} anime on ZenkaiTV.` };
    m = clean.match(/^\/season\/(\d{4})\/([^/]+)$/);
    if (m) return { name: "seasonal", appRoute: "library", path: clean, params: { year: m[1], seasonName: safeDecode(m[2]) }, title: `${m[2]} ${m[1]} Anime - ZenkaiTV`, description: `Browse ${m[2]} ${m[1]} anime on ZenkaiTV.` };
    m = clean.match(/^\/studio\/([^/]+)$/);
    if (m) return { name: "studio", appRoute: "library", path: clean, params: { studioName: safeDecode(m[1]) }, title: `${safeDecode(m[1])} Anime - ZenkaiTV`, description: `Browse anime by ${safeDecode(m[1])} on ZenkaiTV.` };

    return {
      name: "not-found",
      appRoute: "not-found",
      path: clean,
      params: {},
      title: "Page Not Found - ZenkaiTV",
      description: "This ZenkaiTV page could not be found."
    };
  }

  function migrateHashRoute() {
    const hash = (location.hash || "").replace(/^#/, "");
    if (!hash) return null;
    let destination = "";
    if (hash.startsWith("anime/")) destination = `/${hash}`;
    else destination = HASH_MIGRATIONS.get(hash) || "";
    if (!destination) return null;
    history.replaceState({ zenkaiRoute: true }, "", destination);
    return parsePath(location.pathname);
  }

  function current() {
    return parsePath(location.pathname);
  }

  function dispatch(routeInfo) {
    window.dispatchEvent(new CustomEvent("zenkaitv:route", { detail: routeInfo || current() }));
  }

  function navigate(path, options = {}) {
    const target = String(path || "/");
    const method = options.replace ? "replaceState" : "pushState";
    if (location.pathname + location.search !== target) {
      history[method]({ zenkaiRoute: true }, "", target);
    }
    if (!options.silent) dispatch(parsePath(location.pathname));
  }

  window.addEventListener("popstate", () => dispatch(current()));

  window.ZenkaiRouter = {
    slugify,
    episodeSlug,
    parseEpisodeSlug,
    parsePath,
    migrateHashRoute,
    current,
    navigate,
    replace: (path, options = {}) => navigate(path, { ...options, replace: true })
  };
})();
