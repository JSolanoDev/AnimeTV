import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { regularArtworkPriority } from "./lib/regular-artwork-priority.mjs";

const require = createRequire(import.meta.url);
const server = require("../animetv-server.js");
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("airing batches use a single Page query rather than costly Media aliases", async () => {
  const code = read("scripts/build-airing-map.mjs");
  const start = code.indexOf("const mediaFields =");
  const end = code.indexOf("/*", code.indexOf("async function fetchBatch", start));
  let request;
  const context = vm.createContext({
    BATCH: 25, ANILIST: "https://graphql.anilist.co", log() {},
    fetch: async (url, options) => {
      request = JSON.parse(options.body);
      return new Response(JSON.stringify({ data: { Page: { media: [{ id: 7 }, { id: 8 }] } } }));
    }
  });
  vm.runInContext(code.slice(start, end), context);
  const media = await vm.runInContext("fetchBatch([7, 8])", context);
  assert.deepEqual(JSON.parse(JSON.stringify(media)), [{ id: 7 }, { id: 8 }]);
  assert.deepEqual(request.variables.ids, [7, 8]);
  assert.match(request.query, /Page\(page: 1, perPage: 25\)/);
  assert.match(request.query, /media\(id_in: \$ids, type: ANIME\)/);
  assert.doesNotMatch(request.query, /m\d+: Media/);
  assert.match(code, /const PAUSE_MS = 2500/);
  assert.match(code, /\[400, 403, 429\]\.includes\(error.status\)/);
  assert.match(request.query, /coverImage \{ extraLarge \}/);
});

test("new season relation artwork stays attached to its exact identity", () => {
  const code = read("scripts/build-airing-map.mjs");
  const start = code.indexOf("function nodeToEntry(");
  const end = code.indexOf("// Adjacency", start);
  const context = vm.createContext({ titleOf: (title) => title.romaji, startMs: () => 0 });
  vm.runInContext(code.slice(start, end), context);
  context.node = { id: 217001, title: { romaji: "New Season" }, format: "TV", status: "NOT_YET_RELEASED",
    coverImage: { extraLarge: "https://images.test/exact-season.jpg" }, bannerImage: "https://images.test/exact-banner.jpg" };
  const season = vm.runInContext("nodeToEntry(node)", context);
  assert.equal(season.anilistId, 217001);
  assert.equal(season.metadataCover, undefined);
  const artwork = vm.runInContext("collectSeasonArtwork([node])", context);
  assert.equal(artwork["anilist-217001"].metadataCover, context.node.coverImage.extraLarge);
  assert.equal(artwork["anilist-217001"].anilistBanner, context.node.bannerImage);
  assert.equal(vm.runInContext("Object.keys(collectSeasonArtwork([node], {'anilist-217001': {metadataCover:'keep.jpg'}})).length", context), 0);
});

test("a season newer than the offline DB is seeded with exact provider artwork and metadata", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zenkai-new-season-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "offline.jsonl");
  const map = join(dir, "artwork.json");
  const airing = join(dir, "airing.json");
  writeFileSync(db, "");
  writeFileSync(map, JSON.stringify({ entries: { "anilist-17": { metadataCover: "keep.jpg", meta: { description: "Keep synopsis" } } } }));
  writeFileSync(airing, JSON.stringify({ seasonArtwork: {
    "anilist-217001": { metadataCover: "https://images.test/exact-season.jpg", anilistBanner: "https://images.test/exact-banner.jpg" }
  }, entries: { sample: { franchiseSeasons: [
    { anilistId: 17, title: "Existing", metadataCover: "replacement.jpg" },
    { anilistId: 217001, title: "New Season", format: "TV", status: "NOT_YET_RELEASED", seasonYear: 2027 }
  ] } } }));
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("./seed-anilist-rows.mjs", import.meta.url)),
    "--db", db, "--airing", airing, "--artwork", map, "--write"], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  const entries = JSON.parse(readFileSync(map)).entries;
  assert.equal(entries["anilist-17"].metadataCover, "keep.jpg");
  assert.equal(entries["anilist-17"].meta.description, "Keep synopsis");
  assert.equal(entries["anilist-217001"].metadataCover, "https://images.test/exact-season.jpg");
  assert.equal(entries["anilist-217001"].meta.romajiTitle, "New Season");
  assert.equal(entries["anilist-217001"].meta.airingStatus, "NOT_YET_RELEASED");
  assert.equal(entries["anilist-217001"].meta.episodes, null);
});

test("latest-feed artwork uses only an exact static identity and does not fetch", () => {
  const map = JSON.parse(read("scraper/artwork-map.json")).entries;
  const [id, art] = Object.entries(map).find(([key, value]) => key.startsWith("animeav1-") && value.tmdbBackdrop);
  const item = { slug: id.slice("animeav1-".length), title: "Exact feed title", episode: 0, image: "feed-still.jpg" };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("No upstream lookup should run"); };
  try {
    const result = server.enrichAnimeAv1LatestArtwork(item);
    assert.equal(result.tmdbBackdrop, art.tmdbBackdrop);
    assert.equal(result.tmdbPoster, art.tmdbPoster || undefined);
    assert.equal(result.title, item.title);
    assert.equal(result.image, item.image);
    assert.equal(result.episode, 0);
    assert.equal(result.meta, undefined);
    assert.equal(result.franchiseSeasons, undefined);
    assert.deepEqual(server.enrichAnimeAv1LatestArtwork({ ...item, slug: "missing-exact-title-fixture" }), {
      ...item, slug: "missing-exact-title-fixture"
    });
  } finally { globalThis.fetch = originalFetch; }
});

test("latest-feed airing metadata is a static lookup scoped to the exact season", () => {
  const art = JSON.parse(read("scraper/artwork-map.json")).entries;
  const airing = JSON.parse(read("scraper/airing-map.json")).entries;
  const [id, schedule] = Object.entries(airing).find(([key, value]) => art[key]?.anilistId
    && Number(art[key].anilistId) === Number(value.anilistId) && Number(value.nextAiringAt) > 0);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("No new schedule API request should run"); };
  try {
    const result = server.enrichAnimeAv1LatestArtwork({ slug: id.slice("animeav1-".length), episode: 2 });
    assert.equal(result.nextAiringAt, schedule.nextAiringAt);
    assert.equal(result.nextAiringEpisodeNumber, schedule.nextAiringEpisodeNumber);
    assert.equal(result.episode, 2);
    assert.equal(result.franchiseSeasons, undefined);
    assert.equal(server.enrichAnimeAv1LatestArtwork({ slug: "missing-exact-season" }).nextAiringAt, undefined);
  } finally { globalThis.fetch = originalFetch; }
});

test("a brand-new latest-feed title receives its completed provider slot with no HTTP lookup", () => {
  const code = read("animetv-server.js");
  const at = Date.parse("2026-10-05T13:00:00Z");
  let requests = 0;
  const animeYTProvider = require("../lib/animeyt-provider.cjs").createProvider({
    snapshot: { items: [{ slug: "neutral-release", title: "Neutral Release", season: 1 }],
      schedule: [{ slug: "neutral-release", episode: 2, at }] },
    now: () => at + 3600000,
    fetchImpl: () => { requests++; throw new Error("No schedule lookup required"); }
  });
  const context = vm.createContext({ animeYTProvider, enrichLatestCatalogItemFromArtwork: () => ({}) });
  vm.runInContext(code.slice(code.indexOf("function enrichAnimeAv1LatestArtwork("),
    code.indexOf("module.exports.enrichAnimeAv1LatestArtwork")), context);
  const result = context.enrichAnimeAv1LatestArtwork({ slug: "neutral-release", title: "Neutral Release", episode: 2 });
  assert.equal(result.animeytScheduleAt, at);
  assert.equal(result.animeytSlug, "neutral-release");
  assert.equal(result.episode, 2);
  assert.equal(result.nextAiringAt, undefined);
  assert.equal(requests, 0);
});

test("batched metadata records confirmed schedules without changing episodes or season chains", () => {
  const code = read("scripts/add-artwork-metadata.mjs");
  const start = code.indexOf("function recordAiringMetadata(");
  const end = code.indexOf("// \u2500", start);
  const context = vm.createContext({});
  vm.runInContext(code.slice(start, end), context);
  const previous = { anilistId: 123, sourceEpisodeCount: 2, airingStatus: "RELEASING",
    nextAiringAt: 1791124200000, nextAiringEpisodeNumber: 2, franchiseSeasons: [{ anilistId: 123 }],
    lastEpisodeAt: "2026-10-04T14:30:00Z" };
  const entries = { exact: previous };
  context.recordAiringMetadata(entries, "exact", { id: 123, nextAiringEpisode: { airingAt: 1791729000, episode: 3 } });
  assert.equal(entries.exact.nextAiringAt, 1791729000000);
  assert.equal(entries.exact.nextAiringEpisodeNumber, 3);
  assert.equal(entries.exact.sourceEpisodeCount, 2);
  assert.equal(entries.exact.franchiseSeasons, previous.franchiseSeasons);
  assert.equal(entries.exact.lastEpisodeAt, previous.lastEpisodeAt);
  const confirmed = entries.exact;
  for (const nextAiringEpisode of [null, { airingAt: "bad", episode: 3 }, { airingAt: Infinity, episode: 3 }]) {
    context.recordAiringMetadata(entries, "exact", { id: 123, nextAiringEpisode });
    assert.equal(entries.exact, confirmed);
  }
  context.recordAiringMetadata(entries, "exact", { id: 456, nextAiringEpisode: { airingAt: 1791730800, episode: 1 } });
  assert.equal(entries.exact, confirmed);
  context.recordAiringMetadata(entries, "unknown", { id: 789, nextAiringEpisode: null });
  assert.equal(entries.unknown, undefined);
  assert.match(code, /nextAiringEpisode \{ airingAt episode \}/);
  assert.match(code, /REFRESH_AIRING && !ONLY_IDS\.size/);
});

test("a new-title client row reuses the latest feed's baked artwork and description", () => {
  const code = read("client.js");
  const start = code.indexOf("function makeAv1OnlyShow(");
  const end = code.indexOf("function registerAv1Show", start);
  const context = vm.createContext({
    animeAv1LatestEpisodeIdentity: () => ({ providerEpisodeId: 2, displayEpisode: 2 }),
    animeAv1ArtworkVariant: (_url, mode) => `source-${mode}`
  });
  vm.runInContext(code.slice(start, end), context);
  const item = { slug: "new-season", title: "New Season", image: "still.jpg",
    tmdbBackdrop: "wide.jpg", tmdbPoster: "poster.jpg", description: "Complete synopsis",
    anilistId: 123, malId: 456, genres: ["Adventure"] };
  context.item = item;
  const row = vm.runInContext("makeAv1OnlyShow(item)", context);
  assert.equal(row.image, item.tmdbPoster);
  assert.equal(row.tmdbBackdrop, item.tmdbBackdrop);
  assert.equal(row.description, item.description);
  assert.equal(row.anilistId, 123);
  assert.equal(row.sourceInventoryPartial, true);
  assert.deepEqual(JSON.parse(JSON.stringify(row.sourceEpisodeIds)), [2]);
});

test("new-title cards display confirmed local weekday and AM/PM, never the upload clock", () => {
  const code = read("client.js");
  const utils = read("js/utils.js");
  const context = vm.createContext({
    Date: class extends Date { static now() { return Date.UTC(2026, 9, 5, 12); } },
    animeAv1LatestEpisodeIdentity: () => ({ providerEpisodeId: 2, displayEpisode: 2 }),
    animeAv1ArtworkVariant: () => "",
    nextWeeklyAiringFrom: () => { throw new Error("Must not guess from provider upload time"); }
  });
  vm.runInContext(utils.slice(utils.indexOf("function formatAiringClock"),
    utils.indexOf("// Node export so the logic")), context);
  vm.runInContext(code.slice(code.indexOf("function applyScheduleAiringFields("),
    code.indexOf("function scheduleLocale(")), context);
  vm.runInContext(code.slice(code.indexOf("function makeAv1OnlyShow("),
    code.indexOf("function registerAv1Show")), context);
  const date = new context.Date(2026, 9, 11, 8, 30);
  const item = { slug: "new-season", title: "New Season", nextAiringAt: date.getTime(),
    nextAiringEpisodeNumber: 3, releasedAt: "2026-10-04T23:30:00Z" };
  const show = context.makeAv1OnlyShow(item);
  assert.equal(show.nextAiringAt, date.getTime());
  assert.equal(show.day, context.formatAiringWeekday(date));
  assert.equal(show.time, context.formatAiringClock(date));
  assert.equal(show.nextAiringEpisodeNumber, 3);
  assert.equal(show.lastEpisodeAt, item.releasedAt);
  assert.equal(context.makeAv1OnlyShow({ ...item, nextAiringAt: null }).nextAiringAt, undefined);
});

test("a latest-only client card retains today's completed provider slot", () => {
  const code = read("client.js");
  const utils = read("js/utils.js");
  const context = vm.createContext({
    Date: class extends Date { static now() { return Date.UTC(2026, 9, 5, 20); } },
    Intl: { DateTimeFormat: function (_locale, options) {
      return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "America/Denver" });
    } },
    animeAv1LatestEpisodeIdentity: () => ({ providerEpisodeId: 2, displayEpisode: 2 }),
    animeAv1ArtworkVariant: () => ""
  });
  vm.runInContext(utils.slice(utils.indexOf("function formatAiringClock"),
    utils.indexOf("// Node export so the logic")), context);
  vm.runInContext(code.slice(code.indexOf("function applyScheduleAiringFields("),
    code.indexOf("function scheduleLocale(")), context);
  vm.runInContext(code.slice(code.indexOf("function makeAv1OnlyShow("),
    code.indexOf("function registerAv1Show")), context);
  const at = Date.UTC(2026, 9, 5, 13);
  const show = context.makeAv1OnlyShow({ slug: "neutral-release", title: "Neutral Release", animeytScheduleAt: at });
  assert.equal(show.day, "Mon");
  assert.equal(show.time, "7:00 AM");
  assert.equal(show.animeytScheduleAt, at);
  assert.equal(show.nextAiringAt, undefined);
  assert.equal(show.nextAiringEpisodeNumber, 3);
});

test("new-title schedule day and time move together across viewer timezones", () => {
  const code = read("client.js");
  const utils = read("js/utils.js");
  for (const [timeZone, day, time] of [
    ["America/Denver", "Sat", "6:30 PM"], ["Asia/Tokyo", "Sun", "9:30 AM"]
  ]) {
    const context = vm.createContext({
      Date: class extends Date { static now() { return Date.UTC(2026, 9, 5, 12); } },
      Intl: { DateTimeFormat: function (_locale, options) {
        return new Intl.DateTimeFormat("en-US", { ...options, timeZone });
      } },
      animeAv1LatestEpisodeIdentity: () => ({ providerEpisodeId: 1, displayEpisode: 1 }),
      animeAv1ArtworkVariant: () => ""
    });
    vm.runInContext(utils.slice(utils.indexOf("function formatAiringClock"),
      utils.indexOf("// Node export so the logic")), context);
    vm.runInContext(code.slice(code.indexOf("function applyScheduleAiringFields("),
      code.indexOf("function scheduleLocale(")), context);
    vm.runInContext(code.slice(code.indexOf("function makeAv1OnlyShow("),
      code.indexOf("function registerAv1Show")), context);
    const row = context.makeAv1OnlyShow({ slug: "new-season", title: "New Season",
      nextAiringAt: Date.UTC(2026, 9, 11, 0, 30) });
    assert.equal(row.day, day);
    assert.equal(row.time.replace(/\s/g, " "), time);
  }
});

test("offline-only metadata is topped up without discarding saved data", () => {
  const code = read("scripts/add-artwork-metadata.mjs");
  assert.match(code, /e\.meta\?\.description && e\.meta\?\.genres\?\.length && !FORCE/);
  assert.match(code, /entries\[key\]\.meta = \{ \.\.\.saved/);
  assert.match(code, /entries\[key\]\.meta \|\|= null/);
  const art = read("scripts/build-artwork-map.mjs");
  assert.match(art, /regularArtworkPriority\(item, map, publishedIds\)/);
  const entries = { fresh: { status: "offline-db" }, older: { status: "rejected" } };
  const published = new Set(["older"]);
  assert.ok(regularArtworkPriority({ id: "fresh" }, entries, published)
    > regularArtworkPriority({ id: "older" }, entries, published));
});
