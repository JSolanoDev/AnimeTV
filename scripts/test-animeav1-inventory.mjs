import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import {
  animeAv1Slug,
  applyAnimeAv1EpisodeInventory,
  expandAnimeAv1PaginatedInventory,
  excludeUnavailableEpisodeIds,
  markAnimeAv1InventoryUnavailable,
  parseAnimeAv1DirectMediaUrls,
  parseAnimeAv1EpisodeInventory,
  parseAnimeAv1PageMetadata,
  preserveVerifiedEpisodeRange
} from "./build-animeav1-inventory.mjs";

const require = createRequire(import.meta.url);
const {
  animeAv1CachedSourceStatus,
  shouldCacheAnimeAv1SourceStatus
} = require("../animetv-server.js");

test("movie episode zero maps to one playable catalog item", () => {
  const parsed = parseAnimeAv1EpisodeInventory(
    'episodesCount:1,episodes:[{id:10,number:0}] <a href="/media/example-movie/0">Play</a>',
    "example-movie"
  );
  assert.deepEqual(parsed.sourceEpisodeIds, [0]);
  assert.equal(parsed.sourceEpisodeCount, 1);
  assert.equal(parsed.sourcePlayableEpisodeCount, 1);
});

test("episode zero is retained beside a contiguous television run", () => {
  const html = 'episodesCount:3 <a href="/media/example/0"></a><a href="/media/example/1"></a>'
    + '<a href="/media/example/2"></a><a href="/media/example/3"></a>';
  const parsed = parseAnimeAv1EpisodeInventory(html, "example");
  assert.deepEqual(parsed.sourceEpisodeIds, [0, 1, 2, 3]);
  assert.equal(parsed.sourceEpisodeCount, 3);
  assert.equal(parsed.sourcePlayableEpisodeCount, 4);
});

test("a confirmed dead episode zero is excluded without shrinking the TV run", () => {
  const parsed = parseAnimeAv1EpisodeInventory(
    'episodesCount:3 <a href="/media/example/0"></a><a href="/media/example/1"></a>'
      + '<a href="/media/example/2"></a><a href="/media/example/3"></a>',
    "example"
  );
  const filtered = excludeUnavailableEpisodeIds(parsed, [0]);
  assert.deepEqual(filtered.sourceEpisodeIds, [1, 2, 3]);
  assert.deepEqual(filtered.sourceUnavailableEpisodeIds, [0]);
  assert.equal(filtered.sourceEpisodeCount, 3);
  assert.equal(filtered.sourcePlayableEpisodeCount, 3);
});

test("AnimeAV1 player links normalize to directly probeable HLS URLs", () => {
  const html = 'embeds:{SUB:[{server:"HLS",url:"https://player.zilla-networks.com/play/0123456789abcdef0123456789abcdef"},'
    + '{server:"Voe",url:"https://voe.sx/e/example"}]},downloads:{}';
  assert.deepEqual(parseAnimeAv1DirectMediaUrls(html), [
    "https://player.zilla-networks.com/m3u8/0123456789abcdef0123456789abcdef"
  ]);
});

test("exact slug routes cannot absorb episode links from a related title", () => {
  const html = 'episodesCount:2 <a href="/media/example/1"></a><a href="/media/example/2"></a>'
    + '<a href="/media/example-season-2/12"></a>';
  assert.deepEqual(parseAnimeAv1EpisodeInventory(html, "example").sourceEpisodeIds, [1, 2]);
});

test("a boundary-verified paginated inventory restores the hidden episode tail", () => {
  const parsed = parseAnimeAv1EpisodeInventory(
    'episodesCount:53 <a href="/media/long-show/1"></a><a href="/media/long-show/3"></a>'
      + Array.from({ length: 47 }, (_, index) => `<a href="/media/long-show/${index + 4}"></a>`).join(""),
    "long-show"
  );
  assert.equal(parsed.sourceEpisodeCount, 50);
  const expanded = expandAnimeAv1PaginatedInventory(parsed);
  assert.equal(expanded.sourceEpisodeCount, 53);
  assert.equal(expanded.sourcePlayableEpisodeCount, 52);
  assert.equal(expanded.sourceEpisodeIds.includes(2), false);
  assert.deepEqual(expanded.sourceEpisodeIds.slice(-3), [51, 52, 53]);
  assert.equal(expanded.sourceInventoryRangeVerified, true);
});

test("an inconclusive refresh preserves a previously verified long-series range", () => {
  const current = {
    sourceEpisodeIds: [1, 2, 3],
    sourceEpisodeCount: 3,
    sourcePlayableEpisodeCount: 3,
    sourceDeclaredEpisodeCount: 5,
    sourceInventoryRangeProbeStatus: "inconclusive"
  };
  const previous = {
    sourceEpisodeIds: [1, 2, 3, 4, 5],
    sourceEpisodeCount: 5,
    sourcePlayableEpisodeCount: 5,
    sourceDeclaredEpisodeCount: 5,
    sourceInventoryRangeVerified: true
  };
  const preserved = preserveVerifiedEpisodeRange(current, previous);
  assert.deepEqual(preserved.sourceEpisodeIds, [1, 2, 3, 4, 5]);
  assert.equal(preserved.sourceInventoryRangeVerified, true);
  assert.equal(preserved.sourceInventoryRangeProbeStatus, "restored");
});

test("a confirmed range rejection does not preserve stale hidden episodes", () => {
  const current = {
    sourceEpisodeIds: [1, 2, 3],
    sourceEpisodeCount: 3,
    sourcePlayableEpisodeCount: 3,
    sourceDeclaredEpisodeCount: 5,
    sourceInventoryRangeProbeStatus: "rejected"
  };
  const previous = {
    sourceEpisodeIds: [1, 2, 3, 4, 5],
    sourcePlayableEpisodeCount: 5,
    sourceDeclaredEpisodeCount: 5,
    sourceInventoryRangeVerified: true
  };
  assert.equal(preserveVerifiedEpisodeRange(current, previous), current);
});

test("transient AnimeAV1 failures are never cached as missing episodes", () => {
  assert.equal(shouldCacheAnimeAv1SourceStatus(404), true);
  assert.equal(shouldCacheAnimeAv1SourceStatus(503), false);
  assert.equal(animeAv1CachedSourceStatus({ status: 503, data: { ok: false } }), 503);
  assert.equal(animeAv1CachedSourceStatus({ data: { ok: false } }), 404);
});

test("inventory fields are applied without replacing catalog identity", () => {
  const item = { id: "animeav1-example", title: "Example" };
  const inventory = parseAnimeAv1EpisodeInventory('episodesCount:1,episodes:[{id:1,number:0}]', "example");
  applyAnimeAv1EpisodeInventory(item, inventory, "2026-09-07T00:00:00.000Z");
  assert.equal(animeAv1Slug(item), "example");
  assert.equal(item.title, "Example");
  assert.deepEqual(item.sourceEpisodeIds, [0]);
  assert.equal(item.sourceInventoryChecked, true);
});

test("provider route casing survives inventory lookup", () => {
  assert.equal(animeAv1Slug({
    id: "animeav1-castlevania",
    siteUrl: "https://animeav1.com/media/Castlevania"
  }), "Castlevania");
});

test("a listing with no published routes is explicitly unavailable", () => {
  const item = { id: "animeav1-empty", title: "Empty" };
  markAnimeAv1InventoryUnavailable(item, new Error("episode inventory missing from page"), "2026-09-08T00:00:00.000Z");
  assert.deepEqual(item.sourceEpisodeIds, []);
  assert.equal(item.sourcePlayableEpisodeCount, 0);
  assert.equal(item.sourceInventoryChecked, true);
  assert.match(item.sourceInventoryUnavailableReason, /inventory missing/);
});

test("provider page metadata supplies identity, date, runtime, and type", () => {
  const html = 'anime:{title:"Example",runtime:24,startDate:"2020-04-01",endDate:"2020-06-01",'
    + 'episodesCount:12,score:7.42,slug:"Example-Path",malId:12345,'
    + 'category:{id:1,name:"TV Anime",slug:"tv-anime",malId:"TV"},episodes:[{id:1,number:1}]}'
    + ' <a href="/media/Example-Path/1"></a>';
  assert.deepEqual(parseAnimeAv1PageMetadata(html, "Example-Path"), {
    sourceMalId: 12345,
    sourceRuntime: 24,
    sourceScore: 7.42,
    sourceStartDate: "2020-04-01",
    sourceEndDate: "2020-06-01",
    sourceType: "TV"
  });
});
