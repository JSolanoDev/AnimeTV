import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const client = fs.readFileSync(new URL("../client.js", import.meta.url), "utf8");
function section(start, end) {
  const from = client.indexOf(start);
  const to = client.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, start);
  return client.slice(from, to);
}
function node() {
  const attrs = new Map();
  const classes = new Set();
  return {
    dataset: {}, style: { setProperty() {} }, textContent: "", naturalWidth: 1920, naturalHeight: 1080,
    setAttribute: (key, value) => attrs.set(key, value), getAttribute: key => attrs.get(key) ?? null,
    removeAttribute: key => attrs.delete(key), get src() { return attrs.get("src"); },
    set src(value) { attrs.set("src", value); },
    classList: { add: key => classes.add(key), remove: key => classes.delete(key),
      contains: key => classes.has(key), toggle: (key, on) => on ? classes.add(key) : classes.delete(key) }
  };
}
function harness() {
  const catalog = [];
  const failures = new Map();
  const imageRequests = [];
  const saved = [];
  const ctx = vm.createContext({ URL, Date, Map, Set, Promise, console,
    state: { route: "home", catalogTier: "full", carouselIndex: 0, av1Latest: [1] },
    HOME_CARD_LIMIT: 120, enabled: true,
    AdultMode: { isEnabled: () => ctx.enabled },
    isAdultCatalogShow: show => Boolean(show.adult),
    adultSourceOrderedShows: limit => catalog.slice(0, limit),
    buildAnimeAv1ReleaseCards: () => catalog.filter(show => !show.adult),
    recentlyAiredShows: () => [],
    verifiedCarouselArtwork: (proof, url) => proof?.url === url ? url : "",
    confirmedCarouselAiringInstant: show => show.confirmedNextAiringAt || 0,
    hqImage: value => value,
    cinematicBackdropUrl: value => value,
    imageDeliveryUrl: value => value,
    isArtworkLowQuality: (url, role) => failures.get(role)?.has(url),
    markArtworkLowQuality: (url, role) => { if (!failures.has(role)) failures.set(role, new Set()); failures.get(role).add(url); },
    ImageResolver: { isImageFailed: () => false, markImageFailed: () => { throw Error("Adult rejection leaked into shared images"); } },
    artworkIntrinsicPixels: img => ({ width: img.naturalWidth, height: img.naturalHeight }),
    artworkShowIdentity: show => show.id, getShowKey: show => show.id,
    carouselLineupIsProvisional: () => false, renderCarouselIndicators() {},
    heroMemoActive: false, _carouselMemoId: "", _carouselPreviewShowId: "",
    clearHeroMemo() {}, resetCarouselBlurPlaceholder() {}, clearCarouselBlurPlaceholder() {},
    showCarouselBlurPlaceholder() {}, signalAppLoader() {}, applyCarouselArtworkLayout() {},
    writeHeroMemo: entry => saved.push(entry), getShowTitle: show => show.title || show.id,
    simpleCarouselText: () => "Neutral fixture", showHasLatinoDub: () => false,
    formatAiringWeekday: () => "Mon", formatAiringClock: () => "8:30 AM", showAiringTimeText: () => "",
    getCardTarget: () => ({ seasonNumber: 1, episodeNumber: 1 }),
    carouselStage: node(), carouselBackdrop: node(), carouselBackdropImage: node(),
    carouselTitle: node(), carouselText: node(), carouselMeta: node(), carouselOpen: node(),
    carouselIndicators: null, document: { getElementById: () => node() },
    Image: class {
      constructor() { this.naturalWidth = 1920; this.naturalHeight = 1080; imageRequests.push(this); }
      decode() { return Promise.resolve(); }
    }
  });
  vm.runInContext(section("function cinematicArtworkSourceUrl(", "function cinematicBackdropUrl(")
    + section("const artworkImagePreloads =", "async function warmSeasonArtwork(")
    + section("let _carouselStableIds =", "function resetReleaseCarouselLineup(")
    + section("function recentReleaseCarouselShows(", "// Give the live latest feed")
    + section("function renderCarousel()", "let _carouselDotsHtml"), ctx);
  return { ctx, catalog, failures, imageRequests, saved,
    remember: (url, width, height) => ctx.rememberArtworkDimensions(url, { naturalWidth: width, naturalHeight: height }) };
}
const artwork = name => `https://neutral.example/${name}.jpg`;
const show = (id, fields = {}) => ({ id, title: "Neutral series", adult: true, highQualityBackground: artwork(id), ...fields });

test("regular carousel refreshes a changed episode and clock without replacing its decoded image", () => {
  const h = harness(); h.ctx.enabled = false;
  const current = show("regular", { adult: false, _av1Episode: 1, tmdbBackdrop: artwork("regular"),
    carouselArtwork: { url: artwork("regular") }, confirmedNextAiringAt: Date.now() + 3600000 });
  h.catalog.push(current);
  h.ctx.renderCarousel();
  const originalSrc = h.ctx.carouselBackdropImage.src;
  const originalLoad = h.ctx.carouselBackdropImage.onload;
  assert.match(h.ctx.carouselMeta.textContent, /EP 1/);
  current._av1Episode = 2;
  h.ctx.formatAiringWeekday = () => "Tue";
  h.ctx.formatAiringClock = () => "9:00 PM";
  h.ctx.renderCarousel();
  assert.match(h.ctx.carouselMeta.textContent, /EP 2 \| Tue \| 9:00 PM/);
  assert.equal(h.ctx.carouselBackdropImage.src, originalSrc);
  assert.equal(h.ctx.carouselBackdropImage.onload, originalLoad);
});

test("adult hero requires HD landscape pixels, not posters, strips or guessed URL sizes", () => {
  const { ctx } = harness();
  for (const [width, height] of [[320, 180], [960, 540], [2000, 3000], [1920, 400], [1280, 0]]) {
    assert.equal(ctx.adultCarouselDimensionsAreHD({ width, height }), false);
  }
  assert.equal(ctx.adultCarouselDimensionsAreHD({ width: 1280, height: 720 }), true);
  assert.equal(ctx.adultCarouselDimensionsAreHD({ width: 3840, height: 2160 }), true);
  assert.equal(ctx.carouselResolvedBackdropArtwork(show("cover", { highQualityBackground: "", image: artwork("poster") })), "");
});

test("adult filtering precedes the eight-slide limit and does not remove catalog titles", () => {
  const h = harness();
  for (let i = 0; i < 12; i++) {
    h.catalog.push(show(String(i)));
    h.remember(artwork(i), i < 4 ? 560 : 1920, i < 4 ? 315 : 1080);
  }
  assert.deepEqual(Array.from(h.ctx.recentReleaseCarouselShows(), row => row.id), ["4", "5", "6", "7", "8", "9", "10", "11"]);
  assert.equal(h.catalog.length, 12);
  assert.equal(h.imageRequests.length, 0, "selection never probes or fetches the catalog");
});

test("known HD artwork beats an unverified candidate and known small images are skipped", () => {
  const h = harness();
  const row = show("one", { adultCinematicBackdrop: artwork("unknown") });
  h.remember(row.highQualityBackground, 1920, 1080);
  assert.equal(h.ctx.carouselResolvedBackdropArtwork(row), row.highQualityBackground);
  h.remember(row.highQualityBackground, 560, 315);
  assert.equal(h.ctx.carouselResolvedBackdropArtwork(row), row.adultCinematicBackdrop);
  h.remember(row.adultCinematicBackdrop, 1920, 400);
  assert.equal(h.ctx.carouselResolvedBackdropArtwork(row), "");
});

test("a small loaded hero is never revealed or saved; its HD fallback replaces it", () => {
  const h = harness();
  h.catalog.push(show("one", { adultCinematicBackdrop: artwork("small") }));
  h.ctx.renderCarousel();
  const img = h.ctx.carouselBackdropImage;
  img.naturalWidth = 560; img.naturalHeight = 315;
  img.onload();
  assert.equal(img.src, artwork("one"));
  assert.equal(img.dataset.decodedSrc, undefined);
  assert.equal(h.saved.length, 0);
  assert.equal(h.failures.get("backdrop"), undefined, "detail and regular art remain untouched");
  img.naturalWidth = 1920; img.naturalHeight = 1080;
  img.onload();
  assert.equal(img.dataset.decodedSrc, artwork("one"));
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].adultCarouselArtwork.width, 1920);
});

test("failed adult images advance without retrying on rerenders or poisoning regular artwork", () => {
  const h = harness();
  h.catalog.push(show("one"), show("two"));
  h.ctx.renderCarousel();
  h.ctx.carouselBackdropImage.onerror();
  assert.equal(h.ctx.carouselBackdropImage.src, artwork("two"));
  h.ctx.renderCarousel();
  assert.equal(h.ctx.carouselBackdropImage.src, artwork("two"));
  assert.equal(h.failures.get("backdrop"), undefined);
});

test("late adult enrichment repaints the same title, but identical renders preserve its image", () => {
  const h = harness();
  const row = show("one"); h.catalog.push(row);
  h.ctx.renderCarousel(); h.ctx.carouselBackdropImage.onload();
  const onload = h.ctx.carouselBackdropImage.onload;
  h.ctx.renderCarousel();
  assert.equal(h.ctx.carouselBackdropImage.onload, onload);
  row.adultCinematicBackdrop = artwork("upgrade");
  h.remember(row.adultCinematicBackdrop, 3840, 2160);
  // Both are verified: the newly resolved source-curated backdrop stays canonical.
  h.ctx.renderCarousel();
  assert.equal(h.ctx.carouselBackdropImage.src, artwork("upgrade"));
});

test("adult lineup changes retain the selected title, while manual selection still works", () => {
  const h = harness(); h.catalog.push(show("one"), show("two"));
  h.ctx.renderCarousel();
  h.ctx.state.carouselIndex = 1; h.ctx.renderCarousel();
  h.catalog.unshift(show("new")); h.ctx.renderCarousel();
  assert.equal(h.ctx.carouselBackdropImage.src, artwork("two"));
  assert.equal(h.ctx.state.carouselIndex, 2);
  h.ctx.state.carouselIndex = 0; h.ctx.renderCarousel();
  assert.equal(h.ctx.carouselBackdropImage.src, artwork("new"));
});

test("late decode cannot reveal adult art after switching modes or slides", async () => {
  const h = harness(); h.catalog.push(show("one"), show("two"));
  let complete;
  h.ctx.carouselBackdropImage.decode = () => new Promise(resolve => { complete = resolve; });
  h.ctx.renderCarousel(); h.ctx.carouselBackdropImage.onload();
  h.ctx.enabled = false; complete(); await Promise.resolve();
  assert.equal(h.saved.length, 0);
  h.ctx.enabled = true;
  h.ctx.carouselBackdropImage.onload();
  h.ctx.state.carouselIndex = 1; h.ctx.renderCarousel(); complete(); await Promise.resolve();
  assert.equal(h.saved.length, 0);
});

test("preload and repeated selection share one image request and reuse its measured pixels", async () => {
  const h = harness();
  const first = h.ctx.preloadArtworkImage(artwork("one"), 1920, 92);
  const second = h.ctx.preloadArtworkImage(artwork("one"), 1920, 92);
  assert.equal(first, second);
  assert.equal(h.imageRequests.length, 1);
  h.imageRequests[0].onload(); assert.equal(await first, true);
  assert.equal(h.ctx.carouselResolvedBackdropArtwork(show("one")), artwork("one"));
  assert.equal(h.imageRequests.length, 1);
});

test("adult memo rejects missing/small/stale proof while regular schedule rules stay unchanged", () => {
  const h = harness(); let stored;
  Object.assign(h.ctx, { HERO_MEMO_SCHEMA: 5, HERO_MEMO_TTL_MS: 10000, HERO_MEMO_KEY: "hero",
    location: { origin: "https://neutral.example" }, localStorage: { getItem: () => stored, removeItem() {} } });
  vm.runInContext(section("function readHeroMemo()", "function writeHeroMemo("), h.ctx);
  const art = artwork("one");
  const memo = { schema: 5, ts: Date.now(), art, adult: true, src: `/api/image?src=${encodeURIComponent(art)}` };
  stored = JSON.stringify(memo); assert.equal(h.ctx.readHeroMemo(), null);
  for (const proof of [{ url: art, width: 560, height: 315 }, { url: artwork("old"), width: 1920, height: 1080 }]) {
    stored = JSON.stringify({ ...memo, adultCarouselArtwork: proof }); assert.equal(h.ctx.readHeroMemo(), null);
  }
  stored = JSON.stringify({ ...memo, adultCarouselArtwork: { url: art, width: 1920, height: 1080 } });
  assert.equal(h.ctx.readHeroMemo().art, art);
  stored = JSON.stringify({ ...memo, adult: false, carouselArtwork: { url: art }, confirmedNextAiringAt: Date.now() + 1000 });
  assert.equal(h.ctx.readHeroMemo().art, art);
  stored = JSON.stringify({ ...memo, adult: false, carouselArtwork: { url: art } });
  assert.equal(h.ctx.readHeroMemo(), null);
});

test("regular selection still requires confirmed HD proof and time, independent of adult rejection", () => {
  const h = harness(); h.ctx.enabled = false;
  const row = show("regular", { adult: false, tmdbBackdrop: artwork("shared"),
    carouselArtwork: { url: artwork("shared") }, confirmedNextAiringAt: Date.now() + 1000 });
  h.catalog.push(row);
  h.ctx.markArtworkLowQuality(row.tmdbBackdrop, "adult-carousel");
  assert.equal(h.ctx.recentReleaseCarouselShows()[0].id, row.id);
  assert.equal(h.ctx.carouselResolvedBackdropArtwork(row), row.tmdbBackdrop);
  row.confirmedNextAiringAt = 0;
  assert.equal(h.ctx.recentReleaseCarouselShows().length, 0);
});

test("adult selector thumbnails use sharper wide artwork and their preload URL matches exactly", async () => {
  const h = harness();
  h.ctx.imageDeliveryUrl = (url, width, quality) => `${url}?w=${width}&q=${quality}`;
  h.ctx.getCardPosterCandidates = row => [row.image];
  h.ctx.carouselArtworkOrPoster = row => row.image;
  vm.runInContext(section("function carouselIndicatorArtwork(", "function warmCarouselIndicatorTarget(")
    + "let _carouselIndicatorImagesReady=false, _carouselIndicatorHydrationQueued=false, _carouselIndicatorHydrationGeneration=0;"
    + section("function scheduleCarouselIndicatorHydration(", "function simpleCarouselText("), h.ctx);
  const adult = show("one", { image: artwork("portrait") });
  const delivered = h.ctx.carouselIndicatorImageUrl(adult);
  assert.equal(delivered, `${adult.highQualityBackground}?w=360&q=86`);
  h.ctx.scheduleCarouselIndicatorHydration([adult, adult]);
  assert.equal(h.imageRequests.length, 1);
  assert.equal(h.imageRequests[0].src, delivered);
  const regular = { adult: false, image: artwork("poster") };
  assert.equal(h.ctx.carouselIndicatorImageUrl(regular), `${regular.image}?w=180&q=72`);
});
