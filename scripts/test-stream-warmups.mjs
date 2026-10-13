import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const client = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const start = client.indexOf("function warmPlayableStream(");
const end = client.indexOf("function warmEpisodeSourceById(", start);
assert.ok(start >= 0 && end > start);

function context(fetch) {
  const sandbox = vm.createContext({
    AbortController, URL, Date, Promise, Map,
    location: { origin: "https://app.test", protocol: "https:" },
    window: { setTimeout, clearTimeout },
    resolveSourceEndpoint: value => value,
    originalStreamUrlFromProxy: value => value,
    proxiedStreamUrl: value => value,
    preconnectStreamOrigin() {},
    streamTypeFromUrl: value => /\.m3u8(?:$|\?)/.test(value) ? "hls" : /\.mp4(?:$|\?)/.test(value) ? "file" : "",
    playableStreamWarmups: new Map(),
    PLAYABLE_STREAM_WARMUP_TTL: 30000,
    fetch
  });
  vm.runInContext(client.slice(start, end), sandbox);
  return sandbox;
}

test("warmups cancel an ignored-Range body after headers without changing the request", async () => {
  let cancellations = 0;
  let request;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(32768)); },
    cancel() { cancellations++; }
  }), { status: 200, headers: { "Content-Type": "video/mp4" } });
  const sandbox = context(async (url, options) => { request = { url, options }; return response; });
  assert.equal(await sandbox.warmPlayableStream("https://cdn.test/episode.mp4"), response);
  assert.equal(cancellations, 1, "the warmup must not leave a full media transfer open");
  assert.equal(request.options.headers.Range, "bytes=0-0");
  assert.equal(request.options.credentials, "omit");
  assert.equal(request.options.cache, "no-store");
});

test("simultaneous warmups share one request and cleanup, but different URLs do not", async () => {
  let requests = 0;
  let cancellations = 0;
  const sandbox = context(async () => {
    requests++;
    return { body: { cancel: async () => { cancellations++; } } };
  });
  const first = sandbox.warmPlayableStream("https://cdn.test/episode.mp4?token=one");
  assert.equal(first, sandbox.warmPlayableStream("https://cdn.test/episode.mp4?token=one"));
  await Promise.all([first, sandbox.warmPlayableStream("https://cdn.test/episode.mp4?token=two")]);
  assert.equal(requests, 2);
  assert.equal(cancellations, 2);
});

test("HLS and preconnect-only intents do not fetch or consume playback media", async () => {
  let requests = 0;
  const sandbox = context(async () => { requests++; });
  await sandbox.warmPlayableStream("https://cdn.test/master.m3u8");
  await sandbox.warmPlayableStream("https://cdn.test/episode.mp4", { preconnectOnly: true });
  assert.equal(requests, 0);
});

test("cleanup stays inside the existing timeout and failures remain best-effort", async () => {
  let aborted = false;
  const sandbox = context(async (_url, options) => ({ body: { cancel: () => new Promise(resolve => {
    options.signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
  }) } }));
  await sandbox.warmPlayableStream("https://cdn.test/episode.mp4", { timeoutMs: 30 });
  assert.equal(aborted, true, "receiving headers must not disable the cleanup deadline");
  const failed = context(async () => { throw new Error("offline"); });
  assert.equal(await failed.warmPlayableStream("https://cdn.test/episode.mp4"), null);
  const cancelled = context(async () => ({ body: { cancel: async () => { throw new Error("closed"); } } }));
  assert.ok(await cancelled.warmPlayableStream("https://cdn.test/episode.mp4"));
  const empty = context(async () => ({ body: null }));
  assert.ok(await empty.warmPlayableStream("https://cdn.test/episode.mp4"));
});
