import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { auditCatalogIntegrity, restoreLastKnownGood } from "./verify-catalog-integrity.mjs";
import { chooseExactIdentityRepair } from "./lib/offline-identity.mjs";

const row = (id, extra = {}) => ({
  id: `animeav1-${id}`,
  title: id.replace(/-/g, " "),
  image: `https://images.test/${id}.jpg`,
  siteUrl: `https://animeav1.com/media/${id}`,
  episodes: [{ season: 1, episode: 1, title: "Episode 1", siteUrl: `https://animeav1.com/media/${id}/1` }],
  ...extra
});

const art = (ids) => ({
  count: ids.length,
  entries: Object.fromEntries(ids.map((id, index) => [`animeav1-${id}`, {
    anilistId: 100 + index,
    malId: 200 + index,
    tmdbPoster: `https://image.tmdb.org/t/p/original/${id}-poster.jpg`,
    tmdbBackdrop: `https://image.tmdb.org/t/p/original/${id}-backdrop.jpg`
  }]))
});

test("exact offline titles repair stale season identities", () => {
  const current = {
    title: "Example Story",
    synonyms: [],
    anilistId: 10,
    malId: 20,
    episodes: 12,
    year: 2019
  };
  const seasonFour = {
    title: "Example Story: Adopted Daughter",
    synonyms: ["Example Story Season 4"],
    anilistId: 40,
    malId: 50,
    episodes: 24,
    year: 2026
  };
  assert.equal(chooseExactIdentityRepair({
    title: "Example Story: Adopted Daughter",
    current,
    candidates: [seasonFour]
  }), seasonFour);
});

test("equivalent same-year aliases are not replaced by a weaker duplicate", () => {
  const current = {
    title: "Example Special No. 170+1: More",
    anilistId: 10,
    episodes: 1,
    year: 2026
  };
  const duplicate = {
    title: "Example Special: More",
    malId: 20,
    episodes: 1,
    year: 2026
  };
  assert.equal(chooseExactIdentityRepair({
    title: "Example Special: More",
    current,
    candidates: [duplicate]
  }), null);
});

test("healthy catalog, ordered seasons, and skip intervals pass", () => {
  const catalog = { items: [row("alpha"), row("beta")] };
  const artwork = art(["alpha", "beta"]);
  artwork.entries["anilist-10"] = {
    anilistId: 10,
    metadataCover: "https://images.test/season-10-poster.jpg",
    tmdbBackdrop: "https://images.test/season-10-background.jpg",
    meta: { year: 2025, episodes: 12 }
  };
  artwork.entries["anilist-11"] = {
    anilistId: 11,
    metadataCover: "https://images.test/season-11-poster.jpg",
    meta: { year: 2026, episodes: 12 }
  };
  const result = auditCatalogIntegrity({
    catalog,
    previous: catalog,
    artwork,
    airing: { entries: { "animeav1-beta": { franchiseSeasons: [
      { anilistId: 10, title: "Beta", order: 1, startedAt: 100 },
      { anilistId: 11, title: "Beta 2", order: 2, startedAt: 200 }
    ] } } },
    skipTimes: { count: 1, entries: { "200:1": {
      checkedAt: new Date().toISOString(),
      intro: { start: 0, end: 90 },
      outro: { start: 1200.5, end: 1260.5 }
    } } }
  });
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.metrics.providerPlaybackRoutes, 2);
  assert.equal(result.metrics.seasonChainRows, 1);
  assert.equal(result.metrics.uniqueSeasonIdentities, 2);
  assert.equal(result.metrics.seasonIdentityPosters, 2);
  assert.equal(result.metrics.seasonBackgroundSources, 2);
});

test("a relation season without identity-specific artwork is rejected", () => {
  const catalog = { items: [row("alpha")] };
  const result = auditCatalogIntegrity({
    catalog,
    previous: catalog,
    artwork: art(["alpha"]),
    airing: { entries: { "animeav1-alpha": { franchiseSeasons: [
      { anilistId: 987, title: "Alpha Season 2", order: 1, startedAt: 100 }
    ] } } },
    skipTimes: { count: 0, entries: {} }
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /season identity 987 has no exact high-quality poster/);
  assert.match(result.errors.join("\n"), /season identity 987 has no canonical metadata/);
});

test("a catastrophic scrape shrink is rejected", () => {
  const result = auditCatalogIntegrity({
    catalog: { items: [row("alpha")] },
    previous: { items: Array.from({ length: 10 }, (_, index) => row(`old-${index}`)) },
    artwork: art(["alpha"]),
    airing: { entries: {} },
    skipTimes: { count: 0, entries: {} }
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /shrank/);
});

test("duplicate canonical episodes and malformed season order are rejected", () => {
  const catalog = { items: [row("alpha", { episodes: [
    { season: 1, episode: 1, siteUrl: "https://animeav1.com/media/alpha/1" },
    { season: 1, episode: 1, siteUrl: "https://animeav1.com/media/alpha/1-copy" }
  ] })] };
  const result = auditCatalogIntegrity({
    catalog,
    previous: catalog,
    artwork: art(["alpha"]),
    airing: { entries: { "animeav1-alpha": { franchiseSeasons: [
      { anilistId: 2, title: "Later", order: 2, startedAt: 200 },
      { anilistId: 1, title: "Earlier", order: 1, startedAt: 100 }
    ] } } },
    skipTimes: { count: 1, entries: { "200:1": { intro: { start: 90, end: 10 } } } }
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /repeats canonical episode/);
  assert.match(result.errors.join("\n"), /order is not contiguous/);
  assert.match(result.errors.join("\n"), /not in release order/);
  assert.match(result.errors.join("\n"), /invalid opening interval/);
});

test("last-known-good restore preserves the rejected scrape", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zenkai-catalog-"));
  const current = path.join(dir, "current.json");
  const previous = path.join(dir, "previous.json");
  const rejected = path.join(dir, "rejected.json");
  fs.writeFileSync(current, JSON.stringify({ items: [row("broken")] }));
  fs.writeFileSync(previous, JSON.stringify({ items: [row("good-a"), row("good-b")] }));
  restoreLastKnownGood(current, previous, rejected);
  assert.equal(JSON.parse(fs.readFileSync(current, "utf8")).items.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(rejected, "utf8")).items[0].id, "animeav1-broken");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a title without a TMDB backdrop keeps its identity and metadata", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "animetv-server.js"), "utf8");
  const start = source.indexOf("function buildArtworkIdentityIndex(");
  const end = source.indexOf("function handleScrapedCatalog(", start);
  assert.ok(start >= 0 && end > start);
  const catalog = { items: [row("poster-only")] };
  const context = vm.createContext({
    root: "/repo",
    path,
    fs: { readFileSync: () => JSON.stringify(catalog) },
    readArtworkMap: () => ({
      "animeav1-poster-only": {
        status: "no-tmdb-candidates",
        anilistId: 77,
        malId: 88,
        metadataCover: "https://images.test/high-resolution-cover.jpg",
        meta: { year: 2026, episodes: 1, format: "OVA", description: "Metadata survives." }
      }
    }),
    readAiringMap: () => null
  });
  vm.runInContext(source.slice(start, end), context, { filename: "animetv-server.js catalog extract" });
  const [merged] = vm.runInContext("readScrapedRegularCatalogItems()", context);
  assert.equal(merged.anilistId, 77);
  assert.equal(merged.malId, 88);
  assert.equal(merged.coverImageLarge, "https://images.test/high-resolution-cover.jpg");
  assert.equal(merged.description, "Metadata survives.");
});

test("a related season receives its own poster, background, and metadata", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "animetv-server.js"), "utf8");
  const start = source.indexOf("function buildArtworkIdentityIndex(");
  const end = source.indexOf("function handleScrapedCatalog(", start);
  assert.ok(start >= 0 && end > start);
  const catalog = { items: [row("season-three", {
    anilistId: 303,
    image: "https://images.test/season-three-source.jpg",
    description: "Season three description."
  })] };
  const context = vm.createContext({
    root: "/repo",
    path,
    fs: { readFileSync: () => JSON.stringify(catalog) },
    readArtworkMap: () => ({
      "animeav1-season-three": {
        status: "ok",
        anilistId: 303,
        metadataCover: "https://images.test/season-three-poster.jpg",
        tmdbBackdrop: "https://images.test/season-three-background.jpg",
        meta: { description: "Season three description." }
      },
      "anilist-202": {
        status: "ok",
        anilistId: 202,
        malId: 2202,
        metadataCover: "https://images.test/season-two-poster.jpg",
        anilistBanner: "https://images.test/season-two-background.jpg",
        meta: {
          description: "Season two description.",
          genres: ["Adventure"],
          episodes: 12,
          format: "TV",
          year: 2024
        }
      }
    }),
    readAiringMap: () => ({
      "animeav1-season-three": {
        franchiseSeasons: [
          { anilistId: 202, title: "Example Season 2", order: 1 },
          { anilistId: 303, title: "Example Season 3", order: 2 }
        ]
      }
    })
  });
  vm.runInContext(source.slice(start, end), context, { filename: "animetv-server.js catalog extract" });
  const [merged] = vm.runInContext("readScrapedRegularCatalogItems()", context);
  const seasonTwo = merged.franchiseSeasons[0];
  assert.equal(seasonTwo.malId, 2202);
  assert.equal(seasonTwo.image, "https://images.test/season-two-poster.jpg");
  assert.equal(seasonTwo.banner, "https://images.test/season-two-background.jpg");
  assert.equal(seasonTwo.description, "Season two description.");
  assert.notEqual(seasonTwo.image, merged.image);
  assert.notEqual(seasonTwo.description, merged.description);
});
