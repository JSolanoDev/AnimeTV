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

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = String(argOf("--base", "https://zenkaitv.com")).replace(/\/$/, "");
const LIMIT = Number(argOf("--limit", "0")) || 0;
const FORCE = args.includes("--force");
const CONCURRENCY = Number(argOf("--concurrency", "4")) || 4;

// TMDB's own w1280 is 1280x720; "original" is whatever the uploader gave (often
// 1920x1080 or 3840x2160). Store original and let /api/image resize down to the
// viewport width - never up.
const TMDB_IMG = "https://image.tmdb.org/t/p/original";

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

async function anilistSearch(title) {
  let loose = null;
  for (const variant of anilistVariants(title)) {
    const media = await anilistDirect(variant);
    if (!media) continue;
    // The full title matching itself is always trustworthy; a shortened variant
    // has to earn it.
    if (variant === title || anilistLooksRight(media, title)) return media;
    if (!loose) loose = { media, variant };
  }
  if (loose) console.log(`  discarded loose AniList hit for "${title.slice(0, 40)}": ${loose.media.title?.romaji || ""}`.slice(0, 140));
  return null;
}

async function resolveOne(item) {
  const title = item.title || "";
  const media = await anilistSearch(title);
  const aniTitles = media ? [media.title?.romaji, media.title?.english, media.title?.native, ...(media.synonyms || [])] : [title];
  const year = media?.seasonYear || media?.startDate?.year || item.year || null;
  const wantSeason = seasonNumberOf(media?.title?.romaji || title);

  // AniList is the identity we trust; without it a romaji-only TMDB search
  // matches the wrong franchise as often as the right one. Leave it for a re-run
  // (the map is resumable and only retries entries that are not "ok").
  if (!media) return { status: "anilist-failed" };

  // 2. TMDB - search on the strongest titles we now have. TMDB indexes anime as
  // ONE series per franchise, titled in English, with no season suffix, so the
  // season-stripped english title is by far the best query. Every query is also
  // retried without the year: for a later season AniList reports 2026 while the
  // TMDB series first aired years earlier, and the year filter returns nothing.
  const queries = [...new Set([
    stripSeasonSuffix(media.title?.english),
    media.title?.english,
    stripSeasonSuffix(media.title?.romaji),
    media.title?.romaji,
    stripSeasonSuffix(title),
    title
  ].filter(Boolean))];
  const seen = new Set();
  const candidates = [];
  // Films live in a separate TMDB index; /search/tv returns nothing for them.
  const isFilm = /movie|film|pelicula/i.test(`${item.type || ""} ${media.format || ""} ${title}`);
  const typeParam = isFilm ? "&type=movie" : "";
  for (const q of queries.slice(0, 4)) {
    for (const withYear of (year ? [true, false] : [false])) {
      const payload = await getJson(`${BASE}/api/tmdb/search?q=${encodeURIComponent(q)}${typeParam}${withYear ? `&year=${year}` : ""}`);
      if (payload && payload.configured === false) throw new Error("TMDB not configured on the server");
      for (const r of payload?.results || []) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        candidates.push(r);
      }
      if (candidates.length) break;
    }
    if (candidates.some((c) => titleScore(aniTitles, [c.name, c.original_name]) >= 95)) break;
  }
  if (!candidates.length) return { status: "no-tmdb-candidates", anilistId: media?.id || null };

  const scored = candidates
    .map((c) => {
      let score = titleScore(aniTitles, [c.name, c.original_name]);
      const cy = Number(String(c.first_air_date || "").slice(0, 4)) || null;
      // Only for a first season: seasons 2+ live under the season-1 series entry,
      // so their AniList year is legitimately years after first_air_date.
      if (wantSeason === 1 && year && cy) score += Math.abs(cy - year) <= 1 ? 6 : -14;
      if (!c.backdrop_path) score -= 40; // a match with no backdrop is useless here
      return { c, score };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  // Deliberately strict: a wrong backdrop is worse than the strip we already show.
  if (!best || best.score < 78 || !best.c.backdrop_path) {
    return { status: "rejected", anilistId: media?.id || null, bestScore: best?.score ?? 0, bestName: best?.c?.name || "" };
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
    anilistId: media?.id || null,
    malId: media?.idMal || null,
    tmdbId: best.c.id,
    tmdbBackdrop: `${TMDB_IMG}${backdrop}`,
    confidence: best.score,
    matchedName: best.c.name,
    season: wantSeason,
    anilistBanner: media?.bannerImage || "",
    anilistCover: media?.coverImage?.extraLarge || media?.coverImage?.large || ""
  };
}

async function main() {
  const payload = JSON.parse(fs.readFileSync(SRC, "utf8"));
  let items = (payload.items || []).filter((i) =>
    String(i.source || "").toLowerCase().includes("animeav1")
    || String(i.siteUrl || "").includes("animeav1.com/media/"));
  if (LIMIT) items = items.slice(0, LIMIT);

  let map = {};
  if (fs.existsSync(OUT) && !FORCE) {
    try { map = JSON.parse(fs.readFileSync(OUT, "utf8")).entries || {}; } catch { map = {}; }
  }

  const todo = items.filter((i) => FORCE || !map[i.id] || map[i.id].status !== "ok");
  console.log(`${items.length} scraped titles, ${items.length - todo.length} already resolved, ${todo.length} to do`);

  let done = 0, ok = 0, rejected = 0, none = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < todo.length) {
      const item = todo[cursor++];
      try {
        const result = await resolveOne(item);
        map[item.id] = result;
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
