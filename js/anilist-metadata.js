// AniList Metadata Service
// ─────────────────────────────────────────────────────────────────────────────
// Provides season / episode metadata from AniList.  Video URLs and playback
// sources are NEVER touched here — they stay with the existing provider layer.
//
// Public API (called from client.js):
//   hydrateShowAniListFranchise(show)   → enriches show.anilistFranchise
//   buildSeasonListFromAniListFranchise(show, state) → season array for UI
//   makePlaceholderEpisodesFromAniList(entry)        → locked episode array
//
// Depends on: constants.js, utils.js (normalizeTitle, fetchWithTimeout)
// ─────────────────────────────────────────────────────────────────────────────

// ── Franchise version ────────────────────────────────────────────────────────
// Bump this whenever traversal/merge logic changes so every show gets a fresh
// franchise rebuild on next open (in-memory cached franchises become stale).
const _FRANCHISE_VERSION = 9;          // traverse through any-format chain, but only display real seasons (no bonus OVAs)
const _MEDIA_CACHE_VERSION_KEY = "animetv-anilist-cache-v";
const _MEDIA_CACHE_VERSION_VAL = "9";  // clears stale localStorage media cache

// On first load, clear any localStorage AniList media cache that was built with
// an older code version.  This prevents stale data from persisting across
// deployments.
try {
  if (localStorage.getItem(_MEDIA_CACHE_VERSION_KEY) !== _MEDIA_CACHE_VERSION_VAL) {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(ANILIST_META_CACHE_PREFIX)) keysToRemove.push(k);
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
    localStorage.setItem(_MEDIA_CACHE_VERSION_KEY, _MEDIA_CACHE_VERSION_VAL);
  }
} catch { /* storage access may fail on TV browsers */ }

// ── In-memory cache (survives re-renders, cleared on page reload) ────────────
const _anilistMemCache = new Map();

function _readAniListCache(key) {
  const mem = _anilistMemCache.get(key);
  if (mem && Date.now() - mem.ts < ANILIST_META_CACHE_TTL) return mem.data;
  if (mem) _anilistMemCache.delete(key);
  try {
    const raw = JSON.parse(localStorage.getItem(`${ANILIST_META_CACHE_PREFIX}${key}`) || "null");
    if (!raw || !raw.ts || Date.now() - raw.ts > ANILIST_META_CACHE_TTL) {
      localStorage.removeItem(`${ANILIST_META_CACHE_PREFIX}${key}`);
      return null;
    }
    _anilistMemCache.set(key, raw);
    return raw.data;
  } catch { return null; }
}

function _writeAniListCache(key, data, ttl = ANILIST_META_CACHE_TTL) {
  const entry = { ts: Date.now(), data };
  _anilistMemCache.set(key, entry);
  try {
    localStorage.setItem(`${ANILIST_META_CACHE_PREFIX}${key}`, JSON.stringify(entry));
  } catch { /* best-effort on TV browsers */ }
}

// ── Server proxy calls ───────────────────────────────────────────────────────

async function _fetchAniListMedia(anilistId) {
  const key = `media:${anilistId}`;
  const cached = _readAniListCache(key);
  if (cached) return cached;
  try {
    const res = await fetchWithTimeout(
      `${ANILIST_MEDIA_ENDPOINT}?id=${encodeURIComponent(anilistId)}`, {}, 12000
    );
    if (!res.ok) return null;
    const json = await res.json();
    if (!json?.ok || !json.media) return null;
    _writeAniListCache(key, json.media);
    return json.media;
  } catch { return null; }
}

async function _searchAniListAnime(title) {
  const normKey = normalizeTitle(title);
  if (!normKey) return null;
  const key = `search:${normKey}`;
  const cached = _readAniListCache(key);
  if (cached) return cached;
  try {
    const res = await fetchWithTimeout(
      `${ANILIST_SEARCH_ENDPOINT}?q=${encodeURIComponent(title)}`, {}, 12000
    );
    if (!res.ok) return null;
    const json = await res.json();
    if (!json?.ok || !json.media) return null;
    _writeAniListCache(key, json.media, ANILIST_SEARCH_CACHE_TTL);
    return json.media;
  } catch { return null; }
}

// ── Best-match resolution ────────────────────────────────────────────────────

function _titlesOf(node) {
  const t = node?.title || {};
  return [t.english, t.userPreferred, t.romaji, t.native].filter(Boolean);
}

function _matchScore(media, show) {
  const showNorm = normalizeTitle(show.title);
  if (!showNorm) return 0;
  const candidates = [
    ..._titlesOf(media).map(normalizeTitle),
    ...(media.synonyms || []).map(normalizeTitle)
  ].filter(Boolean);
  if (candidates.some(c => c === showNorm)) return 100;
  if (candidates.some(c => c.includes(showNorm) || showNorm.includes(c))) return 70;
  return 0;
}

async function _resolveAniListMedia(show) {
  // 1. Direct AniList ID — most reliable, zero ambiguity
  if (show.anilistId) {
    const m = await _fetchAniListMedia(show.anilistId);
    if (m) return m;
  }

  // 2. Try every known title variant.  Deduplicate so we don't hit the API
  //    multiple times for the same string.
  const seen  = new Set();
  const candidates = [
    show.title,
    show.romajiTitle,
    show.nativeTitle,
    ...(show.aliases || [])
  ].filter(t => {
    const norm = normalizeTitle(t || "");
    if (!norm || seen.has(norm)) return false;
    seen.add(norm);
    return true;
  });

  for (const t of candidates) {
    const m = await _searchAniListAnime(t);
    if (!m) continue;
    const score = _matchScore(m, show);
    // Accept high-confidence matches; for a franchise search a score of 70 is
    // enough since synonyms are broad.
    if (score >= 70) return m;
  }
  return null;
}

// ── Normalization helpers ────────────────────────────────────────────────────

function _sortByAirDate(a, b) {
  const ay = a.seasonYear || a.startDate?.year || 9999;
  const by = b.seasonYear || b.startDate?.year || 9999;
  if (ay !== by) return ay - by;
  const am = a.startDate?.month || 0;
  const bm = b.startDate?.month || 0;
  if (am !== bm) return am - bm;
  return (a.startDate?.day || 0) - (b.startDate?.day || 0);
}

function _normalizeRelationNode(node) {
  const nextEp = node.nextAiringEpisode?.episode;
  const latestAired = nextEp && nextEp > 1 ? nextEp - 1 : null;
  const title = node.title?.english || node.title?.userPreferred ||
                node.title?.romaji  || node.title?.native || "";
  return {
    anilistId:       node.id,
    malId:           node.idMal || null,
    title,
    romajiTitle:     node.title?.romaji  || "",
    nativeTitle:     node.title?.native  || "",
    format:          node.format  || "TV",
    status:          node.status  || "",
    season:          node.season  || null,
    seasonYear:      node.seasonYear || node.startDate?.year || null,
    startDate:       node.startDate || null,
    episodes:        node.episodes || null,
    latestAiredEp:   latestAired,
    nextAiringEp:    nextEp || null,
    image:           node.coverImage?.extraLarge || node.coverImage?.large || "",
    banner:          node.bannerImage || "",
    description:     node.description || "",
    genres:          node.genres || [],
    score:           node.averageScore || null,
  };
}

// Does this title carry an explicit season/part/final designation? Used to tell
// a real continuation (e.g. AoT "Final Chapters", "...Part 2") apart from a
// bonus side-entry that AniList happens to wire into the SEQUEL chain.
function _hasSeasonDesignation(title) {
  const t = String(title || "").toLowerCase();
  return /\b(season|part|cour|final|chapter|chapters|kanketsu)\b/.test(t)
      || /\d+\s*(st|nd|rd|th)\s+(season|part|cour)/.test(t);
}

// Should a chain entry be DISPLAYED as a numbered season? We still traverse
// through every format to discover the whole chain (some franchises route the
// SEQUEL link through a bonus OVA, e.g. Tensei Slime's "Coleus no Yume"), but
// only real seasons should show up in the season list:
//   • TV / TV_SHORT / ONA           → always a season
//   • SPECIAL / OVA / MOVIE         → only if the title marks a continuation
//                                     (AoT "THE FINAL CHAPTERS Special 1/2")
function _isDisplaySeason(node) {
  const fmt = String(node?.format || "").toUpperCase();
  if (fmt === "TV" || fmt === "TV_SHORT" || fmt === "ONA") return true;
  return _hasSeasonDesignation(node?.title || node?.romajiTitle);
}

// ── Full franchise traversal ─────────────────────────────────────────────────
//
// AniList relations are a LINKED LIST, not a star graph:
//   S4 --PREQUEL--> S3 --PREQUEL--> S2b --PREQUEL--> S2a --PREQUEL--> S1
// Opening S4 only gives S3 as a direct relation. To find S1–S4 we must
// traverse PREQUEL links back to the root, then SEQUEL links forward.
//
// Strategy:
//   1. Follow PREQUEL links (≤8 hops) to find the oldest entry (franchise root).
//   2. From the root, follow SEQUEL links (≤8 hops) to collect all TV seasons.
//   3. Along the way, collect any Movie/OVA/Special side entries.
//   4. Cache every media object fetched so revisits are instant.

async function _traverseFranchise(startMedia) {
  // nodeMap  → id : { node (normalized), fullMedia (full AniList object or null) }
  // fetched  → Set of ids for which we have fullMedia + their relations processed
  //
  // KEY INSIGHT: collectSideEntries() adds shallow nodes to nodeMap so they
  // show up in the final list, but we must NOT use nodeMap membership as the
  // "already visited" guard for traversal — a shallow node hasn't had its own
  // relations explored yet.  We use `fetched` for that guard instead.
  const nodeMap = new Map();
  const fetched  = new Set(); // ids whose fullMedia + relations are fully processed
  const mainline = new Set(); // ids on the PREQUEL/SEQUEL story chain (the seasons)
  const MAX_HOPS = 12;

  function addMedia(media, relationType = null) {
    if (!media?.id) return;
    const node = _normalizeRelationNode({
      ...media,
      coverImage: media.coverImage,
      bannerImage: media.bannerImage,
    });
    if (relationType) node.relationType = relationType;
    nodeMap.set(media.id, { node, fullMedia: media });
    fetched.add(media.id);
  }

  function addNode(rawNode, relationType) {
    if (!rawNode?.id) return;
    if (!nodeMap.has(rawNode.id)) {
      const node = _normalizeRelationNode(rawNode);
      node.relationType = relationType;
      nodeMap.set(rawNode.id, { node, fullMedia: null });
    }
  }

  // Collect non-TV side entries (Movies/OVAs/Specials) from a fully-fetched media.
  // TV-format entries are handled by the traversal loops, not here.
  function collectSideEntries(media) {
    for (const edge of media.relations?.edges || []) {
      const { relationType, node } = edge;
      if (node.type !== "ANIME") continue;
      if (!ANILIST_FRANCHISE_RELATIONS.has(relationType)) continue;
      // Only add as a shallow node; TV entries are traversed explicitly below
      addNode(node, relationType);
    }
  }

  // ── Step 1: seed with the entry the user opened ──────────────────────────
  addMedia(startMedia);
  mainline.add(startMedia.id);
  collectSideEntries(startMedia);

  // ── Step 2: follow PREQUEL links back to the franchise root ──────────────
  // Follow the prequel of ANY format (TV/ONA/Special/Movie) so a "Final Chapters"
  // special walks back to its TV parent. Guard with `fetched`, not `nodeMap`.
  let current = startMedia;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const prequelEdge = (current.relations?.edges || [])
      .filter(e =>
        e.relationType === "PREQUEL" &&
        e.node.type === "ANIME" &&
        !fetched.has(e.node.id))
      .sort((a, b) => (a.node.seasonYear || 9999) - (b.node.seasonYear || 9999))[0];

    if (!prequelEdge) break;

    const prequelMedia = await _fetchAniListMedia(prequelEdge.node.id);
    if (!prequelMedia) {
      addNode(prequelEdge.node, "PREQUEL");
      mainline.add(prequelEdge.node.id);
      break;
    }

    addMedia(prequelMedia, "PREQUEL");
    mainline.add(prequelMedia.id);
    collectSideEntries(prequelMedia);
    current = prequelMedia;
  }

  // ── Step 3: follow SEQUEL links forward from the root ────────────────────
  // The root is the oldest entry we've fetched (usually the S1 TV series).
  const mainlineFetched = [...nodeMap.values()]
    .filter(v => mainline.has(v.node.anilistId) && v.fullMedia)
    .sort((a, b) => _sortByAirDate(a.node, b.node));

  const root = mainlineFetched[0];
  if (!root) {
    for (const [id, v] of nodeMap) v.node.mainline = mainline.has(id) && _isDisplaySeason(v.node);
    return nodeMap;
  }

  current = root.fullMedia;

  // Follow SEQUEL of ANY format — the main story line can end in a "Final Chapters"
  // SPECIAL or a continuation MOVIE, which must still appear as the final season(s).
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const sequelEdge = (current.relations?.edges || [])
      .filter(e =>
        e.relationType === "SEQUEL" &&
        e.node.type === "ANIME" &&
        !fetched.has(e.node.id))
      .sort((a, b) => (a.node.seasonYear || 9999) - (b.node.seasonYear || 9999))[0];

    if (!sequelEdge) break;

    const sequelMedia = await _fetchAniListMedia(sequelEdge.node.id);
    if (!sequelMedia) {
      addNode(sequelEdge.node, "SEQUEL");
      mainline.add(sequelEdge.node.id);
      break;
    }

    addMedia(sequelMedia, "SEQUEL");
    mainline.add(sequelMedia.id);
    collectSideEntries(sequelMedia);
    current = sequelMedia;
  }

  // ── Step 4: mop up any shallow mainline nodes (multi-pass until stable) ───
  for (let pass = 0; pass < 5; pass++) {
    const pending = [...nodeMap.values()]
      .filter(v => mainline.has(v.node.anilistId) && !v.fullMedia);
    if (!pending.length) break;

    await Promise.allSettled(pending.map(async ({ node }) => {
      const media = await _fetchAniListMedia(node.anilistId);
      if (media) { addMedia(media); mainline.add(media.id); collectSideEntries(media); }
    }));
  }

  // Tag every node with whether it should DISPLAY as a mainline season. We keep
  // traversing through any-format chain links above, but bonus OVAs/movies that
  // merely sit on the SEQUEL chain are demoted to extras here.
  for (const [id, v] of nodeMap) v.node.mainline = mainline.has(id) && _isDisplaySeason(v.node);
  return nodeMap;
}

// ── Split-cour detection & merge ─────────────────────────────────────────────
//
// AniList stores split-cour anime as separate entries, e.g.:
//   "Re:Zero 2nd Season"         (13 eps, 2020)
//   "Re:Zero 2nd Season Part 2"  (13 eps, 2021)
//
// These should appear as a single "Season 2" in the UI.
// Detection: explicit "Part N" / "Cour N" in one title + ≤ 18 months apart.

function _isSplitCour(e1, e2) {
  const t1 = (e1.romajiTitle || e1.title || "").toLowerCase();
  const t2 = (e2.romajiTitle || e2.title || "").toLowerCase();

  // At least one entry must have an explicit cour/part suffix
  const PART_RE = /\b(part|cour)\s*[2-9]\b|\b[2-9](nd|rd|th)\s*(part|cour)\b/i;
  if (!PART_RE.test(t1) && !PART_RE.test(t2)) return false;

  // Must air within 18 months of each other
  const y1 = e1.seasonYear || e1.startDate?.year || 0;
  const y2 = e2.seasonYear || e2.startDate?.year || 0;
  const m1 = e1.startDate?.month || 1;
  const m2 = e2.startDate?.month || 1;
  return Math.abs((y2 - y1) * 12 + (m2 - m1)) <= 18;
}

function _mergeSplitCours(tvSeasons) {
  if (tvSeasons.length <= 1) return tvSeasons;
  const result = [];
  let i = 0;
  while (i < tvSeasons.length) {
    const cur  = tvSeasons[i];
    const next = tvSeasons[i + 1];
    if (next && _isSplitCour(cur, next)) {
      // Combine both parts into one season entry
      const combinedEps    = (cur.episodes    || 0) + (next.episodes    || 0) || null;
      const combinedAired  = (cur.latestAiredEp || 0) + (next.latestAiredEp || 0) || null;
      result.push({
        ...cur,
        // Use the shorter (simpler) title — that's the "Part 1" title
        title:         cur.title.length <= next.title.length ? cur.title : next.title,
        romajiTitle:   cur.romajiTitle.length <= next.romajiTitle.length ? cur.romajiTitle : next.romajiTitle,
        episodes:      combinedEps,
        latestAiredEp: combinedAired || null,
        // Use the most current status (RELEASING wins)
        status:        next.status === "RELEASING" ? next.status : cur.status,
        // Keep the AniList IDs of both parts so clicking either works
        anilistId:     cur.anilistId,
        extraAnilistId: next.anilistId,
        image:         cur.image || next.image,
      });
      i += 2; // consumed two entries
    } else {
      result.push(cur);
      i += 1;
    }
  }
  return result;
}

// Derive a clean season label from an AniList title, preserving the real
// designation instead of forcing a generic "Season N". This keeps multi-part
// franchises correct, e.g. for Attack on Titan:
//   "Attack on Titan"                       -> Season 1
//   "Attack on Titan Season 3"              -> Season 3
//   "Attack on Titan Season 3 Part 2"       -> Season 3 Part 2
//   "Attack on Titan Final Season"          -> The Final Season
//   "Attack on Titan Final Season Part 2"   -> The Final Season Part 2
//   "...Final Season THE FINAL CHAPTERS Special 1" -> The Final Chapters Part 1
function deriveSeasonLabel(entry, index) {
  const t = (entry.title || entry.romajiTitle || "").trim();
  const isFinal    = /\bfinal\s+season\b|\bthe\s+final\b/i.test(t);
  const isChapters = /\bfinal\s+chapters\b|kanketsu/i.test(t);

  const sm = t.match(/\bseason\s*(\d+)\b/i) || t.match(/\b(\d+)\s*(?:st|nd|rd|th)\s+season\b/i);
  const seasonNum = sm ? parseInt(sm[1], 10) : null;

  const pm = t.match(/\bpart\s*(\d+)\b/i) || t.match(/\bcour\s*(\d+)\b/i)
          || t.match(/\b(\d+)\s*(?:st|nd|rd|th)\s+(?:part|cour)\b/i);
  const partNum = pm ? parseInt(pm[1], 10) : null;

  const sp = t.match(/\bspecial\s*(\d+)\b/i);
  const specialNum = sp ? parseInt(sp[1], 10) : null;

  if (isChapters) {
    const n = specialNum ?? partNum;
    return "The Final Chapters" + (n ? ` Part ${n}` : "");
  }
  if (isFinal) return "The Final Season" + (partNum ? ` Part ${partNum}` : "");
  if (seasonNum) return `Season ${seasonNum}` + (partNum ? ` Part ${partNum}` : "");
  if (partNum) return `Part ${partNum}`;
  return index === 0 ? "Season 1" : `Season ${index + 1}`;
}

// When several consecutive entries share the same base season — e.g.
// "Season 3" + "Season 3 Part 2", or "The Final Season" + "...Part 2" — relabel
// them "<base> Part 1", "<base> Part 2", … so the split reads consistently
// instead of "Season 3" followed by an orphan "Season 3 Part 2".
function _refineSeasonParts(seasons) {
  const baseOf = (label) => (label || "").replace(/\s*Part\s*\d+\s*$/i, "").trim();
  let i = 0;
  while (i < seasons.length) {
    const base = baseOf(seasons[i].seasonLabel);
    let j = i + 1;
    while (j < seasons.length && baseOf(seasons[j].seasonLabel) === base) j++;
    if (j - i > 1) {
      for (let k = i; k < j; k++) seasons[k].seasonLabel = `${base} Part ${k - i + 1}`;
    }
    i = j;
  }
}

/**
 * Build the franchise structure from a full traversal of AniList relations.
 * Returns { mainAnilistId, tvSeasons[], movies[], ovas[], onas[], specials[], all[] }
 *
 * tvSeasons = the main story line (PREQUEL/SEQUEL chain) in chronological order —
 * every season AND part shown separately with its real label (no merging), so
 * multi-part franchises (Attack on Titan, etc.) read correctly end to end.
 */
async function buildFranchiseFromAniListMedia(media) {
  const nodeMap = await _traverseFranchise(media);

  const all = [...nodeMap.values()].map(v => v.node).sort(_sortByAirDate);

  // The main story chain — seasons, split-cour parts, and any "Final Chapters".
  const tvSeasons = all.filter(e => e.mainline).sort(_sortByAirDate);
  tvSeasons.forEach((entry, i) => {
    entry.seasonNumber = i + 1;
    entry.seasonLabel  = deriveSeasonLabel(entry, i);
  });
  _refineSeasonParts(tvSeasons);

  // Extras = OVAs, movies, parody specials, side stories NOT on the main chain.
  const extras   = all.filter(e => !e.mainline);
  const movies   = extras.filter(e => e.format === "MOVIE");
  const ovas     = extras.filter(e => e.format === "OVA");
  const onas     = extras.filter(e => e.format === "ONA");
  const specials = extras.filter(e => e.format === "SPECIAL" || e.format === "MUSIC");

  return { mainAnilistId: media.id, tvSeasons, movies, ovas, onas, specials, all };
}

// ── Placeholder episodes from AniList data ───────────────────────────────────

function makePlaceholderEpisodesFromAniList(entry) {
  const count = getAniListDisplayEpisodeCount(entry);
  if (!count || count <= 0) return [];
  // These are AIRED episodes (the list is capped to the aired count), so they're
  // playable on click — the scraper resolves the actual servers then. Mark them
  // as resolvable rather than "unavailable", so the UI invites a tap instead of
  // claiming the episode doesn't exist.
  return Array.from({ length: Math.min(count, 2000) }, (_, i) => ({
    season:       entry.seasonNumber || 1,
    episode:      i + 1,
    title:        entry.format === "MOVIE" ? (entry.title || "Movie") : `Episode ${i + 1}`,
    needsResolve: true,
  }));
}

function getAniListDisplayEpisodeCount(entry = {}) {
  const status = String(entry.status || "").toUpperCase();
  const format = String(entry.format || "").toUpperCase();
  if (format === "MOVIE") return 1;

  const latestAired = Number(entry.latestAiredEp || entry.latestAiredEpisode || 0);
  const nextAiring = Number(entry.nextAiringEp || entry.nextAiringEpisodeNumber || 0);
  const plannedTotal = Number(entry.episodes || entry.totalEpisodes || 0);
  const isAiring = status === "RELEASING" || status === "AIRING";
  const isFuture = status === "NOT_YET_RELEASED" || status === "UPCOMING";

  if (isFuture) return 0;
  if (isAiring) {
    if (Number.isFinite(latestAired) && latestAired > 0) return latestAired;
    if (Number.isFinite(nextAiring) && nextAiring > 1) return nextAiring - 1;
    return 0;
  }
  if (Number.isFinite(plannedTotal) && plannedTotal > 0) return plannedTotal;
  if (Number.isFinite(latestAired) && latestAired > 0) return latestAired;
  return 0;
}

// ── Season list builder for the UI ──────────────────────────────────────────

/**
 * Convert show.anilistFranchise into the flat season-list array used by
 * getFranchiseSeasonList / renderEpisodeList.
 *
 * @param {object} show       – the active show object
 * @param {object} showsMap   – Map<anilistId → show> built by the caller
 * @param {function} getDetailSeasons  – existing function
 * @param {function} makePlaceholderEpisodes – existing fallback
 */
function buildSeasonListFromAniListFranchise(show, showsMap, getDetailSeasons, makePlaceholderEpisodes) {
  const franchise = show.anilistFranchise;
  if (!franchise) return null;

  const result = [];
  const showAniId = String(show.anilistId || "");

  // ── TV seasons ────────────────────────────────────────────────────────────
  for (const entry of franchise.tvSeasons) {
    const entryAniId  = String(entry.anilistId);
    const extraAniId  = entry.extraAnilistId ? String(entry.extraAnilistId) : null;
    // A season is "current" if the opened show matches either the primary or the
    // extra AniList ID (the latter happens when we merged two split-cour parts).
    const isCurrent   = entryAniId === showAniId || extraAniId === showAniId;
    const matchedShow   = showsMap.get(entryAniId) || (extraAniId ? showsMap.get(extraAniId) : null);
    const resolvedId    = matchedShow ? matchedShow.id : `anilist-${entryAniId}`;
    const currentSeasons = isCurrent ? getDetailSeasons(show) : null;

    // Authoritative aired-till-today count for THIS season, straight from
    // AniList (airing → last aired ep; finished → real total; movie → 1).
    const airedCount = getAniListDisplayEpisodeCount(entry);
    let seasonEpisodes = isCurrent
      ? (currentSeasons || []).flatMap(s => s.episodes || [])
      : (matchedShow ? makePlaceholderEpisodes(matchedShow, entry.seasonNumber)
                     : makePlaceholderEpisodesFromAniList(entry));
    // Never list more episodes than have actually aired, and never spill past
    // the season's real total — applies to every anime, every source.
    if (airedCount > 0) {
      seasonEpisodes = seasonEpisodes.filter(ep =>
        Number(ep.episode ?? ep.number ?? 0) <= airedCount);
    }

    result.push({
      season:        entry.seasonNumber,
      title:         entry.seasonLabel || `Season ${entry.seasonNumber}`,
      sourceTitle:   isCurrent ? show.title : (entry.title || matchedShow?.title || entry.seasonLabel || `Season ${entry.seasonNumber}`),
      image:         isCurrent ? (show.image || entry.image) : (matchedShow?.image || entry.image || show.image),
      format:        entry.format,
      status:        entry.status,
      year:          entry.seasonYear,
      anilistId:     entry.anilistId,
      isCurrentShow: isCurrent,
      relatedShowId: isCurrent ? null : resolvedId,
      episodes:      seasonEpisodes,
      playable:      isCurrent ? (currentSeasons || []).some(s => s.playable) : false,
    });
  }

  // ── Extras (Movie / OVA / ONA / Special) ─────────────────────────────────
  const extras = [
    ...franchise.movies.map(e => ({ ...e, sectionLabel: "Movie" })),
    ...franchise.ovas.map(e =>   ({ ...e, sectionLabel: "OVA"   })),
    ...franchise.onas.map(e =>   ({ ...e, sectionLabel: "ONA"   })),
    ...franchise.specials.map(e =>({ ...e, sectionLabel: "Special" })),
  ];

  for (const entry of extras) {
    const entryAniId  = String(entry.anilistId);
    const isCurrent   = entryAniId === showAniId;
    // Prefer a real catalog match; fall back to the synthetic AniList ID which
    // ensureFranchiseShowsInCatalog() will have created before any click fires.
    const matchedShow   = showsMap.get(entryAniId);
    const resolvedId    = matchedShow ? matchedShow.id : `anilist-${entryAniId}`;
    const idx           = result.length + 1;
    const label         = entry.sectionLabel;
    const title         = entry.title || `${label} ${idx}`;
    const currentSeasons = isCurrent ? getDetailSeasons(show) : null;

    const airedCount = getAniListDisplayEpisodeCount(entry);
    let extraEpisodes = isCurrent
      ? (currentSeasons || []).flatMap(s => s.episodes || [])
      : makePlaceholderEpisodesFromAniList(entry);
    if (airedCount > 0) {
      extraEpisodes = extraEpisodes.filter(ep =>
        Number(ep.episode ?? ep.number ?? 0) <= airedCount);
    }

    result.push({
      season:        idx,
      title,
      sourceTitle:   title,
      image:         isCurrent ? (show.image || entry.image) : (matchedShow?.image || entry.image || show.image),
      format:        entry.format,
      formatBadge:   label,
      status:        entry.status,
      year:          entry.seasonYear,
      anilistId:     entry.anilistId,
      isCurrentShow: isCurrent,
      // Always provide a navigable ID — the show will be in state.shows by the
      // time the user can click (ensureFranchiseShowsInCatalog runs first).
      relatedShowId: isCurrent ? null : resolvedId,
      episodes:      extraEpisodes,
      playable:      isCurrent ? (currentSeasons || []).some(s => s.playable) : false,
    });
  }

  return result.length > 0 ? result : null;
}

// ── Main hydration entry point ───────────────────────────────────────────────

/**
 * Fetch AniList data for `show`, build franchise structure, attach to
 * show.anilistFranchise.  Safe to call multiple times — exits early if
 * already loaded.  Never throws; failures are silently ignored so the
 * rest of the app continues working.
 */
async function hydrateShowAniListFranchise(show) {
  if (!show) return show;
  // Skip only if the franchise was already built with the CURRENT code version.
  // If the version doesn't match, we rebuild — this automatically picks up any
  // traversal / merge improvements after a page reload.
  if (show.anilistFranchiseLoaded && show._franchiseVersion === _FRANCHISE_VERSION) {
    return show;
  }
  // Reset stale franchise data before rebuilding
  show.anilistFranchiseLoaded = false;
  delete show.anilistFranchise;

  try {
    const media = await _resolveAniListMedia(show);
    if (!media) return show;

    // Backfill IDs onto show if they were missing
    if (!show.anilistId && media.id)     show.anilistId = media.id;
    if (!show.malId     && media.idMal)  show.malId     = media.idMal;

    // Update episode count from AniList (authoritative)
    const nextEp      = media.nextAiringEpisode?.episode;
    const latestAired = nextEp && nextEp > 1 ? nextEp - 1 : null;
    if (media.episodes) show.totalEpisodes = media.episodes;
    // Carry the authoritative airing signal onto the show so the detail-view
    // clamp (getSeasonEpisodeLimit) can cut off at the last aired episode for
    // every anime, regardless of how the catalog spells the status string.
    if (media.status) show.anilistStatus = media.status;
    if (nextEp)       show.nextAiringEp  = nextEp;
    if (latestAired)  show.latestAiredEp = latestAired;
    const currentCount = Number(show.episode);
    const anilistCount = latestAired ?? media.episodes;
    if (anilistCount && (!currentCount || anilistCount < currentCount)) {
      show.episode = anilistCount;
    }

    // buildFranchiseFromAniListMedia traverses the full PREQUEL→root→SEQUEL chain
    show.anilistFranchise      = await buildFranchiseFromAniListMedia(media);
    show.anilistFranchiseLoaded = true;
    show._franchiseVersion     = _FRANCHISE_VERSION;
  } catch (err) {
    console.warn("[AniList] franchise hydration failed:", err?.message || err);
  }
  return show;
}
