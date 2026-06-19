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
  const MATCH_CACHE_PREFIX = "zenkaitv:tmdb-match:v11:";
  const MATCH_CACHE_TTL_MS = 1000 * 60 * 60 * 24; // Refresh airing episode stills daily.
  const FAILED_CACHE_KEY = "zenkaitv:img-failed:v1";
  const FAILED_CACHE_MAX = 400;
  const CONFIDENCE_THRESHOLD = 72; // reject loose matches that can attach the wrong anime artwork

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
  const tmdbStillUrl   = (p) => tmdbImage(p, "w780");    // 16:9 episode still
  const tmdbBackdropUrl = (p) => tmdbImage(p, "original"); // highest-quality wide backdrop
  const tmdbPosterUrl  = (p) => tmdbImage(p, "w780");    // high-resolution vertical poster

  // ── Failed-image cache (so we never retry a known-broken URL) ───────────────
  let _failedMemory = null;
  function failedSet() {
    if (_failedMemory) return _failedMemory;
    _failedMemory = new Set();
    try {
      localStorage.removeItem(FAILED_CACHE_KEY);
    } catch { /* ignore */ }
    return _failedMemory;
  }
  function markImageFailed(url) {
    const u = String(url || "").trim();
    if (!u) return;
    const set = failedSet();
    if (set.has(u)) return;
    set.add(u);
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
    let val = String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      // Preserve a-z, 0-9, Chinese ideographs, Hiragana, Katakana, and full-width alphanumeric
      .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uff10-\uff19\uff41-\uff5a\uff21-\uff3a]+/gi, " ");

    val = val.replace(/\bdiamond no ace\b/g, "ace of diamond")
             .replace(/\bdia no ace\b/g, "ace of diamond")
             .replace(/\bdaiya no ace\b/g, "ace of diamond")
             .replace(/\bshin seiki evangelion\b/g, "neon genesis evangelion")
             .replace(/\byofukashi no uta\b/g, "call of the night")
             .replace(/\byoukoso jitsuryoku shijou shugi no kyoushitsu e\b/g, "classroom of the elite")
             .replace(/\bclassroom of (?:the\s+)?elite.*\b/g, "classroom of the elite")
             .replace(/\bhime\s*kishi\s*wa\s*barbaroi\s*no\s*yome\b/g, "the warrior princess and the barbaric king")
             .replace(/\bkaoru hana wa rin to saku\b/g, "the fragrant flower blooms with dignity")
             .replace(/\bbleach sennen kessen hen.*\b/g, "bleach")
             .replace(/\bbleach thousand year blood war.*\b/g, "bleach")
             .replace(/\bjujutsu kaisen shimetsu kaiyu.*\b/g, "jujutsu kaisen")
             .replace(/\bjujutsu kaisen culling game.*\b/g, "jujutsu kaisen")
             .replace(/\bre zero.*\b/g, "re zero starting life in another world")
             .replace(/\btensei shitara slime datta ken.*\b/g, "that time i got reincarnated as a slime")
             .replace(/\bmairimashita\s*iruma\s*kun.*\b/g, "welcome to demon school iruma kun")
             .replace(/\bjidou hanbaiki ni umarekawatta ore wa meikyuu wo samayou.*\b/g, "reborn as a vending machine i now wander the dungeon")
             .replace(/\bhimesama\s*goumon\s*no jikan desu.*\b/g, "tis time for torture princess")
             .replace(/\benen no shouboutai.*\b/g, "fire force")
             .replace(/\bkanojo okarishimasu.*\b/g, "rent a girlfriend")
             .replace(/\byozakura\s*san\s*chi\s*no\s*daisakusen.*\b/g, "mission yozakura family")
             .replace(/\bsaikyou no shokugyou wa yuusha demo kenja demo naku kanteishi.*?\b/g, "the strongest job is apparently not a hero or a sage but an appraiser")
             .replace(/\byomi no tsugai\b/g, "daemons of the shadow realm")
             .replace(/\btongari boushi no atelier\b/g, "witch hat atelier")
             .replace(/\bjishou akuyaku reijou na konyakusha no kansatsu kiroku\b/g, "an observation log of my fiancee a self proclaimed villainess")
             .replace(/\bclass de 2\s*banme ni kawaii onnanoko to tomodachi ni natta\b/g, "i became friends with the second cutest girl in class")
             .replace(/\breplica datte koi wo suru\b/g, "even a replica wants to fall in love")
             .replace(/\bkuroneko to majo no kyoushitsu\b/g, "the classroom of a black cat and a witch")
             .replace(/\bkami no niwatsuki kusunoki\s*tei\b/g, "kusunoki s garden of gods")
             .replace(/\bmaidsan wa taberu dake\b/g, "the food diary of miss maid")
             .replace(/\bmaid san wa taberu dake\b/g, "the food diary of miss maid")
             .replace(/\bichijouma mankitsugurashi\b/g, "ichijyoma mankitsu gurashi")
             .replace(/\bingoku danchi\b/g, "ingoku danchi deviant s apartment complex")
             .replace(/\byuusha no kuzu\b/g, "scum of the brave")
             .replace(/\bhikaru ga shinda natsu\b/g, "the summer hikaru died")
             .replace(/\bboku no kokoro no yabai yatsu\b/g, "the dangers in my heart")
             .replace(/\bsummer\s*time\s*render\b/g, "summer time rendering")
             .replace(/\bsaiki kusuo no psi\s*nan\b/g, "the disastrous life of saiki k")
             .replace(/\bsaiki kusuo no\s*nan\b/g, "the disastrous life of saiki k")
             .replace(/\bmahou no shimai luluttolilly\b/g, "magical sisters luluttolilly")
             .replace(/\bhaikyuu to (?:the )?top\b/g, "haikyu")
             .replace(/\bhaikyuu\b/g, "haikyu")
             .replace(/\bponkotsu fuuki\s*iin to skirt take ga futekisetsu na jk no hanashi\b/g, "the klutzy class monitor and the girl with the short skirt")
             .replace(/\bponkotsu fuukiin to skirt take ga futekisetsu na jk no hanashi\b/g, "the klutzy class monitor and the girl with the short skirt");

    return val
      .replace(/\b(season|part|tv|ova|ona|the|a|an)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokenSimilarity(a, b) {
    const ta = new Set(norm(a).split(" ").filter(Boolean));
    const tb = new Set(norm(b).split(" ").filter(Boolean));
    if (!ta.size || !tb.size) return 0;
    let shared = 0;
    ta.forEach((t) => { if (tb.has(t)) shared += 1; });
    return shared / new Set([...ta, ...tb]).size; // Jaccard 0..1
  }

    function stripSequelWords(str) {
    return norm(str)
      .replace(/[第]?\s*\d+\s*[季期话話集]/g, "")
      .replace(/[第]\s*[一二三四五六七八九十\d]+\s*[季期话話集]/g, "")
      .replace(/\b\d+(st|nd|rd|th)\b/g, "")
      .replace(/\b(season|part|cour|capitulo|temp|temporada|act|stage|arc|saga|chapter|volume|version|edition|special|specials|ova|ona|movie|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/g, "")
      .replace(/\b(s\d+|p\d+|c\d+)\b/g, "")
      .replace(/\b\d+\b/g, "")
      .replace(/\b(ii|iii|iv|v|vi|vii|viii|ix|x)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
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

    const cleanSpaces = (s) => String(s || "").replace(/\s+/g, "");

    let best = 0;
    for (const at of animeTitles) {
      for (const ct of candTitles) {
        const na = norm(at);
        const nc = norm(ct);
        if (!na || !nc) continue;
        let s;
        if (na === nc) {
          s = 100;
        } else if (cleanSpaces(na) === cleanSpaces(nc)) {
          s = 98;
        } else {
          const sa = stripSequelWords(at);
          const sc = stripSequelWords(ct);
          if (sa && sc && (sa === sc || cleanSpaces(sa) === cleanSpaces(sc))) {
            s = 96;
          } else if (na.includes(nc) || nc.includes(na)) {
            s = 82;
          } else {
            s = Math.round(tokenSimilarity(at, ct) * 78);
          }
        }
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

    let genreAdj = 0;
    const genres = candidate.genre_ids || [];
    if (Array.isArray(genres) && genres.length > 0) {
      if (genres.includes(16)) {
        genreAdj = 15;
        reason += " genre(animation)=+15";
      } else {
        genreAdj = -35;
        reason += " genre(non-animation)=-35";
      }
    }

    const confidence = Math.max(0, Math.min(100, tScore + yearAdj + genreAdj));
    return { confidence, reason, tScore };
  }

  // ── Season mapping (AniList season/part -> TMDB season number) ──────────────
  function pickTmdbSeason(anime, tmdbShow) {
    const real = (tmdbShow.seasons || []).filter((s) => Number(s.season_number) > 0 && Number(s.episode_count) > 0);
    if (!real.length) return { season: null, reason: "no numbered TMDB seasons" };
    if (real.length === 1) return { season: real[0], reason: "only one TMDB season" };

    const titleToParse = anime.title || anime.romajiTitle || anime.englishTitle || "";
    const lowerTitle = (typeof titleToParse === "string" ? titleToParse : JSON.stringify(titleToParse)).toLowerCase();
    if (lowerTitle.includes("sennen kessen-hen") || lowerTitle.includes("thousand-year blood war")) {
      const tybwSeason = real.find((s) => s.name.toLowerCase().includes("thousand-year blood war"));
      if (tybwSeason) return { season: tybwSeason, reason: "Bleach Thousand-Year Blood War mapping" };
    }

    const animeTitles = [
      anime.title?.english, anime.title?.romaji, anime.title?.native,
      anime.englishTitle, anime.romajiTitle, anime.nativeTitle,
      anime.title,
      ...(Array.isArray(anime.synonyms) ? anime.synonyms : [])
    ].map((t) => norm(t)).filter(Boolean);

    for (const s of real) {
      const sName = norm(s.name);
      if (sName && sName.length > 4) {
        if (animeTitles.some(t => t.includes(sName) || sName.includes(t))) {
          return { season: s, reason: `season name match ("${s.name}")` };
        }
      }
    }

    let parsedSeasonNum = null;
    if (typeof SeasonNormalization !== "undefined") {
      parsedSeasonNum = SeasonNormalization.parseTitle(titleToParse).seasonNumber;
    }
    if (!parsedSeasonNum && typeof extractSeasonNumber === "function") {
      parsedSeasonNum = extractSeasonNumber(titleToParse, 1);
    }

    const animeSeasonNum = Number(anime.seasonNumber || parsedSeasonNum || 1);
    const animeYear = Number(anime.seasonYear || anime.year || 0) || null;

    // 1) Match by season number when it lines up with a TMDB season.
    if (animeSeasonNum) {
      const bySeason = real.find((s) => Number(s.season_number) === animeSeasonNum);
      if (bySeason) return { season: bySeason, reason: "season number match" };
    }
    // 2) Match by air-date year (most reliable for split-cour anime).
    if (animeYear) {
      const byYear = real
        .map((s) => ({ s, diff: Math.abs((yearOf(s.air_date) || 9999) - animeYear) }))
        .sort((a, b) => a.diff - b.diff)[0];
      if (byYear && byYear.diff <= 1) return { season: byYear.s, reason: `year match (Δ${byYear.diff})` };
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
    anime.tmdbEpisodesByNum = data.episodesByNum || anime.tmdbEpisodesByNum || {};
    anime.tmdbSeasons = data.seasons || anime.tmdbSeasons || [];
    // Convenience bundle matching the documented imageSources shape.
    anime.imageSources = {
      poster: firstValidImage([anime.tmdbSeasonPoster, anime.tmdbPoster, anime.coverImageLarge, anime.image, anime.coverImage]) || null,
      backdrop: firstValidImage([anime.tmdbBackdrop, anime.bannerImage, anime.banner, anime.tmdbSeasonPoster, anime.coverImageLarge]) || null,
      banner: anime.bannerImage || anime.banner || null
    };
    anime.images = {
      poster: firstValidImage([anime.tmdbSeasonPoster, anime.tmdbPoster, anime.coverImageLarge, anime.image, anime.coverImage]) || null,
      cover: anime.coverImageLarge || anime.image || anime.coverImage || null,
      banner: anime.bannerImage || anime.banner || null,
      backdrop: firstValidImage([anime.tmdbBackdrop, anime.bannerImage, anime.banner, anime.tmdbSeasonPoster, anime.coverImageLarge]) || null,
      thumbnail: firstValidImage([anime.tmdbSeasonPoster, anime.coverImageLarge, anime.image]) || null,
      episodeStill: null
    };
  }

  // ── Curated TMDB matches ────────────────────────────────────────────────────
  // A handful of shows can't be found by the fuzzy title search: their romaji
  // title differs too much from the TMDB English title ("Marriagetoxin" vs
  // "Marriage Toxin", "Kill Ao" vs "Kill Blue"), so the confidence check rejects
  // them. The result is the show banner repeated as every episode thumbnail and a
  // low-resolution backdrop. Pinning the TMDB id here forces the right match;
  // season/episode mapping then runs normally (franchise seasons still map by
  // number/year, e.g. Re:Zero S4, Rent-a-Girlfriend S5). Each entry lists the
  // title spellings we may receive from AniList or the scraper. ids verified on
  // themoviedb.org.
  const TMDB_ID_OVERRIDES = [
    // Bleach TYBW: the dedicated TMDB show (#308329) carries NO episode stills,
    // so every episode fell back to the show backdrop. Pin to the main Bleach
    // entry (#30984) whose "Thousand-Year Blood War" season DOES have stills;
    // pickTmdbSeason() already maps the Sennen Kessen-hen title to that season.
    { tmdb: 30984, names: ["Bleach: Sennen Kessen-hen", "Bleach Sennen Kessen-hen", "Bleach: Sennen Kessen-hen - Soukoku-tan", "Bleach: Sennen Kessen-hen - Ketsubetsu-tan", "Bleach: Sennen Kessen-hen - Soukatsu-tan", "Bleach: Thousand-Year Blood War"] },
    // Dr. STONE Science Future (TMDB S4). The base show's 2019 first-air year is
    // far from the 2025/2026 sequel year, so the fuzzy match was rejected; pin it
    // and let the "Science Future" season-name mapping select TMDB S4.
    { tmdb: 86031, names: ["Dr. Stone: Science Future", "Dr. STONE: SCIENCE FUTURE", "Dr. STONE Science Future", "Dr.Stone Science Future", "Dr. STONE 4th Season"] },
    // Daikenja Riddle no Jikan Gyakkou — TMDB English title is too different for
    // the fuzzy search ("The Regression of Great Sage Riddle").
    { tmdb: 313395, names: ["Daikenja Riddle no Jikan Gyakkou", "Daikenja no Jikan Gyakkou", "The Regression of Great Sage Riddle", "大賢者リドルの時間逆行"] },
    { tmdb: 290019, names: ["Class de 2-banme ni Kawaii Onnanoko to Tomodachi ni Natta", "I Made Friends with the Second Prettiest Girl in My Class", "I Became Friends with the Second Cutest Girl in the Class"] },
    { tmdb: 301944, names: ["Marriagetoxin", "Marriage Toxin"] },
    { tmdb: 300126, names: ["Liar Game"] },
    { tmdb: 196285, names: ["Isekai Nonbiri Nouka 2", "Isekai Nonbiri Nouka", "Farming Life in Another World"] },
    { tmdb: 65942,  names: ["Re:Zero kara Hajimeru Isekai Seikatsu 4th Season", "Re:Zero kara Hajimeru Isekai Seikatsu", "Re:ZERO -Starting Life in Another World-"] },
    { tmdb: 283428, names: ["Koori no Jouheki", "Koori no Jyouheki", "The Ramparts of Ice"] },
    { tmdb: 300131, names: ["Kill Ao", "Kill Blue"] },
    { tmdb: 273467, names: ["Himekishi wa Barbaroi no Yome", "Hime Kishi wa Barbaroi no Yome", "The Warrior Princess and the Barbaric King"] },
    { tmdb: 283905, names: ["Kamiina Botan, Yoeru Sugata wa Yuri no Hana", "Botan Kamiina Fully Blossoms When Drunk"] },
    { tmdb: 304820, names: ["Nigashita Sakana wa Ookikatta ga Tsuriageta Sakana ga Ookisugita Ken", "Always a Catch!"] },
    { tmdb: 96316,  names: ["Kanojo, Okarishimasu 5th Season", "Kanojo, Okarishimasu", "Kanojo Okarishimasu", "Rent-a-Girlfriend"] },
    // Original Bleach (2004, 366 eps) — fuzzy search may drift to wrong entries;
    // pin to the same TMDB show (#30984) that already carries seasons 1-16 plus TYBW.
    // Multi-season stills logic then maps global episode numbers across all TMDB seasons.
    { tmdb: 30984, names: ["Bleach"] },
    // NARUTO: Shippuuden — TMDB title is "Naruto: Shippuden" (21 seasons, 500 eps).
    // Without a pin the fuzzy search sometimes attaches the wrong Naruto entry.
    { tmdb: 46261, names: ["NARUTO: Shippuuden", "Naruto: Shippuuden", "Naruto Shippuden", "Naruto Shippuuden", "Naruto: Shippuden"] },
    // [Oshi no Ko] 2nd Season — brackets confuse the TMDB fuzzy search; pin to the
    // main entry (#130392) whose Season 2 carries 2024 episode stills.
    { tmdb: 130392, names: ["[Oshi no Ko] 2nd Season", "Oshi no Ko 2nd Season", "[Oshi no Ko] Season 2", "Oshi no Ko Season 2", "[Oshi no Ko]", "Oshi no Ko"] },
    // Tsue to Tsurugi no Wistoria — TMDB #245842 carries both S1 (2024) and S2 (2026).
    // The romaji title is long and the fuzzy search sometimes rejects it; pin so
    // pickTmdbSeason() can correctly map "2nd Season" to TMDB Season 2 stills.
    { tmdb: 245842, names: ["Tsue to Tsurugi no Wistoria", "Wistoria: Wand and Sword", "Wistoria Wand and Sword", "Tsue to Tsurugi no Wistoria 2nd Season", "Wistoria: Wand and Sword Season 2"] }
  ];

  // Compact key for override matching: lowercase, NFD-decompose, then drop every
  // non a-z/0-9 character (so accents, punctuation and spaces all collapse). The
  // curated names are all romaji/English, so dropping CJK is harmless. Independent
  // of norm()'s translation rules; matches raw titles across spelling/spacing
  // variants ("Re:Zero..." === "Re Zero...", "Marriagetoxin" === "Marriage Toxin").
  function overrideKey(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[^a-z0-9]+/g, "");
  }

  const _overrideIndex = (() => {
    const map = new Map();
    for (const entry of TMDB_ID_OVERRIDES) {
      for (const name of entry.names) {
        const key = overrideKey(name);
        if (key) map.set(key, entry.tmdb);
      }
    }
    return map;
  })();

  // Returns a pinned TMDB id when any of the anime's titles is in the curated
  // list, otherwise null (and the normal fuzzy search runs).
  function lookupTmdbOverride(anime) {
    if (!anime) return null;
    const titleObj = (anime.title && typeof anime.title === "object") ? anime.title : {};
    const titles = [
      typeof anime.title === "string" ? anime.title : "",
      anime.englishTitle, anime.romajiTitle, anime.nativeTitle,
      titleObj.english, titleObj.romaji, titleObj.native,
      ...(Array.isArray(anime.synonyms) ? anime.synonyms : [])
    ];
    for (const t of titles) {
      const key = overrideKey(t);
      if (key && _overrideIndex.has(key)) return _overrideIndex.get(key);
    }
    return null;
  }

  // Fetch show-level art + season list + episode stills for a known TMDB id and
  // assemble the resolved-match record. Shared by the fuzzy-match path and the
  // curated-override path. `searchResult` supplies fallback poster/backdrop paths
  // from a search hit for when the /tv detail fetch fails.
  async function buildResolvedFromTmdbId(anime, tmdbId, confidence, searchResult = {}) {
    const idLabel = anime.anilistId || anime.id;
    let show = null;
    try {
      const resp = await fetchWithTimeout(`/api/tmdb/tv?id=${encodeURIComponent(tmdbId)}`, { cache: "no-store" }, 12000);
      const payload = resp.ok ? await resp.json() : null;
      show = payload?.show || null;
    } catch { /* keep going with search-level paths below */ }

    const showPoster = tmdbPosterUrl(show?.poster_path || searchResult.poster_path);
    const showBackdrop = tmdbBackdropUrl(show?.backdrop_path || searchResult.backdrop_path);

    // Season-specific art (poster + episode stills) when we can map it.
    let seasonPoster = "";
    const episodeStills = {};
    const episodesByNum = {};
    if (show) {
      const { season, reason } = pickTmdbSeason(anime, show);
      if (season) {
        seasonPoster = tmdbPosterUrl(season.poster_path);
        debug(`season mapping for ${idLabel}: TMDB S${season.season_number} (${reason})`);
        try {
          const resp = await fetchWithTimeout(
            `/api/tmdb/season?id=${encodeURIComponent(tmdbId)}&season=${encodeURIComponent(season.season_number)}`,
            { cache: "no-store" }, 12000
          );
          const payload = resp.ok ? await resp.json() : null;
          const tmdbEpisodes = payload?.season?.episodes || [];

          // Check if we need to offset episodes (e.g. all seasons grouped under Season 1 on TMDB)
          let episodeOffset = 0;
          const animeYear = Number(anime.seasonYear || anime.year || 0);

          if (tmdbEpisodes.length > 12 && animeYear) {
            let matchingEp = tmdbEpisodes.find(ep => yearOf(ep.air_date) === animeYear);
            if (!matchingEp && animeYear) {
              matchingEp = tmdbEpisodes.find(ep => {
                const epYear = yearOf(ep.air_date);
                return epYear && Math.abs(epYear - animeYear) <= 1;
              });
            }
            if (matchingEp) {
              episodeOffset = matchingEp.episode_number - 1;
              debug(`Grouped season detected. Mapped AniList Season to TMDB S${season.season_number} starting at episode ${matchingEp.episode_number} (offset: ${episodeOffset})`);
            }
          }

          for (const ep of tmdbEpisodes) {
            const still = tmdbStillUrl(ep.still_path);
            let targetEpisodeNum = ep.episode_number;
            if (episodeOffset > 0) {
              targetEpisodeNum = ep.episode_number - episodeOffset;
            }
            if (targetEpisodeNum > 0) {
              if (still) episodeStills[targetEpisodeNum] = still;
              episodesByNum[targetEpisodeNum] = {
                episode: targetEpisodeNum,
                title: ep.name || "",
                description: ep.overview || "",
                aired: ep.air_date || "",
                thumbnail: still
              };
            }
          }
          debug(`fetched ${Object.keys(episodeStills).length} episode stills for ${idLabel}.`);
        } catch { /* show-level art still applies */ }
      } else {
        debug(`season mapping for ${idLabel}: ${reason}`);
      }
    }

    // ── Multi-season stills for long-running shows (Bleach, Naruto Shippuden, etc.)
    // For shows with >100 episodes split across multiple TMDB seasons, the single-
    // season fetch above only covers one arc. Here we fetch ALL seasons in parallel
    // and rebuild the stills map keyed by GLOBAL episode number (cumulative offset
    // across seasons), so episode 101 maps correctly to S3 ep 38, etc.
    const totalEps = Number(anime.totalEpisodes || anime.episodeCount || anime.episodes || 0);
    if (show && totalEps > 100 && real.length > 2) {
      // Wipe local-numbered stills from the single-season pass; rebuild globally.
      for (const k of Object.keys(episodeStills)) delete episodeStills[k];
      for (const k of Object.keys(episodesByNum)) delete episodesByNum[k];

      let _globalOffset = 0;
      // Compute per-season global offsets synchronously (before any await),
      // then fire all season fetches in parallel.
      const seasonJobs = real.map((s) => {
        const offset = _globalOffset;
        _globalOffset += Number(s.episode_count || 0);
        return { s, offset };
      });
      const fetchSeasonJob = async ({ s, offset }) => {
        try {
          const r = await fetchWithTimeout(
            `/api/tmdb/season?id=${encodeURIComponent(tmdbId)}&season=${encodeURIComponent(s.season_number)}`,
            { cache: "no-store" }, 10000
          );
          const payload = r.ok ? await r.json() : null;
          for (const ep of (payload?.season?.episodes || [])) {
            const globalNum = offset + Number(ep.episode_number);
            const still = tmdbStillUrl(ep.still_path);
            if (still && !episodeStills[globalNum]) episodeStills[globalNum] = still;
            if (!episodesByNum[globalNum]) {
              episodesByNum[globalNum] = {
                episode: globalNum, title: ep.name || "",
                description: ep.overview || "", aired: ep.air_date || "", thumbnail: still
              };
            }
          }
        } catch { /* season unavailable — skip */ }
      };
      for (let i = 0; i < seasonJobs.length; i += 4) {
        await Promise.allSettled(seasonJobs.slice(i, i + 4).map(fetchSeasonJob));
      }
      debug(`multi-season: ${Object.keys(episodeStills).length} global stills for ${idLabel} (${real.length} seasons)`);
    }

    return {
      tmdbId,
      confidence,
      showPoster,
      showBackdrop,
      seasonPoster,
      episodeStills,
      episodesByNum,
      seasons: show?.seasons || []
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
      // Curated override: pin the correct TMDB id for shows the fuzzy search
      // can't match by title. Checked alongside the cache so the pin always wins,
      // but a cache entry that already agrees with the pin is reused.
      const overrideId = lookupTmdbOverride(anime);

      // Cached winning match? (reuse only when it doesn't contradict the override)
      const cached = readMatchCache(anilistId);
      if (cached && (!overrideId || Number(cached.tmdbId) === Number(overrideId))) {
        applyResolvedMatch(anime, cached);
        anime._tmdbResolved = true;
        debug(`cache hit for ${anilistId} → TMDB ${cached.tmdbId} (confidence ${cached.confidence})`);
        return anime;
      }

      if (overrideId) {
        debug(`override: pinning TMDB #${overrideId} for ${anilistId} ("${anime.romajiTitle || anime.title || ""}")`);
        const resolved = await buildResolvedFromTmdbId(anime, overrideId, 100);
        applyResolvedMatch(anime, resolved);
        anime._tmdbResolved = true;
        // Don't cache a transient failure (no art came back) — retry next open.
        if (resolved.showBackdrop || resolved.showPoster || Object.keys(resolved.episodeStills).length) {
          writeMatchCache(anilistId, resolved);
        }
        return anime;
      }

      // Search with the strongest titles first.
      const rawTitles = [
        typeof anime.title === "string" ? anime.title : "",
        anime.englishTitle || anime.title?.english,
        anime.romajiTitle || anime.title?.romaji,
        anime.nativeTitle || anime.title?.native,
        ...(Array.isArray(anime.synonyms) ? anime.synonyms.slice(0, 2) : [])
      ].map((t) => String(t || "").trim()).filter(Boolean);

      const searchTitles = [];
      const seenSearchTitles = new Set();
      for (const t of rawTitles) {
        const normRaw = norm(t);
        if (normRaw && !seenSearchTitles.has(normRaw)) {
          seenSearchTitles.add(normRaw);
          // If the normalized title is different from the lowercase original title,
          // it means a title translation mapping rule was applied. Push it so we search TMDB with it first!
          const cleanT = String(t).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
          if (normRaw !== cleanT) {
            searchTitles.push(normRaw);
          }
          searchTitles.push(t);
        }
        const stripped = stripSequelWords(t);
        if (stripped && stripped.length > 2 && !seenSearchTitles.has(stripped)) {
          seenSearchTitles.add(stripped);
          searchTitles.push(stripped);
        }
      }
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
          let resp = await fetchWithTimeout(
            `/api/tmdb/search?q=${encodeURIComponent(title)}${year ? `&year=${encodeURIComponent(year)}` : ""}`,
            { cache: "no-store" }, 12000
          );
          payload = resp.ok ? await resp.json() : null;
          if ((!payload || !payload.results || !payload.results.length) && year) {
            resp = await fetchWithTimeout(
              `/api/tmdb/search?q=${encodeURIComponent(title)}`,
              { cache: "no-store" }, 12000
            );
            payload = resp.ok ? await resp.json() : null;
          }
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
      if (!best || best.confidence < CONFIDENCE_THRESHOLD || best.tScore < 72) {
        debug(`rejected best match for ${anilistId}: ${best?.c?.name} confidence ${best?.confidence} < ${CONFIDENCE_THRESHOLD}. AniList fallback.`);
        anime._tmdbResolved = true;
        return anime;
      }
      debug(`accepted TMDB #${best.c.id} "${best.c.name}" for ${anilistId} (confidence ${best.confidence}; ${best.reason})`);

      const resolved = await buildResolvedFromTmdbId(anime, best.c.id, best.confidence, best.c);
      applyResolvedMatch(anime, resolved);
      anime._tmdbResolved = true;
      writeMatchCache(anilistId, resolved);
      return anime;
    } finally {
      _inFlight.delete(flightKey);
    }
  }

  // ── Per-surface resolution (the documented priority chains) ─────────────────
  function getEpisodeStill(anime, episode, appSeasonNumber) {
    if (!anime) return "";
    const num = Number(episode?.episode || episode?.episodeNumber || 0);
    if (!num) return "";
    // Season-aware first: multi-season shows keyed by a single flat episode number
    // would make every season reuse Season 1's stills (ep 1 collides with ep 1).
    // When a per-season map has been loaded for this app season it is authoritative
    // — return its still or "" (never bleed in another season's art).
    const sNum = Number(appSeasonNumber || 0);
    if (sNum && anime.tmdbStillsBySeason && anime.tmdbStillsBySeason[sNum]) {
      const scoped = anime.tmdbStillsBySeason[sNum];
      if (scoped[num]) return scoped[num];
      const localMax = Math.max(0, ...Object.keys(scoped).map((key) => Number(key) || 0));
      if (num <= localMax) return "";
    }
    if (!anime.tmdbEpisodeStills) return "";
    return anime.tmdbEpisodeStills[num] || "";
  }

  function resolveEpisodeThumbnail(episode, anime, tmdbData) {
    anime = anime || {};
    tmdbData = tmdbData || {};
    const url = firstValidImage([
      tmdbData.episodeStill !== undefined ? tmdbData.episodeStill : getEpisodeStill(anime, episode),
      episode?.image, episode?.thumbnail, episode?.still, episode?.snapshot
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

  function findTmdbSeasonForEpisode(anime, episodeNumber) {
    const seasons = anime.tmdbSeasons || [];
    if (!seasons.length) return null;
    const numberedSeasons = seasons
      .filter((s) => Number(s.season_number) > 0)
      .sort((a, b) => a.season_number - b.season_number);
    let accumulated = 0;
    for (const s of numberedSeasons) {
      const count = Number(s.episode_count || 0);
      if (episodeNumber > accumulated && episodeNumber <= accumulated + count) {
        return {
          seasonNumber: s.season_number,
          episodeOffset: accumulated
        };
      }
      accumulated += count;
    }
    return null;
  }

  const _lazyFetching = new Set();
  async function lazyFetchEpisodeStill(anime, episodeNumber) {
    if (!anime || !anime.tmdbId || !episodeNumber) return;
    const mapping = findTmdbSeasonForEpisode(anime, episodeNumber);
    if (!mapping) return;
    if (anime._tmdbSeasonsLoaded && anime._tmdbSeasonsLoaded.has(mapping.seasonNumber)) return;
    const key = `${anime.anilistId || anime.id}:${mapping.seasonNumber}`;
    if (_lazyFetching.has(key)) return;
    _lazyFetching.add(key);
    try {
      debug(`Lazy fetching TMDB season S${mapping.seasonNumber} for show ${anime.anilistId || anime.id} (contains absolute episode ${episodeNumber})...`);
      const url = `/api/tmdb/season?id=${encodeURIComponent(anime.tmdbId)}&season=${encodeURIComponent(mapping.seasonNumber)}`;
      const resp = typeof fetchWithTimeout === "function"
        ? await fetchWithTimeout(url, { cache: "no-store" }, 12000)
        : await fetch(url);
      const payload = resp.ok ? await resp.json() : null;
      const eps = payload?.season?.episodes || [];
      let changed = false;
      const maxEpNum = eps.length ? Math.max(...eps.map(e => Number(e.episode_number || 0))) : 0;
      const isAbsoluteNumbering = maxEpNum > eps.length;
      for (const ep of eps) {
        const still = tmdbStillUrl(ep.still_path);
        const absoluteEpNum = isAbsoluteNumbering ? Number(ep.episode_number) : (mapping.episodeOffset + Number(ep.episode_number));
        if (still) {
          if (!anime.tmdbEpisodeStills) anime.tmdbEpisodeStills = {};
          anime.tmdbEpisodeStills[absoluteEpNum] = still;
          changed = true;
        }
        if (!anime.tmdbEpisodesByNum) anime.tmdbEpisodesByNum = {};
        anime.tmdbEpisodesByNum[absoluteEpNum] = {
          episode: absoluteEpNum,
          title: ep.name || "",
          description: ep.overview || "",
          aired: ep.air_date || "",
          thumbnail: still
        };
      }
      if (changed) {
        debug(`Lazy fetched S${mapping.seasonNumber} for show ${anime.anilistId || anime.id}. Triggering repaint.`);
        if (typeof render === "function") render();
        if (typeof renderEpisodeList === "function" && typeof state !== "undefined" && state.activeShow?.id === anime.id) {
          renderEpisodeList(state.activeShow);
        }
      }
    } catch (err) {
      debug(`Lazy fetch failed: ${err.message}`);
    } finally {
      if (!anime._tmdbSeasonsLoaded) anime._tmdbSeasonsLoaded = new Set();
      anime._tmdbSeasonsLoaded.add(mapping.seasonNumber);
      _lazyFetching.delete(key);
    }
  }

  // ── Season-aware episode stills (multi-season shows) ────────────────────────
  // A show that is presented as ONE catalog entry with several seasons (each
  // numbered 1..N) cannot use the flat tmdbEpisodeStills map: Season 2 episode 1
  // would collide with Season 1 episode 1. For these we resolve the TMDB season
  // that matches the *active* app season and store its stills under that season
  // number, rebased to local 1..N so they line up with the displayed list.
  function mapAppSeasonToTmdb(anime, appSeasonNumber, appSeasonMeta) {
    const seasons = anime.tmdbSeasons || [];
    if (!seasons.length) return null;
    const meta = appSeasonMeta || {};
    const pseudo = {
      title: meta.sourceTitle || meta.title || anime.title,
      romajiTitle: anime.romajiTitle,
      englishTitle: anime.englishTitle,
      nativeTitle: anime.nativeTitle,
      synonyms: anime.synonyms,
      seasonNumber: appSeasonNumber,
      seasonYear: meta.year || meta.startYear || (meta.startDate && meta.startDate.year) ||
                  anime.seasonYear || anime.year
    };
    const { season } = pickTmdbSeason(pseudo, { seasons });
    return season ? Number(season.season_number) : null;
  }

  const _seasonStillsFetching = new Set();
  async function ensureSeasonStills(anime, appSeasonNumber, appSeasonMeta) {
    if (!anime || !anime.tmdbId) return;
    const sNum = Number(appSeasonNumber || 0);
    if (!sNum) return;
    // Already resolved (or tried) — don't re-fetch on every repaint.
    if (anime.tmdbStillsBySeason && anime.tmdbStillsBySeason[sNum]) return;
    if (anime._seasonStillsTried && anime._seasonStillsTried.has(sNum)) return;
    const tmdbSeasonNumber = mapAppSeasonToTmdb(anime, sNum, appSeasonMeta);
    if (!tmdbSeasonNumber) return;
    const key = `${anime.anilistId || anime.id}:app${sNum}`;
    if (_seasonStillsFetching.has(key)) return;
    _seasonStillsFetching.add(key);
    try {
      const url = `/api/tmdb/season?id=${encodeURIComponent(anime.tmdbId)}&season=${encodeURIComponent(tmdbSeasonNumber)}`;
      const resp = typeof fetchWithTimeout === "function"
        ? await fetchWithTimeout(url, { cache: "no-store" }, 12000)
        : await fetch(url);
      const payload = resp.ok ? await resp.json() : null;
      const eps = payload?.season?.episodes || [];
      if (!eps.length) return;
      // TMDB seasons sometimes number episodes absolutely (e.g. Naruto S5 = 89..),
      // so rebase to 1..N against the season's lowest episode number.
      const nums = eps.map((e) => Number(e.episode_number || 0)).filter((n) => n > 0);
      const minEp = nums.length ? Math.min(...nums) : 1;
      const offset = minEp > 0 ? minEp - 1 : 0;
      const stills = {};
      const metas = {};
      for (const ep of eps) {
        const local = Number(ep.episode_number) - offset;
        if (local <= 0) continue;
        const still = tmdbStillUrl(ep.still_path);
        if (still) stills[local] = still;
        metas[local] = {
          episode: local,
          title: ep.name || "",
          description: ep.overview || "",
          aired: ep.air_date || "",
          thumbnail: still
        };
      }
      if (!anime.tmdbStillsBySeason) anime.tmdbStillsBySeason = {};
      if (!anime.tmdbEpisodesBySeasonNum) anime.tmdbEpisodesBySeasonNum = {};
      anime.tmdbStillsBySeason[sNum] = stills;
      anime.tmdbEpisodesBySeasonNum[sNum] = metas;
      debug(`season-aware: app S${sNum} -> TMDB S${tmdbSeasonNumber} (${Object.keys(stills).length} stills)`);
      if (typeof renderEpisodeList === "function" && typeof state !== "undefined" &&
          state.activeShow && state.activeShow.id === anime.id) {
        renderEpisodeList(state.activeShow);
      }
    } catch (err) {
      debug(`season-aware fetch failed: ${err && err.message}`);
    } finally {
      if (!anime._seasonStillsTried) anime._seasonStillsTried = new Set();
      anime._seasonStillsTried.add(sNum);
      _seasonStillsFetching.delete(key);
    }
  }

  // Per-season episode metadata (title/aired/still), preferring the season-aware
  // map when present, falling back to the flat one. Returns null when unknown.
  function getSeasonEpisodeMeta(anime, appSeasonNumber, episodeNumber) {
    if (!anime) return null;
    const sNum = Number(appSeasonNumber || 0);
    const num = Number(episodeNumber || 0);
    if (!num) return null;
    if (sNum && anime.tmdbEpisodesBySeasonNum && anime.tmdbEpisodesBySeasonNum[sNum]) {
      const scoped = anime.tmdbEpisodesBySeasonNum[sNum];
      if (scoped[num]) return scoped[num];
      const localMax = Math.max(0, ...Object.keys(scoped).map((key) => Number(key) || 0));
      if (num <= localMax) return null;
    }
    return anime.tmdbEpisodesByNum ? (anime.tmdbEpisodesByNum[num] || null) : null;
  }

  return {
    firstValidImage,
    markImageFailed,
    isImageFailed,
    hydrateTmdbImages,
    getEpisodeStill,
    ensureSeasonStills,
    getSeasonEpisodeMeta,
    resolveEpisodeThumbnail,
    resolvePrePlayerBackground,
    resolvePrePlayerPoster,
    findTmdbSeasonForEpisode,
    lazyFetchEpisodeStill,
    // exposed for tests / debugging
    scoreCandidate,
    titleScore,
    pickTmdbSeason
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = ImageResolver;
}
