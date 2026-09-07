// Bake airing schedules and season chains into the catalogue at BUILD time.
//
// Why this exists: graphql.anilist.co answers HTTP 403 to both the browser and
// the Vercel functions, so every feature that needs live AniList data degrades.
// /api/catalog ships no airing instant at all, which is why the Weekly Schedule
// renders seven empty columns; and show.anilistFranchise is never populated,
// which is why a show with three seasons offers only the parts of the one you
// opened. Neither is a rendering bug - the data simply is not there.
//
// GitHub Actions is a different network from Vercel, so the daily scrape job can
// fetch what the runtime cannot and commit the answer alongside the catalogue,
// exactly as scripts/build-artwork-map.mjs already does for artwork. Identity is
// free here: artwork-map.json has already resolved an anilistId per row.
//
//   node scripts/build-airing-map.mjs [--write] [--limit N] [--fixture file]
//
// Without --write it reports what it would do and changes nothing. A run that
// cannot reach AniList leaves the existing map untouched and exits 0: a stale
// schedule is worth far more than an empty one, and this must never be able to
// fail the nightly catalogue job.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const ARTWORK_MAP = path.join(root, "scraper", "artwork-map.json");
let OUT = path.join(root, "scraper", "airing-map.json");
const ANILIST = "https://graphql.anilist.co";

const args = process.argv.slice(2);
const argOf = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const WRITE = args.includes("--write");
const LIMIT = Number(argOf("--limit", "0")) || 0;
const FIXTURE = argOf("--fixture", "");
// Lets the tests exercise the real shaping without touching the committed map.
const OUT_OVERRIDE = argOf("--out", "");
if (OUT_OVERRIDE) OUT = path.resolve(OUT_OVERRIDE);

// AniList allows 90 requests/minute. 25 ids per request keeps a 1000-row
// catalogue inside ~40 requests, and the pause keeps a comfortable margin.
const BATCH = 25;
const PAUSE_MS = 1200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const log = (...a) => console.log(" ", ...a);

/* ── The query ─────────────────────────────────────────────────────────────
   One request answers many ids through aliases. relations gives the season
   chain: SEQUEL/PREQUEL walk the spine, and the node carries enough to order
   and label the entries without a second lookup. */
const mediaFields = `
  id
  title { romaji english userPreferred }
  format status episodes season seasonYear
  startDate { year month day }
  nextAiringEpisode { airingAt episode }
  relations {
    edges {
      relationType
      node {
        id type format status episodes season seasonYear
        title { romaji english userPreferred }
        startDate { year month day }
      }
    }
  }`;

const buildQuery = (ids) => `query {
${ids.map((id, i) => `  m${i}: Media(id: ${id}, type: ANIME) {${mediaFields}\n  }`).join("\n")}
}`;

async function fetchBatch(ids) {
  const response = await fetch(ANILIST, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query: buildQuery(ids) })
  });
  if (!response.ok) throw new Error(`AniList HTTP ${response.status}`);
  const payload = await response.json();
  // A partial GraphQL result still carries the media it did resolve, so errors
  // are noted rather than thrown - one bad id must not lose the other 24.
  if (payload.errors?.length) log(`note: ${payload.errors.length} GraphQL error(s) in this batch`);
  return payload.data || {};
}

/* ── Shaping ───────────────────────────────────────────────────────────────
   Only what a surface actually renders is kept. The file is committed and
   shipped, so every field has to earn its bytes. */
const titleOf = (t) => (t && (t.userPreferred || t.romaji || t.english)) || "";
const startMs = (d) => (d && d.year ? Date.UTC(d.year, Math.max(0, (d.month || 1) - 1), d.day || 1) : 0);

// SEQUEL/PREQUEL edges form a LINKED LIST, not a star: Mushoku Tensei S3 links
// only to S2 Part 2, which links to S2, which links to S1. Reading one media's
// own edges therefore yields its NEIGHBOURS, never the franchise - open S3 and
// you would be offered S3 and S2 and told that is the whole show. Season 1 is
// unreachable in one hop, which is exactly the season the viewer wanted.
//
// So walk the CONNECTED COMPONENT instead. Every catalogue row is fetched with
// its edges, so the union of those edges already describes the whole spine; a
// component walk turns it into one ordered chain that every member shares. The
// chain is identical no matter which season was opened, and members we never
// fetched (S1 is not in our catalogue and not on our source) still appear,
// because a fetched neighbour named them.
const isSeasonEdge = (type) => type === "SEQUEL" || type === "PREQUEL";

function nodeToEntry(node) {
  return {
    anilistId: node.id,
    title: titleOf(node.title),
    format: node.format || "",
    status: node.status || "",
    episodes: node.episodes || null,
    season: node.season || "",
    seasonYear: node.seasonYear || null,
    // A relation stub sometimes carries only the year. Falling back to it keeps
    // an unfetched season in its right place; without this it sorts to the end
    // and season 1 is offered as the last tab.
    startedAt: startMs(node.startDate) || (node.seasonYear ? Date.UTC(node.seasonYear, 0, 1) : 0)
  };
}

// Adjacency over every media we hold plus every node they name.
function buildChains(allMedia) {
  const nodes = new Map();   // anilistId -> entry (best known version)
  const adjacency = new Map();

  const remember = (node) => {
    if (!node || !node.id) return null;
    const entry = nodeToEntry(node);
    const previous = nodes.get(node.id);
    // A fully fetched media beats a relation stub, which carries no episode
    // count and often no date - preferring it keeps ordering and labels right.
    if (!previous || (!previous.startedAt && entry.startedAt) || (!previous.episodes && entry.episodes)) {
      nodes.set(node.id, previous ? { ...previous, ...entry } : entry);
    }
    if (!adjacency.has(node.id)) adjacency.set(node.id, new Set());
    return node.id;
  };

  for (const media of allMedia) {
    const from = remember(media);
    if (from == null) continue;
    for (const edge of media.relations?.edges || []) {
      // SIDE_STORY and SPIN_OFF are a different work. Following them is how a
      // spin-off ends up numbered as season 4.
      if (!edge || !isSeasonEdge(edge.relationType)) continue;
      const node = edge.node;
      if (!node || node.type !== "ANIME" || node.format === "MUSIC") continue;
      const to = remember(node);
      if (to == null || to === from) continue;
      adjacency.get(from).add(to);
      adjacency.get(to).add(from);
    }
  }

  // Breadth-first over each component, then order by release date.
  const chainFor = new Map();
  const seen = new Set();
  for (const startId of nodes.keys()) {
    if (seen.has(startId)) continue;
    const component = [];
    const queue = [startId];
    seen.add(startId);
    while (queue.length) {
      const id = queue.shift();
      component.push(id);
      for (const next of adjacency.get(id) || []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    // Release order is the only ordering that survives inconsistent numbering
    // ("II", "2nd Season", "Final Season Part 2"). An undated entry sorts last
    // rather than pretending to be the first season.
    const ordered = component
      .map((id) => nodes.get(id))
      .sort((a, b) => (a.startedAt || Infinity) - (b.startedAt || Infinity))
      .map((entry, index) => ({ ...entry, order: index + 1 }));
    for (const id of component) chainFor.set(id, ordered);
  }
  return chainFor;
}

function entryFor(media, chain = []) {
  const airingAt = Number(media.nextAiringEpisode?.airingAt || 0);
  return {
    anilistId: media.id,
    airingStatus: media.status || "",
    season: media.season || "",
    seasonYear: media.seasonYear || null,
    anilistEpisodeCount: media.episodes || null,
    // Milliseconds, matching js/normalize.js - AniList sends seconds.
    nextAiringAt: airingAt ? airingAt * 1000 : null,
    nextAiringEpisodeNumber: media.nextAiringEpisode?.episode || null,
    // Only worth shipping when it actually describes more than this one entry.
    franchiseSeasons: chain.length > 1 ? chain : []
  };
}

// The nightly job commits this path BY NAME. `git add` exits 128 on a pathspec
// that matches nothing, so the first time AniList was unreachable the missing
// file took down the entire commit step - discarding that run's anime_metadata
// .json too, which is the catalogue itself. An empty map is a valid, supported
// state (every surface behaves exactly as it did before it existed), so the file
// must exist even when we resolved nothing. It is never used to overwrite a
// populated map: this only ever creates one that is absent.
function ensureMapExists() {
  if (!WRITE) return;
  try { fs.readFileSync(OUT, "utf8"); return; } catch { /* absent - create it */ }
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), count: 0, entries: {} }, null, 2), "utf8");
    log(`wrote an empty ${path.relative(root, OUT)} so the commit step has a file to add`);
  } catch (error) {
    log(`could not create ${OUT}: ${error.message}`);
  }
}

/* ── Main ──────────────────────────────────────────────────────────────────── */
async function main() {
  let artwork;
  try {
    artwork = JSON.parse(fs.readFileSync(ARTWORK_MAP, "utf8"));
  } catch (error) {
    log(`cannot read artwork-map.json (${error.message}) - nothing to key on, leaving the map alone`);
    ensureMapExists();
    return 0;
  }
  const entries = artwork?.entries || {};

  // rowId -> anilistId, for every row whose identity is already resolved.
  const targets = [];
  for (const [rowId, entry] of Object.entries(entries)) {
    const anilistId = Number(entry?.anilistId || 0);
    if (anilistId > 0) targets.push({ rowId, anilistId });
  }
  const ids = [...new Set(targets.map((t) => t.anilistId))];
  const wanted = LIMIT ? ids.slice(0, LIMIT) : ids;
  log(`${Object.keys(entries).length} catalogue rows, ${targets.length} with an AniList id, ${wanted.length} to fetch`);

  const byAnilistId = new Map();
  // Every media we manage to fetch, kept whole - the chains are computed from
  // the union of their edges once the whole set is in hand, not per-media.
  const fetched = [];

  if (FIXTURE) {
    // Offline path, so the shaping can be exercised without the network.
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
    for (const media of (Array.isArray(fixture) ? fixture : [fixture])) if (media && media.id) fetched.push(media);
    log(`fixture: loaded ${fetched.length} media`);
  } else {
    let failures = 0;
    for (let i = 0; i < wanted.length; i += BATCH) {
      const slice = wanted.slice(i, i + BATCH);
      try {
        const data = await fetchBatch(slice);
        for (const media of Object.values(data)) {
          if (media && media.id) fetched.push(media);
        }
      } catch (error) {
        failures += 1;
        log(`batch ${i / BATCH + 1} failed: ${error.message}`);
        // AniList blocked outright (403) or down: stop rather than grind through
        // forty identical failures, and leave whatever is on disk in place.
        if (failures >= 3) { log("three consecutive failures - abandoning this run"); break; }
      }
      if (i + BATCH < wanted.length) await sleep(PAUSE_MS);
    }
  }

  const chains = buildChains(fetched);
  for (const media of fetched) byAnilistId.set(media.id, entryFor(media, chains.get(media.id) || []));

  if (!byAnilistId.size) {
    log("resolved nothing - the existing map is left exactly as it is (this is not a build failure)");
    ensureMapExists();
    return 0;
  }

  const out = { generatedAt: new Date().toISOString(), count: 0, entries: {} };
  for (const { rowId, anilistId } of targets) {
    const shaped = byAnilistId.get(anilistId);
    if (shaped) { out.entries[rowId] = shaped; out.count += 1; }
  }

  const withAiring = Object.values(out.entries).filter((e) => e.nextAiringAt).length;
  const withChain = Object.values(out.entries).filter((e) => e.franchiseSeasons.length).length;
  log(`shaped ${out.count} rows - ${withAiring} with a next-airing instant, ${withChain} with a season chain`);

  if (!WRITE) { log("dry run - pass --write to commit the file"); return 0; }

  // Never replace a populated map with a thinner one: a partial run (rate limit,
  // a dropped batch) must not delete yesterday's good answers.
  try {
    const previous = JSON.parse(fs.readFileSync(OUT, "utf8"));
    const had = Number(previous?.count || 0);
    if (had > out.count * 1.5) {
      log(`refusing to shrink the map from ${had} to ${out.count} rows - keeping the existing file`);
      return 0;
    }
  } catch { /* no previous map: writing the first one is correct */ }

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), "utf8");
  log(`wrote ${path.relative(root, OUT)}`);
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  // Even an unexpected failure must not break the nightly catalogue job.
  log(`unexpected failure: ${error.message} - leaving the map alone`);
  process.exit(0);
});
