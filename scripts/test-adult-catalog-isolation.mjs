import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const modeSource = readFileSync(new URL("../js/adult-mode.js", import.meta.url), "utf8");
const adapterSource = readFileSync(new URL("../js/adult-source-adapter.js", import.meta.url), "utf8");
const client = readFileSync(new URL("../client.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function section(start, end) {
  const from = client.indexOf(start);
  const to = client.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from);
  return client.slice(from, to);
}

function modeHarness() {
  const saved = new Map();
  const c = vm.createContext({
    localStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    document: { body: { classList: { toggle() {} } } }
  });
  vm.runInContext(modeSource + "\nthis.mode = AdultMode;", c);
  return c.mode;
}
const regular = { id: "regular", title: "Neutral Hentai Club", genre: "Comedy" };
const metadataOnly = { id: "metadata-only", title: "Neutral Restricted Metadata", isAdult: true };
const dedicated = { id: "dedicated", title: "Neutral Catalog Entry", isAdult: true, adultSource: "Fixture" };

test("adult mode requires dedicated-source provenance, not words or general metadata", async () => {
  const mode = modeHarness();
  await mode.setEnabled(true, { confirmFn: async () => true });
  assert.deepEqual(Array.from(mode.filterCatalog([regular, metadataOnly, dedicated]), x => x.id), ["dedicated"]);
  assert.equal(mode.matchesActiveCatalog(regular), false);
  assert.equal(mode.matchesActiveCatalog(metadataOnly), false);
  assert.equal(mode.matchesActiveCatalog(dedicated), true);
});

test("invalid provenance and contradictory flags never enter adult mode", async () => {
  const mode = modeHarness();
  await mode.setEnabled(true, { confirmFn: async () => true });
  const invalid = [undefined, null, {}, { ...dedicated, adultSource: " " },
    { ...dedicated, adultSource: {} }, { ...dedicated, isAdult: false }];
  assert.equal(mode.filterCatalog(invalid).length, 0);
});

test("regular-mode exclusions and the explicit age confirmation remain intact", async () => {
  const mode = modeHarness();
  const safe = { id: "safe", title: "Neutral Adventure", genre: "Adventure" };
  assert.equal(await mode.setEnabled(true, { confirmFn: async () => false }), false);
  assert.deepEqual(Array.from(mode.filterCatalog([safe, dedicated, metadataOnly]), x => x.id), ["safe"]);
  assert.equal(mode.hasConfirmedAge(), false);
  assert.equal(await mode.setEnabled(true, { confirmFn: async () => true }), true);
  assert.equal(mode.hasConfirmedAge(), true);
});

test("the header entry uses the same explicit age gate as Settings", async () => {
  const mode = modeHarness();
  let listener;
  let accepted = false;
  let prompts = 0;
  const from = client.indexOf("// Add event listener for the header adult mode toggle button");
  const to = client.indexOf("\n}\n\nasync function ensureSupabaseForAuth", from);
  assert.ok(from >= 0 && to > from);
  vm.runInNewContext(client.slice(from, to), {
    AdultMode: mode,
    document: { querySelector: () => ({ addEventListener: (_event, callback) => { listener = callback; } }) },
    confirmAdultMode: async () => { prompts++; return accepted; },
    syncAdultModeChrome() {}
  });
  await listener();
  assert.equal(mode.isEnabled(), false, "Cancel must leave the regular catalog selected");
  assert.equal(prompts, 1);
  accepted = true;
  await listener();
  assert.equal(mode.isEnabled(), true);
  assert.equal(prompts, 2);
  await listener();
  assert.equal(mode.isEnabled(), false);
  assert.equal(prompts, 2, "leaving adult mode must not prompt");
});

test("catalog request deadlines release a stalled provider without changing detail requests", async () => {
  for (const provider of ["UnderHentaiAdultSourceAdapter", "HentaiOceanAdultSourceAdapter"]) {
    const timers = new Map();
    const requests = [];
    const c = vm.createContext({
      URL, AbortController, DOMException,
      window: { location: { href: "http://localhost/" } },
      setTimeout: (fn, ms) => { const id = timers.size + 1; timers.set(id, { fn, ms }); return id; },
      clearTimeout: id => timers.delete(id),
      fetch: async (_url, options) => {
        requests.push(options);
        if (!options.signal) return { ok: true, json: async () => ({ ok: true }) };
        return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true }));
      }
    });
    vm.runInContext(adapterSource + `\nthis.adapter = new ${provider}();`, c);
    const pending = c.adapter.listLatest();
    pending.catch(() => {});
    assert.equal(timers.size, 1, "every catalog provider needs a finite deadline");
    const rejected = assert.rejects(pending, { name: "AbortError" });
    const timer = [...timers.values()][0];
    assert.equal(timer.ms, 15000);
    timer.fn();
    await rejected;
    assert.equal(timers.size, 0);
    assert.equal(requests.length, 1, "timeout must not create polling or retries");
    await c.adapter._request("/details", { slug: "neutral-entry" });
    assert.equal(requests[1].signal, undefined, "detail/playback transport stays unchanged");
  }
});

test("a stalled JSON body is also aborted and successful requests clear their deadline", async () => {
  const timers = new Map();
  let bodyStarted = false;
  const c = vm.createContext({
    URL, AbortController, DOMException,
    window: { location: { href: "http://localhost/" } },
    setTimeout: (fn, ms) => { timers.set(1, { fn, ms }); return 1; },
    clearTimeout: id => timers.delete(id),
    fetch: async (_url, options) => ({ ok: true, json: () => {
      bodyStarted = true;
      return new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true }));
    } })
  });
  vm.runInContext(adapterSource + "\nthis.adapter = new UnderHentaiAdultSourceAdapter();", c);
  const pending = c.adapter.listLatest();
  pending.catch(() => {});
  await new Promise(setImmediate);
  assert.equal(bodyStarted, true);
  assert.equal(timers.size, 1);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  [...timers.values()][0].fn();
  await rejected;
  assert.equal(timers.size, 0);
  c.fetch = async () => ({ ok: true, json: async () => ({ ok: true, items: [] }) });
  assert.equal((await c.adapter.listLatest()).length, 0);
  assert.equal(timers.size, 0);
});

function loaderHarness({ cached = null, fails = false } = {}) {
  const mode = modeHarness();
  let requests = 0;
  const statuses = [];
  const c = vm.createContext({
    adultCatalogLoadingPromise: null, adultCatalogLoadedAt: 0,
    state: { shows: [regular, metadataOnly], isLoadingCatalog: true },
    AdultMode: mode,
    AdultSourceRegistry: { isConfigured: () => true, get: () => ({
      name: "Fixture", listLatest: async () => { requests++; if (fails) throw new Error("Fixture unavailable"); return [dedicated]; }
    }) },
    readResponseCache: () => null, readDurableAdultCatalog: async () => cached,
    writeDurableAdultCatalog: async () => true, writeResponseCache() {},
    isolateAdultSourceMetadata: x => x, render() {},
    window: { setTimeout() {} },
    setSourceStatus: status => statuses.push(status), catalogStatusLabel: () => "Fixture catalog",
    localStorage: { removeItem() {} },
    CATALOG_CACHE_TTL: 1000, RESPONSE_CACHE_PREFIX: "fixture:", console: { warn() {} }
  });
  vm.runInContext(section("async function loadAdultCatalog(", "async function hydrateAdultShowDetails("), c);
  return { c, mode, statuses, requests: () => requests };
}

test("cold loading replaces misleading cards with dedicated entries without deleting regular metadata", async () => {
  const h = loaderHarness();
  await h.mode.setEnabled(true);
  assert.equal(h.mode.filterCatalog(h.c.state.shows).length, 0);
  await h.c.loadAdultCatalog();
  assert.deepEqual(Array.from(h.mode.filterCatalog(h.c.state.shows), x => x.id), ["dedicated"]);
  assert.ok(h.c.state.shows.some(x => x.id === "regular"), "mode switching must not delete regular records");
  assert.ok(h.c.state.shows.some(x => x.id === "metadata-only"));
  assert.equal(h.requests(), 1);
});

test("total outage shows unavailable rather than unrelated cards and does not mark data fresh", async () => {
  const h = loaderHarness({ fails: true });
  await h.mode.setEnabled(true);
  assert.equal((await h.c.loadAdultCatalog()).length, 0);
  assert.equal(h.mode.filterCatalog(h.c.state.shows).length, 0);
  assert.equal(h.c.adultCatalogLoadedAt, 0);
  assert.equal(h.statuses.at(-1), "Adult catalog is temporarily unavailable");
  assert.equal(h.c.state.isLoadingCatalog, false);
});

test("a failed refresh retains the last-good dedicated catalog without importing cached metadata-only entries", async () => {
  const h = loaderHarness({ cached: [dedicated, metadataOnly], fails: true });
  await h.mode.setEnabled(true);
  const rows = await h.c.loadAdultCatalog();
  assert.deepEqual(Array.from(rows, x => x.id), ["dedicated"]);
  assert.equal(h.c.adultCatalogLoadedAt, 0);
});
