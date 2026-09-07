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
    "--fixture", fixturePath, "--out", emptyOut, "--write"
  ], { stdio: "pipe" });
  check("an existing map is never overwritten by an empty run",
    JSON.parse(fs.readFileSync(emptyOut, "utf8")).count, 2);
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
  makePlaceholderEpisodes: (show, n) => Array.from({ length: Number(show.anilistEpisodeCount || 3) }, (_, i) => ({ episode: i + 1, season: n }))
});
vm.runInContext(slice("function bakedChainFor(", "\nfunction getFranchiseSeasonList("), ctx, { filename: "client.js extract" });
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

fs.rmSync(tmp, { recursive: true, force: true });

console.log(rows.join("\n"));
const failed = rows.filter((r) => r.startsWith("FAIL")).length;
console.log(failed ? `\n${failed} FAILED` : "\nall airing-map checks passed");
process.exit(failed ? 1 : 0);
