import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const client = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const seasons = readFileSync(new URL("../js/season-normalization.js", import.meta.url), "utf8");
const section = (start, end) => client.slice(client.indexOf(start), client.indexOf(end, client.indexOf(start)));
function harness(shows, query, sort = "default") {
  const context = vm.createContext({
    state: { search: query, librarySort: sort, libraryLetter: "all", libraryType: "all", libraryGenre: "all", libraryYear: "all", libraryStatus: "all" },
    getShowTitle: show => show.englishTitle || show.title || "",
    _animeAv1CatalogSearchMatches: new Map(),
    animeAv1CatalogSlugForShow: show => show.slug
  });
  vm.runInContext(seasons, context);
  vm.runInContext(section("function normalizeSearchText(", "// ── Live AniList search"), context);
  vm.runInContext(section("function showGenres(", "function updateLibraryResultCount("), context);
  return {
    context,
    result: () => Array.from(context.sortLibraryShows(shows.filter(context.matchesShowSearch).filter(context.matchesLibraryAdvancedFilters))),
    ids: () => Array.from(context.sortLibraryShows(shows.filter(context.matchesShowSearch).filter(context.matchesLibraryAdvancedFilters)), show => show.id)
  };
}
const show = (id, title, year = 0, extra = {}) => ({ id, title, year, format: "TV", ...extra });

test("Naruto is first and Shippuden follows before movies or mislabeled one-offs", () => {
  const rows = [
    show("movie", "Naruto Movie 1", 2004, { format: "MOVIE" }),
    show("special", "Naruto Sports Festival", 2004, { status: "FINISHED", totalEpisodes: 1 }),
    show("sd", "Naruto SD", 2012),
    show("boruto", "Boruto: Naruto Next Generations", 2017),
    show("shippuden", "Naruto: Shippuden", 2007),
    show("original", "Naruto", 2002)
  ];
  const originalOrder = rows.map(row => row.id);
  const result = harness(rows, "naruto").ids();
  assert.deepEqual(result.slice(0, 3), ["original", "shippuden", "sd"]);
  assert.equal(result.length, rows.length);
  assert.deepEqual(rows.map(row => row.id), originalOrder);
  assert.equal(harness(rows, "naruto shippuden").ids()[0], "shippuden");
  assert.equal(harness(rows, "naruto movie 1").ids()[0], "movie");
});

test("Dragon Ball main series precede its films in original release order", () => {
  const rows = [
    show("super", "Dragon Ball Super", 2015), show("daima", "Dragon Ball Daima", 2024),
    show("movie", "Dragon Ball Movie 1", 1986, { format: "MOVIE" }),
    show("z", "Dragon Ball Z", 1989), show("gt", "Dragon Ball GT", 1996), show("base", "Dragon Ball", 1986)
  ];
  assert.deepEqual(harness(rows, "dragon ball").ids(), ["base", "z", "gt", "super", "daima", "movie"]);
});

test("partial relation chains cannot promote newer sequels over earlier series", () => {
  const rows = [
    show("daima", "Dragon Ball Daima", 2024, { anilistId: 3, franchiseSeasons: [{ anilistId: 3, order: 1 }] }),
    show("z", "Dragon Ball Z", 1989, { canonicalSeasonNumber: 2 }),
    show("gt", "Dragon Ball GT", 1996, { canonicalSeasonNumber: 3 }),
    show("base", "Dragon Ball", 1986)
  ];
  assert.deepEqual(harness(rows, "dragon ball").ids(), ["base", "z", "gt", "daima"]);
});

test("unrelated matching series stay in separate chronological groups", () => {
  const rows = [
    show("a3", "Alpha Game Season 3", 2025), show("b2", "Beta Game Season 2", 2024),
    show("b1", "Beta Game", 2018), show("a1", "Alpha Game", 2020), show("a2", "Alpha Game Season 2", 2023)
  ];
  assert.deepEqual(harness(rows, "game").ids(), ["a1", "a2", "a3", "b1", "b2"]);
  assert.deepEqual(harness([...rows].reverse(), "game").ids(), ["a1", "a2", "a3", "b1", "b2"]);
});

test("canonical relation chains join renamed sequels without changing their titles", () => {
  const chain = [
    { anilistId: 10, order: 1 }, { anilistId: 20, order: 2 }, { anilistId: "mal-30", malId: 30, order: 3 }
  ];
  const rows = [
    show("third", "Chronicles Reborn", 2025, { malId: 30, synonyms: ["Orbit Reborn"], franchiseSeasons: chain }),
    show("other", "Academy Orbit", 2010),
    show("second", "Orbit Renewal", 2020, { anilistId: 20, franchiseSeasons: chain }),
    show("base", "Orbit", 2018, { anilistId: 10 })
  ];
  assert.deepEqual(harness(rows, "orbit").ids(), ["base", "second", "third", "other"]);
  assert.equal(rows[0].title, "Chronicles Reborn");
});

test("season and part markers order correctly even without release years", () => {
  const rows = [
    show("final", "Example Final Season"), show("s10", "Example Season 10"),
    show("s2", "Example 2nd Season"), show("p2", "Example Season 1 Part 2"), show("s1", "Example Season 1")
  ];
  assert.deepEqual(harness(rows, "example").ids(), ["s1", "p2", "s2", "s10", "final"]);
});

test("typos, aliases, punctuation, and provider-only results remain searchable", () => {
  const rows = [
    show("liar", "Liar Game", 2026), show("translated", "Other Original Title", 2020, { aliases: ["Café Game"] }),
    show("source", "Daima", 2024, { slug: "dragon-ball-daima" })
  ];
  assert.equal(harness(rows, "lier game").ids()[0], "liar");
  assert.equal(harness(rows, "cafe game").ids()[0], "translated");
  const h = harness(rows, "Dragon Ball");
  h.context._animeAv1CatalogSearchMatches.set("dragon ball", new Set(["dragon-ball-daima"]));
  assert.deepEqual(h.ids(), ["source"]);
  assert.equal(harness([show("colon", "Re:Zero"), show("suffix", "Re:Zero Season 2")], "Re:Zero").ids()[0], "colon");
});

test("default browsing and explicit sort modes retain their existing behavior", () => {
  const rows = [show("new", "Example Season 2", 2024, { score: 90, totalEpisodes: 24 }), show("old", "Example", 2020, { score: 80, totalEpisodes: 12 })];
  assert.deepEqual(harness(rows, "").ids(), ["new", "old"]);
  for (const sort of ["score", "year", "episodes"]) assert.deepEqual(harness(rows, "example", sort).ids(), ["new", "old"]);
  assert.deepEqual(harness(rows, "example", "title").ids(), ["old", "new"]);
  const h = harness(rows, "example");
  h.context.state.libraryYear = "2024";
  assert.deepEqual(h.ids(), ["new"]);
  h.context.state.libraryType = "movie";
  assert.deepEqual(h.ids(), []);
});

test("title ranking updates when late metadata adds an exact translated title", () => {
  const rows = [show("first", "Star Example"), show("late", "Star Chronicle")];
  const h = harness(rows, "star");
  rows[1].englishTitle = "Star";
  assert.equal(h.ids()[0], "late");
  assert.equal(rows[0].id, "first");
});

test("genre-only matches cannot outrank an exact title and no rows are lost", () => {
  const rows = Array.from({ length: 1000 }, (_, i) => show(`item-${i}`, `Series ${i}`, 2000 + i % 25, { genres: ["Action"] }));
  rows.push(show("exact", "Action", 2025));
  const result = harness(rows, "action").ids();
  assert.equal(result[0], "exact");
  assert.equal(result.length, rows.length);
  assert.equal(new Set(result).size, rows.length);
});
