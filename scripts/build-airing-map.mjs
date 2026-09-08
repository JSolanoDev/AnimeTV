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
// Rebuild the map from the cache alone, touching no provider. Useful when the
// crawl has nothing left to add, or - as happened here - when Jikan is
// throttling us and continuing to ask would be both useless and rude.
const NO_FETCH = args.includes("--no-fetch");
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
const SAVE_EVERY = 25;
// Ordered by MAL id, so this must tolerate a long opening run of failures.
// Run 1 of 4 gave up after 25 - Jikan was measurably healthy at the time
// (4/5 by hand), but the first ids in catalogue order are all recent ones that
// 504, so the guard fired before the crawl ever reached an id that answers.
const JIKAN_GIVE_UP_AFTER = 80;
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
      airing: String(row.status || "").toUpperCase(),
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
  // The same response carries the broadcast slot, which is the ONLY airing data
  // we can still get: AniList's nextAiringEpisode is gone with AniList, and the
  // Weekly Schedule rendered seven empty columns without it. Free to keep here.
  rememberBroadcast(malId, payload.data);
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

// Jikan can spend an entire run returning 504 for the older links behind a
// newly published sequel. The offline database's relation list is untyped, so
// it is not safe as a general graph. It is safe for one narrow recovery case:
// both nodes are TV/ONA entries and their titles become exactly equal after
// removing only explicit season/part markers. This closes chains such as
// "Honzuki", "Honzuki 2nd Season", and "Honzuki 3rd Season" without turning
// similarly named films, specials, recaps, or spin-offs into seasons.
function strictOfflineSeasonBase(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’'`]/g, "")
    .replace(/\b(?:season|temporada)\s*\d+\b/g, " ")
    .replace(/\b\d+(?:st|nd|rd|th)\s+season\b/g, " ")
    .replace(/\b(?:part|cour)\s*\d+\b/g, " ")
    // Chinese ONA sequels frequently use a bare Roman numeral rather than the
    // word "Season". Keep this suffix rule narrow and anchored so unrelated
    // words are untouched: Shiguang Dailiren / II / III become one strict
    // family, while the named Bridon/Yingdu arc remains a separate extra.
    .replace(/\s+(?:i{1,3}|iv|vi{0,3}|ix|x)\s*$/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function strictOfflineFranchiseStem(value = "") {
  // Preserve the shared work name while dropping a named arc suffix such as
  // " - Ketsubetsu-tan". Colons remain part of the stem because they commonly
  // separate the franchise name from its overall series subtitle.
  return strictOfflineSeasonBase(String(value || "").split(/\s+[\-–—]\s+/)[0]);
}

function isStrictOfflineSeasonSibling(left, right, seasonHintsByMal = new Map()) {
  if (!left || !right || !SEASONISH.has(left.type) || !SEASONISH.has(right.type)) return false;
  const leftBase = strictOfflineSeasonBase(left.title);
  const rightBase = strictOfflineSeasonBase(right.title);
  if (leftBase.length >= 12 && leftBase === rightBase) return true;

  // Named arcs do not contain a numeric season marker. Recover only the narrow
  // case where the exact catalogue identity already established adjacent
  // canonical seasons and the offline database says the two TV/ONA rows are
  // related. This joins Bleach TYBW's named cours without admitting recaps,
  // specials, or a merely similar spin-off into the mainline chain.
  const leftSeason = Number(seasonHintsByMal.get(Number(left.malId)) || 0);
  const rightSeason = Number(seasonHintsByMal.get(Number(right.malId)) || 0);
  if (!leftSeason || !rightSeason || Math.abs(leftSeason - rightSeason) !== 1) return false;
  const leftStem = strictOfflineFranchiseStem(left.title);
  const rightStem = strictOfflineFranchiseStem(right.title);
  return leftStem.length >= 12 && leftStem === rightStem;
}

function buildStrictOfflineSeasonMedia(db, seedMalIds, typedCache, seasonHintsByMal = new Map()) {
  const queue = [...new Set(seedMalIds.map(Number).filter((id) => id > 0))];
  const queued = new Set(queue);
  const media = [];

  while (queue.length) {
    const malId = queue.shift();
    const current = db.get(malId);
    if (!current || !SEASONISH.has(current.type)) continue;

    const typed = (typedCache.get(malId) || []).filter((edge) =>
      edge?.malId && SEASONISH.has(db.get(Number(edge.malId))?.type || "")
    );
    const inferred = (current.related || [])
      .map(Number)
      .filter((relatedId) => relatedId > 0 && isStrictOfflineSeasonSibling(current, db.get(relatedId), seasonHintsByMal))
      .map((relatedId) => ({ relationType: "SEQUEL", malId: relatedId }));
    const edges = [...typed, ...inferred].filter((edge, index, list) =>
      list.findIndex((candidate) => Number(candidate.malId) === Number(edge.malId)) === index
    );
    if (!edges.length) continue;

    const self = nodeFromDatabase(db, malId);
    if (self) {
      media.push({
        ...self,
        relations: {
          edges: edges
            .map((edge) => {
              const node = nodeFromDatabase(db, edge.malId);
              return node ? { relationType: edge.relationType, node } : null;
            })
            .filter(Boolean)
        }
      });
    }

    for (const edge of edges) {
      const relatedId = Number(edge.malId);
      if (queued.has(relatedId)) continue;
      queued.add(relatedId);
      queue.push(relatedId);
    }
  }
  return media;
}

// malId -> { day, time, timezone } for shows that are actually airing. A day
// and a time never go stale the way a computed instant does, so the client works
// out the next occurrence itself.
const broadcastByMal = new Map();

function rememberBroadcast(malId, data) {
  const broadcast = data?.broadcast;
  if (!broadcast?.day || !broadcast?.time) return;
  // Only for shows currently airing - a finished show's old slot would put it
  // back on the schedule every week forever.
  if (data.airing !== true && String(data.status || "") !== "Currently Airing") return;
  broadcastByMal.set(Number(malId), {
    day: String(broadcast.day),
    time: String(broadcast.time),
    timezone: String(broadcast.timezone || "Asia/Tokyo")
  });
}

function loadRelationsCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(RELATIONS_CACHE, "utf8"));
    const edges = new Map();
    for (const [malId, entry] of Object.entries(raw?.edges || {})) {
      if (Array.isArray(entry)) edges.set(Number(malId), entry);
    }
    // Broadcast slots persist with the edges: a run that could not reach an id
    // today still knows when it airs from the night it could.
    for (const [malId, slot] of Object.entries(raw?.broadcast || {})) {
      if (slot?.day && slot?.time && !broadcastByMal.has(Number(malId))) {
        broadcastByMal.set(Number(malId), slot);
      }
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

  const out = { generatedAt: new Date().toISOString(), count: merged.size, edges: {}, broadcast: {} };
  for (const [malId, list] of [...merged.entries()].sort((a, b) => a[0] - b[0])) out.edges[malId] = list;
  for (const [malId, slot] of [...broadcastByMal.entries()].sort((a, b) => a[0] - b[0])) out.broadcast[malId] = slot;
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

async function fetchViaJikan(targets, seasonHintsByMal = new Map()) {
  const db = offlineIndexRef.value || await loadOfflineIndex();
  offlineIndexRef.value = db;
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
  // Oldest MAL ids first. Jikan serves long-established entries reliably and
  // 504s on recent ones, so this front-loads the requests that succeed instead
  // of opening with a wall of failures that looks like an outage.
  const ordered = (LIMIT ? candidates.slice(0, LIMIT) : candidates)
    .slice()
    .sort((a, b) => a.malId - b.malId);
  const seeds = ordered.map((t) => t.malId);
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
    let hitNetwork = false;
    if (edges) {
      // Learned on an earlier night. Free, so it never touches either budget -
      // which is what lets the component keep expanding after the network work
      // has stopped.
      reused += 1;
    } else {
      if (NO_FETCH) { stoppedBy = "--no-fetch"; break; }
      if (requests >= JIKAN_MAX_REQUESTS) { stoppedBy = "request budget"; break; }
      if (!fixture && Date.now() - startedAt > JIKAN_DEADLINE_MS) { stoppedBy = "time budget"; break; }
      requests += 1;
      hitNetwork = true;
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
    // Pace only what actually went to the provider. Sleeping between CACHED
    // ids cost 1.1s each for nothing: with 187 of them that was 3.4 minutes of a
    // 28-minute budget spent idling, and it grows every night the cache does.
    if (!fixture && hitNetwork && queue.length) await sleep(JIKAN_PAUSE_MS);
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
  const recovered = buildStrictOfflineSeasonMedia(db, withMal.map((target) => target.malId), cache, seasonHintsByMal);
  if (recovered.length) {
    media.push(...recovered);
    log(`offline strict-title recovery shaped ${recovered.length} season node(s)`);
  }
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

/* ── The source's own weekly schedule ──────────────────────────────────────
   AnimeAV1 is a SvelteKit app, so every page has a serialised data endpoint
   beside it. /horario/__data.json returns the whole airing schedule - 78 shows
   - in ONE request, each with its slug, the number of its latest episode and
   when that episode was published.

   That single call replaces two expensive things at once:

     - the episode-count probe, which binary-searched /media/<slug>/<n> at four
       or five requests per show. Verified against hand measurements: Mushoku
       Tensei III 11, Thunder 3 9, Mebius Dust 9, Hanaori-san 9 - all exact.
     - the Jikan broadcast lookup, which needed one request per show and was
       being throttled. The publish time of the latest episode IS the weekly
       slot, in real UTC, with no timezone guessing at all.

   It is also the right source on principle: this is the provider that actually
   serves the episodes, so it cannot disagree with itself the way a metadata
   provider can. */
const ANIMEAV1_SCHEDULE = "https://animeav1.com/horario/__data.json";

// SvelteKit serialises with devalue: a flat array where every value is either a
// literal or an INDEX into that same array. Resolve indices back into objects.
function resolveDevalue(flat, index, depth = 0) {
  if (depth > 8 || typeof index !== "number") return null;
  const value = flat[index];
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((child) => resolveDevalue(flat, child, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = resolveDevalue(flat, child, depth + 1);
    return out;
  }
  return value;
}

async function fetchAnimeAv1Schedule() {
  const response = await fetch(ANIMEAV1_SCHEDULE, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`AnimeAV1 schedule HTTP ${response.status}`);
  const payload = await response.json();
  const node = (payload.nodes || []).find((entry) => entry && Array.isArray(entry.data) && entry.data.length > 50);
  if (!node) throw new Error("no data node in the schedule payload");
  const root = resolveDevalue(node.data, 0);
  const media = Array.isArray(root?.media) ? root.media : [];
  const bySlug = new Map();
  for (const show of media) {
    const slug = String(show?.slug || "").trim();
    const number = Number(show?.latestEpisode?.number);
    const airedAt = show?.latestEpisode?.createdAt;
    if (!slug || !(number > 0)) continue;
    bySlug.set(slug, {
      episodes: number,
      lastEpisodeAt: airedAt && Number.isFinite(Date.parse(airedAt)) ? new Date(airedAt).toISOString() : null
    });
  }
  return bySlug;
}

async function applyAnimeAv1Schedule(entries, targets) {
  let schedule;
  try {
    schedule = await fetchAnimeAv1Schedule();
  } catch (error) {
    log(`AnimeAV1 schedule unavailable: ${error.message}`);
    return new Set();
  }
  log(`AnimeAV1 schedule: ${schedule.size} airing show(s) in one request`);
  const covered = new Set();
  for (const { rowId } of targets) {
    const slug = /^animeav1-(.+)$/.exec(rowId)?.[1];
    const hit = slug ? schedule.get(slug) : null;
    if (!hit) continue;
    if (!entries[rowId]) {
      entries[rowId] = {
        anilistId: null, airingStatus: "RELEASING", season: "", seasonYear: null,
        anilistEpisodeCount: null, nextAiringAt: null, nextAiringEpisodeNumber: null,
        franchiseSeasons: []
      };
    }
    entries[rowId].sourceEpisodeCount = hit.episodes;
    if (hit.lastEpisodeAt) entries[rowId].lastEpisodeAt = hit.lastEpisodeAt;
    covered.add(rowId);
  }
  log(`${covered.size} row(s) took their episode count and airing slot from the source itself`);
  return covered;
}

/* ── What the SOURCE actually serves ───────────────────────────────────────
   An airing show renders its PLANNED total, because that is all any metadata
   provider knows. The source serves only what has aired. Measured 2026-09-07
   against production: Mushoku Tensei III offered 14 episodes and AnimeAV1 served
   11; Hanaori-san 12 vs 9; Mebius Dust 12 vs 9; Thunder 3 12 vs 9. Every
   currently-airing show carried exactly three rows that cannot play. Finished
   shows were correct.

   AnimeAV1 answers 200 for an episode it serves and 404 for one it does not, so
   a binary search pins the real number in about four requests. Only airing shows
   need it - a finished show's planned total IS its real total - which keeps this
   to roughly 70 shows a night rather than a thousand. */
const offlineIndexRef = { value: null };
const ANIMEAV1_MEDIA = "https://animeav1.com/media";
const AV1_PROBE_PAUSE_MS = 700;
const AV1_PROBE_MAX_SHOWS = 220;
const THIS_YEAR = new Date().getUTCFullYear();
const RECENT_YEARS = new Set([THIS_YEAR, THIS_YEAR - 1]);

// true = serves it, false = definitely does not (404), null = we do not know.
// Collapsing the third case into "does not" is how a transient failure silently
// lowers a show's episode count: measured, this baked 10 for a show AnimeAV1
// serves 12 episodes of, which would have hidden two playable episodes.
async function av1ServesEpisode(slug, episode) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`${ANIMEAV1_MEDIA}/${slug}/${episode}`, { headers: { Accept: "text/html" } });
      if (response.status === 404) return false;
      if (response.ok) return true;
    } catch { /* fall through to the retry, then to "unknown" */ }
    if (attempt === 0) await sleep(AV1_PROBE_PAUSE_MS * 2);
  }
  return null;
}

async function av1EpisodeCount(slug, plannedTotal) {
  // Find a ceiling the source definitely does NOT serve, by doubling. Starting
  // from the planned total and adding a fixed margin is not safe: a ceiling is
  // an assumption, and this one was wrong - a "Mini" series whose metadata said
  // 6 episodes had the search capped at 10 while AnimeAV1 serves 12, so the
  // probe reported 10 and would have hidden two playable episodes.
  let hi = Math.max(1, Number(plannedTotal) || 12);
  for (let doublings = 0; doublings < 7; doublings += 1) {
    const beyond = await av1ServesEpisode(slug, hi + 1);
    if (beyond === null) return 0;
    if (!beyond) break;
    hi = hi * 2;
    await sleep(AV1_PROBE_PAUSE_MS);
  }

  let lo = 1;
  let last = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const serves = await av1ServesEpisode(slug, mid);
    // A count that is too LOW hides episodes that actually play, and silence is
    // not a 404. Abandon this show rather than conclude a lower bound from it -
    // no count at all simply leaves the previous behaviour in place.
    if (serves === null) return 0;
    if (serves) { last = mid; lo = mid + 1; } else { hi = mid - 1; }
    await sleep(AV1_PROBE_PAUSE_MS);
  }
  return last;
}

async function addSourceEpisodeCounts(entries, db, targets = [], alreadyCovered = new Set()) {
  if (!db || !db.size) return 0;
  const byAniList = new Map();
  for (const entry of db.values()) if (entry.anilistId) byAniList.set(String(entry.anilistId), entry);

  // Walk the CATALOGUE, not just the rows that happen to have a season chain.
  // A source episode count has nothing to do with relations, and scoping this to
  // entries meant only 4 of the catalogue's ~70 airing shows were ever probed.
  const airing = [];
  const seen = new Set();
  for (const { rowId, anilistId, malId, identityId } of targets) {
    if (seen.has(rowId)) continue;
    const slug = /^animeav1-(.+)$/.exec(rowId)?.[1];
    if (!slug) continue;
    const known = byAniList.get(String(anilistId)) || (malId ? db.get(Number(malId)) : null);
    if (!known) continue;
    // ONGOING is the offline database's word for "currently airing", but the
    // snapshot is weekly: it named 19 shows where the catalogue considers 71 to
    // be airing. A season that started since the snapshot is exactly the case
    // this probe exists for, so include recent TV runs as well. Finished older
    // shows are skipped - their planned total IS their real one.
    const recent = RECENT_YEARS.has(Number(known.year)) && SEASONISH.has(known.type);
    if (known.airing !== "ONGOING" && !recent) continue;
    // The schedule already answered this one exactly, for free.
    if (alreadyCovered.has(rowId)) continue;
    seen.add(rowId);
    airing.push({ rowId, slug, anilistId, malId, identityId, planned: entries[rowId]?.anilistEpisodeCount || known.episodes });
  }

  const wanted = airing.slice(0, AV1_PROBE_MAX_SHOWS);
  log(`${airing.length} airing row(s); probing ${wanted.length} for what the source actually serves`);
  let probed = 0;
  for (const { rowId, slug, anilistId, malId, identityId, planned } of wanted) {
    const count = await av1EpisodeCount(slug, planned);
    if (count <= 0) continue;
    // A show with no chain still deserves a correct episode count, so give it a
    // row rather than dropping the measurement on the floor.
    if (!entries[rowId]) {
      entries[rowId] = {
        anilistId: Number(anilistId) || identityId || (malId ? `mal-${malId}` : null),
        airingStatus: "RELEASING",
        season: "",
        seasonYear: null,
        anilistEpisodeCount: null,
        nextAiringAt: null,
        nextAiringEpisodeNumber: null,
        franchiseSeasons: []
      };
    }
    entries[rowId].sourceEpisodeCount = count;
    probed += 1;
  }
  if (airing.length > wanted.length) log(`${airing.length - wanted.length} airing row(s) left unprobed by the cap`);
  log(`source episode counts written for ${probed} show(s)`);
  return probed;
}

function mergePreviousAiringObservations(out, targets) {
  let previous;
  try {
    previous = JSON.parse(fs.readFileSync(OUT, "utf8"));
  } catch {
    return 0;
  }

  const targetByRow = new Map(targets.map((target) => [target.rowId, target]));
  const additiveFields = [
    "anilistEpisodeCount", "sourceEpisodeCount", "lastEpisodeAt",
    "nextAiringAt", "nextAiringEpisodeNumber", "broadcastDay",
    "broadcastTime", "broadcastTimezone", "season", "seasonYear",
    "airingStatus"
  ];
  let restored = 0;

  for (const [rowId, older] of Object.entries(previous?.entries || {})) {
    const target = targetByRow.get(rowId);
    if (!target || !older || typeof older !== "object") continue;
    const sameIdentity = !older.anilistId || String(older.anilistId) === String(target.identityId);
    if (!sameIdentity) continue;

    if (!out.entries[rowId]) {
      out.entries[rowId] = older;
      restored += 1;
      continue;
    }

    const current = out.entries[rowId];
    for (const field of additiveFields) {
      if ((current[field] === null || current[field] === undefined || current[field] === "")
          && older[field] !== null && older[field] !== undefined && older[field] !== "") {
        current[field] = older[field];
        restored += 1;
      }
    }
    const currentChain = Array.isArray(current.franchiseSeasons) ? current.franchiseSeasons : [];
    const olderChain = Array.isArray(older.franchiseSeasons) ? older.franchiseSeasons : [];
    if (olderChain.length > currentChain.length) {
      current.franchiseSeasons = olderChain;
      restored += 1;
    }
  }
  out.count = Object.keys(out.entries).length;
  return restored;
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
  const seasonHintsByMal = new Map();
  for (const entry of Object.values(entries)) {
    const malId = Number(entry?.malId || entry?.meta?.malId || 0);
    const seasonNumber = Number(entry?.canonicalSeasonNumber || 0);
    if (malId > 0 && seasonNumber > 0) seasonHintsByMal.set(malId, seasonNumber);
  }

  // rowId -> anilistId, for every row whose identity is already resolved.
  const targets = [];
  for (const [rowId, entry] of Object.entries(entries)) {
    const anilistId = Number(entry?.anilistId || 0);
    const malId = Number(entry?.malId || entry?.meta?.malId || 0) || null;
    // malId is carried for the Jikan fallback - artwork-map already resolves it
    // for 1079 of 1085 rows, so no second identity pass is needed.
    // A newly announced title can exist in MAL before AniList. Those rows used
    // to be dropped here altogether, so they got neither their season chain nor
    // the source episode count even though both were available downstream.
    if (anilistId > 0 || malId) {
      targets.push({
        rowId,
        anilistId: anilistId > 0 ? anilistId : null,
        malId,
        identityId: anilistId > 0 ? String(anilistId) : `mal-${malId}`
      });
    }
  }
  const ids = [...new Set(targets.map((t) => t.anilistId).filter((id) => id > 0))];
  const wanted = LIMIT ? ids.slice(0, LIMIT) : ids;
  log(`${Object.keys(entries).length} catalogue rows, ${targets.length} with a stable AniList/MAL identity, ${wanted.length} AniList ids to fetch`);

  const byAnilistId = new Map();
  // Every media we manage to fetch, kept whole - the chains are computed from
  // the union of their edges once the whole set is in hand, not per-media.
  const fetched = [];
  // Kept so the source-episode probe can reuse it without a second download.

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
      fetched.push(...await fetchViaJikan(targets, seasonHintsByMal));
    } catch (error) {
      log(`fallback unavailable: ${error.message} - leaving the map alone`);
    }
  }

  const chains = buildChains(fetched);
  for (const media of fetched) byAnilistId.set(String(media.id), entryFor(media, chains.get(media.id) || []));

  if (!byAnilistId.size) {
    log("resolved nothing - the existing map is left exactly as it is (this is not a build failure)");
    ensureMapExists();
    return 0;
  }

  const out = { generatedAt: new Date().toISOString(), count: 0, entries: {} };
  for (const { rowId, identityId } of targets) {
    const shaped = byAnilistId.get(identityId);
    if (shaped) { out.entries[rowId] = shaped; out.count += 1; }
  }

  if (!FIXTURE && !JIKAN_FIXTURE) {
    try {
      // One request to the provider that actually serves the episodes. Cheap
      // enough that even --no-fetch runs it: skipping it would mean rebuilding
      // the map without the only authoritative episode counts we have.
      const covered = await applyAnimeAv1Schedule(out.entries, targets);
      // The per-show probe is the expensive fallback for anything the schedule
      // did not answer, so that one stays behind --no-fetch.
      if (!NO_FETCH) {
        const db = offlineIndexRef.value || await loadOfflineIndex();
        offlineIndexRef.value = db;
        await addSourceEpisodeCounts(out.entries, db, targets, covered);
      }
      out.count = Object.keys(out.entries).length;
    } catch (error) {
      log(`source episode probe skipped: ${error.message}`);
    }
  }

  const restoredObservations = (!FIXTURE && !JIKAN_FIXTURE)
    ? mergePreviousAiringObservations(out, targets)
    : 0;
  if (restoredObservations) log(`restored ${restoredObservations} last-known-good airing observation(s)`);

  // Attach the broadcast slot to every row we know one for. This is what puts
  // shows back on the Weekly Schedule: measured before this, 0 of 996 catalogue
  // rows had any airing instant and all 996 carried day "Local", which the
  // schedule excludes, so all seven columns read "No new episodes".
  let withBroadcast = 0;
  for (const { rowId, malId } of targets) {
    const slot = malId ? broadcastByMal.get(Number(malId)) : null;
    if (!slot || !out.entries[rowId]) continue;
    out.entries[rowId].broadcastDay = slot.day;
    out.entries[rowId].broadcastTime = slot.time;
    out.entries[rowId].broadcastTimezone = slot.timezone;
    withBroadcast += 1;
  }
  log(`${withBroadcast} row(s) carry a broadcast slot`);

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
