import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
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
  assert.equal(result.changesDetected, true);
  assert.ok((await snapshot(root)).every((body) => JSON.parse(body).version === "fresh"));
});

async function writeTimedSnapshot(root, time, change = {}) {
  for (const file of ADULT_SNAPSHOT_FILES) {
    const payload = file.endsWith("adult_portrait_map.json")
      ? { generatedAt: time, items: { "neutral-series": { poster: change.poster || "https://cdn.test/poster.jpg" } } }
      : { generatedAt: time, catalogGeneratedAt: time,
        items: [{ slug: "neutral-series", metadataCheckedAt: time, episodeCount: change.episodeCount || 1,
          description: change.description || "Neutral description", sourceUrl: change.sourceUrl || "https://cdn.test/stream?token=one" }] };
    await writeFile(join(root, file), JSON.stringify(payload));
  }
}

test("timestamp-only refreshes retain byte-identical assets and skip publication", async (t) => {
  const root = await fixture(t);
  await writeTimedSnapshot(root, "2026-10-01T06:00:00Z");
  const before = await snapshot(root);
  const result = await refreshAdultCatalog({ root, run: async (script) => {
    if (script === "build-underhentai-catalog.mjs") await writeTimedSnapshot(root, "2026-10-02T06:00:00Z");
  } });
  assert.equal(result.status, "unchanged");
  assert.equal(result.changesDetected, false);
  assert.equal(result.retainedSnapshot, true);
  assert.deepEqual(await snapshot(root), before);
});

test("episode, artwork, description, and signed source changes still publish", async (t) => {
  for (const change of [{ episodeCount: 2 }, { poster: "https://cdn.test/new.jpg" },
    { description: "Updated neutral description" }, { sourceUrl: "https://cdn.test/stream?token=two" }]) {
    const root = await fixture(t);
    await writeTimedSnapshot(root, "2026-10-01T06:00:00Z");
    const result = await refreshAdultCatalog({ root, run: async (script) => {
      if (script === "build-underhentai-catalog.mjs") await writeTimedSnapshot(root, "2026-10-02T06:00:00Z", change);
    } });
    assert.equal(result.status, "fresh");
    assert.equal(result.changesDetected, true);
  }
});

test("the online publication gate refuses stale or inconsistent reports", async (t) => {
  const root = await fixture(t);
  const reportPath = join(root, "artifacts/adult-refresh-report.json");
  const outputPath = join(root, "github-output.txt");
  await mkdir(dirname(reportPath), { recursive: true });
  const script = fileURLToPath(new URL("./check-adult-refresh-status.mjs", import.meta.url));
  for (const [status, changesDetected, expectedExit, expectedOutput] of [
    ["fresh", true, 0, "true"], ["unchanged", false, 0, "false"],
    ["stale", false, 1, ""], ["fresh", false, 1, ""], ["unknown", false, 1, ""]
  ]) {
    await writeFile(reportPath, JSON.stringify({ status, changesDetected, webAndAndroidMatch: true, reason: "Provider HTTP 403" }));
    await writeFile(outputPath, "");
    const child = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: outputPath }, timeout: 10000 });
    assert.equal(child.status, expectedExit, child.stderr);
    assert.equal((await readFile(outputPath, "utf8")).trim(), expectedOutput ? `changes_detected=${expectedOutput}` : "");
    if (status === "stale") assert.match(child.stderr, /Existing catalog preserved; nothing published/);
  }
});

test("a blocked refresh reports the retained snapshot's real age and title count", async (t) => {
  const root = await fixture(t);
  const generatedAt = new Date(Date.now() - 10 * 86400000).toISOString();
  const catalog = JSON.stringify({ generatedAt, items: [{ slug: "neutral-series" }] });
  for (const file of ADULT_SNAPSHOT_FILES.slice(0, 2)) await writeFile(join(root, file), catalog);
  const result = await refreshAdultCatalog({ root, run: async (script) => {
    if (!isValidation(script)) throw blocked();
  } });
  assert.equal(result.status, "stale");
  assert.equal(result.catalogGeneratedAt, generatedAt);
  assert.equal(result.catalogAgeHours, 240);
  assert.equal(result.titleCount, 1);
  assert.equal(result.retainedSnapshot, true);
  assert.deepEqual(JSON.parse(await readFile(join(root, "artifacts/adult-refresh-report.json"))), result);
});

test("empty safety markers cannot bypass configured checks; the server contract stays unchanged", async () => {
  const source = await readFile(new URL("./build-underhentai-catalog.mjs", import.meta.url), "utf8");
  const constants = source.slice(source.indexOf("const UNSAFE_MINOR_MARKERS"), source.indexOf("function decodeHtml"));
  const functions = source.slice(source.indexOf("function normalizeSafetyText"), source.indexOf("function currentMetaRow"));
  const context = {};
  runInNewContext(constants + functions, context);
  assert.equal(context.isSafeAdultMetadata({ title: "Neutral series" }), true);
  assert.equal(context.isSafeAdultMetadata({ title: "JK neutral fixture" }), false);
  assert.equal(context.isSafeAdultMetadata({ title: "Neutral series", tags: ["JK"] }), false);
  const server = await readFile(new URL("../animetv-server.js", import.meta.url), "utf8");
  const serverContext = {};
  runInNewContext(server.match(/function isSafeAdultMetadata\(\)\s*\{[^}]+\}/)?.[0] || "", serverContext);
  assert.equal(serverContext.isSafeAdultMetadata(), true);
});

test("the real builder discovers new titles with artwork and episodes without refetching page one", async (t) => {
  const root = await fixture(t);
  const previous = { slug: "neutral-previous", title: "Neutral previous", episodeCount: 1,
    metadataCheckedAt: "2026-09-01T00:00:00Z", image: "https://static.underhentai.net/assets/previous.jpg" };
  const catalog = JSON.stringify({ items: [previous], excludedSlugs: [] });
  for (const file of ADULT_SNAPSHOT_FILES.slice(0, 2)) await writeFile(join(root, file), catalog);
  const rows = [previous, { slug: "neutral-new", title: "Neutral new" }, { slug: "neutral-excluded", title: "JK neutral fixture" }];
  const listing = rows.map(({ slug, title }) => `<article><a href="/${slug}/"><img src="https://static.underhentai.net/assets/${slug}.jpg"><h2>${title}</h2></a></article>`).join("");
  const pages = { "/": listing,
    "/sitemap.xml": "<sitemapindex><loc>https://www.underhentai.net/post-sitemap.xml</loc></sitemapindex>",
    "/post-sitemap.xml": `<urlset>${rows.map(({ slug }) => `<loc>https://www.underhentai.net/${slug}/</loc>`).join("")}</urlset>` };
  for (const { slug, title } of rows) pages[`/${slug}/`] = `<h1>${title}</h1><a class="glightbox" href="https://static.underhentai.net/assets/${slug}.jpg"></a><div class="ep2-header">Episode 1</div><a class="ep2-stream" href="/watch/?id=${slug}-1">Stream</a><div class="ep2-header">Episode 2</div><a class="ep2-stream" href="/watch/?id=${slug}-2">Stream</a>`;
  const hook = join(root, "neutral-provider.mjs");
  await writeFile(hook, `import {appendFileSync} from 'node:fs';
    const pages = ${JSON.stringify(pages)};
    globalThis.fetch = async (url) => { const path = new URL(url).pathname; appendFileSync('requests.log', path+'\\n');
      return new Response(pages[path] || 'Missing', {status: pages[path] ? 200 : 404}); };`);
  const script = new URL("./build-underhentai-catalog.mjs", import.meta.url);
  const child = spawnSync(process.execPath, ["--import", pathToFileURL(hook).href, fileURLToPath(script)], {
    cwd: root, encoding: "utf8", timeout: 10000
  });
  assert.equal(child.status, 0, child.stderr);
  const body = await readFile(join(root, ADULT_SNAPSHOT_FILES[0]), "utf8");
  const result = JSON.parse(body);
  assert.deepEqual(result.items.map(({ slug }) => slug), ["neutral-previous", "neutral-new"]);
  const item = result.items.find(({ slug }) => slug === "neutral-new");
  assert.equal(item.episodeCount, 2);
  assert.equal(item.releaseCount, 2);
  assert.equal(item.image, pages["/"].match(/src="([^"]*neutral-new.jpg)"/)[1]);
  assert.equal(item.poster, item.image);
  assert.ok(item.metadataCheckedAt);
  assert.equal(result.excludedForSafety, 1);
  assert.equal(await readFile(join(root, ADULT_SNAPSHOT_FILES[1]), "utf8"), body);
  const requests = (await readFile(join(root, "requests.log"), "utf8")).trim().split("\n");
  assert.equal(requests.filter((path) => path === "/").length, 1);
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
