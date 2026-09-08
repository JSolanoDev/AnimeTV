import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { normalizeAniSkipResults } = require("../animetv-server.js");
const clientSource = fs.readFileSync(path.join(ROOT, "client.js"), "utf8");

function skipContext(fetchWithTimeout) {
  const start = clientSource.indexOf("const _skipTimesByMal");
  const end = clientSource.indexOf("function buildApkPlayerUrl", start);
  assert.ok(start >= 0 && end > start, "client skip-time section exists");
  const context = vm.createContext({
    Map,
    Number,
    Promise,
    URLSearchParams,
    PLAYER_SKIP_SEGMENTS: ["intro", "outro"],
    fetchWithTimeout
  });
  vm.runInContext(clientSource.slice(start, end), context, { filename: "client.js skip extract" });
  return context;
}

test("parallel skip-time warmups share one request and expose both segments", async () => {
  let requests = 0;
  let release;
  let requestedUrl = "";
  const context = skipContext((url) => {
    requests += 1;
    requestedUrl = url;
    return new Promise((resolve) => { release = resolve; });
  });
  const warm = vm.runInContext("warmSkipTimes", context);
  const payloadFor = vm.runInContext("episodeSkipSegmentsPayload", context);
  const show = { malId: 123 };
  const episode = { id: "episode-1", episode: 1 };
  const first = warm(show, episode);
  const second = warm(show, episode);
  assert.equal(requests, 1);
  assert.match(requestedUrl, /malId=123/);
  assert.match(requestedUrl, /episode=1/);
  release({ json: async () => ({ episodes: { "1": {
    intro: { start: 0, end: 91.5 },
    outro: { start: 1300, end: 1380 }
  } } }) });
  await Promise.all([first, second]);
  await warm(show, episode);
  assert.equal(requests, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(payloadFor(show, episode))),
    {
      episodeKey: "episode-1",
      intro: { start: 0, end: 91.5 },
      outro: { start: 1300, end: 1380 }
    }
  );
});

test("server accepts only valid AniSkip opening and ending intervals", () => {
  assert.deepEqual(normalizeAniSkipResults({ found: true, results: [
    { skipType: "op", interval: { startTime: 0, endTime: 88.25 } },
    { skipType: "ed", interval: { startTime: 1200, endTime: 1260 } },
    { skipType: "op", interval: { startTime: 90, endTime: 10 } },
    { skipType: "mixed-op", interval: { startTime: 1, endTime: 2 } }
  ] }), {
    intro: { start: 0, end: 88.25 },
    outro: { start: 1200, end: 1260 }
  });
  assert.deepEqual(normalizeAniSkipResults({ found: false, results: [] }), {});
});

test("invalid segments are omitted and provider timing wins", async () => {
  const context = skipContext(async () => ({ json: async () => ({ episodes: {} }) }));
  const payloadFor = vm.runInContext("episodeSkipSegmentsPayload", context);
  const result = payloadFor(
    { malId: 0 },
    { id: "direct", episode: 1, intro: { start: 8, end: 75 }, outro: { start: 90, end: 80 } }
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    episodeKey: "direct",
    intro: { start: 8, end: 75 }
  });
});

test("AniSkip builder recovers MAL identity and source episode count from maps", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zenkai-skip-"));
  const catalog = path.join(dir, "catalog.json");
  const artwork = path.join(dir, "artwork.json");
  const airing = path.join(dir, "airing.json");
  const fixture = path.join(dir, "fixture.json");
  const out = path.join(dir, "aniskip.json");
  const androidOut = path.join(dir, "android-aniskip.json");
  fs.writeFileSync(catalog, JSON.stringify({ items: [{
    id: "animeav1-example-season-2",
    title: "Example Season 2",
    siteUrl: "https://animeav1.com/media/example-season-2",
    episodes: []
  }] }));
  fs.writeFileSync(artwork, JSON.stringify({ entries: {
    "animeav1-example-season-2": { malId: 500, anilistId: 600 }
  } }));
  fs.writeFileSync(airing, JSON.stringify({ entries: {
    "animeav1-example-season-2": { sourceEpisodeCount: 2 }
  } }));
  fs.writeFileSync(fixture, JSON.stringify({ entries: {
    "500:1": { intro: { start: 0, end: 90 } },
    "500:2": { outro: { start: 1200, end: 1260 } }
  } }));

  execFileSync(process.execPath, [
    path.join(ROOT, "scripts", "build-aniskip-map.mjs"),
    "--catalog", catalog,
    "--artwork", artwork,
    "--airing", airing,
    "--fixture", fixture,
    "--out", out,
    "--android-out", androidOut
  ], { stdio: "pipe" });

  const built = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(built.count, 2);
  assert.deepEqual(built.entries["500:1"].intro, { start: 0, end: 90 });
  assert.deepEqual(built.entries["500:2"].outro, { start: 1200, end: 1260 });
  assert.equal(fs.readFileSync(out, "utf8"), fs.readFileSync(androidOut, "utf8"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("AniSkip builder refuses MAL identities shared by different catalog titles", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zenkai-skip-collision-"));
  const catalog = path.join(dir, "catalog.json");
  const artwork = path.join(dir, "artwork.json");
  const airing = path.join(dir, "airing.json");
  const fixture = path.join(dir, "fixture.json");
  const out = path.join(dir, "aniskip.json");
  fs.writeFileSync(catalog, JSON.stringify({ items: [
    { id: "animeav1-example", title: "Example", episode: 1 },
    { id: "animeav1-example-special", title: "Example Special", episode: 1 }
  ] }));
  fs.writeFileSync(artwork, JSON.stringify({ entries: {
    "animeav1-example": { malId: 500 },
    "animeav1-example-special": { malId: 500 }
  } }));
  fs.writeFileSync(airing, JSON.stringify({ entries: {} }));
  fs.writeFileSync(fixture, JSON.stringify({ entries: {
    "500:1": { intro: { start: 0, end: 90 } }
  } }));

  execFileSync(process.execPath, [
    path.join(ROOT, "scripts", "build-aniskip-map.mjs"),
    "--catalog", catalog,
    "--artwork", artwork,
    "--airing", airing,
    "--fixture", fixture,
    "--out", out
  ], { stdio: "pipe" });

  const built = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.deepEqual(built.ambiguousMalIds, [500]);
  assert.equal(built.count, 0);
  assert.deepEqual(built.entries, {});
  fs.rmSync(dir, { recursive: true, force: true });
});
