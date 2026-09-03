import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const client = readFileSync(new URL("../client.js", import.meta.url), "utf8");
function section(start, end) {
  const from = client.indexOf(start);
  const to = client.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from);
  return client.slice(from, to);
}

function scheduler() {
  let now = 0;
  let id = 0;
  const timers = new Map();
  const frames = [];
  const idle = [];
  return {
    window: {
      setTimeout(fn, delay = 0) { timers.set(++id, { fn, at: now + delay }); return id; },
      clearTimeout(key) { timers.delete(key); },
      requestAnimationFrame(fn) { frames.push(fn); },
      requestIdleCallback(fn) { idle.push(fn); }
    },
    performance: { now: () => now },
    frame() { frames.splice(0).forEach(fn => fn()); },
    idle() { idle.splice(0).forEach(fn => fn()); },
    async advance(ms) {
      now += ms;
      for (const [key, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(key);
        timer.fn();
      }
      await Promise.resolve();
      await Promise.resolve();
    }
  };
}

function modeHarness(cached = false) {
  const clock = scheduler();
  const events = [];
  let enabled = true;
  let finish;
  const load = new Promise(resolve => { finish = resolve; });
  const c = vm.createContext({
    ...clock,
    state: { isLoadingCatalog: false },
    console: { warn() {} },
    AdultMode: { isEnabled: () => enabled },
    resetCatalogModeControls: () => events.push("reset"),
    syncAdultModeChrome: () => events.push("theme"),
    catalogShows: () => cached ? [{ id: "fixture" }] : [],
    refreshCatalogStatus: () => events.push("status"),
    renderNow: () => events.push("paint"),
    render: () => events.push("refresh"),
    loadAdultCatalog: () => { events.push("load"); return load; }
  });
  vm.runInContext(section("let catalogModeChangeGeneration =", "// Restore the saved 18+ mode"), c);
  return { c, clock, events, finish, disable: () => { enabled = false; c.handleCatalogModeChange(false); } };
}

test("mode switches paint cached cards before any catalog refresh starts", async () => {
  const h = modeHarness(true);
  h.c.handleCatalogModeChange(true);
  assert.deepEqual(h.events, ["reset", "theme", "status", "paint"]);
  assert.equal(h.c.state.isLoadingCatalog, false);
  h.clock.frame();
  assert.equal(h.events.includes("load"), false);
  await h.clock.advance(0);
  assert.equal(h.events.at(-1), "load");
  h.finish();
  await h.clock.advance(0);
  assert.equal(h.events.at(-1), "refresh");
});

test("a cold mode switch renders loading placeholders immediately", async () => {
  const h = modeHarness();
  h.c.handleCatalogModeChange(true);
  assert.equal(h.c.state.isLoadingCatalog, true);
  assert.equal(h.events.at(-1), "paint");
  h.clock.frame();
  await h.clock.advance(0);
  h.finish();
  await h.clock.advance(0);
  assert.equal(h.c.state.isLoadingCatalog, false);
});

test("switching back cancels a queued mode refresh", async () => {
  const h = modeHarness(true);
  h.c.handleCatalogModeChange(true);
  h.disable();
  h.clock.frame();
  await h.clock.advance(0);
  assert.equal(h.events.includes("load"), false);
});

test("an old refresh cannot repaint the newly selected mode", async () => {
  const h = modeHarness(true);
  h.c.handleCatalogModeChange(true);
  h.clock.frame();
  await h.clock.advance(0);
  h.disable();
  const count = h.events.length;
  h.finish();
  await h.clock.advance(0);
  assert.equal(h.events.length, count);
});

function libraryHarness() {
  const clock = scheduler();
  const classes = new Set();
  const c = vm.createContext({
    ...clock,
    state: { route: "library", libraryQuerySig: "regular", libraryVisibleLimit: 84 },
    LIBRARY_RENDER_STEP: 28,
    libraryGrid: { dataset: { hasMore: "true", totalCards: "140", visibleCards: "84" },
      scrollWidth: 1400, clientWidth: 1000, scrollLeft: 400,
      setAttribute(key, value) { this[key] = value; } },
    libraryAutoLoader: { hidden: true, classList: { add: key => classes.add(key), remove: key => classes.delete(key) } },
    libraryAutoLoaderStatus: { textContent: "" },
    renderNow: () => {}
  });
  vm.runInContext(section("let libraryAutoLoadObserver =", "function observeLibraryScrollSentinel("), c);
  return { c, clock, classes };
}

test("library feedback paints before appending and never delays the next batch", async () => {
  const { c, clock, classes } = libraryHarness();
  c.requestNextLibraryBatch();
  assert.equal(c.libraryAutoLoader.hidden, false);
  assert.equal(c.libraryAutoLoaderStatus.textContent, "Loading titles");
  assert.equal(c.libraryGrid["aria-busy"], "true");
  assert.equal(c.state.libraryVisibleLimit, 84);
  c.requestNextLibraryBatch();
  clock.frame();
  clock.idle();
  assert.equal(c.state.libraryVisibleLimit, 112);
  assert.equal(c.libraryGrid["aria-busy"], "false");
  assert.equal(c.libraryAutoLoaderStatus.textContent, "Titles ready");
  assert.equal(classes.has("is-complete"), true);
  await clock.advance(449);
  assert.equal(c.libraryAutoLoader.hidden, false);
  c.setLibraryAutoLoadPending(false);
  await clock.advance(1);
  assert.equal(c.libraryAutoLoader.hidden, true);
});

test("changing filters cancels stale queued batches and their indicator", () => {
  const { c, clock } = libraryHarness();
  c.requestNextLibraryBatch();
  clock.frame();
  c.cancelLibraryAutoLoad();
  c.state.libraryQuerySig = "new-filter";
  clock.idle();
  assert.equal(c.state.libraryVisibleLimit, 84);
  assert.equal(c.libraryAutoLoader.hidden, true);
  assert.equal(c.libraryGrid["aria-busy"], "false");
});

test("scrolling still requests a batch when the intersection callback fired too early", () => {
  const { c, clock } = libraryHarness();
  let intersect;
  let scroll;
  const Observer = class {
    constructor(callback) { intersect = callback; }
    observe() {}
  };
  c.IntersectionObserver = Observer;
  c.window.IntersectionObserver = Observer;
  c.libraryGrid.addEventListener = (type, listener) => { if (type === "scroll") scroll = listener; };
  c.libraryGrid.scrollWidth = 3000;
  c.libraryGrid.scrollLeft = 0;
  vm.runInContext(section("function observeLibraryScrollSentinel(", "function ensureLibraryScrollSentinel("), c);
  c.observeLibraryScrollSentinel({});
  intersect([{ isIntersecting: true }]);
  assert.equal(c.libraryAutoLoader.hidden, true);
  assert.equal(typeof scroll, "function");
  c.libraryGrid.scrollLeft = 1900;
  scroll();
  clock.frame();
  assert.equal(c.libraryAutoLoader.hidden, false);
  clock.frame();
  clock.idle();
  assert.equal(c.state.libraryVisibleLimit, 112);
});

test("the last batch finishes with no extra requests", async () => {
  const { c, clock } = libraryHarness();
  c.libraryGrid.dataset.visibleCards = "130";
  c.renderNow = () => { c.libraryGrid.dataset.hasMore = "false"; };
  c.requestNextLibraryBatch();
  clock.frame();
  clock.idle();
  assert.equal(c.state.libraryVisibleLimit, 140);
  await clock.advance(450);
  c.requestNextLibraryBatch();
  assert.equal(c.libraryAutoLoader.hidden, true);
});

test("loading feedback respects the app's reduced-motion preference", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /body\.reduce-motion \.library-auto-loader-track > span\s*\{[^}]*animation: none/);
});
