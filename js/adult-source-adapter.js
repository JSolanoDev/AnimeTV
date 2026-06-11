/**
 * ZenkaiTV AdultSourceAdapter (SCAFFOLD ONLY)
 *
 * A pluggable interface for an 18+ content source, shaped to match the existing
 * AnimeAV1 scraper (login / search / getDetails). This file intentionally
 * contains NO real fetching for any specific site — every method is a clearly
 * marked placeholder. Drop in your own vetted source by extending this class
 * and implementing the `// TODO: Implement with your adult source` sections.
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
    // TODO: Implement with your adult source.
    // e.g. POST credentials, store a session cookie/token on `this._session`.
    void email; void password;
    throw new Error(`AdultSourceAdapter[${this.name}].login is not implemented`);
  }

  /**
   * Search the source. MUST return items flagged `isAdult: true` so the rest of
   * the app keeps them out of the default catalog.
   * @returns {Promise<Array<{id,title,thumbnail,url,isAdult:boolean,adultSource:string}>>}
   */
  async search(query, page = 1) {
    // TODO: Implement with your adult source.
    // Return [{ id, title, thumbnail, url, isAdult: true, adultSource: this.name }, ...]
    void query; void page;
    return [];
  }

  /**
   * Newest releases for the home rail (optional; mirrors AnimeAV1 "latest").
   * @returns {Promise<Array<object>>}
   */
  async listLatest(page = 1) {
    // TODO: Implement with your adult source.
    void page;
    return [];
  }

  /**
   * Full details for one item (episodes/streams).
   * @returns {Promise<object|null>}
   */
  async getDetails(id) {
    // TODO: Implement with your adult source.
    // Return { id, title, description, thumbnail, episodes: [...], isAdult: true } or null.
    void id;
    return null;
  }

  /**
   * Resolve a playable URL for an episode/stream (mirrors the source resolvers).
   * @returns {Promise<{url:string,type:string}|null>}
   */
  async resolveStream(id, episode) {
    // TODO: Implement with your adult source.
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

if (typeof module !== "undefined" && module.exports) {
  module.exports = { AdultSourceAdapter, NullAdultSourceAdapter, AdultSourceRegistry };
}
