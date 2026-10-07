import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../animetv-server.js", import.meta.url), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

function harness(fetchImpl) {
  let now = 100000;
  let nextId = 0;
  const timers = new Map();
  const calls = [];
  const context = vm.createContext({
    AbortController, URL, URLSearchParams,
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, ms) {
      const id = ++nextId;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, options) {
      calls.push({ url, ...options });
      return fetchImpl(url, options, context);
    },
    JIKAN_API: "https://metadata.example.test/v4",
    JIKAN_REQUEST_BUDGET_MS: 8000,
    JIKAN_EPISODE_BUDGET_MS: 20000,
    JIKAN_EPISODE_CACHE_TTL_MS: 86400000,
    JIKAN_FAILURE_TTL_MS: 60000,
    JIKAN_SEARCH_CACHE: {},
    JIKAN_FULL_CACHE: {},
    JIKAN_EPISODES_CACHE: {},
    JIKAN_UNAVAILABLE_CACHE: { "Cache-Control": "public, max-age=10, s-maxage=60" },
    METADATA_STALE_CACHE_HEADERS: { "Cache-Control": "public, stale-while-revalidate=300" },
    jikanRequestQueue: Promise.resolve(),
    jikanLastRequestAt: 0,
    jikanRetryAt: 0,
    jikanCircuit: { failures: 0, retryAt: 0, status: 0 },
    jikanInflight: new Map(),
    jikanEpisodeCache: new Map(),
    jikanSearchCache: new Map(),
    jikanFullCache: new Map(),
    jikanCoolingDown: () => false,
    noteJikanFailure: () => {},
    noteJikanSuccess: () => {},
    normalizeTitle: (title) => title.toLowerCase(),
    sendJson: (response, body, status = 200, headers) => Object.assign(response, { body, status, headers })
  });
  vm.runInContext([
    section("function jikanCircuitError(", "// Jikan is a free,"),
    section("function isPermanentJikanError(", "function noteJikanFailure("),
    section("function sendJikanUnavailable(", "setInterval("),
    section("function coalesceInflight(", "function anilistCoalesce("),
    section("function wait(ms)", "function normalizeJikanEpisode("),
    section("function normalizeJikanEpisode(", "// \u2500\u2500 TMDB proxy")
  ].join("\n"), context);
  async function flush() {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  }
  async function advance(ms) {
    const target = now + ms;
    await flush();
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      now = timer.at;
      timers.delete(id);
      timer.fn();
      await flush();
    }
    now = target;
    await flush();
  }
  return { context, calls, advance, timers };
}

const success = (data) => ({ ok: true, json: async () => ({ data }) });
const never = () => new Promise(() => {});

test("successful metadata requests preserve JSON and upstream spacing", async () => {
  const h = harness(() => success([{ title: "Example" }]));
  const first = h.context.fetchJikanJson("/anime/1/full");
  assert.equal((await first).data[0].title, "Example");
  const second = h.context.fetchJikanJson("/anime/2/full");
  await h.advance(349);
  assert.equal(h.calls.length, 1);
  await h.advance(1);
  await second;
  assert.equal(h.calls.length, 2);
  assert.equal(h.timers.size, 0);
});

test("HTTP errors retain their status", async () => {
  const h = harness(() => ({ ok: false, status: 404 }));
  await assert.rejects(h.context.fetchJikanJson("/anime/1/full"), { status: 404 });
  assert.equal(h.timers.size, 0);
});

test("a transient HTTP failure is retried within the same deadline", async () => {
  let attempts = 0;
  let cancelled = 0;
  const h = harness(() => ++attempts === 1
    ? { ok: false, status: 504, body: { cancel: async () => cancelled++ } }
    : success([{ title: "Example" }]));
  const request = h.context.fetchJikanJson("/anime/1/full");
  await h.advance(650);
  assert.equal((await request).data.length, 1);
  assert.equal(attempts, 2);
  assert.equal(cancelled, 1);
  assert.equal(h.timers.size, 0);
});

test("a 429 honors Retry-After without multiplying upstream requests", async () => {
  let limited = true;
  const h = harness(() => limited
    ? {
        ok: false,
        status: 429,
        headers: { get: (name) => name.toLowerCase() === "retry-after" ? "15" : null },
        body: { cancel: async () => {} }
      }
    : success([]));

  await assert.rejects(h.context.fetchJikanJson("/anime/1/full"), { status: 429 });
  assert.equal(h.calls.length, 1);
  assert.equal(h.context.jikanRetryAt, 115000);

  await assert.rejects(h.context.fetchJikanJson("/anime/2/full"), { status: 429 });
  assert.equal(h.calls.length, 1);

  limited = false;
  await h.advance(15000);
  await h.context.fetchJikanJson("/anime/2/full");
  assert.equal(h.calls.length, 2);
});

test("TMDB shares its Retry-After cooldown across route keys", async () => {
  let now = 200000;
  let calls = 0;
  let limited = true;
  const c = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    URLSearchParams,
    TMDB_CONFIGURED: true,
    TMDB_PROXY_BASE: "",
    TMDB_READ_TOKEN: "",
    TMDB_API_KEY: "fixture-key",
    TMDB_API_BASE: "https://tmdb.example.test/3",
    TMDB_TIMEOUT_MS: 12000,
    tmdbRetryAt: 0,
    fetchWithTimeout: async () => {
      calls += 1;
      return limited
        ? {
            ok: false,
            status: 429,
            headers: { get: (name) => name.toLowerCase() === "retry-after" ? "10" : null },
            body: { cancel: async () => {} }
          }
        : { ok: true, json: async () => ({ id: 1 }) };
    }
  });
  vm.runInContext(section("function coalesceInflight(", "function anilistCoalesce("), c);
  vm.runInContext(section("function tmdbCooldownError(", "function tmdbNotConfigured("), c);

  await assert.rejects(c.tmdbFetch("/tv/1", { language: "en-US" }), { status: 429 });
  assert.equal(calls, 1);
  assert.equal(c.tmdbRetryAt, 210000);
  await assert.rejects(c.tmdbFetch("/tv/2", { language: "en-US" }), { status: 429 });
  assert.equal(calls, 1);

  now = 210000;
  limited = false;
  assert.equal((await c.tmdbFetch("/tv/2", { language: "en-US" })).id, 1);
  assert.equal(calls, 2);
});

test("an HTTP 200 body carrying an upstream 500 is retried instead of cached empty", async () => {
  let attempts = 0;
  const h = harness(() => ++attempts < 2
    ? { ok: true, json: async () => ({ status: 500, type: "UpstreamException", message: "temporary failure" }) }
    : success([{ title: "Recovered episode" }]));
  const request = h.context.fetchJikanJson("/anime/20/episodes");
  await h.advance(1950);
  assert.equal((await request).data[0].title, "Recovered episode");
  assert.equal(attempts, 2);
  assert.equal(h.timers.size, 0);
});

test("repeated HTTP failures open the circuit after two attempts", async () => {
  const h = harness(() => ({ ok: false, status: 504 }));
  const request = assert.rejects(h.context.fetchJikanJson("/anime/1/full"), { status: 504 });
  await h.advance(2000);
  await request;
  assert.equal(h.calls.length, 2);
  await assert.rejects(h.context.fetchJikanJson("/anime/2/full"), { providerCooldown: true });
  assert.equal(h.calls.length, 2);
  assert.equal(h.timers.size, 0);
});

test("retries cannot reset a route deadline", async () => {
  const h = harness(() => ({ ok: false, status: 504 }));
  const request = assert.rejects(h.context.fetchJikanJson("/anime/1/full", { deadlineAt: 100500 }), { code: "JIKAN_TIMEOUT" });
  await h.advance(2000);
  await request;
  assert.equal(h.calls.length, 1);
  assert.equal(h.timers.size, 0);
});

for (const stage of ["headers", "body"]) {
  test(`a hung ${stage} is aborted and releases the queue`, async () => {
    let hung = true;
    const h = harness(() => hung ? (stage === "headers" ? never() : { ok: true, json: never }) : success([]));
    const rejected = assert.rejects(h.context.fetchJikanJson("/anime/1/full"), { code: "JIKAN_TIMEOUT" });
    await h.advance(8000);
    await rejected;
    assert.equal(h.calls[0].signal.aborted, true);
    hung = false;
    await h.advance(60000);
    await h.context.fetchJikanJson("/anime/2/full");
    assert.equal(h.calls.length, 2);
    assert.equal(h.timers.size, 0);
  });
}

test("a queued request expires without contacting the upstream", async () => {
  const h = harness(never);
  const active = assert.rejects(h.context.fetchJikanJson("/anime/1/full"), { code: "JIKAN_TIMEOUT" });
  const queued = assert.rejects(h.context.fetchJikanJson("/anime/2/full", { deadlineAt: 100100 }), { code: "JIKAN_TIMEOUT" });
  await h.advance(100);
  await queued;
  assert.equal(h.calls.length, 1);
  await h.advance(7900);
  await active;
  assert.equal(h.calls.length, 1);
  assert.equal(h.timers.size, 0);
});

test("an already expired deadline never enters the queue", async () => {
  const h = harness(never);
  await assert.rejects(h.context.fetchJikanJson("/anime/1/full", { deadlineAt: 99999 }), { code: "JIKAN_TIMEOUT" });
  assert.equal(h.calls.length, 0);
  assert.equal(h.timers.size, 0);
});

test("episode pages share one deadline and keep stale data on failure", async () => {
  const h = harness((url, options, context) => new Promise((resolve) => context.setTimeout(() => resolve({
    ok: true,
    json: async () => ({ data: [{ mal_id: Number(new URL(url).searchParams.get("page")) }], pagination: { last_visible_page: 30 } })
  }), 1500)));
  const stale = [{ episode: 1, title: "Cached episode" }];
  h.context.jikanEpisodeCache.set("1", { data: stale, ts: -86400000 });
  const response = {};
  const request = h.context.handleJikanEpisodes(new URL("https://app.example.test/api/jikan/episodes?id=1"), response);
  await h.advance(20000);
  await request;
  assert.equal(response.status, 200);
  assert.equal(response.body.unavailable, true);
  assert.equal(response.body.stale, true);
  assert.equal(response.body.data, stale);
  assert.equal(response.body.notFound, undefined);
  assert.match(response.headers["Cache-Control"], /stale-while-revalidate/);
  assert.equal(h.context.jikanEpisodeCache.get("1").data, stale);
  const count = h.calls.length;
  assert.ok(count > 1 && count < 30);
  await h.advance(8000);
  assert.equal(h.calls.length, count);
});

test("successful episode pagination still returns every page", async () => {
  const h = harness((url) => ({ ok: true, json: async () => ({
    data: [{ mal_id: Number(new URL(url).searchParams.get("page")), title: "Example episode" }],
    pagination: { last_visible_page: 3 }
  }) }));
  const response = {};
  const request = h.context.handleJikanEpisodes(new URL("https://app.example.test/api/jikan/episodes?id=1"), response);
  await h.advance(1000);
  await request;
  assert.equal(response.body.ok, true);
  assert.deepEqual(Array.from(response.body.data, (episode) => episode.episode), [1, 2, 3]);
  assert.equal(response.body.pages, 3);
});

test("an outage blocks other metadata keys, permits one recovery probe, and resets on success", async () => {
  let down = true;
  const h = harness(() => down ? { ok: false, status: 503 } : success([{ title: "Recovered" }]));
  const failure = assert.rejects(h.context.fetchJikanJson("/anime/1/full"), { status: 503 });
  await h.advance(650);
  await failure;
  const responses = Array.from({ length: 25 }, (_, index) => {
    const response = {};
    return h.context.handleJikanFull(new URL(`https://app.test/api/jikan/full?id=${index + 2}`), response)
      .then(() => response);
  });
  const results = await Promise.all(responses);
  assert.equal(h.calls.length, 2);
  assert.equal(results.every(result => result.status === 200 && result.body.unavailable && !result.body.notFound), true);
  assert.equal(h.context.jikanFullCache.size, 0);
  down = false;
  await h.advance(60000);
  const probes = Array.from({ length: 25 }, () => {
    const response = {};
    return h.context.handleJikanFull(new URL("https://app.test/api/jikan/full?id=99"), response).then(() => response);
  });
  assert.equal((await Promise.all(probes)).every(response => response.body.ok), true);
  assert.equal(h.calls.length, 3);
  assert.equal(h.context.jikanCircuit.failures, 0);
  assert.equal(h.context.jikanCircuit.retryAt, 0);
});

test("fresh metadata remains available while the global circuit is open", async () => {
  const h = harness(() => { throw new Error("must not reach upstream"); });
  h.context.jikanCircuit.retryAt = 160000;
  h.context.jikanFullCache.set("1", { data: { title: "Cached title" }, ts: 100000 });
  h.context.jikanEpisodeCache.set("1", { data: [{ episode: 1 }], ts: 100000 });
  const full = {};
  const episodes = {};
  await h.context.handleJikanFull(new URL("https://app.test/api/jikan/full?id=1"), full);
  await h.context.handleJikanEpisodes(new URL("https://app.test/api/jikan/episodes?id=1"), episodes);
  assert.equal(full.body.data.title, "Cached title");
  assert.equal(episodes.body.data.length, 1);
  assert.equal(h.calls.length, 0);
});

test("missing titles do not trip Jikan's outage circuit", async () => {
  const h = harness(() => ({ ok: false, status: 404 }));
  const first = assert.rejects(h.context.fetchJikanJson("/anime/1/full"), { status: 404 });
  await first;
  const second = assert.rejects(h.context.fetchJikanJson("/anime/2/full"), { status: 404 });
  await h.advance(350);
  await second;
  assert.equal(h.context.jikanCircuit.failures, 0);
  assert.equal(h.calls.length, 2);
});

test("playlist headers and body share one abortable deadline", async () => {
  const h = harness(() => ({ status: 200, headers: new Map(), text: never }));
  vm.runInContext(section("async function fetchSourcePlaylistSnapshot(", "function sourcePlaylistIsMaster("), h.context);
  const request = assert.rejects(h.context.fetchSourcePlaylistSnapshot("https://media.test/video.m3u8", {}), { status: 504 });
  await h.advance(12000);
  await request;
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.timers.size, 0);
});

test("a fresh episode cache refreshes when it does not include the confirmed release", async () => {
  const h = harness(() => ({ ok: true, json: async () => ({
    data: [{ mal_id: 2, title: "New episode" }],
    pagination: { last_visible_page: 1 }
  }) }));
  h.context.jikanEpisodeCache.set("1", {
    data: [{ episode: 1, title: "Cached episode" }],
    ts: 100000
  });
  const response = {};
  const request = h.context.handleJikanEpisodes(
    new URL("https://app.example.test/api/jikan/episodes?id=1&episode=2"),
    response
  );
  await h.advance(1);
  await request;
  assert.equal(h.calls.length, 1);
  assert.equal(response.body.data[0].episode, 2);
});

test("a fresh episode cache remains fast when it includes the confirmed release", async () => {
  const h = harness(() => { throw new Error("upstream should not be called"); });
  h.context.jikanEpisodeCache.set("1", {
    data: [{ episode: 2, title: "Cached new episode" }],
    ts: 100000
  });
  const response = {};
  await h.context.handleJikanEpisodes(
    new URL("https://app.example.test/api/jikan/episodes?id=1&episode=2"),
    response
  );
  assert.equal(h.calls.length, 0);
  assert.equal(response.body.cached, true);
});

for (const [handler, path] of [["handleJikanFull", "full?id=1"], ["handleJikanSearch", "search?q=Example"]]) {
  test(`${handler} treats timeouts as unavailable, not missing titles`, async () => {
    const h = harness(never);
    const response = {};
    const request = h.context[handler](new URL(`https://app.example.test/api/jikan/${path}`), response);
    await h.advance(8000);
    await request;
    assert.equal(response.status, 200);
    assert.equal(response.body.unavailable, true);
    assert.equal(response.body.notFound, undefined);
    assert.match(response.headers["Cache-Control"], /s-maxage=60/);
    assert.equal(h.context.jikanFullCache.size + h.context.jikanSearchCache.size, 0);
  });
}
