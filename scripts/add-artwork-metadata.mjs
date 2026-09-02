// Attach AniList metadata (year, score, genres, synopsis, duration, format...) to
// every entry in scraper/artwork-map.json, ONCE, at build time.
//
// Why this exists: /api/catalog ships 1079 rows and, measured 2026-09-02, ZERO of
// them were fully populated - year on 15 rows (1.4%), duration and format on none.
// 963 rows carry a perfectly good anilistId and still rendered as bare "Movie" or
// "TV" with no year, score, genres or synopsis.
//
// The cause is the same one build-artwork-map.mjs fixed for artwork: metadata is
// resolved client-side, per title, on demand. Artwork is now 81% covered because it
// is baked into the catalogue; metadata was left on the runtime chain and so sat
// near zero. This puts it on the same footing.
//
// Unlike the artwork build this does NOT search - every id is already known - so it
// queries AniList by id, 50 per request via Page(media(id_in:)). All ~960 ids take
// about 20 requests instead of ~960, which matters because AniList is currently
// handing out 30 requests/minute, not the documented 90.
//
//   node scripts/add-artwork-metadata.mjs [--force] [--limit N] [--interval MS]
//
// Resumable: entries that already carry `meta` are skipped unless --force.

import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const MAP = path.join(root, "scraper", "artwork-map.json");

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const FORCE = args.includes("--force");
const LIMIT = Number(argOf("--limit", "0")) || 0;
// AniList answered 30/min on 2026-09-02 (x-ratelimit-limit), well below the
// documented 90. 2500ms keeps a margin even if several runs overlap.
const INTERVAL = Number(argOf("--interval", "2500"));
const BATCH = 50;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ANILIST_URL = "https://graphql.anilist.co";
const QUERY = `query ($ids: [Int]) {
  Page(page: 1, perPage: ${BATCH}) {
    media(id_in: $ids, type: ANIME) {
      id idMal seasonYear season format status episodes duration
      averageScore genres countryOfOrigin
      title { romaji english native }
      description(asHtml: false)
      startDate { year }
      studios(isMain: true) { nodes { name } }
    }
  }
}`;

async function fetchBatch(ids) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    let res;
    try {
      res = await fetch(ANILIST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query: QUERY, variables: { ids } })
      });
    } catch (err) {
      console.log(`  network error (${err.message}) - retry ${attempt}`);
      await sleep(2000 * attempt);
      continue;
    }
    if (res.status === 429) {
      // Honour the window AniList asks for rather than retrying into it. Retrying
      // early is what produced 554 failures out of 600 on the artwork build.
      const retryAfter = Number(res.headers.get("retry-after") || 0);
      const waitMs = (retryAfter > 0 ? retryAfter : 60) * 1000;
      console.log(`  429 - pausing ${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) {
      console.log(`  http ${res.status} - retry ${attempt}`);
      await sleep(2000 * attempt);
      continue;
    }
    const json = await res.json();
    if (json.errors) {
      console.log(`  graphql: ${JSON.stringify(json.errors).slice(0, 160)}`);
      return null;
    }
    return json.data?.Page?.media || [];
  }
  return null;
}

// AniList's own field names are deliberately NOT reused where they would collide
// with something the entry or the catalogue row already means:
//   entry.status is "ok" | "failed" (did the artwork match succeed)
//   media.status  is FINISHED | RELEASING | ...
// so the airing status is stored as airingStatus and mapped on the way out.
function toMeta(m) {
  const year = m.seasonYear || m.startDate?.year || null;
  return {
    year: year || null,
    score: typeof m.averageScore === "number" ? m.averageScore : null,
    genres: Array.isArray(m.genres) ? m.genres : [],
    description: m.description || "",
    duration: typeof m.duration === "number" ? m.duration : null,
    episodes: typeof m.episodes === "number" ? m.episodes : null,
    format: m.format || "",
    airingStatus: m.status || "",
    country: m.countryOfOrigin || "",
    studio: m.studios?.nodes?.[0]?.name || "",
    // Only consulted for CN/KR/TW productions, where AniList's romaji is a
    // transliteration of Chinese ("Shiguang Dailiren III") rather than a readable
    // name, and the scraped title is that same transliteration - so there was no
    // English name anywhere in the row for getShowTitle() to prefer.
    englishTitle: m.title?.english || "",
    romajiTitle: m.title?.romaji || ""
  };
}

const raw = JSON.parse(fs.readFileSync(MAP, "utf8"));
const entries = raw.entries || {};
const keys = Object.keys(entries);

// One id can back several slugs (seasons of the same series share a match), so
// resolve each id once and fan the result back out.
const idToKeys = new Map();
for (const key of keys) {
  const e = entries[key];
  if (!e || e.status !== "ok" || !e.anilistId) continue;
  if (e.meta && !FORCE) continue;
  const id = Number(e.anilistId);
  if (!Number.isFinite(id)) continue;
  if (!idToKeys.has(id)) idToKeys.set(id, []);
  idToKeys.get(id).push(key);
}

let ids = [...idToKeys.keys()];
if (LIMIT) ids = ids.slice(0, LIMIT);

console.log(`map has ${keys.length} entries; ${ids.length} unique AniList ids need metadata`);
if (!ids.length) { console.log("nothing to do"); process.exit(0); }

const batches = [];
for (let i = 0; i < ids.length; i += BATCH) batches.push(ids.slice(i, i + BATCH));
console.log(`${batches.length} requests at ${INTERVAL}ms spacing (~${Math.round(batches.length * INTERVAL / 1000)}s)\n`);

let resolved = 0;
let missing = 0;
for (let i = 0; i < batches.length; i++) {
  const batch = batches[i];
  if (i > 0) await sleep(INTERVAL);
  const media = await fetchBatch(batch);
  if (!media) { console.log(`batch ${i + 1}/${batches.length}: FAILED, leaving ${batch.length} ids for a later run`); continue; }
  const seen = new Set();
  for (const m of media) {
    seen.add(m.id);
    const meta = toMeta(m);
    for (const key of idToKeys.get(m.id) || []) {
      entries[key].meta = meta;
      resolved++;
    }
  }
  // An id AniList no longer serves (merged or removed entries) must not be retried
  // forever - mark it so the next run skips it.
  for (const id of batch) {
    if (seen.has(id)) continue;
    missing++;
    for (const key of idToKeys.get(id) || []) entries[key].meta = null;
  }
  console.log(`batch ${String(i + 1).padStart(2)}/${batches.length}: ${media.length}/${batch.length} ids -> ${resolved} entries so far`);
}

raw.entries = entries;
raw.metadataGeneratedAt = new Date().toISOString();
fs.writeFileSync(MAP, JSON.stringify(raw, null, 2));

const withMeta = keys.filter((k) => entries[k]?.meta).length;
console.log(`\nwrote ${MAP}`);
console.log(`entries with metadata: ${withMeta}/${keys.length}`);
console.log(`ids AniList did not return: ${missing}`);
