import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { ADULT_SNAPSHOT_FILES, refreshAdultCatalog as refreshCatalogTransaction } from "./refresh-adult-catalog.mjs";
import { AdultUpstreamUnavailableError, createAdultFetcher } from "./lib/adult-upstream.mjs";
import { prepareAdultArtwork } from "./prepare-adult-artwork.mjs";

// Transaction-only fixtures deliberately omit artwork; availability has separate fixtures below.
const refreshAdultCatalog = options => refreshCatalogTransaction({ prepareArtwork: async () => null, ...options });

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
  assert.equal(result.failureCode, "ADULT_UPSTREAM_UNAVAILABLE");
  assert.equal(result.snapshotValidated, true);
  assert.equal(result.changesDetected, false);
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

async function checkRefreshReport(root, args = ["--allow-preserved-outage"]) {
  const outputPath = join(root, "github-output.txt");
  await writeFile(outputPath, "");
  const script = fileURLToPath(new URL("./check-adult-refresh-status.mjs", import.meta.url));
  const child = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: outputPath }, timeout: 10000 });
  return { ...child, output: (await readFile(outputPath, "utf8")).trim() };
}

test("expected provider outages warn without publishing only after byte-identical rollback", async t => {
  for (const status of [403, 429, 503, "timeout"]) {
    const root = await fixture(t);
    const before = await snapshot(root);
    await refreshAdultCatalog({ root, run: async script => {
      if (script === "build-underhentai-catalog.mjs") await writeSnapshot(root, "partial");
      if (script === "build-underhentai-details.mjs") {
        throw new AdultUpstreamUnavailableError(`Adult provider ${status}`, { status });
      }
    } });
    const result = await checkRefreshReport(root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, "changes_detected=false");
    assert.match(result.stderr, /::warning::Adult provider unavailable/);
    assert.match(result.stderr, /publishing and deployment skipped/);
    assert.doesNotMatch(result.stdout, /Provider check passed|ready to publish/);
    assert.deepEqual(await snapshot(root), before);
  }
});

test("warning mode rejects unproven outages, malformed reports, and inconsistent publication flags", async t => {
  const root = await fixture(t);
  const reportPath = join(root, "artifacts/adult-refresh-report.json");
  const valid = await refreshAdultCatalog({ root, run: async script => {
    if (!isValidation(script)) throw blocked();
  } });
  for (const patch of [
    { failureCode: null }, { failureCode: "ADULT_REFRESH_FAILED" }, { snapshotValidated: false },
    { retainedSnapshot: false }, { reason: "" }, { reason: {} }, { webAndAndroidMatch: false },
    { changesDetected: true }, { status: "unknown" }, { status: "fresh", changesDetected: false }
  ]) {
    await writeFile(reportPath, JSON.stringify({ ...valid, ...patch }));
    const result = await checkRefreshReport(root);
    assert.equal(result.status, 1, JSON.stringify(patch));
    assert.equal(result.output, "");
    assert.doesNotMatch(result.stderr, /::warning::/);
  }
  for (const body of ["not JSON", "null", "[]"]) {
    await writeFile(reportPath, body);
    const result = await checkRefreshReport(root);
    assert.equal(result.status, 1);
    assert.equal(result.output, "");
  }
  await rm(reportPath);
  const missing = await checkRefreshReport(root);
  assert.equal(missing.status, 1);
  assert.equal(missing.output, "");
});

test("a previous success report cannot survive a later programming or validation error", async t => {
  for (const validationError of [false, true]) {
    const root = await fixture(t);
    const reportPath = join(root, "artifacts/adult-refresh-report.json");
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify({ status: "fresh", changesDetected: true, webAndAndroidMatch: true }));
    const before = await snapshot(root);
    await assert.rejects(refreshAdultCatalog({ root, run: async script => {
      if (validationError || !isValidation(script)) throw new Error("neutral validation or parser error");
    } }), /neutral validation or parser error/);
    assert.deepEqual(await snapshot(root), before);
    await assert.rejects(readFile(reportPath), { code: "ENOENT" });
    assert.equal((await checkRefreshReport(root)).status, 1);
  }
});

test("outage validation must not modify the saved snapshot", async t => {
  const root = await fixture(t);
  const before = await snapshot(root);
  let validations = 0;
  await assert.rejects(refreshAdultCatalog({ root, run: async script => {
    if (!isValidation(script)) throw blocked();
    if (++validations === 3) await writeSnapshot(root, "unexpected validation change");
  } }), /changed during outage validation/);
  assert.deepEqual(await snapshot(root), before);
  await assert.rejects(readFile(join(root, "artifacts/adult-refresh-report.json")), { code: "ENOENT" });
});

test("warning mode resumes normal publication when provider access recovers", async t => {
  const root = await fixture(t);
  await refreshAdultCatalog({ root, run: async script => {
    if (!isValidation(script)) throw blocked();
  } });
  assert.equal((await checkRefreshReport(root)).output, "changes_detected=false");
  const recovered = await refreshAdultCatalog({ root, run: async script => {
    if (script === "build-underhentai-catalog.mjs") await writeSnapshot(root, "fresh");
  } });
  assert.equal(recovered.failureCode, null);
  const result = await checkRefreshReport(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "changes_detected=true");
  assert.match(result.stdout, /ready to publish/);
  assert.equal(result.stderr, "");
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

const ART_POSTER = "https://static.underhentai.net/assets/neutral-poster.jpg";
const ART_BACKGROUND = "https://static.underhentai.net/assets/neutral-background.jpg";
function artworkRow(slug = "neutral-series", poster = ART_POSTER, background = ART_BACKGROUND) {
  return { slug, title: "Neutral series", episodeCount: 1, screenshots: [background],
    mainWallpaper: poster, image: poster, poster, cover: poster, thumbnail: poster, coverImage: poster,
    highQualityBackground: background, underHentaiBackdrop: background, adultBackground: background,
    backdrop: background, banner: background,
    images: { poster, cover: poster, thumbnail: poster, banner: background, backdrop: background } };
}
async function writeArtworkFixture(root, rows = [artworkRow()], portraitItems = {}) {
  for (const file of ADULT_SNAPSHOT_FILES) {
    const payload = file.endsWith("adult_portrait_map.json") ? { version: 2, total: Object.keys(portraitItems).length, items: portraitItems }
      : file.endsWith("underhentai_releases.json") ? { years: {} } : { items: rows };
    await writeFile(join(root, file), JSON.stringify(payload));
  }
}
async function baselineArtwork(root) {
  return new Map(await Promise.all(ADULT_SNAPSHOT_FILES.map(async file => [file, await readFile(join(root, file))])));
}
const imageResponse = () => new Response(null, { headers: { "Content-Type": "image/jpeg", "Content-Length": "4096" } });

test("new titles have ready thumbnail/background fields and deduplicated opaque HEAD checks", async t => {
  const root = await fixture(t);
  await writeArtworkFixture(root, [artworkRow(), artworkRow("neutral-second")]);
  const calls = [];
  const result = await prepareAdultArtwork({ root, intervalMs: 0, fetchImpl: async (url, options) => {
    calls.push({ url, method: options.method });
    return imageResponse();
  } });
  assert.equal(result.checkedUrls, 2);
  assert.deepEqual(calls, [{ url: ART_POSTER, method: "HEAD" }, { url: ART_BACKGROUND, method: "HEAD" }]);
  const catalog = JSON.parse(await readFile(join(root, ADULT_SNAPSHOT_FILES[0])));
  assert.equal(catalog.items[0].thumbnail, ART_POSTER);
  assert.equal(catalog.items[0].highQualityBackground, ART_BACKGROUND);
});

test("unchanged published artwork creates no additional upstream or Vercel requests", async t => {
  const root = await fixture(t);
  await writeArtworkFixture(root);
  const before = await snapshot(root);
  const baseline = await baselineArtwork(root);
  const result = await prepareAdultArtwork({ root, baseline, fetchImpl: async () => { throw new Error("Unexpected request"); } });
  assert.equal(result.checkedUrls, 0);
  assert.equal(result.repairedTitles, 0);
  assert.deepEqual(await snapshot(root), before);
});

test("dead or HTML poster URLs use the same title's available artwork before publication", async t => {
  for (const status of [404, 200]) {
    const root = await fixture(t);
    const row = artworkRow();
    const fallback = "https://static.underhentai.net/assets/neutral-fallback.jpg";
    row.screenshots = [fallback];
    await writeArtworkFixture(root, [row]);
    const result = await prepareAdultArtwork({ root, intervalMs: 0, fetchImpl: async url => url === ART_POSTER
      ? new Response(null, { status, headers: { "Content-Type": "text/html" } }) : imageResponse() });
    assert.equal(result.rejectedUrls, 1);
    assert.equal(result.repairedTitles, 1);
    for (const file of ADULT_SNAPSHOT_FILES.filter(path => /underhentai_(?:catalog|details)\.json$/.test(path))) {
      const body = JSON.parse(await readFile(join(root, file)));
      assert.equal(body.items[0].thumbnail, fallback);
      assert.equal(body.items[0].images.poster, fallback);
      assert.equal(body.items[0].highQualityBackground, ART_BACKGROUND);
    }
  }
});

test("an unsupported HEAD uses one header-only range GET, without downloading the image", async t => {
  const root = await fixture(t);
  await writeArtworkFixture(root, [artworkRow("neutral-series", ART_POSTER, ART_POSTER)]);
  const methods = [];
  const result = await prepareAdultArtwork({ root, intervalMs: 0, fetchImpl: async (_url, options) => {
    methods.push(options.method);
    if (options.method === "HEAD") return new Response(null, { status: 405 });
    assert.equal(options.headers.Range, "bytes=0-0");
    return imageResponse();
  } });
  assert.equal(result.checkedUrls, 1);
  assert.deepEqual(methods, ["HEAD", "GET"]);
});

test("unavailable replacement artwork keeps the same title's previously published artwork", async t => {
  const root = await fixture(t);
  await writeArtworkFixture(root);
  const baseline = await baselineArtwork(root);
  await writeArtworkFixture(root, [artworkRow("neutral-series",
    "https://static.underhentai.net/assets/replacement-poster.jpg",
    "https://static.underhentai.net/assets/replacement-background.jpg")]);
  const calls = [];
  const result = await prepareAdultArtwork({ root, baseline, intervalMs: 0, fetchImpl: async url => {
    calls.push(url);
    return new Response(null, { status: 404 });
  } });
  assert.equal(result.checkedUrls, 2);
  assert.equal(result.rejectedUrls, 2);
  assert.ok(!calls.includes(ART_POSTER));
  assert.ok(!calls.includes(ART_BACKGROUND));
  const catalog = JSON.parse(await readFile(join(root, ADULT_SNAPSHOT_FILES[0])));
  assert.equal(catalog.items[0].thumbnail, ART_POSTER);
  assert.equal(catalog.items[0].highQualityBackground, ART_BACKGROUND);
});

test("a new title without available artwork cannot publish partial catalog changes", async t => {
  const root = await fixture(t);
  await writeArtworkFixture(root);
  const before = await snapshot(root);
  await assert.rejects(prepareAdultArtwork({ root, intervalMs: 0,
    fetchImpl: async () => new Response(null, { status: 404 }) }), /refusing to publish/);
  assert.deepEqual(await snapshot(root), before);
});

test("broken new portrait mappings fall back to the prepared title artwork", async t => {
  const root = await fixture(t);
  const portrait = "https://lain.bgm.tv/pic/cover/l/neutral.jpg";
  await writeArtworkFixture(root, [artworkRow()], { "neutral-series": { url: portrait, source: "neutral" } });
  await prepareAdultArtwork({ root, intervalMs: 0, fetchImpl: async url => url === portrait
    ? new Response(null, { status: 404 }) : imageResponse() });
  for (const file of ADULT_SNAPSHOT_FILES.filter(path => path.endsWith("adult_portrait_map.json"))) {
    const body = JSON.parse(await readFile(join(root, file)));
    assert.equal(body.items["neutral-series"], undefined);
    assert.equal(body.total, 0);
  }
});

test("artwork 403/429/5xx and timeouts stop without retrying or writing partial assets", async t => {
  for (const status of [403, 429, 503, "timeout"]) {
    const root = await fixture(t);
    await writeArtworkFixture(root);
    const before = await snapshot(root);
    let requests = 0;
    await assert.rejects(prepareAdultArtwork({ root, intervalMs: 0, timeoutMs: 5,
      fetchImpl: async (_url, options) => {
        requests++;
        if (status === "timeout") return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
        return new Response(null, { status, headers: { "Retry-After": "120" } });
      } }), error => error.code === "ADULT_UPSTREAM_UNAVAILABLE" && (status === "timeout" || error.retryAfter === "120"));
    assert.equal(requests, 1);
    assert.deepEqual(await snapshot(root), before);
  }
});

test("unsafe artwork redirects never reach a private or unapproved host", async t => {
  const root = await fixture(t);
  await writeArtworkFixture(root);
  let requests = 0;
  await assert.rejects(prepareAdultArtwork({ root, intervalMs: 0, fetchImpl: async () => {
    requests++;
    return new Response(null, { status: 302, headers: { Location: "https://127.0.0.1/private.jpg" } });
  } }), /refusing to publish/);
  assert.equal(requests, 2, "only the two original public asset URLs may be requested");
});

test("the real refresh transaction rolls back an artwork outage before the release builder", async t => {
  const root = await fixture(t);
  await writeArtworkFixture(root);
  const before = await snapshot(root);
  const calls = [];
  const result = await refreshCatalogTransaction({ root,
    run: async script => {
      calls.push(script);
      if (script === "build-underhentai-details.mjs") {
        await writeArtworkFixture(root, [artworkRow("neutral-new", "https://static.underhentai.net/assets/new.jpg")]);
      }
    },
    prepareArtwork: options => prepareAdultArtwork({ ...options, intervalMs: 0,
      fetchImpl: async () => new Response(null, { status: 403 }) }) });
  assert.equal(result.status, "stale");
  assert.equal(result.changesDetected, false);
  assert.deepEqual(await snapshot(root), before);
  assert.ok(!calls.includes("build-underhentai-releases.mjs"));
});

test("server and client preserve the prepared high-quality background over gallery fallbacks", async () => {
  const server = await readFile(new URL("../animetv-server.js", import.meta.url), "utf8");
  const client = await readFile(new URL("../client.js", import.meta.url), "utf8");
  const serverContext = { URL, UNDERHENTAI_BASE: "https://www.underhentai.net", decodeUnderHentaiImage: value => value };
  runInNewContext(server.slice(server.indexOf("function isUnderHentaiPlaceholderArtwork("), server.indexOf("function isBlockedPlaybackUrl(")), serverContext);
  assert.equal(serverContext.getUnderHentaiArtwork({ highQualityBackground: ART_BACKGROUND, screenshots: [ART_POSTER] }).backgroundArtwork, ART_BACKGROUND);
  const clientContext = { isAdultCatalogShow: () => true, hqImage: value => value };
  runInNewContext(client.slice(client.indexOf("function underHentaiBackdropCandidates("), client.indexOf("const HELL_MODE_WATCH_BACKDROP")), clientContext);
  assert.equal(clientContext.underHentaiBackdropCandidates({ highQualityBackground: ART_BACKGROUND, screenshots: [ART_POSTER] }).find(Boolean), ART_BACKGROUND);
});
