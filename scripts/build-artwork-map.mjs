// Resolve a real 16:9 backdrop for every scraped AnimeAV1 title, ONCE, at build
// time, and write scraper/artwork-map.json.
//
// Why this exists: scraper/anime_metadata.json ships 1000 rows with anilistId:null
// and malId:null. TMDB artwork is resolved client-side, and that resolve is a
// chain - AniList title search -> anilistId -> TMDB search -> backdrop - which only
// runs for a show once it is enriched. So at any moment about 4 of 1177 catalogue
// rows had a TMDB backdrop and everything else fell back to AnimeAV1's 1900x400
// strip, which is a banner, not a backdrop, and never 1080p.
//
// Resolving it here removes the whole chain from the client: the catalogue ships
// with anilistId + a >=1280x720 tmdbBackdrop already attached.
//
// Runs against the deployed API routes (they hold the TMDB key), so no local
// secrets are needed:
//   node scripts/build-artwork-map.mjs [--limit N] [--base https://zenkaitv.com] [--force]
//
// Resumable: an existing map is loaded and only missing/failed ids are retried,
// so a rate-limited run can simply be run again.

import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const SRC = path.join(root, "scraper", "anime_metadata.json");
const OUT = path.join(root, "scraper", "artwork-map.json");
const OVERRIDES_FILE = path.join(root, "scraper", "anilist-id-overrides.json");

// Slug -> AniList id for titles AniList's SEARCH cannot reach. The scorer never
// gets a chance on these: the search returns zero candidates because AniList
// tokenises on its own spelling ("Yoroi-Shinden" vs the scraped "Yoroi Shin Den",
// "Cour 2" vs "Part 2"). Without an id the row gets no metadata, no TMDB art and
// no franchise grouping - which is how Yoroi Shin Den ended up showing Part 2 as a
// standalone entry with Part 1 missing from the season picker.
let ANILIST_OVERRIDES = {};
try {
  ANILIST_OVERRIDES = JSON.parse(fs.readFileSync(OVERRIDES_FILE, "utf8")).overrides || {};
} catch {
  ANILIST_OVERRIDES = {}; // optional file
}

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = String(argOf("--base", "https://zenkaitv.com")).replace(/\/$/, "");
const LIMIT = Number(argOf("--limit", "0")) || 0;
const FORCE = args.includes("--force");
const CONCURRENCY = Number(argOf("--concurrency", "4")) || 4;
const ONLY_IDS = new Set(String(argOf("--ids", ""))
  .split(",").map((value) => value.trim()).filter(Boolean));

// TMDB's own w1280 is 1280x720; "original" is whatever the uploader gave (often
// 1920x1080 or 3840x2160). Store original and let /api/image resize down to the
// viewport width - never up.
const TMDB_IMG = "https://image.tmdb.org/t/p/original";
const TMDB_ID_OVERRIDES = new Map([
  // Stable visual carriers for the long-running shows. These names are too
  // generic for fuzzy search and every daily rebuild must retain the same exact
  // series so global episode titles/stills stay aligned.
  ["animeav1-naruto", 46260],
  ["animeav1-naruto-shippuuden", 31910],
  ["animeav1-one-piece", 37854],
  ["animeav1-boruto-naruto-next-generations", 70881],
  // Western animation carried by AnimeAV1 has no MAL/AniList identity.
  ["animeav1-castlevania", 71024],
  // Recuts are separate AnimeAV1 titles but metadata providers often fold them
  // into the original series. Pin their exact visual carriers.
  ["animeav1-psycho-pass-new-edit-version", 327222],
  ["animeav1-rezero-kara-hajimeru-isekai-seikatsu-shin-henshuu-ban", 65942],
  // Link Click's English title collides exactly with a 2026 live-action series.
  // Pin both source-backed and relation-only identities to the animated show.
  ["animeav1-shiguang-dailiren-ii", 123542],
  ["animeav1-shiguang-dailiren-yingdu-pian", 123542],
  ["animeav1-shiguang-dailiren-iii", 123542],
  // Current adaptations whose names collide with older series.
  ["animeav1-catseye", 286691],
  ["animeav1-kinnikuman-kanpeki-choujin-shiso-hen", 236000],
  ["animeav1-devil-may-cry-2025", 235930],
  ["animeav1-devil-may-cry-2026", 235930],
  ["anilist-126403", 123542],
  ["anilist-136484", 123542],
  ["anilist-170166", 123542],
  ["anilist-191832", 123542],
  // TMDB uses a completely unrelated English localization for this title, so
  // fuzzy scoring correctly refuses it unless the identity is pinned.
  ["animeav1-aru-asa-dummy-head-mic-ni-natteita-ore-kun-no-jinsei", 205961],
  // TMDB uses an English localization while the offline identity database has
  // only the Japanese title. Both MAL rows are split cours of this one TMDB
  // season, so pinning the shared series is exact and lets the client scope by
  // providerEpisodeOffset.
  ["mal-50953", 156898],
  ["mal-51366", 156898]
]);
// TMDB stores Bridon as Season 3, which shifts the animated third season to
// physical Season 4. These values select artwork only; canonical app numbering
// remains Link Click Seasons 1, 2, and 3.
const TMDB_SEASON_OVERRIDES = new Map([
  ["animeav1-shiguang-dailiren-ii", 2],
  ["animeav1-shiguang-dailiren-yingdu-pian", 3],
  ["animeav1-shiguang-dailiren-iii", 4],
  ["animeav1-catseye", 1],
  ["animeav1-kinnikuman-kanpeki-choujin-shiso-hen", 1],
  ["animeav1-devil-may-cry-2025", 1],
  ["animeav1-devil-may-cry-2026", 2],
  ["anilist-126403", 1],
  ["anilist-136484", 2],
  ["anilist-170166", 3],
  ["anilist-191832", 4]
]);

const norm = (s) => String(s || "")
  .toLowerCase()
  .replace(/[’'`]/g, "")
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

// Roman/arabic season markers are the single biggest source of wrong matches
// ("Youjo Senki II" must not match season 1), so compare with them stripped AND
// require the season number itself to agree.
const SEASON_WORDS = /\b(?:season|saison|temporada|part|cour|final|2nd|3rd|4th|1st)\b/g;
const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8 };
function seasonNumberOf(title) {
  const t = norm(title);
  let m = t.match(/\b(?:season|temporada|part|cour)\s*(\d+)\b/);
  if (m) return Number(m[1]);
  m = t.match(/\b(\d+)(?:st|nd|rd|th)\s+season\b/);
  if (m) return Number(m[1]);
  m = t.match(/\s(i{1,3}|iv|vi{0,3})$/);
  if (m && ROMAN[m[1]]) return ROMAN[m[1]];
  return 1;
}
// "Frieren: Beyond Journey's End Season 2" -> "Frieren: Beyond Journey's End".
// Keeps original casing/punctuation because it is fed back to TMDB as a query.
function stripSeasonSuffix(raw) {
  return String(raw || "")
    .replace(/\s*[:\-]?\s*(?:season|saison|temporada|part|cour)\s*\d+\s*$/i, "")
    .replace(/\s+\d+(?:st|nd|rd|th)\s+season\s*$/i, "")
    .replace(/\s+(?:II|III|IV|V|VI|VII|VIII)\s*$/, "")
    .trim();
}

// Also drops a trailing standalone number: stripping the word "season" out of
// "...for mobs season 2" leaves "...for mobs 2", which then scores 74 against
// TMDB's "...for Mobs" and was rejected despite being the right show.
const baseTitle = (t) => norm(t)
  .replace(SEASON_WORDS, " ")
  .replace(/\s(i{1,3}|iv|vi{0,3})$/, " ")
  .replace(/\s+\d+\s*$/, " ")
  .replace(/\s+/g, " ")
  .trim();

function titleScore(candidates, tmdbNames) {
  let best = 0;
  for (const a of candidates.filter(Boolean)) {
    for (const b of tmdbNames.filter(Boolean)) {
      const na = baseTitle(a), nb = baseTitle(b);
      if (!na || !nb) continue;
      if (na === nb) { best = Math.max(best, 100); continue; }
      // Romanisation sources disagree about where the spaces go, and word-overlap
      // scoring punishes that hard: "Mizu Zokusei no Mahoutsukai" vs AniList's
      // "Mizu Zokusei no Mahou Tsukai" is the SAME show but scored below the gate
      // and was discarded. Compare the space-stripped forms too - the same trick
      // titleMatchScore() uses in client.js.
      if (na.replace(/ /g, "") === nb.replace(/ /g, "")) { best = Math.max(best, 100); continue; }
      if (na.startsWith(nb) || nb.startsWith(na)) { best = Math.max(best, 88); continue; }
      const aw = new Set(na.split(" ")), bw = new Set(nb.split(" "));
      const inter = [...aw].filter((w) => bw.has(w)).length;
      const overlap = inter / Math.max(aw.size, bw.size);
      best = Math.max(best, Math.round(overlap * 80));
    }
  }
  return best;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// AniList allows about 90 requests a minute and answers 429 well before that when
// several land at once. Running at concurrency 3 with no gate produced 554
// anilist-failed out of 600 - the retries could not out-wait a limit they were
// still saturating. Serialise every AniList call behind one global gate with a
// minimum spacing; TMDB is unthrottled and still runs concurrently.
const ANILIST_MIN_INTERVAL_MS = Number(argOf("--anilist-interval", "800"));
let _aniGate = Promise.resolve();
let _aniLast = 0;
function anilistSlot() {
  const take = async () => {
    const wait = _aniLast + ANILIST_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    _aniLast = Date.now();
  };
  _aniGate = _aniGate.then(take, take);
  return _aniGate;
}

async function getJson(url, tries = 4, rateLimited = false) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "ZenkaiTV-artwork-map" } });
      if (res.status === 429 || res.status >= 500) {
        // A rate-limited endpoint needs to wait out its window, not retry into it.
        const backoff = rateLimited ? 5000 * attempt : 1200 * attempt;
        await sleep(backoff);
        if (rateLimited) { _aniLast = Date.now(); }
        continue;
      }
      if (!res.ok) return null;
      return await res.json();
    } catch {
      await sleep(800 * attempt);
    }
  }
  return null;
}

const ANILIST_URL = "https://graphql.anilist.co";
const ANILIST_QUERY = `query ($search: String) {
  Media(search: $search, type: ANIME) {
    id idMal seasonYear format
    title { romaji english native }
    synonyms bannerImage
    coverImage { extraLarge large }
  }
}`;

async function anilistDirect(search) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    await anilistSlot();
    let res;
    try {
      res = await fetch(ANILIST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query: ANILIST_QUERY, variables: { search } })
      });
    } catch {
      await sleep(1500 * attempt);
      continue;
    }
    if (res.status === 429) {
      // Honour the window AniList asks for rather than retrying into it, and
      // push the shared gate out so the other workers wait too.
      const retryAfter = Number(res.headers.get("retry-after") || 0);
      const waitMs = (retryAfter > 0 ? retryAfter : 60) * 1000;
      console.log(`  anilist 429 - pausing ${Math.round(waitMs / 1000)}s`);
      _aniLast = Date.now() + waitMs;
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    return body?.data?.Media || null;
  }
  return null;
}

// Scraped titles use romanisation the AniList index does not always share
// ("Tenkou-saki" vs "Tenkousaki"), so walk progressively looser forms. This
// mirrors the ladder the server runs in handleAniListSearch.
function anilistVariants(raw) {
  const title = String(raw || "").trim();
  const out = [title];
  if (/-/.test(title)) out.push(title.replace(/-/g, ""));
  // Accents: the catalogue writes "Otome Kaijuu Caraméliser", AniList indexes
  // "KAIJU GIRL CARAMELISE".
  const unaccented = title.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (unaccented !== title) out.push(unaccented);
  const plain = unaccented.replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
  out.push(plain);
  // Localised season markers - the catalogue is Spanish-language.
  out.push(plain.replace(/\btemporada\b/gi, "Season").replace(/\bparte\b/gi, "Part"));
  // Romanisation disagrees about joined particles ("dewa" vs "de wa").
  out.push(plain.replace(/\b(dewa|niwa|nowa|towa)\b/gi, (w) => `${w.slice(0, -2)} ${w.slice(-2)}`));
  const noFormat = plain.replace(/\b(movie|film|pelicula|ova|ona|special|especial)\b/gi, "").replace(/\s+/g, " ").trim();
  if (noFormat && noFormat !== plain) out.push(noFormat);
  // A subtitle after a colon is often the part AniList does not index.
  String(title).split(/\s*[:|]\s*/).map((s) => s.trim()).filter((s) => s.length > 3).forEach((s) => out.push(s));
  // Progressively shorter prefixes. Only safe because every hit is validated.
  const words = plain.split(" ").filter(Boolean);
  for (const n of [6, 5, 4, 3]) if (words.length > n) out.push(words.slice(0, n).join(" "));
  return [...new Set(out.filter((s) => s && s.length > 2))].slice(0, 10);
}

// Does the entry AniList returned actually look like what we asked for?
function anilistLooksRight(media, scrapedTitle) {
  const names = [media.title?.romaji, media.title?.english, media.title?.native, ...(media.synonyms || [])];
  return titleScore(names, [scrapedTitle]) >= 62;
}

const ANILIST_BY_ID_QUERY = `query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id idMal seasonYear format
    title { romaji english native }
    synonyms bannerImage
    coverImage { extraLarge large }
  }
}`;

// Used only for overrides, where the id is already known and trusted, so there is
// nothing to score - fetch it straight.
async function anilistById(id) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    await anilistSlot();
    let res;
    try {
      res = await fetch(ANILIST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query: ANILIST_BY_ID_QUERY, variables: { id } })
      });
    } catch {
      await sleep(1500 * attempt);
      continue;
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") || 0);
      const waitMs = (retryAfter > 0 ? retryAfter : 60) * 1000;
      console.log(`  anilist 429 - pausing ${Math.round(waitMs / 1000)}s`);
      _aniLast = Date.now() + waitMs;
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    if (!json || json.errors) return null;
    return json.data?.Media || null;
  }
  return null;
}

// The season number must agree - the rule the header comment already claims and
// that resolve-from-offline-db.mjs enforces, but which was missing here. AniList
// search answers a "... 2nd Season" query with the SEASON 1 entry, and because
// titleScore strips SEASON_WORDS the two titles score identically, so nothing
// downstream could tell them apart. Both Hell Mode seasons resolved to AniList
// 185262; dedupeCatalogShows then merged the two catalogue rows on that shared id
// and the survivor served season 2's episodes under season 1's title and slug.
// Rejecting is the right failure here: a wrong id is worse than none, and
// anilist-id-overrides.json exists to supply the id when search cannot.
function anilistSeasonAgrees(media, scrapedTitle) {
  const want = seasonNumberOf(scrapedTitle);
  const names = [media?.title?.romaji, media?.title?.english, media?.title?.native,
    ...(media?.synonyms || [])].filter(Boolean);
  if (!names.length) return true;
  return names.some((n) => seasonNumberOf(n) === want);
}

function anilistYearAgrees(media, scrapedTitle) {
  const explicitYear = Number(String(scrapedTitle || "").match(/\b((?:19|20)\d{2})\b/)?.[1] || 0);
  const mediaYear = Number(media?.seasonYear || media?.startDate?.year || 0);
  return !explicitYear || !mediaYear || explicitYear === mediaYear;
}

async function anilistSearch(title) {
  let loose = null;
  let seasonMiss = null;
  for (const variant of anilistVariants(title)) {
    const media = await anilistDirect(variant);
    if (!media) continue;
    if (!anilistSeasonAgrees(media, title) || !anilistYearAgrees(media, title)) {
      if (!seasonMiss) seasonMiss = { media, variant };
      continue;
    }
    // The full title matching itself is always trustworthy; a shortened variant
    // has to earn it.
    if (variant === title || anilistLooksRight(media, title)) return media;
    if (!loose) loose = { media, variant };
  }
  if (seasonMiss) console.log(`  season mismatch, discarded "${title.slice(0, 40)}" -> ${seasonMiss.media.title?.romaji || ""} (add an override if this is right)`.slice(0, 170));
  if (loose) console.log(`  discarded loose AniList hit for "${title.slice(0, 40)}": ${loose.media.title?.romaji || ""}`.slice(0, 140));
  return null;
}

async function resolveOne(item, existing = null) {
  const title = item.title || "";
  const hasOverride = Object.prototype.hasOwnProperty.call(ANILIST_OVERRIDES, item.id);
  const overrideId = ANILIST_OVERRIDES[item.id];
  if (hasOverride) console.log(`  override: ${item.id} -> ${overrideId ? `AniList ${overrideId}` : "TMDB-only identity"}`);
  const knownAniListId = hasOverride
    ? (Number(overrideId) || null)
    : (Number(item.anilistId || existing?.anilistId || 0) || null);
  const existingMatchesOverride = !hasOverride
    || String(existing?.anilistId || "") === String(knownAniListId || "");
  const trustedOfflineRepair = existingMatchesOverride && existing?.status === "identity-repaired";
  const fetchedMedia = knownAniListId
    ? await anilistById(knownAniListId)
    : (hasOverride || trustedOfflineRepair ? null : await anilistSearch(title));
  // The offline identity pass can establish the correct AniList/MAL row even
  // while AniList's API is unavailable. Keep using that trusted identity and its
  // titles to resolve TMDB instead of replacing it with "anilist-failed".
  const fallbackMedia = existingMatchesOverride && existing && (existing.anilistId || existing.malId)
    ? {
        id: Number(existing.anilistId) || null,
        idMal: Number(existing.malId || existing.meta?.malId) || null,
        seasonYear: existing.meta?.year || item.year || null,
        format: existing.meta?.format || item.type || "",
        title: {
          romaji: existing.meta?.romajiTitle || title,
          english: existing.meta?.englishTitle || "",
          native: ""
        },
        synonyms: existing.identityTitles || [],
        bannerImage: existing.anilistBanner || "",
        coverImage: { extraLarge: existing.anilistCover || "", large: existing.anilistCover || "" }
      }
    : null;
  const media = fetchedMedia || fallbackMedia;
  const aniTitles = media ? [media.title?.romaji, media.title?.english, media.title?.native, ...(media.synonyms || [])] : [title];
  const year = media?.seasonYear || media?.startDate?.year || item.year || null;
  const wantSeason = Number(existing?.canonicalSeasonNumber)
    || seasonNumberOf(media?.title?.romaji || title);
  const identityArtwork = media ? {
    anilistId: media.id || existing?.anilistId || null,
    malId: media.idMal || existing?.malId || existing?.meta?.malId || null,
    anilistBanner: media.bannerImage || existing?.anilistBanner || "",
    anilistCover: media.coverImage?.extraLarge || media.coverImage?.large || existing?.anilistCover || "",
    metadataCover: existing?.metadataCover || ""
  } : hasOverride ? {
    // Explicit values clear a previously merged, wrong identity. The worker
    // preserves unrelated fields by spreading the old record first.
    anilistId: knownAniListId,
    malId: null,
    anilistBanner: "",
    anilistCover: "",
    metadataCover: "",
    meta: null,
    identityTitles: []
  } : {};

  // 2. TMDB - search on the strongest titles we now have. TMDB indexes anime as
  // ONE series per franchise, titled in English, with no season suffix, so the
  // season-stripped english title is by far the best query. Every query is also
  // retried without the year: for a later season AniList reports 2026 while the
  // TMDB series first aired years earlier, and the year filter returns nothing.
  const pinnedTmdbId = TMDB_ID_OVERRIDES.get(item.id);
  if (pinnedTmdbId) {
    const details = await getJson(`${BASE}/api/tmdb/tv?id=${pinnedTmdbId}`);
    const show = details?.show;
    const pinnedSeason = Number(TMDB_SEASON_OVERRIDES.get(item.id) || wantSeason);
    const seasonEntry = (show?.seasons || []).find((entry) => Number(entry.season_number) === pinnedSeason);
    const posterPath = seasonEntry?.poster_path || show?.poster_path || "";
    if (show?.backdrop_path || posterPath) {
      return {
        status: show.backdrop_path ? "ok" : "poster-only",
        ...identityArtwork,
        tmdbId: pinnedTmdbId,
        tmdbBackdrop: show.backdrop_path ? `${TMDB_IMG}${show.backdrop_path}` : "",
        tmdbPoster: posterPath ? `${TMDB_IMG}${posterPath}` : "",
        confidence: 100,
        matchedName: show.name || show.original_name || "pinned TMDB series",
        season: pinnedSeason
      };
    }
  }

  // Unpinned TMDB searches require an AniList identity. Without it a romaji-only
  // search matches the wrong franchise as often as the right one. An explicitly
  // pinned TMDB-only title, such as Netflix's Devil May Cry, has already returned
  // above and deliberately does not inherit an unrelated anime database row.
  if (!media) return { status: "anilist-failed" };

  const queries = [...new Set([
    stripSeasonSuffix(media.title?.english),
    media.title?.english,
    stripSeasonSuffix(media.title?.romaji),
    media.title?.romaji,
    ...(media.synonyms || []).slice(0, 6).flatMap((name) => [stripSeasonSuffix(name), name]),
    stripSeasonSuffix(title),
    title
  ].filter(Boolean))];
  const seen = new Set();
  const candidates = [];
  // Films live in a separate TMDB index; /search/tv returns nothing for them.
  const isFilm = /movie|film|pelicula/i.test(`${item.type || ""} ${media.format || ""} ${title}`);
  const looksLikeFeature = isFilm || (
    Number(existing?.meta?.episodes || 0) === 1
    && Number(existing?.meta?.duration || 0) >= 40
  );
  // Several streaming features are catalogued as ONA/OVA by AniList. Searching
  // only TMDB's TV index left them with no background even though the same title
  // exists in the movie index. Try the likely index first and retain the strict
  // title score below, so this expands coverage without weakening identity.
  const typeParams = looksLikeFeature ? ["&type=movie", ""] : [""];
  queryLoop: for (const q of queries.slice(0, 4)) {
    for (const typeParam of typeParams) {
      for (const withYear of (year ? [true, false] : [false])) {
        const payload = await getJson(`${BASE}/api/tmdb/search?q=${encodeURIComponent(q)}${typeParam}${withYear ? `&year=${year}` : ""}`);
        if (payload && payload.configured === false) throw new Error("TMDB not configured on the server");
        for (const r of payload?.results || []) {
          const candidateKey = `${r.media_type || (typeParam ? "movie" : "tv")}:${r.id}`;
          if (seen.has(candidateKey)) continue;
          seen.add(candidateKey);
          candidates.push(r);
        }
        if (candidates.length) break;
      }
      if (candidates.some((c) => titleScore(aniTitles, [c.name, c.original_name]) >= 95)) break queryLoop;
    }
  }
  if (!candidates.length) return { status: "no-tmdb-candidates", ...identityArtwork };

  const scored = candidates
    .map((c) => {
      const titleConfidence = titleScore(aniTitles, [c.name, c.original_name]);
      let score = titleConfidence;
      const cy = Number(String(c.first_air_date || "").slice(0, 4)) || null;
      // Only for a first season: seasons 2+ live under the season-1 series entry,
      // so their AniList year is legitimately years after first_air_date.
      if (wantSeason === 1 && year && cy) score += Math.abs(cy - year) <= 1 ? 6 : -14;
      if (!c.backdrop_path) score -= 40; // a match with no backdrop is useless here
      return { c, score, titleConfidence };
    })
    .sort((a, b) => b.score - a.score);

  const pinned = pinnedTmdbId ? scored.find(({ c }) => Number(c.id) === pinnedTmdbId) : null;
  const best = pinned ? { ...pinned, score: 100, titleConfidence: 100 } : scored[0];
  if (best && best.titleConfidence >= 78 && !best.c.backdrop_path && best.c.poster_path) {
    return {
      status: "poster-only",
      ...identityArtwork,
      tmdbId: best.c.id,
      tmdbPoster: `${TMDB_IMG}${best.c.poster_path}`,
      confidence: best.titleConfidence,
      matchedName: best.c.name,
      season: wantSeason
    };
  }
  // Deliberately strict: a wrong backdrop is worse than the strip we already show.
  if (!best || best.score < 78 || !best.c.backdrop_path) {
    return { status: "rejected", ...identityArtwork, bestScore: best?.score ?? 0, bestName: best?.c?.name || "" };
  }

  // 3. Prefer the season-specific backdrop when the title is a later season.
  let backdrop = best.c.backdrop_path;
  if (wantSeason > 1) {
    const details = await getJson(`${BASE}/api/tmdb/tv?id=${best.c.id}`);
    const seasons = details?.show?.seasons || [];
    const match = seasons.find((s) => Number(s.season_number) === wantSeason);
    if (match?.poster_path && details?.show?.backdrop_path) backdrop = details.show.backdrop_path;
  }

  return {
    status: "ok",
    ...identityArtwork,
    tmdbId: best.c.id,
    tmdbBackdrop: `${TMDB_IMG}${backdrop}`,
    tmdbPoster: best.c.poster_path ? `${TMDB_IMG}${best.c.poster_path}` : "",
    confidence: best.score,
    matchedName: best.c.name,
    season: wantSeason,
  };
}

async function main() {
  const payload = JSON.parse(fs.readFileSync(SRC, "utf8"));
  let items = (payload.items || []).filter((i) =>
    String(i.source || "").toLowerCase().includes("animeav1")
    || String(i.siteUrl || "").includes("animeav1.com/media/"));

  let map = {};
  // --force means re-resolve the selected rows, not discard every other row in
  // the resumable map. This makes a targeted identity repair safe to run.
  if (fs.existsSync(OUT)) {
    try { map = JSON.parse(fs.readFileSync(OUT, "utf8")).entries || {}; } catch { map = {}; }
  }

  // Relation-only seasons use stable `anilist-<id>` / `mal-<id>` rows. Include
  // them in the same resolver as source-backed catalog rows so a newly learned
  // sequel gets its own artwork on the same nightly run that discovers it.
  const itemIds = new Set(items.map((item) => item.id));
  for (const [id, entry] of Object.entries(map)) {
    if (itemIds.has(id) || !/^(?:anilist|mal)-\d+$/.test(id)) continue;
    const title = entry?.meta?.romajiTitle || entry?.meta?.englishTitle || "";
    if (!title) continue;
    items.push({
      id,
      title,
      type: entry.meta?.format || "",
      year: entry.meta?.year || null,
      anilistId: entry.anilistId || null,
      malId: entry.malId || entry.meta?.malId || null
    });
  }
  let todo = items.filter((i) =>
    (!ONLY_IDS.size || ONLY_IDS.has(i.id))
    && (FORCE || !map[i.id] || map[i.id].status !== "ok")
  );
  // Identity corrections must be rebuilt before ordinary rejected artwork
  // retries. This also makes a bounded nightly/manual run repair stale seasons
  // immediately instead of spending its whole budget on older misses first.
  todo.sort((a, b) =>
    Number(map[b.id]?.status === "identity-repaired")
    - Number(map[a.id]?.status === "identity-repaired")
  );
  if (LIMIT) todo = todo.slice(0, LIMIT);
  console.log(`${items.length} scraped titles, ${items.length - todo.length} already resolved, ${todo.length} to do`);

  let done = 0, ok = 0, rejected = 0, none = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < todo.length) {
      const item = todo[cursor++];
      try {
        const existing = map[item.id] || null;
        const result = await resolveOne(item, existing);
        // A retry updates artwork status without throwing away identity or
        // metadata established by the offline/Jikan passes.
        map[item.id] = existing ? { ...existing, ...result } : result;
        if (result.status === "ok") ok++;
        else if (result.status === "rejected") rejected++;
        else none++;
      } catch (err) {
        if (/not configured/.test(err.message)) throw err;
        map[item.id] = { status: "error", error: err.message };
      }
      done++;
      if (done % 25 === 0 || done === todo.length) {
        console.log(`  ${done}/${todo.length}  ok=${ok} rejected=${rejected} no-candidates=${none}`);
        fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), count: Object.keys(map).length, entries: map }, null, 0));
      }
      await sleep(120); // be gentle with the deployed API
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), count: Object.keys(map).length, entries: map }, null, 0));
  const okTotal = Object.values(map).filter((v) => v.status === "ok").length;
  console.log(`\nwrote ${OUT}`);
  console.log(`resolved ${okTotal}/${Object.keys(map).length} with a TMDB backdrop`);
}

main().catch((err) => { console.error("FAILED:", err.message); process.exit(1); });
