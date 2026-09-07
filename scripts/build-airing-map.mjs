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
let ARTWORK_MAP = path.join(root, "scraper", "artwork-map.json");
let OUT = path.join(root, "scraper", "airing-map.json");
// Typed relation edges, learned one night at a time. Jikan cannot be crawled in
// a single run from a GitHub runner: run #114 spent its whole 28-minute budget
// to resolve 99 of 599 rows, because most ids answer 504 and burn three retries
// each. Throwing that away every night means the map never fills in. Keeping it
// means each run only pays for ids it has never seen, and the graph converges.
let RELATIONS_CACHE = path.join(root, "scraper", "relations-cache.json");
const ANILIST = "https://graphql.anilist.co";

const args = process.argv.slice(2);
const argOf = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const WRITE = args.includes("--write");
const LIMIT = Number(argOf("--limit", "0")) || 0;
const FIXTURE = argOf("--fixture", "");
// Lets the tests exercise the real shaping without touching the committed map.
const OUT_OVERRIDE = argOf("--out", "");
if (OUT_OVERRIDE) OUT = path.resolve(OUT_OVERRIDE);
// The Jikan fallback below reaches two networks. Both can be replaced by a file
// so the whole path is testable without touching either provider.
const OFFLINE_FIXTURE = argOf("--offline-fixture", "");
const JIKAN_FIXTURE = argOf("--jikan-fixture", "");
const ARTWORK_OVERRIDE = argOf("--artwork", "");
const RELATIONS_OVERRIDE = argOf("--relations-cache", "");
// A run driven entirely by fixtures must not touch the network - otherwise the
// test suite depends on AniList being reachable, which is the very thing that
// is broken.
const SKIP_ANILIST = Boolean(JIKAN_FIXTURE);
if (ARTWORK_OVERRIDE) ARTWORK_MAP = path.resolve(ARTWORK_OVERRIDE);
if (RELATIONS_OVERRIDE) RELATIONS_CACHE = path.resolve(RELATIONS_OVERRIDE);

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
// A SEQUEL edge is not enough on its own. MAL chains recaps and specials into
// the sequel spine, so the first real chains this produced offered "Boku no
// Hero Academia: Memories" (a 4-episode special) and "...: More" (1 episode) as
// seasons 3 and 5, and a 1-episode "Wistoria Recap" as season 3. A season is a
// TV or ONA run; everything else is an extra, however it is linked.
const CHAIN_FORMATS = new Set(["TV", "TV_SHORT", "ONA"]);
const isSeasonFormat = (format) => CHAIN_FORMATS.has(String(format || "").toUpperCase());

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
      if (!node || node.type !== "ANIME" || !isSeasonFormat(node.format)) continue;
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

/* ── Fallback source: Jikan relations + the offline database ───────────────
   AniList answers 403 from Vercel, from a browser, from a dev machine AND from
   the GitHub Actions runner (run #111: the bake finished in 3 seconds, where 40
   batched requests at a 1200ms pause cannot finish inside a minute). So the
   primary source is simply gone, and the season chains it was meant to produce
   have to come from somewhere else.

   Jikan labels its relations explicitly - "Prequel" / "Sequel" - which is the
   same semantics AniList gave us, so the chain stays trustworthy. What Jikan
   does NOT cheaply give is the title, episode count and year of every related
   entry; that comes from the manami offline database, one static release asset,
   no rate limit.

   The offline database's own relatedAnime is UNTYPED and must never be used as
   the relation source. Measured over this catalogue, untyped components merge
   78 Gundam series into one "franchise", and attach Ponkotsu Quest to Vinland
   Saga and SKET Dance to Gintama. Typed edges are the whole point. */
const OFFLINE_DB_RELEASE = "https://api.github.com/repos/manami-project/anime-offline-database/releases/latest";
const OFFLINE_DB_ASSET = "anime-offline-database.jsonl";
const JIKAN = "https://api.jikan.moe/v4";
// Jikan publishes 3 requests/second and 60/minute. One per 1.1s sits inside the
// per-minute limit with room to spare; this is a nightly job, not a race.
const JIKAN_PAUSE_MS = 1100;
// 599 catalogue rows sit beside another TV/ONA entry; following the chain
// outward adds the seasons we do not carry. 1400 at ~1.1s is roughly 26 minutes,
// which is a nightly job's business and nobody else's.
const JIKAN_MAX_REQUESTS = 1400;
// Jikan answers 504 ("failed to connect to MyAnimeList") in BURSTS - five ids in
// a row measured 2026-09-07, then a 200 on the same ids minutes later. Run #113
// abandoned the whole crawl after 1m7s because five consecutive failures were
// treated as "the provider is down". They are not; they are weather. Retry each
// id, and only give up when failures are sustained across many DIFFERENT ids.
// Retrying an id three times inside six seconds is not a retry strategy: Jikan's
// 504s cluster in TIME, so all three attempts land in the same bad window.
// Measured 2026-09-07: a local crawl failed 31 ids in a row "3x" each, and two
// of those same ids answered 200 when asked again minutes later.
//
// So do not retry in place. Put the id back at the END of the queue and let the
// rest of the crawl happen first - by the time it comes round again, minutes
// have passed and the window has usually moved. It costs no extra wall time,
// because there is always other work to do.
const MAX_DEFERRALS = 4;
// Write the cache as we go. A 28-minute crawl that is killed on the last minute
// - by the step timeout, by a cancelled run - must not throw away everything it
// learned, because the whole point of the cache is that runs accumulate.
const SAVE_EVERY = 50;
const JIKAN_GIVE_UP_AFTER = 25;
// A wall-clock stop, because retries multiply the worst case past any request
// count. The job's step timeout is 40 minutes; stop well inside it and keep
// whatever was built rather than being killed with nothing.
const JIKAN_DEADLINE_MS = 28 * 60 * 1000;
const SEASONISH = new Set(["TV", "ONA"]);
// Ordering inside a year: AniList sorts by air date and the offline database
// only carries a season name, so map it back to the month the season starts.
const SEASON_MONTH = { WINTER: 1, SPRING: 4, SUMMER: 7, FALL: 10 };

function indexOfflineDatabase(text) {
  const byMal = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    let anilistId = null;
    let malId = null;
    for (const source of row.sources || []) {
      const a = /anilist\.co\/anime\/(\d+)/.exec(source);
      if (a) anilistId = Number(a[1]);
      const m = /myanimelist\.net\/anime\/(\d+)/.exec(source);
      if (m) malId = Number(m[1]);
    }
    if (!malId) continue;
    const related = [];
    for (const link of row.relatedAnime || []) {
      const m = /myanimelist\.net\/anime\/(\d+)/.exec(link);
      if (m) related.push(Number(m[1]));
    }
    byMal.set(malId, {
      malId,
      anilistId,
      title: row.title || "",
      type: String(row.type || "").toUpperCase(),
      episodes: Number(row.episodes) || null,
      year: row.animeSeason?.year || null,
      season: String(row.animeSeason?.season || "").toUpperCase(),
      related
    });
  }
  return byMal;
}

async function loadOfflineIndex() {
  if (OFFLINE_FIXTURE) return indexOfflineDatabase(fs.readFileSync(OFFLINE_FIXTURE, "utf8"));
  const listing = await fetch(OFFLINE_DB_RELEASE, { headers: { Accept: "application/vnd.github+json" } });
  if (!listing.ok) throw new Error(`GitHub releases HTTP ${listing.status}`);
  const release = await listing.json();
  const asset = (release.assets || []).find((a) => a.name === OFFLINE_DB_ASSET);
  if (!asset) throw new Error(`release ${release.tag_name} has no ${OFFLINE_DB_ASSET}`);
  log(`offline database ${release.tag_name} (${Math.round((asset.size || 0) / 1048576)}MB)`);
  const download = await fetch(asset.browser_download_url);
  if (!download.ok) throw new Error(`offline database HTTP ${download.status}`);
  return indexOfflineDatabase(await download.text());
}

// Only rows that actually sit beside another TV/ONA entry can have a chain, and
// asking Jikan about the rest is a request spent to learn nothing. Over this
// catalogue that is 599 of 1071 rows - roughly eleven minutes instead of twenty.
function couldHaveSeasons(db, malId) {
  const entry = db.get(malId);
  if (!entry || !SEASONISH.has(entry.type)) return false;
  return entry.related.some((id) => SEASONISH.has(db.get(id)?.type || ""));
}

async function jikanRelations(malId) {
  // /relations is the obvious endpoint and it answers 504 ("failed to connect to
  // MyAnimeList") while /full - which carries the same typed relations - answers
  // 200. Measured 2026-09-07 across all five Mushoku ids: /relations 504 on every
  // one, /full 200 with Prequel:55888 on the first.
  const response = await fetch(`${JIKAN}/anime/${malId}/full`, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Jikan HTTP ${response.status}`);
  const payload = await response.json();
  return parseRelationBlocks(payload.data?.relations);
}

function parseRelationBlocks(blocks) {
  const edges = [];
  for (const block of blocks || []) {
    const relation = String(block.relation || "").toUpperCase();
    // PREQUEL/SEQUEL only. Side stories, spin-offs, summaries, alternative
    // versions and "other" are a different work; numbering them as seasons is
    // the entire hazard this source exists to avoid.
    if (relation !== "PREQUEL" && relation !== "SEQUEL") continue;
    for (const entry of block.entry || []) {
      if (String(entry.type || "").toLowerCase() !== "anime") continue;
      if (entry.mal_id) edges.push({ relationType: relation, malId: Number(entry.mal_id) });
    }
  }
  return edges;
}

// Shape a database row into the same object the AniList query returns, so the
// component walk and entryFor below cannot tell the two sources apart.
function nodeFromDatabase(db, malId) {
  const entry = db.get(malId);
  if (!entry) return null;
  const month = SEASON_MONTH[entry.season] || 1;
  return {
    id: entry.anilistId || `mal-${malId}`,
    type: "ANIME",
    format: entry.type || "",
    status: "",
    episodes: entry.episodes,
    season: entry.season || "",
    seasonYear: entry.year,
    startDate: entry.year ? { year: entry.year, month, day: 1 } : null,
    title: { romaji: entry.title, userPreferred: entry.title }
  };
}

function loadRelationsCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(RELATIONS_CACHE, "utf8"));
    const edges = new Map();
    for (const [malId, entry] of Object.entries(raw?.edges || {})) {
      if (Array.isArray(entry)) edges.set(Number(malId), entry);
    }
    return edges;
  } catch {
    return new Map();
  }
}

// The cache never shrinks. A run observed it drop from 124 ids to 91 - the cause
// was not pinned down, and it does not need to be: this file is the only thing
// that makes the crawl converge, so losing entries defeats its whole purpose.
// Merging with whatever is on disk makes any writer, racing or buggy, additive.
function saveRelationsCache(edges, quiet = false) {
  if (!WRITE) return;
  const merged = new Map();
  try {
    const previous = JSON.parse(fs.readFileSync(RELATIONS_CACHE, "utf8"));
    for (const [malId, list] of Object.entries(previous?.edges || {})) {
      if (Array.isArray(list)) merged.set(Number(malId), list);
    }
  } catch { /* first write */ }
  const had = merged.size;
  for (const [malId, list] of edges.entries()) merged.set(malId, list);
  if (merged.size < had) { log("refusing to shrink the relation cache"); return; }

  const out = { generatedAt: new Date().toISOString(), count: merged.size, edges: {} };
  for (const [malId, list] of [...merged.entries()].sort((a, b) => a[0] - b[0])) out.edges[malId] = list;
  try {
    fs.mkdirSync(path.dirname(RELATIONS_CACHE), { recursive: true });
    fs.writeFileSync(RELATIONS_CACHE, JSON.stringify(out, null, 2), "utf8");
    if (!quiet) log(`relation cache: ${out.count} id(s) known`);
  } catch (error) {
    log(`could not write the relation cache: ${error.message}`);
  }
}

async function relationsOnce(malId, fixture) {
  if (fixture) {
    // A key that is ABSENT models an id Jikan could not answer for - a 504, which
    // is the common case. An explicitly empty array models a real answer with no
    // relations. The difference matters: the first must never be cached as fact.
    return Object.prototype.hasOwnProperty.call(fixture, String(malId))
      ? parseRelationBlocks(fixture[String(malId)])
      : null;
  }
  try {
    return await jikanRelations(malId);
  } catch {
    return null;
  }
}

async function fetchViaJikan(targets) {
  const db = await loadOfflineIndex();
  log(`offline database indexed: ${db.size} entries`);

  const fixture = JIKAN_FIXTURE ? JSON.parse(fs.readFileSync(JIKAN_FIXTURE, "utf8")) : null;
  const withMal = targets.filter((t) => t.malId);
  const candidates = withMal.filter((t) => couldHaveSeasons(db, t.malId));
  // Seed with our own rows, then follow the chain OUTWARD. Asking only about
  // rows we carry closes the component over fetched nodes and leaves everything
  // else a leaf: Mushoku Tensei season 1 is reachable only through Part 2, which
  // is not in our catalogue, so seeding alone produced a chain that began at
  // Part 2 and silently dropped season 1 - the exact season being asked for.
  // A season we do NOT carry is precisely the one the viewer is missing, so its
  // own edges have to be read too.
  const seeds = (LIMIT ? candidates.slice(0, LIMIT) : candidates).map((t) => t.malId);
  const queue = [...seeds];
  const queued = new Set(seeds);
  log(`${withMal.length} rows with a MAL id, ${candidates.length} sit beside another TV/ONA entry`);

  // The cache is real even under a fixture: only the NETWORK is stubbed, so a
  // test can prove that what one run learns the next run reuses.
  const cache = loadRelationsCache();
  const cachedAtStart = cache.size;
  const media = [];
  const deferrals = new Map();
  const startedAt = Date.now();
  let requests = 0;
  let failures = 0;
  let missed = 0;
  let reused = 0;
  let resolvedThisRun = 0;
  let stoppedBy = "";
  while (queue.length) {
    const malId = queue.shift();
    let edges = cache.get(malId);
    if (edges) {
      // Learned on an earlier night. Free, so it never touches either budget -
      // which is what lets the component keep expanding after the network work
      // has stopped.
      reused += 1;
    } else {
      if (requests >= JIKAN_MAX_REQUESTS) { stoppedBy = "request budget"; break; }
      if (!fixture && Date.now() - startedAt > JIKAN_DEADLINE_MS) { stoppedBy = "time budget"; break; }
      requests += 1;
      edges = await relationsOnce(malId, fixture);
      if (edges === null) {
        failures += 1;
        const soFar = deferrals.get(malId) || 0;
        if (soFar < MAX_DEFERRALS) {
          deferrals.set(malId, soFar + 1);
          queue.push(malId);            // try again once the rest has been walked
        } else {
          missed += 1;
        }
        // Only a provider that has answered NOTHING is a provider that is down.
        // A long failure streak at the TAIL is just the deferred ids coming round
        // with nothing left between them - and treating that as an outage ended a
        // run after 581 requests with 20 of its 28 minutes unused, leaving the
        // Mushoku chain cached at both ends and broken in the middle.
        if (failures >= JIKAN_GIVE_UP_AFTER && resolvedThisRun === 0) {
          stoppedBy = "the provider answered nothing at all";
          break;
        }
        if (!fixture) await sleep(JIKAN_PAUSE_MS);
        continue;
      }
      failures = 0;
      resolvedThisRun += 1;
      cache.set(malId, edges);
      if (cache.size - cachedAtStart >= SAVE_EVERY && (cache.size - cachedAtStart) % SAVE_EVERY === 0) saveRelationsCache(cache, true);
    }
    const self = nodeFromDatabase(db, malId);
    if (self) {
      media.push({
        ...self,
        relations: {
          edges: edges
            .map((edge) => { const node = nodeFromDatabase(db, edge.malId); return node ? { relationType: edge.relationType, node } : null; })
            .filter(Boolean)
        }
      });
    }
    for (const edge of edges) {
      if (queued.has(edge.malId)) continue;
      if (!SEASONISH.has(db.get(edge.malId)?.type || "")) continue;
      queued.add(edge.malId);
      queue.push(edge.malId);
    }
    if (!fixture && queue.length) await sleep(JIKAN_PAUSE_MS);
  }
  // The budgets stop NETWORK work, not the walk. Anything still queued that we
  // already know is free to expand, so drain it - otherwise a chain sits half
  // built purely because the clock ran out on an unrelated id.
  const drained = new Set();
  while (queue.length) {
    const malId = queue.shift();
    if (drained.has(malId)) continue;
    drained.add(malId);
    const edges = cache.get(malId);
    if (!edges) continue;
    reused += 1;
    const self = nodeFromDatabase(db, malId);
    if (self) {
      media.push({
        ...self,
        relations: {
          edges: edges
            .map((edge) => { const node = nodeFromDatabase(db, edge.malId); return node ? { relationType: edge.relationType, node } : null; })
            .filter(Boolean)
        }
      });
    }
    for (const edge of edges) {
      if (queued.has(edge.malId)) continue;
      if (!SEASONISH.has(db.get(edge.malId)?.type || "")) continue;
      queued.add(edge.malId);
      queue.push(edge.malId);
    }
  }

  saveRelationsCache(cache);
  // Never let a cap look like completeness.
  if (stoppedBy) log(`stopped by ${stoppedBy}`);
  if (missed) log(`${missed} id(s) could not be read even after retries`);
  log(`Jikan: ${requests} new request(s), ${reused} reused from cache (${cachedAtStart} known before this run), ${media.length} media shaped`);
  return media;
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
  // Same pathspec hazard as the map itself: the commit step lists this file by
  // name, and `git add` exits 128 on a pathspec that matches nothing.
  try { fs.readFileSync(RELATIONS_CACHE, "utf8"); } catch {
    try {
      fs.mkdirSync(path.dirname(RELATIONS_CACHE), { recursive: true });
      fs.writeFileSync(RELATIONS_CACHE, JSON.stringify({ generatedAt: new Date().toISOString(), count: 0, edges: {} }, null, 2), "utf8");
    } catch { /* reported below if the map write also fails */ }
  }
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
    // malId is carried for the Jikan fallback - artwork-map already resolves it
    // for 1079 of 1085 rows, so no second identity pass is needed.
    if (anilistId > 0) targets.push({ rowId, anilistId, malId: Number(entry?.malId || 0) || null });
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
    for (let i = 0; SKIP_ANILIST ? false : i < wanted.length; i += BATCH) {
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

  if (!fetched.length && !FIXTURE) {
    log("AniList resolved nothing - falling back to Jikan relations + the offline database");
    try {
      fetched.push(...await fetchViaJikan(targets));
    } catch (error) {
      log(`fallback unavailable: ${error.message} - leaving the map alone`);
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
