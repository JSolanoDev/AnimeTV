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

class HentaiOceanAdultSourceAdapter extends AdultSourceAdapter {
  constructor(config = {}) {
    super({ name: "Hentai Ocean", baseUrl: "/api/adult/hentaiocean", ...config });
  }

  async _request(path, params = {}) {
    const endpoint = new URL(`${this.baseUrl}${path}`, window.location.href);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") endpoint.searchParams.set(key, value);
    });
    const response = await fetch(endpoint, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) throw new Error(payload.error || `${this.name} request failed`);
    return payload;
  }

  _catalogItem(item = {}, sourceIndex = 0) {
    const slug = String(item.slug || "").trim();
    const image = String(item.image || item.poster || item.cover || item.thumbnail || "").trim();
    const banner = String(item.highQualityBackground || item.backdrop || item.banner || "").trim();
    const episodeCount = Math.max(0, Number(item.episodeCount || 0));
    const year = String(item.year || item.aired || "").match(/\b(?:19|20)\d{2}\b/)?.[0] || "";
    return {
      ...item,
      id: `adult-hentaiocean-${slug}`,
      adultId: `hentaiocean:${slug}`,
      slug,
      title: item.title || slug.replace(/-/g, " "),
      thumbnail: image,
      image,
      poster: image,
      cover: image,
      coverImage: image,
      mainWallpaper: image,
      banner,
      backdrop: banner,
      highQualityBackground: banner,
      adultBackground: banner,
      adultCinematicBackdrop: banner,
      hentaiOceanImage: image,
      hentaiOceanBackdrop: banner,
      images: { poster: image, cover: image, thumbnail: image, banner, backdrop: banner },
      description: String(item.description || "").trim(),
      genres: Array.isArray(item.genres) && item.genres.length ? item.genres : ["Hentai"],
      genre: item.genres?.[0] || "Hentai",
      episode: episodeCount,
      episodeCount,
      totalEpisodes: episodeCount,
      latestAiredEp: episodeCount,
      year,
      startYear: year,
      source: this.name,
      adultSource: this.name,
      sourceOrder: Number.isFinite(Number(item.sourceOrder)) ? Number(item.sourceOrder) : sourceIndex,
      isAdult: true,
      adult: true,
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
    const slug = String(id || "").replace(/^hentaiocean:/, "").replace(/^adult-hentaiocean-/, "");
    const payload = await this._request("/details", { slug });
    const item = payload.item || null;
    if (!item) return null;
    const mapped = this._catalogItem(item);
    const episodes = (item.episodes || []).map((episode) => ({
      ...episode,
      id: `${slug}-s1-e${Number(episode.number || episode.episode || 1) || 1}`,
      season: 1,
      number: Number(episode.number || episode.episode || 1) || 1,
      episode: Number(episode.number || episode.episode || 1) || 1,
      server: this.name,
      locked: false,
      sourceOptions: Array.isArray(episode.sourceOptions) ? episode.sourceOptions : []
    }));
    return {
      ...mapped,
      description: item.description || mapped.description,
      episode: episodes.length,
      episodeCount: episodes.length,
      totalEpisodes: episodes.length,
      episodes,
      seasons: [{
        season: 1,
        title: "Season 1",
        sourceTitle: mapped.title,
        image: mapped.image,
        banner: mapped.banner,
        highQualityBackground: mapped.banner,
        adultBackground: mapped.banner,
        playable: true,
        episodes
      }],
      adultDetailsLoaded: true
    };
  }
}

class CompositeAdultSourceAdapter extends AdultSourceAdapter {
  constructor(adapters = []) {
    const usable = adapters.filter((adapter) => adapter instanceof AdultSourceAdapter);
    super({ name: usable.map((adapter) => adapter.name).join(" + ") || "adult-sources" });
    this.adapters = usable;
    this.primary = usable[0] || new NullAdultSourceAdapter();
    this.hentaiOcean = usable.find((adapter) => adapter instanceof HentaiOceanAdultSourceAdapter) || null;
    this._oceanCatalog = [];
  }

  _titleKey(value = "") {
    return String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\([^)]*\)/g, " ")
      .replace(/\b(?:the\s+)?animation\b/g, " ")
      .replace(/\b(?:ova|ona)\b/g, " ")
      .replace(/\bepisode\s*\d+\b/g, " ")
      .replace(/\s+\d+$/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  _keys(item = {}) {
    return [...new Set([
      item.title,
      item.officialTitle,
      item.nativeTitle,
      item.romajiTitle,
      ...(Array.isArray(item.aliases) ? item.aliases : [])
    ].map((value) => this._titleKey(value)).filter(Boolean))];
  }

  _findExactOceanMatch(item = {}) {
    const keys = this._keys(item);
    return this._oceanCatalog.find((candidate) => this._keys(candidate).some((key) => keys.includes(key))) || null;
  }

  _enrich(primary = {}, ocean = null) {
    if (!ocean) return primary;
    const image = String(ocean.image || ocean.poster || ocean.cover || "").trim();
    const banner = String(ocean.hentaiOceanBackdrop || ocean.highQualityBackground || ocean.backdrop || ocean.banner || "").trim();
    const sourceTitle = primary.title;
    return {
      ...primary,
      sourceTitle,
      title: ocean.title || primary.title,
      aliases: [...new Set([...(primary.aliases || []), sourceTitle, ocean.title].filter(Boolean))],
      description: primary.description || ocean.description || "",
      image: image || primary.image,
      poster: image || primary.poster,
      cover: image || primary.cover,
      coverImage: image || primary.coverImage,
      thumbnail: image || primary.thumbnail,
      mainWallpaper: image || primary.mainWallpaper,
      banner: banner || primary.banner,
      backdrop: banner || primary.backdrop,
      highQualityBackground: banner || primary.highQualityBackground,
      adultBackground: banner || primary.adultBackground,
      adultCinematicBackdrop: banner || primary.adultCinematicBackdrop,
      hentaiOceanImage: image,
      hentaiOceanBackdrop: banner,
      hentaiOceanSlug: ocean.slug,
      images: {
        ...(primary.images || {}),
        poster: image || primary.images?.poster || primary.image,
        cover: image || primary.images?.cover || primary.image,
        thumbnail: image || primary.images?.thumbnail || primary.image,
        banner: banner || primary.images?.banner || primary.banner,
        backdrop: banner || primary.images?.backdrop || primary.backdrop
      }
    };
  }

  _mergeDetailPlayback(primary = {}, ocean = null) {
    if (!ocean) return primary;
    const oceanByEpisode = new Map((ocean.episodes || []).map((episode) => [
      Number(episode.number || episode.episode || 1),
      episode
    ]));
    const episodes = (primary.episodes || []).map((episode) => {
      const episodeNumber = Number(episode.number || episode.episode || 1);
      const fallback = oceanByEpisode.get(episodeNumber);
      if (!fallback) return episode;
      const seenSources = new Set();
      const sourceOptions = [
        ...(episode.sourceOptions || []),
        ...(fallback.sourceOptions || [])
      ].filter((source) => {
        const key = source.id || source.videoUrl || source.externalUrl || source.streamResolver?.endpoint;
        if (!key || seenSources.has(key)) return false;
        seenSources.add(key);
        return true;
      });
      const screenshots = [...new Set([
        ...(episode.screenshots || []),
        ...(fallback.screenshots || []),
        fallback.banner
      ].filter(Boolean))];
      return { ...episode, sourceOptions, screenshots, locked: !sourceOptions.length };
    });
    const byEpisode = new Map(episodes.map((episode) => [Number(episode.number || episode.episode || 1), episode]));
    return {
      ...primary,
      episodes,
      screenshots: [...new Set([
        ...(primary.screenshots || []),
        ...episodes.flatMap((episode) => episode.screenshots || [])
      ].filter(Boolean))],
      seasons: (primary.seasons || []).map((season) => ({
        ...season,
        episodes: (season.episodes || []).map((episode) => (
          byEpisode.get(Number(episode.number || episode.episode || 1)) || episode
        ))
      }))
    };
  }

  _mergeCatalogs(primaryItems = [], oceanItems = []) {
    this._oceanCatalog = oceanItems;
    const claimedOceanIds = new Set();
    const merged = primaryItems.map((item) => {
      const match = this._findExactOceanMatch(item);
      if (match) claimedOceanIds.add(match.id);
      return this._enrich(item, match);
    });
    oceanItems.forEach((item) => {
      if (!claimedOceanIds.has(item.id)) merged.push(item);
    });
    return merged.map((item, sourceOrder) => ({ ...item, sourceOrder }));
  }

  async listLatest(page = 1, options = {}) {
    const results = await Promise.allSettled(this.adapters.map((adapter) => adapter.listLatest(page, options)));
    const primaryItems = results[0]?.status === "fulfilled" ? results[0].value : [];
    const oceanIndex = this.adapters.indexOf(this.hentaiOcean);
    const oceanItems = oceanIndex >= 0 && results[oceanIndex]?.status === "fulfilled" ? results[oceanIndex].value : [];
    if (!primaryItems.length && !oceanItems.length) {
      const message = results.map((result) => result.status === "rejected" ? result.reason?.message : "").find(Boolean);
      throw new Error(message || "Adult catalogs are unavailable");
    }
    return this._mergeCatalogs(primaryItems, oceanItems);
  }

  async search(query, page = 1) {
    const results = await Promise.allSettled(this.adapters.map((adapter) => adapter.search(query, page)));
    const primaryItems = results[0]?.status === "fulfilled" ? results[0].value : [];
    const oceanIndex = this.adapters.indexOf(this.hentaiOcean);
    const oceanItems = oceanIndex >= 0 && results[oceanIndex]?.status === "fulfilled" ? results[oceanIndex].value : [];
    return this._mergeCatalogs(primaryItems, oceanItems);
  }

  async getDetails(id) {
    const rawId = String(id || "");
    if (/^(?:hentaiocean:|adult-hentaiocean-)/.test(rawId) && this.hentaiOcean) {
      return this.hentaiOcean.getDetails(rawId);
    }
    const details = await this.primary.getDetails(rawId);
    if (!details) return null;
    if (!this._oceanCatalog.length && this.hentaiOcean) {
      this._oceanCatalog = await this.hentaiOcean.listLatest(1).catch(() => []);
    }
    const oceanMatch = this._findExactOceanMatch(details);
    const enriched = this._enrich(details, oceanMatch);
    if (!oceanMatch || !this.hentaiOcean) return enriched;
    const oceanDetails = await this.hentaiOcean.getDetails(oceanMatch.id).catch(() => null);
    return this._mergeDetailPlayback(enriched, oceanDetails);
  }

  async resolveStream(id, episode) {
    if (/^(?:hentaiocean:|adult-hentaiocean-)/.test(String(id || "")) && this.hentaiOcean) {
      return this.hentaiOcean.resolveStream(id, episode);
    }
    return this.primary.resolveStream(id, episode);
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

AdultSourceRegistry.register(new CompositeAdultSourceAdapter([
  new UnderHentaiAdultSourceAdapter(),
  new HentaiOceanAdultSourceAdapter()
]));

if (typeof window !== "undefined") {
  window.AdultSourceAdapter = AdultSourceAdapter;
  window.NullAdultSourceAdapter = NullAdultSourceAdapter;
  window.UnderHentaiAdultSourceAdapter = UnderHentaiAdultSourceAdapter;
  window.HentaiOceanAdultSourceAdapter = HentaiOceanAdultSourceAdapter;
  window.CompositeAdultSourceAdapter = CompositeAdultSourceAdapter;
  window.AdultSourceRegistry = AdultSourceRegistry;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    AdultSourceAdapter,
    NullAdultSourceAdapter,
    UnderHentaiAdultSourceAdapter,
    HentaiOceanAdultSourceAdapter,
    CompositeAdultSourceAdapter,
    AdultSourceRegistry
  };
}
