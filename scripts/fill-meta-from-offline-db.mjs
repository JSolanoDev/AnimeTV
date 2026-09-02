// Fill scraper/artwork-map.json metadata straight from the offline database, by id.
//
// Companion to resolve-from-offline-db.mjs. That script establishes an identity for
// rows that had none; this one fills metadata for rows that HAVE an id but no
// metadata - the entries whose TMDB artwork match failed ("rejected" /
// "no-tmdb-candidates"), which add-artwork-metadata.mjs could not fetch while
// AniList was returning 403 and Jikan's search 504.
//
// No network at all: the database is keyed by AniList and MAL id, so this works
// during an outage. It also backfills malId wherever only an anilistId was known,
// which is what gives add-artwork-metadata.mjs its Jikan fallback route later.
//
//   node scripts/fill-meta-from-offline-db.mjs --db <path-to.jsonl> [--write]
//
// The database has no synopsis and its tags are not genres, so those two fields are
// left empty for a later AniList/Jikan pass to fill in.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const MAP = path.join(root, "scraper", "artwork-map.json");

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DB = argOf("--db", "");
const WRITE = args.includes("--write");
if (!DB || !fs.existsSync(DB)) { console.error("pass --db <anime-offline-database.jsonl>"); process.exit(1); }

const idFrom = (s, host, re) => { for (const u of s || []) if (u.includes(host)) { const m = u.match(re); if (m) return Number(m[1]); } return null; };

// The database status vocabulary is FINISHED / ONGOING / UPCOMING. The client reads
// AniList's, and getSeasonEpisodeLimit() keys off these exact strings to decide how
// many episodes have aired - a wrong value empties the episode list (v627/v628), so
// map explicitly and leave it blank when unrecognised.
const STATUS = { FINISHED: "FINISHED", ONGOING: "RELEASING", UPCOMING: "NOT_YET_RELEASED" };

const byAni = new Map();
const byMal = new Map();
await new Promise((res) => {
  const rl = readline.createInterface({ input: fs.createReadStream(DB) });
  rl.on("line", (l) => {
    if (!l.trim()) return;
    let o; try { o = JSON.parse(l); } catch { return; }
    if (!o.sources || !o.title) return;
    const anilistId = idFrom(o.sources, "anilist.co", /anilist\.co\/anime\/(\d+)/);
    const malId = idFrom(o.sources, "myanimelist.net", /myanimelist\.net\/anime\/(\d+)/);
    if (!anilistId && !malId) return;
    const e = {
      malId,
      year: o.animeSeason?.year || null,
      // The database scores 1-10; this app renders "${score}%" on a 0-100 scale.
      score: typeof o.score?.arithmeticMean === "number" ? Math.round(o.score.arithmeticMean * 10) : null,
      genres: [],                    // db has tags, not genres - too noisy to map
      description: "",               // not carried by the database
      duration: o.duration ? (o.duration.unit === "SECONDS" ? Math.round(o.duration.value / 60) : o.duration.value) : null,
      episodes: typeof o.episodes === "number" ? o.episodes : null,
      format: o.type || "",
      airingStatus: STATUS[String(o.status || "").toUpperCase()] || "",
      country: "",
      studio: (o.studios || [])[0] || "",
      englishTitle: "",
      romajiTitle: o.title || "",
      _via: "offline-db"
    };
    if (anilistId) byAni.set(anilistId, e);
    if (malId) byMal.set(malId, e);
  });
  rl.on("close", res);
});
console.log(`database indexed: ${byAni.size} by AniList id, ${byMal.size} by MAL id`);

const raw = JSON.parse(fs.readFileSync(MAP, "utf8"));
const entries = raw.entries || {};
const keys = Object.keys(entries);

let filledMeta = 0, filledMal = 0, noHit = 0;
for (const k of keys) {
  const e = entries[k];
  if (!e) continue;
  const hit = (e.anilistId && byAni.get(Number(e.anilistId))) || (e.malId && byMal.get(Number(e.malId))) || null;
  if (!hit) { if (!e.meta) noHit++; continue; }
  // Backfill the MAL id wherever only the AniList id was known - that is the route
  // add-artwork-metadata.mjs needs when AniList is unavailable.
  if (!e.malId && hit.malId) { e.malId = hit.malId; filledMal++; }
  if (!e.meta) { e.meta = { ...hit }; filledMeta++; }
}

console.log(`entries              : ${keys.length}`);
console.log(`metadata filled      : ${filledMeta}`);
console.log(`malId backfilled     : ${filledMal}`);
console.log(`still without meta   : ${keys.filter((k) => !entries[k].meta).length} (${noHit} had no database hit)`);

if (!WRITE) { console.log("\n(dry run - pass --write to apply)"); process.exit(0); }
raw.entries = entries;
raw.metadataGeneratedAt = new Date().toISOString();
fs.writeFileSync(MAP, JSON.stringify(raw, null, 2));
console.log(`\nwrote ${MAP}`);
