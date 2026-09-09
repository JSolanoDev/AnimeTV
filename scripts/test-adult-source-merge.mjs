import assert from "node:assert/strict";
import { createRequire } from "node:module";

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

const portraitFixtures = [
  ["nonohara-yuka-no-himitsu-no-haishin", "Nonohara Yuka no Himitsu no Haishin", /veohentai\.com/],
  ["shiawase-nara-niku-o-morou-the-animation", "Shiawase nara Niku o Morou! The Animation", /veohentai\.com/],
  ["mecha-gishi-resta-no-daibouken", "Mecha Gishi Resta no Daibouken", /veohentai\.com/],
  ["sex-ga-suki-de-suki-de-daisuki-na-classmate-no-ano-ko", "Sex ga Suki de Suki de Daisuki na Classmate no Ano Ko", /veohentai\.com/],
  ["kakurenbo-the-animation", "Kakurenbo The Animation", /veohentai\.com/],
  ["nee-summer", "Nee Summer!", /shikimori\.one/],
  ["boku-dake-no-hentai-kanojo-motto-the-animation", "Boku dake no Hentai Kanojo Motto The Animation", /shikimori\.one/]
];
portraitFixtures.forEach(([slug, title, expectedHost]) => {
  const artwork = resolveUnderHentaiPortraitArtwork({ slug, title });
  assert.match(artwork?.url || "", expectedHost, `${title} should have a portrait-card fallback`);
});

const portraitPrimary = underHentai._catalogItem({
  slug: "portrait-fixture",
  title: "Portrait Fixture",
  image: "https://static.underhentai.net/assets/landscape.jpg",
  adultPortraitCover: "https://veohentai.com/wp-content/uploads/portrait.jpg"
});
assert.equal(
  portraitPrimary.adultPortraitCover,
  "https://veohentai.com/wp-content/uploads/portrait.jpg",
  "UnderHentai card mapping must preserve a separate portrait cover"
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
