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
    section(client, "const WEEKLY_SCHEDULE_DAY_OVERRIDES", "function scheduleLocale("),
    context
  );
  return { context, instant };
}

function scheduleNavigationHarness(today = 0) {
  let localDay = (today + 1) % 7;
  class LocalDate extends Date {
    getDay() { return localDay; }
  }
  const listeners = new Map();
  const list = { dataset: {}, innerHTML: "" };
  const context = vm.createContext({
    Date: LocalDate,
    Intl,
    _scheduleSelectedDay: null,
    _scheduleControlsWired: false,
    _scheduleDataRevision: 0,
    _scheduleMemo: { key: "", at: 0, value: null },
    state: {
      route: "home", appLanguage: "en", uiPreferences: { titleLanguage: "en" },
      shows: [
        { id: "fixture-mon", title: "Monday release", day: "Mon", status: "RELEASING" },
        { id: "fixture-tue", title: "Tuesday release", day: "Tue", status: "RELEASING" }
      ]
    },
    scheduleList: list,
    scheduleDays: { addEventListener: (name, callback) => listeners.set(name, callback), setAttribute() {} },
    scheduleKicker: null,
    scheduleCount: {},
    scheduleTimeZone: null,
    requestAnimationFrame() {},
    revealSelectedScheduleDay() {},
    catalogShows: () => context.state.shows,
    applyScheduleAiringFields() {},
    normalizeTitle: title => title,
    weekdayIndexFromName: name => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name),
    scheduleDayName: index => ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][index],
    showAiringTimeText: () => "8:00 PM",
    cardEpisodeLabel: () => "EP 1",
    getShowTitle: show => show.title,
    getCardPosterCandidates: () => [],
    scheduleCardTemplate: show => `<a>${show.title}</a>`,
    escapeHtml: value => value,
    t: key => key,
    syncCompletedArtwork() {},
    APP_ROUTES: ["home", "schedule", "library", "not-found"],
    document: { body: { dataset: {} }, querySelectorAll: () => [] },
    cancelLibraryAutoLoad() {},
    syncRouteVisibility() {},
    scheduleAnimeAv1LatestLoad() {},
    scrollToRoute() {},
    refreshFocusables() {},
    renderNow: () => { if (context.state.route === "schedule") context.renderSchedule(); },
    fetch: () => { throw new Error("day selection must not fetch"); }
  });
  vm.runInContext(section(client, "function renderSchedule()", "function renderAniPubCatalog()"), context);
  vm.runInContext(section(client, "let _routeHistoryInit = false;", "function syncRouteVisibility()"), context);
  return {
    context, list,
    setToday: index => { localDay = (index + 1) % 7; },
    select: index => listeners.get("click")({ target: { closest: () => ({ dataset: { scheduleDay: String(index) } }) } })
  };
}

test("every schedule visit selects the viewer's current local day, including Sunday", () => {
  const { context, list, select, setToday } = scheduleNavigationHarness(0);
  context.setRoute("schedule", { skipHistory: true });
  assert.equal(context._scheduleSelectedDay, 0);
  assert.match(list.innerHTML, /Monday release/);
  assert.doesNotMatch(list.innerHTML, /Tuesday release/);

  select(-1);
  assert.equal(context._scheduleSelectedDay, -1, "All Days remains available explicitly");
  assert.match(list.innerHTML, /Tuesday release/);
  context.renderSchedule();
  assert.equal(context._scheduleSelectedDay, -1, "metadata rerenders must preserve the chosen filter");

  context.setRoute("home", { skipHistory: true });
  setToday(6);
  context.setRoute("schedule", { skipHistory: true });
  assert.equal(context._scheduleSelectedDay, 6, "a new visit recalculates today after a date change");
  assert.match(list.innerHTML, /scheduleNoEpisodes/);
  select(-1);
  context.setRoute("schedule", { skipHistory: true });
  assert.equal(context._scheduleSelectedDay, 6, "clicking Schedule again also returns to today");
});

test("an empty today stays selected while catalog metadata arrives", () => {
  const { context, list, select } = scheduleNavigationHarness(2);
  context.setRoute("schedule", { skipHistory: true });
  assert.equal(context._scheduleSelectedDay, 2);
  assert.match(list.innerHTML, /scheduleNoEpisodes/);

  context.state.shows.push({ id: "fixture-wed", title: "Wednesday release", day: "Wed", status: "RELEASING" });
  context._scheduleDataRevision++;
  context.renderSchedule();
  assert.equal(context._scheduleSelectedDay, 2);
  assert.match(list.innerHTML, /Wednesday release/);
  assert.doesNotMatch(list.innerHTML, /Monday release/);
  select(0);
  context.renderSchedule();
  assert.equal(context._scheduleSelectedDay, 0, "manual weekday choices remain selected until navigation");
});

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

test("an exact next-airing timestamp wins over recurring and upload fallbacks", () => {
  const exactInstant = Date.UTC(2026, 9, 19, 14, 0);
  const { context } = scheduleFieldHarness({
    nextWeeklyAiringFrom: () => {
      throw new Error("upload fallback should not run");
    },
    broadcastInstant: () => {
      throw new Error("broadcast fallback should not run");
    }
  });
  const show = { nextAiringAt: exactInstant };
  const source = {
    nextAiringAt: 0,
    broadcastDay: "Fridays",
    broadcastTime: "23:00",
    broadcastTimezone: "Asia/Tokyo",
    lastEpisodeAt: "2026-09-12T15:24:20.000Z"
  };

  context.applyScheduleAiringFields(show, source);
  assert.equal(show.nextAiringAt, exactInstant);
});

test("fresh airing enrichment replaces a stale exact timestamp", () => {
  const staleInstant = Date.UTC(2026, 8, 12, 14, 0);
  const refreshedInstant = Date.UTC(2026, 9, 19, 14, 0);
  const { context } = scheduleFieldHarness({
    broadcastInstant: () => {
      throw new Error("broadcast fallback should not run");
    }
  });
  const show = { nextAiringAt: staleInstant };
  const source = { nextAiringAt: refreshedInstant };

  context.applyScheduleAiringFields(show, source);
  assert.equal(show.nextAiringAt, refreshedInstant);
});

test("Bleach keeps its corrected Friday slot during a one-off AniList delay", () => {
  const delayedMonday = Date.UTC(2026, 9, 19, 14, 0);
  const { context } = scheduleFieldHarness();
  const show = { id: "animeav1-bleach-sennen-kessen-hen-kashin-tan" };

  context.applyScheduleAiringFields(show, { nextAiringAt: delayedMonday });
  assert.equal(show.nextAiringAt, delayedMonday);
  assert.equal(show.day, "Fri");
});

test("a recurring broadcast slot wins over a late provider upload", () => {
  let uploadFallbackCalls = 0;
  const broadcastAt = Date.UTC(2026, 8, 18, 14, 0);
  const { context } = scheduleFieldHarness({
    broadcastInstant: () => broadcastAt,
    nextWeeklyAiringFrom: () => {
      uploadFallbackCalls += 1;
      return Date.UTC(2026, 8, 19, 18, 0);
    }
  });
  const show = {};
  const source = {
    broadcastDay: "Fridays",
    broadcastTime: "23:00",
    broadcastTimezone: "Asia/Tokyo",
    lastEpisodeAt: "2026-09-12T15:24:20.000Z"
  };

  context.applyScheduleAiringFields(show, source);
  assert.equal(show.nextAiringAt, broadcastAt);
  assert.equal(uploadFallbackCalls, 0);
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
    broadcastTimezone: "Asia/Tokyo",
    episodeThumbnailFallback: "https://cdn.example.com/exact-landscape.jpg"
  };
  const incoming = {
    id: "metadata-1",
    title: "Fixture",
    day: "Local",
    time: "TBA",
    nextAiringAt: null,
    lastEpisodeAt: "",
    broadcastDay: "",
    episodeThumbnailFallback: ""
  };
  const merged = context.mergeClientCatalogShow(current, incoming);

  assert.equal(merged.day, "Monday");
  assert.equal(merged.time, "8:00 PM");
  assert.equal(merged.nextAiringAt, 123456);
  assert.equal(merged.lastEpisodeAt, current.lastEpisodeAt);
  assert.equal(merged.broadcastDay, "Mondays");
  assert.equal(merged.episodeThumbnailFallback, current.episodeThumbnailFallback);
});

test("every catalog replacement invalidates schedule data before rendering", () => {
  const replacement = section(client, "function replaceRegularCatalog(", "function regularCatalogSnapshot(");
  const enrichment = section(client, "async function enrichCatalogAiringData(", "async function loadExternalSources(");
  assert.match(replacement, /state\.shows = mergeShows[\s\S]*?invalidateScheduleData\(\)/);
  assert.match(enrichment, /if \(Number\(it\.nextAiringAt \|\| 0\) > 0\) s\.nextAiringAt = Number\(it\.nextAiringAt\)/);
  assert.match(enrichment, /if \(changed\) \{\s*invalidateScheduleData\(\)/);
});
