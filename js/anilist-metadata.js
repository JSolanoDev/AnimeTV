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
const _FRANCHISE_VERSION = 15;
const _MEDIA_CACHE_VERSION_KEY = "animetv-anilist-cache-v";
const _MEDIA_CACHE_VERSION_VAL = "11"; // clears stale localStorage media cache

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
const _franchiseMediaInFlight = new Map();
let _anilistUnavailableUntil = 0;

function franchiseEntryKey(entry = {}) {
  return entry.anilistId ? String(entry.anilistId) : entry.malId ? `mal-${entry.malId}` : "";
}

function franchiseEntryMatches(entry, show) {
  return Boolean(entry && show && (
    (entry.anilistId && show.anilistId && String(entry.anilistId) === String(show.anilistId)) ||
    (entry.malId && show.malId && String(entry.malId) === String(show.malId))
  ));
}

function jikanFranchiseMedia(data, anilistId = null) {
  const id = Number(data?.mal_id);
  if (!id) return null;
  const statuses = { "Finished Airing": "FINISHED", "Currently Airing": "RELEASING", "Not yet aired": "NOT_YET_RELEASED" };
  const date = data.aired?.prop?.from;
  return {
    id: anilistId || `mal-${id}`,
    idMal: id,
    metadataProvider: "jikan",
    type: "ANIME",
    title: { english: data.title_english || data.title, romaji: data.title, native: data.title_japanese },
    format: String(data.type || "TV").toUpperCase().replace(/ /g, "_"),
    status: statuses[data.status] || "",
    episodes: data.episodes || null,
    seasonYear: data.year || date?.year || null,
    startDate: date || null,
    coverImage: { large: data.images?.webp?.large_image_url || data.images?.jpg?.large_image_url || "" },
    description: data.synopsis || "",
    genres: (data.genres || []).map(genre => genre.name),
    averageScore: data.score ? Math.round(data.score * 10) : null,
    relations: { edges: (data.relations || []).flatMap(relation => {
      const type = String(relation.relation || "").toUpperCase();
      // Only explicit continuity links; adaptations and similarly named works are not seasons.
      if (type !== "PREQUEL" && type !== "SEQUEL") return [];
      return (relation.entry || []).filter(entry => entry.type === "anime" && entry.mal_id).map(entry => ({
        relationType: type,
        node: { id: `mal-${entry.mal_id}`, idMal: entry.mal_id, type: "ANIME", format: "UNKNOWN", title: { romaji: entry.name } }
      }));
    }) }
  };
}

async function _fetchJikanFranchiseMedia(malId, anilistId = null) {
  if (!malId) return null;
  const key = `jikan-media:${malId}`;
  let media = _readAniListCache(key);
  if (!media) {
    try {
      const response = await fetchWithTimeout(`/api/jikan/full?id=${encodeURIComponent(malId)}`, {}, 10000);
      const payload = response.ok ? await response.json() : null;
      if (payload?.unavailable || !payload?.data) return null;
      media = jikanFranchiseMedia(payload.data);
      if (media) _writeAniListCache(key, media);
    } catch { return null; }
  }
  return media && anilistId ? { ...media, id: anilistId } : media;
}

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

async function _fetchAniListMedia(anilistId, malId = null) {
  if (String(anilistId).startsWith("mal-")) return _fetchJikanFranchiseMedia(String(anilistId).slice(4));
  const key = `media:${anilistId}`;
  const cached = _readAniListCache(key);
  if (cached && String(cached.id) === String(anilistId)) return cached;
  const flightKey = `${key}:${malId || ""}`;
  if (_franchiseMediaInFlight.has(flightKey)) return _franchiseMediaInFlight.get(flightKey);
  const request = (async () => {
      // The server may have this exact ID cached even during an upstream outage.
      // A failure for another title must not suppress these cache reads.
      try {
        const res = await fetchWithTimeout(`${ANILIST_MEDIA_ENDPOINT}?id=${encodeURIComponent(anilistId)}`, {}, 8000);
        const json = res.ok ? await res.json() : null;
        if (json?.ok && json.media && String(json.media.id) === String(anilistId)) {
          _writeAniListCache(key, json.media);
          return json.media;
        }
        _anilistUnavailableUntil = Date.now() + 60000;
      } catch { _anilistUnavailableUntil = Date.now() + 60000; }
    return _fetchJikanFranchiseMedia(malId, anilistId);
  })().finally(() => _franchiseMediaInFlight.delete(flightKey));
  _franchiseMediaInFlight.set(flightKey, request);
  return request;
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
    const m = await _fetchAniListMedia(show.anilistId, show.malId);
    if (m) return m;
  }
  if (show.malId) {
    const m = await _fetchJikanFranchiseMedia(show.malId, show.anilistId);
    if (m) return m;
  }
  if (Date.now() < _anilistUnavailableUntil) return null;

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
    anilistId:       /^\d+$/.test(String(node.id || "")) ? Number(node.id) : null,
    metadataId:      node.id,
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
  const mainline = new Set(); // ids in the connected SEQUEL/PREQUEL component (the seasons)
  const hasFullMedia = (node) => [...nodeMap.values()].some(value => value.fullMedia && (
    value.fullMedia.id === node.id || (node.idMal && Number(value.node.malId) === Number(node.idMal))
  ));

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
    if (rawNode.idMal && [...nodeMap.values()].some(value => Number(value.node.malId) === Number(rawNode.idMal))) return;
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

  // ── Seed with the entry the user opened ──────────────────────────────────
  addMedia(startMedia);
  mainline.add(startMedia.id);
  collectSideEntries(startMedia);

  // ── BFS the FULL connected SEQUEL/PREQUEL component ───────────────────────
  // Walking a single linear chain picks ONE branch when the graph forks (Demon
  // Slayer: S1 -> {Mugen Train movie, Mugen Train TV} -> Yuukaku -> ...), so the
  // season list used to change depending on which entry was opened. Exploring the
  // whole component in BOTH directions makes the list identical from ANY start.
  // canFollowSeasonLink still severs separate adaptations/remakes (Doraemon).
  const MAX_NODES = 40;
  const queue = [startMedia];
  while (queue.length && fetched.size < MAX_NODES) {
    const current = queue.shift();
    const links = (current.relations?.edges || []).filter(e =>
      (e.relationType === "SEQUEL" || e.relationType === "PREQUEL") &&
      e.node?.type === "ANIME"
    );
    for (const edge of links) {
      if (fetched.has(edge.node.id) || hasFullMedia(edge.node)) continue;
      if (!canFollowSeasonLink(current, edge.node)) continue;   // remake / separate adaptation
      const media = await _fetchAniListMedia(edge.node.id, edge.node.idMal);
      if (!media) {
        addNode(edge.node, edge.relationType);
        mainline.add(edge.node.id);
        continue;
      }
      if (!canFollowSeasonLink(current, media)) continue;
      addMedia(media, edge.relationType);
      mainline.add(media.id);
      collectSideEntries(media);
      queue.push(media);
    }
  }

  // Mop up any shallow mainline nodes and expand their links too (multi-pass).
  for (let pass = 0; pass < 6; pass++) {
    const pending = [...nodeMap.values()]
      .filter(v => mainline.has(v.node.metadataId) && !v.fullMedia);
    if (!pending.length) break;
    const before = fetched.size;
    await Promise.allSettled(pending.map(async ({ node }) => {
      const media = await _fetchAniListMedia(node.metadataId, node.malId);
      if (!media) return;
      addMedia(media);
      mainline.add(media.id);
      collectSideEntries(media);
      for (const e of media.relations?.edges || []) {
        if ((e.relationType === "SEQUEL" || e.relationType === "PREQUEL") &&
            e.node?.type === "ANIME" && canFollowSeasonLink(media, e.node)) {
          mainline.add(e.node.id);
          addNode(e.node, e.relationType);
        }
      }
    }));
    if (fetched.size === before) break;
  }

  // Tag every node with whether it should DISPLAY as a mainline season. We keep
  // bonus OVAs/movies that bridge seasons in the component, but demote them to
  // extras here so only real seasons (TV/ONA + designated specials) are tabs.
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
 * Returns { mainAnilistId, groups: [], all[] }
 *
 * Each group in groups[] follows the normalized structure:
 * { id, title, type, seasonNumber, partNumber, yearStart, items: [...] }
 */
async function buildFranchiseFromAniListMedia(media) {
  const nodeMap = await _traverseFranchise(media);
  const allNodes = [...nodeMap.values()].map(v => v.node);

  // Use the new universal normalization system
  const normalized = SeasonNormalization.normalizeFranchise(allNodes);

  // Map groups to the format expected by the UI builders if needed,
  // or just provide the new groups structure.
  // To maintain some compatibility with existing code that expects
  // franchise.tvSeasons, franchise.movies, etc.

  const tvSeasons = normalized.groups.filter(g => g.type === "main").flatMap(g => {
    // Each group becomes a "season card" in the UI.
    // We'll attach the group metadata to each item or just return the groups.
    // The UI (buildSeasonListFromAniListFranchise) needs to be updated too.
    return g;
  });

  const movies = normalized.groups.filter(g => g.type === "movie");
  const ovas = normalized.groups.filter(g => g.type === "special");
  const recaps = normalized.groups.filter(g => g.type === "recap");

  return {
    mainAnilistId: /^\d+$/.test(String(media.id)) ? Number(media.id) : null,
    mainMalId: media.idMal || null,
    incomplete: [...nodeMap.values()].some(value => !value.fullMedia &&
      (value.node.relationType === "PREQUEL" || value.node.relationType === "SEQUEL")),
    groups: normalized.groups,
    tvSeasons, // Now these are Groups, not just entries
    movies: movies.flatMap(g => g.items),
    ovas: ovas.flatMap(g => g.items),
    recaps: recaps.flatMap(g => g.items),
    all: allNodes
  };
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
    // Stable provenance so episode totals never combine across different anime.
    animeId:      entry.anilistId ?? null,
    anilistId:    entry.anilistId ?? null,
    malId:        entry.malId ?? null,
    startYear:    entry.seasonYear ?? entry.startDate?.year ?? null,
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
  if (!franchise || !franchise.groups) return null;

  const result = [];

  for (const group of franchise.groups) {
    // A group is current if any of its items match the current show
    const isCurrent = group.items.some(item =>
      franchiseEntryMatches(item, show) ||
      (item.extraAnilistId && String(item.extraAnilistId) === String(show.anilistId || ""))
    );

    const mainItem = group.items[0];
    const entryKey = franchiseEntryKey(mainItem);
    const matchedShow = showsMap.get(entryKey) || showsMap.get(`mal-${mainItem.malId}`);
    const resolvedId = matchedShow ? matchedShow.id : mainItem.anilistId ? `anilist-${mainItem.anilistId}` : `jikan-${mainItem.malId}`;

    let groupEpisodes = [];
    let groupPlayable = false;

    group.items.forEach(item => {
      const itemIsCurrent = franchiseEntryMatches(item, show);
      const itemMatched = showsMap.get(franchiseEntryKey(item)) || showsMap.get(`mal-${item.malId}`);

      let itemEps = [];
      if (itemIsCurrent) {
        const ds = getDetailSeasons(show) || [];
        // Extract episodes that belong to this entry
        itemEps = ds.flatMap(s => s.episodes || []);
        groupPlayable = groupPlayable || ds.some(s => s.playable);
      } else {
        itemEps = itemMatched
          ? makePlaceholderEpisodes(itemMatched, group.seasonNumber || 1)
          : makePlaceholderEpisodesFromAniList(item);
      }

      // Cap to aired count
      const airedCount = getAniListDisplayEpisodeCount(item);
      if (airedCount > 0 && itemEps.length > airedCount) {
        itemEps = itemEps.slice(0, airedCount);
      }
      groupEpisodes.push(...itemEps);
    });

    result.push({
      id: group.id,
      season: group.seasonNumber || result.length + 1,
      part: group.partNumber,
      type: group.type,
      title: group.title,
      sourceTitle: isCurrent ? show.title : (mainItem.title || matchedShow?.title || group.title),
      image: isCurrent ? (show.image || mainItem.image) : (matchedShow?.image || mainItem.image || show.image),
      format: mainItem.format,
      formatBadge: group.type !== 'main' ? (group.type === 'movie' ? 'Movie' : group.type === 'recap' ? 'Recap' : 'Special') : '',
      status: mainItem.status,
      year: group.yearStart,
      anilistId: mainItem.anilistId,
      malId: mainItem.malId,
      isCurrentShow: isCurrent,
      relatedShowId: isCurrent ? null : resolvedId,
      episodes: groupEpisodes,
      playable: groupPlayable
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
  if (show._franchiseNextTry > Date.now()) return show;
  // Skip only if the franchise was already built with the CURRENT code version.
  // If the version doesn't match, we rebuild — this automatically picks up any
  // traversal / merge improvements after a page reload.
  if (show.anilistFranchiseLoaded && show._franchiseVersion === _FRANCHISE_VERSION) {
    return show;
  }
  // Keep the last usable season list visible while a provider is unavailable.

  try {
    const media = await _resolveAniListMedia(show);
    if (!media) {
      show._franchiseNextTry = Date.now() + 60000;
      return show;
    }

    // Backfill IDs onto show if they were missing
    if (!show.anilistId && /^\d+$/.test(String(media.id))) show.anilistId = Number(media.id);
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
    const franchise = await buildFranchiseFromAniListMedia(media);
    if (!franchise.incomplete || !show.anilistFranchise ||
        franchise.groups.length >= (show.anilistFranchise.groups?.length || 0)) {
      show.anilistFranchise = franchise;
    }
    show.anilistFranchiseLoaded = !franchise.incomplete;
    show._franchiseNextTry = franchise.incomplete ? Date.now() + 60000 : 0;
    show._franchiseVersion     = _FRANCHISE_VERSION;
  } catch (err) {
    console.warn("[AniList] franchise hydration failed:", err?.message || err);
  }
  return show;
}

/**
 * After AniList franchise hydration, make sure every franchise entry
 * (movie, OVA, related TV seasons) has a minimal show object in state.shows.
 */
// ensureFranchiseShowsInCatalog lived here too, but client.js loads AFTER this
// file and declares the same top-level name, so this copy was always silently
// overridden - dead code that looked live, and they had drifted apart (this one
// only understood franchise.groups; the surviving one also handles the legacy
// tvSeasons/movies/ovas/... shape and de-dupes). Removed; client.js owns it.
// Guarded by scripts/check-global-collisions.mjs.
