import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const client = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const normalize = readFileSync(new URL("../js/normalize.js", import.meta.url), "utf8");

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing source section: ${start}`);
  return source.slice(from, to);
}

function scheduleFieldHarness(overrides = {}) {
  const instant = Date.UTC(2026, 8, 14, 18, 30);
  const context = vm.createContext({
    Date,
    nextWeeklyAiringFrom: () => instant,
    broadcastInstant: () => instant,
    formatAiringWeekday: () => "Mon",
    formatAiringClock: () => "12:30 PM",
    ...overrides
  });
  vm.runInContext(
    section(client, "function applyScheduleAiringFields(", "function scheduleLocale("),
    context
  );
  return { context, instant };
}

test("schedule derives a visible local day before remote enrichment finishes", () => {
  const { context, instant } = scheduleFieldHarness();
  const show = {
    day: "Local",
    time: "",
    lastEpisodeAt: "2026-09-07T18:30:00.000Z"
  };

  assert.equal(context.applyScheduleAiringFields(show), true);
  assert.equal(show.nextAiringAt, instant);
  assert.equal(show.day, "Mon");
  assert.equal(show.time, "12:30 PM");
});

test("schedule falls back to a known broadcast slot", () => {
  let requestedSlot = null;
  const { context, instant } = scheduleFieldHarness({
    nextWeeklyAiringFrom: () => 0,
    broadcastInstant: (...parts) => {
      requestedSlot = parts;
      return instant;
    }
  });
  const show = {
    day: "TBA",
    broadcastDay: "Mondays",
    broadcastTime: "00:30",
    broadcastTimezone: "Asia/Tokyo"
  };

  context.applyScheduleAiringFields(show);
  assert.deepEqual(requestedSlot, ["Mondays", "00:30", "Asia/Tokyo"]);
  assert.equal(show.day, "Mon");
});

test("catalog changes clear an empty schedule memo", () => {
  const context = vm.createContext({});
  vm.runInContext(
    section(client, "let _scheduleDataRevision", "function scheduleAiringEnrichment("),
    context
  );
  vm.runInContext('_scheduleMemo = { key: "4416:0", at: 1, value: [] }; invalidateScheduleData();', context);

  assert.equal(vm.runInContext("_scheduleDataRevision", context), 1);
  assert.equal(vm.runInContext("_scheduleMemo.value", context), null);
});

test("client catalog merges preserve useful airing fields", () => {
  const context = vm.createContext({
    catalogMetadataRank: () => 0,
    mergeCatalogSourceLabels: (...parts) => parts.filter(Boolean).join(" + "),
    mergeEpisodes: (current) => current || [],
    mergeSeasons: (current) => current || []
  });
  vm.runInContext(
    section(normalize, "function usefulClientAiringValue(", "function mergeShows("),
    context
  );

  const current = {
    id: "anime-1",
    title: "Fixture",
    day: "Monday",
    time: "8:00 PM",
    nextAiringAt: 123456,
    lastEpisodeAt: "2026-09-07T20:00:00.000Z",
    broadcastDay: "Mondays",
    broadcastTime: "20:00",
    broadcastTimezone: "Asia/Tokyo"
  };
  const incoming = {
    id: "metadata-1",
    title: "Fixture",
    day: "Local",
    time: "TBA",
    nextAiringAt: null,
    lastEpisodeAt: "",
    broadcastDay: ""
  };
  const merged = context.mergeClientCatalogShow(current, incoming);

  assert.equal(merged.day, "Monday");
  assert.equal(merged.time, "8:00 PM");
  assert.equal(merged.nextAiringAt, 123456);
  assert.equal(merged.lastEpisodeAt, current.lastEpisodeAt);
  assert.equal(merged.broadcastDay, "Mondays");
});

test("every catalog replacement invalidates schedule data before rendering", () => {
  const replacement = section(client, "function replaceRegularCatalog(", "function regularCatalogSnapshot(");
  const enrichment = section(client, "async function enrichCatalogAiringData(", "async function loadExternalSources(");
  assert.match(replacement, /state\.shows = mergeShows[\s\S]*?invalidateScheduleData\(\)/);
  assert.match(enrichment, /if \(changed\) \{\s*invalidateScheduleData\(\)/);
});
