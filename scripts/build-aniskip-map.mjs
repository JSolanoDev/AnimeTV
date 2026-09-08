// Resolve opening/ending timestamps from AniSkip and bake them into
// scraper/aniskip-map.json, which the server serves and the player consumes as
// generic episode metadata. Nothing here is provider-specific: skip times belong
// to an anime + MAL entry + episode number, so switching streaming source keeps
// the same timestamps.
//
//   node scripts/build-aniskip-map.mjs --catalog <file.json> [--shows N]
//                                      [--max-episodes N] [--max-lookups N]
//                                      [--concurrency N] [--recheck-days N]
//                                      [--only-mal 1,2,3]
//
// Run it against a catalogue JSON (the /api/catalog payload). Results accumulate,
// so a later run only queries what is new or due a recheck.

import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const CATALOG = argOf("--catalog", "");
const OUT_OVERRIDE = argOf("--out", "");
const OUT = OUT_OVERRIDE || path.join(root, "scraper", "aniskip-map.json");
const ANDROID_OUT_OVERRIDE = argOf("--android-out", "");
const ANDROID_OUT = ANDROID_OUT_OVERRIDE || (
  OUT_OVERRIDE ? "" : path.join(root, "android", "app", "src", "main", "assets", "scraper", "aniskip-map.json")
);
const ARTWORK_FILE = argOf("--artwork", path.join(root, "scraper", "artwork-map.json"));
const AIRING_FILE = argOf("--airing", path.join(root, "scraper", "airing-map.json"));
const FIXTURE_FILE = argOf("--fixture", "");
const MAX_SHOWS = Number(argOf("--shows", "0")) || 0;
const MAX_EPISODES = Number(argOf("--max-episodes", "2000")) || 2000;
const MAX_LOOKUPS = Number(argOf("--max-lookups", "0")) || 0;
const CONCURRENCY = Math.max(1, Math.min(6, Number(argOf("--concurrency", "4")) || 4));
// A miss is not permanent - AniSkip is crowd-sourced and episodes gain timestamps
// later, so a negative result is retried once it is this old.
const RECHECK_DAYS = Number(argOf("--recheck-days", "14")) || 14;
const ONLY_MAL = new Set(String(argOf("--only-mal", "")).split(",").map((s) => Number(s.trim())).filter(Boolean));
const DRY_RUN = args.includes("--dry-run");

const API = "https://api.aniskip.com/v2/skip-times";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readEntries = (file) => {
  if (!file || !fs.existsSync(file)) return {};
  try {
    const payload = JSON.parse(fs.readFileSync(file, "utf8"));
    return payload && typeof payload.entries === "object" ? payload.entries : {};
  } catch {
    return {};
  }
};

let fixture = null;
if (FIXTURE_FILE) {
  fixture = JSON.parse(fs.readFileSync(FIXTURE_FILE, "utf8"));
  fixture = fixture && typeof fixture.entries === "object" ? fixture.entries : fixture;
}

// ── persistence ────────────────────────────────────────────────────────────
let store = { generatedAt: "", count: 0, entries: {} };
if (fs.existsSync(OUT)) {
  try { store = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch { /* rebuild from scratch */ }
}
store.entries = store.entries || {};

function writeStore() {
  const body = JSON.stringify(store, null, 2) + "\n";
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, body, "utf8");
  if (ANDROID_OUT) {
    fs.mkdirSync(path.dirname(ANDROID_OUT), { recursive: true });
    fs.writeFileSync(ANDROID_OUT, body, "utf8");
  }
}

const isDue = (record, now) => {
  if (!record) return true;
  if (record.intro || record.outro) return false;          // a hit never expires
  const checked = Date.parse(record.checkedAt || "") || 0; // a miss does
  return now - checked > RECHECK_DAYS * 86400000;
};

// ── validation ─────────────────────────────────────────────────────────────
// Exactly the rule the player enforces, applied before anything is written, so a
// malformed interval can never reach the catalogue.
function toSegment(interval) {
  if (!interval || typeof interval !== "object") return null;
  const start = Number(interval.startTime);
  const end = Number(interval.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end <= start) return null;
  return { start, end };   // decimals preserved deliberately
}

// ── one lookup, with bounded retries ───────────────────────────────────────
let rateLimitedUntil = 0;

async function lookup(malId, episode) {
  if (fixture) {
    const value = fixture[`${malId}:${episode}`];
    if (!value) return { intro: null, outro: null };
    const normalizeFixtureSegment = (segment) => {
      if (!segment) return null;
      return toSegment(segment.interval || {
        startTime: segment.start,
        endTime: segment.end
      });
    };
    return {
      intro: normalizeFixtureSegment(value.intro),
      outro: normalizeFixtureSegment(value.outro)
    };
  }
  const url = `${API}/${malId}/${episode}?types=op&types=ed&episodeLength=0`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const wait = rateLimitedUntil - Date.now();
    if (wait > 0) await sleep(wait);
    let res;
    try {
      res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12000) });
    } catch (error) {
      // Timeout or network blip. Back off, then give up quietly - a missing
      // timestamp is a normal outcome and must never fail the build.
      await sleep(600 * attempt);
      continue;
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") || 0);
      const ms = (retryAfter > 0 ? retryAfter : 30) * 1000;
      rateLimitedUntil = Date.now() + ms;
      console.log(`  429 - pausing ${Math.round(ms / 1000)}s`);
      await sleep(ms);
      continue;
    }
    // 404 means "no skip times for this episode", which is the single most common
    // answer and is not an error.
    if (res.status === 404) return { intro: null, outro: null };
    if (!res.ok) { await sleep(400 * attempt); continue; }
    let body;
    try { body = await res.json(); } catch { return { intro: null, outro: null }; }
    if (!body || body.found !== true || !Array.isArray(body.results)) return { intro: null, outro: null };
    let intro = null;
    let outro = null;
    for (const row of body.results) {
      const seg = toSegment(row?.interval);
      if (!seg) continue;
      const kind = String(row?.skipType || "").toLowerCase();
      if (kind === "op" && !intro) intro = seg;
      if (kind === "ed" && !outro) outro = seg;
    }
    return { intro, outro };
  }
  return null; // exhausted retries - leave the record untouched so it retries next run
}

// ── work list ──────────────────────────────────────────────────────────────
if (!CATALOG || !fs.existsSync(CATALOG)) {
  console.error("Pass --catalog <file.json> (the /api/catalog payload).");
  process.exit(1);
}
const payload = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
const items = payload.items || payload.shows || [];
const artwork = readEntries(ARTWORK_FILE);
const airing = readEntries(AIRING_FILE);

function resolvedMalId(show) {
  const hit = artwork[show?.id] || {};
  const value = Number(show?.malId || show?.mal_id || hit.malId || hit.meta?.malId || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function resolvedEpisodeCount(show) {
  const episodes = Array.isArray(show?.episodes) ? show.episodes : [];
  const largestListed = episodes.reduce((largest, episode, index) => {
    const value = Number(episode?.canonicalEpisode ?? episode?.episode ?? episode?.number ?? index + 1);
    return Number.isFinite(value) ? Math.max(largest, value) : largest;
  }, 0);
  const artHit = artwork[show?.id] || {};
  const airingHit = airing[show?.id] || {};
  const candidates = [
    show?.sourceEpisodeCount,
    airingHit.sourceEpisodeCount,
    show?.latestAiredEp,
    show?.latestEpisode,
    largestListed,
    show?.totalEpisodes,
    typeof show?.episode === "number" ? show.episode : 0,
    artHit.meta?.episodes,
    airingHit.anilistEpisodeCount
  ].map(Number).filter((value) => Number.isFinite(value) && value > 0);
  return candidates.length ? Math.floor(Math.max(...candidates)) : 0;
}

// One MAL entry should identify one catalogue row. Duplicate guesses are exactly
// the metadata collision class that previously mixed a base series with its
// special, so omit those ambiguous ids instead of attaching the wrong timings.
const showsByMal = new Map();
const collidingMalIds = new Set();
for (const show of items) {
  const malId = resolvedMalId(show);
  const count = resolvedEpisodeCount(show);
  if (!malId || !count || (ONLY_MAL.size && !ONLY_MAL.has(malId))) continue;
  const current = showsByMal.get(malId);
  if (current && current.id !== show.id) {
    collidingMalIds.add(malId);
    continue;
  }
  showsByMal.set(malId, { ...show, malId, resolvedEpisodeCount: count });
}
for (const malId of collidingMalIds) showsByMal.delete(malId);
store.ambiguousMalIds = [...collidingMalIds].sort((a, b) => a - b);

let shows = [...showsByMal.values()];
if (MAX_SHOWS) shows = shows.slice(0, MAX_SHOWS);

const now = Date.now();
let jobs = [];
for (const show of shows) {
  const malId = Number(show.malId);
  // Episode numbering follows the MAL entry this catalogue row represents, which
  // is why later seasons carry their own malId rather than absolute numbering.
  const count = Math.min(show.resolvedEpisodeCount, MAX_EPISODES);
  for (let ep = 1; ep <= count; ep++) {
    const key = `${malId}:${ep}`;
    if (!isDue(store.entries[key], now)) continue;
    jobs.push({ key, malId, ep, title: show.title });
  }
}

// New episodes first; old misses due for a recheck use whatever daily capacity
// remains. This is what makes a newly posted episode gain a skip button on its
// first daily pass rather than sitting behind years of negative cache entries.
jobs.sort((a, b) => Number(Boolean(store.entries[a.key])) - Number(Boolean(store.entries[b.key])));
const dueBeforeCap = jobs.length;
if (MAX_LOOKUPS) jobs = jobs.slice(0, MAX_LOOKUPS);

console.log(`shows: ${shows.length}  episodes due: ${dueBeforeCap}  queued: ${jobs.length}  (cached: ${Object.keys(store.entries).length})`);
if (collidingMalIds.size) console.log(`ambiguous MAL ids skipped: ${collidingMalIds.size}`);
if (DRY_RUN) process.exit(0);
if (!jobs.length) {
  console.log("nothing to do");
  writeStore();
  process.exit(0);
}

// ── bounded concurrency ────────────────────────────────────────────────────
let done = 0;
let hits = 0;
let misses = 0;
let failed = 0;
let cursor = 0;

async function worker() {
  while (cursor < jobs.length) {
    const job = jobs[cursor++];
    const result = await lookup(job.malId, job.ep);
    done++;
    if (result === null) {
      failed++;
    } else if (result.intro || result.outro) {
      hits++;
      const record = { checkedAt: new Date(now).toISOString() };
      if (result.intro) record.intro = result.intro;
      if (result.outro) record.outro = result.outro;
      store.entries[job.key] = record;
    } else {
      misses++;
      store.entries[job.key] = { checkedAt: new Date(now).toISOString() };
    }
    if (done % 50 === 0) console.log(`  ${done}/${jobs.length}  hits=${hits} misses=${misses} failed=${failed}`);
    await sleep(120); // gentle spacing on top of the concurrency cap
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// Prune records that carry neither timestamps nor a checkedAt - nothing should
// look like a hit unless it really is one.
for (const [key, value] of Object.entries(store.entries)) {
  if (!value || (!value.intro && !value.outro && !value.checkedAt)) delete store.entries[key];
}

store.generatedAt = new Date(now).toISOString();
store.count = Object.keys(store.entries).length;
writeStore();

const withIntro = Object.values(store.entries).filter((e) => e.intro).length;
const withOutro = Object.values(store.entries).filter((e) => e.outro).length;
const withBoth = Object.values(store.entries).filter((e) => e.intro && e.outro).length;
console.log(`\nqueried ${done}  hits ${hits}  misses ${misses}  failed ${failed}`);
console.log(`stored ${store.count}  intro ${withIntro}  outro ${withOutro}  both ${withBoth}`);
console.log(`-> ${path.relative(root, OUT)}`);
if (ANDROID_OUT) console.log(`-> ${path.relative(root, ANDROID_OUT)}`);
