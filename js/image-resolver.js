/**
 * ZenkaiTV Image Resolver
 *
 * One reusable system that picks the best available image for every surface
 * (episode thumbnails, pre-player backgrounds, pre-player posters) using a
 * strict priority chain, and enriches AniList anime with TMDB artwork
 * (episode stills, season posters, backdrops) when a TMDB key is configured.
 *
 * Design notes
 * ------------
 * - AniList already provides covers, banners, titles, and airing schedules, but
 *   it does NOT provide episode-level thumbnails. TMDB fills that gap.
 * - The TMDB API key lives ONLY on the server (`/api/tmdb/*`). This module just
 *   calls those proxy routes, scores the candidates, rejects low-confidence
 *   matches, and caches the winning match so we never re-search every render.
 * - When TMDB is not configured (or no confident match exists) every priority
 *   chain falls through to AniList artwork — the app keeps working unchanged.
 */
const ImageResolver = (function () {
  "use strict";

  const TMDB_IMG_BASE = "https://image.tmdb.org/t/p";
  const MATCH_CACHE_PREFIX = "zenkaitv:tmdb-match:v1:";
  const MATCH_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
  const FAILED_CACHE_KEY = "zenkaitv:img-failed:v1";
  const FAILED_CACHE_MAX = 400;
  const CONFIDENCE_THRESHOLD = 55; // below this we reject the TMDB match

  // Debug logging — on by default, silence with localStorage zenkaitv:img-debug=0
  function debugEnabled() {
    try { return localStorage.getItem("zenkaitv:img-debug") !== "0"; } catch { return true; }
  }
  function debug(...args) {
    if (debugEnabled()) console.debug("[ImageResolver]", ...args);
  }

  // ── TMDB image URL builders ────────────────────────────────────────────────
  function tmdbImage(path, size) {
    const p = String(path || "").trim();
    if (!p) return "";
    return `${TMDB_IMG_BASE}/${size}${p.startsWith("/") ? "" : "/"}${p}`;
  }
  const tmdbStillUrl   = (p) => tmdbImage(p, "w780");   // 16:9 episode still
  const tmdbBackdropUrl = (p) => tmdbImage(p, "w1280"); // wide cinematic backdrop
  const tmdbPosterUrl  = (p) => tmdbImage(p, "w500");   // vertical poster

  // ── Failed-image cache (so we never retry a known-broken URL) ───────────────
  let _failedMemory = null;
  function failedSet() {
    if (_failedMemory) return _failedMemory;
    _failedMemory = new Set();
    try {
      const raw = JSON.parse(localStorage.getItem(FAILED_CACHE_KEY) || "[]");
      if (Array.isArray(raw)) raw.forEach((u) => _failedMemory.add(u));
    } catch { /* ignore */ }
    return _failedMemory;
  }
  function markImageFailed(url) {
    const u = String(url || "").trim();
    if (!u) return;
    const set = failedSet();
    if (set.has(u)) return;
    set.add(u);
    try {
      const arr = [...set].slice(-FAILED_CACHE_MAX);
      localStorage.setItem(FAILED_CACHE_KEY, JSON.stringify(arr));
    } catch { /* quota — memory copy still works this session */ }
    debug("marked broken image, will skip from now on:", u);
  }
  function isImageFailed(url) {
    return failedSet().has(String(url || "").trim());
  }

  // Return the first usable image: non-empty, a real http(s)/data URL, and not
  // already known to be broken.
  function firstValidImage(candidates) {
    for (const candidate of candidates || []) {
      const url = String(candidate || "").trim();
      if (!url) continue;
      if (isImageFailed(url)) continue;
      if (!/^(https?:|data:|\/|\.\/)/i.test(url)) continue;
      return url;
    }
    return "";
  }

  // ── Title matching + confidence scoring ─────────────────────────────────────
  function norm(value) {
    // Local copy of the catalog's normalizeTitle so the resolver is standalone.
    if (typeof normalizeTitle === "function") return normalizeTitle(value);
    return String(value || "")
      .toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  }

  function tokenSimilarity(a, b) {
    const ta = new Set(norm(a).split(" ").filter(Boolean));
    const tb = new Set(norm(b).split(" ").filter(Boolean));
    if (!ta.size || !tb.size) return 0;
    let shared = 0;
    ta.forEach((t) => { if (tb.has(t)) shared += 1; });
    return shared / new Set([...ta, ...tb]).size; // Jaccard 0..1
  }

  // Best title-only score (0..100) between any AniList title/synonym and a
  // TMDB candidate name/original_name.
  function titleScore(anime, candidate) {
    const animeTitles = [
      anime.englishTitle, anime.romajiTitle, anime.nativeTitle,
      anime.title?.english, anime.title?.romaji, anime.title?.native,
      anime.title,
      ...(Array.isArray(anime.synonyms) ? anime.synonyms : [])
    ].map((t) => String(t || "").trim()).filter(Boolean);
    const candTitles = [candidate.name, candidate.original_name]
      .map((t) => String(t || "").trim()).filter(Boolean);

    let best = 0;
    for (const at of animeTitles) {
      for (const ct of candTitles) {
        const na = norm(at);
        const nc = norm(ct);
        if (!na || !nc) continue;
        let s;
        if (na === nc) s = 100;
        else if (na.includes(nc) || nc.includes(na)) s = 82;
        else s = Math.round(tokenSimilarity(at, ct) * 78);
        if (s > best) best = s;
      }
    }
    return best;
  }

  function yearOf(dateStr) {
    const m = /(\d{4})/.exec(String(dateStr || ""));
    return m ? Number(m[1]) : null;
  }

  // Final confidence: title score adjusted by air-year proximity. Big year gaps
  // are only forgiven when the title is a very strong match.
  function scoreCandidate(anime, candidate) {
    const tScore = titleScore(anime, candidate);
    const animeYear = Number(anime.seasonYear || anime.year || 0) || null;
    const candYear = yearOf(candidate.first_air_date);
    let yearAdj = 0;
    let reason = `title=${tScore}`;
    if (animeYear && candYear) {
      const diff = Math.abs(animeYear - candYear);
      if (diff === 0) yearAdj = 6;
      else if (diff === 1) yearAdj = -2;
      else if (diff === 2) yearAdj = tScore >= 85 ? -6 : -16;
      else yearAdj = tScore >= 90 ? -8 : -28;
      reason += ` year(${animeYear} vs ${candYear} Δ${diff})=${yearAdj}`;
    } else {
      reason += " year(n/a)";
    }
    const confidence = Math.max(0, Math.min(100, tScore + yearAdj));
    return { confidence, reason, tScore };
  }

  // ── Season mapping (AniList season/part -> TMDB season number) ──────────────
  function pickTmdbSeason(anime, tmdbShow) {
    const real = (tmdbShow.seasons || []).filter((s) => Number(s.season_number) > 0 && Number(s.episode_count) > 0);
    if (!real.length) return { season: null, reason: "no numbered TMDB seasons" };
    if (real.length === 1) return { season: real[0], reason: "only one TMDB season" };

    const animeSeasonNum = Number(anime.seasonNumber || 0) || null;
    const animeYear = Number(anime.seasonYear || anime.year || 0) || null;

    // 1) Match by air-date year (most reliable for split-cour anime).
    if (animeYear) {
      const byYear = real
        .map((s) => ({ s, diff: Math.abs((yearOf(s.air_date) || 9999) - animeYear) }))
        .sort((a, b) => a.diff - b.diff)[0];
      if (byYear && byYear.diff <= 1) return { season: byYear.s, reason: `year match (Δ${byYear.diff})` };
    }
    // 2) Match by season number when it lines up with a TMDB season.
    if (animeSeasonNum) {
      const bySeason = real.find((s) => Number(s.season_number) === animeSeasonNum);
      if (bySeason) return { season: bySeason, reason: "season number match" };
    }
    // 3) Uncertain — don't guess wrong; caller will keep AniList fallback for
    //    season-specific art but can still use show-level poster/backdrop.
    return { season: null, reason: "uncertain mapping — keeping AniList fallback" };
  }

  // ── TMDB enrichment ─────────────────────────────────────────────────────────
  function readMatchCache(anilistId) {
    try {
      const cached = JSON.parse(localStorage.getItem(MATCH_CACHE_PREFIX + anilistId) || "null");
      if (!cached || Date.now() - Number(cached.savedAt || 0) > MATCH_CACHE_TTL_MS) {
        if (cached) localStorage.removeItem(MATCH_CACHE_PREFIX + anilistId);
        return null;
      }
      return cached.data || null;
    } catch { return null; }
  }
  function writeMatchCache(anilistId, data) {
    try {
      localStorage.setItem(MATCH_CACHE_PREFIX + anilistId, JSON.stringify({ savedAt: Date.now(), data }));
    } catch { /* small TV storage quota — fine, we just re-resolve next time */ }
  }

  const _inFlight = new Set();
  let _tmdbConfigured = null; // null=unknown, true/false once a route has answered

  function applyResolvedMatch(anime, data) {
    if (!anime || !data) return;
    anime.tmdbId = data.tmdbId ?? anime.tmdbId ?? null;
    anime.tmdbMatchConfidence = data.confidence ?? anime.tmdbMatchConfidence ?? 0;
    anime.tmdbPoster = data.showPoster || anime.tmdbPoster || null;
    anime.tmdbBackdrop = data.showBackdrop || anime.tmdbBackdrop || null;
    anime.tmdbSeasonPoster = data.seasonPoster || anime.tmdbSeasonPoster || null;
    anime.tmdbEpisodeStills = data.episodeStills || anime.tmdbEpisodeStills || {};
    // Convenience bundle matching the documented imageSources shape.
    anime.imageSources = {
      poster: firstValidImage([anime.tmdbSeasonPoster, anime.tmdbPoster, anime.coverImageLarge, anime.image, anime.coverImage]) || null,
      backdrop: firstValidImage([anime.tmdbBackdrop, anime.bannerImage, anime.banner, anime.tmdbSeasonPoster, anime.coverImageLarge]) || null,
      banner: anime.bannerImage || anime.banner || null
    };
  }

  // Resolve + attach TMDB artwork to an anime object. Safe to call repeatedly;
  // it no-ops once resolved and dedupes concurrent calls.
  async function hydrateTmdbImages(anime) {
    if (!anime || anime._tmdbResolved) return anime;
    const anilistId = anime.anilistId || anime.id;
    if (!anilistId) return anime;
    if (_tmdbConfigured === false) return anime; // server already told us there's no key
    const flightKey = String(anilistId);
    if (_inFlight.has(flightKey)) return anime;
    _inFlight.add(flightKey);

    try {
      // Cached winning match?
      const cached = readMatchCache(anilistId);
      if (cached) {
        applyResolvedMatch(anime, cached);
        anime._tmdbResolved = true;
        debug(`cache hit for ${anilistId} → TMDB ${cached.tmdbId} (confidence ${cached.confidence})`);
        return anime;
      }

      // Search with the strongest titles first.
      const searchTitles = [
        anime.englishTitle || anime.title?.english,
        anime.romajiTitle || anime.title?.romaji,
        anime.nativeTitle || anime.title?.native,
        ...(Array.isArray(anime.synonyms) ? anime.synonyms.slice(0, 2) : [])
      ].map((t) => String(t || "").trim()).filter(Boolean);
      const seenTitles = new Set();
      const year = String(anime.seasonYear || anime.year || "");
      debug(`search titles for ${anilistId}:`, searchTitles, "year:", year || "—");

      const candidates = [];
      const seenIds = new Set();
      for (const title of searchTitles) {
        const key = norm(title);
        if (!key || seenTitles.has(key)) continue;
        seenTitles.add(key);
        let payload;
        try {
          const resp = await fetchWithTimeout(
            `./api/tmdb/search?q=${encodeURIComponent(title)}${year ? `&year=${encodeURIComponent(year)}` : ""}`,
            { cache: "no-store" }, 12000
          );
          payload = resp.ok ? await resp.json() : null;
        } catch { payload = null; }
        if (payload && payload.configured === false) {
          _tmdbConfigured = false;
          debug("TMDB not configured on server — using AniList artwork only.");
          return anime;
        }
        _tmdbConfigured = true;
        for (const r of (payload?.results || [])) {
          if (seenIds.has(r.id)) continue;
          seenIds.add(r.id);
          candidates.push(r);
        }
        // A confident exact-title hit early lets us stop searching synonyms.
        if (candidates.some((c) => titleScore(anime, c) >= 95)) break;
      }

      if (!candidates.length) {
        debug(`no TMDB candidates for ${anilistId} — AniList fallback.`);
        anime._tmdbResolved = true;
        return anime;
      }

      const scored = candidates
        .map((c) => ({ c, ...scoreCandidate(anime, c) }))
        .sort((a, b) => b.confidence - a.confidence);
      debug(`candidates for ${anilistId}:`, scored.map((s) => `${s.c.name} (#${s.c.id}) → ${s.confidence} [${s.reason}]`));

      const best = scored[0];
      if (!best || best.confidence < CONFIDENCE_THRESHOLD) {
        debug(`rejected best match for ${anilistId}: ${best?.c?.name} confidence ${best?.confidence} < ${CONFIDENCE_THRESHOLD}. AniList fallback.`);
        anime._tmdbResolved = true;
        return anime;
      }
      debug(`accepted TMDB #${best.c.id} "${best.c.name}" for ${anilistId} (confidence ${best.confidence}; ${best.reason})`);

      // Pull show-level art + season list.
      let show = null;
      try {
        const resp = await fetchWithTimeout(`./api/tmdb/tv?id=${encodeURIComponent(best.c.id)}`, { cache: "no-store" }, 12000);
        const payload = resp.ok ? await resp.json() : null;
        show = payload?.show || null;
      } catch { /* keep going with search-level paths below */ }

      const showPoster = tmdbPosterUrl(show?.poster_path || best.c.poster_path);
      const showBackdrop = tmdbBackdropUrl(show?.backdrop_path || best.c.backdrop_path);

      // Season-specific art (poster + episode stills) when we can map it.
      let seasonPoster = "";
      const episodeStills = {};
      if (show) {
        const { season, reason } = pickTmdbSeason(anime, show);
        if (season) {
          seasonPoster = tmdbPosterUrl(season.poster_path);
          debug(`season mapping for ${anilistId}: TMDB S${season.season_number} (${reason})`);
          try {
            const resp = await fetchWithTimeout(
              `./api/tmdb/season?id=${encodeURIComponent(best.c.id)}&season=${encodeURIComponent(season.season_number)}`,
              { cache: "no-store" }, 12000
            );
            const payload = resp.ok ? await resp.json() : null;
            for (const ep of (payload?.season?.episodes || [])) {
              const still = tmdbStillUrl(ep.still_path);
              if (ep.episode_number && still) episodeStills[ep.episode_number] = still;
            }
            debug(`fetched ${Object.keys(episodeStills).length} episode stills for ${anilistId}.`);
          } catch { /* show-level art still applies */ }
        } else {
          debug(`season mapping for ${anilistId}: ${reason}`);
        }
      }

      const resolved = {
        tmdbId: best.c.id,
        confidence: best.confidence,
        showPoster,
        showBackdrop,
        seasonPoster,
        episodeStills
      };
      applyResolvedMatch(anime, resolved);
      anime._tmdbResolved = true;
      writeMatchCache(anilistId, resolved);
      return anime;
    } finally {
      _inFlight.delete(flightKey);
    }
  }

  // ── Per-surface resolution (the documented priority chains) ─────────────────
  function getEpisodeStill(anime, episode) {
    if (!anime || !anime.tmdbEpisodeStills) return "";
    const num = Number(episode?.episode || episode?.episodeNumber || 0);
    return num ? (anime.tmdbEpisodeStills[num] || "") : "";
  }

  function resolveEpisodeThumbnail(episode, anime, tmdbData) {
    anime = anime || {};
    tmdbData = tmdbData || {};
    const url = firstValidImage([
      tmdbData.episodeStill || getEpisodeStill(anime, episode),
      episode?.image, episode?.thumbnail, episode?.still, episode?.snapshot,
      tmdbData.seasonPoster || anime.tmdbSeasonPoster,
      tmdbData.showPoster || anime.tmdbPoster,
      anime.bannerImage || anime.banner,
      anime.coverImageLarge,
      anime.coverImage || anime.image
    ]);
    return url || "";
  }

  function resolvePrePlayerBackground(episode, anime, tmdbData) {
    anime = anime || {};
    tmdbData = tmdbData || {};
    return firstValidImage([
      tmdbData.showBackdrop || anime.tmdbBackdrop,
      anime.highQualityBackground,
      anime.bannerImage || anime.banner,
      tmdbData.seasonPoster || anime.tmdbSeasonPoster,
      anime.coverImageLarge,
      episode && (episode.thumbnail || episode.image),
      anime.coverImage || anime.image
    ]) || "";
  }

  function resolvePrePlayerPoster(episode, anime, tmdbData) {
    anime = anime || {};
    tmdbData = tmdbData || {};
    return firstValidImage([
      tmdbData.seasonPoster || anime.tmdbSeasonPoster,
      tmdbData.showPoster || anime.tmdbPoster,
      anime.coverImageLarge,
      anime.coverImage || anime.image
    ]) || "";
  }

  return {
    firstValidImage,
    markImageFailed,
    isImageFailed,
    hydrateTmdbImages,
    getEpisodeStill,
    resolveEpisodeThumbnail,
    resolvePrePlayerBackground,
    resolvePrePlayerPoster,
    // exposed for tests / debugging
    scoreCandidate,
    titleScore,
    pickTmdbSeason
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = ImageResolver;
}
