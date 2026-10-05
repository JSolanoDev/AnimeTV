// Regression test for the cached-show crash:
//
//   anime._seasonStillsTried = new Set()   ->  JSON round trip  ->  {}
//   anime._seasonStillsTried.has(sNum)     ->  TypeError, episode panel dies
//
// Loads the REAL js/image-resolver.js in a VM so the assertions track the
// shipped module rather than a restatement of it.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";

const ROOT = process.argv[2] || ".";
const src = fs.readFileSync(ROOT + "/js/image-resolver.js", "utf8");
const clientSrc = fs.readFileSync(ROOT + "/client.js", "utf8");
const utilsSrc = fs.readFileSync(ROOT + "/js/utils.js", "utf8");
const metadataFetchSrc = utilsSrc.slice(utilsSrc.indexOf("const metadataJsonCache ="), utilsSrc.indexOf("async function fetchWithRetry("));
const require = createRequire(import.meta.url);
const server = require(path.resolve(ROOT, "animetv-server.js"));

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
  fetchWithTimeout: (...args) => ctx.fetch(...args),
  location: { origin: "https://app.test", href: "https://app.test/" },
  setTimeout, clearTimeout, Promise, Date, Math, JSON, URL
};
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(metadataFetchSrc, ctx);
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

// A detail page can render with one episode before the source inventory arrives.
// Once the list grows, the first season-art lookup must not freeze that one
// thumbnail in memory or in localStorage for the rest of the day.
{
  const episodes = Array.from({ length: 26 }, (_, index) => ({
    episode_number: index + 1,
    name: `Episode ${index + 1} title`,
    overview: "",
    air_date: "2026-07-03",
    still_path: index < 12 ? `/heavy-knight-${index + 1}.jpg` : null
  }));
  let fetches = 0;
  ctx.fetch = async () => {
    fetches += 1;
    return { ok: true, json: async () => ({ season: { poster_path: null, episodes } }) };
  };
  const makeAnime = () => ({
    id: "heavy-knight-art-coverage",
    anilistId: 180136,
    tmdbId: 270603,
    year: 2026,
    totalEpisodes: 1,
    tmdbSeasons: [{ season_number: 1, episode_count: 26, name: "Season 1", air_date: "2026-07-03" }]
  });
  const anime = makeAnime();
  await ensure(anime, 1, { season: 1, year: 2026, episodeCount: 1 });
  check("early season lookup has one still", Object.keys(anime.tmdbStillsBySeason[1]).length, 1);

  anime.sourceEpisodeCount = 12;
  anime.sourceEpisodeIds = Array.from({ length: 12 }, (_, index) => index + 1);
  await ensure(anime, 1, { season: 1, year: 2026, episodes: anime.sourceEpisodeIds });
  check("grown episode list refetches season art", fetches, 2);
  check("grown episode list gets episode 12 still", Boolean(anime.tmdbStillsBySeason[1][12]), true);
  check("grown episode list gets episode 12 title", anime.tmdbEpisodesBySeasonNum[1][12]?.title, "Episode 12 title");

  const restored = makeAnime();
  restored.sourceEpisodeCount = 12;
  restored.sourceEpisodeIds = anime.sourceEpisodeIds;
  await ensure(restored, 1, { season: 1, year: 2026, episodes: anime.sourceEpisodeIds });
  check("refreshed season art is reused from cache", fetches, 2);
  check("cached episode 12 still survives reload", Boolean(restored.tmdbStillsBySeason[1][12]), true);
}

// Legacy cache rows can contain metadata for every scheduled episode but only
// one downloaded still. They need one refresh, then must not refetch on every
// visit if TMDB genuinely has no more artwork yet.
{
  const anime = {
    id: "legacy-partial-art",
    anilistId: 180137,
    tmdbId: 270603,
    year: 2026,
    sourceEpisodeCount: 12,
    tmdbSeasons: [{ season_number: 1, episode_count: 26, name: "Season 1", air_date: "2026-07-03" }]
  };
  const cacheKey = "zenkaitv:tmdb-season-art:v8:180137:s1";
  store.set(cacheKey, JSON.stringify({ savedAt: Date.now(), data: {
    anilistId: "180137", tmdbId: "270603", appSeasonNumber: 1, tmdbSeasonNumber: 1,
    stills: { 1: "https://example.test/one.jpg" },
    metas: Object.fromEntries(Array.from({ length: 26 }, (_, index) => [index + 1, { title: `Episode ${index + 1}` }]))
  } }));
  let fetches = 0;
  ctx.fetch = async () => {
    fetches += 1;
    return { ok: true, json: async () => ({ season: { episodes: Array.from({ length: 26 }, (_, index) => ({
      episode_number: index + 1, name: `Episode ${index + 1}`,
      air_date: "2026-07-03", still_path: index < 12 ? `/fresh-${index + 1}.jpg` : null
    })) } }) };
  };
  await ensure(anime, 1, { season: 1, year: 2026, episodeCount: 12 });
  check("legacy cache with one still is refreshed", fetches, 1);
  check("legacy cache refresh fills episode 12", Boolean(anime.tmdbStillsBySeason[1][12]), true);
  await ensure(anime, 1, { season: 1, year: 2026, episodeCount: 12 });
  check("complete season art does not refetch", fetches, 1);
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

{
  const continuous = {
    title: "Naruto",
    isFranchiseEntry: true,
    totalEpisodes: 220,
    seasons: [{ season: 1, episodes: Array.from({ length: 220 }, (_, index) => ({ episode: index + 1 })) }],
    tmdbSeasons: [
      { season_number: 1, episode_count: 52 },
      { season_number: 2, episode_count: 52 },
      { season_number: 3, episode_count: 54 },
      { season_number: 4, episode_count: 62 }
    ],
    tmdbStillsBySeason: { 1: { 1: "https://example.test/local-1.jpg" } },
    tmdbEpisodesBySeasonNum: { 1: { 1: { episode: 1, title: "Local One" } } },
    tmdbEpisodeStills: { 101: "https://example.test/global-101.jpg" },
    tmdbEpisodesByNum: { 101: { episode: 101, title: "Global One Hundred One" } }
  };
  check("a continuous long-series entry is detected", ImageResolver.usesContinuousGlobalEpisodeMap(continuous), true);
  check("continuous Naruto stills continue past physical TMDB Season 1", ImageResolver.getEpisodeStill(continuous, { episode: 101 }, 1), "https://example.test/global-101.jpg");
  check("continuous Naruto titles continue past physical TMDB Season 1", ImageResolver.getSeasonEpisodeMeta(continuous, 1, 101)?.title, "Global One Hundred One");
}

{
  const requests = [];
  const anime = { id: "long-series-cache-test", anilistId: 987654321, tmdbId: 123456789, title: "Long Series Fixture", totalEpisodes: 120, format: "TV" };
  const fetchLongSeason = async (url) => {
    const path = String(url);
    requests.push(path);
    if (path.includes("/api/tmdb/tv?")) return { ok: true, json: async () => ({ show: {
      id: 123456789, poster_path: "/poster.jpg", backdrop_path: "/backdrop.jpg", number_of_episodes: 120,
      seasons: [1, 2, 3].map((number) => ({ season_number: number, episode_count: 40, name: `Season ${number}` }))
    } }) };
    const number = Number(new URL(path, "http://localhost").searchParams.get("season"));
    return { ok: true, json: async () => ({ season: { episodes: Array.from({ length: 40 }, (_, index) => ({
      episode_number: index + 1, name: `S${number} E${index + 1}`, overview: "", air_date: "2026-01-01", still_path: `/s${number}-e${index + 1}.jpg`
    })) } }) };
  };
  const longStore = new Map();
  const longCtx = {
    console: { debug() {}, log() {}, warn() {}, error() {} },
    localStorage: {
      getItem: (key) => longStore.get(key) || null,
      setItem: (key, value) => longStore.set(key, String(value)),
      removeItem: (key) => longStore.delete(key)
    },
    fetch: fetchLongSeason, fetchWithTimeout: fetchLongSeason,
    location: { origin: "https://app.test", href: "https://app.test/" },
    setTimeout, clearTimeout, Promise, Date, Math, JSON, URL
  };
  longCtx.window = longCtx;
  longCtx.globalThis = longCtx;
  vm.createContext(longCtx);
  vm.runInContext(metadataFetchSrc, longCtx);
  vm.runInContext(src, longCtx);
  await vm.runInContext("ImageResolver", longCtx).hydrateTmdbImages(anime);
  check("long series fetches each TMDB season only once", requests.filter((url) => url.includes("/api/tmdb/season?")).length, 3);
  check("long series keeps global episode titles", anime.tmdbEpisodesByNum?.[41]?.title, "S2 E1");
}

{
  const artwork = JSON.parse(fs.readFileSync(ROOT + "/scraper/artwork-map.json", "utf8")).entries;
  const tempal = artwork["animeav1-tempal-item-no-chikara"] || {};
  check("Tempal keeps the exact AniList identity", tempal.anilistId, 212888);
  check("Tempal keeps the exact TMDB identity", tempal.tmdbId, 324502);
  check("Tempal ships a high-resolution TMDB backdrop", /745xqHbiUWwO51TM60MXRCR4Onm/.test(tempal.tmdbBackdrop || ""), true);

  const kantei = artwork["animeav1-tensei-kizoku-kantei-skill-de-nariagaru-3rd-season"] || {};
  check("Kantei Skill Season 3 keeps the exact AniList identity", kantei.anilistId, 185756);
  check("Kantei Skill Season 3 keeps the franchise TMDB identity", kantei.tmdbId, 237150);
  check("Kantei Skill Season 3 maps local episode 1 to absolute episode 25", kantei.providerEpisodeOffset, 24);

  const narumi = artwork["animeav1-kaijuu-8-gou-narumi-no-heijitsu"] || {};
  check("Narumi shorts ship the verified 4K franchise backdrop", /htGeuCcNhlBe8GTx3izKOsd8frw/.test(narumi.tmdbBackdrop || ""), true);
  check("Narumi shorts do not inherit parent-series TMDB episodes", narumi.tmdbId ?? null, null);
  check("Narumi shorts ship an exact landscape episode fallback", /1371\/154494l\.jpg/.test(narumi.episodeThumbnailFallback || ""), true);
  check("standalone episode thumbnails consume the exact fallback", clientSrc.includes("show.episodeThumbnailFallback"), true);
  check("standalone episode fallbacks win before unrelated resolver artwork", /if \(exactEpisodeFallback && isStandaloneRelease\) \{\s*return capturedFrame \|\| ownImage \|\| exactEpisodeFallback;/.test(clientSrc), true);
  check("standalone releases may display their high-resolution landscape fallback", /const isFallback = !isAdultShow && !isStandaloneShow && epImgSrc/.test(clientSrc), true);

  const latestOnly = server.applyAnimeAv1LatestInventory([], [
    { slug: "tempal-item-no-chikara", title: "Tempal: Item no Chikara", episode: 1, image: "https://cdn.animeav1.com/thumbnails/4439.jpg" },
    { slug: "tensei-kizoku-kantei-skill-de-nariagaru-3rd-season", title: "Tensei Kizoku, Kantei Skill de Nariagaru 3rd Season", episode: 1, image: "https://cdn.animeav1.com/thumbnails/4440.jpg" },
    { slug: "kaijuu-8-gou-narumi-no-heijitsu", title: "Kaijuu 8-gou: Narumi no Heijitsu", episode: 4, image: "https://cdn.animeav1.com/thumbnails/4437.jpg" }
  ], "2026-09-28T00:00:00.000Z");
  const latestTempal = latestOnly.find((item) => item.id === "animeav1-tempal-item-no-chikara") || {};
  const latestKantei = latestOnly.find((item) => item.id === "animeav1-tensei-kizoku-kantei-skill-de-nariagaru-3rd-season") || {};
  const latestNarumi = latestOnly.find((item) => item.id === "animeav1-kaijuu-8-gou-narumi-no-heijitsu") || {};
  check("latest-only Tempal receives its bundled TMDB background", latestTempal.tmdbId, 324502);
  check("latest-only Tempal receives its full metadata", latestTempal.englishTitle, "Overgeared");
  check("latest-only Kantei receives its bundled TMDB background", latestKantei.tmdbId, 237150);
  check("latest-only Kantei preserves the episode offset", latestKantei.providerEpisodeOffset, 24);
  check("latest-only Narumi receives its bundled background", /htGeuCcNhlBe8GTx3izKOsd8frw/.test(latestNarumi.tmdbBackdrop || ""), true);
  check("latest-only Narumi receives its episode thumbnail fallback", /1371\/154494l\.jpg/.test(latestNarumi.episodeThumbnailFallback || ""), true);
}

{
  const before = Date.now();
  const [latest] = server.parseAnimeAv1Latest(`
    <article>
      <img src="https://cdn.animeav1.com/thumbnails/4437.jpg" />
      <span>hace 2 días</span>
      <span>Episodio <span>4</span></span>
      <a href="/media/kaijuu-8-gou-narumi-no-heijitsu/4">
        <span class="sr-only">Ver Kaijuu 8-gou: Narumi no Heijitsu 4</span>
      </a>
    </article>
  `);
  const age = before - Date.parse(latest?.releasedAt || "");
  check("latest parser keeps the Narumi release", latest?.slug, "kaijuu-8-gou-narumi-no-heijitsu");
  check("latest parser keeps episode 4", latest?.episode, 4);
  check("latest parser converts provider relative age", age >= 47 * 60 * 60 * 1000 && age <= 49 * 60 * 60 * 1000, true);
}

{
  const art = JSON.parse(fs.readFileSync(ROOT + "/scraper/artwork-map.json", "utf8"))
    .entries["animeav1-dotto-koni-chan"];
  const catalog = JSON.parse(fs.readFileSync(ROOT + "/scraper/anime_metadata.json", "utf8"))
    .items.find((item) => item.id === "animeav1-dotto-koni-chan");
  check("Koni artwork retains its exact series identity", art.tmdbId, 44440);
  check("Koni uses the cleaner original poster", art.tmdbPoster.endsWith("/3INoBmgKVIhs3VJ0zCPd7WOrk1Q.jpg"), true);
  check("Koni episode fallback is the native landscape, not a cropped poster", art.episodeThumbnailFallback, art.tmdbBackdrop);
  check("Koni retains all 26 provider episode IDs", catalog.sourceEpisodeIds, Array.from({ length: 26 }, (_, i) => i + 1));

  let genuineStill = "";
  const thumbCtx = {
    getCapturedEpisodeFrame: () => "",
    hqImage: (url) => url,
    comparableImageUrl: (url) => url || "",
    getWatchPosterArtwork: () => art.tmdbPoster,
    getWatchBackdropArtwork: () => art.tmdbBackdrop,
    isAdultImageUrl: () => false,
    curatedDottoKoniArtwork: () => null,
    ImageResolver: {
      getEpisodeStill: () => genuineStill,
      getNearestEpisodeStill: () => "",
      lazyFetchEpisodeStill() {},
      resolveEpisodeThumbnail: (episode, _show, data) => data.episodeStill || episode.image || ""
    }
  };
  vm.createContext(thumbCtx);
  vm.runInContext(clientSrc.slice(clientSrc.indexOf("function episodeThumb("), clientSrc.indexOf("function buildSeasonNav(")), thumbCtx);
  const show = { ...art, format: "TV", image: art.tmdbPoster };
  const season = { season: 1 };
  check("missing TV still uses the curated landscape fallback", thumbCtx.episodeThumb({ episode: 1 }, season, show), art.tmdbBackdrop);
  check("a repeated poster cannot win over the landscape fallback", thumbCtx.episodeThumb({ episode: 2, image: art.tmdbPoster }, season, show), art.tmdbBackdrop);
  genuineStill = "https://example.test/episode-1.jpg";
  check("new genuine episode stills win over the TV fallback", thumbCtx.episodeThumb({ episode: 1 }, season, show), genuineStill);
  genuineStill = "";
  check("a captured episode frame wins over generic artwork", thumbCtx.episodeThumb({ episode: 1, _capturedFrame: "frame:test" }, season, show), "frame:test");
  check("standalone shorts keep their isolated artwork behavior", thumbCtx.episodeThumb({ episode: 1 }, season, { ...show, format: "SPECIAL" }), art.episodeThumbnailFallback);
  check("adult thumbnails never inherit this regular fallback", thumbCtx.episodeThumb({ episode: 1 }, season, { ...show, adultSource: "NeutralFixture" }), art.tmdbPoster);

  const curatedCtx = { isAdultCatalogShow: (row) => Boolean(row.adultSource || row.isAdult) };
  vm.createContext(curatedCtx);
  vm.runInContext(clientSrc.slice(clientSrc.indexOf("const DOTTO_KONI_ARTWORK ="), clientSrc.indexOf("function curatedWatchBackdrop(")), curatedCtx);
  const stale = { id: "source-animetv-api-animeav1-dotto-koni-chan", tmdbPoster: "old:poster" };
  check("old cached source rows receive the poster repair without a refetch", curatedCtx.curatedDottoKoniArtwork(stale)?.poster, art.tmdbPoster);
  check("identity-only rows receive the same artwork", curatedCtx.curatedDottoKoniArtwork({ anilistId: 1684 })?.backdrop, art.tmdbBackdrop);
  check("a similarly named unrelated title is never remapped", curatedCtx.curatedDottoKoniArtwork({ id: "animeav1-other-koni-chan" }), null);
  check("adult identities cannot use the curated regular artwork", curatedCtx.curatedDottoKoniArtwork({ ...stale, adultSource: "NeutralFixture" }), null);
  thumbCtx.curatedDottoKoniArtwork = curatedCtx.curatedDottoKoniArtwork;
  check("cached episode rows receive the landscape repair without catalog refresh", thumbCtx.episodeThumb({ episode: 1 }, season, stale), art.tmdbBackdrop);

  const titleCtx = { state: { uiPreferences: { titleLanguage: "romaji" } } };
  vm.createContext(titleCtx);
  vm.runInContext(utilsSrc.slice(utilsSrc.indexOf("function getShowTitle("), utilsSrc.indexOf("function saveAniPubFallbackCache(")), titleCtx);
  const titleRow = { title: "Dotto Koni-chan", romajiTitle: "Dotto KONI-chan" };
  check("Koni spelling is stable after AniList title hydration", titleCtx.getShowTitle(titleRow), "Dotto! Koni-chan");
  titleCtx.state.uiPreferences.titleLanguage = "english";
  check("Koni spelling is stable in English title mode", titleCtx.getShowTitle(titleRow), "Dotto! Koni-chan");
  check("display-name formatting does not rename provider identities", titleRow.title, "Dotto Koni-chan");
  check("other anime display names are unchanged", titleCtx.getShowTitle({ title: "Other Series" }), "Other Series");

  let transcodes = 0;
  const deliveryCtx = {
    HELL_MODE_WATCH_BACKDROP: "https://example.test/hell-mode.jpg",
    CINEMATIC_BACKDROP_WIDTH: 2560,
    CINEMATIC_BACKDROP_QUALITY: 92,
    cinematicArtworkSourceUrl: (url) => url.replace("/w780/", "/original/"),
    imageDeliveryUrl: (url) => { transcodes++; return `proxy:${url}`; }
  };
  vm.createContext(deliveryCtx);
  vm.runInContext(clientSrc.slice(clientSrc.indexOf("function cinematicBackdropUrl("), clientSrc.indexOf("function imageDeliverySrcSet(")), deliveryCtx);
  check("Koni backdrop is delivered directly at native resolution", deliveryCtx.cinematicBackdropUrl(art.tmdbBackdrop), art.tmdbBackdrop);
  check("a resized Koni URL resolves to the same native cache key", deliveryCtx.cinematicBackdropUrl(art.tmdbBackdrop.replace("/original/", "/w780/")), art.tmdbBackdrop);
  check("Koni backdrop does not invoke the image function", transcodes, 0);
  check("other backdrops retain the existing delivery path", deliveryCtx.cinematicBackdropUrl("https://example.test/other.jpg"), "proxy:https://example.test/other.jpg");
}

// The detail view can render before TMDB's season response returns. The season
// warmer must repaint once that response adds episode stills; otherwise users
// see generated placeholders until they hover, switch tabs, or reload.
{
  const start = clientSrc.indexOf("function seasonEpisodeArtworkSignature(");
  const end = clientSrc.indexOf("function warmRelatedSeasonShow(", start);
  const schedulerSrc = clientSrc.slice(start, end);
  let renders = 0;
  const show = {
    id: "animeav1-sakurada-reset",
    tmdbId: 71014,
    seasons: [{ season: 1, episodes: Array.from({ length: 24 }, (_, index) => ({ episode: index + 1 })) }]
  };
  const schedulerCtx = {
    console,
    JSON,
    Object,
    Promise,
    state: { activeShow: show, activeSeasonIndex: 0 },
    overlay: { hidden: false },
    episodeList: { querySelector: () => null },
    getDetailSeasons: (anime) => anime.seasons,
    warmSeasonArtwork: async (anime, _index, options) => {
      anime.tmdbStillsBySeason = { 1: { 1: "https://image.tmdb.org/t/p/original/sakurada-1.jpg" } };
      anime.tmdbEpisodesBySeasonNum = { 1: { 1: { title: "Memory in Children 1/3" } } };
      options.onSeasonReady?.();
      return anime;
    },
    renderEpisodeList: (_anime, options) => {
      renders += 1;
      check("season-art repaint disables duplicate metadata hydration", options.hydrateExtras, false);
    },
    window: { setTimeout }
  };
  vm.createContext(schedulerCtx);
  vm.runInContext(schedulerSrc, schedulerCtx, { filename: "client-season-artwork-scheduler.js" });
  await vm.runInContext("scheduleSeasonArtworkWarm(state.activeShow, 0, state.activeShow.seasons)", schedulerCtx);
  check("active episode list repaints when season stills arrive", renders, 1);

  renders = 0;
  const unchanged = {
    id: "already-loaded",
    tmdbId: 71014,
    seasons: show.seasons,
    tmdbStillsBySeason: show.tmdbStillsBySeason,
    tmdbEpisodesBySeasonNum: show.tmdbEpisodesBySeasonNum
  };
  schedulerCtx.state.activeShow = unchanged;
  schedulerCtx.warmSeasonArtwork = async (anime, _index, options) => {
    options.onSeasonReady?.();
    return anime;
  };
  schedulerCtx.scheduleSeasonArtworkWarm = vm.runInContext("scheduleSeasonArtworkWarm", schedulerCtx);
  await schedulerCtx.scheduleSeasonArtworkWarm(unchanged, 0, unchanged.seasons);
  check("already-rendered season artwork does not repaint again", renders, 0);
}

console.log(rows.join("\n"));
const failed = rows.filter((r) => r.startsWith("FAIL")).length;
console.log(failed ? `\n${failed} FAILED` : "\nall season-stills checks passed");
process.exit(failed ? 1 : 0);
