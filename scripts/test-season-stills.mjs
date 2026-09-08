// Regression test for the cached-show crash:
//
//   anime._seasonStillsTried = new Set()   ->  JSON round trip  ->  {}
//   anime._seasonStillsTried.has(sNum)     ->  TypeError, episode panel dies
//
// Loads the REAL js/image-resolver.js in a VM so the assertions track the
// shipped module rather than a restatement of it.
import fs from "node:fs";
import vm from "node:vm";

const ROOT = process.argv[2] || ".";
const src = fs.readFileSync(ROOT + "/js/image-resolver.js", "utf8");

const rows = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  rows.push(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`));
};
// The module runs in its own VM realm, so its Set is a different constructor
// than this file's. instanceof would be false for a perfectly good Set; the
// brand check works across realms.
const isSet = (v) => Object.prototype.toString.call(v) === "[object Set]";
const checkNoThrow = (name, fn) => {
  try { fn(); rows.push(`PASS  ${name}`); }
  catch (e) { rows.push(`FAIL  ${name}  (threw ${e && e.message})`); }
};

// ── minimal browser surface the module touches ────────────────────────────
const store = new Map();
const ctx = {
  console: { debug() {}, log() {}, warn() {}, error() {} },
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  },
  fetch: () => Promise.reject(new Error("network disabled in test")),
  setTimeout, clearTimeout, Promise, Date, Math, JSON, URL
};
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx, { filename: "js/image-resolver.js" });

const ImageResolver = vm.runInContext("ImageResolver", ctx);
check("module exposes ensureSeasonStills", typeof ImageResolver.ensureSeasonStills, "function");

const ensure = ImageResolver.ensureSeasonStills;

// ── the exact production failure, reproduced end to end ───────────────────
{
  const live = { id: 1, tmdbId: 999, _seasonStillsTried: new Set([1]) };
  const revived = JSON.parse(JSON.stringify(live));
  check("a Set really does serialise to {}", revived._seasonStillsTried, {});
  checkNoThrow("JSON round-tripped show does not throw", () => ensure(revived, 1));
  check("the {} was normalised to a real Set", isSet(revived._seasonStillsTried), true);
}

// ── every restored shape the field can come back as ───────────────────────
const shapes = [
  ["undefined", undefined],
  ["null", null],
  ["{} (serialised Set)", {}],
  ["[] (empty array)", []],
  ["[1,2] (array with values)", [1, 2]],
  ["a real Set", new Set([3])]
];
for (const [label, value] of shapes) {
  const anime = { id: 2, tmdbId: 999, _seasonStillsTried: value };
  checkNoThrow(`ensureSeasonStills tolerates ${label}`, () => ensure(anime, 1));
  check(`${label} becomes a Set`, isSet(anime._seasonStillsTried), true);
}

// ── an array's values are preserved, a serialised Set's are not (it has none)
{
  const fromArray = { id: 3, tmdbId: 999, _seasonStillsTried: [7, 8] };
  ensure(fromArray, 1);
  // No TMDB season list means the requested season remains retryable.
  check("array values are rehydrated", [...fromArray._seasonStillsTried].sort((a,b)=>a-b), [7, 8]);

  const fromObject = { id: 4, tmdbId: 999, _seasonStillsTried: {} };
  ensure(fromObject, 1);
  check("a serialised Set starts empty, not corrupt", [...fromObject._seasonStillsTried], []);
}

// ── the guard still short-circuits a season already tried ─────────────────
{
  const anime = { id: 5, tmdbId: 999, _seasonStillsTried: vm.runInContext("new Set([2])", ctx) };
  checkNoThrow("an already-tried season resolves without throwing", () => ensure(anime, 2));
  check("already-tried season still recorded", anime._seasonStillsTried.has(2), true);
}

// ── a show with no tmdbId must not blow up either ─────────────────────────
checkNoThrow("show without tmdbId resolves", () => ensure({ id: 6 }, 1));
checkNoThrow("undefined show resolves", () => ensure(undefined, 1));

// TMDB models Honzuki's first 36 episodes as one season while AniList models
// them as three. The exact app season must still select the right TMDB bucket.
{
  const tmdbShow = { seasons: [
    { season_number: 1, episode_count: 36, name: "Ascendance of a Bookworm", air_date: "2019-10-03" },
    { season_number: 2, episode_count: 24, name: "Adopted Daughter of an Archduke", air_date: "2026-04-03" }
  ] };
  for (const [title, seasonNumber, expectedTmdbSeason] of [
    ["Honzuki no Gekokujou", 1, 1],
    ["Honzuki no Gekokujou 2nd Season", 2, 1],
    ["Honzuki no Gekokujou 3rd Season", 3, 1],
    ["Honzuki no Gekokujou: Ryoushu no Youjo", 4, 2]
  ]) {
    const result = ImageResolver.pickTmdbSeason({ title, canonicalSeasonNumber: seasonNumber }, tmdbShow);
    check(`${title} maps to its real TMDB season`, result.season?.season_number, expectedTmdbSeason);
  }
}

// TMDB inserts the Bridon arc as physical Season 3, so Link Click's canonical
// third season must select physical Season 4 rather than the live-action show or
// Bridon's episode art.
{
  const tmdbShow = { seasons: [
    { season_number: 1, episode_count: 11, name: "Link Click", air_date: "2021-04-30" },
    { season_number: 2, episode_count: 12, name: "Link Click 2", air_date: "2023-07-14" },
    { season_number: 3, episode_count: 6, name: "Bridon Arc", air_date: "2024-12-27" },
    { season_number: 4, episode_count: 12, name: "Link Click 3", air_date: "2026-08-14" }
  ] };
  const result = ImageResolver.pickTmdbSeason({
    title: "Shiguang Dailiren III",
    englishTitle: "Link Click Season 3",
    canonicalSeasonNumber: 3
  }, tmdbShow);
  check("Link Click app Season 3 maps past Bridon to TMDB Season 4", result.season?.season_number, 4);
}

{
  const unsafe = ImageResolver.pickTmdbSeason({
    title: "Unrelated Earlier Series",
    canonicalSeasonNumber: 1,
    tmdbFranchiseFallback: true,
    tmdbFranchiseCarrierSeason: 4
  }, { seasons: [{ season_number: 1, episode_count: 12, name: "Separate Sequel" }] });
  check("an inherited id cannot borrow a separately catalogued sequel", unsafe.season, null);
}

// Same-year split cours cannot be scoped by release year. The baked provider
// offset is authoritative and must select the second half of the TMDB season.
{
  const anime = {
    id: "same-year-part-two",
    anilistId: 127720,
    tmdbId: 94664,
    title: "Mushoku Tensei Part 2",
    year: 2021,
    isFranchiseEntry: true,
    providerEpisodeOffset: 11,
    totalEpisodes: 12,
    tmdbSeasons: [{ season_number: 1, episode_count: 23, name: "Season 1", air_date: "2021-01-01" }]
  };
  ctx.fetch = async (url) => ({
    ok: true,
    json: async () => ({ season: { poster_path: null, episodes: Array.from({ length: 23 }, (_, index) => ({
      episode_number: index + 1,
      name: `Absolute ${index + 1}`,
      overview: "",
      air_date: "2021-01-01",
      still_path: `/episode-${index + 1}.jpg`
    })) } })
  });
  await ensure(anime, 1, { season: 1, year: 2021, episodeCount: 12, providerEpisodeOffset: 11 });
  check("same-year Part 2 starts after the provider offset", anime.tmdbEpisodesBySeasonNum[1][1].title, "Absolute 12");
  check("same-year Part 2 keeps exactly its own episode count", Object.keys(anime.tmdbEpisodesBySeasonNum[1]).length, 12);
}

// A cache row is only reusable when it came from the TMDB season the current
// mapping selects. This is the regression behind Season 3 displaying Season 1
// episode names after a reload.
{
  const anime = {
    id: "season-cache",
    anilistId: 178789,
    tmdbId: 94664,
    title: "Mushoku Tensei III: Isekai Ittara Honki Dasu",
    seasonNumber: 3,
    isFranchiseEntry: true,
    tmdbSeasons: [
      { season_number: 1, episode_count: 12, name: "Season 1", air_date: "2021-01-01" },
      { season_number: 3, episode_count: 12, name: "Season 3", air_date: "2026-01-01" }
    ]
  };
  const cacheKey = "zenkaitv:tmdb-season-art:v8:178789:s3";
  store.set(cacheKey, JSON.stringify({
    savedAt: Date.now(),
    data: {
      anilistId: "178789",
      tmdbId: "94664",
      appSeasonNumber: 3,
      tmdbSeasonNumber: 1,
      stills: {},
      metas: { 1: { episode: 1, title: "Wrong Season" } }
    }
  }));
  let fetches = 0;
  ctx.fetch = async (url) => {
    fetches += 1;
    check("wrong cached mapping refetches TMDB Season 3", String(url).includes("season=3"), true);
    return {
      ok: true,
      json: async () => ({ season: { poster_path: null, episodes: [
        { episode_number: 1, name: "Correct Season", overview: "", air_date: "2026-01-01", still_path: null }
      ] } })
    };
  };
  await ensure(anime, 3, { season: 3, title: "Season 3", sourceTitle: anime.title });
  check("wrong cached season is discarded", fetches, 1);
  check("refetched metadata belongs to Season 3", anime.tmdbEpisodesBySeasonNum[3][1].title, "Correct Season");
  const repaired = JSON.parse(store.get(cacheKey));
  check("cache stores TMDB season provenance", repaired.data.tmdbSeasonNumber, 3);
}

{
  const franchise = {
    isFranchiseEntry: true,
    tmdbEpisodeStills: { 1: "https://example.test/season-1.jpg" },
    tmdbEpisodesByNum: { 1: { episode: 1, title: "Season 1" } }
  };
  check("franchise stills never fall through to a flat season", ImageResolver.getEpisodeStill(franchise, { episode: 1 }, 3), "");
  check("franchise nearest still never crosses seasons", ImageResolver.getNearestEpisodeStill(franchise, { episode: 1 }, 3), "");
  check("franchise metadata never crosses seasons", ImageResolver.getSeasonEpisodeMeta(franchise, 3, 1), null);
}

console.log(rows.join("\n"));
const failed = rows.filter((r) => r.startsWith("FAIL")).length;
console.log(failed ? `\n${failed} FAILED` : "\nall season-stills checks passed");
process.exit(failed ? 1 : 0);
