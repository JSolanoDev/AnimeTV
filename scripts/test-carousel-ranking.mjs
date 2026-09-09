// The hero must show what is CURRENT, not what is popular. These drive the real
// ranking helpers out of js/utils.js.
import {
  currentAnimeSeason,
  isCurrentSeasonShow,
  carouselCurrencyTier,
  carouselCurrencyDistanceMs,
  sortCarouselCurrency,
  sortCarouselQuality
} from "../js/utils.js";
import fs from "node:fs";

const rows = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  rows.push(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`));
};

const NOW = new Date(2026, 4, 15, 12, 0, 0).getTime(); // 15 May 2026, local
const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const cur = currentAnimeSeason(NOW);

/* ---- the fixture from the brief ---- */
const A = { title: "A", status: "RELEASING", score: 70, nextAiringAt: NOW + 2 * HOUR };
const B = { title: "B", status: "RELEASING", score: 70, nextAiringAt: NOW + DAY };
const C = { title: "C", status: "FINISHED", score: 99, season: "SPRING", seasonYear: 2023 };
const D = { title: "D", status: "RELEASING", score: 40, season: cur.season, seasonYear: cur.seasonYear };

const lastAired = (s) => (s.title === "D" ? NOW - 30 * MIN : null);
const order = sortCarouselCurrency([C, B, A, D], NOW, lastAired).map((s) => s.title);
check("D / A / B rank ahead of C", order, ["D", "A", "B", "C"]);
check("the completed hit is last despite the top score", order[order.length - 1], "C");
check("popularity did not lift C", order.indexOf("C") > order.indexOf("D"), true);

/* ---- the old ranking really would have put C first ---- */
{
  const byQuality = sortCarouselQuality([C, B, A, D]).map((s) => s.title);
  check("quality-only ranking puts the 3-year-old hit first", byQuality[0], "C");
}

/* ---- tiers ---- */
check("airing + imminent episode is tier 0", carouselCurrencyTier(A, NOW, null), 0);
check("airing + just-aired episode is tier 0", carouselCurrencyTier(D, NOW, NOW - 30 * MIN), 0);
check("completed is tier 3 regardless of score", carouselCurrencyTier(C, NOW, null), 3);
check("cancelled is tier 3", carouselCurrencyTier({ status: "CANCELLED" }, NOW, null), 3);
check("current-season, no instant, is tier 1",
  carouselCurrencyTier({ status: "RELEASING", season: cur.season, seasonYear: cur.seasonYear }, NOW, null), 1);
check("airing but undated and off-season is tier 2",
  carouselCurrencyTier({ status: "RELEASING", season: "WINTER", seasonYear: 2019 }, NOW, null), 2);
check("a null show is tier 3", carouselCurrencyTier(null, NOW, null), 3);

/* ---- distance metric, both directions ---- */
check("30 minutes since airing", carouselCurrencyDistanceMs(D, NOW, NOW - 30 * MIN), 30 * MIN);
check("2 hours until airing", carouselCurrencyDistanceMs(A, NOW, null), 2 * HOUR);
check("nearer of the two wins", carouselCurrencyDistanceMs(A, NOW, NOW - 10 * MIN), 10 * MIN);
check("no instant at all is infinite", carouselCurrencyDistanceMs({}, NOW, null), null); // JSON turns Infinity into null
check("a future lastAired is ignored", carouselCurrencyDistanceMs({}, NOW, NOW + DAY), null);

/* ---- malformed input must not throw or invent a position ---- */
for (const [label, show] of [
  ["missing nextAiringEpisode", { status: "RELEASING" }],
  ["malformed timestamp", { status: "RELEASING", nextAiringAt: "soon" }],
  ["NaN timestamp", { status: "RELEASING", nextAiringAt: NaN }],
  ["missing artwork/status", {}],
  ["upcoming title", { status: "NOT_YET_RELEASED" }]
]) {
  let threw = false;
  try { carouselCurrencyTier(show, NOW, null); } catch { threw = true; }
  check(`${label} does not throw`, threw, false);
}
check("a malformed timestamp does not become tier 0",
  carouselCurrencyTier({ status: "RELEASING", nextAiringAt: "soon" }, NOW, null) === 0, false);

/* ---- season boundaries ---- */
check("December belongs to next year's winter", currentAnimeSeason(new Date(2026, 11, 20).getTime()), { season: "WINTER", seasonYear: 2027 });
check("January is this year's winter", currentAnimeSeason(new Date(2026, 0, 10).getTime()), { season: "WINTER", seasonYear: 2026 });
check("April is spring", currentAnimeSeason(new Date(2026, 3, 10).getTime()).season, "SPRING");
check("July is summer", currentAnimeSeason(new Date(2026, 6, 10).getTime()).season, "SUMMER");
check("October is fall", currentAnimeSeason(new Date(2026, 9, 10).getTime()).season, "FALL");
check("a current-season show is recognised", isCurrentSeasonShow({ season: cur.season, seasonYear: cur.seasonYear }, NOW), true);
check("an old-season show is not", isCurrentSeasonShow({ season: "SPRING", seasonYear: 2019 }, NOW), false);

/* ---- stability: an empty pool and a single item are safe ---- */
check("empty pool stays empty", sortCarouselCurrency([], NOW, () => null), []);
check("single item survives", sortCarouselCurrency([A], NOW, () => null).map((s) => s.title), ["A"]);

/* ---- production wiring: the Home hero follows provider releases only ---- */
{
  const client = fs.readFileSync("client.js", "utf8");
  const between = (from, to) => client.slice(client.indexOf(from), client.indexOf(to, client.indexOf(from)));
  const recentFallback = between("function recentlyAiredShows(", "function todayShows(");
  const releasePool = between("function recentReleaseCarouselShows(", "// Hero backdrop:");
  const render = between("function renderCarousel()", "let _carouselDotsHtml");
  check("recentlyAiredShows never pads from the whole catalog", /sortCarouselCurrency|result\.push\(\.\.\.pad\)/.test(recentFallback), false);
  check("release carousel is sourced from the AnimeAV1 feed", /buildAnimeAv1ReleaseCards/.test(releasePool), true);
  check("renderCarousel consumes only the release pool", /recentReleaseCarouselShows\(8\)/.test(render), true);
  check("latest feed starts promptly after first paint", /function scheduleAnimeAv1LatestLoad\(delayMs = 450\)/.test(client), true);
  const indicators = between("function renderCarouselIndicators(", "function scheduleCarouselIndicatorHydration(");
  check("slide selection keeps the existing indicator image nodes", /if \(_carouselDotsHtml !== dotsHtml\)/.test(indicators), true);
  check("selection is updated as a class instead of rebuilt into HTML", /classList\.toggle\("is-selected", selected\)/.test(indicators), true);
  check("empty indicator cards stay hidden until thumbnails are ready", /carouselIndicators\.hidden = true/.test(indicators), true);
  check("indicator cards preload stable poster artwork without changing their layout", /carouselIndicatorArtwork\(show\)/.test(indicators), true);
  const hydration = between("function scheduleCarouselIndicatorHydration(", "function simpleCarouselText(");
  check("indicator artwork is preloaded before the selector is revealed", /Promise\.allSettled\([\s\S]*preloadArtworkImage/.test(hydration), true);
  check("the hero never paints its 4K artwork onto the loading layer", /carouselBackdrop\.style\.backgroundImage = `url/.test(render), false);
  check("the high-resolution lookup keeps the clean wait surface visible", /if \(resolving\) \{[\s\S]*carouselStage\.classList\.add\("is-backdrop-loading"\)/.test(render), true);
  check("a failed high-resolution lookup repaints the source-art fallback", /\.then\(repaintResolvedArtwork, repaintResolvedArtwork\)/.test(render), true);
  check("the empty image branch does not dismiss an active artwork lookup", /if \(!resolving\) carouselStage\.classList\.remove\("is-backdrop-loading"\)/.test(render), true);
  check("the carousel warms only its immediate next slide", /state\.carouselIndex \+ 1/.test(render) && !/off <= 3/.test(render), true);
  check("carousel TMDB hydration suppresses unrelated detail renders", /enrichTmdbImages\(next, \{ refresh: false \}\)/.test(render), true);
}

console.log(rows.join("\n"));
const failed = rows.filter((r) => r.startsWith("FAIL")).length;
console.log(failed ? `\n${failed} FAILED` : "\nall carousel-ranking checks passed");
process.exit(failed ? 1 : 0);
