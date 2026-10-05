import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import sharp from "sharp";
import { verifiedCarouselArtwork, confirmedCarouselAiringInstant } from "../js/utils.js";
import { prepareCarouselArtwork, selectCarouselArtworkIds } from "./lib/carousel-artwork.mjs";
import { buildHomepageBootstrap } from "./build-homepage-bootstrap.mjs";

const URL = "https://image.tmdb.org/t/p/original/neutral.jpg";
const NOW = Date.parse("2026-10-05T12:00:00Z");
const proof = { version: 1, url: URL, width: 1920, height: 1080 };
const image = async (width, height) => sharp({ create: { width, height, channels: 3,
  background: "#315d42" } }).jpeg().toBuffer();
const response = bytes => new Response(bytes, { headers: { "Content-Type": "image/jpeg" } });

test("native HD proof rejects strips, posters, small originals, guessed sizes and stale URLs", () => {
  assert.equal(verifiedCarouselArtwork(proof, URL), URL);
  for (const invalid of [null, { ...proof, version: 0 }, { ...proof, width: 1280, height: 720 },
    { ...proof, height: 400 }, { ...proof, width: 2000, height: 3000 },
    { ...proof, url: "https://image.tmdb.org/t/p/w1920/neutral.jpg" }]) {
    assert.equal(verifiedCarouselArtwork(invalid, invalid?.url || URL), "");
  }
  assert.equal(verifiedCarouselArtwork(proof, `${URL}?replacement=1`), "");
});

test("only confirmed instants/zone-aware broadcasts supply carousel day and time", () => {
  assert.equal(confirmedCarouselAiringInstant({ confirmedNextAiringAt: NOW + 3600000 }, NOW), NOW + 3600000);
  for (const show of [{ nextAiringAt: NOW + 3600000, lastEpisodeAt: new Date(NOW).toISOString() },
    { day: "Sun", time: "8:30 AM" }, { confirmedNextAiringAt: "bad" },
    { confirmedNextAiringAt: NOW - 8 * 86400000 }, { confirmedNextAiringAt: NOW + 30 * 86400000 },
    { broadcastDay: "Sundays", broadcastTime: "09:30", broadcastTimezone: "unknown" }]) {
    assert.equal(confirmedCarouselAiringInstant(show, NOW), 0);
  }
  assert.ok(confirmedCarouselAiringInstant({ broadcastDay: "Sundays", broadcastTime: "09:30",
    broadcastTimezone: "Asia/Tokyo" }, NOW) > NOW);
});

test("offline preparation measures original pixels once per URL and reuses valid proof", async () => {
  const entries = { a: { tmdbBackdrop: URL }, b: { tmdbBackdrop: URL } };
  const bytes = await image(1920, 1080);
  let calls = 0;
  const stats = await prepareCarouselArtwork(entries, ["a", "b"], { now: NOW, intervalMs: 0,
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, URL);
      assert.equal(options.redirect, "error");
      assert.ok(options.signal);
      return response(bytes);
    } });
  assert.equal(calls, 1);
  assert.equal(stats.checkedTitles, 2);
  assert.deepEqual(entries.a.carouselArtwork, proof);
  assert.deepEqual(selectCarouselArtworkIds(["a", "b"], entries, NOW + 86400000), []);
});

test("small image stays pending with daily cooldown, then automatically qualifies when replaced", async () => {
  const entries = { a: { tmdbBackdrop: URL } };
  const bytes = await image(1280, 720);
  await prepareCarouselArtwork(entries, ["a"], { now: NOW, intervalMs: 0, fetchImpl: async () => response(bytes) });
  assert.equal(entries.a.carouselArtwork, undefined);
  assert.deepEqual(selectCarouselArtworkIds(["a"], entries, NOW + 3600000), []);
  assert.deepEqual(selectCarouselArtworkIds(["a"], entries, NOW + 86400000), ["a"]);
  const replacement = URL.replace("neutral.jpg", "neutral-hd.jpg");
  entries.a.tmdbBackdrop = replacement;
  assert.deepEqual(selectCarouselArtworkIds(["a"], entries, NOW + 3600000), ["a"]);
  const hd = await image(3840, 2160);
  await prepareCarouselArtwork(entries, ["a"], { now: NOW + 3600000, intervalMs: 0, fetchImpl: async () => response(hd) });
  assert.equal(verifiedCarouselArtwork(entries.a.carouselArtwork, replacement), replacement);
});

test("probes are bounded; provider throttling stops without retries or approval", async () => {
  const entries = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [String(i), { tmdbBackdrop: URL }]));
  assert.equal(selectCarouselArtworkIds(Object.keys(entries), entries, NOW).length, 12);
  let calls = 0;
  await assert.rejects(prepareCarouselArtwork(entries, ["0", "1"], { now: NOW, intervalMs: 0,
    fetchImpl: async () => { calls++; return new Response(null, { status: 429, headers: { "Retry-After": "60" } }); }
  }), error => error.retryAfter === "60");
  assert.equal(calls, 1);
  assert.equal(entries["0"].carouselArtwork, undefined);
});

test("carousel filters before taking eight; pending titles remain in the catalog", () => {
  const code = fs.readFileSync(new globalThis.URL("../client.js", import.meta.url), "utf8");
  const cards = Array.from({ length: 12 }, (_, i) => ({ id: String(i), title: "Neutral title",
    tmdbBackdrop: URL, carouselArtwork: i < 4 ? null : proof, confirmedNextAiringAt: Date.now() + 3600000 }));
  const context = vm.createContext({ state: { av1Latest: [1] }, HOME_CARD_LIMIT: 120,
    buildAnimeAv1ReleaseCards: () => cards, recentlyAiredShows: () => { throw new Error("No unrelated padding"); },
    verifiedCarouselArtwork, confirmedCarouselAiringInstant, isArtworkLowQuality: () => false });
  vm.runInContext(code.slice(code.indexOf("function recentReleaseCarouselShows("),
    code.indexOf("// Hero backdrop:")), context);
  assert.deepEqual(Array.from(context.recentReleaseCarouselShows(), show => show.id), cards.slice(4).map(show => show.id));
  assert.equal(cards.length, 12);
  cards.forEach(show => { show.confirmedNextAiringAt = null; });
  assert.equal(context.recentReleaseCarouselShows().length, 0);
  assert.match(code, /if \(!isAdultCatalogShow\(next\) \|\| next\._tmdbResolved\) preloadHeroImage\(next\)/);
});

test("bootstrap retains proof, rejects mismatched-season schedules and never drops catalog episodes", () => {
  const catalog = { items: [{ id: "a", title: "Neutral", sourcePlayableEpisodeCount: 2, sourceEpisodeIds: [1, 2] }] };
  const art = { entries: { a: { anilistId: 17, tmdbBackdrop: URL, carouselArtwork: proof } } };
  const airing = { entries: { a: { anilistId: 18, nextAiringAt: NOW, broadcastDay: "Sundays" } } };
  const row = buildHomepageBootstrap(catalog, art, airing).items[0];
  assert.equal(row.confirmedNextAiringAt, null);
  assert.equal(row.broadcastDay, "");
  assert.deepEqual(row.carouselArtwork, proof);
  assert.deepEqual(row.sourceEpisodeIds, [1, 2]);
});

test("both automatic artwork jobs install Sharp before running preparation tests", () => {
  for (const name of ["refresh-latest-artwork", "scrape-catalog"]) {
    const code = fs.readFileSync(new globalThis.URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8");
    const install = code.indexOf("npm ci --omit=dev --no-audit --no-fund");
    assert.ok(install > code.indexOf("actions/setup-node@"));
    assert.ok(install < code.indexOf("node --test"));
    assert.ok(install < code.indexOf("node scripts/"));
  }
});
