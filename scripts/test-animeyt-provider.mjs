import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const provider = require("../lib/animeyt-provider.cjs");
const classification = require("../js/source-classification.js");
const snapshot = { items: [{ slug: "sample-series", title: "Sample Series", season: 1 },
  { slug: "sample-series-temporada-2", title: "Sample Series", season: 2 }], schedule: [] };
const video = "https://archive.org/download/sample/episode.mp4";
const episodePage = `<iframe data-src="https://mytsumi.com/container.php?id=SampleId1234&amp;only=SUB"></iframe>`;
const containerPage = `<button data-player-kind="video" data-player-label="Omega" data-player-url="${video}"></button>`;
const episodesPage = `<article data-episode-id="1234"><a class="aniyt-episode-media" href="https://animeyt.cc/1234/anime/sample-capitulo-1/"></a>
 <div class="aniyt-episode-card-meta">T2 <span class="aniyt-episode-meta-chip--episode">EP 1</span></div></article>`;
const request = { titles: ["Sample Series Season 2"], season: 2, episode: 1, language: "sub" };
function harness(overrides = {}) {
  const calls = [];
  let clock = Date.parse("2026-10-05T12:00:00Z");
  const p = provider.createProvider({ snapshot, now: () => clock, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(url.includes("/tv/") ? episodesPage : url.includes("/anime/") ? episodePage : containerPage);
  }, ...overrides });
  return { p, calls, advance: ms => { clock += ms; } };
}

test("exact installment matching rejects wrong seasons and ambiguous names", () => {
  const index = provider.buildIdentityIndex(snapshot.items);
  assert.equal(provider.matchTitle(index, ["Sample Series 2nd Season"], 2).slug, "sample-series-temporada-2");
  assert.equal(provider.matchTitle(index, ["Sample Series II"], 2).season, 2);
  assert.equal(provider.matchTitle(index, ["Sample Series Season 2"], 1), null);
  assert.equal(provider.matchTitle(index, ["Sample Series Other"], 1), null);
  const ambiguous = provider.buildIdentityIndex([...snapshot.items, { slug: "sample-series-remake", title: "Sample Series", season: 1 }]);
  assert.equal(provider.matchTitle(ambiguous, ["Sample Series"], 1), null);
  assert.equal(provider.titleIdentity("sample-2023-temporada-2").season, 2);
});

test("catalog parser decodes titles and admits only canonical TV identities", () => {
  assert.deepEqual(provider.catalogRows([{ link: "https://animeyt.cc/tv/sample-series/", title: { rendered: "Sample &amp; Series" } },
    { link: "https://other.test/tv/sample/", title: { rendered: "Wrong" } }]), [{ slug: "sample-series", title: "Sample & Series", season: 1 }]);
});

test("episode parser preserves exact season/number; never picks first link by position", () => {
  assert.deepEqual(provider.parseEpisodes(episodesPage), [{ season: 2, episode: 1, url: "https://animeyt.cc/1234/anime/sample-capitulo-1/" }]);
  assert.equal(provider.parseEpisodes(episodesPage.replace("animeyt.cc", "evil.test")).length, 0);
  assert.equal(provider.parseEpisodes(episodesPage.replace("T2", "")).length, 0);
  assert.equal(provider.parseEpisodes('<h1 class="aniyt-series-title-line">Sample Series</h1>' + episodesPage.replace("T2", ""), 1, "Sample Series")[0].season, 1);
  assert.equal(provider.parseEpisodes('<h1 class="aniyt-series-title-line">Different Series</h1>' + episodesPage.replace("T2", ""), 1, "Sample Series").length, 0);
});

test("public container URL is fixed-origin, language constrained and unambiguous", () => {
  const url = new URL(provider.parseContainer(episodePage));
  assert.equal(url.origin, "https://mytsumi.com");
  assert.equal(url.searchParams.get("open"), "1");
  assert.equal(url.searchParams.get("only"), "SUB");
  assert.ok(provider.parseContainer(episodePage.replace("SampleId1234", "Sample_Id-1234")));
  assert.equal(provider.parseContainer(episodePage.replace("mytsumi.com", "127.0.0.1")), "");
  assert.equal(provider.parseContainer('<iframe src="https://mytsumi.com/multiplayer/options.php?server=multi&amp;value=SampleId1234"></iframe>'),
    "https://mytsumi.com/multiplayer/contenedor.php?id=SampleId1234");
});

test("only tested native Omega media admitted; embeds/downloads/signed links excluded", () => {
  assert.equal(provider.parseNativeSources(containerPage).length, 1);
  for (const change of [containerPage.replace("video", "iframe"), containerPage.replace("Omega", "MEGA"),
    containerPage.replace(video, "https://127.0.0.1/episode.mp4"), containerPage.replace(video, `${video}?token=secret`),
    containerPage.replace(video, "https://archive.org@evil.test/episode.mp4"), `<a href="${video}">Download Omega</a>`]) {
    assert.equal(provider.parseNativeSources(change).length, 0);
  }
});

test("100 simultaneous viewers share exactly three upstream page requests", async () => {
  const h = harness();
  const results = await Promise.all(Array.from({ length: 100 }, () => h.p.sources(request)));
  assert.equal(h.calls.length, 3);
  assert.ok(results.every(result => result?.ok && result.sources[0].videoUrl === video));
  await h.p.sources(request);
  assert.equal(h.calls.length, 3);
  assert.ok(h.calls.every(call => call.options.signal && call.options.redirect === "error"));
});

test("missing title, Spanish track and missing episode do not create cascaded lookups", async () => {
  const h = harness();
  assert.equal(await h.p.sources({ ...request, titles: ["Absent Show"] }), null);
  assert.equal(await h.p.sources({ ...request, language: "spanish" }), null);
  assert.equal(h.calls.length, 0);
  assert.equal(await h.p.sources({ ...request, episode: 2 }), null);
  assert.equal(h.calls.length, 1);
  await h.p.sources({ ...request, episode: 2 });
  assert.equal(h.calls.length, 1);
});

test("source cache expires quickly while static episode/container pages are reused", async () => {
  const h = harness();
  await h.p.sources(request);
  h.advance(61000);
  await h.p.sources(request);
  assert.equal(h.calls.length, 4);
});

test("429 honors Retry-After without retrying or caching a broken source", async () => {
  let count = 0;
  const h = harness({ fetchImpl: async () => { count++; return new Response("limited", { status: 429, headers: { "Retry-After": "120" } }); } });
  await assert.rejects(h.p.sources(request), /429/);
  h.advance(60000);
  await assert.rejects(h.p.sources(request), /cooling down/);
  assert.equal(count, 1);
  h.advance(61000);
  await assert.rejects(h.p.sources(request), /429/);
  assert.equal(count, 2);
});

test("schedules use absolute UTC seconds, not server weekday or upload dates", () => {
  const at = Date.parse("2026-10-06T01:30:00Z");
  const events = provider.parseSchedule(`<a data-aniyt-schedule-event data-aniyt-day="tue" data-aniyt-ts="${at / 1000}" href="https://animeyt.cc/tv/sample-series/">EP 2</a>`);
  assert.deepEqual(events, [{ slug: "sample-series", episode: 2, at }]);
  const h = harness({ snapshot: { ...snapshot, schedule: events } });
  const item = h.p.enrich({ title: "Sample Series" });
  assert.equal(item.nextAiringAt, at);
  assert.equal(new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "America/Denver" }).format(at), "Mon");
  assert.equal(new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/Denver" }).format(at), "7:30 PM");
  assert.equal(h.p.enrich({ title: "Sample Series", nextAiringAt: at + 1000 }).nextAiringAt, at + 1000);
  assert.equal(h.p.enrich({ title: "Sample Series", nextAiringAt: at + 1800000, nextAiringEpisodeNumber: 2 }).nextAiringAt, at);
  assert.equal(h.p.enrich({ title: "Sample Series", nextAiringAt: at + 1800000, nextAiringEpisodeNumber: 3 }).nextAiringAt, at + 1800000);
  h.advance(8 * 86400000);
  assert.equal(h.p.enrich({ title: "Sample Series" }).nextAiringAt, undefined);
});

test("legacy player tables are parsed as JSON, never executed or confused with downloads", () => {
  const row = { tab_name: "Omega", url: video, status: "active", is_mp4: true, is_fake_player: false };
  const table = rows => `<script>const videoTabs = ${JSON.stringify(rows)}; throw new Error('must not execute');</script>`;
  assert.equal(provider.parseNativeSources(table([row])).length, 1);
  assert.equal(provider.parseNativeSources(table([{ ...row, is_fake_player: true }])).length, 0);
  assert.equal(provider.parseNativeSources(table([{ ...row, status: "disabled" }])).length, 0);
});

test("provider schedule carrier expires and cannot override a different episode", () => {
  const utils = require("../js/utils.js");
  const now = Date.parse("2026-11-01T07:00:00Z");
  const at = Date.parse("2026-11-01T09:30:00Z");
  const show = { airingTimeSource: "AnimeYT", animeytAiringAt: at, animeytAiringEpisode: 2, nextAiringEpisodeNumber: 2 };
  assert.equal(utils.animeYTConfirmedAiringInstant(show, now), at);
  assert.equal(utils.animeYTConfirmedAiringInstant({ ...show, nextAiringEpisodeNumber: 3 }, now), 0);
  assert.equal(utils.animeYTConfirmedAiringInstant(show, at + 1), 0);
  assert.equal(new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/Denver" }).format(at), "2:30 AM");
});

test("normalization preserves AnimeYT identity during sparse metadata merges", () => {
  const normalize = readFileSync(new URL("../js/normalize.js", import.meta.url), "utf8");
  assert.match(normalize, /animeytSlug: show\.animeytSlug \|\| current\.animeytSlug/);
  assert.match(normalize, /animeytAiringAt: Number\(show\.animeytAiringAt\) \|\| Number\(current\.animeytAiringAt\)/);
});

test("episode normalization retains AnimeYT's verified identity instead of a synthetic Direct duplicate", () => {
  const normalize = readFileSync(new URL("../js/normalize.js", import.meta.url), "utf8");
  const sandbox = vm.createContext({ getProviderEpisodeId: () => 1, cleanPlaybackSourceLabel: label => label,
    comparePlaybackSources: () => 0 });
  vm.runInContext(normalize.slice(normalize.indexOf("function pickPlayableUrl("), normalize.indexOf("function cleanPlaybackSourceLabel(")), sandbox);
  const source = { id: "animeyt-sub-sample", label: "AnimeYT Omega", videoUrl: video, verifiedPlayable: true, verifiedAt: 12345 };
  const options = sandbox.normalizeEpisodeSourceOptions({ videoUrl: video, provider: "AnimeAV1", sourceOptions: [source] });
  assert.equal(options.length, 1);
  assert.equal(options[0].id, source.id);
  assert.equal(options[0].verifiedPlayable, true);
  assert.equal(options[0].verifiedAt, source.verifiedAt);
  const oldProvider = sandbox.normalizeEpisodeSourceOptions({ videoUrl: video, provider: "AnimeAV1", sourceOptions: [{ ...source, id: "animeav1-direct" }] });
  assert.equal(oldProvider[0].id, "direct", "unrelated provider normalization is unchanged");
});

test("preferred provider is still codec gated; adult source behavior is unchanged", () => {
  const source = { id: "animeyt-sub-test", label: "AnimeYT Sub - Omega", type: "direct", videoUrl: video };
  assert.equal(classification.isAnimeYTSource(source), true);
  assert.ok(classification.sourcePreferenceScore(source) < classification.sourcePreferenceScore({ id: "animeav1", type: "direct" }));
  assert.equal(classification.isAnimeYTSource({ id: "underhentai" }), false);
});

test("verified public Omega MP4s avoid video relay; other hosts and Cast keep their existing path", () => {
  const client = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  const sandbox = vm.createContext({ URL, isAnimeYTSource: classification.isAnimeYTSource,
    originalStreamUrlFromProxy: url => new URL(url).searchParams.get("url") || url });
  vm.runInContext(client.slice(client.indexOf("function animeYTDirectPlaybackUrl("), client.indexOf("function buildApkPlayerUrl(")), sandbox);
  const source = { provider: "AnimeYT", verifiedPlayable: true };
  const proxy = `https://app.test/api/source?url=${encodeURIComponent(video)}`;
  assert.equal(sandbox.animeYTDirectPlaybackUrl(source, proxy), video);
  for (const [item, url] of [[null, proxy], [{ ...source, provider: "Other" }, proxy],
    [source, `${video}?token=test`], [source, "https://evil.test/episode.mp4"], [source, "https://archive.org@evil.test/episode.mp4"]]) {
    assert.equal(sandbox.animeYTDirectPlaybackUrl(item, url), "");
  }
  assert.match(client, /options\.castSrc = proxiedStreamUrl\(url, selectedSource\.referer \|\| selectedSource\.siteUrl \|\| ""\);\s*url = directAnimeYT;/);
  const player = readFileSync(new URL("../player/player.js", import.meta.url), "utf8");
  assert.match(player, /castSourceUrl = firstParam\("castSrc"\) \|\| sourceUrl/);
  const cast = vm.createContext({ URL, window: { location: { origin: "https://app.test" } }, castSourceUrl: proxy });
  const from = player.indexOf("function castMediaUrl()");
  vm.runInContext(player.slice(from, player.indexOf("// Set by the Cast ladder", from)), cast);
  assert.equal(cast.castMediaUrl(), proxy);
});

test("late lookup cannot cross a language switch and absent titles invoke no function", async () => {
  const client = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  const from = client.indexOf("const animeYTEpisodeCache =");
  const to = client.indexOf("// AnimeNeon is queried first", from);
  let language = "sub";
  let release;
  let calls = 0;
  const response = new Promise(resolve => { release = resolve; });
  const show = { animeytSlug: "sample-series", animeytSeason: 1 };
  const episode = { canonicalSeason: 1, canonicalEpisode: 1, sourceOptions: [] };
  const context = vm.createContext({ URL, Map, Date, console: { warn() {} }, location: { origin: "http://localhost:4191" },
    isScraperEnabled: () => true, preferredWatchLanguageForEpisode: () => language,
    getDetailSeasons: () => [{ season: 1, episodes: [episode] }], getCanonicalEpisodeNumber: ep => ep.canonicalEpisode,
    playbackProviderIsCoolingDown: () => false, deferPlaybackProviderOnFailure() {}, simpleHash: () => "sample",
    fetchWithTimeout: () => { calls++; return response; } });
  vm.runInContext(client.slice(from, to), context);
  assert.equal(await context.attachAnimeYTSources({}, episode), undefined);
  assert.equal(calls, 0);
  const first = context.attachAnimeYTSources(show, episode);
  const second = context.attachAnimeYTSources(show, episode);
  assert.equal(calls, 1);
  language = "spanish";
  release(new Response(JSON.stringify({ ok: true, sources: [{ provider: "Omega", videoUrl: video }] })));
  await Promise.all([first, second]);
  assert.equal(episode.sourceOptions.length, 0);
});

test("a coalesced lookup cannot replace verified media with a duplicate raw source", async () => {
  const client = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  const from = client.indexOf("const animeYTEpisodeCache =");
  const show = { animeytSlug: "sample-series", animeytSeason: 1 };
  const verified = { id: "animeyt-sub-sample", videoUrl: "/api/source?url=media", verifiedPlayable: true };
  const episode = { canonicalSeason: 1, canonicalEpisode: 1, sourceOptions: [verified] };
  const context = vm.createContext({ URL, Map, Date, console, location: { origin: "http://localhost:4191" },
    isScraperEnabled: () => true, preferredWatchLanguageForEpisode: () => "sub",
    getDetailSeasons: () => [{ season: 1, episodes: [episode] }], getCanonicalEpisodeNumber: ep => ep.canonicalEpisode,
    playbackProviderIsCoolingDown: () => false, deferPlaybackProviderOnFailure() {}, simpleHash: () => "sample",
    fetchWithTimeout: async () => new Response(JSON.stringify({ ok: true, sources: [{ provider: "Omega", videoUrl: video }] })) });
  vm.runInContext(client.slice(from, client.indexOf("// AnimeNeon is queried first", from)), context);
  await context.attachAnimeYTSources(show, episode);
  assert.equal(episode.sourceOptions.length, 1);
  assert.equal(episode.sourceOptions[0], verified);
});

test("a recovered video clears its old error only when playback actually resumes", () => {
  const player = readFileSync(new URL("../player/player.js", import.meta.url), "utf8");
  const from = player.indexOf('art.on("video:playing", () => {');
  const playing = player.slice(from, player.indexOf('art.on("video:pause"', from));
  assert.match(playing, /playbackHasStarted = true;\s*hideError\(\);/);
  assert.match(player, /showError\("Video failed to load"/);
  assert.match(player, /send\("error", "playback-error"\)/);
});

test("an identical previously verified mirror adopts AnimeYT priority without losing its id or health", async () => {
  const client = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  const from = client.indexOf("const animeYTEpisodeCache =");
  const show = { animeytSlug: "sample-series", animeytSeason: 1 };
  const episode = { canonicalSeason: 1, canonicalEpisode: 1, sourceOptions: [
    { id: "existing-mirror", videoUrl: video, verifiedPlayable: true, verifiedAt: 12345 }
  ] };
  const context = vm.createContext({ URL, Map, Date, console, location: { origin: "http://localhost:4191" },
    isScraperEnabled: () => true, preferredWatchLanguageForEpisode: () => "sub",
    getDetailSeasons: () => [{ season: 1, episodes: [episode] }], getCanonicalEpisodeNumber: ep => ep.canonicalEpisode,
    playbackProviderIsCoolingDown: () => false, deferPlaybackProviderOnFailure() {}, simpleHash: () => "sample",
    fetchWithTimeout: async () => new Response(JSON.stringify({ ok: true, sources: [{ provider: "Omega", videoUrl: video }] })) });
  vm.runInContext(client.slice(from, client.indexOf("// AnimeNeon is queried first", from)), context);
  await context.attachAnimeYTSources(show, episode);
  assert.equal(episode.sourceOptions.length, 1);
  assert.equal(episode.sourceOptions[0].id, "existing-mirror");
  assert.equal(episode.sourceOptions[0].verifiedAt, 12345);
  assert.equal(classification.isAnimeYTSource(episode.sourceOptions[0]), true);
});
