import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const client = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const normalize = readFileSync(new URL("../js/normalize.js", import.meta.url), "utf8");
const require = createRequire(import.meta.url);

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing source section: ${start}`);
  return source.slice(from, to);
}

function discoveryRefreshHarness() {
  let now = Date.UTC(2026, 9, 5, 12);
  let id = 0;
  const timers = new Map();
  const calls = [];
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    console: { warn() {} },
    document: { visibilityState: "visible" }, overlay: { hidden: true },
    state: { route: "home", av1LatestAt: now }, adult: false,
    AdultMode: { isEnabled: () => context.adult },
    window: { clearTimeout: timer => timers.delete(timer), setTimeout: (callback, delay) => {
      timers.set(++id, { callback, delay }); return id;
    } },
    loadAnimeAv1Latest: async () => { calls.push("latest"); context.state.av1LatestAt = now; },
    enrichCatalogAiringData: async () => { calls.push("airing"); },
    invalidateScheduleData: () => calls.push("invalidate"),
    renderSchedule: () => calls.push("schedule"), renderCarousel: () => calls.push("carousel")
  });
  vm.runInContext(section(client, "const DISCOVERY_RELEASE_REFRESH_MS", "function scheduleAnimeAv1LatestLoad("), context);
  return { context, timers, calls, advance: ms => { now += ms; } };
}

test("open discovery pages refresh with one timer and resume stale data without polling hidden pages", async () => {
  const h = discoveryRefreshHarness();
  h.context.scheduleDiscoveryReleaseRefresh();
  h.context.scheduleDiscoveryReleaseRefresh();
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].delay, 15 * 60000);
  h.context.document.visibilityState = "hidden";
  h.context.scheduleDiscoveryReleaseRefresh();
  assert.equal(h.timers.size, 0);
  h.advance(60 * 60000);
  h.context.document.visibilityState = "visible";
  h.context.scheduleDiscoveryReleaseRefresh();
  assert.equal([...h.timers.values()][0].delay, 1000);
  h.timers.clear();
  await h.context.refreshDiscoveryReleases();
  assert.deepEqual(h.calls, ["latest", "airing", "invalidate", "carousel"]);
  assert.equal(h.timers.size, 1);
  h.context.state.route = "schedule";
  h.timers.clear(); h.calls.length = 0;
  await h.context.refreshDiscoveryReleases();
  assert.equal(h.calls.at(-1), "schedule");
});

test("discovery refresh makes no requests during playback, other routes or adult mode", async () => {
  for (const setup of [h => { h.context.overlay.hidden = false; },
    h => { h.context.state.route = "library"; }, h => { h.context.adult = true; },
    h => { h.context.document.visibilityState = "hidden"; }]) {
    const h = discoveryRefreshHarness(); setup(h);
    await h.context.refreshDiscoveryReleases();
    assert.deepEqual(h.calls, []);
  }
});

test("failed discovery refresh waits a full interval instead of retrying aggressively", async () => {
  const h = discoveryRefreshHarness();
  h.context.loadAnimeAv1Latest = async () => { throw new Error("offline"); };
  await h.context.refreshDiscoveryReleases();
  assert.equal([...h.timers.values()][0].delay, 15 * 60000);
});

test("airing metadata coalesces installs, refreshes hourly and preserves the last good week on failure", async () => {
  let now = Date.UTC(2026, 9, 5, 12);
  let calls = 0;
  let release;
  let failed = false;
  const pending = new Promise(resolve => { release = resolve; });
  const rows = [{ id: "neutral", animeytScheduleAt: now + 86400000 }];
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    fetchWithTimeout: async () => {
      calls++; if (calls === 1) await pending;
      return { ok: !failed, json: async () => ({ items: rows }) };
    }
  });
  vm.runInContext(section(client, "const CATALOG_AIRING_REFRESH_MS", "async function enrichCatalogAiringData("), context);
  const requests = Array.from({ length: 8 }, () => context.loadCatalogAiringRows());
  assert.equal(calls, 1); release();
  for (const response of await Promise.all(requests)) assert.deepEqual(response, rows);
  now += 15 * 60000;
  assert.deepEqual(await context.loadCatalogAiringRows(), rows);
  assert.equal(calls, 1);
  now += 45 * 60000; failed = true;
  assert.deepEqual(await context.loadCatalogAiringRows(), rows);
  assert.equal(calls, 2);
  await context.loadCatalogAiringRows(); assert.equal(calls, 2);
  now += 60 * 60000; failed = false;
  await context.loadCatalogAiringRows(); assert.equal(calls, 3);
});

test("online daily and hourly updates validate schedule and carousel before publishing matching assets", () => {
  for (const name of ["scrape-catalog", "refresh-latest-artwork"]) {
    const workflow = readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8");
    assert.match(workflow, /on:[\s\S]*schedule:[\s\S]*cron:/);
    const index = workflow.indexOf("node scripts/build-animeyt-index.mjs");
    const bootstrap = workflow.lastIndexOf("node scripts/build-homepage-bootstrap.mjs");
    const publish = workflow.indexOf("bash scripts/commit-catalog-update.sh");
    assert.ok(index > 0 && bootstrap > index && publish > bootstrap);
    assert.ok(workflow.indexOf("scripts/test-schedule-stability.mjs") < publish);
    assert.ok(workflow.indexOf("scripts/test-carousel-admission.mjs") < publish);
    assert.match(workflow, /changes_detected == 'true'/);
  }
});

function scheduleFieldHarness(overrides = {}) {
  const instant = Date.UTC(2026, 8, 14, 18, 30);
  class ScheduleDate extends Date {
    static now() { return Date.UTC(2026, 9, 5, 12); }
  }
  const context = vm.createContext({
    Date: ScheduleDate,
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

function scheduleNavigationHarness(today = 0) {
  let localDay = (today + 1) % 7;
  let latestLoads = 0;
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
    HOME_CARD_LIMIT: 54,
    buildAnimeAv1ReleaseCards: () => [],
    applyScheduleAiringFields() {},
    normalizeTitle: title => title,
    animeAv1CatalogSlugForShow: show => show.animeAv1Slug || "",
    weekdayIndexFromName: name => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name),
    scheduleDayName: index => ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][index],
    showAiringTimeText: () => "8:00 PM",
    formatAiringClock: date => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Denver" }).format(date),
    cardEpisodeLabel: () => "EP 1",
    getShowTitle: show => show.title,
    getCardPosterCandidates: () => [],
    imageDeliveryUrl: url => url,
    scheduleCardTemplate: show => `<a>${show.title}</a>`,
    escapeHtml: value => value,
    t: key => key,
    syncCompletedArtwork() {},
    APP_ROUTES: ["home", "schedule", "library", "not-found"],
    document: { body: { dataset: {} }, querySelectorAll: () => [] },
    cancelLibraryAutoLoad() {},
    syncRouteVisibility() {},
    scheduleAnimeAv1LatestLoad() { latestLoads++; },
    scheduleDiscoveryReleaseRefresh() {},
    scrollToRoute() {},
    refreshFocusables() {},
    renderNow: () => { if (context.state.route === "schedule") context.renderSchedule(); },
    fetch: () => { throw new Error("day selection must not fetch"); }
  });
  vm.runInContext(section(client, "function scheduleAiringTimeText(", "function scheduleCardTemplate("), context);
  vm.runInContext(section(client, "function renderSchedule()", "function renderAniPubCatalog()"), context);
  vm.runInContext(section(client, "let _routeHistoryInit = false;", "function syncRouteVisibility()"), context);
  return {
    context, list, latestLoads: () => latestLoads,
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

test("an open schedule follows local midnight without losing All Days or another weekday choice", () => {
  const h = scheduleNavigationHarness(0);
  h.context.setRoute("schedule", { skipHistory: true });
  h.setToday(1); h.context.renderSchedule();
  assert.equal(h.context._scheduleSelectedDay, 1);
  h.select(-1); h.setToday(2); h.context.renderSchedule();
  assert.equal(h.context._scheduleSelectedDay, -1);
  h.select(0); h.setToday(3); h.context.renderSchedule();
  assert.equal(h.context._scheduleSelectedDay, 0);
});

test("all seven weekday filters and All Days retain their releases without new feed requests", () => {
  const h = scheduleNavigationHarness();
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  h.context.state.shows = days.map((day, index) => ({
    id: `fixture-${index}`, title: `${day} fixture release`, day, status: "RELEASING"
  }));
  h.context.setRoute("schedule", { skipHistory: true });
  for (let index = 0; index < days.length; index++) {
    h.select(index);
    assert.equal(h.context._scheduleSelectedDay, index);
    assert.match(h.list.innerHTML, new RegExp(`${days[index]} fixture release`));
    for (const other of days.filter(day => day !== days[index])) {
      assert.doesNotMatch(h.list.innerHTML, new RegExp(`${other} fixture release`));
    }
  }
  h.select(-1);
  for (const day of days) assert.match(h.list.innerHTML, new RegExp(`${day} fixture release`));
  assert.equal(h.latestLoads(), 1, "weekday and All Days navigation must reuse the loaded feed");
});

test("schedule posters deduplicate delivered URLs and skip a failed CDN size", () => {
  const failed = new Set();
  const c = vm.createContext({
    getCardPosterCandidates: () => ["https://cdn.example/w780/primary.jpg", "https://cdn.example/original/primary.jpg", "https://cdn.example/backup.jpg"],
    imageDeliveryUrl: url => url.replace(/\/(?:w780|original)\//, "/w500/"),
    ImageResolver: { isImageFailed: url => failed.has(url) }
  });
  vm.runInContext(section(client, "function getSchedulePosterCandidates(", "function scheduleCardTemplate("), c);
  assert.deepEqual(Array.from(c.getSchedulePosterCandidates({})), ["https://cdn.example/w500/primary.jpg", "https://cdn.example/backup.jpg"]);
  failed.add("https://cdn.example/w500/primary.jpg");
  assert.deepEqual(Array.from(c.getSchedulePosterCandidates({})), ["https://cdn.example/backup.jpg"]);
  assert.equal(failed.has("https://cdn.example/w780/primary.jpg"), false, "the original and delivered URL can differ");
});

test("a new backup poster refreshes a schedule card even when its primary stays unchanged", () => {
  const h = scheduleNavigationHarness();
  let candidates = ["https://cdn.example/primary.jpg"];
  const failed = new Set();
  h.context.getCardPosterCandidates = () => candidates;
  h.context.ImageResolver = { isImageFailed: url => failed.has(url) };
  h.context.renderSchedule();
  const initial = h.list.dataset.schedSig;
  h.context.renderSchedule();
  assert.equal(h.list.dataset.schedSig, initial, "unchanged metadata still skips DOM reconstruction");
  candidates = [...candidates, "https://cdn.example/backup.jpg"];
  h.context.renderSchedule();
  assert.notEqual(h.list.dataset.schedSig, initial);
  const updated = h.list.dataset.schedSig;
  failed.add(candidates[0]);
  h.context.renderSchedule();
  assert.notEqual(h.list.dataset.schedSig, updated);
  assert.doesNotMatch(h.list.dataset.schedSig, /primary\.jpg/);
  assert.match(h.list.dataset.schedSig, /backup\.jpg/);
});

test("opening the schedule directly invokes the existing cache-aware latest loader, not on day clicks", () => {
  const h = scheduleNavigationHarness();
  h.context.setRoute("schedule", { skipHistory: true });
  assert.equal(h.latestLoads(), 1);
  h.select(2);
  h.context.renderSchedule();
  assert.equal(h.latestLoads(), 1, "changing the weekday must not fetch another feed");
});

test("schedule visits reuse a fresh latest feed and coalesce simultaneous cold loads", async () => {
  const now = Date.UTC(2026, 9, 5, 20);
  let requests = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const items = [{ slug: "neutral-release", episode: 2, releasedAt: new Date(now).toISOString() }];
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    state: { shows: [], av1Latest: items, av1LatestAt: now, av1LatestLoading: false },
    readAnimeAv1LatestCache: () => null,
    fetchWithTimeout: async () => { requests++; await pending; return { ok: true, json: async () => ({ items }) }; },
    reconcileAnimeAv1LatestInventory() {},
    writeAnimeAv1LatestCache() {},
    resetReleaseCarouselLineup() {},
    render() {},
    scheduleVisibleMetadataWarm() {},
    buildLatestEpisodesList: () => [],
    HOME_INITIAL_CARD_LIMIT: 24,
    console
  });
  vm.runInContext(section(client, "async function loadAnimeAv1Latest(", "function hqImage("), context);
  await context.loadAnimeAv1Latest();
  assert.equal(requests, 0, "home-to-schedule navigation should reuse the same fresh feed");
  context.state.av1LatestAt = now - 6 * 60000;
  const loads = Array.from({ length: 25 }, () => context.loadAnimeAv1Latest());
  assert.equal(requests, 1);
  release();
  await Promise.all(loads);
  await context.loadAnimeAv1Latest();
  assert.equal(requests, 1);
});

test("new latest-feed releases enter today's calendar before the full catalog refresh", () => {
  const { context, list } = scheduleNavigationHarness(0);
  context.state.shows = [];
  let latest = [];
  context.buildAnimeAv1ReleaseCards = (_limit, options) => {
    assert.equal(options.applyUiFilters, false, "homepage search filters must not hide calendar releases");
    return latest;
  };
  context.renderSchedule();
  assert.match(list.innerHTML, /scheduleNoEpisodes/);
  latest = [{ id: "new-release", title: "New Monday release", day: "Mon", status: "RELEASING" }];
  context.state.av1LatestAt = 1;
  context.renderSchedule();
  assert.match(list.innerHTML, /New Monday release/);
  assert.equal(context.scheduleCount.textContent, "1 scheduleEpisodes · Monday · scheduleToday");
  context.state.shows.push(...latest);
  context.renderSchedule();
  assert.equal((list.innerHTML.match(/New Monday release/g) || []).length, 1);
  latest[0].status = "FINISHED";
  context.state.av1LatestAt = 2;
  context.renderSchedule();
  assert.match(list.innerHTML, /scheduleNoEpisodes/);
});

test("latest provider slots replace duplicate metadata clocks while preserving the catalog identity", () => {
  const h = scheduleNavigationHarness();
  h.context.state.shows = [{ id: "catalog-title", title: "Canonical Release", animeAv1Slug: "neutral-release",
    status: "RELEASING", day: "Sun", time: "6:30 AM" }];
  h.context.buildAnimeAv1ReleaseCards = () => [{ id: "feed-title", title: "Provider Release", animeAv1Slug: "neutral-release",
    status: "RELEASING", day: "Mon", time: "7:00 AM", animeytScheduleAt: 123456 }];
  h.context.renderSchedule();
  assert.equal(h.context.scheduleCount.textContent, "1 scheduleEpisodes · Monday · scheduleToday");
  const [show] = h.context._scheduleMemo.value;
  assert.equal(show.id, "catalog-title");
  assert.equal(show.title, "Canonical Release");
  assert.equal(show.day, "Mon");
  assert.equal(show.time, "7:00 AM");
  assert.equal(h.context._scheduleMemo.value.length, 1);
});

test("completed provider slots stay visible after a next-episode refresh without changing its instant", () => {
  const now = Date.parse("2026-10-06T02:00:00Z");
  const at = Date.parse("2026-10-06T01:30:00Z");
  const future = Date.parse("2026-10-11T01:30:00Z");
  const utils = require("../js/utils.js");
  const { context } = scheduleFieldHarness({
    Date: class extends Date { static now() { return now; } },
    formatAiringWeekday: date => new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "America/Denver" }).format(date),
    formatAiringClock: date => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Denver" }).format(date),
    animeYTConfirmedAiringInstant: show => utils.animeYTConfirmedAiringInstant(show, now),
    broadcastInstant: () => { throw new Error("must not guess another slot"); },
    nextWeeklyAiringFrom: () => { throw new Error("must not invent an upcoming release"); }
  });
  const show = { nextAiringAt: future, nextAiringEpisodeNumber: 3, episode: 2 };
  context.applyScheduleAiringFields(show, { animeytScheduleAt: at, nextAiringAt: future });
  assert.equal(show.day, "Mon");
  assert.equal(show.time, "7:30 PM");
  assert.equal(show.nextAiringAt, future);
  assert.equal(show.nextAiringEpisodeNumber, 3);
  assert.equal(context.applyScheduleAiringFields(show, { nextAiringAt: future }), false);
  const newShow = {};
  context.applyScheduleAiringFields(newShow, { animeytScheduleAt: at, lastEpisodeAt: "2026-10-06T04:00:00Z" });
  assert.equal(newShow.day, "Mon");
  assert.equal(newShow.time, "7:30 PM");
  assert.equal(newShow.nextAiringAt, undefined);
});

test("rendered calendar cards use the provider slot, not a different next-episode clock", () => {
  const at = Date.parse("2026-10-05T14:20:00Z");
  const context = vm.createContext({
    Date,
    formatAiringClock: date => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Denver" }).format(date),
    showAiringTimeText: () => "8:00 AM",
    getCardTarget: () => ({ seasonNumber: 1, episodeNumber: 2 }),
    getShowTitle: show => show.title,
    getCardPosterCandidates: () => [],
    imageDeliveryUrl: url => url,
    animePathForShow: () => "/anime/neutral-series",
    cardEpisodeLabel: () => "EP 2",
    escapeHtml: value => String(value),
    t: key => key
  });
  vm.runInContext(section(client, "function scheduleAiringTimeText(", "function renderSchedule()"), context);
  const show = { id: "neutral-series", title: "Neutral Series", animeytScheduleAt: at,
    nextAiringAt: Date.parse("2026-10-11T14:00:00Z") };
  assert.match(context.scheduleCardTemplate(show, 0), /<time>8:20 AM<\/time>/);
  assert.match(context.scheduleCardTemplate({ ...show, animeytScheduleAt: 0 }, 0), /<time>8:00 AM<\/time>/);
  assert.match(context.scheduleCardTemplate({ ...show, animeytScheduleAt: Infinity }, 0), /<time>8:00 AM<\/time>/);

  const h = scheduleNavigationHarness();
  h.context.state.shows = [{ ...show, day: "Mon", status: "RELEASING" }];
  h.context.renderSchedule();
  const previousSignature = h.list.dataset.schedSig;
  assert.match(previousSignature, /8:20 AM/);
  h.context.state.shows[0].animeytScheduleAt = at + 10 * 60000;
  h.context.renderSchedule();
  assert.notEqual(h.list.dataset.schedSig, previousSignature, "a provider clock correction must redraw the cards");
  assert.match(h.list.dataset.schedSig, /8:30 AM/);
});

test("invalid and expired calendar carriers cannot hide a valid next-airing slot", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");
  const future = now + 86400000;
  const { context } = scheduleFieldHarness({ Date: class extends Date { static now() { return now; } } });
  for (const at of [NaN, Infinity, -1, now - 7 * 86400000, now + 7 * 86400000]) {
    const show = { animeytScheduleAt: at, nextAiringAt: future };
    context.applyScheduleAiringFields(show);
    assert.equal(show.nextAiringAt, future);
    assert.equal(show.animeytScheduleAt, 0);
    assert.equal(show.day, "Mon");
  }
  const expired = { animeytScheduleAt: now - 7 * 86400000, day: "Mon", time: "7:00 AM" };
  context.applyScheduleAiringFields(expired);
  assert.equal(expired.day, "TBA");
  assert.equal(expired.time, "");
  assert.equal(expired.animeytScheduleAt, 0);
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

test("the schedule weekday and clock follow the same instant, including Bleach", () => {
  const delayedMonday = Date.UTC(2026, 9, 19, 14, 0);
  const { context } = scheduleFieldHarness();
  const show = { id: "animeav1-bleach-sennen-kessen-hen-kashin-tan" };

  context.applyScheduleAiringFields(show, { nextAiringAt: delayedMonday });
  assert.equal(show.nextAiringAt, delayedMonday);
  assert.equal(show.day, "Mon");
});

test("an expired baked instant falls back to the declared broadcast slot", () => {
  const { context, instant } = scheduleFieldHarness();
  const show = { nextAiringAt: Date.UTC(2026, 8, 12), day: "Sat", time: "8:00 AM",
    broadcastDay: "Mondays", broadcastTime: "00:30", broadcastTimezone: "Asia/Tokyo" };
  context.applyScheduleAiringFields(show);
  assert.equal(show.nextAiringAt, instant);
  assert.equal(show.day, "Mon");
  assert.equal(show.time, "12:30 PM");
});

test("expired or invalid timestamps without trustworthy fallbacks become TBA", () => {
  const { context } = scheduleFieldHarness({ nextWeeklyAiringFrom: () => 0 });
  for (const at of [Date.UTC(2026, 8, 12), Infinity, 8640000000000001, "invalid"]) {
    const show = { nextAiringAt: at, day: "Sat", time: "8:00 AM" };
    assert.equal(context.applyScheduleAiringFields(show), true);
    assert.equal(show.nextAiringAt, null);
    assert.equal(show.day, "TBA");
    assert.equal(show.time, "");
    assert.equal(context.applyScheduleAiringFields(show), false);
  }
});

test("recent broadcasts stay visible and announced future reschedules are not rolled forward", () => {
  const { context } = scheduleFieldHarness({ broadcastInstant: () => { throw new Error("must retain exact slot"); } });
  for (const at of [Date.UTC(2026, 9, 4, 15), Date.UTC(2027, 0, 3, 14, 16)]) {
    const show = { nextAiringAt: at, broadcastDay: "Sundays" };
    context.applyScheduleAiringFields(show);
    assert.equal(show.nextAiringAt, at);
  }
});

test("MyAnimeList/Jikan broadcast slots convert both day and clock to the viewer timezone", () => {
  const functionSource = section(normalize, "function normalizeJikanShow(", "function catalogMetadataRank(");
  const utilsPath = new URL("../js/utils.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:\/)/, "$1");
  const script = `
    const vm = require('node:vm');
    const utils = require(${JSON.stringify(utilsPath)});
    const context = vm.createContext({ Date, pickGenre: () => '', cleanDescription: () => '',
      formatAiringClock: utils.formatAiringClock, formatAiringWeekday: utils.formatAiringWeekday,
      broadcastInstant: (...args) => utils.broadcastInstant(...args, Date.UTC(2026, 9, 5, 12)) });
    vm.runInContext(${JSON.stringify(functionSource)}, context);
    const entry = { mal_id: 1, title: 'Neutral Series', airing: true,
      broadcast: { day: 'Mondays', time: '00:30', timezone: 'Asia/Tokyo' } };
    const active = context.normalizeJikanShow(entry, 'Jikan');
    const finished = context.normalizeJikanShow({ ...entry, airing: false }, 'Jikan');
    const unknownZone = context.normalizeJikanShow({ ...entry, broadcast: { ...entry.broadcast, timezone: 'Unknown/Zone' } }, 'Jikan');
    console.log(JSON.stringify({ day: active.day, time: active.time, at: active.nextAiringAt,
      locale: new Intl.DateTimeFormat().resolvedOptions().locale,
      zone: active.broadcastTimezone, finishedDay: finished.day, unknownDay: unknownZone.day }));
  `;
  for (const zone of ["America/Denver", "Asia/Tokyo", "Europe/Berlin"]) {
    const result = JSON.parse(execFileSync(process.execPath, ["-e", script], {
      env: { ...process.env, TZ: zone, LANG: "en_US.UTF-8" }, encoding: "utf8"
    }));
    const expectedAt = Date.UTC(2026, 9, 11, 15, 30);
    assert.equal(result.day, new Intl.DateTimeFormat(result.locale, { weekday: "short", timeZone: zone }).format(expectedAt), zone);
    assert.equal(result.time, new Intl.DateTimeFormat(result.locale, { hour: "numeric", minute: "2-digit", hour12: true, timeZone: zone }).format(expectedAt), zone);
    assert.equal(result.at, expectedAt);
    assert.equal(result.zone, "Asia/Tokyo");
    assert.equal(result.finishedDay, "TBA");
    assert.equal(result.unknownDay, "TBA");
  }
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
    episodeThumbnailFallback: "https://cdn.example.com/exact-landscape.jpg",
    animeytScheduleAt: 123456
  };
  const incoming = {
    id: "metadata-1",
    title: "Fixture",
    day: "Local",
    time: "TBA",
    nextAiringAt: null,
    lastEpisodeAt: "",
    broadcastDay: "",
    episodeThumbnailFallback: "",
    animeytScheduleAt: 0
  };
  const merged = context.mergeClientCatalogShow(current, incoming);

  assert.equal(merged.day, "Monday");
  assert.equal(merged.time, "8:00 PM");
  assert.equal(merged.nextAiringAt, 123456);
  assert.equal(merged.lastEpisodeAt, current.lastEpisodeAt);
  assert.equal(merged.broadcastDay, "Mondays");
  assert.equal(merged.episodeThumbnailFallback, current.episodeThumbnailFallback);
  assert.equal(merged.animeytScheduleAt, current.animeytScheduleAt);
});

test("every catalog replacement invalidates schedule data before rendering", () => {
  const replacement = section(client, "function replaceRegularCatalog(", "function regularCatalogSnapshot(");
  const enrichment = section(client, "async function enrichCatalogAiringData(", "async function loadExternalSources(");
  assert.match(replacement, /state\.shows = mergeShows[\s\S]*?invalidateScheduleData\(\)/);
  assert.match(enrichment, /if \(Number\(it\.nextAiringAt \|\| 0\) > 0\) s\.nextAiringAt = Number\(it\.nextAiringAt\)/);
  assert.match(enrichment, /if \(changed\) \{\s*invalidateScheduleData\(\)/);
});

test("the existing airing refresh preserves the provider clock without an additional upstream request", async () => {
  const server = readFileSync(new URL("../animetv-server.js", import.meta.url), "utf8");
  const now = Date.UTC(2026, 9, 5, 12);
  const at = now + 86400000;
  let metadataCalls = 0;
  let providerCalls = 0;
  let result;
  class ClockDate extends Date { static now() { return now; } }
  const animeYTProvider = require("../lib/animeyt-provider.cjs").createProvider({
    snapshot: { items: [{ slug: "neutral-series", title: "Neutral Series", season: 1 }],
      schedule: [{ slug: "neutral-series", at, episode: 2 }] },
    now: () => now,
    fetchImpl: () => { providerCalls++; throw new Error("Schedule must be static"); }
  });
  const context = vm.createContext({ Date: ClockDate, animeYTProvider,
    ANILIST_AIRING_TTL_MS: 600000, anilistAiringCache: { data: null, ts: 0 },
    ANILIST_AIRING_GQL: "fixture", ANILIST_AIRING_CACHE_HEADERS: {},
    anilistCoalesce: async (_key, task) => task(),
    fetchAniListJson: async () => {
      metadataCalls++;
      return { data: { Page: { pageInfo: { hasNextPage: false }, media: [{
        id: 1, idMal: 2, title: { userPreferred: "Neutral Series" }, status: "RELEASING",
        nextAiringEpisode: { episode: 2, airingAt: (at + 9 * 86400000) / 1000 }
      }] } } };
    },
    sendJson: (_response, payload) => { result = payload; }
  });
  vm.runInContext(section(server, "async function handleAniListAiring(", "async function handleAniListMedia("), context);
  await context.handleAniListAiring(null, {});
  assert.equal(result.items[0].nextAiringAt, at);
  assert.equal(result.items[0].animeytAiringEpisode, 2);
  assert.equal(result.items[0].airingTimeSource, "AnimeYT");
  assert.equal(result.items[0].anilistId, 1);
  assert.equal(result.items[0].malId, 2);
  await context.handleAniListAiring(null, {});
  assert.equal(result.cached, true);
  assert.equal(metadataCalls, 1);
  assert.equal(providerCalls, 0);
});
