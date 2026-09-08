// A show must never be deleted from the catalogue by a wrong identity guess.
//
// artwork-map.json resolves an AniList/MAL id per row, and it is sometimes wrong
// in a specific way: it hands ONE id to TWO different AnimeAV1 slugs. Measured
// 2026-09-07 on the live map, eight ids were shared that way -
// "Nukitashi the Animation" and "Nukitashi the Animation Specials" are both
// AniList 174188. mergeShows saw matching ids, merged the two rows, and the
// specials entry won: the base series vanished from /api/catalog entirely and
// its slug became unreachable. Six shows were lost this way.
//
// The AnimeAV1 slug is the only identity that is ours - it is the key the source
// serves episodes under - so it outranks any matcher guess.
import fs from "node:fs";
import vm from "node:vm";

const ROOT = process.argv[2] || ".";
const src = fs.readFileSync(ROOT + "/animetv-server.js", "utf8");

const slice = (start, end) => {
  const a = src.indexOf(start);
  if (a < 0) { console.error("MISS " + start); process.exit(1); }
  const b = src.indexOf(end, a);
  return src.slice(a, b < 0 ? undefined : b);
};

// Absent on the build this fixes, which is the point: running the suite against
// the previous animetv-server.js has to reach the assertions and fail them,
// rather than dying on a missing slice.
const optionalSlice = (start, end) => (src.indexOf(start) < 0 ? "" : slice(start, end));

const code = [
  optionalSlice("function animeAv1SlugOf(", "\nfunction catalogIdentitiesAreCompatible("),
  slice("function catalogIdentitiesAreCompatible(", "\nfunction mergeShows("),
  slice("function mergeShows(", "\nfunction normalizeTitle("),
  slice("function normalizeTitle(", "\nfunction pickGenre("),
  slice("function mergeCatalogShow(", "\nfunction "),
  slice("function mergeSourceLabels(", "\nfunction "),
  slice("function catalogMetadataRank(", "\nfunction ")
].join("\n");

const ctx = vm.createContext({ Number, String, Array, Math, JSON, Boolean, Object, Set, Map, console });
vm.runInContext(code, ctx, { filename: "animetv-server.js extract" });
const mergeShows = vm.runInContext("mergeShows", ctx);

const rows = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  rows.push(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`));
};

const av1 = (slug, title, extra = {}) => ({ id: `animeav1-${slug}`, title, source: "AnimeAV1", ...extra });

/* ── the exact production shape ───────────────────────────────────────────── */
{
  // Both rows carry AniList 174188, because the artwork matcher proposed it twice.
  const merged = mergeShows([
    av1("nukitashi-the-animation", "Nukitashi the Animation", { anilistId: 174188, malId: 57969 }),
    av1("nukitashi-the-animation-specials", "Nukitashi the Animation Specials", { anilistId: 174188, malId: 57969 })
  ]);
  check("one id shared by two slugs keeps BOTH shows", merged.length, 2);
  check("and the base series is still there",
    merged.some((s) => s.id === "animeav1-nukitashi-the-animation"), true);
  check("and so are the specials",
    merged.some((s) => s.id === "animeav1-nukitashi-the-animation-specials"), true);
}

/* ── all six shows lost in production ─────────────────────────────────────── */
{
  const pairs = [
    ["super-no-ura-de-yani-suu-futari", "super-no-ura-de-yani-suu-futari-mini", 196187],
    ["nukitashi-the-animation", "nukitashi-the-animation-specials", 174188],
    ["the-idolmster-cinderella-girls-u149", "the-idolmster-cinderella-girls-u149-special", 146975],
    ["inu-ni-nattara-suki-na-hito-ni-hirowareta", "inu-ni-nattara-suki-na-hito-ni-hirowareta-specials", 146346]
  ];
  const items = pairs.flatMap(([a, b, id]) => [
    av1(a, a, { anilistId: id }), av1(b, b, { anilistId: id })
  ]);
  const merged = mergeShows(items);
  check("every colliding pair survives", merged.length, 8);
  check("no slug is lost", pairs.flatMap(([a, b]) => [a, b]).every(
    (slug) => merged.some((s) => s.id === `animeav1-${slug}`)), true);
}

/* ── the legitimate merge must still happen ───────────────────────────────── */
{
  // One AnimeAV1 row plus its AniList/Jikan counterpart is ONE show. Only the
  // AnimeAV1 row has a slug, so nothing here conflicts.
  const merged = mergeShows([
    av1("one-piece", "One Piece", { anilistId: 21, malId: 21 }),
    { id: "anilist-21", title: "One Piece", anilistId: 21, malId: 21, source: "AniList", score: 88 }
  ]);
  check("a source row and its metadata row still merge", merged.length, 1);
  check("and the merged row keeps the playable AnimeAV1 id", merged[0].id, "animeav1-one-piece");
  check("while gaining the metadata", merged[0].score, 88);
}

/* ── genuinely different shows are never merged ───────────────────────────── */
{
  const merged = mergeShows([
    av1("show-a", "Show A", { anilistId: 1 }),
    av1("show-b", "Show B", { anilistId: 2 })
  ]);
  check("different ids stay separate", merged.length, 2);
}

/* ── the same slug twice is still one show ────────────────────────────────── */
{
  const merged = mergeShows([
    av1("dup", "Dup", { anilistId: 5 }),
    av1("dup", "Dup", { anilistId: 5, description: "fuller" })
  ]);
  check("the same slug twice collapses to one", merged.length, 1);
}

/* ── a row with no slug at all behaves as before ──────────────────────────── */
{
  const merged = mergeShows([
    { id: "anilist-100", title: "Meta Only", anilistId: 100 },
    { id: "jikan-100", title: "Meta Only", anilistId: 100, malId: 900 }
  ]);
  check("id-only rows still merge on their ids", merged.length, 1);
}

/* ── coverage floor: the source's slugs outrank the scraper's output ──────────
   Measured 2026-09-07: the original Bleach (366 episodes) and Boruto were both
   served by AnimeAV1 and both absent from anime_metadata.json - only the
   Thousand-Year Blood War arcs had been parsed. A show the source HAS must not
   be unreachable because a parser missed it. */
{
  const cov = vm.createContext({
    Number, String, Array, Math, JSON, Boolean, Object, Set, Map, console,
    ANIMEAV1_BASE: "https://animeav1.com",
    ANIMEAV1_HEADERS: {},
    HOSTED_RUNTIME: false,
    log: () => {},
    getAnimeAv1SlugCatalog: null,
    fetchWithTimeout: async () => ({ ok: false }),
    mapLimit: async (items, _limit, mapper) => Promise.all(items.map(mapper))
  });
  vm.runInContext([
    slice("function animeAv1SlugOf(", "\nfunction catalogIdentitiesAreCompatible("),
    slice("function cleanAnimeAv1Slug(", "\nfunction "),
    slice("function cleanAnimeAv1Title(", "\nfunction "),
    slice("function decodeHtmlEntities(", "\nfunction "),
    slice("function stripTags(", "\nfunction "),
    slice("function slugToTitle(", "\nfunction "),
    slice("async function animeAv1RowsMissingFromScrape(", "\nasync function buildCatalogPayload(")
  ].join("\n"), cov, { filename: "animetv-server.js coverage extract" });
  const missingRows = vm.runInContext("animeAv1RowsMissingFromScrape", cov);
  const setCatalog = (value) => { cov.getAnimeAv1SlugCatalog = value; };

  const scraped = [
    { id: "animeav1-bleach-sennen-kessen-hen", title: "Bleach: Sennen Kessen-hen" },
    { id: "animeav1-one-piece", title: "One Piece" }
  ];
  setCatalog(async () => ({ items: [
    { slug: "one-piece", title: "One Piece" },
    { slug: "bleach-sennen-kessen-hen", title: "Bleach: Sennen Kessen-hen" },
    { slug: "bleach", title: "Bleach" },
    { slug: "boruto-naruto-next-generations", title: "Boruto: Naruto Next Generations" }
  ] }));
  const added = await missingRows(scraped);

  check("only the slugs the scrape lacks are added", added.length, 2);
  check("and they are the ones the source serves",
    added.map((r) => r.id), ["animeav1-bleach", "animeav1-boruto-naruto-next-generations"]);
  check("an added row keeps the slug that makes it playable", added[0].animeAv1Slug, "bleach");
  check("and carries a real title", added[0].title, "Bleach");
  check("a scraped slug is never duplicated",
    added.some((r) => r.id === "animeav1-one-piece"), false);

  // Together with the scrape, nothing the source serves is missing.
  const union = [...scraped, ...added];
  check("the union covers every slug the source has", union.length, 4);
  check("and merging keeps all four", mergeShows(union).length, 4);

  // The catalogue must still be served when the slug catalogue cannot be read.
  setCatalog(async () => { throw new Error("upstream down"); });
  check("an unreachable slug catalogue adds nothing and throws nothing",
    (await missingRows(scraped)).length, 0);

  setCatalog(async () => ({}));
  check("a malformed slug catalogue is handled too", (await missingRows(scraped)).length, 0);
}

console.log(rows.join("\n"));
const failed = rows.filter((r) => r.startsWith("FAIL")).length;
console.log(failed ? `\n${failed} FAILED` : "\nall catalog-merge checks passed");
process.exit(failed ? 1 : 0);
