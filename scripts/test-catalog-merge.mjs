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

console.log(rows.join("\n"));
const failed = rows.filter((r) => r.startsWith("FAIL")).length;
console.log(failed ? `\n${failed} FAILED` : "\nall catalog-merge checks passed");
process.exit(failed ? 1 : 0);
