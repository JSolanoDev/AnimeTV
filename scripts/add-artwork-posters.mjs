// Fill in tmdbPoster for every entry the artwork map already resolved.
//
// The map was built to answer "what is this title's cinema background", so it only
// captured backdrop_path. The poster is the other half: 2000x3000 key art that the
// card grid and the watch page should use as the title poster, in place of the
// AnimeAV1 cover (225x350) or the AniList cover (460x690).
//
//   node scripts/add-artwork-posters.mjs [--force]
//
// Talks to TMDB directly using the key in .env - the deployed /api/tmdb/tv route
// returns a trimmed object, and there is no AniList call here, so no rate gate is
// needed. Resumable: entries that already carry a poster are skipped.

import fs from "node:fs";
import path from "node:path";
import https from "node:https";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const MAP = path.join(root, "scraper", "artwork-map.json");
const FORCE = process.argv.includes("--force");

// Read the key locally. It is never written into the map or any output.
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; })
);
const KEY = env.TMDB_API_KEY;
const TOKEN = env.TMDB_READ_ACCESS_TOKEN;
if (!KEY && !TOKEN) { console.error("FAILED: no TMDB credentials in .env"); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmdb(p) {
  return new Promise((res) => {
    const headers = { Accept: "application/json" };
    const url = new URL("https://api.themoviedb.org/3" + p);
    if (TOKEN) headers.Authorization = "Bearer " + TOKEN;
    else url.searchParams.set("api_key", KEY);
    https.get(url, { headers }, (r) => {
      const c = [];
      r.on("data", (d) => c.push(d));
      r.on("end", () => {
        if (r.statusCode !== 200) return res({ status: r.statusCode, body: null });
        try { res({ status: 200, body: JSON.parse(Buffer.concat(c).toString()) }); }
        catch { res({ status: 0, body: null }); }
      });
    }).on("error", () => res({ status: 0, body: null }));
  });
}

// The map records tmdbId but not which index it came from, so try tv then movie.
async function posterFor(tmdbId) {
  for (const kind of ["tv", "movie"]) {
    const r = await tmdb(`/${kind}/${tmdbId}`);
    if (r.status === 200 && r.body) {
      return { poster: r.body.poster_path || "", kind };
    }
    if (r.status === 429) { await sleep(2000); return posterFor(tmdbId); }
  }
  return { poster: "", kind: "" };
}

async function main() {
  const doc = JSON.parse(fs.readFileSync(MAP, "utf8"));
  const entries = doc.entries || {};
  const todo = Object.entries(entries)
    .filter(([, v]) => v.status === "ok" && v.tmdbId && (FORCE || !v.tmdbPoster));
  console.log(`${Object.keys(entries).length} entries, ${todo.length} need a poster`);

  let done = 0, got = 0, missing = 0, cursor = 0;
  const worker = async () => {
    while (cursor < todo.length) {
      const [id, v] = todo[cursor++];
      const { poster } = await posterFor(v.tmdbId);
      if (poster) { v.tmdbPoster = `https://image.tmdb.org/t/p/original${poster}`; got++; }
      else { v.tmdbPosterMissing = true; missing++; }
      done++;
      if (done % 50 === 0 || done === todo.length) {
        console.log(`  ${done}/${todo.length}  posters=${got} missing=${missing}`);
        fs.writeFileSync(MAP, JSON.stringify({ ...doc, entries }));
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));

  fs.writeFileSync(MAP, JSON.stringify({ ...doc, entries }));
  const total = Object.values(entries).filter((v) => v.tmdbPoster).length;
  console.log(`\n${total} entries now carry a TMDB poster`);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
