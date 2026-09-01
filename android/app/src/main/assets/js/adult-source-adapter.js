/**
 * ZenkaiTV AdultSourceAdapter
 *
 * A pluggable interface for an 18+ content source, shaped to match the existing
 * AnimeAV1 scraper (login / search / getDetails). This file intentionally
 * Adult providers stay behind the explicit 18+ mode gate and are never merged
 * into the regular catalog surface.
 *
 * Contract (mirror of the AnimeAV1 scraper):
 *
 *   class AnimeAV1Scraper {
 *     login(email, password): Promise<boolean>
 *     search(query, page=1):  Promise<ContentItem[]>   // { id, title, thumbnail, url }
 *     getDetails(id):         Promise<ContentDetails | null>
 *   }
 *
 * ContentItem  (what search/listLatest return — flagged so AdultMode filters it):
 *   { id, title, thumbnail, url, isAdult: true, adultSource: <name> }
 *
 * ContentDetails (what getDetails returns):
 *   { id, title, description, thumbnail, episodes: [{ number, title, url }], isAdult: true }
 */
class AdultSourceAdapter {
  /**
   * @param {object} config - e.g. { name, baseUrl, credentials }
   */
  constructor(config = {}) {
    this.name = config.name || "adult-source";
    this.baseUrl = config.baseUrl || "";
    this.config = config;
    this._session = null;
  }

  /**
   * Authenticate, if your source needs it (the AnimeAV1 scraper logs in here).
   * @returns {Promise<boolean>} true on success.
   */
  async login(email, password) {
    void email; void password;
    throw new Error(`AdultSourceAdapter[${this.name}].login is not implemented`);
  }

  /**
   * Search the source. MUST return items flagged `isAdult: true` so the rest of
   * the app keeps them out of the default catalog.
   * @returns {Promise<Array<{id,title,thumbnail,url,isAdult:boolean,adultSource:string}>>}
   */
  async search(query, page = 1) {
    void query; void page;
    return [];
  }

  /**
   * Newest releases for the home rail (optional; mirrors AnimeAV1 "latest").
   * @returns {Promise<Array<object>>}
   */
  async listLatest(page = 1) {
    void page;
    return [];
  }

  /**
   * Full details for one item (episodes/streams).
   * @returns {Promise<object|null>}
   */
  async getDetails(id) {
    void id;
    return null;
  }

  /**
   * Resolve a playable URL for an episode/stream (mirrors the source resolvers).
   * @returns {Promise<{url:string,type:string}|null>}
   */
  async resolveStream(id, episode) {
    void id; void episode;
    return null;
  }
}

/**
 * Default no-op adapter. Lets adult mode run end-to-end (toggle, theme, badge,
 * empty catalog) before any real source is connected — nothing is fetched.
 */
class NullAdultSourceAdapter extends AdultSourceAdapter {
  constructor() { super({ name: "none" }); }
  async login() { return false; }
  async search() { return []; }
  async listLatest() { return []; }
  async getDetails() { return null; }
  async resolveStream() { return null; }
}

class UnderHentaiAdultSourceAdapter extends AdultSourceAdapter {
  constructor(config = {}) {
    super({ name: "UnderHentai", baseUrl: "/api/adult/underhentai", ...config });
  }

  async _request(path, params = {}) {
    const endpoint = new URL(`${this.baseUrl}${path}`, window.location.href);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") endpoint.searchParams.set(key, value);
    });
    const response = await fetch(endpoint, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `${this.name} request failed`);
    }
    return payload;
  }

  _isUnavailableUpload(value = "") {
    try {
      const parsed = new URL(String(value));
      return parsed.hostname.toLowerCase() === "static.underhentai.net"
        && parsed.pathname.toLowerCase().startsWith("/uploads/");
    } catch {
      return false;
    }
  }

  _airedYear(aired = "") {
    const match = String(aired).match(/\b(?:19|20)\d{2}\b/);
    return match ? Number(match[0]) : "";
  }

  _normalizedStatus(status = "", aired = "") {
    const normalized = String(status || "").trim().toUpperCase().replace(/\s+/g, "_");
    if (["RELEASING", "FINISHED", "NOT_YET_RELEASED", "CANCELLED", "HIATUS"].includes(normalized)) return normalized;
    const sourceText = `${status} ${aired}`;
    if (/ongoing|currently airing|releasing/i.test(sourceText)) return "RELEASING";
    if (/upcoming|not yet|tba/i.test(sourceText)) return "NOT_YET_RELEASED";
    return aired ? "FINISHED" : "";
  }

  _description(item = {}) {
    const description = String(item.description || "").trim();
    if (description) return description;
    const officialTitle = String(item.officialTitle || "").trim();
    const brand = String(item.brand || "").trim();
    return [
      officialTitle ? `Official title: ${officialTitle}` : "",
      brand ? `Studio: ${brand}` : ""
    ].filter(Boolean).join(" · ") || "UnderHentai title.";
  }

  _bestImage(item = {}) {
    const screenshots = Array.isArray(item.screenshots) ? item.screenshots : [];
    const candidates = [
      item.mainWallpaper,
      item.image,
      item.poster,
      item.cover,
      item.thumbnail,
      item.banner,
      screenshots[0]
    ].map((value) => String(value || "").trim()).filter(Boolean);
    return candidates.find((value) => !this._isUnavailableUpload(value)) || candidates[0] || "";
  }

  _bestBanner(item = {}, fallback = "") {
    const screenshots = Array.isArray(item.screenshots) ? item.screenshots : [];
    return String(
      screenshots[0] ||
      item.highQualityBackground ||
      item.background ||
      item.backdrop ||
      item.banner ||
      item.mainWallpaper ||
      fallback ||
      ""
    ).trim();
  }

  _catalogItem(item = {}, sourceIndex = 0) {
    const episodeCount = Math.max(0, Number(item.episodeCount || 0));
    const sourceOrder = Number.isFinite(Number(item.sourceOrder))
      ? Number(item.sourceOrder)
      : sourceIndex;
    const image = this._bestImage(item);
    const banner = this._bestBanner(item, image);
    const aired = String(item.aired || "").trim();
    const year = this._airedYear(aired);
    const status = this._normalizedStatus(item.status, aired);
    const officialTitle = String(item.officialTitle || "").trim();
    const brand = String(item.brand || "").trim();
    return {
      id: `adult-underhentai-${item.slug}`,
      adultId: item.slug,
      slug: item.slug,
      title: item.title || item.slug,
      nativeTitle: officialTitle,
      officialTitle,
      aliases: officialTitle ? [officialTitle] : [],
      thumbnail: image,
      image,
      poster: image,
      cover: image,
      coverImage: image,
      mainWallpaper: image,
      banner,
      backdrop: banner,
      highQualityBackground: banner || image,
      adultBackground: banner || image,
      underHentaiImage: image,
      underHentaiBackdrop: banner || image,
      screenshots: Array.isArray(item.screenshots) ? item.screenshots : [],
      images: {
        poster: image,
        cover: image,
        thumbnail: image,
        banner,
        backdrop: banner || image
      },
      url: item.url || "",
      siteUrl: item.url || "",
      description: this._description(item),
      genres: Array.isArray(item.genres) ? item.genres : [],
      genre: item.genres?.[0] || "Hentai",
      episode: episodeCount,
      episodeCount,
      totalEpisodes: episodeCount,
      latestAiredEp: episodeCount,
      releaseCount: Math.max(0, Number(item.releaseCount || 0)),
      aired,
      year,
      startYear: year,
      status,
      format: item.format || "",
      brand,
      studios: brand ? [brand] : [],
      source: item.source || this.name,
      isAdult: true,
      adult: true,
      adultSource: item.adultSource || this.name,
      sourceOrder,
      adultDetailsLoaded: false,
      seasons: [],
      episodes: []
    };
  }

  async search(query, page = 1) {
    const payload = await this._request("/catalog", { q: query, page });
    return (payload.items || []).map((item, index) => this._catalogItem(item, index));
  }

  async listLatest(page = 1, options = {}) {
    const payload = await this._request("/catalog", { page, refresh: options.refresh ? 1 : "" });
    return (payload.items || []).map((item, index) => this._catalogItem(item, index));
  }

  async getDetails(id) {
    const slug = String(id || "").replace(/^adult-underhentai-/, "");
    const payload = await this._request("/details", { slug });
    const item = payload.item || null;
    if (!item) return null;
    const image = this._bestImage(item);
    const banner = this._bestBanner(item, image);
    const episodes = (item.episodes || []).map((episode) => {
      const episodeNumber = Number(episode.episode || episode.number || 1) || 1;
      const sourceOptions = (episode.sourceOptions || []).map((source, index) => {
        const resolver = source.streamResolver || source.resolver || {};
        return {
          ...source,
          id: source.id || `${slug}-e${episodeNumber}-source-${index}`,
          label: source.label || source.provider || source.server || `Adult Source ${index + 1}`,
          type: "resolver",
          streamResolver: {
            type: resolver.type || "underhentai",
            endpoint: resolver.endpoint || `/api/adult/underhentai/stream?slug=${encodeURIComponent(slug)}&episode=${encodeURIComponent(episodeNumber)}&release=${encodeURIComponent(source.releaseIndex ?? index)}`
          }
        };
      }).sort((a, b) => {
        const score = (source = {}) => {
          const text = `${source.id || ""} ${source.label || ""} ${source.provider || ""} ${source.streamResolver?.endpoint || ""}`.toLowerCase();
          if (text.includes("veohentai") || text.includes("hentaiplayer") || text.includes("1hanime")) return 0;
          if (text.includes("underhentai")) return 1;
          if (text.includes("kraken")) return 2;
          return 3;
        };
        return score(a) - score(b);
      });
      return {
        ...episode,
        id: `${slug}-s1-e${episodeNumber}`,
        season: 1,
        number: episodeNumber,
        episode: episodeNumber,
        image: this._bestImage(episode) || image,
        thumbnail: this._bestImage(episode) || image,
        banner: this._bestBanner(episode, banner || image),
        adultBackground: this._bestBanner(episode, banner || image),
        underHentaiImage: this._bestImage(episode) || image,
        underHentaiBackdrop: this._bestBanner(episode, banner || image),
        server: this.name,
        locked: !sourceOptions.length,
        sourceOptions
      };
    });
    return {
      ...this._catalogItem(item),
      description: this._description(item),
      officialTitle: item.officialTitle || "",
      brand: item.brand || "",
      episode: episodes.length,
      totalEpisodes: episodes.length,
      episodes,
      seasons: [{
        season: 1,
        title: "Season 1",
        sourceTitle: item.title,
        image,
        banner,
        highQualityBackground: banner || image,
        adultBackground: banner || image,
        underHentaiImage: image,
        underHentaiBackdrop: banner || image,
        screenshots: Array.isArray(item.screenshots) ? item.screenshots : [],
        playable: true,
        episodes
      }],
      adultDetailsLoaded: true
    };
  }

  async resolveStream(id, episode) {
    const payload = await this._request("/stream", { slug: id, episode });
    return payload;
  }
}

/**
 * Tiny registry so the app can hold a single active adult source and swap it
 * later. Defaults to the null adapter — the app shows the empty 18+ catalog
 * until a real adapter is registered.
 */
const AdultSourceRegistry = (function () {
  "use strict";
  let _active = new NullAdultSourceAdapter();

  return {
    /** Register the active adult source adapter (an AdultSourceAdapter instance). */
    register(adapter) {
      if (adapter instanceof AdultSourceAdapter) _active = adapter;
      return _active;
    },
    /** The currently-active adapter (never null — NullAdultSourceAdapter by default). */
    get() { return _active; },
    /** True once a real (non-null) source has been plugged in. */
    isConfigured() { return !(_active instanceof NullAdultSourceAdapter); }
  };
})();

AdultSourceRegistry.register(new UnderHentaiAdultSourceAdapter());

if (typeof window !== "undefined") {
  window.AdultSourceAdapter = AdultSourceAdapter;
  window.NullAdultSourceAdapter = NullAdultSourceAdapter;
  window.UnderHentaiAdultSourceAdapter = UnderHentaiAdultSourceAdapter;
  window.AdultSourceRegistry = AdultSourceRegistry;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    AdultSourceAdapter,
    NullAdultSourceAdapter,
    UnderHentaiAdultSourceAdapter,
    AdultSourceRegistry
  };
}
