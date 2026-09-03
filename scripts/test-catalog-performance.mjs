import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { CompositeAdultSourceAdapter } = require("../js/adult-source-adapter.js");
const client = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../animetv-server.js", import.meta.url), "utf8");
const section = (source, start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
};

test("catalog joins normalize each title once instead of scanning every pair", () => {
  const adapter = new CompositeAdultSourceAdapter();
  const primary = Array.from({ length: 2000 }, (_, i) => ({ id: `p${i}`, title: `Series ${i} Alpha` }));
  const secondary = Array.from({ length: 1000 }, (_, i) => ({ id: `s${i}`, title: `Series ${i} Alpha` }));
  let calls = 0;
  const keys = adapter._keys.bind(adapter);
  adapter._keys = item => { calls++; return keys(item); };
  const merged = adapter._mergeCatalogs(primary, secondary);
  assert.equal(merged.length, primary.length);
  assert.equal(calls, primary.length + secondary.length);
  assert.deepEqual(merged.map(item => item.id), primary.map(item => item.id));
});

test("indexed matches preserve first-source ordering across conflicting aliases", () => {
  const adapter = new CompositeAdultSourceAdapter();
  const secondary = [
    { id: "early", title: "Other Title", aliases: ["Shared Alias"] },
    { id: "late", title: "Exact Title" },
    { id: "empty", title: "" }
  ];
  adapter._mergeCatalogs([], secondary);
  for (const item of [
    { title: "Exact Title", aliases: ["Shared Alias"] },
    { title: "EXACT TITLE The Animation" },
    { title: "Missing Title" },
    { title: "" }
  ]) {
    const wanted = adapter._keys(item);
    const previous = secondary.find(candidate => adapter._keys(candidate).some(key => wanted.includes(key))) || null;
    assert.equal(adapter._findExactOceanMatch(item), previous);
  }
});

test("a refreshed source replaces the title index and retains unmatched rows", () => {
  const adapter = new CompositeAdultSourceAdapter();
  adapter._mergeCatalogs([], [{ id: "old", title: "Old Series" }]);
  const next = { id: "new", title: "New Series" };
  const merged = adapter._mergeCatalogs([{ id: "primary", title: "Primary Series" }], [next]);
  assert.deepEqual(merged.map(item => item.id), ["primary", "new"]);
  assert.equal(adapter._findExactOceanMatch({ title: "Old Series" }), null);
  assert.equal(adapter._findExactOceanMatch({ title: "New Series" }), next);
});

function loadHarness({ age = 0, empty = false, fail = false } = {}) {
  const items = [{ id: "fixture", isAdult: true }];
  const now = 1_000_000;
  let requests = 0;
  let reads = 0;
  const c = vm.createContext({
    adultCatalogLoadingPromise: null,
    adultCatalogLoadedAt: now - age,
    Date: { now: () => now },
    state: { shows: empty ? [] : items },
    AdultSourceRegistry: { isConfigured: () => true, get: () => ({ name: "Fixture", listLatest: async () => {
      requests++;
      if (fail) throw new Error("Fixture unavailable");
      return items;
    } }) },
    AdultMode: { isEnabled: () => false, isAdultContent: item => item.isAdult === true },
    isolateAdultSourceMetadata: item => item,
    render() {},
    readResponseCache: () => { reads++; return null; },
    readDurableAdultCatalog: async () => null,
    writeDurableAdultCatalog: async () => true,
    CATALOG_CACHE_TTL: 1000,
    RESPONSE_CACHE_PREFIX: "fixture:",
    localStorage: { removeItem() {} },
    console: { warn() {} }
  });
  vm.runInContext(section(client, "async function loadAdultCatalog(", "async function hydrateAdultShowDetails("), c);
  return { c, requests: () => requests, reads: () => reads, now };
}

test("a recent mode switch reuses memory without reading storage or fetching", async () => {
  const h = loadHarness();
  assert.equal((await h.c.loadAdultCatalog()).length, 1);
  assert.equal(h.requests(), 0);
  assert.equal(h.reads(), 0);
});

test("expired, empty and explicitly refreshed catalogs still fetch", async () => {
  for (const [options, force] of [[{ age: 300001 }, false], [{ empty: true }, false], [{}, true]]) {
    const h = loadHarness(options);
    assert.equal((await h.c.loadAdultCatalog(force)).length, 1);
    assert.equal(h.requests(), 1);
    assert.equal(h.c.adultCatalogLoadedAt, h.now);
  }
});

test("a failed refresh keeps existing cards and does not mark stale data fresh", async () => {
  const h = loadHarness({ age: 400000, fail: true });
  const before = h.c.adultCatalogLoadedAt;
  assert.equal((await h.c.loadAdultCatalog()).length, 1);
  assert.equal(h.c.adultCatalogLoadedAt, before);
  assert.equal(h.c.state.shows.length, 1);
});

test("local-only retired files cannot change the production catalog total", async () => {
  const results = [];
  for (const hasRetiredFile of [false, true]) {
    let retiredReads = 0;
    const c = vm.createContext({
      readUnderHentaiCatalog: () => ({ items: [{ slug: "fixture", title: "Fixture" }], excludedForSafety: 1 }),
      loadLiveUnderHentaiCatalog: async () => [],
      readVeoHentaiCatalog: () => { retiredReads++; return { items: hasRetiredFile ? [{ slug: "retired" }] : [] }; },
      prepareVeoHentaiSnapshotItem: item => item,
      decodeUnderHentaiImage: value => value,
      chooseUnderHentaiDisplayImage: value => value,
      getUnderHentaiArtwork: () => ({ screenshots: [], backgroundArtwork: "" }),
      sendJson: (_response, payload) => results.push(payload),
      log() {}
    });
    vm.runInContext(section(server, "async function handleUnderHentaiCatalog(", "function readXmlValue("), c);
    await c.handleUnderHentaiCatalog(new URL("http://fixture/catalog"), {});
    assert.equal(retiredReads, 0);
  }
  assert.deepEqual(results.map(result => result.count), [1, 1]);
  assert.deepEqual(results.map(result => result.excludedForSafety), [1, 1]);
  assert.match(client, /multi-source-v9/, "retired browser snapshots must not be restored after upgrading");
});
