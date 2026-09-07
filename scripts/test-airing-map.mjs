// The build-time airing/season bake, end to end.
//
// graphql.anilist.co answers 403 to Vercel and to the browser, so this data can
// only be fetched by the nightly GitHub Actions job and committed. These checks
// cover the two halves that have to agree: what build-airing-map.mjs SHAPES, and
// what client.js does with it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";

const ROOT = process.argv[2] || ".";
const rows = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  rows.push(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`));
};

/* ── 1. The shaping, by running the real script against a fixture ─────────── */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "airing-map-"));
const fixturePath = path.join(tmp, "fixture.json");
const outPath = path.join(tmp, "out.json");
// Without this every one of these runs writes scraper/relations-cache.json in
// the REPO - the suite's fixture edges ended up committed as production data
// once already. Tests get their own file.
const isolatedCache = path.join(tmp, "isolated-relations.json");

const nowSec = Math.floor(Date.now() / 1000);
fs.writeFileSync(fixturePath, JSON.stringify([{
  id: 178789,
  title: { romaji: "Mushoku Tensei III", userPreferred: "Mushoku Tensei: Jobless Reincarnation Season 3" },
  format: "TV", status: "RELEASING", episodes: 14, season: "SPRING", seasonYear: 2026,
  startDate: { year: 2026, month: 4, day: 6 },
  nextAiringEpisode: { airingAt: nowSec + 3600, episode: 12 },
  relations: { edges: [
    // Out of release order on purpose: the shaping has to sort them.
    { relationType: "PREQUEL", node: { id: 146065, type: "ANIME", format: "TV", status: "FINISHED", episodes: 12, seasonYear: 2023, title: { romaji: "Mushoku Tensei II" }, startDate: { year: 2023, month: 10, day: 4 } } },
    { relationType: "PREQUEL", node: { id: 108465, type: "ANIME", format: "TV", status: "FINISHED", episodes: 23, seasonYear: 2021, title: { romaji: "Mushoku Tensei" }, startDate: { year: 2021, month: 1, day: 11 } } },
    // Neither of these is a season.
    { relationType: "SIDE_STORY", node: { id: 999999, type: "ANIME", format: "OVA", status: "FINISHED", episodes: 1, title: { romaji: "Eris the Goblin Slayer" }, startDate: { year: 2022, month: 3, day: 1 } } },
    { relationType: "SPIN_OFF", node: { id: 888888, type: "ANIME", format: "TV", status: "FINISHED", episodes: 12, title: { romaji: "A Spin Off" }, startDate: { year: 2024, month: 1, day: 1 } } },
    { relationType: "SEQUEL", node: { id: 200001, type: "ANIME", format: "TV", status: "NOT_YET_RELEASED", episodes: null, seasonYear: 2028, title: { romaji: "Mushoku Tensei IV" }, startDate: { year: 2028, month: 4, day: 1 } } }
  ] }
}], null, 2));

execFileSync(process.execPath, [
  path.join(ROOT, "scripts", "build-airing-map.mjs"),
    "--relations-cache", isolatedCache,
  "--fixture", fixturePath, "--out", outPath, "--write"
], { stdio: "pipe" });

const built = JSON.parse(fs.readFileSync(outPath, "utf8"));
const entry = Object.values(built.entries)[0];

check("an entry is produced for the catalogue row", Boolean(entry), true);
check("airing instant is milliseconds", entry.nextAiringAt, (nowSec + 3600) * 1000);
check("next episode number carried", entry.nextAiringEpisodeNumber, 12);
check("airing status carried", entry.airingStatus, "RELEASING");
check("season carried", [entry.season, entry.seasonYear], ["SPRING", 2026]);
check("chain is ordered by release date", entry.franchiseSeasons.map((s) => s.seasonYear), [2021, 2023, 2026, 2028]);
check("SIDE_STORY is not a season", entry.franchiseSeasons.some((s) => s.anilistId === 999999), false);
check("SPIN_OFF is not a season", entry.franchiseSeasons.some((s) => s.anilistId === 888888), false);
check("SEQUEL is a season", entry.franchiseSeasons.some((s) => s.anilistId === 200001), true);
check("order is 1-based and contiguous", entry.franchiseSeasons.map((s) => s.order), [1, 2, 3, 4]);

/* ── 2. A show with no relations ships no chain ──────────────────────────── */
fs.writeFileSync(fixturePath, JSON.stringify([{
  id: 1, title: { romaji: "Standalone" }, format: "TV", status: "FINISHED",
  episodes: 12, startDate: { year: 2020, month: 1, day: 1 }, relations: { edges: [] }
}], null, 2));
execFileSync(process.execPath, [
  path.join(ROOT, "scripts", "build-airing-map.mjs"),
    "--relations-cache", isolatedCache,
  "--fixture", fixturePath, "--out", outPath, "--write"
], { stdio: "pipe" });
const solo = Object.values(JSON.parse(fs.readFileSync(outPath, "utf8")).entries)[0];
check("a standalone show carries no chain", solo.franchiseSeasons, []);
check("and no airing instant it does not have", solo.nextAiringAt, null);

/* ── 2b. THE MULTI-HOP CASE ────────────────────────────────────────────────
   SEQUEL/PREQUEL edges are a linked list. Mushoku Tensei S3's own edges name
   only S2 - season 1 is two hops away, and reading one media's edges could
   never reach it. Measured on production 2026-09-06: opening S3 offered exactly
   two tabs, "Season 3 Part 1" and "Season 3 Part 2", and no season 1 at all.

   Here S3 and S2 are both fetched; season 1 is named ONLY by S2 and is never
   fetched (it is absent from our catalogue and from the AnimeAV1 source). It
   must still appear, and the chain must be identical whichever season is
   opened. */
{
  fs.writeFileSync(fixturePath, JSON.stringify([
    {
      id: 178789, title: { romaji: "Mushoku Tensei III" }, format: "TV", status: "RELEASING",
      episodes: 14, seasonYear: 2026, startDate: { year: 2026, month: 4, day: 6 },
      relations: { edges: [
        { relationType: "PREQUEL", node: { id: 146065, type: "ANIME", format: "TV", title: { romaji: "Mushoku Tensei II" }, seasonYear: 2023 } }
      ] }
    },
    {
      id: 146065, title: { romaji: "Mushoku Tensei II" }, format: "TV", status: "FINISHED",
      episodes: 12, seasonYear: 2023, startDate: { year: 2023, month: 10, day: 4 },
      relations: { edges: [
        // Season 1: named here, never fetched, no full startDate - only a year.
        { relationType: "PREQUEL", node: { id: 108465, type: "ANIME", format: "TV", episodes: 23, title: { romaji: "Mushoku Tensei" }, seasonYear: 2021 } },
        { relationType: "SEQUEL", node: { id: 178789, type: "ANIME", format: "TV", title: { romaji: "Mushoku Tensei III" }, seasonYear: 2026 } }
      ] }
    }
  ], null, 2));
  execFileSync(process.execPath, [
    path.join(ROOT, "scripts", "build-airing-map.mjs"),
    "--relations-cache", isolatedCache,
    "--fixture", fixturePath, "--out", outPath, "--write"
  ], { stdio: "pipe" });
  const built = JSON.parse(fs.readFileSync(outPath, "utf8"));
  const s3 = built.entries[Object.keys(built.entries).find((k) => built.entries[k].anilistId === 178789)];
  const s2 = built.entries[Object.keys(built.entries).find((k) => built.entries[k].anilistId === 146065)];

  check("season 1 is reached through season 2, two hops from the opened show",
    s3.franchiseSeasons.map((x) => x.anilistId), [108465, 146065, 178789]);
  check("an unfetched season still orders by its year alone",
    s3.franchiseSeasons.map((x) => x.seasonYear), [2021, 2023, 2026]);
  check("season 1 keeps its own episode count", s3.franchiseSeasons[0].episodes, 23);
  check("the chain is identical opened from season 2",
    s2.franchiseSeasons.map((x) => x.anilistId), [108465, 146065, 178789]);
  check("and is numbered 1..3 from the true first season",
    s3.franchiseSeasons.map((x) => x.order), [1, 2, 3]);
}

/* ── 2c. A RUN THAT RESOLVES NOTHING MUST STILL LEAVE A FILE ───────────────
   Run #111 (2026-09-06) failed exactly here. AniList 403s from the GitHub
   Actions runner just as it does from Vercel and from a dev machine, so the bake
   resolved nothing and wrote no file - and git-auto-commit-action, which lists
   scraper/airing-map.json by name, died with
     fatal: pathspec 'scraper/airing-map.json' did not match any files
     Error: Invalid status code: 128
   taking the whole catalogue commit down with it. */
{
  const emptyOut = path.join(tmp, "empty.json");
  fs.writeFileSync(fixturePath, JSON.stringify([], null, 2));
  execFileSync(process.execPath, [
    path.join(ROOT, "scripts", "build-airing-map.mjs"),
    "--relations-cache", isolatedCache,
    "--fixture", fixturePath, "--out", emptyOut, "--write"
  ], { stdio: "pipe" });
  check("a run that resolves nothing still leaves a file", fs.existsSync(emptyOut), true);
  const empty = JSON.parse(fs.readFileSync(emptyOut, "utf8"));
  check("and that file is a valid, empty map", [empty.count, Object.keys(empty.entries).length], [0, 0]);

  // ...and it must never flatten a map that already has content.
  const populated = { generatedAt: "2026-01-01T00:00:00.000Z", count: 2, entries: { a: { anilistId: 1 }, b: { anilistId: 2 } } };
  fs.writeFileSync(emptyOut, JSON.stringify(populated, null, 2));
  execFileSync(process.execPath, [
    path.join(ROOT, "scripts", "build-airing-map.mjs"),
    "--relations-cache", isolatedCache,
    "--fixture", fixturePath, "--out", emptyOut, "--write"
  ], { stdio: "pipe" });
  check("an existing map is never overwritten by an empty run",
    JSON.parse(fs.readFileSync(emptyOut, "utf8")).count, 2);
}

/* ── 2d. THE JIKAN + OFFLINE-DATABASE FALLBACK ────────────────────────────
   AniList answers 403 from every network we have, GitHub Actions included, so
   the season chain has to come from somewhere else. Jikan labels its relations
   ("Prequel" / "Sequel"), which keeps the chain trustworthy; the manami offline
   database supplies each entry's title, episode count and AniList id without a
   second request.

   The database's own relatedAnime is UNTYPED and is never the relation source.
   Measured over this catalogue it merges 78 Gundam series into one franchise
   and attaches Ponkotsu Quest to Vinland Saga - hence the decoy below, a real
   TV show wired in through Spin-off/Side story/Other, which must never appear.

   Ids and episode counts here are the real ones. */
{
  const offline = path.join(tmp, "offline.jsonl");
  const jikan = path.join(tmp, "jikan.json");
  const artwork = path.join(tmp, "artwork.json");
  const chainOut = path.join(tmp, "chain.json");

  // relatedAnime is what PRESELECTS a row for a Jikan call - the cheap "could
  // this possibly have seasons at all?" test - so it has to be populated exactly
  // as the real database populates it. Note it is deliberately UNTYPED here,
  // which is precisely why it can never be the relation source itself.
  const dbRow = (mal, ani, title, type, episodes, year, season, related = []) => JSON.stringify({
    sources: [`https://anilist.co/anime/${ani}`, `https://myanimelist.net/anime/${mal}`],
    title, type, episodes, animeSeason: { season, year },
    relatedAnime: related.map((id) => `https://myanimelist.net/anime/${id}`)
  });
  fs.writeFileSync(offline, [
    dbRow(39535, 108465, "Mushoku Tensei: Isekai Ittara Honki Dasu", "TV", 11, 2021, "WINTER", [45576, 21]),
    dbRow(45576, 127720, "Mushoku Tensei: Isekai Ittara Honki Dasu Part 2", "TV", 12, 2021, "FALL", [39535, 51179]),
    dbRow(51179, 146065, "Mushoku Tensei II: Isekai Ittara Honki Dasu", "TV", 12, 2023, "SUMMER", [45576, 55888, 21]),
    dbRow(55888, 166873, "Mushoku Tensei II: Isekai Ittara Honki Dasu Part 2", "TV", 12, 2024, "SPRING", [51179, 59193]),
    dbRow(59193, 178789, "Mushoku Tensei III: Isekai Ittara Honki Dasu", "TV", 14, 2026, "SUMMER", [55888]),
    dbRow(21, 21, "One Piece", "TV", null, 1999, "FALL", [39535, 51179])
  ].join("\n") + "\n");

  const anime = (mal, name) => ({ mal_id: mal, type: "anime", name });
  fs.writeFileSync(jikan, JSON.stringify({
    39535: [{ relation: "Sequel", entry: [anime(45576, "Part 2")] },
            { relation: "Other", entry: [anime(21, "DECOY")] }],
    45576: [{ relation: "Prequel", entry: [anime(39535, "S1")] },
            { relation: "Sequel", entry: [anime(51179, "II")] }],
    51179: [{ relation: "Prequel", entry: [anime(45576, "Part 2")] },
            { relation: "Sequel", entry: [anime(55888, "II Part 2")] },
            { relation: "Spin-off", entry: [anime(21, "DECOY")] },
            { relation: "Side story", entry: [anime(21, "DECOY")] }],
    55888: [{ relation: "Prequel", entry: [anime(51179, "II")] },
            { relation: "Sequel", entry: [anime(59193, "III")] }],
    59193: [{ relation: "Prequel", entry: [anime(55888, "II Part 2")] }]
  }, null, 2));

  // Only the two seasons our catalogue actually carries.
  fs.writeFileSync(artwork, JSON.stringify({ entries: {
    "animeav1-mushoku-tensei-ii-isekai-ittara-honki-dasu": { anilistId: 146065, malId: 51179 },
    "animeav1-mushoku-tensei-iii-isekai-ittara-honki-dasu": { anilistId: 178789, malId: 59193 }
  } }, null, 2));

  execFileSync(process.execPath, [
    path.join(ROOT, "scripts", "build-airing-map.mjs"),
    "--relations-cache", isolatedCache,
    "--artwork", artwork, "--offline-fixture", offline, "--jikan-fixture", jikan,
    "--out", chainOut, "--write"
  ], { stdio: "pipe" });

  const built = JSON.parse(fs.readFileSync(chainOut, "utf8"));
  const s3 = Object.values(built.entries).find((e) => e.anilistId === 178789);
  const s2 = Object.values(built.entries).find((e) => e.anilistId === 146065);
  const ids = s3.franchiseSeasons.map((x) => x.anilistId);

  check("the fallback builds a chain with no AniList at all", ids.length, 5);
  check("season 1 survives two links outside the catalogue", ids[0], 108465);
  check("season 2 is there too", ids.includes(146065), true);
  check("in release order", s3.franchiseSeasons.map((x) => x.seasonYear), [2021, 2021, 2023, 2024, 2026]);
  check("ordered within a year by the season it aired in",
    s3.franchiseSeasons.slice(0, 2).map((x) => x.season), ["WINTER", "FALL"]);
  check("each season keeps its own episode count",
    s3.franchiseSeasons.map((x) => x.episodes), [11, 12, 12, 12, 14]);
  check("a spin-off/side-story/other decoy is never a season", ids.includes(21), false);
  check("the chain is identical opened from season 2", s2.franchiseSeasons.map((x) => x.anilistId), ids);
  check("numbering starts at the true first season", s3.franchiseSeasons.map((x) => x.order), [1, 2, 3, 4, 5]);
}

/* ── 2e. THE CHAIN MUST CONVERGE ACROSS RUNS ──────────────────────────────
   Jikan cannot be crawled in one pass from a GitHub runner. Run #114 spent its
   entire 28-minute budget resolving 99 of 599 rows, because most ids answer 504
   and burn three retries each - and MAL id 55888 (Mushoku Tensei II Part 2, the
   link between season 3 and everything before it) answers 504 every time.
   Production got a two-entry chain out of that.

   So what a run learns has to survive it. Here the first pass can only read the
   two ids nearest the opened show; the second pass reads the rest and must
   reuse - not refetch - what the first one already knew. */
{
  const cachePath = path.join(tmp, "relations.json");
  const chainOut = path.join(tmp, "converge.json");
  const offline = path.join(tmp, "offline.jsonl");
  const artwork = path.join(tmp, "artwork.json");
  const anime = (mal) => ({ mal_id: mal, type: "anime", name: String(mal) });
  const runBake = (jikanPath) => execFileSync(process.execPath, [
    path.join(ROOT, "scripts", "build-airing-map.mjs"),
    "--artwork", artwork, "--offline-fixture", offline, "--jikan-fixture", jikanPath,
    "--relations-cache", cachePath, "--out", chainOut, "--write"
  ], { stdio: "pipe" }).toString();

  // Night one: only the opened show and its immediate neighbour answer.
  const night1 = path.join(tmp, "jikan1.json");
  fs.writeFileSync(night1, JSON.stringify({
    59193: [{ relation: "Prequel", entry: [anime(55888)] }],
    55888: [{ relation: "Prequel", entry: [anime(51179)] }, { relation: "Sequel", entry: [anime(59193)] }]
  }));
  runBake(night1);
  const after1 = JSON.parse(fs.readFileSync(chainOut, "utf8"));
  const chain1 = Object.values(after1.entries).find((e) => e.anilistId === 178789).franchiseSeasons;
  check("night one gets only as far as it could read", chain1.map((x) => x.anilistId), [146065, 166873, 178789]);
  check("and what it learned is written down", JSON.parse(fs.readFileSync(cachePath, "utf8")).count, 2);

  // Night two: the rest of the chain answers. The first two ids must be REUSED.
  const night2 = path.join(tmp, "jikan2.json");
  fs.writeFileSync(night2, JSON.stringify({
    51179: [{ relation: "Prequel", entry: [anime(45576)] }, { relation: "Sequel", entry: [anime(55888)] }],
    45576: [{ relation: "Prequel", entry: [anime(39535)] }, { relation: "Sequel", entry: [anime(51179)] }],
    39535: [{ relation: "Sequel", entry: [anime(45576)] }]
  }));
  const log2 = runBake(night2);
  const after2 = JSON.parse(fs.readFileSync(chainOut, "utf8"));
  const chain2 = Object.values(after2.entries).find((e) => e.anilistId === 178789).franchiseSeasons;

  check("night two completes the franchise", chain2.map((x) => x.anilistId), [108465, 127720, 146065, 166873, 178789]);
  check("season 1 is finally there", chain2[0].anilistId, 108465);
  check("in release order", chain2.map((x) => x.seasonYear), [2021, 2021, 2023, 2024, 2026]);
  check("night one's ids were reused, not refetched", /reused from cache/.test(log2) && /2 known before this run/.test(log2), true);
  check("the cache now holds every link", JSON.parse(fs.readFileSync(cachePath, "utf8")).count, 5);
}

/* ── 3. The client half ───────────────────────────────────────────────────── */
const src = fs.readFileSync(path.join(ROOT, "client.js"), "utf8");
const slice = (start, end) => {
  const a = src.indexOf(start);
  if (a < 0) { console.error("MISS " + start); process.exit(1); }
  const b = src.indexOf(end, a);
  return src.slice(a, b < 0 ? undefined : b);
};

let catalog = [];
const ctx = vm.createContext({
  Number, String, Array, Math, JSON, Boolean, Object,
  catalogShows: () => catalog,
  getDetailSeasons: (show) => [{ season: 1, episodes: (show.episodes || []).slice() }],
  _buildShowsByAniListId: () => new Map(),
  // Swapped per-case below to stand in for whatever the live traversal returned.
  buildSeasonListFromAniListFranchise: () => null,
  makePlaceholderEpisodes: (show, n) => Array.from({ length: Number(show.anilistEpisodeCount || 3) }, (_, i) => ({ episode: i + 1, season: n }))
});
vm.runInContext([
  slice("function bakedChainFor(", "\nfunction getFranchiseSeasonList("),
  slice("function getFranchiseSeasonList(", "\n// ── TioAnime source integration")
].join("\n"), ctx, { filename: "client.js extract" });
const bakedChainFor = vm.runInContext("bakedChainFor", ctx);
const buildSeasonListFromBakedChain = vm.runInContext("buildSeasonListFromBakedChain", ctx);

const chain = [
  { anilistId: 108465, title: "Mushoku Tensei", episodes: 23, seasonYear: 2021, format: "TV", status: "FINISHED", order: 1 },
  { anilistId: 146065, title: "Mushoku Tensei II", episodes: 12, seasonYear: 2023, format: "TV", status: "FINISHED", order: 2 },
  { anilistId: 178789, title: "Mushoku Tensei III", episodes: 14, seasonYear: 2026, format: "TV", status: "RELEASING", order: 3 }
];

// The opened object often is NOT the catalogue row that carries the chain: the
// deep-link path builds one with the source's raw id while the catalogue row is
// normalised. Both must find it.
const catalogRow = { id: "source-animetv-api-animeav1-mt3", anilistId: 178789, title: "Mushoku Tensei III", franchiseSeasons: chain };
catalog = [catalogRow];

check("a show carrying the chain resolves it", bakedChainFor(catalogRow).chain.length, 3);
const opened = { id: "animeav1-mt3", title: "Mushoku Tensei III", episodes: [{ episode: 1 }, { episode: 2 }] };
check("an opened object with the raw id still resolves it", bakedChainFor(opened).chain.length, 3);
check("and inherits the matched row's AniList id", bakedChainFor(opened).selfAniListId, 178789);
check("an unrelated show resolves nothing", bakedChainFor({ id: "animeav1-other" }), null);

const list = buildSeasonListFromBakedChain(opened, new Map());
check("three seasons are built", list.length, 3);
check("in release order", list.map((s) => s.year), [2021, 2023, 2026]);
check("exactly one is the current show", list.filter((s) => s.isCurrentShow).length, 1);
check("and it is the one that was opened", list.find((s) => s.isCurrentShow).anilistId, 178789);
check("the current season uses the real episodes", list.find((s) => s.isCurrentShow).episodes.length, 2);
check("other seasons are filled from their own counts", list[0].episodes.length, 23);
check("filled episodes are locked, not pretend-playable", list[0].episodes.every((e) => e.locked), true);

// A single-entry chain says nothing the normal path does not.
catalog = [{ id: "x", anilistId: 5, franchiseSeasons: [{ anilistId: 5, title: "Only", episodes: 12, order: 1 }] }];
check("a one-link chain is not a season list", buildSeasonListFromBakedChain({ id: "x", anilistId: 5 }, new Map()), null);
check("no chain at all is not a season list", buildSeasonListFromBakedChain({ id: "nope" }, new Map()), null);

/* ── which source wins ────────────────────────────────────────────────────
   getFranchiseSeasonList used to return the LIVE franchise first and
   unconditionally. That was right while AniList answered. It does not any
   more: the live traversal falls back to Jikan, whose relation nodes are
   shallow, and it stops at whatever it could expand on that page load. For
   Mushoku Tensei that is two entries - "Season 3 Part 1" and "Season 3 Part
   2", the second being season 2 mislabelled - and they were overriding a baked
   chain holding all five seasons in order. Reported from production with a
   screenshot of exactly those two tabs. */
{
  const getFranchiseSeasonList = vm.runInContext("getFranchiseSeasonList", ctx);
  const setLive = (value) => { ctx.buildSeasonListFromAniListFranchise = () => value; };

  catalog = [catalogRow];
  const opened = { id: "animeav1-mt3", anilistId: 178789, title: "Mushoku Tensei III", episodes: [{ episode: 1 }], anilistFranchise: {} };

  setLive([{ season: 3, title: "Season 3 Part 1" }, { season: 3, title: "Season 3 Part 2" }]);
  const withDegradedLive = getFranchiseSeasonList(opened);
  check("a degraded live franchise never beats a fuller baked chain", withDegradedLive.length, 3);
  check("and the baked labels are the ones shown",
    withDegradedLive.map((x) => x.title), ["Mushoku Tensei", "Mushoku Tensei II", "Mushoku Tensei III"]);

  // The live source still wins when it genuinely knows more - AniList coming
  // back, or a season that aired after the last bake.
  setLive([{ season: 1 }, { season: 2 }, { season: 3 }, { season: 4 }]);
  check("a richer live franchise is still preferred", getFranchiseSeasonList(opened).length, 4);

  setLive(null);
  check("no live franchise at all falls through to the baked chain", getFranchiseSeasonList(opened).length, 3);
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(rows.join("\n"));
const failed = rows.filter((r) => r.startsWith("FAIL")).length;
console.log(failed ? `\n${failed} FAILED` : "\nall airing-map checks passed");
process.exit(failed ? 1 : 0);
