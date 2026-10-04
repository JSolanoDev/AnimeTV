import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { ADULT_SNAPSHOT_FILES, refreshAdultCatalog } from "./refresh-adult-catalog.mjs";
import { AdultUpstreamUnavailableError, createAdultFetcher } from "./lib/adult-upstream.mjs";

const blocked = () => new AdultUpstreamUnavailableError("Adult provider HTTP 403", { status: 403 });
async function fixture(t, version = "saved") {
  const root = await mkdtemp(join(tmpdir(), "zenkai-adult-refresh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeSnapshot(root, version);
  return root;
}
async function writeSnapshot(root, version) {
  for (const file of ADULT_SNAPSHOT_FILES) {
    const path = join(root, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ version }));
  }
}
const snapshot = (root) => Promise.all(ADULT_SNAPSHOT_FILES.map((file) => readFile(join(root, file), "utf8")));
const isValidation = (script) => ["verify-underhentai-playability.mjs", "test-adult-releases.mjs"].includes(script);

test("403 preserves every adult asset byte-for-byte and skips the remaining builders", async (t) => {
  const root = await fixture(t);
  const before = await snapshot(root);
  const calls = [];
  const result = await refreshAdultCatalog({ root, run: async (script) => {
    calls.push(script);
    if (!isValidation(script)) throw blocked();
  } });
  assert.equal(result.status, "stale");
  assert.deepEqual(await snapshot(root), before);
  assert.equal(calls.filter((script) => !isValidation(script)).length, 1);
  assert.equal(calls.filter(isValidation).length, 4);
  assert.equal(JSON.parse(await readFile(join(root, "artifacts/adult-refresh-report.json"))).retainedSnapshot, true);
});

test("a late provider outage rolls back partially written web and Android data", async (t) => {
  const root = await fixture(t);
  const before = await snapshot(root);
  const result = await refreshAdultCatalog({ root, run: async (script) => {
    if (script === "build-underhentai-catalog.mjs") await writeSnapshot(root, "partial");
    if (script === "build-underhentai-details.mjs") throw blocked();
  } });
  assert.equal(result.status, "stale");
  assert.deepEqual(await snapshot(root), before);
});

test("invalid candidates and programming errors still fail and restore the old snapshot", async (t) => {
  for (const candidateError of [false, true]) {
    const root = await fixture(t);
    const before = await snapshot(root);
    let updated = false;
    await assert.rejects(refreshAdultCatalog({ root, run: async (script) => {
      if (script === "build-underhentai-catalog.mjs") {
        await writeSnapshot(root, "invalid");
        updated = true;
        if (!candidateError) throw new Error("parser bug");
      }
      if (candidateError && updated && isValidation(script)) throw new Error("invalid candidate");
    } }), /parser bug|invalid candidate/);
    assert.deepEqual(await snapshot(root), before);
  }
});

test("missing or invalid saved data cannot be used to conceal an upstream failure", async (t) => {
  const root = await fixture(t);
  let requests = 0;
  await assert.rejects(refreshAdultCatalog({ root, run: async () => { throw new Error("invalid baseline"); } }), /invalid baseline/);
  for (const file of ADULT_SNAPSHOT_FILES) await rm(join(root, file));
  await assert.rejects(refreshAdultCatalog({ root, run: async () => { requests++; throw blocked(); } }), /HTTP 403/);
  assert.equal(requests, 1);
  for (const file of ADULT_SNAPSHOT_FILES) await assert.rejects(readFile(join(root, file)), { code: "ENOENT" });
});

test("a healthy refresh validates and keeps the complete new snapshot", async (t) => {
  const root = await fixture(t);
  const result = await refreshAdultCatalog({ root, run: async (script) => {
    if (script === "build-underhentai-catalog.mjs") await writeSnapshot(root, "fresh");
  } });
  assert.equal(result.status, "fresh");
  assert.ok((await snapshot(root)).every((body) => JSON.parse(body).version === "fresh"));
});

test("403 and 429 stop queued requests without retrying or ignoring Retry-After", async () => {
  for (const status of [403, 429, 503]) {
    let requests = 0;
    const fetcher = createAdultFetcher({ intervalMs: 1000, sleep: async () => {}, fetchImpl: async () => {
      requests++;
      return new Response("blocked", { status, headers: { "Retry-After": "120" } });
    } });
    await assert.rejects(fetcher.fetchText("https://example.test/"), (error) => error.status === status && error.retryAfter === "120");
    await assert.rejects(fetcher.fetchText("https://example.test/page/2/"), { code: "ADULT_UPSTREAM_UNAVAILABLE" });
    assert.throws(fetcher.throwIfUnavailable, { code: "ADULT_UPSTREAM_UNAVAILABLE" });
    assert.equal(requests, 1);
  }
});

test("timeouts and network failures stop the refresh, but 404 is not an outage", async () => {
  const timeout = createAdultFetcher({ timeoutMs: 5, fetchImpl: async (_url, { signal }) =>
    new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))) });
  await assert.rejects(timeout.fetchText("https://example.test/"), { code: "ADULT_UPSTREAM_UNAVAILABLE" });
  const network = createAdultFetcher({ fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(network.fetchText("https://example.test/"), { code: "ADULT_UPSTREAM_UNAVAILABLE" });
  const missing = createAdultFetcher({ intervalMs: 0, fetchImpl: async () => new Response("missing", { status: 404 }) });
  await assert.rejects(missing.fetchText("https://example.test/"), /HTTP 404/);
  assert.doesNotThrow(missing.throwIfUnavailable);
});

test("a worker waiting for its request slot does not fetch after another worker is blocked", async () => {
  let releaseSlot;
  let requests = 0;
  const fetcher = createAdultFetcher({ intervalMs: 1000,
    sleep: () => new Promise((resolve) => { releaseSlot = resolve; }),
    fetchImpl: async () => { requests++; return new Response("Forbidden", { status: 403 }); } });
  const first = fetcher.fetchText("https://example.test/first");
  const queued = fetcher.fetchText("https://example.test/queued");
  await assert.rejects(first, { code: "ADULT_UPSTREAM_UNAVAILABLE" });
  releaseSlot();
  await assert.rejects(queued, { code: "ADULT_UPSTREAM_UNAVAILABLE" });
  assert.equal(requests, 1);
});

test("Android mismatch fails before any upstream call", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, ADULT_SNAPSHOT_FILES[1]), "{}");
  let calls = 0;
  await assert.rejects(refreshAdultCatalog({ root, run: async () => { calls++; } }), /mismatched/);
  assert.equal(calls, 0);
});

test("the actual catalog builder returns the outage exit code after a single 403", async (t) => {
  const root = await fixture(t);
  const hook = join(root, "mock-provider.mjs");
  await writeFile(hook, `import { appendFileSync } from 'node:fs';
    globalThis.fetch = async () => { appendFileSync('requests.log', 'request\\n'); return new Response('Forbidden', {status:403}); };`);
  const script = new URL("./build-underhentai-catalog.mjs", import.meta.url);
  const before = await snapshot(root);
  const child = spawnSync(process.execPath, ["--import", pathToFileURL(hook).href, fileURLToPath(script)], {
    cwd: root, encoding: "utf8", timeout: 10000
  });
  assert.equal(child.status, 75, child.stderr);
  assert.match(child.stderr, /HTTP 403/);
  assert.equal((await readFile(join(root, "requests.log"), "utf8")).trim(), "request");
  assert.deepEqual(await snapshot(root), before);
});
