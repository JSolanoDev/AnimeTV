// Fill tmdbBackdrop / tmdbPoster for artwork-map entries that still have none.
//
// build-artwork-map.mjs normally does this, but it resolves identity through
// AniList first, and AniList was returning 403 for hours on 2026-09-02. TMDB itself
// is unaffected, and the offline database already gave every row a title and a set
// of synonyms, so the TMDB half can run on its own.
//
// Those 114 rows are the ones that render as a bare title over a cropped poster,
// because .is-poster-fit is the fallback when there is no wide art at all.
//
//   node scripts/add-tmdb-artwork.mjs --db <offline-db.jsonl> [--write] [--limit N]
//
// Conservative on purpose: a wrong backdrop is more visible than a missing one, so
// a match must clear the title bar AND, when both years are known, agree on year.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const MAP = path.join(root, "scraper", "artwork-map.json");
const SRC = path.join(root, "scraper", "anime_metadata.json");

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DB = argOf("--db", "");
const BASE = String(argOf("--base", "https://zenkaitv.com")).replace(/\/$/, "");
const WRITE = args.includes("--write");
const LIMIT = Number(argOf("--limit", "0")) || 0;
const MIN = Number(argOf("--min", "80"));
const TMDB_IMG = "https://image.tmdb.org/t/p/original";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || "").toLowerCase().replace(/[’'`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const SEASON_WORDS = /\b(?:season|saison|temporada|part|cour|final|2nd|3rd|4th|1st)\b/g;
const baseTitle = (t) => norm(t).replace(SEASON_WORDS, " ").replace(/\s(i{1,3}|iv|vi{0,3})$/, " ")
  .replace(/\s+\d+\s*$/, " ").replace(/\s+/g, " ").trim();
// TMDB indexes anime as ONE series per franchise, in English, with no season
// suffix, so the query must be the season-stripped title.
const stripSeason = (t) => String(t || "")
  .replace(/\s*[:\-]?\s*(?:season|saison|temporada|part|cour)\s*\d+\s*$/i, "")
  .replace(/\s+\d+(?:st|nd|rd|th)\s+season\s*$/i, "")
  .replace(/\s+(?:II|III|IV|V|VI|VII|VIII)\s*$/, "")
  .trim();
// The parent franchise name, for specials / OVAs / side stories. TMDB gives most of
// these no entry of their own but does index the parent series, and a spin-off
// showing its franchise's backdrop is right - that is already what the accepted
// "One Piece: Gyojin Tou-hen" -> "One Piece" matches do. Used only as a LAST resort,
// after the full title has failed, so anything with its own TMDB entry still wins.
const FORMAT_TAIL = /\s*[-:]?\s*\(?\b(?:ona|ova|tv|special|specials|movie|film|shorts?|picture drama|recap)\b\)?\s*$/i;
const franchiseBase = (t) => {
  let s = String(t || "").replace(FORMAT_TAIL, "").trim();
  const cut = s.search(/\s[:\-–—]\s|:/);
  if (cut > 2) s = s.slice(0, cut).trim();
  return stripSeason(s).replace(/[:\-–—]\s*$/, "").trim();
};
// Collapse spellings of one name to a single query slot, keeping the first form.
const uniqByBase = (arr) => {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    const k = baseTitle(s);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
};
const looksEnglish = (s) => /^[\x20-\x7E]+$/.test(s) && /[aeiou]/i.test(s);
// A short, generic alias is poison. The offline database lists "Demon Lord" as a
// synonym of Maou-sama, Retry!; querying that returns TMDB's unrelated
// "DEMON LORD 2099", and because baseTitle() strips a trailing number the two
// compared equal and scored a false 100. Require real specificity before an alias
// may drive a query or vouch for a match.
const isSpecific = (s) => {
  const n = baseTitle(s);
  return n.length >= 12 || n.split(" ").filter(Boolean).length >= 3;
};

// TMDB titles keep their numbers ("2099", "86"), so the RESULT side is normalised
// without the trailing-number strip that baseTitle applies to scraped season
// markers. Stripping it there is what let "demon lord 2099" equal "demon lord".
const tmdbName = (t) => norm(t).replace(SEASON_WORDS, " ").replace(/\s+/g, " ").trim();

function score(aNames, bNames) {
  let best = 0;
  for (const a of aNames.filter(Boolean)) for (const b of bNames.filter(Boolean)) {
    const na = baseTitle(a), nb = tmdbName(b);
    if (!na || !nb) continue;
    if (na === nb || na.replace(/ /g, "") === nb.replace(/ /g, "")) { best = Math.max(best, 100); continue; }
    // Prefix matching is only safe in ONE direction. Our title extending TMDB's is
    // the normal franchise case - "One Piece: Gyojin Tou-hen" over TMDB's
    // "One Piece", "Shingeki no Kyojin: The Final Season" over "Attack on Titan" -
    // because TMDB indexes anime as one series per franchise.
    if (na.startsWith(nb)) { best = Math.max(best, 88); continue; }
    // The other direction is how "Demon Lord" (a synonym of Maou-sama, Retry!)
    // attached itself to TMDB's unrelated "DEMON LORD 2099". Allow it only when our
    // own name is specific enough to carry the claim.
    if (nb.startsWith(na) && isSpecific(a)) { best = Math.max(best, 88); continue; }
    const aw = new Set(na.split(" ")), bw = new Set(nb.split(" "));
    const inter = [...aw].filter((w) => bw.has(w)).length;
    best = Math.max(best, Math.round((inter / Math.max(aw.size, bw.size)) * 80));
  }
  return best;
}

const idFrom = (s, host, re) => { for (const u of s || []) if (u.includes(host)) { const m = u.match(re); if (m) return Number(m[1]); } return null; };

// Titles + synonyms per id, so the TMDB query can use the English name when the
// database has one - TMDB is indexed in English and a romaji query often misses.
const names = new Map();
const byBaseName = new Map();
if (DB && fs.existsSync(DB)) {
  await new Promise((res) => {
    const rl = readline.createInterface({ input: fs.createReadStream(DB) });
    rl.on("line", (l) => {
      if (!l.trim()) return;
      let o; try { o = JSON.parse(l); } catch { return; }
      if (!o.sources || !o.title) return;
      const a = idFrom(o.sources, "anilist.co", /anilist\.co\/anime\/(\d+)/);
      const m = idFrom(o.sources, "myanimelist.net", /myanimelist\.net\/anime\/(\d+)/);
      const all = [o.title, ...(o.synonyms || [])];
      if (a) names.set(`a${a}`, all);
      if (m) names.set(`m${m}`, all);
      // Also index by base title, so a special can look up its PARENT entry's
      // names. TMDB does not index "Boku no Hero Academia" at all - only
      // "My Hero Academia" - and that English name lives on the parent series'
      // database entry, not on the ONA's own.
      const b = baseTitle(o.title);
      if (b && !byBaseName.has(b)) byBaseName.set(b, all);
    });
    rl.on("close", res);
  });
  console.log(`offline db: names for ${names.size} ids`);
}

async function getJson(u, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(u, { headers: { "User-Agent": "ZenkaiTV-tmdb-artwork" } });
      if (r.status === 429 || r.status >= 500) { await sleep(1200 * i); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch { await sleep(800 * i); }
  }
  return null;
}

const raw = JSON.parse(fs.readFileSync(MAP, "utf8"));
const entries = raw.entries || {};
const scraped = (JSON.parse(fs.readFileSync(SRC, "utf8")).items || [])
  .filter((i) => String(i.source || "").toLowerCase().includes("animeav1") || String(i.siteUrl || "").includes("animeav1.com/media/"));
const titleOf = new Map(scraped.map((s) => [s.id, s.title]));

let todo = Object.keys(entries).filter((k) => !entries[k].tmdbBackdrop);
if (LIMIT) todo = todo.slice(0, LIMIT);
console.log(`rows without a backdrop: ${todo.length}`);

let ok = 0, weak = 0, none = 0;
for (let i = 0; i < todo.length; i++) {
  const slug = todo[i];
  const e = entries[slug];
  const scrapedTitle = titleOf.get(slug) || e.meta?.romajiTitle || "";
  if (!scrapedTitle) { none++; continue; }
  // All aliases are kept: filtering short ones out cost real matches (the English
  // synonym "True Beauty" is only 11 characters). Precision comes from the
  // directional prefix rule in score(), not from discarding names here.
  const alias = names.get(`a${e.anilistId}`) || names.get(`m${e.malId}`) || [];
  const isMovie = String(e.meta?.format || "").toUpperCase() === "MOVIE";
  const year = e.meta?.year || null;

  // English aliases first - TMDB is an English index.
  //
  // Deduped by NORMALISED form, not by exact string. The database lists many
  // near-identical variants ("Boku no Hero Academia (ONA)" / "(Web)" / "HLA"), and
  // a plain Set kept all of them, so the query budget was spent on five spellings
  // of one name that TMDB does not index while the genuinely different English
  // title further down the list was never tried.
  const queries = uniqByBase([
    ...alias.filter(looksEnglish).map(stripSeason),
    stripSeason(scrapedTitle),
    scrapedTitle
  ].map((s) => s.trim()).filter((s) => s.length > 2)).slice(0, 8);

  let best = null;
  let scoreNames = [...alias, scrapedTitle];
  const runQueries = async (qs, franchisePass) => {
    for (const q of qs) {
      await sleep(150);
      const url = `${BASE}/api/tmdb/search?q=${encodeURIComponent(q)}${isMovie ? "&type=movie" : ""}`;
      const payload = await getJson(url);
      for (const r of (payload?.results || [])) {
        if (!r.backdrop_path) continue;
        const rNames = [r.name, r.title, r.original_name, r.original_title];
        let s = score(scoreNames, rNames);
        const rYear = Number(String(r.first_air_date || r.release_date || "").slice(0, 4)) || null;
        // Year is corroboration, not identity: TMDB dates the FRANCHISE from season 1,
        // so a later season legitimately disagrees. Only reward agreement.
        if (year && rYear && Math.abs(year - rYear) <= 1) s += 6;
        if (!best || s > best.s) best = { s, r, franchisePass };
      }
      if (best && best.s >= 100) return;
    }
  };
  await runQueries(queries, false);

  // Last resort: the parent franchise. Specials, OVAs and side stories mostly have
  // no TMDB entry of their own - "Undead Unluck: Winter-hen", "Yuru Camp Season 3
  // Specials", "Boku no Hero Academia ONA" - but their franchise does, and showing
  // the franchise backdrop is correct. Only after the full title has failed, so
  // anything with its own entry still wins on its own name.
  if (!best || best.s < MIN) {
    const bases = [...alias.filter(looksEnglish).map(franchiseBase), franchiseBase(scrapedTitle)]
      .map((s) => s.trim()).filter((s) => s.length > 2);
    // Pull in the PARENT entry's own names. Without this the franchise pass can
    // only query the romaji base, which for several franchises TMDB does not index
    // at all - "Boku no Hero Academia" returns zero results, "My Hero Academia" is
    // the only name that works, and it lives on the parent's database entry.
    const parentNames = [];
    for (const b of bases) for (const n of (byBaseName.get(baseTitle(b)) || [])) parentNames.push(n);
    // The franchise name is now a legitimate thing to match on: we are deliberately
    // looking for the parent series, so its name should vouch for the result.
    scoreNames = [...scoreNames, ...bases, ...parentNames.filter(isSpecific)];
    // Specific English parent names FIRST. TMDB is an English index, and the
    // romaji base often returns nothing at all, so leading with it wasted the
    // budget; the acronym synonyms the database carries ("BNHA", "MHA") then ate
    // the rest of the slots before "My Hero Academia" was ever tried.
    const fq = uniqByBase([
      ...parentNames.filter((n) => looksEnglish(n) && isSpecific(n)),
      ...bases
    ])
      .filter((q) => !queries.includes(q))
      .slice(0, 5);
    if (fq.length) await runQueries(fq, true);
  }

  if (!best) { none++; continue; }
  if (best.s < MIN) { weak++; console.log(`  weak ${String(best.s).padStart(3)}  ${scrapedTitle.slice(0, 40).padEnd(40)} -> ${String(best.r.name || best.r.title).slice(0, 34)}`); continue; }
  e.tmdbId = best.r.id;
  e.tmdbBackdrop = TMDB_IMG + best.r.backdrop_path;
  if (best.r.poster_path) e.tmdbPoster = TMDB_IMG + best.r.poster_path;
  if (e.status !== "ok") e.status = "ok";
  ok++;
  console.log(`  ${String(best.s).padStart(3)}${best.franchisePass ? " F" : "  "} ${scrapedTitle.slice(0, 42).padEnd(42)} -> ${String(best.r.name || best.r.title).slice(0, 36).padEnd(36)} ${String(best.r.first_air_date || best.r.release_date || "").slice(0, 4)}`);
}

console.log(`\nmatched   : ${ok}`);
console.log(`below bar : ${weak}`);
console.log(`no result : ${none}`);

if (!WRITE) { console.log("\n(dry run - pass --write to apply)"); process.exit(0); }
raw.entries = entries;
fs.writeFileSync(MAP, JSON.stringify(raw, null, 2));
console.log(`\nwrote ${MAP}`);
