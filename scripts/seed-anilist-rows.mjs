// Seed artwork-map entries for the AniList-sourced catalogue rows.
//
// /api/catalog carries two kinds of row: the ~989 scraped AnimeAV1 rows, and ~87
// rows built straight from AniList (id "anilist-<id>" - Bleach, Naruto, Hunter x
// Hunter, Fullmetal Alchemist: Brotherhood, Re:Zero Break Time ...). The artwork
// map only ever covered the scraped ones, so those 87 shipped with NO backdrop, no
// year, no duration and no format - normalizeAniListShow() does not emit those
// fields at all.
//
// Identity is free here: the row id IS the AniList id. So this only has to seed a
// map entry per id; fill-meta-from-offline-db.mjs then fills metadata and
// add-tmdb-artwork.mjs resolves the backdrop, exactly as for the scraped rows.
//
//   node scripts/seed-anilist-rows.mjs --db <offline-db.jsonl> [--ids a,b,c] [--write]
//
// Without --ids it reads the live catalogue from --base (default production).

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const MAP = path.join(root, "scraper", "artwork-map.json");

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DB = argOf("--db", "");
const BASE = String(argOf("--base", "https://zenkaitv.com")).replace(/\/$/, "");
const IDS = argOf("--ids", "");
const WRITE = args.includes("--write");
if (!DB || !fs.existsSync(DB)) { console.error("pass --db <anime-offline-database.jsonl>"); process.exit(1); }

let ids = [];
if (IDS) {
  ids = IDS.split(",").map((s) => Number(s.trim())).filter(Boolean);
} else {
  const res = await fetch(`${BASE}/api/catalog`);
  const items = (await res.json()).items || [];
  ids = items
    .map((s) => String(s.id || "").match(/^anilist-(\d+)$/))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  console.log(`catalogue: ${items.length} rows, ${ids.length} AniList-sourced`);
}
ids = [...new Set(ids)];
console.log(`seeding ${ids.length} AniList ids`);

const idFrom = (s, host, re) => { for (const u of s || []) if (u.includes(host)) { const m = u.match(re); if (m) return Number(m[1]); } return null; };

const want = new Set(ids);
const found = new Map();
await new Promise((res) => {
  const rl = readline.createInterface({ input: fs.createReadStream(DB) });
  rl.on("line", (l) => {
    if (!l.trim()) return;
    let o; try { o = JSON.parse(l); } catch { return; }
    if (!o.sources || !o.title) return;
    const a = idFrom(o.sources, "anilist.co", /anilist\.co\/anime\/(\d+)/);
    if (!a || !want.has(a) || found.has(a)) return;
    found.set(a, { title: o.title, malId: idFrom(o.sources, "myanimelist.net", /myanimelist\.net\/anime\/(\d+)/) });
  });
  rl.on("close", res);
});
console.log(`matched in the offline database: ${found.size}/${ids.length}`);

const raw = JSON.parse(fs.readFileSync(MAP, "utf8"));
const entries = raw.entries || {};
let seeded = 0, already = 0, missing = 0;
for (const id of ids) {
  const key = `anilist-${id}`;
  if (entries[key]) { already++; continue; }
  const hit = found.get(id);
  if (!hit) { missing++; continue; }
  // status "seeded" rather than "ok": no TMDB match has been attempted yet, and
  // add-tmdb-artwork.mjs flips it to "ok" once a backdrop actually lands.
  entries[key] = { status: "seeded", anilistId: id, malId: hit.malId || null };
  seeded++;
}
console.log(`seeded ${seeded}, already present ${already}, not in the database ${missing}`);

if (!WRITE) { console.log("\n(dry run - pass --write to apply)"); process.exit(0); }
raw.entries = entries;
fs.writeFileSync(MAP, JSON.stringify(raw, null, 2));
console.log(`\nwrote ${MAP}`);
