// Resolve the catalogue rows that AniList's SEARCH cannot reach, using the
// manami-project anime-offline-database instead of a live API.
//
// Why: on 2026-09-02 AniList returned 403 ("temporarily disabled due to severe
// stability issues") and Jikan's search returned 504 ("failed to connect to
// MyAnimeList") at the same time, so every title -> id route was down and 114
// catalogue rows were stuck with no id, no metadata and no TMDB artwork. Those are
// the pages that render as a bare title over a cropped poster.
//
// The offline database is a static release asset on GitHub - it needs neither API.
// It cross-references AniList / MAL / Kitsu / AniDB ids and carries title,
// synonyms, type, episodes, status, year, duration, score and studios.
//
//   node scripts/resolve-from-offline-db.mjs --db <path-to.jsonl> [--write] [--min 88]
//
// Without --write it only reports; nothing is modified. A wrong id is worse than no
// id (it attaches another show's synopsis, score and artwork), so matches below the
// confidence bar are listed for review rather than applied.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const MAP = path.join(root, "scraper", "artwork-map.json");
const SRC = path.join(root, "scraper", "anime_metadata.json");
const OVERRIDES = path.join(root, "scraper", "anilist-id-overrides.json");

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DB = argOf("--db", "");
const WRITE = args.includes("--write");
const MIN = Number(argOf("--min", "88"));
if (!DB || !fs.existsSync(DB)) { console.error("pass --db <anime-offline-database.jsonl>"); process.exit(1); }

// Same normalisation the artwork build uses, so behaviour matches.
const norm = (s) => String(s || "").toLowerCase()
  .replace(/[’'`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const SEASON_WORDS = /\b(?:season|saison|temporada|part|cour|final|2nd|3rd|4th|1st)\b/g;
const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8 };
function seasonNumberOf(title) {
  const t = norm(title);
  let m = t.match(/\b(?:season|temporada|part|cour)\s*(\d+)\b/); if (m) return Number(m[1]);
  m = t.match(/\b(\d+)(?:st|nd|rd|th)\s+season\b/); if (m) return Number(m[1]);
  m = t.match(/\s(i{1,3}|iv|vi{0,3})$/); if (m && ROMAN[m[1]]) return ROMAN[m[1]];
  m = t.match(/\s(\d{1,2})$/); if (m) return Number(m[1]);
  return 1;
}
const baseTitle = (t) => norm(t)
  .replace(SEASON_WORDS, " ").replace(/\s(i{1,3}|iv|vi{0,3})$/, " ")
  .replace(/\s+\d+\s*$/, " ").replace(/\s+/g, " ").trim();
const squash = (s) => s.replace(/ /g, "");

const idFrom = (sources, host, re) => {
  for (const u of sources || []) if (u.includes(host)) { const m = u.match(re); if (m) return Number(m[1]); }
  return null;
};

// ── Load the database ──────────────────────────────────────────────────────────
const byBase = new Map();   // season-stripped base title -> [entry]
let dbCount = 0;
await new Promise((resolve) => {
  const rl = readline.createInterface({ input: fs.createReadStream(DB) });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let o; try { o = JSON.parse(line); } catch { return; }
    if (!o.sources || !o.title) return;            // skips the header line
    dbCount++;
    const entry = {
      title: o.title,
      synonyms: o.synonyms || [],
      type: o.type || "",
      episodes: typeof o.episodes === "number" ? o.episodes : null,
      status: o.status || "",
      year: o.animeSeason?.year || null,
      duration: o.duration ? (o.duration.unit === "SECONDS" ? Math.round(o.duration.value / 60) : o.duration.value) : null,
      score: o.score?.arithmeticMean ?? null,
      studios: o.studios || [],
      picture: o.picture || "",
      anilistId: idFrom(o.sources, "anilist.co", /anilist\.co\/anime\/(\d+)/),
      malId: idFrom(o.sources, "myanimelist.net", /myanimelist\.net\/anime\/(\d+)/)
    };
    if (!entry.anilistId && !entry.malId) return;
    for (const name of [o.title, ...(o.synonyms || [])]) {
      const b = baseTitle(name);
      if (!b) continue;
      if (!byBase.has(b)) byBase.set(b, []);
      const list = byBase.get(b);
      if (!list.includes(entry)) list.push(entry);
    }
  });
  rl.on("close", resolve);
});
console.log(`database: ${dbCount} entries, ${byBase.size} distinct base titles`);

// ── The rows that still need an identity ───────────────────────────────────────
const raw = JSON.parse(fs.readFileSync(MAP, "utf8"));
const entries = raw.entries || {};
const scraped = (JSON.parse(fs.readFileSync(SRC, "utf8")).items || [])
  .filter((i) => String(i.source || "").toLowerCase().includes("animeav1")
    || String(i.siteUrl || "").includes("animeav1.com/media/"));
const titleOf = new Map(scraped.map((s) => [s.id, s.title]));

const rowOf = new Map(scraped.map((s) => [s.id, s]));
const targets = Object.keys(entries)
  .filter((k) => !entries[k].anilistId && !entries[k].malId)
  .map((k) => ({ slug: k, title: titleOf.get(k) || "", year: rowOf.get(k)?.year || null }))
  .filter((t) => t.title);
console.log(`rows with no identity at all: ${targets.length}`);

// ── Match ──────────────────────────────────────────────────────────────────────
// The season number must agree. That is the single biggest source of wrong matches
// ("Youjo Senki II" must never resolve to season 1), and it is the same rule
// build-artwork-map.mjs applies.
function scoreNames(a, b) {
  const na = baseTitle(a), nb = baseTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  if (squash(na) === squash(nb)) return 100;
  if (na.startsWith(nb) || nb.startsWith(na)) return 88;
  const aw = new Set(na.split(" ")), bw = new Set(nb.split(" "));
  const inter = [...aw].filter((w) => bw.has(w)).length;
  return Math.round((inter / Math.max(aw.size, bw.size)) * 80);
}

// A row that looks like an unannounced-season placeholder rather than a real
// entry: one "episode" of something plainly serial, dated in the future, and not
// yet indexed by MyAnimeList.
const looksLikeStub = (c) => c.episodes === 1 && /^(TV|ONA)$/.test(c.type || "") && !c.malId;

// Used only to break ties between candidates that scored identically.
function tieBreak(a, b, scrapedYear) {
  const stub = (looksLikeStub(a.entry) ? 1 : 0) - (looksLikeStub(b.entry) ? 1 : 0);
  if (stub) return stub;                                   // a stub loses
  const mal = (b.entry.malId ? 1 : 0) - (a.entry.malId ? 1 : 0);
  if (mal) return mal;                                     // indexed by MAL wins
  if (scrapedYear) {
    const da = Math.abs((a.entry.year || 0) - scrapedYear);
    const db = Math.abs((b.entry.year || 0) - scrapedYear);
    if (da !== db) return da - db;                          // closer year wins
  }
  return (a.entry.anilistId || 1e9) - (b.entry.anilistId || 1e9); // stable
}

const resolved = [], rejected = [], missed = [];
for (const t of targets) {
  const want = seasonNumberOf(t.title);
  const cands = byBase.get(baseTitle(t.title)) || [];
  if (!cands.length) { missed.push({ ...t, why: "no candidate with that base title" }); continue; }
  let best = null;
  for (const c of cands) {
    const names = [c.title, ...c.synonyms];
    let s = 0;
    for (const n of names) s = Math.max(s, scoreNames(t.title, n));
    // Season agreement, checked against whichever of its names scored the match.
    const cSeason = Math.min(...names.map(seasonNumberOf));
    const seasonOk = names.some((n) => seasonNumberOf(n) === want);
    if (!seasonOk) s -= 40;
    const cand = { score: s, entry: c, cSeason };
    if (!best || s > best.score || (s === best.score && tieBreak(cand, best, t.year) < 0)) best = cand;
  }
  const row = { slug: t.slug, title: t.title, wantSeason: want, score: best.score, entry: best.entry };
  if (best.score >= MIN) resolved.push(row); else rejected.push(row);
}

// Two seasons of one franchise must never share an id. If the scorer produced
// that anyway, neither is trustworthy - drop both rather than guess.
const idUse = {};
for (const r of resolved) if (r.entry.anilistId) idUse[r.entry.anilistId] = (idUse[r.entry.anilistId] || 0) + 1;
const collided = resolved.filter((r) => r.entry.anilistId && idUse[r.entry.anilistId] > 1);
if (collided.length) {
  console.log(`\nDROPPED ${collided.length} colliding matches (same id proposed for several slugs):`);
  for (const c of collided) console.log(`  AL=${c.entry.anilistId}  ${c.title.slice(0, 56)}`);
  for (const c of collided) { resolved.splice(resolved.indexOf(c), 1); rejected.push(c); }
}

const OUT = argOf("--out", "");
if (OUT) {
  fs.writeFileSync(OUT, JSON.stringify(resolved.map((r) => ({
    slug: r.slug, title: r.title, score: r.score,
    anilistId: r.entry.anilistId, malId: r.entry.malId,
    dbTitle: r.entry.title, type: r.entry.type, episodes: r.entry.episodes, year: r.entry.year
  })), null, 1));
  console.log(`wrote ${OUT}`);
}

console.log(`\nconfident (>= ${MIN}): ${resolved.length}`);
console.log(`below the bar        : ${rejected.length}`);
console.log(`no candidate at all  : ${missed.length}`);

console.log("\n--- resolved ---");
for (const r of resolved) {
  console.log(`  ${String(r.score).padStart(3)}  ${r.title.slice(0, 44).padEnd(44)} -> ${String(r.entry.title).slice(0, 40).padEnd(40)} AL=${r.entry.anilistId} MAL=${r.entry.malId} ${r.entry.type} ${r.entry.episodes}ep ${r.entry.year || "-"}`);
}
console.log("\n--- below the bar (NOT applied) ---");
for (const r of rejected.slice(0, 40)) {
  console.log(`  ${String(r.score).padStart(3)}  ${r.title.slice(0, 44).padEnd(44)} -> ${String(r.entry?.title || "-").slice(0, 40)}`);
}
console.log("\n--- no candidate ---");
for (const m of missed.slice(0, 40)) console.log(`       ${m.title.slice(0, 60)}`);

if (!WRITE) { console.log("\n(dry run - pass --write to apply)"); process.exit(0); }

// ── Apply ──────────────────────────────────────────────────────────────────────
// Ids go into the override file so a future build-artwork-map run reuses them, and
// straight into the map so the fix lands without waiting for AniList to come back.
const ov = JSON.parse(fs.readFileSync(OVERRIDES, "utf8"));
const AOD_STATUS = { FINISHED: "FINISHED", ONGOING: "RELEASING", UPCOMING: "NOT_YET_RELEASED" };
let applied = 0;
for (const r of resolved) {
  const e = r.entry;
  if (e.anilistId) ov.overrides[r.slug] = e.anilistId;
  const entry = entries[r.slug] || (entries[r.slug] = { status: "offline-db" });
  entry.anilistId = e.anilistId || entry.anilistId || null;
  entry.malId = e.malId || entry.malId || null;
  if (!entry.meta) {
    entry.meta = {
      malId: e.malId || null,
      year: e.year || null,
      // The database scores 1-10; this app renders "${score}%" on a 0-100 scale.
      score: typeof e.score === "number" ? Math.round(e.score * 10) : null,
      genres: [],                 // the db has tags, not genres - too noisy to map
      description: "",            // not carried by the database
      duration: e.duration || null,
      episodes: e.episodes ?? null,
      format: e.type || "",
      // Mapped explicitly: getSeasonEpisodeLimit() keys off these exact strings and
      // a wrong value empties the episode list (see v627/v628).
      airingStatus: AOD_STATUS[String(e.status || "").toUpperCase()] || "",
      country: "",
      studio: (e.studios || [])[0] || "",
      englishTitle: "",
      romajiTitle: e.title || "",
      _via: "offline-db"
    };
  }
  applied++;
}
fs.writeFileSync(OVERRIDES, JSON.stringify(ov, null, 2));
raw.entries = entries;
fs.writeFileSync(MAP, JSON.stringify(raw, null, 2));
console.log(`\napplied ${applied} identities to the map and the override file`);
