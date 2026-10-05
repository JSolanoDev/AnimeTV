import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import test from "node:test";

function assertCatalogSnapshotIntegrity(catalog, details) {
  assert.ok(Array.isArray(catalog.items) && catalog.items.length > 0, "the bundled adult catalog must not be empty");
  for (const field of ["totalFound", "eligibleTitleCount", "excludedForSafety", "incompleteMetadataCount"]) {
    assert.ok(Number.isInteger(catalog[field]) && catalog[field] >= 0, `catalog ${field} must be a nonnegative integer`);
  }
  const slugs = catalog.items.map((item) => item.slug);
  assert.ok(slugs.every((slug) => typeof slug === "string" && slug.trim()), "every bundled title must have an identity");
  assert.equal(new Set(slugs).size, slugs.length, "the bundled catalog must not contain duplicate identities");
  assert.equal(slugs.length, catalog.eligibleTitleCount, "every eligible title must remain bundled");

  assert.ok(Array.isArray(catalog.exclusions), "catalog exclusions must be recorded");
  assert.ok(catalog.exclusions.every((item) => typeof item.slug === "string" && item.slug.trim()
    && ["safety", "metadata-unavailable"].includes(item.reason)), "every exclusion must have an identity and a supported reason");
  const excludedSlugs = catalog.exclusions.map((item) => item.slug);
  assert.equal(new Set(excludedSlugs).size, excludedSlugs.length, "catalog exclusions must not contain duplicate identities");
  assert.deepEqual([...(catalog.excludedSlugs || [])].sort(), [...excludedSlugs].sort(), "excluded identities must match their recorded reasons");
  const eligible = new Set(slugs);
  assert.ok(excludedSlugs.every((slug) => !eligible.has(slug)), "excluded titles must not appear in the eligible catalog");
  assert.equal(catalog.excludedForSafety, catalog.exclusions.filter((item) => item.reason === "safety").length,
    "all safety exclusions must be accounted for");
  assert.equal(catalog.incompleteMetadataCount, catalog.exclusions.filter((item) => item.reason === "metadata-unavailable").length,
    "all pending metadata entries must be accounted for");
  assert.equal(catalog.totalFound, slugs.length + excludedSlugs.length, "every discovered title must be bundled or explicitly excluded");

  assert.ok(Array.isArray(details.items), "the bundled catalog must have a details snapshot");
  assert.equal(details.count, details.items.length, "the details count must match the bundled rows");
  const detailSlugs = details.items.map((item) => item.slug);
  assert.equal(new Set(detailSlugs).size, detailSlugs.length, "the details snapshot must not contain duplicate identities");
  assert.deepEqual([...detailSlugs].sort(), [...slugs].sort(), "every eligible title must retain exactly one bundled detail entry");
  assert.ok(catalog.generatedAt, "the catalog must identify its snapshot");
  assert.equal(details.catalogGeneratedAt, catalog.generatedAt, "catalog and details must belong to the same refresh");
}

function neutralSnapshot(titleCount = 2) {
  const items = Array.from({ length: titleCount }, (_, index) => ({ slug: `neutral-series-${index}` }));
  const exclusions = [
    { slug: "neutral-excluded", reason: "safety" },
    { slug: "neutral-pending", reason: "metadata-unavailable" }
  ];
  return {
    catalog: {
      items, generatedAt: "2026-10-05T00:00:00Z", totalFound: titleCount + exclusions.length,
      eligibleTitleCount: titleCount, excludedForSafety: 1, incompleteMetadataCount: 1,
      exclusions, excludedSlugs: exclusions.map((item) => item.slug)
    },
    details: { items: structuredClone(items), count: titleCount, catalogGeneratedAt: "2026-10-05T00:00:00Z" }
  };
}

test("snapshot accounting allows recorded exclusions and newly added eligible titles", () => {
  for (const count of [2, 979, 991]) {
    const { catalog, details } = neutralSnapshot(count);
    assert.doesNotThrow(() => assertCatalogSnapshotIntegrity(catalog, details));
  }
});

test("snapshot accounting rejects empty catalogs, invalid counters and missing eligible titles", () => {
  for (const mutate of [
    ({ catalog }) => { catalog.items = []; },
    ({ catalog }) => { catalog.eligibleTitleCount = undefined; },
    ({ catalog }) => { catalog.totalFound = -1; },
    ({ catalog }) => { catalog.items.pop(); },
    ({ catalog }) => { catalog.items.pop(); catalog.eligibleTitleCount--; }
  ]) {
    const snapshot = neutralSnapshot();
    mutate(snapshot);
    assert.throws(() => assertCatalogSnapshotIntegrity(snapshot.catalog, snapshot.details));
  }
});

test("snapshot accounting rejects duplicate or missing title identities", () => {
  for (const mutate of [
    ({ catalog }) => { catalog.items[1].slug = catalog.items[0].slug; },
    ({ catalog }) => { catalog.items[0].slug = ""; },
    ({ details }) => { details.items[1].slug = details.items[0].slug; },
    ({ details }) => { details.items.pop(); },
    ({ details }) => { details.items.pop(); details.count--; },
    ({ details }) => { details.items[1].slug = "neutral-unexpected"; }
  ]) {
    const snapshot = neutralSnapshot();
    mutate(snapshot);
    assert.throws(() => assertCatalogSnapshotIntegrity(snapshot.catalog, snapshot.details));
  }
});

test("snapshot accounting rejects inconsistent or overlapping exclusions", () => {
  for (const mutate of [
    ({ catalog }) => { catalog.exclusions[0].slug = catalog.items[0].slug; catalog.excludedSlugs[0] = catalog.items[0].slug; },
    ({ catalog }) => { catalog.exclusions[1].slug = catalog.exclusions[0].slug; },
    ({ catalog }) => { catalog.excludedSlugs.pop(); },
    ({ catalog }) => { catalog.exclusions[0].reason = "unknown"; },
    ({ catalog }) => { catalog.excludedForSafety++; },
    ({ catalog }) => { catalog.incompleteMetadataCount++; }
  ]) {
    const snapshot = neutralSnapshot();
    mutate(snapshot);
    assert.throws(() => assertCatalogSnapshotIntegrity(snapshot.catalog, snapshot.details));
  }
});

test("snapshot accounting rejects details from a different refresh", () => {
  const { catalog, details } = neutralSnapshot();
  details.catalogGeneratedAt = "2026-10-04T00:00:00Z";
  assert.throws(() => assertCatalogSnapshotIntegrity(catalog, details), /same refresh/);
});

test("failed snapshot assertions exit nonzero even after importing the server safety net", () => {
  const { catalog, details } = neutralSnapshot();
  catalog.items.pop();
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { createRequire } from "node:module";
    import test from "node:test";
    createRequire(${JSON.stringify(import.meta.url)})("../animetv-server.js");
    assert.equal(process.__animeTvSafetyNetInstalled, true);
    ${assertCatalogSnapshotIntegrity.toString()}
    test("invalid neutral snapshot", () => assertCatalogSnapshotIntegrity(${JSON.stringify(catalog)}, ${JSON.stringify(details)}));
  `], { encoding: "utf8", timeout: 15000 });
  assert.ifError(child.error);
  assert.equal(child.status, 1, child.stdout + child.stderr);
  assert.match(child.stdout + child.stderr, /every eligible title must remain bundled/);
});

// Keep every integration assertion in the test runner so the server's process
// safety net cannot turn an assertion failure into a successful build check.
test("adult source adapters preserve bundled artwork, merging and playback variants", async () => {

  global.window = { location: { href: "http://localhost/" } };

  const require = createRequire(import.meta.url);
  const {
    UnderHentaiAdultSourceAdapter,
    HentaiOceanAdultSourceAdapter,
    CompositeAdultSourceAdapter
  } = require("../js/adult-source-adapter.js");
  const {
    parseHentaiOceanEmbedData,
    hentaiOceanDirectCandidates,
    resolveUnderHentaiPortraitArtwork
  } = require("../animetv-server.js");

  const underHentai = new UnderHentaiAdultSourceAdapter();
  const hentaiOcean = new HentaiOceanAdultSourceAdapter();
  const composite = new CompositeAdultSourceAdapter([underHentai, hentaiOcean]);
  const underHentaiCatalog = require("../scraper/underhentai_catalog.json");
  const underHentaiDetails = require("../scraper/underhentai_details.json");
  const portraitMap = require("../scraper/adult_portrait_map.json");

  assertCatalogSnapshotIntegrity(underHentaiCatalog, underHentaiDetails);
  assert.ok(
    underHentaiCatalog.items.every((item) => /^https:\/\/static\.underhentai\.net\//i.test(item.image || "")),
    "every bundled adult title must retain its verified source artwork fallback"
  );
  assert.ok(
    underHentaiCatalog.items
      .map((item, index) => underHentai._catalogItem(item, index))
      .every((item) => item.adultPortraitCover && item.image),
    "every normalized adult card must have both primary and portrait artwork"
  );
  assert.equal(Object.keys(portraitMap.items || {}).length, portraitMap.total);
  assert.ok(portraitMap.total >= 90, "the production portrait map should retain verified exact-match coverage");
  assert.ok(
    Object.values(portraitMap.items || {}).every((artwork) => !/(?:www\.)?veohentai\.com/i.test(artwork?.url || "")),
    "the production portrait map must not retain the retired VeoHentai uploads"
  );

  const portraitFixtures = [
    ["nonohara-yuka-no-himitsu-no-haishin", "Nonohara Yuka no Himitsu no Haishin", /img\.hentaihaven\.xxx/],
    ["shiawase-nara-niku-o-morou-the-animation", "Shiawase nara Niku o Morou! The Animation", /shikimori\.one/],
    ["nee-summer", "Nee Summer!", /shikimori\.one/],
    ["boku-dake-no-hentai-kanojo-motto-the-animation", "Boku dake no Hentai Kanojo Motto The Animation", /shikimori\.one/],
    ["ane-kyun-joshi-ga-ie-ni-kita", "Ane Kyun! Joshi ga Ie ni Kita!", /shikimori\.one/],
    ["inyouchuu-shoku-ryoushokutou-taimaroku-harami-ochiru-shoujo-tachi-anime-edition", "Inyouchuu Shoku", /lain\.bgm\.tv/],
    ["s-ke-ni-totsuida-m-jou-no-nichijou", "S-ke ni Totsuida M-jou no Nichijou", /lain\.bgm\.tv/],
    ["otome-hime", "Otome Hime", /shikimori\.one/],
    ["mou-ichido-shite-mitai", "Mou Ichido, Shite Mitai.", /lain\.bgm\.tv/],
    ["dainiji-ura-nyuugakushiken-the-animation", "Dainiji Ura Nyuugakushiken The Animation", /lain\.bgm\.tv/],
    ["tsuma-ga-onsen-de-circle-nakama-no-nikubenki-ni-natta-no-desu-ga-anime-edition", "Tsuma ga Onsen", /lain\.bgm\.tv/],
    ["swamp-stamp-anime-edition", "Swamp Stamp Anime Edition", /shikimori\.one/],
    ["kowaremono-risa-plus-the-animation", "Kowaremono: Risa Plus The Animation", /shikimori\.one/],
    ["kowaremono-risa-the-animation", "Kowaremono: Risa The Animation", /shikimori\.one/],
    ["kowaremono-the-animation", "Kowaremono The Animation", /lain\.bgm\.tv/]
  ];
  portraitFixtures.forEach(([slug, title, expectedHost]) => {
    const artwork = resolveUnderHentaiPortraitArtwork({ slug, title });
    assert.match(artwork?.url || "", expectedHost, `${title} should have a portrait-card fallback`);
  });

  assert.equal(
    resolveUnderHentaiPortraitArtwork({
      slug: "unmapped-retired-poster",
      adultPortraitCover: "https://veohentai.com/wp-content/uploads/dead.jpg"
    }),
    null,
    "a stale cached VeoHentai poster must not be returned as usable artwork"
  );

  const portraitPrimary = underHentai._catalogItem({
    slug: "portrait-fixture",
    title: "Portrait Fixture",
    image: "https://static.underhentai.net/assets/landscape.jpg",
    adultPortraitCover: "https://img.hentaihaven.xxx/images/portrait.jpg"
  });
  assert.equal(
    portraitPrimary.adultPortraitCover,
    "https://img.hentaihaven.xxx/images/portrait.jpg",
    "UnderHentai card mapping must preserve a separate portrait cover"
  );

  const sourceFallback = underHentai._catalogItem({
    slug: "source-fallback",
    title: "Source Fallback",
    image: "https://static.underhentai.net/assets/source-fallback.jpg"
  });
  assert.equal(
    sourceFallback.adultPortraitCover,
    sourceFallback.image,
    "every title without a mapped portrait must retain its verified source image"
  );

  const primary = underHentai._catalogItem({
    slug: "sample-the-animation",
    title: "Sample The Animation",
    image: "https://static.underhentai.net/assets/sample.jpg",
    banner: "https://static.underhentai.net/assets/sample-wide.jpg",
    episodeCount: 2
  });
  const exactOceanMatch = hentaiOcean._catalogItem({
    slug: "sample",
    title: "Sample",
    image: "https://hentaiocean.com/assets/cover/sample.jpg",
    banner: "https://hentaiocean.com/thumbnail/sample-2.webp",
    episodeCount: 2
  });
  const oceanOnly = hentaiOcean._catalogItem({
    slug: "second-series",
    title: "Second Series",
    image: "https://hentaiocean.com/assets/cover/second.jpg",
    banner: "https://hentaiocean.com/thumbnail/second-series-1.webp",
    episodeCount: 1
  });

  const merged = composite._mergeCatalogs([primary], [exactOceanMatch, oceanOnly]);

  assert.equal(merged.length, 2, "exact title matches must not create duplicate cards");
  assert.equal(merged[0].adultSource, "UnderHentai", "UnderHentai remains the playback owner for exact matches");
  assert.equal(merged[0].title, "Sample", "the official source title should clean the display title");
  assert.equal(merged[0].image, exactOceanMatch.image, "the official portrait cover should enrich the primary item");
  assert.equal(merged[0].adultPortraitCover, exactOceanMatch.image, "the highest-quality exact portrait should lead every card image chain");
  assert.equal(merged[0].adultCinematicBackdrop, exactOceanMatch.banner, "the 16:9 source thumbnail should become the cinematic backdrop");
  assert.equal(merged[1].adultSource, "Hentai Ocean", "unmatched titles should remain playable secondary-source entries");
  assert.deepEqual(merged.map((item) => item.sourceOrder), [0, 1], "the merged catalog should have stable progressive-render order");

  const underResolver = { id: "under-release", type: "resolver", streamResolver: { endpoint: "/under" } };
  const oceanFallback = {
    id: "ocean-fallback",
    type: "resolver",
    streamResolver: { type: "hentaiocean", endpoint: "/api/adult/hentaiocean/stream?episode=sample-1" }
  };
  const mergedDetails = composite._mergeDetailPlayback({
    screenshots: ["https://static.underhentai.net/thumbs/sample.jpg"],
    episodes: [{ number: 1, sourceOptions: [underResolver], screenshots: ["https://static.underhentai.net/thumbs/sample.jpg"] }],
    seasons: [{ season: 1, episodes: [{ number: 1, sourceOptions: [underResolver] }] }]
  }, {
    episodes: [{ number: 1, sourceOptions: [oceanFallback], screenshots: ["https://hentaiocean.com/storyboard/sample-1.webp"] }]
  });

  assert.deepEqual(
    mergedDetails.episodes[0].sourceOptions.map((source) => source.id),
    ["under-release", "ocean-fallback"],
    "an exact secondary title should be available after the UnderHentai release fails"
  );
  assert.equal(mergedDetails.episodes[0].screenshots.length, 2, "episode galleries should merge exact secondary storyboards");
  assert.equal(mergedDetails.seasons[0].episodes[0], mergedDetails.episodes[0], "season rows should use the merged playable episode");

  const oceanResolverAdapter = new HentaiOceanAdultSourceAdapter();
  oceanResolverAdapter._request = async (path, params) => ({ path, params, ok: true });
  const oceanResolved = await oceanResolverAdapter.resolveStream("hentaiocean:sample", { slug: "sample-1" });
  assert.equal(oceanResolved.path, "/stream", "Hentai Ocean playback should resolve through the native-player endpoint");
  assert.equal(oceanResolved.params.episode, "sample-1", "the resolver must retain the exact provider episode id");

  const oceanEmbedData = parseHentaiOceanEmbedData(`
    <script>
      var jsondata = {"info":[{"description":"brace } inside text"}],"mirrors":[{"mirrorurl":"https://w2.hentaiocean.com/play?vid=Sample%20Episode.mp4"}]};
    </script>
  `);
  assert.equal(oceanEmbedData.mirrors.length, 1, "the mirror list should be parsed without executing source scripts");
  const oceanDirect = hentaiOceanDirectCandidates(oceanEmbedData.mirrors, "sample-1");
  assert.deepEqual(
    oceanDirect.map((source) => source.codec),
    ["av01", "avc1"],
    "the ad page should become native AV1 playback with an H.264 Chromecast fallback"
  );
  assert.ok(oceanDirect.every((source) => source.type === "direct" && source.mimeType === "video/mp4"));

  const duplicateEpisodeAdapter = new UnderHentaiAdultSourceAdapter();
  duplicateEpisodeAdapter._request = async () => ({
    item: {
      slug: "sample-variants",
      title: "Sample Variants",
      image: "https://static.underhentai.net/assets/sample.jpg",
      episodes: [
        {
          number: 1,
          screenshots: ["https://static.underhentai.net/thumbs/sample/sub.jpg"],
          sourceOptions: [{ releaseIndex: 0, label: "Subbed", watchUrl: "https://www.underhentai.net/watch/?id=1&ep=0" }]
        },
        {
          number: 1,
          screenshots: ["https://static.underhentai.net/thumbs/sample/raw.jpg"],
          sourceOptions: [{ releaseIndex: 0, label: "Raw", watchUrl: "https://www.underhentai.net/watch/?id=1&ep=1" }]
        }
      ]
    }
  });
  const consolidated = await duplicateEpisodeAdapter.getDetails("sample-variants");
  assert.equal(consolidated.episodes.length, 1, "duplicate variant rows should become one episode");
  assert.equal(consolidated.episodes[0].sourceOptions.length, 2, "all variant playback routes should remain available");
  assert.equal(consolidated.episodes[0].screenshots.length, 2, "variant galleries should be combined");
  assert.match(consolidated.episodes[0].sourceOptions[0].streamResolver.endpoint, /watch=/, "each resolver should identify its exact watch page");
  assert.notEqual(
    consolidated.episodes[0].sourceOptions[0].streamResolver.endpoint,
    consolidated.episodes[0].sourceOptions[1].streamResolver.endpoint,
    "variant resolver URLs must not collide"
  );

  console.log("Adult source merge tests passed.");
});
