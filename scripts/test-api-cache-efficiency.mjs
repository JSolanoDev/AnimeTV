import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const server = readFileSync(new URL("../animetv-server.js", import.meta.url), "utf8");
const client = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const section = (source, start, end) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const to = source.indexOf(end, from);
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
};

function playlistHarness(fetchWithTimeout) {
  let now = 1000;
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    Map, Object, Promise, Response, String,
    sourcePlaylistCache: new Map(),
    sourcePlaylistInflight: new Map(),
    SOURCE_PLAYLIST_MEMORY_TTL_MS: 15000,
    SOURCE_PLAYLIST_CACHE_MAX: 100,
    fetchWithTimeout
  });
  vm.runInContext(section(server, "function sourcePlaylistIsVod(", "async function handleSourceProxy("), context);
  return { context, advance: (ms) => { now += ms; } };
}

test("one hundred concurrent AnimeAV1 manifest reads share one upstream request", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const harness = playlistHarness(async () => {
    calls += 1;
    if (calls === 1) return gate;
    return new Response("#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:1,\nb.m4s\n#EXT-X-ENDLIST", {
      status: 200,
      headers: { "content-type": "application/vnd.apple.mpegurl" }
    });
  });
  const requests = Array.from({ length: 100 }, () => harness.context.fetchCoalescedSourcePlaylist(
    "https://player.zilla-networks.com/m3u8/fixture",
    { Referer: "https://player.zilla-networks.com/play/fixture" },
    "fixture"
  ));
  await Promise.resolve();
  assert.equal(calls, 1);
  release(new Response("#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:1,\na.m4s\n#EXT-X-ENDLIST", {
    status: 200,
    headers: { "content-type": "application/vnd.apple.mpegurl" }
  }));
  const responses = await Promise.all(requests);
  assert.equal(new Set(await Promise.all(responses.map((response) => response.text()))).size, 1);

  const cached = await harness.context.fetchCoalescedSourcePlaylist("ignored", {}, "fixture");
  assert.match(await cached.text(), /#EXT-X-ENDLIST/);
  assert.equal(calls, 1);

  harness.advance(15001);
  const expired = await harness.context.fetchCoalescedSourcePlaylist("ignored", {}, "fixture");
  assert.equal(calls, 2);
  assert.match(await expired.text(), /b\.m4s/);
});

test("live manifests are coalesced in flight but never retained", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const harness = playlistHarness(async () => {
    calls += 1;
    if (calls === 1) return gate;
    return new Response("#EXTM3U\n#EXTINF:1,\nlive.m4s", { status: 200 });
  });
  const first = harness.context.fetchCoalescedSourcePlaylist("live", {}, "live");
  const second = harness.context.fetchCoalescedSourcePlaylist("live", {}, "live");
  await Promise.resolve();
  assert.equal(calls, 1);
  release(new Response("#EXTM3U\n#EXTINF:1,\nlive.m4s", { status: 200 }));
  await Promise.all([first, second]);
  await harness.context.fetchCoalescedSourcePlaylist("live", {}, "live");
  assert.equal(calls, 2);
  assert.equal(harness.context.sourcePlaylistCache.size, 0);
});

test("normal playback and Cast share one AnimeAV1 source lookup", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const context = vm.createContext({
    Array, Map, Promise, encodeURIComponent,
    ANIMEAV1_SOURCE_TIMEOUT_MS: 6500,
    _animeAv1EpisodeSourceCache: new Map(),
    _animeAv1EpisodeSourceInflight: new Map(),
    fetchWithTimeout: async () => {
      calls += 1;
      return gate;
    }
  });
  vm.runInContext(section(
    client,
    "async function fetchAnimeAv1EpisodeSourcePayload(",
    "async function buildAnimeAv1CastCandidate("
  ), context);

  const consumers = Array.from({ length: 100 }, () =>
    context.fetchAnimeAv1EpisodeSourcePayload("fixture", 7)
  );
  await Promise.resolve();
  assert.equal(calls, 1);
  const payload = { ok: true, sources: [], castSources: [{ provider: "UPNShare" }] };
  release({ ok: true, json: async () => payload });
  assert.equal((await Promise.all(consumers)).every((value) => value === payload), true);
  assert.equal(await context.fetchAnimeAv1EpisodeSourcePayload("fixture", 7), payload);
  assert.equal(calls, 1);
});
