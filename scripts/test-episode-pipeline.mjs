import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const utils = require("../js/utils.js");
const SeasonNormalization = require("../js/season-normalization.js");
const sourceClassification = require("../js/source-classification.js");
const normalizeSource = readFileSync(new URL("../js/normalize.js", import.meta.url), "utf8");
const routerSource = readFileSync(new URL("../js/router.js", import.meta.url), "utf8");
const clientSource = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const playerSource = readFileSync(new URL("../player/player.js", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../animetv-server.js", import.meta.url), "utf8");

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing source section ${start}`);
  return source.slice(from, to);
}

function normalizationContext() {
  const sandbox = vm.createContext({
    console: { log() {}, warn() {}, debug() {} },
    ...utils,
    SeasonNormalization,
    Date,
    URL,
    pickGenre: (genres) => genres[0] || "",
    pickPlayableUrl: (item = {}) => item.videoUrl || item.streamUrl || item.file || item.url || "",
    getEpisodeUrl: (episode = {}) => episode.videoUrl || episode.streamUrl || episode.file || "",
    normalizeSubtitleTracks: (item = {}) => Array.isArray(item.subtitles) ? item.subtitles : [],
    cleanPlaybackSourceLabel: (value) => String(value || ""),
    isAnime1vEpisode: () => false,
    sourceLabelFromResolver: (resolver = {}) => resolver.type || "Resolver",
    languageName: (value) => value || "",
    isSafeAdultMetadata: () => true
  });
  vm.runInContext(`${normalizeSource}\nthis.pipeline = {
    normalizeExternalShow, normalizeSeasons, normalizeEpisodes,
    normalizeEpisodeSourceOptions, groupEpisodesBySeason, mergeEpisodes,
    mergeShows, mergeSeasons,
    parseEpisodeNumber, getCanonicalEpisodeNumber, getProviderEpisodeId,
    getInventoryProviderEpisodeId, getVerifiedFallbackSourceEpisode,
    canonicalEpisodeIdentity
  };`, sandbox);
  return sandbox;
}

function routerContext(pathname = "/") {
  const sandbox = vm.createContext({
    URL,
    location: { pathname, search: "", hash: "" },
    history: { pushState() {}, replaceState() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    window: { addEventListener() {}, dispatchEvent() {} }
  });
  vm.runInContext(routerSource, sandbox);
  return sandbox.window.ZenkaiRouter;
}

function applyTargetContext(seasons) {
  const state = { episodeChunkByContext: {} };
  const sandbox = vm.createContext({
    state,
    getShowKey: (show = {}) => show.id || show.slug || show.title || "show",
    extractSeasonNumber: utils.extractSeasonNumber,
    parseEpisodeNumber: (value, fallback = null) => {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
      const match = String(value ?? "").match(/^\d+(?:\.\d+)?$/);
      return match ? Number(match[0]) : fallback;
    },
    getCanonicalEpisodeNumber: (episode = {}, fallback = null) => {
      for (const value of [episode.canonicalEpisode, episode.episode, episode.number]) {
        const number = Number(value);
        if (value !== "" && value != null && Number.isFinite(number) && number >= 0) return number;
      }
      return fallback;
    },
    getDetailSeasons: () => seasons,
    getEpisodeUrl: (episode = {}) => episode.videoUrl || ""
  });
  vm.runInContext(section(clientSource, "function episodeChunkContextKey(", "function renderEpisodeList("), sandbox);
  vm.runInContext(section(clientSource, "function applyOpenTarget(", "function closeShow("), sandbox);
  return sandbox;
}

function navigationContext(seasons, selected) {
  const sandbox = vm.createContext({
    state: { activeShow: { id: "show" }, activeEpisode: selected },
    getDetailSeasons: () => seasons,
    getCanonicalEpisodeNumber: (episode = {}, fallback = null) => {
      const value = episode.canonicalEpisode ?? episode.episode ?? episode.number;
      return value == null ? fallback : Number(value);
    }
  });
  vm.runInContext(section(clientSource, "function getEpisodeNavigationTargets(", "function renderPlayerEpisodeActions("), sandbox);
  return sandbox;
}

function searchContext(shows, query) {
  const sourceSearchMatches = new Map();
  const sandbox = vm.createContext({
    state: { shows, search: query },
    getShowTitle: (show = {}) => show.englishTitle || show.title || "",
    _animeAv1CatalogSearchMatches: sourceSearchMatches,
    animeAv1CatalogSlugForShow: (show = {}) => {
      const idSlug = String(show.id || "").match(/^animeav1-(.+)$/i)?.[1] || "";
      return String(show.animeAv1Slug || show._av1Slug || idSlug).trim().toLowerCase();
    }
  });
  vm.runInContext(
    section(clientSource, "function normalizeSearchText(", "// ── Live AniList search"),
    sandbox
  );
  sandbox.sourceSearchMatches = sourceSearchMatches;
  return sandbox;
}

function playbackFallbackContext({ primaryFound, slowJk = false, language = "spanish", hostname = "localhost" }) {
  const calls = [];
  let resolveCompleted;
  const completed = new Promise((resolve) => { resolveCompleted = resolve; });
  let releaseSlowJk = () => {};
  const slowJkGate = slowJk
    ? new Promise((resolve) => { releaseSlowJk = resolve; })
    : Promise.resolve();
  const sourceOptionsBackgroundLookups = new Map();
  const sourceMatches = {
    animeneon: (source) => source.provider === "AnimeNeon",
    animeav1: (source) => source.provider === "AnimeAV1",
    jkanime: (source) => source.provider === "JKAnime",
    tioanime: (source) => source.provider === "TioAnime",
    underhentai: () => false
  };
  const sandbox = vm.createContext({
    console: { info() {}, warn() {} },
    Date,
    SOURCE_FAST_FIRST_PASS_MS: 0,
    SOURCE_FAST_SECOND_PASS_MS: 0,
    SOURCE_EAGER_FALLBACK_DELAY_MS: 450,
    AdultMode: { isAdultContent: () => false },
    episodeList: null,
    location: { hostname, origin: `https://${hostname}` },
    preferredWatchLanguageForEpisode: () => language,
    browserSupportsDeclaredCodec: sourceClassification.browserSupportsDeclaredCodec,
    hasRecentlyFailedPlaybackFamily: () => false,
    document: { querySelector: () => null },
    sourceOptionsBackgroundLookups,
    getCanonicalEpisodeNumber: () => 1,
    playbackLookupKey: () => "lookup",
    getVerifiedFallbackSourceEpisode: (show) => show.verifiedFallbackKey
      ? { providerKey: show.verifiedFallbackKey, providerAnimeSlug: "verified", providerEpisodeId: 13 }
      : null,
    normalizeEpisodeSourceOptions: (episode) => episode.sourceOptions || [],
    getEpisodePlaybackSources: (episode) => episode.sourceOptions || [],
    isAnimeNeonSource: sourceMatches.animeneon,
    isAnimeAv1Source: sourceMatches.animeav1,
    isJKAnimeSource: sourceMatches.jkanime,
    isTioAnimeSource: sourceMatches.tioanime,
    isHlsSource: () => true,
    isAdFreeFallbackCandidate: () => true,
    sourcePreferenceScore: () => 0,
    getKnownSourceServer: (key) => ({ match: sourceMatches[key] || (() => false) }),
    isScraperEnabled: () => true,
    renderSourcePickerIn() {},
    renderSourcePickerInSidePanel() {},
    refreshFocusables() {},
    promoteResolvedEpisodeSource: () => resolveCompleted(),
    wait: (milliseconds = 0) => new Promise((resolve) => {
      setTimeout(resolve, Math.min(Math.max(0, Number(milliseconds) || 0), 5));
    }),
    attachAnimeNeonSources: async (_show, episode) => {
      calls.push("animeneon:primary:start");
      await Promise.resolve();
      if (primaryFound && !(episode.sourceOptions || []).some((source) => source.id === "neon-primary")) {
        episode.sourceOptions = [...(episode.sourceOptions || []), {
          id: "neon-primary",
          provider: "AnimeNeon",
          type: "iframe",
          externalUrl: "https://voe.sx/e/primary"
        }];
      }
      episode.animeNeonSourcesChecked = true;
      calls.push("animeneon:primary:end");
    },
    attachAnimeAv1Sources: async (_show, episode, options = {}) => {
      const phase = options.includeFallbacks ? "fallback" : "primary";
      calls.push(`animeav1:${phase}:start`);
      await Promise.resolve();
      if (primaryFound && !(episode.sourceOptions || []).some((source) => source.id === "primary")) {
        episode.sourceOptions = [...(episode.sourceOptions || []), {
          id: "primary",
          provider: "AnimeAV1",
          type: "direct",
          videoUrl: "https://media.test/primary.m3u8"
        }];
      }
      episode.animeAv1SourcesChecked = true;
      calls.push(`animeav1:${phase}:end`);
    },
    attachJKAnimeSources: async (_show, episode) => {
      calls.push("jkanime");
      await slowJkGate;
      episode.sourceOptions = [...(episode.sourceOptions || []), {
        id: "jk",
        provider: "JKAnime",
        type: "iframe",
        externalUrl: "https://mp4upload.test/embed"
      }];
      episode.jkAnimeSourcesChecked = true;
    },
    attachTioAnimeSources: async (_show, episode) => {
      calls.push("tioanime");
      episode.sourceOptions = [...(episode.sourceOptions || []), {
        id: "tio-yourupload",
        provider: "TioAnime",
        type: "iframe",
        externalUrl: "https://www.yourupload.com/embed/example"
      }];
      episode.tioAnimeSourcesChecked = true;
    },
    KNOWN_SOURCE_SERVERS: Object.entries(sourceMatches).map(([key, match]) => ({ key, match }))
  });
  vm.runInContext(
    section(clientSource, "function isDirectMediaResolverCandidate(", "function playbackLookupKey("),
    sandbox
  );
  return { sandbox, calls, completed, releaseSlowJk };
}

function sourceRaceContext(overrides = {}) {
  const sandbox = vm.createContext({
    Date, Set,
    RELIABLE_PLAYBACK_TOTAL_BUDGET_MS: 14000,
    RELIABLE_PLAYBACK_PRIMARY_PROBE_MS: 5000,
    RELIABLE_PLAYBACK_BACKUP_DELAY_MS: 450,
    AdultMode: { isAdultContent: () => false },
    wait: () => new Promise(() => {}),
    getSelectedEpisodeSource: () => null,
    getEpisodePlaybackSources: (episode) => episode.sourceOptions,
    isAdFreeFallbackCandidate: () => true,
    hasFreshVerifiedPlaybackSource: () => false,
    hasRecentlyFailedPlaybackFamily: () => false,
    isLocalPlaybackRelay: () => true,
    isFastPreferredPlaybackSource: () => false,
    verifiedFallbackPreference: () => 0,
    pickFallbackRaceCandidates: (sources) => sources.slice(0, 4),
    firstSuccessfulFallback: (tasks) => Promise.any(tasks.map(async (task) => {
      const result = await task;
      if (!result) throw new Error("unavailable");
      return result;
    })).catch(() => null),
    regularSourceProviderKey: () => "",
    playbackRecoveryProviderKeys: () => [],
    attachPlaybackFailureFallbacks: async (_show, episode) => episode,
    selectEpisodePlaybackSource: (episode, id) => { episode.selectedSourceId = id; },
    ...overrides
  });
  vm.runInContext(section(clientSource, "async function prepareReliablePlaybackSource(", "function renderDirectVideoPlayer("), sandbox);
  return sandbox;
}

test("UPNShare: preferred host ranks first without replacing other providers", () => {
  const upn = { id: "animeav1-upn", provider: "UPNShare", type: "iframe", externalUrl: "https://animeav1.uns.bio/#episode" };
  const neon = { id: "animeneon-voe", type: "iframe", externalUrl: "https://voe.sx/e/episode" };
  const hls = { id: "animeav1-hls", type: "direct", videoUrl: "https://media.test/master.m3u8" };
  assert.deepEqual(sourceClassification.orderSourceOptions([neon, hls, upn]), [upn, neon, hls]);
  assert.equal(sourceClassification.isUpnShareSource(upn), true);
  assert.equal(sourceClassification.isUpnShareSource(neon), false);
});

test("UPNShare: local Sub discovery uses one primary lookup and leaves backups dormant", async () => {
  const { sandbox, calls, completed } = playbackFallbackContext({ primaryFound: true, language: "sub" });
  sandbox.location.hostname = "localhost";
  sandbox.attachAnimeAv1Sources = async (_show, episode) => {
    calls.push("animeav1:upn");
    episode.sourceOptions.push({ id: "animeav1-upn", provider: "AnimeAV1", type: "iframe", externalUrl: "https://animeav1.uns.bio/#episode" });
  };
  const episode = { sourceOptions: [] };
  await sandbox.attachPlaybackSourceOptions({ title: "Example" }, episode, 1);
  await completed;
  assert.deepEqual(calls, ["animeav1:upn"]);
});

test("UPNShare: a local inventory miss still discovers the next provider", async () => {
  const { sandbox, calls, completed } = playbackFallbackContext({ primaryFound: true, language: "sub" });
  sandbox.location.hostname = "localhost";
  sandbox.attachAnimeAv1Sources = async () => { calls.push("animeav1:miss"); };
  await sandbox.attachPlaybackSourceOptions({ title: "Example" }, { sourceOptions: [] }, 1);
  await completed;
  assert.deepEqual(calls, ["animeav1:miss", "animeneon:primary:start", "animeneon:primary:end"]);
});

test("UPNShare: Latino discovery stays language-aware and production keeps the IP-bound guard", () => {
  const { sandbox } = playbackFallbackContext({ primaryFound: true, language: "sub", hostname: "zenkaitv.test" });
  const upn = { id: "animeav1-upn", provider: "UPNShare", type: "iframe", externalUrl: "https://animeav1.uns.bio/#episode" };
  assert.equal(sandbox.shouldPreferUpnShareLookup({}, {}), false);
  assert.equal(sandbox.isProductionIpBoundPlaybackSource(upn), true);
  sandbox.location.hostname = "localhost";
  assert.equal(sandbox.shouldPreferUpnShareLookup({}, {}), true);
  assert.equal(sandbox.isFastPreferredPlaybackSource(upn), true);
  sandbox.browserSupportsDeclaredCodec = () => false;
  assert.equal(sandbox.isFastPreferredPlaybackSource(upn), false);
  sandbox.preferredWatchLanguageForEpisode = () => "spanish";
  assert.equal(sandbox.shouldPreferUpnShareLookup({}, {}), false);
  sandbox.preferredWatchLanguageForEpisode = () => "sub";
  sandbox.hasRecentlyFailedPlaybackFamily = () => true;
  assert.equal(sandbox.shouldPreferUpnShareLookup({}, {}), false);
});

test("UPNShare: a healthy primary is verified before a faster alternative", async () => {
  const upn = { id: "animeav1-upn", provider: "UPNShare" };
  const backup = { id: "backup" };
  const checked = [];
  const sandbox = sourceRaceContext({
    isFastPreferredPlaybackSource: () => true,
    verifyReliablePlaybackCandidate: async (_episode, source) => { checked.push(source.id); return source; }
  });
  const result = await sandbox.prepareReliablePlaybackSource({}, { sourceOptions: [backup, upn] });
  assert.equal(result.id, upn.id);
  assert.deepEqual(checked, [upn.id]);
});

test("UPNShare: failed media automatically selects a verified backup without retrying the bad candidate", async () => {
  const upn = { id: "animeav1-upn", provider: "UPNShare" };
  const backup = { id: "backup" };
  const checked = [];
  const sandbox = sourceRaceContext({
    isFastPreferredPlaybackSource: () => true,
    verifyReliablePlaybackCandidate: async (_episode, source) => { checked.push(source.id); return source === backup ? source : null; }
  });
  const episode = { sourceOptions: [backup, upn] };
  const result = await sandbox.prepareReliablePlaybackSource({}, episode);
  assert.equal(result.id, backup.id);
  assert.deepEqual(checked, [upn.id, backup.id]);
  assert.equal(episode._failedSourceIds.has(upn.id), true);
});

test("UPNShare: a requested Latino track is not displaced by the Sub primary", async () => {
  const upn = { id: "animeav1-upn", provider: "UPNShare" };
  const spanish = { id: "animeneon-spanish", languageVersion: "spanish" };
  const checked = [];
  const sandbox = sourceRaceContext({
    preferredWatchLanguageForEpisode: () => "spanish",
    isFastPreferredPlaybackSource: () => true,
    verifyReliablePlaybackCandidate: async (_episode, source) => { checked.push(source.id); return source; }
  });
  const result = await sandbox.prepareReliablePlaybackSource({}, { sourceOptions: [upn, spanish] });
  assert.equal(result.id, spanish.id);
  assert.deepEqual(checked, [spanish.id]);
});

test("UPNShare: a progressive Latino mirror keeps priority over a faster Sub source", async () => {
  const upn = { id: "animeav1-upn", provider: "UPNShare" };
  const spanish = { id: "animeneon-spanish", languageVersion: "spanish" };
  const checked = [];
  const sandbox = sourceRaceContext({
    getSelectedEpisodeSource: () => upn,
    preferredWatchLanguageForEpisode: () => "spanish",
    isFastPreferredPlaybackSource: (source) => source === upn,
    verifyReliablePlaybackCandidate: async (_episode, source) => { checked.push(source.id); return source; }
  });
  const result = await sandbox.prepareReliablePlaybackSource({}, { sourceOptions: [upn, spanish] }, { eagerBackups: true });
  assert.equal(result.id, spanish.id);
  assert.deepEqual(checked, [spanish.id]);
});

test("reliability: a working mirror beyond two failed batches is still considered", async () => {
  const sources = Array.from({ length: 13 }, (_, i) => ({ id: `mirror-${i}` }));
  const episode = { sourceOptions: sources };
  const checked = new Set();
  let active = 0;
  let peak = 0;
  const sandbox = sourceRaceContext({
    verifyReliablePlaybackCandidate: async (_episode, source) => {
      assert.ok(!checked.has(source.id), "do not retry the same candidate");
      checked.add(source.id);
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return source === sources[10] ? source : null;
    }
  });
  const result = await sandbox.prepareReliablePlaybackSource({}, episode);
  assert.equal(result?.id, "mirror-10");
  assert.equal(episode.selectedSourceId, "mirror-10");
  assert.ok(peak <= 4);
});

test("reliability: completed playback stops launching queued mirror probes", async () => {
  const sources = Array.from({ length: 12 }, (_, i) => ({ id: `mirror-${i}` }));
  const checked = [];
  const sandbox = sourceRaceContext({
    verifyReliablePlaybackCandidate: async (_episode, source) => {
      checked.push(source.id);
      if (source === sources[0]) return source;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return null;
    }
  });
  assert.equal((await sandbox.prepareReliablePlaybackSource({}, { sourceOptions: sources })).id, "mirror-0");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(checked.length, 4);
});

test("reliability: an expired total budget does not launch more mirrors", async () => {
  let now = 1000;
  const checked = [];
  const sandbox = sourceRaceContext({
    Date: { now: () => now },
    verifyReliablePlaybackCandidate: async (_episode, source) => {
      checked.push(source.id);
      now += 1000;
      return null;
    }
  });
  const result = await sandbox.prepareReliablePlaybackSource({}, {
    sourceOptions: Array.from({ length: 12 }, (_, i) => ({ id: `mirror-${i}` }))
  }, { timeoutMs: 900 });
  assert.equal(result, null);
  assert.equal(checked.length, 1);
});

test("reliability: the fast primary head start does not abort a healthy cold check", async () => {
  const source = { id: "cold-primary" };
  const budgets = [];
  const sandbox = sourceRaceContext({
    isFastPreferredPlaybackSource: () => true,
    verifyReliablePlaybackCandidate: async (_episode, candidate, options) => {
      budgets.push(options.timeoutMs);
      return options.timeoutMs >= 1200 ? candidate : null;
    }
  });
  const result = await sandbox.prepareReliablePlaybackSource({}, { sourceOptions: [source] }, {
    softFailures: true, timeoutMs: 3000, primaryProbeMs: 850
  });
  assert.equal(result?.id, "cold-primary");
  assert.equal(budgets.length, 1);
  assert.ok(budgets[0] >= 1200 && budgets[0] <= 3000);
});

test("reliability: an already available backup does not wait for unrelated discovery", async () => {
  const primary = { id: "primary" };
  const backup = { id: "backup" };
  const episode = { sourceOptions: [primary] };
  let discoveryWaits = 0;
  const sandbox = sourceRaceContext({
    isFastPreferredPlaybackSource: () => true,
    verifyReliablePlaybackCandidate: async (_episode, source) => source === backup ? source : null,
    attachPlaybackFailureFallbacks: async () => {
      episode.sourceOptions.push(backup);
      episode._playbackFailureFastPromise = new Promise(() => {});
      return episode;
    },
    wait: (ms) => {
      if (ms === 650) discoveryWaits++;
      return new Promise(() => {});
    }
  });
  const result = await Promise.race([
    sandbox.prepareReliablePlaybackSource({}, episode),
    new Promise((resolve) => setTimeout(() => resolve(null), 100))
  ]);
  assert.equal(result?.id, "backup");
  assert.equal(discoveryWaits, 0);
});

test("reliability: real Play starts verification before the discovery grace wait", () => {
  const playback = section(clientSource, "async function runActivePlaybackAttempt(", "function isExternalIframeEpisode(");
  assert.ok(playback.indexOf("const reliablePreparation") < playback.indexOf('await playbackLookupWithTimeout("Playback source quick pass"'));
  assert.match(playback, /&& !reliablePreparation/);
  assert.match(playback, /let reliableSource = await reliablePreparation/);
});

test("reliability: a recently failing preferred host cannot block a healthy backup", async () => {
  const bad = { id: "bad-hls" };
  const good = { id: "good-mp4" };
  let badFinished = false;
  const sandbox = sourceRaceContext({
    hasRecentlyFailedPlaybackFamily: source => source === bad,
    isFastPreferredPlaybackSource: source => source === bad,
    verifyReliablePlaybackCandidate: async (_episode, source) => {
      if (source === bad) {
        await new Promise(resolve => setTimeout(resolve, 30));
        badFinished = true;
        return null;
      }
      assert.equal(badFinished, false, "healthy backup should not wait for the failed family");
      return source;
    }
  });
  const result = await sandbox.prepareReliablePlaybackSource({}, { sourceOptions: [bad, good] });
  assert.equal(result?.id, good.id);
});

test("reliability: proven progressive hosts gain priority but unknown hosts do not", () => {
  let health = null;
  const sandbox = vm.createContext({
    location: { hostname: "zenkaitv.com" },
    playbackFamilyHealth: () => health
  });
  vm.runInContext(section(clientSource, "function isDirectMediaResolverCandidate(", "function hasFastPreferredPlaybackSource("), sandbox);
  const source = { type: "iframe", externalUrl: "https://www.mp4upload.com/embed-example.html" };
  assert.equal(sandbox.isFastPreferredPlaybackSource(source), false);
  health = true;
  assert.equal(sandbox.isFastPreferredPlaybackSource(source), true);
  assert.equal(sandbox.isFastPreferredPlaybackSource({ type: "iframe", externalUrl: "https://voe.sx/e/example" }), false);
  health = false;
  assert.equal(sandbox.isFastPreferredPlaybackSource(source), false);
});

test("audit: identical media IDs share one live verification without mixing referers or tokens", async () => {
  let resolutions = 0;
  let probes = 0;
  const sandbox = vm.createContext({
    Date, Map, JSON,
    playbackSourceHealthCache: new Map(),
    PLAYBACK_SOURCE_HEALTH_OK_TTL_MS: 90000,
    PLAYBACK_SOURCE_HEALTH_FAIL_TTL_MS: 15000,
    RELIABLE_PLAYBACK_PRIMARY_PROBE_MS: 5000,
    sourceDirectUrl: (source) => source.videoUrl || "",
    fallbackReferer: (source) => source.referer || "",
    resolveFallbackCandidateToDirect: async (source) => {
      resolutions++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { url: source.videoUrl };
    },
    probePlayableFallback: async () => { probes++; return true; },
    recordPlaybackFamilyHealth() {}
  });
  vm.runInContext(section(clientSource, "function playbackSourceHealthKey(", "async function verifyReliablePlaybackCandidate("), sandbox);
  const source = { videoUrl: "https://cdn.test/ep.mp4?token=one", referer: "https://provider.test/" };
  await Promise.all(Array.from({ length: 100 }, (_, i) => sandbox.inspectPlaybackSourceHealth({ ...source, id: `mirror-${i}` })));
  assert.equal(resolutions, 1);
  assert.equal(probes, 1);
  await sandbox.inspectPlaybackSourceHealth({ ...source, referer: "https://other.test/" });
  await sandbox.inspectPlaybackSourceHealth({ ...source, videoUrl: "https://cdn.test/ep.mp4?token=two" });
  assert.equal(resolutions, 3, "request context and signed URL changes must not share health");
});

test("audit: no-match artwork and failed carousel attempts survive rebuilt release cards", async () => {
  const canonical = { id: "missing-tmdb-film", title: "Example" };
  let searches = 0;
  const sandbox = vm.createContext({
    state: { shows: [canonical] },
    ImageResolver: { hydrateTmdbImages: async (show) => {
      if (!show._tmdbResolved) { searches++; show._tmdbResolved = true; }
      return show;
    } }
  });
  vm.runInContext(section(clientSource, "function enrichTmdbImages(", "function usesContinuousGlobalEpisodeMetadata("), sandbox);
  for (let i = 0; i < 100; i++) {
    await sandbox.enrichTmdbImages({ ...canonical }, { refresh: false });
  }
  assert.equal(searches, 1, "a missing TMDB identity is not a reason to query on every repaint");
  assert.equal(canonical._tmdbResolved, true);
  const failed = { id: "network-failure" };
  sandbox.state.shows = [failed];
  sandbox.ImageResolver.hydrateTmdbImages = async () => { throw new Error("offline"); };
  await sandbox.enrichTmdbImages({ ...failed, _carouselResolveTried: true });
  assert.equal(failed._carouselResolveTried, true);
  assert.equal(failed._tmdbResolved, undefined, "a transient failure must not become a permanent no-match");
});

test("audit: buffered headroom excludes disconnected ranges left by seeking", () => {
  const sandbox = vm.createContext({});
  vm.runInContext(section(playerSource, "  function bufferedEnd(", "  function resetPlaybackHealth("), sandbox);
  const video = { currentTime: 20, buffered: { length: 2, start: (i) => [0, 100][i], end: (i) => [25, 200][i] } };
  assert.equal(sandbox.bufferedAhead(video), 5);
  video.currentTime = 50;
  assert.equal(sandbox.bufferedAhead(video), 0);
  video.currentTime = 110;
  assert.equal(sandbox.bufferedAhead(video), 90);
});

test("audit: an old autoplay rejection cannot mute or resume a replacement player", async () => {
  let rejectPlay;
  let calls = 0;
  const oldVideo = { muted: false, play: () => { calls++; return new Promise((_resolve, reject) => { rejectPlay = reject; }); } };
  const sandbox = vm.createContext({ art: { video: oldVideo } });
  vm.runInContext(section(playerSource, "  function startPlayback(", "  function loadHls("), sandbox);
  sandbox.startPlayback(oldVideo);
  sandbox.art = { video: {} };
  rejectPlay({ name: "NotAllowedError" });
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  assert.equal(oldVideo.muted, false);
});

test("audit: next-episode probes wait for buffer and stop after a navigation", async () => {
  const events = {};
  const timers = [];
  let current = true;
  let finishMetadata;
  let probes = 0;
  let fallbackProbes = 0;
  let secondaryLookups = 0;
  const episode = {};
  const next = {};
  const player = { currentTime: 4, duration: 30, bufferedEnd: 5, addEventListener: (name, fn) => { events[name] = fn; } };
  const sandbox = vm.createContext({
    navigator: { connection: {} },
    window: { setTimeout: (fn) => timers.push(fn) },
    isPlaybackAttemptCurrent: () => current,
    getEpisodeNavigationTargets: () => ({ next: { seasonIndex: 0, episodeIndex: 1 } }),
    getDetailSeasons: () => [{ episodes: [episode, next] }],
    attachAnimeNeonSources: () => new Promise((resolve) => { finishMetadata = resolve; }),
    getEpisodePlaybackSources: () => [],
    isAnimeNeonSource: () => false,
    isScraperEnabled: () => true,
    attachAnimeAv1Sources: async () => { secondaryLookups++; },
    playbackSelectionKey: () => "next",
    selectedSeasonIdentity: () => ({ seasonNumber: 1 }),
    warmEpisodePlaybackIntent: async () => { probes++; return {}; },
    prepareReliablePlaybackSource: async () => { fallbackProbes++; }
  });
  vm.runInContext(section(clientSource, "function setupAdjacentEpisodeWarmup(", "function renderDirectVideoPlayer("), sandbox);
  sandbox.setupAdjacentEpisodeWarmup(player, {}, episode, {});
  events.timeupdate();
  assert.equal(probes, 0, "three seconds played is not evidence of buffer headroom");
  assert.equal(finishMetadata, undefined, "a starving current video should not trigger speculative media work");
  player.bufferedEnd = 25;
  events.timeupdate();
  assert.equal(typeof finishMetadata, "function");
  current = false;
  finishMetadata();
  await new Promise(setImmediate);
  assert.equal(secondaryLookups, 0);
  assert.equal(probes, 0);
  assert.equal(fallbackProbes, 0);
});

test("audit: player retries release observers/listeners and preserve page controls", () => {
  const cleanups = [];
  let observers = 0;
  let disconnected = 0;
  const moved = [];
  const page = { appendChild: (node) => { node.parentElement = page; moved.push(node); } };
  const nodes = Array.from({ length: 4 }, () => ({}));
  const selectors = ["#playerTopbar", "#backButton", "#chromeToggle", "#floatingLabel"];
  const listeners = new Map();
  const target = {
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); }
  };
  const sandbox = vm.createContext({
    playerCleanups: cleanups, art: null, hlsRecoveryTimer: null, sheet: null, hlsLevels: [],
    ResizeObserver: class { constructor() { observers++; } observe() {} disconnect() { disconnected++; } },
    syncPictureInsets() {},
    window: { ...target, screen: { orientation: target }, clearTimeout() {} },
    document: { ...target, querySelector: (selector) => selector === ".ztv-player-page" ? page : nodes[selectors.indexOf(selector)] },
    getPlayerHostWindow: () => ({ ...target, matchMedia: () => target }),
    stopStatusLoop() {}, clearStartupWatchdog() {}, clearStallWatchdog() {}, cancelScheduledRecovery() {},
    closeOptionsSheet() {}, unlockOrientation() {}, destroyHls() {}
  });
  vm.runInContext([
    section(playerSource, "  function watchPictureInsets()", "  function firstParam("),
    section(playerSource, "  function wireTapToHideControls()", "  // Long enough to move"),
    section(playerSource, "  function destroyPlayer()", "  function cssUrl(")
  ].join("\n"), sandbox);
  for (let i = 0; i < 5; i++) {
    nodes.forEach((node) => { node.parentElement = {}; });
    sandbox.art = { template: { $player: { addEventListener() {} } }, on() {}, destroy() { assert.ok(nodes.every((node) => node.parentElement === page)); } };
    sandbox.watchPictureInsets();
    sandbox.wireTapToHideControls();
    sandbox.destroyPlayer();
    assert.equal([...listeners.values()].reduce((n, set) => n + set.size, 0), 0);
    assert.equal(cleanups.length, 0);
  }
  assert.equal(observers, 5);
  assert.equal(disconnected, 5);
  assert.equal(moved.length, 20);
});

test("audit: a source found by the late resolver proceeds on the first click", async () => {
  const start = '  if (!url) {\n    if (activeEpisode && !waitedForLookup)';
  const normalized = clientSource.replace(/\r\n/g, "\n");
  const latePath = section(normalized, start, "  // Android TV: route every source");
  let errors = 0;
  const sandbox = vm.createContext({
    renderPlayerPopupMessage: (_frame, _title, message) => { if (message.startsWith("No playable")) errors++; },
    wait: async () => {},
    isPlaybackAttemptCurrent: () => true,
    getSelectedEpisodeSource: () => ({ type: "resolver", streamResolver: { endpoint: "/api/source" } }),
    resolveEpisodeStream: async () => "https://cdn.test/late.mp4"
  });
  vm.runInContext(`async function resolveLate() {
    let url = "", source;
    const activeEpisode = {}, waitedForLookup = false, frame = {}, show = {}, playbackContext = {};
    ${latePath}
    return url;
  }`, sandbox);
  assert.equal(await sandbox.resolveLate(), "https://cdn.test/late.mp4");
  assert.equal(errors, 0);
});

test("audit: healthy buffers still warm one next episode, then dispose its listeners", async () => {
  const events = new Map();
  let warmed = 0;
  let cleared = 0;
  const next = {};
  const player = {
    currentTime: 10, duration: 1400,
    buffered: { length: 1, start: () => 0, end: () => 30 },
    addEventListener: (key, fn) => events.set(key, fn),
    removeEventListener: (key) => events.delete(key)
  };
  const connection = { saveData: true };
  const sandbox = vm.createContext({
    navigator: { connection }, window: { clearTimeout() { cleared++; } },
    isPlaybackAttemptCurrent: () => true,
    getEpisodeNavigationTargets: () => ({ next: { seasonIndex: 0, episodeIndex: 1 } }),
    getDetailSeasons: () => [{ episodes: [{}, next] }],
    attachAnimeNeonSources: async () => next,
    getEpisodePlaybackSources: () => [{}], isAnimeNeonSource: () => true,
    playbackSelectionKey: () => "next", selectedSeasonIdentity: () => ({ seasonNumber: 1 }),
    warmEpisodePlaybackIntent: async () => { warmed++; return {}; }
  });
  vm.runInContext(section(clientSource, "function setupAdjacentEpisodeWarmup(", "function renderDirectVideoPlayer("), sandbox);
  sandbox.setupAdjacentEpisodeWarmup(player, {}, {}, {});
  events.get("timeupdate")();
  await new Promise(setImmediate);
  assert.equal(warmed, 0, "Data Saver disables speculative media downloads");
  connection.saveData = false;
  events.get("timeupdate")();
  await new Promise(setImmediate);
  events.get("timeupdate")();
  await new Promise(setImmediate);
  assert.equal(warmed, 1);
  player._disposeAdjacentWarmup();
  assert.equal(events.size, 0);
  assert.equal(cleared, 1);
});

function regularSourceSlugContext() {
  const sandbox = vm.createContext({
    Map,
    normalizeTitle: utils.normalizeTitle,
    getShowTitle: (show = {}) => show.title || ""
  });
  vm.runInContext(
    section(clientSource, "function stripSeasonFromTitle(", "async function attachAniPubFallback("),
    sandbox
  );
  vm.runInContext(
    section(clientSource, "function sourceTitleValues(", "function tioAnimeSlugFromSearchPayload("),
    sandbox
  );
  sandbox._tioAnimeSlugCache = new Map();
  sandbox._tioAnimeSlugTitleMap = {};
  vm.runInContext(
    section(clientSource, "function applyTioAnimeSlugFromMap(", "async function resolveTioAnimeSlugFromCatalog("),
    sandbox
  );
  sandbox.jkAnimeSearchCandidates = sandbox.tioAnimeSearchCandidates;
  sandbox._jkAnimeSlugCache = new Map();
  sandbox._jkAnimeSlugTitleMap = {};
  vm.runInContext(
    section(clientSource, "function applyJKAnimeSlugFromMap(", "async function resolveJKAnimeSlugFromCatalog("),
    sandbox
  );
  return sandbox;
}

function animeAv1SourceContext() {
  let fetchCount = 0;
  let lastFetchUrl = "";
  let lastFetchOptions = null;
  let now = 1000;
  let releaseFetch;
  const prefetched = [];
  const gate = new Promise((resolve) => { releaseFetch = resolve; });
  const sandbox = vm.createContext({
    Date: { now: () => now },
    console: { warn() {} },
    document: {
      createElement: () => ({}),
      head: { appendChild: (node) => prefetched.push(node.href) }
    },
    PLAYER_SHELL_VERSION: "765",
    _animeAv1EpisodeSourceCache: new Map(),
    _animeAv1EpisodeSourceInflight: new Map(),
    ANIMEAV1_SOURCE_TIMEOUT_MS: 6500,
    AdultMode: { isAdultContent: () => false },
    isScraperEnabled: () => true,
    parseEpisodeNumber: (value) => {
      const number = Number(value);
      return value !== "" && Number.isFinite(number) && number >= 0 ? number : null;
    },
    getInventoryProviderEpisodeId: (_show, episode) => episode.providerEpisodeId,
    hydrateAnimeAv1Slug: async () => {},
    fetchWithTimeout: async (url, options) => {
      fetchCount += 1;
      lastFetchUrl = url;
      lastFetchOptions = options;
      await gate;
      return {
        ok: true,
        json: async () => ({
          ok: true,
          sources: [{ provider: "HLS", url: "/api/source?url=example" }]
        })
      };
    },
    mergeAnimeAv1SourcesIntoEpisode: (_show, episode, data) => {
      episode.sourceOptions = data.sources;
    }
  });
  vm.runInContext(
    section(clientSource, "const EPISODE_SOURCE_PAYLOAD_TTL_MS", "async function buildAnimeAv1CastCandidate("),
    sandbox
  );
  vm.runInContext(
    section(clientSource, "let _playerShellPrefetched", "function mergeAnimeAv1SourcesIntoEpisode("),
    sandbox
  );
  return {
    sandbox,
    releaseFetch,
    prefetched,
    advanceTime: (milliseconds) => { now += milliseconds; },
    getFetchCount: () => fetchCount,
    getLastFetchUrl: () => lastFetchUrl,
    getLastFetchOptions: () => lastFetchOptions
  };
}

test("0. explicit sequel source matching cannot fall back to the parent season", () => {
  const sandbox = regularSourceSlugContext();
  const title = "Nige Jouzu no Wakagimi 2nd Season";
  const parentTitle = "Nige Jouzu no Wakagimi";
  const parentKey = utils.normalizeTitle(parentTitle);
  const secondSeasonKey = utils.normalizeTitle(`${parentTitle} 2`);
  const sequel = { title, aliases: [parentTitle] };

  const candidates = [...sandbox.tioAnimeSearchCandidates(sequel)].map(utils.normalizeTitle);
  assert.equal(candidates.includes(parentKey), false);
  assert.equal(sandbox.applyTioAnimeSlugFromMap({ ...sequel }, { [parentKey]: "parent-season" }), null);
  assert.equal(sandbox.applyJKAnimeSlugFromMap({ ...sequel }, { [parentKey]: "parent-season" }), null);

  const tioMatch = sandbox.applyTioAnimeSlugFromMap({ ...sequel }, { [secondSeasonKey]: "second-season" });
  const jkMatch = sandbox.applyJKAnimeSlugFromMap({ ...sequel }, { [secondSeasonKey]: "second-season" });
  assert.equal(tioMatch?.slug, "second-season");
  assert.equal(jkMatch?.slug, "second-season");

  const firstSeason = { title: parentTitle };
  assert.equal(sandbox.applyTioAnimeSlugFromMap(firstSeason, { [parentKey]: "parent-season" })?.slug, "parent-season");

  const serverSandbox = vm.createContext({});
  vm.runInContext(
    section(serverSource, "function seasonTitleVariants(", "function readBundledTioAnimeSlugSnapshot("),
    serverSandbox
  );
  const serverCandidates = [...serverSandbox.seasonSafeSourceTitleCandidates([title])].map(utils.normalizeTitle);
  assert.equal(serverCandidates.includes(parentKey), false);
  assert.equal(serverCandidates.includes(secondSeasonKey), true);
});

test("1. single-season episode selection retains canonical identity", () => {
  const { pipeline } = normalizationContext();
  const seasons = pipeline.normalizeSeasons({
    id: "single",
    title: "Single Example",
    episodes: [{ id: "single-e1", episode: 1, videoUrl: "https://video.test/1.mp4" }]
  });
  assert.equal(seasons.length, 1);
  assert.equal(seasons[0].season, 1);
  assert.equal(seasons[0].episodes[0].canonicalEpisode, 1);
});

test("2. Season 2 Episode 1 survives a provider season numbered 1", () => {
  const { pipeline } = normalizationContext();
  const show = pipeline.normalizeExternalShow({
    id: "second",
    title: "Example Season 2",
    canonicalSeasonNumber: 2,
    canonicalSeasonPart: 1,
    normalizedSeasonTitle: "Season 2 Part 1",
    providerEpisodeOffset: 12,
    seasons: [{
      season: 1,
      title: "Season 1",
      episodes: [{ episode: 1, season: 1, providerEpisodeId: 13 }]
    }]
  }, { id: "animeav1", name: "AnimeAV1", provider: "AnimeAV1" }, 0);
  const [season] = show.seasons;
  const [episode] = season.episodes;
  assert.equal(show.canonicalSeasonNumber, 2);
  assert.equal(show.canonicalSeasonPart, 1);
  assert.equal(show.providerEpisodeOffset, 12);
  assert.equal(season.season, 2);
  assert.equal(season.part, 1);
  assert.equal(episode.canonicalSeason, 2);
  assert.equal(episode.canonicalEpisode, 1);
  assert.equal(episode.providerEpisodeId, 13);

  const topLevel = pipeline.normalizeExternalShow({
    id: "second-flat",
    title: "Example Season 2",
    seasonNumber: 2,
    episodes: [{ episode: 1, season: 1, providerEpisodeId: 1 }]
  }, { id: "animeav1", name: "AnimeAV1", provider: "AnimeAV1" }, 0);
  assert.equal(topLevel.seasons[0].season, 2);
  assert.equal(topLevel.seasons[0].episodes[0].canonicalSeason, 2);
});

test("3. switching Season 1 to Season 2 selects that season's object", () => {
  const seasons = [
    { season: 1, episodes: [{ id: "s1e1", episode: 1 }] },
    { season: 2, episodes: [{ id: "s2e1", episode: 1 }] }
  ];
  const c = applyTargetContext(seasons);
  c.applyOpenTarget({ title: "Example" }, { seasonNumber: 2, episodeNumber: 1 });
  assert.equal(c.state.activeSeasonIndex, 1);
  assert.equal(c.state.activeEpisode.episode.id, "s2e1");
});

test("3b. deep links wait for the requested episode instead of clamping to the latest bootstrap row", () => {
  const bootstrapSeasons = [{
    season: 1,
    episodes: [{ id: "one-piece-e1180", episode: 1180 }]
  }];
  const c = applyTargetContext(bootstrapSeasons);
  const target = { seasonNumber: 1, episodeNumber: 877, playIntent: true, watchRoute: true };

  assert.equal(c.applyOpenTarget({ id: "one-piece", title: "One Piece" }, target), false);
  assert.equal(c.state.activeEpisode, undefined);

  const fullSeasons = [{
    season: 1,
    episodes: [
      { id: "one-piece-e877", episode: 877 },
      { id: "one-piece-e1180", episode: 1180 }
    ]
  }];
  assert.equal(c.applyOpenTarget({ id: "one-piece", title: "One Piece" }, target, fullSeasons), true);
  assert.equal(c.state.activeEpisode.episode.id, "one-piece-e877");
});

test("4. direct Season 2 URLs parse deterministically", () => {
  const route = routerContext("/watch/example/s2-e1").parsePath("/watch/example/s2-e1");
  assert.equal(route.target.seasonNumber, 2);
  assert.equal(route.target.episodeNumber, 1);
  assert.equal(route.target.watchRoute, true);
});

test("5. provider episode ID remains separate from display number", () => {
  const { pipeline } = normalizationContext();
  const [episode] = pipeline.normalizeEpisodes({
    id: "split-cour",
    episodes: [{ episode: 1, providerEpisodeId: 13, sourceEpisodeNumber: 13 }]
  });
  assert.equal(episode.canonicalEpisode, 1);
  assert.equal(pipeline.getProviderEpisodeId(episode), 13);
});

test("6. decimal episode numbers are not truncated", () => {
  const { pipeline } = normalizationContext();
  assert.equal(pipeline.parseEpisodeNumber("Episode 12.5"), 12.5);
  const [episode] = pipeline.normalizeEpisodes({ episodes: [{ episode: "12.5" }] });
  assert.equal(episode.canonicalEpisode, 12.5);
});

test("7. episode zero is a valid identity", () => {
  const { pipeline } = normalizationContext();
  assert.equal(pipeline.parseEpisodeNumber(0), 0);
  const [episode] = pipeline.normalizeEpisodes({ episodes: [{ episode: 0, providerEpisodeId: 0 }] });
  assert.equal(episode.canonicalEpisode, 0);
  assert.equal(pipeline.getProviderEpisodeId(episode), 0);
});

test("7b. metadata merging preserves a movie's verified provider episode zero", () => {
  const { pipeline } = normalizationContext();
  const provider = pipeline.normalizeExternalShow({
    id: "animeav1-the-ribbon-hero",
    title: "The Ribbon Hero",
    anilistId: 211308,
    malId: 64012,
    format: "MOVIE",
    sourceEpisodeIds: [0],
    sourceEpisodeCount: 1,
    sourcePlayableEpisodeCount: 1,
    sourceInventoryChecked: true,
    sourceInventoryCheckedAt: "2026-09-08T05:28:00.580Z"
  }, { id: "animeav1", name: "AnimeAV1", provider: "AnimeAV1" }, 0);
  const metadata = pipeline.normalizeExternalShow({
    id: "anilist-211308",
    title: "THE RIBBON HERO",
    anilistId: 211308,
    malId: 64012,
    format: "MOVIE",
    score: 67
  }, { id: "anilist", name: "AniList", provider: "AniList" }, 1);

  for (const rows of [[provider, metadata], [metadata, provider]]) {
    const [merged] = pipeline.mergeShows(rows);
    assert.deepEqual(Array.from(merged.sourceEpisodeIds), [0]);
    assert.equal(merged.sourceInventoryChecked, true);
    assert.equal(merged.sourcePlayableEpisodeCount, 1);
    assert.equal(
      pipeline.getInventoryProviderEpisodeId(merged, { canonicalEpisode: 1, providerEpisodeId: 1 }),
      0
    );
  }
});

test("7bb. a verified standalone fallback builds Episode 1 but requests provider episode 13", () => {
  const { pipeline } = normalizationContext();
  const show = pipeline.normalizeExternalShow({
    id: "animeav1-deadman-wonderland-akai-knife-tsukai",
    title: "Deadman Wonderland: Akai Knife Tsukai",
    type: "OVA",
    sourceInventoryChecked: true,
    sourceEpisodeIds: [],
    sourcePlayableEpisodeCount: 0,
    fallbackProvider: "TioAnime",
    fallbackProviderKey: "tioanime",
    fallbackProviderAnimeSlug: "deadman-wonderland",
    fallbackEpisodeMap: { "1": 13 },
    fallbackEpisodeIds: [1],
    fallbackPlayableEpisodeCount: 1,
    fallbackInventoryChecked: true,
    sourceFallbackVerified: true
  }, { id: "animeav1", name: "AnimeAV1", provider: "AnimeAV1" }, 0);
  assert.equal(show.seasons.length, 1);
  assert.equal(show.seasons[0].episodes.length, 1);
  assert.equal(show.seasons[0].episodes[0].canonicalEpisode, 1);
  const fallback = pipeline.getVerifiedFallbackSourceEpisode(show, show.seasons[0].episodes[0]);
  assert.equal(fallback.provider, "TioAnime");
  assert.equal(fallback.providerKey, "tioanime");
  assert.equal(fallback.providerAnimeSlug, "deadman-wonderland");
  assert.equal(fallback.providerEpisodeId, 13);
  assert.equal(fallback.canonicalEpisode, 1);
  assert.equal(fallback.siteUrl, "");
});

test("7bc. a verified fallback survives the detail-view inventory clamp", () => {
  const sandbox = vm.createContext({});
  vm.runInContext(
    section(clientSource, "function getSeasonEpisodeLimit(", "function clampSeasonEpisodes("),
    sandbox
  );
  assert.equal(sandbox.getSeasonEpisodeLimit({
    type: "OVA",
    sourceInventoryChecked: true,
    sourceEpisodeCount: 0,
    sourcePlayableEpisodeCount: 0,
    sourceFallbackVerified: true,
    fallbackInventoryChecked: true,
    fallbackPlayableEpisodeCount: 1
  }), 1);
});

test("7c. regular backups stay dormant when AnimeNeon resolves", async () => {
  const { sandbox, calls, completed } = playbackFallbackContext({ primaryFound: true });
  const episode = { sourceOptions: [] };
  await sandbox.attachPlaybackSourceOptions({ title: "Primary title" }, episode, 1);
  await completed;
  assert.deepEqual(calls, ["animeneon:primary:start", "animeneon:primary:end"]);
  assert.equal(episode.playbackSourceLookupComplete, true);
  assert.equal(episode.sourceOptions[0].provider, "AnimeNeon");
});

test("7d. regular backups run only after confirmed AnimeNeon and AnimeAV1 misses", async () => {
  const { sandbox, calls, completed } = playbackFallbackContext({ primaryFound: false });
  const episode = { sourceOptions: [] };
  await sandbox.attachPlaybackSourceOptions({ title: "Missing primary title" }, episode, 1);
  await completed;
  const neonEnd = calls.indexOf("animeneon:primary:end");
  const animeAv1End = calls.indexOf("animeav1:primary:end");
  assert.ok(neonEnd >= 0);
  assert.ok(animeAv1End > neonEnd);
  assert.ok(calls.indexOf("jkanime") > animeAv1End);
  assert.ok(calls.indexOf("tioanime") > animeAv1End);
  assert.deepEqual(new Set(episode.sourceOptions.map((source) => source.provider)), new Set(["JKAnime", "TioAnime"]));
  assert.equal(episode.playbackSourceLookupComplete, true);
});

test("7d1. progressive embeds stay deferred while proven fast sources enter verification", () => {
  const { sandbox } = playbackFallbackContext({ primaryFound: false });
  assert.equal(sandbox.hasFastPreferredPlaybackSource({
    sourceOptions: [{ id: "early-mp4upload", type: "iframe", externalUrl: "https://mp4upload.test/embed" }]
  }), false);
  assert.equal(sandbox.hasFastPreferredPlaybackSource({
    sourceOptions: [{ id: "resolved-mp4upload", type: "direct", videoUrl: "https://a4.mp4upload.com/video.mp4" }]
  }), false);
  assert.equal(sandbox.hasFastPreferredPlaybackSource({
    sourceOptions: [{ id: "unknown-embed", type: "iframe", externalUrl: "https://unknown.test/embed" }]
  }), false);
  assert.equal(sandbox.hasFastPreferredPlaybackSource({
    sourceOptions: [{ id: "tio-yourupload", type: "iframe", externalUrl: "https://www.yourupload.com/embed/example" }]
  }), false);
  assert.equal(sandbox.hasFastPreferredPlaybackSource({
    sourceOptions: [{ id: "animeav1-upn", type: "iframe", externalUrl: "https://animeav1.uns.bio/#episode" }]
  }), true);
  assert.equal(sandbox.hasFastPreferredPlaybackSource({
    sourceOptions: [{ id: "animeav1-voe", type: "iframe", externalUrl: "https://voe.sx/e/episode" }]
  }), true);
  assert.equal(sandbox.hasFastPreferredPlaybackSource({
    sourceOptions: [{ id: "jkanime-streamwish", type: "iframe", externalUrl: "https://sfastwish.com/e/episode" }]
  }), true);
  assert.equal(sandbox.hasFastPreferredPlaybackSource({
    sourceOptions: [{ id: "jkanime-vidhide", type: "iframe", externalUrl: "https://vidhidevip.com/embed/episode" }]
  }), true);
  assert.equal(sandbox.hasFastPreferredPlaybackSource({
    sourceOptions: [{ id: "direct", type: "direct", videoUrl: "https://media.test/episode.m3u8" }]
  }), true);
});

test("7d2. the first usable backup releases playback while another provider is slow", async () => {
  const { sandbox, calls, completed, releaseSlowJk } = playbackFallbackContext({
    primaryFound: false,
    slowJk: true
  });
  const episode = { sourceOptions: [] };
  const lookup = sandbox.attachPlaybackSourceOptions({ title: "Fast backup title" }, episode, 1, {
    eagerFallbacks: true
  });
  const released = await Promise.race([
    lookup.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 50))
  ]);
  assert.equal(released, true);
  assert.ok(calls.includes("tioanime"));
  assert.equal(episode.sourceOptions.some((source) => source.provider === "TioAnime"), true);
  releaseSlowJk();
  await completed;
});

test("7e. a verified OVA fallback cannot be replaced by a fuzzy parent-series match", async () => {
  const { sandbox, calls, completed } = playbackFallbackContext({ primaryFound: false });
  const episode = { sourceOptions: [] };
  await sandbox.attachPlaybackSourceOptions({
    title: "Deadman Wonderland: Akai Knife Tsukai",
    verifiedFallbackKey: "tioanime"
  }, episode, 1);
  await completed;
  assert.deepEqual(calls, [
    "animeneon:primary:start",
    "animeneon:primary:end",
    "animeav1:primary:start",
    "animeav1:primary:end",
    "tioanime"
  ]);
  assert.equal(episode.sourceOptions.length, 1);
  assert.equal(episode.sourceOptions[0].provider, "TioAnime");
  assert.equal(episode.playbackSourceLookupComplete, true);
});

test("7f. a confirmed playback failure expands backups once and coalesces concurrent requests", async () => {
  const { sandbox, calls } = playbackFallbackContext({ primaryFound: true });
  const episode = {
    sourceOptions: [{ id: "failed-primary", provider: "AnimeAV1" }],
    serverChecks: { animeav1: "found" }
  };
  const show = { title: "Fallback example" };

  const first = sandbox.attachPlaybackFailureFallbacks(show, episode);
  const second = sandbox.attachPlaybackFailureFallbacks(show, episode);
  await Promise.all([first, second]);

  assert.equal(calls.filter((value) => value === "animeneon:primary:start").length, 1);
  assert.equal(calls.filter((value) => value === "animeav1:fallback:start").length, 1);
  assert.equal(calls.filter((value) => value === "tioanime").length, 1);
  assert.equal(calls.filter((value) => value === "jkanime").length, 1);
  assert.equal(episode.playbackFailureFallbacksComplete, true);
  assert.equal(episode.sourceOptionsPending, false);
  assert.equal(episode._playbackFailureFallbackPromise, null);
  assert.equal(episode._playbackFailureFastPromise, null);
  assert.equal(episode.serverChecks.animeneon, "found");
  assert.equal(episode.serverChecks.animeav1, "found");
  assert.equal(episode.serverChecks.tioanime, "found");
  assert.equal(episode.serverChecks.jkanime, "found");

  const callCount = calls.length;
  await sandbox.attachPlaybackFailureFallbacks(show, episode);
  assert.equal(calls.length, callCount);
});

test("7f1. first-play recovery reuses cached lookups and refreshes only sources that failed", () => {
  const sandbox = vm.createContext({
    Set,
    REGULAR_SOURCE_PROVIDER_KEYS: ["animeneon", "animeav1", "jkanime", "tioanime"],
    isScraperEnabled: () => true,
    getEpisodePlaybackSources: (episode) => episode.sourceOptions || [],
    regularSourceProviderKey: (source = {}) => source.providerKey || "",
    regularSourceProviderMatch: (providerKey, source = {}) => providerKey === source.providerKey,
    hasRecentlyFailedPlaybackFamily: (source = {}) => source.familyFailed === true
  });
  vm.runInContext(
    section(clientSource, "function playbackRecoveryProviderKeys(", "function claimEpisodeProviderRefresh("),
    sandbox
  );

  assert.deepEqual(Array.from(sandbox.playbackRecoveryProviderKeys({ sourceOptions: [] })), []);

  const failedEpisode = {
    sourceOptions: [
      { id: "bad-av1", providerKey: "animeav1" },
      { id: "healthy-jk", providerKey: "jkanime" }
    ],
    _failedSourceIds: new Set(["bad-av1"])
  };
  assert.deepEqual(
    Array.from(sandbox.playbackRecoveryProviderKeys(failedEpisode)),
    ["animeav1"]
  );
  assert.deepEqual(
    Array.from(sandbox.playbackRecoveryProviderKeys(failedEpisode, { providerKey: "tioanime" })),
    ["animeav1", "tioanime"]
  );
});

test("7f2. play-intent health checking promotes a verified backup automatically", async () => {
  const primary = { id: "primary", type: "direct", videoUrl: "https://dead.test/episode.m3u8" };
  const backup = { id: "backup", type: "direct", videoUrl: "https://media.test/episode.mp4" };
  const episode = { sourceOptions: [primary], selectedSourceId: "primary" };
  let fallbackLookups = 0;
  const sandbox = vm.createContext({
    Date,
    Set,
    RELIABLE_PLAYBACK_TOTAL_BUDGET_MS: 4200,
    RELIABLE_PLAYBACK_PRIMARY_PROBE_MS: 1600,
    RELIABLE_PLAYBACK_BACKUP_DELAY_MS: 450,
    AdultMode: { isAdultContent: () => false },
    wait: () => new Promise(() => {}),
    getSelectedEpisodeSource: (value) => value.sourceOptions.find((source) => (
      source.id === value.selectedSourceId && !value._failedSourceIds?.has(source.id)
    )) || value.sourceOptions.find((source) => !value._failedSourceIds?.has(source.id)) || null,
    hasFreshVerifiedPlaybackSource: () => false,
    hasRecentlyFailedPlaybackFamily: () => false,
    isLocalPlaybackRelay: () => true,
    isFastPreferredPlaybackSource: () => true,
    verifyReliablePlaybackCandidate: async (_value, source) => source.id === "backup" ? source : null,
    playbackRecoveryProviderKeys: () => [],
    refreshFailedPlaybackProviders: async (_show, value) => value,
    regularSourceProviderKey: (source = {}) => source.providerKey || "",
    attachPlaybackFailureFallbacks: async (_show, value) => {
      fallbackLookups += 1;
      if (!value.sourceOptions.some((source) => source.id === "backup")) value.sourceOptions.push(backup);
      return value;
    },
    getEpisodePlaybackSources: (value) => value.sourceOptions,
    isAdFreeFallbackCandidate: () => true,
    verifiedFallbackPreference: (source) => source.id === "backup" ? 0 : 1,
    pickFallbackRaceCandidates: (sources) => sources.slice(0, 3),
    firstSuccessfulFallback: async (tasks) => {
      for (const task of tasks) {
        const value = await task;
        if (value) return value;
      }
      return null;
    },
    selectEpisodePlaybackSource: (value, id) => {
      value.selectedSourceId = id;
      return value.sourceOptions.find((source) => source.id === id) || null;
    }
  });
  vm.runInContext(
    section(clientSource, "async function prepareReliablePlaybackSource(", "function renderDirectVideoPlayer("),
    sandbox
  );

  const selected = await sandbox.prepareReliablePlaybackSource({ title: "Example" }, episode);
  assert.equal(selected.id, "backup");
  assert.equal(episode.selectedSourceId, "backup");
  assert.equal(episode._failedSourceIds.has("primary"), true);
  assert.equal(fallbackLookups, 1);
});

test("7f2a. first Play consumes a late recovery source instead of a stale warmup", async () => {
  const primary = { id: "primary", type: "direct", videoUrl: "https://dead.test/episode.m3u8" };
  const backup = { id: "late-backup", type: "direct", videoUrl: "https://media.test/episode.m3u8" };
  const episode = { sourceOptions: [primary], selectedSourceId: primary.id };
  const staleWarmup = Promise.resolve(episode);
  episode._eagerFallbackLookupPromise = staleWarmup;
  episode._playbackFailureFallbackPromise = new Promise((resolve) => {
    setTimeout(() => {
      episode.sourceOptions.push(backup);
      resolve(episode);
    }, 20);
  });
  let redundantLookups = 0;
  const sandbox = vm.createContext({
    Date,
    Set,
    RELIABLE_PLAYBACK_TOTAL_BUDGET_MS: 4200,
    RELIABLE_PLAYBACK_PRIMARY_PROBE_MS: 1600,
    RELIABLE_PLAYBACK_BACKUP_DELAY_MS: 450,
    RELIABLE_PLAYBACK_HANDOFF_WAIT_MS: 500,
    AdultMode: { isAdultContent: () => false },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    getSelectedEpisodeSource: (value) => value.sourceOptions.find((source) => (
      source.id === value.selectedSourceId && !value._failedSourceIds?.has(source.id)
    )) || null,
    getEpisodePlaybackSources: (value) => value.sourceOptions,
    isAdFreeFallbackCandidate: () => true,
    hasFreshVerifiedPlaybackSource: () => false,
    hasRecentlyFailedPlaybackFamily: () => false,
    isLocalPlaybackRelay: () => true,
    isFastPreferredPlaybackSource: (source) => source.id === backup.id,
    fallbackSourceIdentity: (source) => source.id,
    verifiedFallbackPreference: (source) => source.id === backup.id ? 0 : 1,
    pickFallbackRaceCandidates: (sources) => sources,
    firstSuccessfulFallback: async (tasks) => {
      for (const task of tasks) {
        const value = await task;
        if (value) return value;
      }
      return null;
    },
    verifyReliablePlaybackCandidate: async (_value, source) => source.id === backup.id ? source : null,
    playbackRecoveryProviderKeys: () => [],
    refreshFailedPlaybackProviders: async (_show, value) => value,
    regularSourceProviderKey: () => "",
    attachPlaybackFailureFallbacks: async (_show, value) => {
      redundantLookups += 1;
      return value;
    },
    selectEpisodePlaybackSource: (value, id) => {
      value.selectedSourceId = id;
      return value.sourceOptions.find((source) => source.id === id) || null;
    }
  });
  vm.runInContext(
    section(clientSource, "async function prepareReliablePlaybackSource(", "function renderDirectVideoPlayer("),
    sandbox
  );

  const selected = await sandbox.prepareReliablePlaybackSource({ title: "Bleach" }, episode);
  assert.equal(selected.id, backup.id);
  assert.equal(episode.selectedSourceId, backup.id);
  assert.equal(redundantLookups, 0);
});

test("7f2a0. runtime recovery starts the verified backup without another click", () => {
  const sourceLookup = section(
    clientSource,
    "async function attachPlaybackSourceOptions(",
    "async function attachPlaybackFailureFallbacks("
  );
  const player = section(clientSource, "function renderDirectVideoPlayer(", "function renderPlaybackError(");
  assert.match(sourceLookup, /_eagerFallbackLookupPromise = null/);
  assert.match(player, /_playbackFallbackPromptActive = false/);
  assert.match(player, /playActiveShow\(\{ allowSourceLookup: false, restart: true \}\)/);
});

test("7f2a1. eager playback does not promote a fragile progressive source before backups arrive", async () => {
  const fragile = { id: "mp4upload", type: "direct", videoUrl: "https://mp4upload.test/video.mp4" };
  const backup = { id: "voe-hls", type: "iframe", externalUrl: "https://voe.test/e/video" };
  const episode = { sourceOptions: [fragile], selectedSourceId: fragile.id };
  const checked = [];
  const sandbox = vm.createContext({
    Date,
    Set,
    RELIABLE_PLAYBACK_TOTAL_BUDGET_MS: 4200,
    RELIABLE_PLAYBACK_PRIMARY_PROBE_MS: 1600,
    RELIABLE_PLAYBACK_BACKUP_DELAY_MS: 450,
    AdultMode: { isAdultContent: () => false },
    wait: () => new Promise(() => {}),
    getSelectedEpisodeSource: (value) => value.sourceOptions.find((source) => source.id === value.selectedSourceId) || null,
    getEpisodePlaybackSources: (value) => value.sourceOptions,
    isAdFreeFallbackCandidate: () => true,
    hasFreshVerifiedPlaybackSource: () => false,
    hasRecentlyFailedPlaybackFamily: () => false,
    isLocalPlaybackRelay: () => false,
    isFastPreferredPlaybackSource: (source) => source.id === backup.id,
    verifiedFallbackPreference: (source) => source.id === backup.id ? 0 : 7,
    pickFallbackRaceCandidates: (sources) => sources,
    firstSuccessfulFallback: async (tasks) => {
      for (const task of tasks) {
        const value = await task;
        if (value) return value;
      }
      return null;
    },
    verifyReliablePlaybackCandidate: async (_value, source) => {
      checked.push(source.id);
      return source.id === backup.id ? source : null;
    },
    playbackRecoveryProviderKeys: () => [],
    refreshFailedPlaybackProviders: async (_show, value) => value,
    regularSourceProviderKey: (source = {}) => source.providerKey || "",
    attachPlaybackFailureFallbacks: async (_show, value) => {
      if (!value.sourceOptions.includes(backup)) value.sourceOptions.push(backup);
      return value;
    },
    selectEpisodePlaybackSource: (value, id) => {
      value.selectedSourceId = id;
      return value.sourceOptions.find((source) => source.id === id) || null;
    }
  });
  vm.runInContext(
    section(clientSource, "async function prepareReliablePlaybackSource(", "function renderDirectVideoPlayer("),
    sandbox
  );

  const selected = await sandbox.prepareReliablePlaybackSource({ title: "Example" }, episode, {
    eagerBackups: true
  });
  assert.equal(selected.id, backup.id);
  assert.equal(checked[0], backup.id);
  assert.equal(episode.selectedSourceId, backup.id);
});

test("7f2a2. a quick Streamtape resolve cannot outrank segmented playback", () => {
  const sandbox = vm.createContext({
    location: { hostname: "localhost" }
  });
  vm.runInContext(
    section(clientSource, "function isDirectMediaResolverCandidate(", "function hasFastPreferredPlaybackSource("),
    sandbox
  );

  assert.equal(sandbox.isFastPreferredPlaybackSource({
    id: "voe",
    type: "iframe",
    externalUrl: "https://voe.sx/e/working"
  }), true);
  assert.equal(sandbox.isFastPreferredPlaybackSource({
    id: "streamtape",
    type: "iframe",
    externalUrl: "https://streamtape.com/e/quick-but-fragile"
  }), false);
  assert.equal(sandbox.isFastPreferredPlaybackSource({
    id: "mp4upload",
    type: "direct",
    videoUrl: "https://a4.mp4upload.com/video.mp4"
  }), false);
  assert.equal(sandbox.isFastPreferredPlaybackSource({
    id: "portable-hls",
    type: "direct",
    videoUrl: "https://media.test/master.m3u8"
  }), true);
});

test("7f2aa. a failed signed source refreshes and verifies again during the same Play", async () => {
  const stale = {
    id: "animeav1-upn",
    providerKey: "animeav1",
    generation: "stale",
    type: "iframe",
    externalUrl: "https://embed.test/episode"
  };
  const episode = { sourceOptions: [stale], selectedSourceId: stale.id };
  let refreshes = 0;
  const sandbox = vm.createContext({
    Date,
    Set,
    RELIABLE_PLAYBACK_TOTAL_BUDGET_MS: 4200,
    RELIABLE_PLAYBACK_PRIMARY_PROBE_MS: 1600,
    RELIABLE_PLAYBACK_BACKUP_DELAY_MS: 450,
    RELIABLE_PLAYBACK_REFRESH_RECOVERY_MS: 5000,
    AdultMode: { isAdultContent: () => false },
    wait: () => new Promise(() => {}),
    getSelectedEpisodeSource: (value) => value.sourceOptions.find((source) => (
      source.id === value.selectedSourceId && !value._failedSourceIds?.has(source.id)
    )) || value.sourceOptions.find((source) => !value._failedSourceIds?.has(source.id)) || null,
    getEpisodePlaybackSources: (value) => value.sourceOptions,
    hasFreshVerifiedPlaybackSource: () => false,
    hasRecentlyFailedPlaybackFamily: () => false,
    isLocalPlaybackRelay: () => true,
    isFastPreferredPlaybackSource: () => true,
    isAdFreeFallbackCandidate: () => true,
    verifiedFallbackPreference: () => 0,
    pickFallbackRaceCandidates: (sources) => sources,
    firstSuccessfulFallback: async (tasks) => {
      for (const task of tasks) {
        const value = await task;
        if (value) return value;
      }
      return null;
    },
    verifyReliablePlaybackCandidate: async (_value, source) => (
      source.generation === "fresh" ? source : null
    ),
    regularSourceProviderKey: (source = {}) => source.providerKey || "",
    refreshFailedPlaybackProviders: async (_show, value) => {
      refreshes += 1;
      value._failedSourceIds.delete(stale.id);
      value.sourceOptions = [{ ...stale, generation: "fresh" }];
      return value;
    },
    playbackRecoveryProviderKeys: () => [],
    attachPlaybackFailureFallbacks: async (_show, value) => value,
    selectEpisodePlaybackSource: (value, id) => {
      value.selectedSourceId = id;
      return value.sourceOptions.find((source) => source.id === id) || null;
    }
  });
  vm.runInContext(
    section(clientSource, "async function prepareReliablePlaybackSource(", "function renderDirectVideoPlayer("),
    sandbox
  );

  const selected = await sandbox.prepareReliablePlaybackSource({ title: "Example" }, episode);
  assert.equal(selected.generation, "fresh");
  assert.equal(refreshes, 1);
  assert.equal(episode.selectedSourceId, stale.id);
  assert.equal(episode._failedSourceIds.has(stale.id), false);
});

test("7f2a. production races a portable backup alongside an IP-bound VOE candidate", async () => {
  const mp4Upload = { id: "mp4upload", type: "iframe", externalUrl: "https://mp4upload.test/embed" };
  const voe = { id: "voe", type: "iframe", externalUrl: "https://voe.test/embed" };
  const episode = { sourceOptions: [mp4Upload, voe], selectedSourceId: "mp4upload" };
  const verified = [];
  const sandbox = vm.createContext({
    Date,
    Set,
    RELIABLE_PLAYBACK_TOTAL_BUDGET_MS: 4200,
    RELIABLE_PLAYBACK_PRIMARY_PROBE_MS: 1600,
    RELIABLE_PLAYBACK_BACKUP_DELAY_MS: 450,
    AdultMode: { isAdultContent: () => false },
    wait: () => new Promise(() => {}),
    getSelectedEpisodeSource: (value) => value.sourceOptions.find((source) => source.id === value.selectedSourceId) || null,
    getEpisodePlaybackSources: (value) => value.sourceOptions,
    isAdFreeFallbackCandidate: () => true,
    hasFreshVerifiedPlaybackSource: () => false,
    hasRecentlyFailedPlaybackFamily: () => false,
    isLocalPlaybackRelay: () => false,
    fallbackSourceIdentity: (source) => source.id,
    isFastPreferredPlaybackSource: (source) => source.id === "voe",
    verifiedFallbackPreference: (source) => source.id === "voe" ? 0 : 1,
    pickFallbackRaceCandidates: (sources) => sources.slice(0, 3),
    verifyReliablePlaybackCandidate: async (_value, source) => {
      verified.push(source.id);
      return source.id === "mp4upload" ? source : null;
    },
    firstSuccessfulFallback: async (tasks) => {
      for (const task of tasks) {
        const value = await task;
        if (value) return value;
      }
      return null;
    },
    playbackRecoveryProviderKeys: () => [],
    refreshFailedPlaybackProviders: async (_show, value) => value,
    regularSourceProviderKey: (source = {}) => source.providerKey || "",
    attachPlaybackFailureFallbacks: async (_show, value) => value,
    selectEpisodePlaybackSource: (value, id) => {
      value.selectedSourceId = id;
      return value.sourceOptions.find((source) => source.id === id) || null;
    }
  });
  vm.runInContext(
    section(clientSource, "async function prepareReliablePlaybackSource(", "function renderDirectVideoPlayer("),
    sandbox
  );

  const selected = await sandbox.prepareReliablePlaybackSource({ title: "Example" }, episode);
  assert.equal(selected.id, "mp4upload");
  assert.deepEqual(verified, ["voe", "mp4upload"]);
  assert.equal(episode.selectedSourceId, "mp4upload");
});

test("7f2b. a failed primary is not retried when no backup verifies", async () => {
  const primary = { id: "primary", type: "direct", videoUrl: "https://dead.test/episode.m3u8" };
  const episode = { sourceOptions: [primary], selectedSourceId: "primary" };
  const sandbox = vm.createContext({
    Date,
    Set,
    RELIABLE_PLAYBACK_TOTAL_BUDGET_MS: 4200,
    RELIABLE_PLAYBACK_PRIMARY_PROBE_MS: 1600,
    RELIABLE_PLAYBACK_BACKUP_DELAY_MS: 450,
    AdultMode: { isAdultContent: () => false },
    wait: () => new Promise(() => {}),
    getSelectedEpisodeSource: (value) => value.sourceOptions.find((source) => (
      source.id === value.selectedSourceId && !value._failedSourceIds?.has(source.id)
    )) || null,
    hasFreshVerifiedPlaybackSource: () => false,
    hasRecentlyFailedPlaybackFamily: () => false,
    isLocalPlaybackRelay: () => true,
    isFastPreferredPlaybackSource: () => true,
    verifyReliablePlaybackCandidate: async () => null,
    playbackRecoveryProviderKeys: () => [],
    refreshFailedPlaybackProviders: async (_show, value) => value,
    regularSourceProviderKey: (source = {}) => source.providerKey || "",
    attachPlaybackFailureFallbacks: async (_show, value) => value,
    getEpisodePlaybackSources: (value) => value.sourceOptions,
    isAdFreeFallbackCandidate: () => true,
    verifiedFallbackPreference: () => 0,
    pickFallbackRaceCandidates: (sources) => sources,
    firstSuccessfulFallback: async () => null,
    selectEpisodePlaybackSource: () => null
  });
  vm.runInContext(
    section(clientSource, "async function prepareReliablePlaybackSource(", "function renderDirectVideoPlayer("),
    sandbox
  );

  const selected = await sandbox.prepareReliablePlaybackSource({ title: "Example" }, episode);
  assert.equal(selected, null);
  assert.equal(episode._failedSourceIds.has("primary"), true);
});

test("7f2c. a preferred source remains eligible after only the short probe times out", async () => {
  const yourUpload = { id: "yourupload", type: "iframe", externalUrl: "https://www.yourupload.com/embed/example" };
  const episode = { sourceOptions: [yourUpload], selectedSourceId: "yourupload" };
  let checks = 0;
  const never = new Promise(() => {});
  const sandbox = vm.createContext({
    Date,
    Set,
    RELIABLE_PLAYBACK_TOTAL_BUDGET_MS: 4200,
    RELIABLE_PLAYBACK_PRIMARY_PROBE_MS: 1600,
    RELIABLE_PLAYBACK_BACKUP_DELAY_MS: 450,
    AdultMode: { isAdultContent: () => false },
    wait: (ms) => ms === 1600 ? Promise.resolve() : never,
    getSelectedEpisodeSource: (value) => value.sourceOptions.find((source) => source.id === value.selectedSourceId) || null,
    getEpisodePlaybackSources: (value) => value.sourceOptions,
    isAdFreeFallbackCandidate: () => true,
    hasFreshVerifiedPlaybackSource: () => false,
    hasRecentlyFailedPlaybackFamily: () => false,
    isLocalPlaybackRelay: () => true,
    isFastPreferredPlaybackSource: () => true,
    verifiedFallbackPreference: () => 0,
    pickFallbackRaceCandidates: (sources) => sources,
    verifyReliablePlaybackCandidate: async (_value, source) => {
      checks += 1;
      return checks === 1 ? never : source;
    },
    firstSuccessfulFallback: async (tasks) => {
      for (const task of tasks) {
        const value = await task;
        if (value) return value;
      }
      return null;
    },
    playbackRecoveryProviderKeys: () => [],
    refreshFailedPlaybackProviders: async (_show, value) => value,
    regularSourceProviderKey: (source = {}) => source.providerKey || "",
    attachPlaybackFailureFallbacks: async (_show, value) => value,
    selectEpisodePlaybackSource: (value, id) => {
      value.selectedSourceId = id;
      return value.sourceOptions.find((source) => source.id === id) || null;
    }
  });
  vm.runInContext(
    section(clientSource, "async function prepareReliablePlaybackSource(", "function renderDirectVideoPlayer("),
    sandbox
  );

  const selected = await sandbox.prepareReliablePlaybackSource({ title: "Example" }, episode);
  assert.equal(selected.id, "yourupload");
  assert.equal(checks, 2);
});

test("7f2c2. the three-second target cannot poison a slow provider for recovery", async () => {
  const source = { id: "slow-but-healthy", type: "direct", videoUrl: "https://media.test/episode.mp4" };
  const episode = { sourceOptions: [source] };
  const sandbox = vm.createContext({
    isAdFreeFallbackCandidate: () => true,
    hasFreshVerifiedPlaybackSource: () => false,
    inspectPlaybackSourceHealth: async () => null,
    getResumePosition: () => 0,
    persistVerifiedFallbackSource: () => null
  });
  vm.runInContext(
    section(clientSource, "async function verifyReliablePlaybackCandidate(", "async function prepareReliablePlaybackSource("),
    sandbox
  );

  await sandbox.verifyReliablePlaybackCandidate(episode, source, { softFailure: true });
  assert.equal(episode._failedSourceIds, undefined);

  await sandbox.verifyReliablePlaybackCandidate(episode, source);
  assert.equal(episode._failedSourceIds.has(source.id), true);
});

test("7f2d. intent warming verifies only the best primary and never fans out to backup providers", async () => {
  const voe = { id: "voe", type: "iframe", externalUrl: "https://voe.test/embed" };
  const mp4Upload = { id: "mp4upload", type: "iframe", externalUrl: "https://mp4upload.test/embed" };
  const episode = { sourceOptions: [voe, mp4Upload], selectedSourceId: "mp4upload" };
  const checked = [];
  let backupLookups = 0;
  const sandbox = vm.createContext({
    Date,
    Set,
    RELIABLE_PLAYBACK_TOTAL_BUDGET_MS: 4200,
    RELIABLE_PLAYBACK_PRIMARY_PROBE_MS: 1600,
    RELIABLE_PLAYBACK_BACKUP_DELAY_MS: 450,
    AdultMode: { isAdultContent: () => false },
    wait: () => new Promise(() => {}),
    getSelectedEpisodeSource: (value) => value.sourceOptions.find((source) => source.id === value.selectedSourceId) || null,
    getEpisodePlaybackSources: (value) => value.sourceOptions,
    isAdFreeFallbackCandidate: () => true,
    hasFreshVerifiedPlaybackSource: () => false,
    hasRecentlyFailedPlaybackFamily: () => false,
    isLocalPlaybackRelay: () => false,
    fallbackSourceIdentity: (source) => source.id,
    isFastPreferredPlaybackSource: (source) => source.id === "voe",
    verifiedFallbackPreference: (source) => source.id === "voe" ? 0 : 7,
    pickFallbackRaceCandidates: (sources) => sources.slice(0, 3),
    verifyReliablePlaybackCandidate: async (_value, source) => {
      checked.push(source.id);
      return source;
    },
    firstSuccessfulFallback: async (tasks) => {
      for (const task of tasks) {
        const value = await task;
        if (value) return value;
      }
      return null;
    },
    playbackRecoveryProviderKeys: () => [],
    refreshFailedPlaybackProviders: async (_show, value) => value,
    regularSourceProviderKey: (source = {}) => source.providerKey || "",
    attachPlaybackFailureFallbacks: async (_show, value) => {
      backupLookups += 1;
      return value;
    },
    selectEpisodePlaybackSource: (value, id) => {
      value.selectedSourceId = id;
      return value.sourceOptions.find((source) => source.id === id) || null;
    }
  });
  vm.runInContext(
    section(clientSource, "async function prepareReliablePlaybackSource(", "function renderDirectVideoPlayer("),
    sandbox
  );

  const selected = await sandbox.prepareReliablePlaybackSource({ title: "Example" }, episode, {
    primaryOnly: true
  });
  assert.equal(selected.id, "voe");
  assert.deepEqual(checked, ["voe"]);
  assert.equal(backupLookups, 0);
  assert.equal(episode._reliablePrimaryWarmPromise, null);
});

test("7f2e. episode intent and adjacent playback warm the shared source path before a click", () => {
  const renderer = section(clientSource, "function renderEpisodeList(", "function episodeDisplaySubtitle(");
  const warmup = section(clientSource, "function warmEpisodePlaybackIntent(", "function renderDirectVideoPlayer(");
  const playback = section(clientSource, "async function runActivePlaybackAttempt(", "function isExternalIframeEpisode(");
  assert.match(renderer, /button\.addEventListener\("pointerenter", warmPrimary/);
  assert.match(renderer, /button\.addEventListener\("pointerdown", warmForPlay/);
  assert.match(renderer, /warmEpisodePlaybackIntent\(show, episode, seasonNumber, options\)/);
  assert.match(renderer, /eagerBackups:\s*true/);
  assert.match(renderer, /timeoutMs:\s*RELIABLE_PLAYBACK_FAST_TARGET_MS/);
  assert.match(warmup, /primaryOnly:\s*true/);
  assert.match(warmup, /const promiseKey = eagerBackups/);
  assert.match(warmup, /attachPlaybackFailureFallbacks\(show, episode\)/);
  assert.match(warmup, /softFailures:\s*true/);
  assert.match(warmup, /prefetchSegment:\s*Boolean\(options\.prefetchSegment\)/);
  assert.doesNotMatch(clientSource, /allowResolvedFallback/);
  assert.match(clientSource, /prefetchSegment:\s*true/);
  assert.match(warmup, /bufferedEnd - position >= 12/);
  assert.doesNotMatch(warmup, /position >= 3/);
  assert.match(warmup, /connection\?\.saveData/);
  assert.match(warmup, /timeoutMs:\s*8000/);
  assert.match(warmup, /if \(!source\) verifyNearTransition\(\)/);
  assert.match(playback, /lookupPromise\s*&&\s*!alreadyPlayable\s*&&\s*!getSelectedEpisodeSource/);
});

test("7f3. regular backup source routes share CDN cache and cold in-flight work", () => {
  assert.match(serverSource, /const tioAnimeSourceInflight = new Map\(\)/);
  assert.match(serverSource, /const jkAnimeSourceInflight = new Map\(\)/);
  assert.match(serverSource, /coalesceInflight\(tioAnimeSourceInflight, inflightKey/);
  assert.match(serverSource, /coalesceInflight\(\s*jkAnimeSourceInflight,/);
  assert.match(serverSource, /s-maxage=300, stale-while-revalidate=600/);
  assert.match(serverSource, /const forceRefresh = url\.searchParams\.get\("refresh"\) === "1"/);
  assert.match(serverSource, /SOURCE_REFRESH_CACHE_HEADERS/);
  const jkAttach = section(clientSource, "function fetchJKAnimeEpisodeSourcePayload(", "function mergeJKAnimeSourcesIntoEpisode(");
  assert.ok(jkAttach.indexOf("animeAv1CatalogSlugForShow(show)") < jkAttach.indexOf("hydrateJKAnimeSlug(show"));
});

test("7f3b. AnimeNeon multiserver pages expose preferred real player entries", () => {
  const sandbox = vm.createContext({});
  vm.runInContext(
    section(serverSource, "function animeNeonMultiserverEntries(", "async function expandAnimeNeonMultiserver("),
    sandbox
  );
  const entries = sandbox.animeNeonMultiserverEntries(`
    <li onclick="go_to_player('encrypted-other')"><span>byseqekaho.com</span></li>
    <li onclick="go_to_player('encrypted-tape')"><span>streamtape.com</span></li>
    <li onclick="go_to_player('encrypted-voe')"><span>voe.sx</span></li>
  `);
  assert.deepEqual(Array.from(entries, (entry) => entry.provider), ["voe.sx", "streamtape.com", "byseqekaho.com"]);
  assert.match(serverSource, /\/embed\/api\/decrypt-stream/);
  assert.match(serverSource, /url\.pathname === "\/api\/animeneon\/sources"/);
});

test("7f3c. Latino selection is limited to episodes present in the dub inventory", () => {
  const sandbox = vm.createContext({
    state: {
      activeShow: null,
      activeEpisode: null,
      watchLanguageChoice: "spanish"
    },
    showHasLatinoDub: (show = {}) => show.hasLatinoDub === true && Number(show.latinoEpisodeCount || 0) > 0,
    getCanonicalEpisodeNumber: (episode = {}, fallback = null) => episode.episode ?? fallback
  });
  vm.runInContext(
    section(clientSource, "function preferredWatchLanguage()", "function invalidateAnimeNeonLanguageSelection("),
    sandbox
  );
  const show = { hasLatinoDub: true, latinoEpisodeCount: 877 };
  assert.equal(sandbox.episodeHasLatinoDub(show, { episode: 877 }), true);
  assert.equal(sandbox.episodeHasLatinoDub(show, { episode: 878 }), false);
  assert.equal(sandbox.preferredWatchLanguageForEpisode(show, { episode: 877 }), "spanish");
  assert.equal(sandbox.preferredWatchLanguageForEpisode(show, { episode: 878 }), "sub");
});

test("7f3d. player language follows the selected episode source instead of the global preference", () => {
  const sandbox = vm.createContext({
    state: {
      activeShow: { title: "One Piece" },
      activeEpisode: { season: { season: 1 }, seasonIndex: 0 },
      uiPreferences: { playerQuality: 0, playerInterface: "zenkai", playerFit: "contain" }
    },
    getLanguagePreferences: () => ({ audio: "spanish", subtitles: "none" }),
    getSelectedEpisodeSource: (episode) => episode.selectedSource,
    isPreferredAdultSource: () => false,
    AdultMode: { isAdultContent: () => false },
    preferredWatchLanguageForEpisode: () => "sub",
    preferredWatchLanguage: () => "spanish",
    streamTypeFromUrl: () => "hls",
    streamTypeQueryValue: () => "hls",
    normalizeSubtitleTracks: () => [],
    getResumePosition: () => 0,
    currentEpisodeKicker: () => "S1E878",
    getEpisodeNavigationTargets: () => ({}),
    PLAYER_SKIP_SEGMENTS: [],
    skipSegmentParam: () => "",
    resolveEpisodeSkipSegment: () => null,
    episodeSkipKey: () => "878",
    getEpisodePlaybackSources: () => [],
    episodeThumb: () => "",
    currentEpisodeTitle: () => "Episode 878",
    buildPlayerUrl: (_url, _title, options) => JSON.stringify(options)
  });
  vm.runInContext(
    section(clientSource, "function buildApkPlayerUrl(", "function createApkPlayerController("),
    sandbox
  );

  const subOptions = JSON.parse(sandbox.buildApkPlayerUrl("https://cdn.test/sub.m3u8", false, {
    episode: 878,
    selectedSource: { languageVersion: "sub", audioLanguage: "ja" }
  }));
  assert.equal(subOptions.audio, "japanese");
  assert.equal(subOptions.subtitles, "spanish");

  const latinoOptions = JSON.parse(sandbox.buildApkPlayerUrl("https://cdn.test/latino.m3u8", false, {
    episode: 877,
    selectedSource: { languageVersion: "spanish", audioLanguage: "es" }
  }));
  assert.equal(latinoOptions.audio, "spanish");
  assert.equal(latinoOptions.subtitles, "none");
});

test("7f3e. normal AnimeNeon reads use CDN cache and optional mirrors stay on recovery", () => {
  const clientSection = section(clientSource, "function animeNeonEpisodeSourceCacheKey(", "async function attachAnimeNeonSources(");
  const serverSection = section(serverSource, "async function fetchAnimeNeonEpisode(", "async function handleAnimeNeonHealth(");
  assert.match(clientSection, /cache:\s*options\.forceRefresh \? "no-store" : "default"/);
  assert.match(clientSource, /_animeNeonEpisodeSourceCache\.delete\(animeNeonEpisodeSourceCacheKey/);
  assert.match(serverSection, /forceRefresh \|\| directServers\.length < 3/);
  assert.match(serverSection, /const sourceGroups = \[\.\.\.directGroups, \.\.\.expandedGroups\]/);
});

test("7f4. a failed host family is demoted for the next episode until it recovers", () => {
  const sandbox = vm.createContext({
    Date,
    Map,
    URL,
    location: { origin: "https://zenkaitv.test", hostname: "zenkaitv.test" },
    fallbackSourceIdentity: (source = {}) => [source.id, source.provider, source.videoUrl, source.externalUrl].filter(Boolean).join(" "),
    sourceDirectUrl: (source = {}) => source.videoUrl || "",
    sourcePreferenceScore: () => 5,
    originalStreamUrlFromProxy: (value) => value
  });
  vm.runInContext(
    section(clientSource, "function verifiedFallbackPreference(", "function pickFallbackRaceCandidates("),
    sandbox
  );

  const failedEpisode = { id: "animeav1-yourupload-e1", provider: "YourUpload", externalUrl: "https://www.yourupload.com/embed/e1" };
  const nextEpisodeSameHost = { id: "animeav1-yourupload-e2", provider: "YourUpload", externalUrl: "https://www.yourupload.com/embed/e2" };
  const alternative = { id: "jkanime-mp4upload-e2", provider: "MP4Upload", externalUrl: "https://mp4upload.com/embed/e2" };
  const freshHls = { id: "animeav1-upn-e2", provider: "UPNShare", externalUrl: "https://animeav1.uns.bio/e/e2" };
  const voeEmbed = { id: "animeav1-voe-e2", provider: "Voe", externalUrl: "https://voe.sx/e/e2" };
  const resolvedVoe = { id: "animeav1-voe-e2", provider: "Voe", videoUrl: "https://media.test/master.m3u8" };

  assert.ok(sandbox.verifiedFallbackPreference(freshHls) < sandbox.verifiedFallbackPreference(voeEmbed));
  assert.ok(sandbox.verifiedFallbackPreference(freshHls) < sandbox.verifiedFallbackPreference(alternative));
  assert.ok(sandbox.verifiedFallbackPreference(voeEmbed) < sandbox.verifiedFallbackPreference(alternative));
  assert.equal(sandbox.fallbackCandidateFamily(voeEmbed), "voe");
  assert.equal(sandbox.fallbackCandidateFamily(resolvedVoe), "voe");
  assert.equal(sandbox.fallbackCandidateFamily(freshHls), "upnshare");
  sandbox.recordPlaybackFamilyHealth(freshHls, false);
  assert.ok(sandbox.verifiedFallbackPreference(freshHls) > sandbox.verifiedFallbackPreference(voeEmbed));
  assert.equal(sandbox.hasRecentlyFailedPlaybackFamily({
    id: "animeav1-upn-e3", provider: "UPNShare", externalUrl: "https://animeav1.uns.bio/#next"
  }), true);
  sandbox.recordPlaybackFamilyHealth(failedEpisode, false);
  assert.equal(sandbox.hasRecentlyFailedPlaybackFamily(nextEpisodeSameHost), true);
  assert.ok(sandbox.verifiedFallbackPreference(nextEpisodeSameHost) > sandbox.verifiedFallbackPreference(alternative));
  sandbox.recordPlaybackFamilyHealth(nextEpisodeSameHost, true);
  assert.equal(sandbox.hasRecentlyFailedPlaybackFamily(nextEpisodeSameHost), false);
});

test("7f5. every selected source proves media and progressive mirrors prove continuation", () => {
  const inspection = section(
    clientSource,
    "function inspectPlaybackSourceHealth(",
    "async function verifyReliablePlaybackCandidate("
  );
  const preparation = section(
    clientSource,
    "async function prepareReliablePlaybackSource(",
    "function setupAdjacentEpisodeWarmup("
  );
  assert.doesNotMatch(clientSource, /canStartResolvedAdFreeFallback/);
  assert.doesNotMatch(inspection, /provisional:\s*true/);
  assert.match(clientSource, /const FALLBACK_RACE_LIMIT = 4/);
  assert.match(clientSource, /rangeSize\s*=\s*requiresSustainedProbe\s*\?\s*128 \* 1024\s*:\s*64 \* 1024/);
  assert.match(clientSource, /bytesPerSecond >= 96 \* 1024/);
  assert.doesNotMatch(clientSource, /trustedProvider\s*&&\s*playbackFamilyHealth\(source\)\s*===\s*true/);
  assert.match(inspection, /manifestOnly:\s*false/);
  assert.match(clientSource, /requiresSustainedProbe\s*=\s*\/\(\?:mp4upload\|yourupload\|youupload\|streamtape\)/);
  assert.match(clientSource, /rangeEnd\s*=\s*rangeStart \+ rangeSize - 1/);
  assert.match(clientSource, /reader\.read\(\)/);
  assert.match(clientSource, /minimumBytes\s*=\s*requiresSustainedProbe\s*\?\s*128\s*\*\s*1024\s*:\s*32\s*\*\s*1024/);
  assert.match(clientSource, /bytesPerSecond\s*>=\s*96\s*\*\s*1024/);
  assert.match(clientSource, /rangeStart:\s*1024 \* 1024/);
  assert.match(clientSource, /Promise\.all\(\[firstProbe, continuationProbe\]\)/);
  assert.doesNotMatch(preparation, /allowResolvedFallback/);
  assert.match(clientSource, /persistVerifiedFallbackSource\(episode, source, resolved, \{ verified: true \}\)/);
});

test("7f5b. HLS verification warms the segment used by a resumed episode", () => {
  const sandbox = vm.createContext({});
  vm.runInContext(
    section(clientSource, "function hlsManifestChildLine(", "async function probeHlsManifest("),
    sandbox
  );
  const manifest = [
    "#EXTM3U",
    "#EXTINF:6.0,",
    "segment-0.ts",
    "#EXTINF:6.0,",
    "segment-1.ts",
    "#EXTINF:6.0,",
    "segment-2.ts",
    "#EXT-X-ENDLIST"
  ].join("\n");
  assert.equal(sandbox.hlsManifestChildLine(manifest, 0), "segment-0.ts");
  assert.equal(sandbox.hlsManifestChildLine(manifest, 8), "segment-1.ts");
  assert.equal(sandbox.hlsManifestChildLine(manifest, 15), "segment-2.ts");
  assert.deepEqual(
    [...sandbox.hlsManifestMediaLines(manifest, 8, 2)],
    ["segment-1.ts", "segment-2.ts"]
  );
  assert.match(clientSource, /const results = await Promise\.all\(probes\)/);
  assert.match(clientSource, /results\.length > 0 && results\.every\(Boolean\)/);
  assert.match(clientSource, /startTime:\s*Math\.max\(0, Number\(getResumePosition\(episode\)\)/);
  assert.match(clientSource, /cacheCompleteSegment\s*\?\s*\{\}\s*:\s*\{ Range:/);
  assert.match(clientSource, /maxCachedSegmentBytes\s*=\s*12 \* 1024 \* 1024/);
  assert.match(clientSource, /if \(!streamEnded\) await reader\?\.cancel/);
});

test("7f6. VOE VOD fragments use a short shared CDN cache", () => {
  assert.match(serverSource, /const isCloudwindowVodSegment\s*=/);
  assert.match(serverSource, /isCloudwindowVodSegment[\s\S]+Vercel-CDN-Cache-Control/);
  assert.match(serverSource, /s-maxage=1800, stale-while-revalidate=3600/);
});

test("7f7. a failed primary gets one bounded backup-provider handoff before the final error", () => {
  const playback = section(
    clientSource,
    "function playActiveShow(",
    "function isExternalIframeEpisode("
  );
  const firstVerification = playback.indexOf("prepareReliablePlaybackSource(show, activeEpisode,");
  const backupLookup = playback.indexOf("attachPlaybackFailureFallbacks(show, activeEpisode)");
  const boundedWait = playback.indexOf("wait(RELIABLE_PLAYBACK_HANDOFF_WAIT_MS)");
  const secondVerification = playback.indexOf("timeoutMs: RELIABLE_PLAYBACK_HANDOFF_VERIFY_MS");
  const finalError = playback.indexOf('title: "Playback source unavailable"');

  assert.ok(firstVerification >= 0);
  assert.match(playback, /timeoutMs:\s*RELIABLE_PLAYBACK_FAST_TARGET_MS/);
  assert.match(playback, /primaryProbeMs:\s*RELIABLE_PLAYBACK_FAST_PRIMARY_MS/);
  assert.match(playback, /softFailures:\s*true/);
  assert.ok(backupLookup > firstVerification);
  assert.ok(boundedWait > backupLookup);
  assert.ok(secondVerification > boundedWait);
  assert.ok(finalError > secondVerification);
});

test("7g. all AnimeAV1 mirrors are available from one payload without duplicates", () => {
  const sandbox = vm.createContext({
    normalizeTitle: (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    simpleHash: (value) => String(value || "").length,
    embedProviderRank: (provider) => /upn/i.test(provider) ? 0 : /voe/i.test(provider) ? 1 : 2,
    isBlockedPlaybackSource: () => false,
    isUpnShareSource: sourceClassification.isUpnShareSource
  });
  vm.runInContext(
    section(clientSource, "function mergeAnimeAv1SourcesIntoEpisode(", "// ── JKAnime source integration"),
    sandbox
  );
  const episode = { sourceOptions: [] };
  const data = {
    episodeUrl: "https://animeav1.com/media/example/12",
    sources: [{ provider: "HLS", type: "direct", url: "/api/source?url=primary" }],
    castSources: [
      { provider: "HLS", type: "direct", url: "/api/source?url=primary" },
      { provider: "UPNShare", type: "iframe", externalUrl: "https://animeav1.uns.bio/#primary" },
      { provider: "Voe", type: "iframe", url: "https://voe.example/embed" },
      { provider: "MP4Upload", type: "iframe", url: "https://mp4upload.example/embed" },
      { provider: "MP4Upload duplicate", type: "iframe", url: "https://mp4upload.example/embed" },
      { provider: "Mega", type: "iframe", url: "https://mega.nz/file/download-only" },
      { provider: "MediaFire", type: "iframe", url: "https://mediafire.com/file/download-only" }
    ]
  };

  sandbox.mergeAnimeAv1SourcesIntoEpisode({}, episode, data, "example", 12);
  assert.deepEqual(Array.from(episode.sourceOptions, (source) => source.provider), ["HLS", "UPNShare", "Voe", "MP4Upload"]);

  sandbox.mergeAnimeAv1SourcesIntoEpisode({}, episode, data, "example", 12, { includeFallbacks: true });
  assert.deepEqual(Array.from(episode.sourceOptions, (source) => source.provider), ["HLS", "UPNShare", "Voe", "MP4Upload"]);
  assert.ok(episode.sourceOptions.every((source) => source.siteUrl === data.episodeUrl));
  assert.equal(new Set(episode.sourceOptions.map((source) => source.videoUrl || source.externalUrl)).size, 4);
});

test("7g2. AnimeAV1 embed-only episodes remain eligible for automatic playback", () => {
  const attachSection = section(clientSource, "async function attachAnimeAv1Sources(", "function mergeAnimeAv1SourcesIntoEpisode(");
  assert.match(attachSection, /!Array\.isArray\(data\.sources\) && !Array\.isArray\(data\.castSources\)/);
  assert.match(attachSection, /mergeAnimeAv1SourcesIntoEpisode\(show, episode, data, slug, epNum\)/);
  assert.match(serverSource, /ok: normalizedCastSources\.length > 0/);
});

test("7g3. TioAnime keeps every unique playable option and preserves direct-media metadata", () => {
  const sandbox = vm.createContext({
    normalizeTitle: (value) => String(value || "").toLowerCase(),
    simpleHash: (value) => value,
    embedProviderRank: () => 0,
    isBlockedPlaybackSource: (source) => source.provider === "Blocked"
  });
  vm.runInContext(section(clientSource, "function mergeTioAnimeSourcesIntoEpisode(", "// AnimeNeon is queried first"), sandbox);
  const data = {
    episodeUrl: "https://tioanime.com/ver/example-13",
    sources: [
      { provider: "MP4Upload", type: "iframe", url: "https://mp4upload.test/embed" },
      { provider: "Duplicate", type: "iframe", externalUrl: "https://mp4upload.test/embed" },
      { provider: "HLS", type: "direct", videoUrl: "https://media.test/master.m3u8", mimeType: "application/vnd.apple.mpegurl", container: "hls", codec: "avc1.42E01E", headers: { Referer: "https://tioanime.com/" } },
      { provider: "YourUpload", type: "iframe", externalUrl: "https://yourupload.test/embed" },
      { provider: "Blocked", type: "iframe", url: "https://blocked.test/" },
      { provider: "Mega", type: "iframe", url: "https://mega.nz/file/download-only" }
    ],
    mega: ["https://mega.nz/file/download-only"]
  };
  const episode = { sourceOptions: [] };
  sandbox.mergeTioAnimeSourcesIntoEpisode({}, episode, data, "example", 13);
  sandbox.mergeTioAnimeSourcesIntoEpisode({}, episode, data, "example", 13);
  assert.equal(episode.sourceOptions.length, 3);
  const direct = episode.sourceOptions.find((source) => source.type === "direct");
  assert.equal(direct.videoUrl, "https://media.test/master.m3u8");
  assert.equal(direct.externalUrl, "");
  assert.equal(direct.codec, "avc1.42E01E");
  assert.equal(direct.providerEpisodeId, 13);
  assert.equal(direct.headers.Referer, "https://tioanime.com/");
  assert.equal(episode.downloadUrl, data.mega[0]);
});

test("7h. latest releases fall back to session cache when local storage is full", () => {
  const sessionValues = new Map();
  const sandbox = vm.createContext({
    localStorage: {
      getItem: () => null,
      setItem: () => { throw new DOMException("Quota exceeded", "QuotaExceededError"); },
      removeItem() {}
    },
    sessionStorage: {
      getItem: (key) => sessionValues.get(key) || null,
      setItem: (key, value) => sessionValues.set(key, value),
      removeItem: (key) => sessionValues.delete(key)
    }
  });
  vm.runInContext(
    section(clientSource, "const ANIMEAV1_LATEST_CACHE_KEY", "async function loadAnimeAv1Latest("),
    sandbox
  );

  assert.equal(sandbox.writeAnimeAv1LatestCache([{ id: "latest-1" }], 1234), true);
  const cached = sandbox.readAnimeAv1LatestCache();
  assert.deepEqual(JSON.parse(JSON.stringify(cached)), {
    items: [{ id: "latest-1" }],
    cachedAt: 1234
  });
});

test("8. missing episode numbers are explicitly position-derived", () => {
  const { pipeline } = normalizationContext();
  const episodes = pipeline.normalizeEpisodes({ episodes: [{ title: "Pilot" }, { title: "Second" }] });
  assert.equal(episodes[0].canonicalEpisode, null);
  assert.equal(episodes[0].displayEpisodeNumber, 1);
  assert.equal(episodes[0].episodeNumberSource, "position");
  assert.equal(episodes[1].providerEpisodeId, null);
});

test("9. duplicate provider results merge by provider identity", () => {
  const { pipeline } = normalizationContext();
  const merged = pipeline.mergeEpisodes(
    [{ provider: "AnimeAV1", providerAnimeId: "example", providerEpisodeId: 7, season: 1, episode: 7, title: "Episode 7" }],
    [{ provider: "AnimeAV1", providerAnimeId: "example", providerEpisodeId: 7, season: 1, episode: 7, videoUrl: "https://video.test/7.mp4" }]
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].videoUrl, "https://video.test/7.mp4");
  assert.equal(merged[0].title, "Episode 7");
});

test("10. multiple source normalization preserves transport metadata", () => {
  const { pipeline } = normalizationContext();
  const sources = pipeline.normalizeEpisodeSourceOptions({
    providerEpisodeId: 4,
    sourceOptions: [
      { id: "hls", provider: "AnimeAV1", url: "https://video.test/a.m3u8", mimeType: "application/vnd.apple.mpegurl", codec: "avc1.42E01E", resolution: "1080p", bitrate: 4000000, headers: { Referer: "https://animeav1.com/" } },
      { id: "mp4", provider: "AnimeAV1", url: "https://video.test/a.mp4", mimeType: "video/mp4", codec: "h264" }
    ]
  });
  assert.equal(sources.length, 2);
  assert.equal(sources[0].resolution, "1080p");
  assert.equal(sources[0].headers.Referer, "https://animeav1.com/");
  assert.equal(sources[0].providerEpisodeId, 4);
});

test("11. a failed first source advances once to the next untried source", () => {
  const sandbox = vm.createContext({
    state: { preferredSource: "auto", activeEpisodeUrl: "" },
    getEpisodePlaybackSources: (episode) => episode.sourceOptions,
    isPreferredAdultSource: () => false,
    isAdultFallbackSource: () => false,
    sourcePreferenceScore: (source) => source.rank
  });
  vm.runInContext(section(clientSource, "function getSelectedEpisodeSource(", "function selectEpisodePlaybackSource("), sandbox);
  const episode = {
    sourceOptions: [{ id: "first", rank: 0 }, { id: "second", rank: 1 }],
    selectedSourceId: "first",
    _failedSourceIds: new Set(["first"])
  };
  assert.equal(sandbox.getSelectedEpisodeSource(episode).id, "second");
  episode._failedSourceIds.add("second");
  assert.equal(sandbox.getSelectedEpisodeSource(episode), null);
});

test("11b. choosing a fallback retries only that source and preserves other failures", () => {
  const sandbox = vm.createContext({
    state: { activeEpisodeUrl: "stale" },
    getEpisodePlaybackSources: (episode) => episode.sourceOptions
  });
  vm.runInContext(
    section(clientSource, "function selectEpisodePlaybackSource(", "function renderPlayerSourceOptions("),
    sandbox
  );
  const episode = {
    sourceOptions: [
      { id: "primary", type: "direct", videoUrl: "https://video.test/primary.m3u8" },
      { id: "fallback", type: "direct", videoUrl: "https://video.test/fallback.mp4" }
    ],
    _failedSourceIds: new Set(["primary", "fallback"]),
    _playbackFallbackPromptActive: true
  };

  assert.equal(sandbox.selectEpisodePlaybackSource(episode, "fallback").id, "fallback");
  assert.equal(episode._failedSourceIds.has("primary"), true);
  assert.equal(episode._failedSourceIds.has("fallback"), false);
  assert.equal(episode._playbackFallbackPromptActive, false);
});

test("11c. player reports manifest HTTP errors and timeouts before the normal HLS retry loop", () => {
  const handler = section(
    playerSource,
    "hls.on(window.Hls.Events.ERROR, (_, data) => {",
    "function scheduleHlsReload("
  );
  assert.ok(handler.indexOf("manifestUnavailable") < handler.indexOf("if (!data?.fatal) return"));
  assert.match(handler, /responseCode >= 400/);
  assert.match(handler, /\(\?:error\|timeout\)/);
  assert.match(playerSource, /manifestLoadingMaxRetry:\s*0/);
  const playerManifestTimeout = playerSource.match(/HLS_MANIFEST_LOADING_TIMEOUT_MS\s*=\s*sourceNeedsSlowManifestGrace\s*\?\s*(\d+)\s*:\s*(\d+)/);
  const clientManifestTimeout = clientSource.match(/manifestLoadingTimeOut:\s*streamNeedsSlowManifestGrace\(sourceUrl\)\s*\?\s*(\d+)\s*:\s*(\d+)/);
  assert.ok(Number(playerManifestTimeout?.[1]) >= 8000 && Number(playerManifestTimeout?.[1]) <= 10000);
  assert.ok(Number(playerManifestTimeout?.[2]) >= 4000 && Number(playerManifestTimeout?.[2]) <= 6000);
  assert.equal(Number(clientManifestTimeout?.[1]), Number(playerManifestTimeout?.[1]));
  assert.equal(Number(clientManifestTimeout?.[2]), Number(playerManifestTimeout?.[2]));
  assert.match(handler, /send\("error", "manifest-upstream-unavailable"\)/);
});

test("11c2. a pending play request cannot suppress the startup fallback watchdog", () => {
  const watchdog = section(
    playerSource,
    "function armStartupWatchdog()",
    "function clearStartupWatchdog()"
  );
  const deadlines = playerSource.match(/PLAYBACK_STARTUP_DEADLINE_MS\s*=\s*sourceIsHls\s*\?\s*(\d+)\s*:\s*(\d+)/);
  const hlsDeadline = Number(deadlines?.[1]);
  const directDeadline = Number(deadlines?.[2]);
  assert.ok(hlsDeadline >= 5500 && hlsDeadline <= 8000);
  assert.ok(directDeadline >= 4000 && directDeadline <= 8000);
  assert.doesNotMatch(watchdog, /!video\.paused/);
  assert.match(watchdog, /video\.readyState >= 2/);
  assert.match(watchdog, /send\("error", "startup-timeout"\)/);
});

test("11c3. a stream that stalls after startup escalates to automatic fallback", () => {
  const watchdog = section(
    playerSource,
    "function armStallWatchdog(",
    "function clearStallWatchdog()"
  );
  const deadlines = playerSource.match(/PLAYBACK_STALL_DEADLINE_MS\s*=\s*sourceIsHls\s*\?\s*(\d+)\s*:\s*(\d+)/);
  const hlsDeadline = Number(deadlines?.[1]);
  const directDeadline = Number(deadlines?.[2]);
  const bufferingHandlers = section(
    playerSource,
    'art.on("video:waiting"',
    'art.on("video:seeked"'
  );
  const destroy = section(playerSource, "function destroyPlayer()", "function cssUrl(");
  assert.ok(hlsDeadline >= 5000 && hlsDeadline <= 9000);
  assert.ok(directDeadline >= 4000 && directDeadline <= 7000);
  assert.match(watchdog, /if \(!playbackHasStarted\) return/);
  assert.match(playerSource, /art\.on\("video:playing", \(\) => \{\s*playbackHasStarted = true/);
  assert.match(bufferingHandlers, /armStallWatchdog\("waiting"\)/);
  assert.match(bufferingHandlers, /armStallWatchdog\("stalled"\)/);
  assert.match(watchdog, /send\("error", `playback-stalled:/);
  assert.doesNotMatch(watchdog, /progressed \|\| bufferedAhead/);
  assert.match(destroy, /clearStallWatchdog\(\)/);
});

test("11c3b. silent freezes and repeated short rebuffers replace an unhealthy source", () => {
  const healthMonitor = section(
    playerSource,
    "function resetPlaybackHealth(",
    "function startStatusLoop()"
  );
  const statusLoop = section(
    playerSource,
    "function startStatusLoop()",
    "function stopStatusLoop()"
  );
  const bufferingHandlers = section(
    playerSource,
    'art.on("video:waiting"',
    'art.on("video:seeked"'
  );

  assert.match(playerSource, /PLAYBACK_REBUFFER_WINDOW_MS\s*=\s*45 \* 1000/);
  assert.match(playerSource, /PLAYBACK_REBUFFER_EVENT_LIMIT\s*=\s*3/);
  assert.match(healthMonitor, /document\.hidden \|\| video\.seeking/);
  assert.match(playerSource, /visibilitychange", onPlaybackVisibilityChange/);
  assert.match(healthMonitor, /function onPlaybackVisibilityChange\(\) \{\s*clearStallWatchdog\(\);\s*cancelRebufferObservation\(\);\s*resetPlaybackHealth/);
  assert.match(healthMonitor, /reportPlaybackStall\("progress-watchdog"/);
  assert.match(healthMonitor, /rebufferHistory\.length >= PLAYBACK_REBUFFER_EVENT_LIMIT/);
  assert.match(bufferingHandlers, /beginRebufferObservation\(\)/);
  assert.match(statusLoop, /monitorPlaybackHealth\(art\?\.video\)/);
  assert.match(playerSource, /finishRebufferObservation\(video\)/);
  assert.match(playerSource, /cancelRebufferObservation\(\);\s*resetPlaybackHealth\(art\?\.video\)/);
});

test("11c3c. adaptive playback keeps a conservative rendition and a larger forward buffer", () => {
  assert.match(playerSource, /maxBufferLength:\s*90/);
  assert.match(playerSource, /maxMaxBufferLength:\s*180/);
  assert.match(playerSource, /abrBandWidthFactor:\s*0\.75/);
  assert.match(playerSource, /abrBandWidthUpFactor:\s*0\.5/);
  assert.match(playerSource, /maxStarvationDelay:\s*2/);
  assert.match(playerSource, /maxLoadingDelay:\s*2/);
});

test("11c4. one episode has one active playback run and stale runs are rejected", async () => {
  const show = { id: "show-1" };
  const firstEpisode = { id: "show-1-s1-e1", canonicalSeason: 1, canonicalEpisode: 1 };
  const secondEpisode = { id: "show-1-s1-e2", canonicalSeason: 1, canonicalEpisode: 2 };
  const state = {
    activeShow: show,
    activeEpisode: { season: { season: 1 }, episode: firstEpisode, seasonIndex: 0, episodeIndex: 0 }
  };
  const contexts = [];
  const pending = [];
  const sandbox = vm.createContext({
    state,
    getShowKey: (value = {}) => value.id || "show",
    getCanonicalEpisodeNumber: (episode = {}, fallback = 1) => (
      Number(episode.canonicalEpisode ?? episode.episode ?? fallback)
    ),
    runActivePlaybackAttempt: (_options, context) => {
      contexts.push(context);
      return new Promise((resolve) => pending.push(resolve));
    }
  });
  vm.runInContext(
    section(clientSource, "let activePlaybackAttemptSequence", "function stopActivePlayback()"),
    sandbox
  );
  vm.runInContext(
    section(clientSource, "function playActiveShow(", "async function runActivePlaybackAttempt("),
    sandbox
  );

  const first = sandbox.playActiveShow();
  const duplicate = sandbox.playActiveShow();
  assert.equal(first, duplicate);
  assert.equal(contexts.length, 1);

  state.activeEpisode = { season: { season: 1 }, episode: secondEpisode, seasonIndex: 0, episodeIndex: 1 };
  const second = sandbox.playActiveShow();
  assert.notEqual(second, first);
  assert.equal(contexts.length, 2);
  assert.equal(sandbox.isPlaybackAttemptCurrent(contexts[0], show, firstEpisode), false);
  assert.equal(sandbox.isPlaybackAttemptCurrent(contexts[1], show, secondEpisode), true);

  pending.forEach((resolve) => resolve());
  await Promise.all([first, second]);
});

test("11d. mounting HLS preconnects without issuing a duplicate manifest probe", () => {
  const renderer = section(
    clientSource,
    "function renderDirectVideoPlayer(",
    "function renderPlaybackError("
  );
  assert.match(renderer, /preconnectOnly:\s*streamType\s*===\s*"hls"/);
  assert.match(renderer, /hasFreshVerifiedPlaybackSource\(selectedSource\)/);
  assert.match(clientSource, /options\.preconnectOnly \|\| streamTypeFromUrl\(resolved\) === "hls"/);
  const warmupWiring = section(
    clientSource,
    "function wireSourceButtonWarmups(",
    "function isLocalSourceProxyUrl("
  );
  assert.match(warmupWiring, /if \(sourceButtons\.length\) warmTopEpisodeSources/);
});

test("11e. fallback selection leaves the zero-size cinema mount for the visible side panel", () => {
  const panelHelper = section(
    clientSource,
    "function showSourcePickerPanel(",
    "function wirePlayerChrome("
  );
  assert.match(panelHelper, /showEpisodeListTab\(\)/);
  assert.match(panelHelper, /renderSourcePickerInSidePanel\(\)/);

  const errorRenderer = section(
    clientSource,
    "function renderPlaybackError(",
    "function playEpisodeByPosition("
  );
  assert.match(errorRenderer, /data-try-another[^\n]*addEventListener\("click", showSourcePickerPanel\)/);
  assert.doesNotMatch(errorRenderer, /data-try-another[^\n]*renderSourcePickerIn\(frame\)/);
});

test("11f. recovery offers exactly one verified source", () => {
  const sandbox = vm.createContext({
    getEpisodePlaybackSources: (episode) => episode.sourceOptions
  });
  vm.runInContext(
    section(clientSource, "function getSourcePickerPlaybackSources(", "function getSourcePickerServerDefinitions("),
    sandbox
  );
  const episode = {
    sourceOptions: [
      { id: "failed" },
      { id: "verified", verifiedPlayable: true },
      { id: "unverified" }
    ],
    _failedSourceIds: new Set(["failed"]),
    _playbackFallbackPromptActive: true,
    _verifiedFallbackSourceId: "verified"
  };
  assert.deepEqual(Array.from(sandbox.getSourcePickerPlaybackSources(episode), (source) => source.id), ["verified"]);
});

test("11g. fallback verification admits ad-walled hosts only through direct media resolution", () => {
  const sandbox = vm.createContext({
    isAnimeAv1Source: sourceClassification.isAnimeAv1Source,
    isTioAnimeSource: sourceClassification.isTioAnimeSource,
    location: { hostname: "zenkaitv.com" },
    originalStreamUrlFromProxy: (value) => value,
    sourceDirectUrl: (source) => source.videoUrl || "",
    embedProviderRank: (identity) => {
      const value = String(identity).toLowerCase();
      if (value.includes("yourupload") || value.includes("mp4upload")) return 0;
      if (value.includes("voe") || value.includes("vidhide")) return 2;
      return 1;
    }
  });
  vm.runInContext(
    `${section(clientSource, "function isDirectMediaResolverCandidate(", "function isFastPreferredPlaybackSource(")}\n${section(clientSource, "function fallbackSourceIdentity(", "function verifiedFallbackPreference(")}`,
    sandbox
  );
  assert.equal(sandbox.isAdFreeFallbackCandidate({ type: "iframe", provider: "YourUpload", externalUrl: "https://yourupload.test/embed" }), true);
  assert.equal(sandbox.isAdFreeFallbackCandidate({ type: "iframe", provider: "Voe", externalUrl: "https://voe.sx/e/working", adWalled: true }), false);
  assert.equal(sandbox.isAdFreeFallbackCandidate({ type: "iframe", provider: "Streamtape", externalUrl: "https://streamtape.com/e/working/video.mp4" }), true);
  assert.equal(sandbox.isAdFreeFallbackCandidate({ type: "iframe", provider: "Streamwish", externalUrl: "https://sfastwish.com/e/working", adWalled: true }), false);
  assert.equal(sandbox.isAdFreeFallbackCandidate({ type: "iframe", provider: "Vidhide", externalUrl: "https://vidhidevip.com/embed/working", adWalled: true }), true);
  assert.equal(sandbox.isAdFreeFallbackCandidate({ type: "iframe", provider: "Voe", externalUrl: "https://unknown.test/embed", adWalled: true }), false);
  assert.equal(sandbox.isAdFreeFallbackCandidate({ type: "iframe", provider: "Unknown", externalUrl: "https://unknown.test/embed" }), false);
  assert.equal(sandbox.isAdFreeFallbackCandidate({ id: "animeav1-byse", type: "iframe", provider: "Byse", externalUrl: "https://byselapuix.test/embed" }), true);
  assert.equal(sandbox.isAdFreeFallbackCandidate({ id: "tioanime-mirror", type: "iframe", provider: "Mirror", externalUrl: "https://mirror.test/embed", adWalled: true }), true);
  assert.equal(sandbox.isAdFreeFallbackCandidate({ id: "animeav1-mirror", type: "iframe", externalUrl: "javascript:alert(1)" }), false);
  assert.equal(sandbox.isAdFreeFallbackCandidate({ type: "iframe", provider: "Mega", externalUrl: "https://mega.nz/file/download-only" }), false);
  assert.equal(sandbox.isAdFreeFallbackCandidate({ type: "iframe", provider: "MediaFire", externalUrl: "https://mediafire.com/file/download-only" }), false);
  assert.equal(sandbox.isAdFreeFallbackCandidate({ type: "direct", videoUrl: "https://video.test/episode.mp4" }), true);
  assert.equal(sandbox.isAdFreeFallbackCandidate({ type: "direct", provider: "Voe", videoUrl: "https://video.test/master.m3u8", adWalled: false }), false);
  assert.equal(sandbox.isAdFreeFallbackCandidate({ type: "direct", videoUrl: "https://ugc.cloudwindow-route.com/master.m3u8" }), false);
  const animeAv1Upn = {
    id: "animeav1-upnshare-1",
    type: "iframe",
    externalUrl: "https://animeav1.uns.bio/#episode",
    streamResolver: { endpoint: "/api/resolve" }
  };
  assert.equal(sandbox.isAdFreeFallbackCandidate(animeAv1Upn), false);
  sandbox.location.hostname = "localhost";
  assert.equal(sandbox.isAdFreeFallbackCandidate({ type: "iframe", provider: "Voe", externalUrl: "https://voe.sx/e/working", adWalled: true }), true);
  assert.equal(sandbox.isAdFreeFallbackCandidate({ type: "iframe", provider: "Streamwish", externalUrl: "https://sfastwish.com/e/working", adWalled: true }), true);
  assert.equal(sandbox.isAdFreeFallbackCandidate(animeAv1Upn), true);
});

test("11g2. verified fallback playback keeps the same referer-aware proxy used by its probe", () => {
  const sandbox = vm.createContext({
    Date,
    proxiedStreamUrl: (url, referer) => `/api/source?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(referer)}`,
    normalizeEpisodeSourceOptions: (episode) => episode.sourceOptions,
    getEpisodePlaybackSources: (episode) => episode.sourceOptions
  });
  vm.runInContext(
    section(clientSource, "function persistVerifiedFallbackSource(", "function verifyFallbackCandidate("),
    sandbox
  );
  const episode = {
    sourceOptions: [{ id: "backup", type: "iframe", externalUrl: "https://embed.test/e/1" }]
  };
  const source = episode.sourceOptions[0];
  const selected = sandbox.persistVerifiedFallbackSource(episode, source, {
    url: "https://media.test:183/video.mp4",
    mediaReferer: "https://embed.test/e/1"
  });

  assert.equal(selected.type, "direct");
  assert.equal(selected.externalUrl, "");
  assert.match(selected.videoUrl, /^\/api\/source\?/);
  assert.match(selected.videoUrl, /referer=https%3A%2F%2Fembed\.test%2Fe%2F1/);
});

test("11h. playback failure verifies and opens the backup without asking", () => {
  const renderer = section(
    clientSource,
    "function renderDirectVideoPlayer(",
    "function renderPlaybackError("
  );
  assert.match(renderer, /findVerifiedAdFreeFallbackSource\(episode\)/);
  assert.ok(renderer.indexOf("prepareReliablePlaybackSource(") < renderer.indexOf("await Promise.race([firstCandidateReady"));
  assert.match(renderer, /selectEpisodePlaybackSource\(episode, verifiedFallback\.id\)/);
  assert.match(renderer, /playActiveShow\(\{ allowSourceLookup: false, restart: true \}\)/);
  assert.match(renderer, /selectedSource\.id !== activeSource\.id/);
  assert.doesNotMatch(renderer, /Use verified source/);
  assert.match(clientSource, /probePlayableFallback\(resolved, \{/);
  assert.match(clientSource, /verifyFallbackCandidate\(episode, source, \{/);
  assert.match(renderer, /refreshProviderKeys:\s*playbackRecoveryProviderKeys\(episode, activeSource\)/);
});

function lastResortFallbackContext(overrides = {}) {
  const sandbox = vm.createContext({
    Date, Set,
    RELIABLE_PLAYBACK_TOTAL_BUDGET_MS: 14000,
    RELIABLE_PLAYBACK_PRIMARY_PROBE_MS: 5000,
    getEpisodePlaybackSources: (episode) => episode.sourceOptions,
    isAdFreeFallbackCandidate: () => true,
    verifiedFallbackPreference: () => 0,
    pickFallbackRaceCandidates: (sources) => sources.slice(0, 4),
    firstSuccessfulFallback: (tasks) => Promise.any(tasks.map(async (task) => {
      const result = await task;
      if (!result) throw new Error("unavailable");
      return result;
    })).catch(() => null),
    ...overrides
  });
  vm.runInContext(section(clientSource, "async function findVerifiedAdFreeFallbackSource(", "function playbackSourceHealthKey("), sandbox);
  return sandbox;
}

test("11h2. last-resort recovery refills failed slots beyond the first four mirrors", async () => {
  const sources = Array.from({ length: 11 }, (_, index) => ({ id: `mirror-${index}` }));
  const checked = new Set();
  let active = 0;
  let peak = 0;
  const sandbox = lastResortFallbackContext({
    verifyFallbackCandidate: async (_episode, source, options) => {
      assert.ok(!checked.has(source.id));
      checked.add(source.id);
      assert.ok(options.timeoutMs <= 5000);
      assert.ok(options.deadlineAt > Date.now());
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return source === sources[9] ? source : null;
    }
  });
  const episode = { sourceOptions: sources };
  const first = sandbox.findVerifiedAdFreeFallbackSource(episode);
  const second = sandbox.findVerifiedAdFreeFallbackSource(episode);
  assert.equal((await first)?.id, "mirror-9");
  assert.equal((await second)?.id, "mirror-9");
  assert.ok(peak <= 4);
  assert.equal(episode._verifiedFallbackPromise, null);
});

test("11h3. last-resort recovery stops queueing work after success or deadline", async () => {
  const checked = [];
  const sandbox = lastResortFallbackContext({
    verifyFallbackCandidate: async (_episode, source) => {
      checked.push(source.id);
      if (source.id === "mirror-0") return source;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return null;
    }
  });
  const episode = { sourceOptions: Array.from({ length: 12 }, (_, index) => ({ id: `mirror-${index}` })) };
  assert.equal((await sandbox.findVerifiedAdFreeFallbackSource(episode)).id, "mirror-0");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(checked.length, 4);

  let now = 1000;
  const expiredChecks = [];
  const expired = lastResortFallbackContext({
    Date: { now: () => now },
    RELIABLE_PLAYBACK_TOTAL_BUDGET_MS: 900,
    verifyFallbackCandidate: async (_episode, source) => {
      expiredChecks.push(source.id);
      now += 1000;
      return null;
    }
  });
  assert.equal(await expired.findVerifiedAdFreeFallbackSource(episode), null);
  assert.equal(expiredChecks.length, 1);
});

test("11h4. last-resort verification reuses shared health checks and the resume position", async () => {
  let checks = 0;
  let release;
  const resolved = { url: "https://media.test/episode.mp4" };
  const sandbox = vm.createContext({
    Map,
    getResumePosition: () => 45,
    inspectPlaybackSourceHealth: async (_source, options) => {
      checks++;
      assert.equal(options.startTime, 45);
      await new Promise((resolve) => { release = resolve; });
      return resolved;
    },
    persistVerifiedFallbackSource: (_episode, source) => source
  });
  vm.runInContext(section(clientSource, "function verifyFallbackCandidate(", "async function findVerifiedAdFreeFallbackSource("), sandbox);
  const episode = {};
  const source = { id: "backup" };
  const first = sandbox.verifyFallbackCandidate(episode, source);
  const second = sandbox.verifyFallbackCandidate(episode, source);
  assert.equal(first, second);
  release();
  assert.equal(await first, source);
  assert.equal(checks, 1);
  assert.equal(episode._fallbackVerificationPromises.size, 0);
});

test("11i. fallback verification stays diverse and reserves a progressive candidate", async () => {
  const sandbox = vm.createContext({
    URL,
    location: { origin: "https://app.test", hostname: "app.test" },
    fallbackSourceIdentity: (source = {}) => [source.id, source.provider, source.videoUrl].filter(Boolean).join(" "),
    sourceDirectUrl: (source = {}) => source.videoUrl || "",
    originalStreamUrlFromProxy: (value) => value
  });
  vm.runInContext(
    section(clientSource, "function fallbackCandidateFamily(", "async function resolveFallbackCandidateToDirect("),
    sandbox
  );

  const candidates = [
    { id: "yourupload-1", provider: "YourUpload" },
    { id: "yourupload-2", provider: "YourUpload" },
    { id: "mp4upload", provider: "MP4Upload" },
    { id: "okru", provider: "OK.ru" }
  ];
  assert.deepEqual(
    Array.from(sandbox.pickFallbackRaceCandidates(candidates, 3), (source) => source.id),
    ["yourupload-1", "mp4upload", "okru"]
  );
  const hlsHeavyCandidates = [
    { id: "voe", provider: "VOE" },
    { id: "streamwish", provider: "Streamwish" },
    { id: "vidhide", provider: "Vidhide" },
    { id: "streamtape", provider: "Streamtape" },
    { id: "mp4upload-working", provider: "MP4Upload" }
  ];
  assert.deepEqual(
    Array.from(sandbox.pickFallbackRaceCandidates(hlsHeavyCandidates, 4), (source) => source.id),
    ["voe", "streamwish", "vidhide", "mp4upload-working"]
  );

  const winner = await sandbox.firstSuccessfulFallback([
    Promise.resolve(null),
    Promise.resolve({ id: "working" }),
    new Promise((resolve) => setTimeout(() => resolve({ id: "slower" }), 10))
  ]);
  assert.equal(winner.id, "working");
  assert.match(clientSource, /const FALLBACK_RACE_LIMIT = 4/);
  assert.match(clientSource, /_verifiedFallbackSourceIds/);
});

test("12. HLS sources retain manifest MIME and container", () => {
  const { pipeline } = normalizationContext();
  const [source] = pipeline.normalizeEpisodeSourceOptions({
    sourceOptions: [{ id: "hls", provider: "AnimeAV1", url: "https://video.test/master.m3u8", mimeType: "application/vnd.apple.mpegurl", container: "hls" }]
  });
  assert.equal(source.videoUrl, "https://video.test/master.m3u8");
  assert.equal(source.mimeType, "application/vnd.apple.mpegurl");
  assert.equal(source.container, "hls");
});

test("12b. the primary and regular backup providers remain identifiable after normalization", () => {
  const animeNeon = { id: "animeneon-sub-voe-1", provider: "VOE", siteUrl: "https://animeneon.net/ver/example-1.id" };
  const animeAv1 = { id: "animeav1-hls-1", provider: "AnimeAV1", type: "direct", videoUrl: "https://video.test/master.m3u8" };
  assert.equal(sourceClassification.isAnimeNeonSource(animeNeon), true);
  assert.equal(sourceClassification.isJKAnimeSource({ id: "jkanime-ribbon-1", provider: "Streamwish" }), true);
  assert.equal(sourceClassification.isTioAnimeSource({ id: "tioanime-ribbon-1", provider: "YourUpload" }), true);
  assert.equal(sourceClassification.isTioAnimeSource({ id: "underhentai-ribbon-1" }), false);
  assert.ok(sourceClassification.sourcePreferenceScore(animeNeon) < sourceClassification.sourcePreferenceScore(animeAv1));
});

test("13. AV1 remains available but ranks behind supported H264 when unsupported", () => {
  const previous = globalThis.MediaSource;
  globalThis.MediaSource = { isTypeSupported: (mime) => !mime.includes("av01") };
  try {
    const av1 = { provider: "AnimeAV1", type: "direct", videoUrl: "https://video.test/a.m3u8", codec: "av01" };
    const h264 = { provider: "AnimeAV1", type: "direct", videoUrl: "https://video.test/b.m3u8", codec: "avc1.42E01E" };
    assert.equal(sourceClassification.declaredVideoCodec(av1), "av1");
    assert.ok(sourceClassification.sourcePreferenceScore(h264) < sourceClassification.sourcePreferenceScore(av1));
  } finally {
    if (previous === undefined) delete globalThis.MediaSource;
    else globalThis.MediaSource = previous;
  }
});

test("6b. catalog search tolerates a one-letter title typo without dropping another token", () => {
  const liarGame = { title: "Liar Game", aliases: ["LIAR GAME"] };
  const unrelated = { title: "Darling in the Franxx" };
  const context = searchContext([liarGame, unrelated], "lier game");
  assert.equal(context.matchesShowSearch(liarGame), true);
  assert.equal(context.matchesShowSearch(unrelated), false);
  context.state.search = "liar game";
  assert.equal(context.matchesShowSearch(liarGame), true);
});

test("6c. AnimeAV1 source results expand matches beyond visible local titles", () => {
  const sourceOnlyMatch = { id: "animeav1-dragon-ball-daima", title: "Daima" };
  const context = searchContext([sourceOnlyMatch], "Dragon Ball");
  context.sourceSearchMatches.set("dragon ball", new Set(["dragon-ball-daima"]));
  assert.equal(context.matchesShowSearch(sourceOnlyMatch), true);
});

test("13b. Hentai Ocean remains behind the UnderHentai primary source", () => {
  const underHentai = {
    id: "underhentai-release",
    label: "UnderHentai",
    type: "resolver",
    streamResolver: { type: "underhentai", endpoint: "/api/adult/underhentai/stream?episode=1" }
  };
  const hentaiOcean = {
    id: "hentaiocean-av01-sample-1",
    label: "Hentai Ocean AV1",
    provider: "Hentai Ocean",
    type: "direct",
    videoUrl: "/api/source?url=https%3A%2F%2Fw2.hentaiocean.com%2Fvideo%2Fsample.mp4",
    codec: "av01"
  };
  assert.ok(
    sourceClassification.sourcePreferenceScore(underHentai) < sourceClassification.sourcePreferenceScore(hentaiOcean),
    "secondary direct media must not displace the primary resolver"
  );
});

test("14. next episode follows 12 to 12.5 instead of adding one", () => {
  const season = { season: 1, episodes: [{ id: "e12", episode: 12 }, { id: "e12-5", episode: 12.5 }, { id: "e13", episode: 13 }] };
  const c = navigationContext([season], { season, episode: season.episodes[0], seasonIndex: 0, episodeIndex: 0 });
  const target = c.getEpisodeNavigationTargets().next;
  assert.deepEqual({ seasonIndex: target.seasonIndex, episodeIndex: target.episodeIndex }, { seasonIndex: 0, episodeIndex: 1 });
});

test("15. the final episode advances only to the next real season", () => {
  const seasons = [
    { season: 1, episodes: [{ id: "s1e1", episode: 1 }] },
    { season: 2, episodes: [{ id: "s2e1", episode: 1 }] }
  ];
  const c = navigationContext(seasons, { season: seasons[0], episode: seasons[0].episodes[0], seasonIndex: 0, episodeIndex: 0 });
  const target = c.getEpisodeNavigationTargets().next;
  assert.deepEqual({ seasonIndex: target.seasonIndex, episodeIndex: target.episodeIndex }, { seasonIndex: 1, episodeIndex: 0 });
});

test("16. refresh persistence retains split-cour provider offsets", () => {
  const store = new Map();
  const sandbox = vm.createContext({
    Date,
    localStorage: { getItem: (key) => store.get(key) || null, setItem: (key, value) => store.set(key, value) }
  });
  const cacheSection = section(clientSource, "const FRANCHISE_ROUTE_CACHE_KEY", "function findShowBySlugOrId(");
  vm.runInContext(`${cacheSection}\nthis.routeCache = { readFranchiseRoutes, rememberFranchiseRoutes };`, sandbox);
  sandbox.routeCache.rememberFranchiseRoutes([{
    id: "anilist-127720",
    anilistId: 127720,
    title: "Mushoku Tensei Part 2",
    isFranchiseEntry: true,
    canonicalSeasonNumber: 1,
    canonicalSeasonPart: 2,
    providerEpisodeOffset: 11,
    providerBaseTitle: "Mushoku Tensei",
    franchiseSeasons: [{ anilistId: 108465 }, { anilistId: 127720 }]
  }]);
  const restored = sandbox.routeCache.readFranchiseRoutes()[0].show;
  assert.equal(restored.canonicalSeasonNumber, 1);
  assert.equal(restored.canonicalSeasonPart, 2);
  assert.equal(restored.providerEpisodeOffset, 11);
});

test("17. mobile route application preserves Season 2 Episode 3", () => {
  const seasons = [
    { season: 1, episodes: [{ id: "s1e1", episode: 1 }] },
    { season: 2, episodes: [{ id: "s2e1", episode: 1 }, { id: "s2e2", episode: 2 }, { id: "s2e3", episode: 3 }] }
  ];
  const c = applyTargetContext(seasons);
  c.state.mobileViewport = true;
  c.applyOpenTarget({ title: "Example Season 2" }, { seasonNumber: 2, episodeNumber: 3 });
  assert.equal(c.state.activeSeasonIndex, 1);
  assert.equal(c.state.activeEpisode.episode.id, "s2e3");
});

test("phone gallery lightboxes stay disabled at 760px and below", () => {
  const isDisabledAt = (innerWidth, clientWidth = innerWidth) => {
    const sandbox = vm.createContext({
      Math,
      Number,
      window: { innerWidth },
      document: { documentElement: { clientWidth } }
    });
    vm.runInContext(
      section(clientSource, "function isPhoneGalleryPopupDisabled(", "function stopActivePlayback("),
      sandbox
    );
    return sandbox.isPhoneGalleryPopupDisabled();
  };

  assert.equal(isDisabledAt(390), true);
  assert.equal(isDisabledAt(760), true);
  assert.equal(isDisabledAt(761), false);
  assert.equal(isDisabledAt(390, 1024), false);
  assert.equal(
    (clientSource.match(/if \(isPhoneGalleryPopupDisabled\(\)\) return;/g) || []).length,
    2,
    "both adult gallery thumbnail handlers must block phone lightboxes"
  );
});

test("18. Cast candidates start with the selected source from the active episode", () => {
  const episode = {
    selectedSourceId: "selected",
    videoUrl: "https://video.test/active.m3u8",
    sourceOptions: [
      { id: "active", label: "Active", videoUrl: "https://video.test/active.m3u8" },
      { id: "selected", label: "Selected", videoUrl: "https://video.test/selected.m3u8" }
    ]
  };
  const sandbox = vm.createContext({
    state: { activeEpisode: { episode } },
    getEpisodePlaybackSources: (value) => value.sourceOptions,
    getSelectedEpisodeSource: (value) => value.sourceOptions.find((source) => source.id === value.selectedSourceId),
    isActivePlaybackSource: (source, value) => source.videoUrl === value.videoUrl,
    isLocalSourceProxyUrl: () => false,
    localSourceProxyPath: (url) => url,
    resolveSourceEndpoint: (url) => url,
    streamTypeFromUrl: () => "hls"
  });
  vm.runInContext(section(clientSource, "function buildCastCandidateList(", "// The poster travels"), sandbox);
  const candidates = sandbox.buildCastCandidateList();
  assert.equal(candidates[0].label, "Selected");
  assert.equal(candidates.length, 2);
});

test("19. stale provider season routes use the canonical sequel and cour identity", () => {
  const state = { activeShow: null, activeEpisode: null, activeSeasonIndex: 0 };
  const sandbox = vm.createContext({
    state,
    SeasonNormalization,
    appRouter: () => ({
      episodeSlug: (season, episode, part) => `s${season}${part ? `-part-${part}` : ""}-e${episode}`
    }),
    getShowSlug: (show = {}) => show.slug || "example"
  });
  vm.runInContext(section(clientSource, "function episodePathForShow(", "const FRANCHISE_ROUTE_CACHE_KEY"), sandbox);
  vm.runInContext(section(clientSource, "function selectedSeasonIdentity(", "function selectedSeasonLabel("), sandbox);
  const show = {
    slug: "example-season-2",
    canonicalSeasonNumber: 2,
    canonicalSeasonPart: 1,
    seasons: [{ season: 1, episodes: [{ season: 1, episode: 3 }] }]
  };
  assert.equal(
    sandbox.episodePathForShow(show, 1, 3, ""),
    "/watch/example-season-2/s2-part-1-e3"
  );

  const chainOnlyShow = {
    slug: "example-season-2",
    anilistId: 2,
    canonicalSeasonNumber: 2,
    canonicalSeasonPart: null,
    isFranchiseEntry: true,
    franchiseSeasons: [
      { anilistId: 1, title: "Example", format: "TV", episodes: 12, seasonYear: 2021 },
      { anilistId: 2, title: "Example II", format: "TV", episodes: 12, seasonYear: 2022 },
      { anilistId: 3, title: "Example II Part 2", format: "TV", episodes: 12, seasonYear: 2023 }
    ],
    seasons: [
      { season: 1, title: "Season 1", episodes: [{ season: 1, episode: 3 }] },
      { season: 1, title: "Season 1", episodes: [] }
    ]
  };
  const selected = {
    season: chainOnlyShow.seasons[0],
    episode: chainOnlyShow.seasons[0].episodes[0],
    seasonIndex: 0,
    episodeIndex: 0
  };
  state.activeShow = chainOnlyShow;
  state.activeEpisode = selected;
  vm.runInContext(section(clientSource, "function selectedSeasonLabel(", "function normalizeDisplayText("), sandbox);
  assert.equal(
    sandbox.episodePathForShow(chainOnlyShow, 1, 3, ""),
    "/watch/example-season-2/s2-part-1-e3"
  );
  assert.equal(sandbox.selectedSeasonLabel(selected), "Season 2 Part 1");
});

test("20. a resolved URL mounts after the first episode-row click", async () => {
  let plays = 0;
  const episode = { id: "show-s2-e3", videoUrl: "https://media.example/episode.m3u8" };
  const frame = { querySelector: () => null };
  const sandbox = vm.createContext({
    state: { playIntent: true, activeEpisode: { episode }, activeEpisodeUrl: "" },
    location: { hostname: "example.test" },
    console: { debug() {} },
    document: { querySelector: (selector) => selector === "#videoFrame" ? frame : null },
    getEpisodeUrl: (value) => value.videoUrl || "",
    getSelectedEpisodeSource: (value) => value.sourceOptions?.[0] || null,
    playActiveShow: async () => { plays += 1; }
  });
  vm.runInContext(section(clientSource, "function debugPromotion(", "function getSelectedEpisodeSource("), sandbox);
  assert.equal(sandbox.promoteResolvedEpisodeSource(episode), true);
  await Promise.resolve();
  assert.equal(plays, 1);
  assert.equal(sandbox.state.activeEpisodeUrl, episode.videoUrl);

  frame.querySelector = () => ({ id: "animePlayerFrame" });
  assert.equal(sandbox.promoteResolvedEpisodeSource(episode), false);
  await Promise.resolve();
  assert.equal(plays, 1);

  const lateSourceEpisode = {
    id: "show-s2-e4",
    sourceOptions: [{ id: "backup", type: "direct", videoUrl: "https://media.example/late.mp4" }]
  };
  sandbox.state.activeEpisode = { episode: lateSourceEpisode };
  sandbox.state.activeEpisodeUrl = "";
  assert.equal(sandbox.promoteResolvedEpisodeSource(lateSourceEpisode), false);
  await Promise.resolve();
  assert.equal(plays, 1);
  assert.equal(lateSourceEpisode.videoUrl, undefined);
});

test("21. an episode-row click reaches source scheduling with canonical season identity", () => {
  let scheduled = null;
  let loadingFeedback = null;
  const episode = { id: "show-s2-e3", episode: 3, canonicalEpisode: 3 };
  const season = { season: 2, part: 1, episodes: [episode] };
  const state = {
    activeShow: { id: "show", slug: "show", canonicalSeasonNumber: 2, canonicalSeasonPart: 1 },
    activeEpisode: null,
    activeSeasonIndex: 0,
    episodeChunkByContext: {},
    currentRouteInfo: null
  };
  const frame = { style: { setProperty() {} } };
  const sandbox = vm.createContext({
    state,
    getDetailSeasons: () => [season],
    getEpisodeUrl: () => "",
    selectedSeasonIdentity: () => ({ seasonNumber: 2, seasonPart: 1 }),
    getCanonicalEpisodeNumber: (value, fallback) => value.canonicalEpisode ?? fallback,
    episodePathForShow: (_show, s, e, p) => `/watch/show/s${s}-part-${p}-e${e}`,
    appRouter: () => ({
      replace: (path) => { sandbox.location.pathname = path; },
      parsePath: (path) => ({ path })
    }),
    location: { pathname: "/anime/show" },
    updateRouteMeta() {},
    document: {
      body: { classList: { remove() {} } },
      querySelector: (selector) => selector === "#videoFrame" ? frame : null
    },
    setPlayerCinemaOpen() {},
    stopActivePlayback() {},
    getWatchBackdropArtwork: () => "",
    currentEpisodeLabel: () => "Season 2 Part 1 Episode 3",
    renderPlayerPopupMessage: (_frame, label, message) => {
      loadingFeedback = { label, message };
    },
    schedulePlaybackSourceOptions: (_show, value, canonicalSeason, options) => {
      scheduled = { value, canonicalSeason, options };
    },
    renderEpisodeList() {},
    refreshFocusables() {},
    Math
  });
  vm.runInContext(section(clientSource, "function episodeChunkContextKey(", "function renderEpisodeList("), sandbox);
  vm.runInContext(section(clientSource, "function selectEpisodeByPosition(", "function showEpisodeListTab("), sandbox);
  sandbox.selectEpisodeByPosition(0, 0, true);
  assert.equal(scheduled.value, episode);
  assert.equal(scheduled.canonicalSeason, 2);
  assert.equal(scheduled.options.autoReplay, true);
  assert.equal(sandbox.location.pathname, "/watch/show/s2-part-1-e3");
  assert.deepEqual(loadingFeedback, { label: "Season 2 Part 1 Episode 3", message: "" });
});

test("AnimeAV1 source warmup coalesces concurrent requests for one episode", async () => {
  const { sandbox, releaseFetch, getFetchCount } = animeAv1SourceContext();
  const show = { animeAv1Slug: "example" };
  const first = { providerEpisodeId: 3 };
  const second = { providerEpisodeId: 3 };
  const lookups = [
    sandbox.attachAnimeAv1Sources(show, first),
    sandbox.attachAnimeAv1Sources(show, second)
  ];
  await Promise.resolve();
  assert.equal(getFetchCount(), 1);
  releaseFetch();
  await Promise.all(lookups);
  assert.equal(first.sourceOptions.length, 1);
  assert.equal(second.sourceOptions.length, 1);
  assert.equal(sandbox._animeAv1EpisodeSourceInflight.size, 0);
});

test("a late source lookup never remounts an already buffered player", async () => {
  const show = { id: "show" };
  const episode = {
    id: "episode",
    sourceOptionsChecked: "lookup",
    playbackSourceLookupComplete: true
  };
  let mounted = true;
  let replayCount = 0;
  const sandbox = vm.createContext({
    Promise,
    state: { activeEpisode: { episode }, activeShow: show, playIntent: true },
    document: {
      querySelector: (selector) => selector === "#videoFrame"
        ? { querySelector: () => mounted ? {} : null }
        : null
    },
    playbackLookupKey: () => "lookup",
    sourceOptionsBackgroundLookups: new Map(),
    pendingSourceLookups: new Map(),
    playActiveShow: () => { replayCount += 1; }
  });
  vm.runInContext(
    section(clientSource, "function schedulePlaybackSourceOptions(", "function stripSeasonFromTitle("),
    sandbox
  );

  await sandbox.schedulePlaybackSourceOptions(show, episode, 1, { autoReplay: true });
  assert.equal(replayCount, 0);

  mounted = false;
  await sandbox.schedulePlaybackSourceOptions(show, episode, 1, { autoReplay: true });
  await Promise.resolve();
  assert.equal(replayCount, 1);
});

test("AnimeAV1 card intent warms the exact provider episode for later playback", async () => {
  const { sandbox, releaseFetch, prefetched, getFetchCount, getLastFetchUrl } = animeAv1SourceContext();
  const show = { animeAv1Slug: "movie-example" };
  const warmup = sandbox.warmAnimeAv1PlaybackIntent(show, {
    episodeNumber: "1",
    providerAnimeSlug: "movie-example",
    providerEpisodeId: "0"
  });
  await Promise.resolve();
  assert.equal(getFetchCount(), 1);
  assert.match(getLastFetchUrl(), /episode=0/);
  releaseFetch();
  await warmup;

  const playbackEpisode = { providerEpisodeId: 0 };
  await sandbox.attachAnimeAv1Sources(show, playbackEpisode);
  assert.equal(getFetchCount(), 1, "playback should reuse the intent-warmed response");
  assert.equal(playbackEpisode.sourceOptions.length, 1);
  assert.deepEqual(
    prefetched,
    [
      "/player/player.html?v=765",
      "/player/player.css?v=765",
      "/player/player.js?v=765",
      "https://cdn.jsdelivr.net/npm/artplayer/dist/artplayer.js",
      "https://cdn.jsdelivr.net/npm/hls.js@1.6.16/dist/hls.min.js"
    ]
  );
});

test("AnimeAV1 episode payloads expire and a confirmed failure bypasses cached source metadata", async () => {
  const {
    sandbox,
    releaseFetch,
    advanceTime,
    getFetchCount,
    getLastFetchUrl,
    getLastFetchOptions
  } = animeAv1SourceContext();
  const show = { animeAv1Slug: "expiring-example" };

  const first = sandbox.attachAnimeAv1Sources(show, { providerEpisodeId: 4 });
  await Promise.resolve();
  releaseFetch();
  await first;
  await sandbox.attachAnimeAv1Sources(show, { providerEpisodeId: 4 });
  assert.equal(getFetchCount(), 1);

  advanceTime((5 * 60 * 1000) + 1);
  await sandbox.attachAnimeAv1Sources(show, { providerEpisodeId: 4 });
  assert.equal(getFetchCount(), 2, "expired payload should be fetched again");

  await sandbox.attachAnimeAv1Sources(show, { providerEpisodeId: 4 }, { forceRefresh: true });
  assert.equal(getFetchCount(), 3, "confirmed failure should bypass a still-fresh payload");
  assert.match(getLastFetchUrl(), /refresh=1/);
  assert.equal(getLastFetchOptions().cache, "no-store");
});

test("the main Play action marks intent before scheduling source resolution", () => {
  const handler = section(
    clientSource,
    'fakePlay.addEventListener("click",',
    'castButton?.addEventListener("click",'
  );
  const intentAt = handler.indexOf("state.playIntent = true;");
  const scheduleAt = handler.indexOf("schedulePlaybackSourceOptions(");
  assert.ok(intentAt >= 0 && scheduleAt > intentAt);
});

test("22. catalog dedupe cannot erase a baked franchise chain", () => {
  const { pipeline } = normalizationContext();
  const chain = [
    { anilistId: 1, title: "Example", episodes: 12 },
    { anilistId: 2, title: "Example Season 2", episodes: 12 }
  ];
  const [merged] = pipeline.mergeShows([
    {
      id: "animeav1-example-season-2",
      anilistId: 2,
      title: "Example Season 2",
      source: "AnimeAV1",
      animeAv1Slug: "example-season-2",
      canonicalSeasonNumber: 2,
      canonicalSeasonPart: 1,
      franchiseSeasons: chain,
      seasons: [{ season: 2, part: 1, episodes: [{ season: 2, episode: 1 }] }]
    },
    {
      id: "anilist-2",
      anilistId: 2,
      title: "Example Season 2",
      source: "AniList",
      animeAv1Slug: "",
      canonicalSeasonNumber: null,
      canonicalSeasonPart: null,
      franchiseSeasons: null,
      seasons: []
    }
  ]);
  assert.equal(merged.franchiseSeasons.length, 2);
  assert.equal(merged.canonicalSeasonNumber, 2);
  assert.equal(merged.canonicalSeasonPart, 1);
  assert.equal(merged.animeAv1Slug, "example-season-2");
  assert.equal(merged.seasons[0].canonicalSeasonNumber, 2);
  assert.equal(merged.seasons[0].part, 1);
});

test("Mushoku Tensei relation chain is ordered into three canonical seasons", () => {
  const getCanonicalEpisodeNumber = (episode = {}, fallback = null) => {
    const value = episode.canonicalEpisode ?? episode.episode ?? episode.number;
    return value == null ? fallback : Number(value);
  };
  const state = { shows: [] };
  const sandbox = vm.createContext({
    console: { warn() {}, log() {} },
    state,
    SeasonNormalization,
    catalogShows: () => state.shows,
    rememberFranchiseRoutes() {},
    franchiseEntryKey: (entry) => String(entry.anilistId || entry.malId || ""),
    cleanDescription: (value) => String(value || ""),
    getCanonicalEpisodeNumber,
    getEpisodeUrl: (episode = {}) => episode.videoUrl || "",
    groupEpisodesBySeason: (episodes) => [{ season: 1, episodes }],
    repairEpisodeGaps: (episodes, seasonNumber) => episodes.map((episode) => ({
      ...episode,
      season: seasonNumber,
      canonicalSeason: seasonNumber
    })),
    seasonAiredFloor: () => 0,
    extractSeasonNumber: utils.extractSeasonNumber
  });
  vm.runInContext(section(clientSource, "const bakedChainCache =", "// ── TioAnime source integration"), sandbox);
  vm.runInContext(section(clientSource, "const materializedFranchiseCache =", "function validateEpisodeIntegrity("), sandbox);
  vm.runInContext(section(clientSource, "function selectedSeasonIdentity(", "function selectedSeasonLabel("), sandbox);

  const chain = [
    { anilistId: 108465, malId: 39535, title: "Mushoku Tensei: Isekai Ittara Honki Dasu", format: "TV", seasonYear: 2021, episodes: 11, status: "FINISHED" },
    { anilistId: 127720, malId: 45576, title: "Mushoku Tensei: Isekai Ittara Honki Dasu Part 2", format: "TV", seasonYear: 2021, episodes: 12, status: "FINISHED" },
    { anilistId: 146065, malId: 51179, title: "Mushoku Tensei II: Isekai Ittara Honki Dasu", format: "TV", seasonYear: 2023, episodes: 12, status: "FINISHED" },
    {
      anilistId: 166873,
      malId: 55888,
      title: "Mushoku Tensei II: Isekai Ittara Honki Dasu Part 2",
      format: "TV",
      seasonYear: 2024,
      episodes: 12,
      status: "FINISHED",
      image: "https://images.test/season-two-part-two-poster.jpg",
      banner: "https://images.test/season-two-part-two-background.jpg",
      description: "Season two part two description."
    },
    { anilistId: 178789, malId: 59284, title: "Mushoku Tensei III: Isekai Ittara Honki Dasu", format: "TV", seasonYear: 2026, episodes: 14, status: "RELEASING" }
  ];
  const current = {
    id: "source-animeav1-s3",
    anilistId: 178789,
    malId: 59284,
    title: chain[4].title,
    animeAv1Slug: "mushoku-tensei-iii-isekai-ittara-honki-dasu",
    franchiseSeasons: chain,
    canonicalSeasonPart: 1,
    anilistFranchise: {
      groups: [
        {
          seasonNumber: 3,
          partNumber: 1,
          title: "Season 3 Part 1",
          episodeCount: 14,
          items: [{ ...chain[4] }]
        },
        {
          seasonNumber: 3,
          partNumber: 2,
          title: "Season 3 Part 2",
          episodeCount: 12,
          items: [{ ...chain[3] }]
        }
      ]
    },
    // AnimeAV1 publishes each sequel as a standalone page whose top-level
    // episodes still carry local Season 1. Relation data must canonicalize this
    // before detail rendering.
    seasons: [],
    episodes: Array.from({ length: 14 }, (_, index) => ({ season: 1, canonicalSeason: 1, episode: index + 1 }))
  };
  const catalogTwin = {
    id: "animeav1-s3",
    anilistId: 178789,
    malId: 59284,
    title: chain[4].title,
    franchiseSeasons: chain,
    canonicalSeasonPart: 1,
    seasons: []
  };
  // The bootstrap/detail object can follow a full-catalog twin with the same
  // AniList ID. Both must receive the relation identity before episode rows are
  // built; stamping only Array.find()'s first match recreates the production bug.
  state.shows = [catalogTwin, current];
  sandbox.ensureFranchiseShowsInCatalog(current);
  const [canonicalDetailSeason] = sandbox.getDetailSeasons(current);
  assert.equal(catalogTwin.canonicalSeasonNumber, 3);
  assert.equal(current.canonicalSeasonNumber, 3);
  assert.equal(catalogTwin.canonicalSeasonPart, null);
  assert.equal(current.canonicalSeasonPart, null);
  const relatedSeason = state.shows.find((entry) => entry.id === "anilist-166873");
  assert.equal(relatedSeason.anilistId, 166873);
  assert.equal(relatedSeason.malId, 55888);
  assert.equal(relatedSeason.image, "https://images.test/season-two-part-two-poster.jpg");
  assert.equal(relatedSeason.banner, "https://images.test/season-two-part-two-background.jpg");
  assert.equal(relatedSeason.description, "Season two part two description.");
  assert.notEqual(relatedSeason.image, current.image);
  assert.equal(canonicalDetailSeason.season, 3);
  assert.equal(canonicalDetailSeason.part, null);
  assert.deepEqual(
    { ...sandbox.selectedSeasonIdentity(current, {
      season: { season: 3, part: 1, canonicalSeasonPart: 1 },
      episode: { season: 3, episode: 2 }
    }, 2) },
    { seasonNumber: 3, seasonPart: "" }
  );
  assert.equal(canonicalDetailSeason.episodes[0].canonicalSeason, 3);
  const showsMap = new Map();
  state.shows.forEach((show) => {
    if (show.anilistId) showsMap.set(String(show.anilistId), show);
    if (show.malId) showsMap.set(`mal-${show.malId}`, show);
  });
  const list = sandbox.buildSeasonListFromBakedChain(current, showsMap);
  assert.deepEqual(Array.from(list, (group) => group.title), [
    "Season 1 Part 1",
    "Season 1 Part 2",
    "Season 2 Part 1",
    "Season 2 Part 2",
    "Season 3"
  ]);
  assert.equal(list[1].episodes[0].providerEpisodeId, 12);
  assert.equal(list[3].episodes[0].providerEpisodeId, 13);
  assert.equal(list[4].episodes[0].providerEpisodeId, 1);
});

test("related-season direct URLs rebuild from relations and reject corrupt route caches", () => {
  const stale = [{
    savedAt: Date.now(),
    show: {
      id: "anilist-166873",
      anilistId: 178789,
      title: "Mushoku Tensei II: Isekai Ittara Honki Dasu Part 2",
      isFranchiseEntry: true
    }
  }];
  const state = {
    shows: [
      {
        id: "animeav1-colliding-lightweight-row",
        anilistId: 146065,
        title: "Mushoku Tensei II: Isekai Ittara Honki Dasu",
        romajiTitle: "Mushoku Tensei II: Isekai Ittara Honki Dasu Part 2"
      },
      {
        id: "animeav1-mushoku-tensei-ii-isekai-ittara-honki-dasu",
        title: "Mushoku Tensei II: Isekai Ittara Honki Dasu",
        franchiseSeasons: [{
          anilistId: 166873,
          title: "Mushoku Tensei II: Isekai Ittara Honki Dasu Part 2"
        }]
      }
    ],
    addonSections: [],
    av1Shows: new Map()
  };
  const slugify = (value) => String(value || "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const sandbox = vm.createContext({
    state,
    Date,
    Map,
    ROUTE_SLUG_ALIASES: {},
    localStorage: { getItem: () => JSON.stringify(stale), setItem() {} },
    getShowSlug: (show = {}) => slugify(show.slug || show.title || show.id),
    getShowKey: (show = {}) => String(show.id || ""),
    ensureFranchiseShowsInCatalog: (carrier) => {
      const related = carrier.franchiseSeasons[0];
      if (!state.shows.some((show) => show.anilistId === related.anilistId)) {
        state.shows.push({
          id: `anilist-${related.anilistId}`,
          anilistId: related.anilistId,
          title: related.title,
          isFranchiseEntry: true
        });
      }
    }
  });
  vm.runInContext(section(clientSource, "const FRANCHISE_ROUTE_CACHE_KEY", "function ensureNotFoundSection("), sandbox);

  assert.equal(sandbox.readFranchiseRoutes().length, 0);
  const resolved = sandbox.findShowBySlugOrId("mushoku-tensei-ii-isekai-ittara-honki-dasu-part-2");
  assert.equal(resolved.id, "anilist-166873");
  assert.equal(resolved.anilistId, 166873);
});

test("stale Continue Watching seasons reconcile against authoritative catalog seasons", () => {
  const thunder = {
    id: "animeav1-thunder-3",
    anilistId: 207254,
    malId: 62805,
    title: "Thunder 3",
    image: "https://images.test/thunder-3-poster.jpg",
    seasonNumber: 1,
    seasons: [{
      season: 1,
      episodes: [{ episode: 1, title: "SMALL THREE", thumbnail: "https://images.test/thunder-3-e1.jpg" }]
    }]
  };
  const state = { shows: [thunder] };
  const sandbox = vm.createContext({
    state,
    Date,
    findShowForWatchEntry: () => thunder,
    parseEpisodeNumber: (value, fallback = null) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    buildWatchKey: (show, season, episode) => `${show.id}:s${season}:e${episode}`,
    getDetailSeasons: (show) => show.seasons,
    getCanonicalEpisodeNumber: (episode, fallback = null) => Number(episode?.episode ?? fallback),
    getAnimeTrackId: (show) => show.id,
    getShowTitle: (show) => show.title,
    episodeThumb: (episode) => episode.thumbnail,
    sanitizeWatchEntry() {}
  });
  vm.runInContext(
    section(clientSource, "function authoritativeWatchSeason(", "function getContinueWatchingList("),
    sandbox
  );

  const map = {
    "animeav1-thunder-3:s3:e1": {
      episodeKey: "animeav1-thunder-3:s3:e1",
      showId: "animeav1-thunder-3",
      title: "Thunder 3",
      season: 3,
      episode: 1,
      progress: 42,
      lastWatchedAt: 10
    }
  };
  assert.equal(sandbox.reconcileWatchMapSeasons(map), true);
  assert.equal(map["animeav1-thunder-3:s3:e1"], undefined);
  assert.equal(map["animeav1-thunder-3:s1:e1"].season, 1);
  assert.equal(map["animeav1-thunder-3:s1:e1"].progress, 42);
  assert.equal(map["animeav1-thunder-3:s1:e1"].episodeTitle, "SMALL THREE");
  assert.equal(map["animeav1-thunder-3:s1:e1"].thumb, "https://images.test/thunder-3-e1.jpg");
  assert.equal(
    sandbox.authoritativeWatchSeason({ seasons: [{ season: 1 }, { season: 2 }] }, 3),
    3
  );
});
