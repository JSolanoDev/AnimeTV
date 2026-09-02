import assert from "node:assert/strict";
import { createRequire } from "node:module";

global.window = { location: { href: "http://localhost/" } };

const require = createRequire(import.meta.url);
const {
  UnderHentaiAdultSourceAdapter,
  HentaiOceanAdultSourceAdapter,
  CompositeAdultSourceAdapter
} = require("../js/adult-source-adapter.js");

const underHentai = new UnderHentaiAdultSourceAdapter();
const hentaiOcean = new HentaiOceanAdultSourceAdapter();
const composite = new CompositeAdultSourceAdapter([underHentai, hentaiOcean]);

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
assert.equal(merged[0].adultCinematicBackdrop, exactOceanMatch.banner, "the 16:9 source thumbnail should become the cinematic backdrop");
assert.equal(merged[1].adultSource, "Hentai Ocean", "unmatched titles should remain playable secondary-source entries");
assert.deepEqual(merged.map((item) => item.sourceOrder), [0, 1], "the merged catalog should have stable progressive-render order");

const underResolver = { id: "under-release", type: "resolver", streamResolver: { endpoint: "/under" } };
const oceanFallback = { id: "ocean-fallback", type: "iframe", externalUrl: "https://hentaiocean.com/embed/sample-1" };
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

console.log("Adult source merge tests passed.");
