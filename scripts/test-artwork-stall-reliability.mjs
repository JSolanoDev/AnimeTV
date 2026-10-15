import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const client = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
function section(start, end) {
  const from = client.indexOf(start);
  const to = client.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing section: ${start}`);
  return client.slice(from, to);
}
function node() {
  const classes = new Set();
  return { style: {}, dataset: {}, hidden: true, classList: {
    add: (...names) => names.forEach(name => classes.add(name)),
    remove: (...names) => names.forEach(name => classes.delete(name)),
    contains: name => classes.has(name),
    toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name)
  } };
}
function backdropHarness() {
  const nodes = Object.fromEntries(["watchBackdrop", "watchBackdropBlur", "watchBackdropTitleArt", "watchBackdropTitleText"].map(id => [id, node()]));
  const images = [];
  const roles = [];
  const seasons = [{ number: 1 }, { number: 2 }];
  const art = "https://image.tmdb.org/t/p/original/neutral.jpg";
  const show = { id: "neutral-show", title: "Neutral title", tmdbBackdrop: art, banner: art, _tmdbResolved: true, seasons };
  const c = vm.createContext({ state: { activeShow: show, activeSeasonIndex: 0 },
    document: { querySelector: selector => nodes[selector.slice(1)], body: node() },
    overlay: node(), window: { setTimeout() {} }, setTimeout() {},
    Image: class { constructor() { images.push(this); } },
    isAdultCatalogShow: () => false, curatedWatchBackdrop: () => "", getCarouselArtwork: () => "",
    underHentaiBackdropCandidates: () => [], animeAv1BackdropCandidates: () => [], seasonWideBackdropCandidates: () => [],
    hqImage: value => value, verticalArt: new Set(), getBackdropSeasonNumber: season => season?.number,
    getDetailSeasons: value => value.seasons, watchBackdropKey: (value, season) => `${value.id}:${season.number}`,
    getShowTitle: value => value.title, getBestCapturedEpisodeFrame: () => "", animeBackdropFallback: () => "fallback",
    cinematicBackdropUrl: value => value, artworkQualityKey: value => value, backdropQualityCache: new Map(),
    getWatchBackdropArtwork: value => value.tmdbBackdrop, markArtworkLowQuality() {},
    artworkDimensionsAreUseful: (image, role) => { roles.push(role); return role === "backdrop"; },
    backdropPixelsLookUseful: () => false, ImageResolver: { markImageFailed() {} }
  });
  vm.runInContext(section("function applyWatchBackdrop(", "function compactMetadataLine("), c);
  return { c, nodes, images, roles, show, seasons, art };
}

test("TMDB backdrop aliased as banner is validated as a landscape backdrop", () => {
  const h = backdropHarness();
  h.c.applyWatchBackdrop(h.show, h.seasons[0]);
  h.images[0].onload();
  assert.deepEqual(h.roles, ["backdrop"]);
  assert.equal(h.nodes.watchBackdrop.dataset.backdropUrl, h.art);
  h.c.applyWatchBackdrop(h.show, h.seasons[0]);
  assert.equal(h.images.length, 1, "a warm repeat reuses the successful decode result");
});
test("a genuine banner-only fallback retains its existing aspect validation", () => {
  const h = backdropHarness();
  h.show.tmdbBackdrop = "";
  h.c.getWatchBackdropArtwork = () => h.show.banner;
  h.c.artworkDimensionsAreUseful = (image, role) => { h.roles.push(role); return true; };
  h.c.applyWatchBackdrop(h.show, h.seasons[0]);
  h.images[0].onload();
  assert.deepEqual(h.roles, ["banner"]);
  assert.equal(h.nodes.watchBackdrop.dataset.backdropUrl, h.art);
});
test("late image callbacks cannot paint a different season or title", () => {
  for (const event of ["onload", "onerror"]) {
    const h = backdropHarness();
    h.c.applyWatchBackdrop(h.show, h.seasons[0]);
    h.c.state.activeSeasonIndex = 1;
    h.nodes.watchBackdrop.dataset.backdropUrl = "new-season";
    h.images[0][event]();
    assert.equal(h.nodes.watchBackdrop.dataset.backdropUrl, "new-season");
  }
});
test("cold backdrop shows a visible loading placeholder until decode completes", () => {
  const h = backdropHarness();
  h.c.applyWatchBackdrop(h.show, h.seasons[0]);
  assert.equal(h.nodes.watchBackdropTitleArt.hidden, false);
  assert.equal(h.nodes.watchBackdropTitleArt.classList.contains("is-loading"), true);
  assert.equal(h.nodes.watchBackdropTitleText.textContent, "Neutral title");
  h.images[0].onload();
  assert.equal(h.nodes.watchBackdropTitleArt.hidden, true);
  assert.equal(h.nodes.watchBackdropTitleArt.classList.contains("is-loading"), false);
  assert.match(html, /id="watchBackdrop"[^>]*><\/div>\s*<div[^>]*id="watchBackdropTitleArt"/);
});
test("pending images keep their fade and failed candidate resets readiness", () => {
  const bareRules = [...styles.matchAll(/\.thumb-poster,\s*\.ep-thumb-img\s*\{([^}]+)\}/g)];
  assert.ok(bareRules.length);
  assert.doesNotMatch(bareRules.at(-1)[1], /opacity:\s*1/);
  assert.match(styles, /\.thumb-poster\s*\{[^}]*transition:[^;]*opacity/s);
  const image = { ...node(), dataset: { imageFallbacks: encodeURIComponent(JSON.stringify(["old", "next"])) }, removeAttribute() {}, closest: () => wrap };
  const wrap = node();
  image.classList.add("img-ready"); wrap.classList.add("img-ready");
  const c = vm.createContext({ artworkRoleForImage: () => "poster", isArtworkLowQuality: () => false });
  vm.runInContext(section("function advanceArtworkCandidate(", "function markCurrentArtworkCandidateLowQuality("), c);
  assert.equal(c.advanceArtworkCandidate(image), true);
  assert.equal(image.classList.contains("img-ready"), false);
  assert.equal(wrap.classList.contains("img-ready"), false);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.art-sheen::after[^}]*animation: none !important/s);
});
test("Nia HD correction uses exact identity, not a fuzzy title or another catalog", () => {
  const c = vm.createContext({ isAdultCatalogShow: value => Boolean(value.adult), pickImage: values => values[0] });
  vm.runInContext(section("const HELL_MODE_WATCH_BACKDROP", "// Best wide cinematic backdrop"), c);
  const hd = "https://image.tmdb.org/t/p/original/5obfnImCRn0LzQnRb4jxuCJRlxd.jpg";
  assert.equal(c.curatedWatchBackdrop({ anilistId: 206949 }), hd);
  assert.equal(c.curatedWatchBackdrop({ malId: 63382 }), hd);
  assert.equal(c.curatedWatchBackdrop({ title: "Nia Liston fan title" }), "");
  assert.equal(c.curatedWatchBackdrop({ anilistId: 206949, adult: true }), "");
});

function recoveryHarness(overrides = {}) {
  const timers = new Map(); let serial = 0;
  const calls = [];
  const episode = {};
  const c = vm.createContext({ window: {
    setTimeout: (callback, delay) => { timers.set(++serial, { callback, delay }); return serial; },
    clearTimeout: id => timers.delete(id)
  }, attachPlaybackFailureFallbacks: () => { calls.push("lookup"); return Promise.resolve(); },
  playbackRecoveryProviderKeys: () => [], prepareReliablePlaybackSource: async () => null,
  findVerifiedAdFreeFallbackSource: async () => null, wait: async () => {}, ...overrides });
  vm.runInContext(section("async function findRuntimePlaybackFallback(", "// Full-screen playback-error overlay."), c);
  return { c, timers, calls, episode };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
test("hung runtime recovery ends within a single 15-second overall budget", async () => {
  const h = recoveryHarness({ prepareReliablePlaybackSource: () => new Promise(() => {}) });
  const result = h.c.findRuntimePlaybackFallback({}, h.episode, {});
  await flush();
  assert.equal(h.timers.size, 1);
  const timer = [...h.timers.values()][0];
  assert.equal(timer.delay, 15000);
  timer.callback();
  assert.equal(await result, null);
  assert.equal(h.timers.size, 0);
});
test("recovery accepts an immediate verified backup and clears its timer", async () => {
  const verified = { id: "verified-backup" };
  const h = recoveryHarness({ prepareReliablePlaybackSource: async () => verified });
  assert.equal(await h.c.findRuntimePlaybackFallback({}, h.episode, {}), verified);
  assert.equal(h.timers.size, 0);
});
test("lookup rejection, late verification and navigation cannot trigger more recovery", async () => {
  const rejected = recoveryHarness({ attachPlaybackFailureFallbacks: () => Promise.reject(new Error("provider")), prepareReliablePlaybackSource: async () => { throw new Error("offline"); } });
  assert.equal(await rejected.c.findRuntimePlaybackFallback({}, rejected.episode, {}), null);
  assert.equal(rejected.timers.size, 0);
  let finish;
  let checks = 0;
  const h = recoveryHarness({ prepareReliablePlaybackSource: () => { checks++; return new Promise(resolve => { finish = resolve; }); } });
  const result = h.c.findRuntimePlaybackFallback({}, h.episode, {});
  await flush();
  [...h.timers.values()][0].callback();
  assert.equal(await result, null);
  finish({ id: "late" }); await flush();
  assert.equal(checks, 1);
  const left = recoveryHarness();
  assert.equal(await left.c.findRuntimePlaybackFallback({}, left.episode, {}, { isCurrent: () => false }), null);
  assert.equal(left.calls.length, 0);
});
test("media failure saves progress and releases the old controller before removing its UI", () => {
  const render = section("function renderDirectVideoPlayer(", "async function findRuntimePlaybackFallback(");
  assert.match(render, /saveWatchProgress\(player, episode, \{ force: true \}\);[\s\S]*?_disposeAdjacentWarmup[\s\S]*?renderPlayerPopupMessage/);
  assert.match(render, /findRuntimePlaybackFallback\([\s\S]*?isCurrent:/);
  assert.match(render, /episode\._playbackFallbackPromptActive = false;\s*renderPlaybackError/);
  assert.match(render, /addEventListener\("timeupdate", \(\) => \{\s*if \(recoveringPlayback\) return;/);
  assert.match(render, /addEventListener\("pause", \(\) => \{\s*if \(!recoveringPlayback\) saveWatchProgress/);
  assert.match(render, /addEventListener\("ended", \(\) => \{\s*if \(recoveringPlayback\) return;/);
});
test("the actual error handler saves resume, cleans up once and leaves usable failure controls", async () => {
  const render = section("function renderDirectVideoPlayer(", "async function findRuntimePlaybackFallback(");
  const from = render.indexOf('player?.addEventListener("error", async () => {');
  const handler = render.slice(from, render.indexOf("  const resumeAt", from));
  for (const brokenCleanup of [false, true]) {
    const calls = [];
    const episode = { id: "neutral-episode", number: 2 };
    const show = { id: "neutral-show" };
    const source = { id: "neutral-source" };
    let onError;
    const player = { currentTime: 315, duration: 1440,
      addEventListener: (name, fn) => { onError = fn; },
      _disposeAdjacentWarmup: () => { calls.push("dispose"); if (brokenCleanup) throw new Error("cleanup"); },
      destroy: () => calls.push("destroy") };
    const c = vm.createContext({ player, episode, frame: {}, iframe: {}, selectedSource: source,
      skipShow: show, playbackContext: null, streamType: "file", useApkPlayer: true, recoveringPlayback: false, _activeProgressPlayer: { player, episode },
      state: { activeShow: show, activeEpisode: { episode } },
      console: { error() {}, warn() {} }, getSelectedEpisodeSource: () => source,
      playbackSourceHealthCache: new Map(), playbackSourceHealthKey: () => "source", recordPlaybackFamilyHealth() {},
      saveWatchProgress: (value, ep, options) => { assert.equal(value.currentTime, 315); assert.equal(options.force, true); calls.push("save"); },
      renderPlayerPopupMessage: () => calls.push("spinner"),
      findRuntimePlaybackFallback: async (value, ep, src, options) => { assert.equal(options.isCurrent(), true); calls.push("lookup"); return null; },
      renderPlaybackError: () => { assert.equal(episode._playbackFallbackPromptActive, false); calls.push("error-controls"); }
    });
    vm.runInContext(handler, c);
    await onError();
    assert.equal(calls[0], "save");
    assert.ok(calls.indexOf("dispose") < calls.indexOf("spinner"));
    assert.equal(calls.at(-1), "error-controls");
    assert.equal(episode._playbackFallbackPromptActive, false);
    assert.equal(c._activeProgressPlayer, null);
    const settledCalls = calls.length;
    await onError();
    assert.equal(calls.length, settledCalls, "a second event from the disposed player cannot restart recovery");
  }
});
