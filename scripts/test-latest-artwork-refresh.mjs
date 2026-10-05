import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { latestArtworkRows, selectLatestArtwork, selectLatestAiring, refreshLatestArtwork } from "./refresh-latest-artwork.mjs";

test("release seeding deduplicates exact provider identities without inventing episodes", () => {
  const rows = latestArtworkRows({ items: [
    { slug: "neutral-title", title: "Neutral Title", episode: 2 },
    { slug: "neutral-title", title: "Neutral Title", episode: 1 },
    { slug: "../bad", title: "Invalid" }
  ] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "animeav1-neutral-title");
  assert.equal(rows[0].sourceEpisodeIds, undefined);
  assert.equal(rows[0].episode, undefined);
});

test("complete saved metadata makes hourly runs no-ops; misses retry only daily", () => {
  const now = Date.parse("2026-10-05T00:00:00Z");
  const rows = ["ready", "retry", "new"].map((id) => ({ id }));
  const entries = {
    ready: { status: "ok", tmdbBackdrop: "wide.jpg", anilistCover: "cover.jpg",
      meta: { description: "A neutral synopsis.", genres: ["Adventure"] } },
    retry: { artworkCheckedAt: new Date(now - 3600000).toISOString() }
  };
  assert.deepEqual(selectLatestArtwork(rows, entries, now), [{ id: "new" }]);
  assert.deepEqual(selectLatestArtwork(rows, entries, now + 86400000), [{ id: "new" }, { id: "retry" }]);
  assert.equal(selectLatestArtwork(rows, entries, now, 1).length, 1);
});

test("recent exact schedules reuse known identities and are checked at most daily", () => {
  const now = Date.parse("2026-10-05T00:00:00Z");
  const rows = ["ready", "new", "unknown", "finished", "retry"].map(id => ({ id }));
  const entries = {
    ready: { anilistId: 1, airingCheckedAt: new Date(now - 3600000).toISOString() },
    new: { anilistId: 2, meta: { airingStatus: "RELEASING" } },
    unknown: { meta: { airingStatus: "RELEASING" } },
    finished: { anilistId: 3, meta: { airingStatus: "FINISHED" } },
    retry: { anilistId: 4, airingCheckedAt: new Date(now - 86400000).toISOString() }
  };
  assert.deepEqual(selectLatestAiring(rows, entries, now), [{ id: "new" }, { id: "retry" }]);
  assert.equal(selectLatestAiring(rows, entries, now, 1).length, 1);
  entries.new.airingCheckedAt = new Date(now).toISOString();
  entries.retry.airingCheckedAt = new Date(now).toISOString();
  assert.deepEqual(selectLatestAiring(rows, entries, now), []);
});

test("refresh uses existing identity, metadata and availability gates before publication", () => {
  const source = fs.readFileSync(new URL("refresh-latest-artwork.mjs", import.meta.url), "utf8");
  assert.match(source, /"--concurrency", "1"/);
  assert.match(source, /AbortSignal\.timeout\(15000\)/);
  assert.match(source, /build-artwork-map\.mjs[\s\S]*add-artwork-metadata\.mjs[\s\S]*prepare-regular-artwork\.mjs/);
  assert.match(source, /"--refresh-airing"/);
  assert.match(source, /catch \(error\)[\s\S]*\[file, bytes\] of snapshots[\s\S]*writeFileSync\(file, bytes\)/);
  const workflow = fs.readFileSync(new URL("../.github/workflows/refresh-latest-artwork.yml", import.meta.url), "utf8");
  assert.match(workflow, /group: scrape-catalog/);
  assert.match(workflow, /changes_detected == 'true'/);
  assert.match(workflow, /cron: '37 \* \* \* \*'/);
  const daily = fs.readFileSync(new URL("../.github/workflows/scrape-catalog.yml", import.meta.url), "utf8");
  const metadata = daily.indexOf("node scripts/add-artwork-metadata.mjs");
  const schedule = daily.indexOf("node scripts/build-airing-map.mjs --write");
  const publish = daily.indexOf("bash scripts/commit-catalog-update.sh");
  assert.ok(metadata >= 0 && schedule > metadata && publish > schedule);
});

test("a new title automatically receives artwork, metadata and its schedule before publication", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "art-refresh-new-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const id = "animeav1-neutral";
  const file = name => path.join(rootDir, name);
  const write = (name, value) => {
    fs.mkdirSync(path.dirname(file(name)), { recursive: true });
    fs.writeFileSync(file(name), JSON.stringify(value));
  };
  const inventory = { items: [{ id, title: "Neutral", sourceEpisodeIds: [1, 2], sourceEpisodeCount: 2 }] };
  write("scraper/artwork-map.json", { entries: {} });
  write("scraper/airing-map.json", { entries: {} });
  write("scraper/anime_metadata.json", inventory);
  write("android/app/src/main/assets/scraper/artwork-map.json", { entries: {} });
  write("homepage-bootstrap.json", { items: [] });
  const calls = [];
  const fetchImpl = async () => ({ ok: true,
    text: async () => '<article><a href="/media/neutral/2"><span class="sr-only">Ver Neutral 2</span></a></article>' });
  const run = (script, args) => {
    calls.push(script);
    const map = JSON.parse(fs.readFileSync(file("scraper/artwork-map.json"), "utf8"));
    if (script === "build-artwork-map.mjs") {
      const input = JSON.parse(fs.readFileSync(args[args.indexOf("--catalog") + 1], "utf8"));
      assert.deepEqual(input.items.map(row => row.id), [id]);
      map.entries[id] = { anilistId: 123, status: "ok", tmdbBackdrop: "wide.jpg", anilistCover: "cover.jpg" };
    }
    if (script === "add-artwork-metadata.mjs") {
      assert.equal(args[args.indexOf("--ids") + 1], id);
      assert.ok(args.includes("--refresh-airing"));
      map.entries[id].meta = { description: "A neutral synopsis.", genres: ["Adventure"], airingStatus: "RELEASING" };
      map.entries[id].airingCheckedAt = new Date().toISOString();
      write("scraper/airing-map.json", { entries: {
        [id]: { anilistId: 123, nextAiringAt: 1791729000000, nextAiringEpisodeNumber: 3, franchiseSeasons: [] }
      } });
    }
    if (script === "prepare-regular-artwork.mjs") {
      assert.equal(args[args.indexOf("--carousel-ids") + 1], id);
      map.entries[id].carouselArtworkCheckedAt = new Date().toISOString();
      map.entries[id].carouselArtworkCheckedUrl = map.entries[id].tmdbBackdrop;
    }
    if (["build-artwork-map.mjs", "add-artwork-metadata.mjs", "prepare-regular-artwork.mjs"].includes(script)) write("scraper/artwork-map.json", map);
  };
  assert.deepEqual(await refreshLatestArtwork({ rootDir, fetchImpl, run }), [id]);
  assert.deepEqual(calls, ["build-artwork-map.mjs", "add-artwork-metadata.mjs",
    "prepare-regular-artwork.mjs", "build-homepage-bootstrap.mjs"]);
  assert.equal(JSON.parse(fs.readFileSync(file("scraper/airing-map.json"))).entries[id].nextAiringAt, 1791729000000);
  assert.deepEqual(JSON.parse(fs.readFileSync(file("scraper/anime_metadata.json"))), inventory);

  const saved = fs.readFileSync(file("scraper/artwork-map.json"), "utf8");
  calls.length = 0;
  assert.deepEqual(await refreshLatestArtwork({ rootDir, fetchImpl, run }), []);
  assert.deepEqual(calls, []);
  assert.equal(fs.readFileSync(file("scraper/artwork-map.json"), "utf8"), saved);

  // A later check refreshes schedules without redoing successful artwork searches.
  const map = JSON.parse(saved);
  map.entries[id].airingCheckedAt = new Date(Date.now() - 25 * 3600000).toISOString();
  write("scraper/artwork-map.json", map);
  assert.deepEqual(await refreshLatestArtwork({ rootDir, fetchImpl, run }), [id]);
  assert.deepEqual(calls, ["add-artwork-metadata.mjs", "prepare-regular-artwork.mjs", "build-homepage-bootstrap.mjs"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file("scraper/anime_metadata.json"))), inventory);
});

test("an upstream failure leaves saved files alone and never starts lookups", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "art-refresh-"));
  const mapPath = path.join(rootDir, "scraper", "artwork-map.json");
  fs.mkdirSync(path.dirname(mapPath));
  const original = JSON.stringify({ entries: {} });
  fs.writeFileSync(mapPath, original);
  try {
    await assert.rejects(refreshLatestArtwork({ rootDir, fetchImpl: async () => ({ ok: false, status: 429 }),
      run: () => { throw new Error("Must not run"); } }), /HTTP 429/);
    assert.equal(fs.readFileSync(mapPath, "utf8"), original);
    assert.equal(fs.existsSync(path.join(rootDir, "scratch")), false);
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test("pending HD checks use the publication gate without repeating metadata/API searches", async t => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "art-refresh-hd-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const id = "animeav1-neutral";
  fs.mkdirSync(path.join(rootDir, "scraper"));
  const mapPath = path.join(rootDir, "scraper/artwork-map.json");
  fs.writeFileSync(mapPath, JSON.stringify({ entries: { [id]: { anilistId: 123, status: "ok",
    tmdbBackdrop: "https://image.tmdb.org/t/p/original/neutral.jpg", anilistCover: "cover.jpg",
    airingCheckedAt: new Date().toISOString(), meta: { description: "Neutral synopsis.", genres: ["Adventure"] } } } }));
  const calls = [];
  await refreshLatestArtwork({ rootDir,
    fetchImpl: async () => ({ ok: true, text: async () => '<article><a href="/media/neutral/1"><span class="sr-only">Ver Neutral 1</span></a></article>' }),
    run: (script, args) => {
      calls.push(script);
      if (script === "prepare-regular-artwork.mjs") assert.equal(args[args.indexOf("--carousel-ids") + 1], id);
    } });
  assert.deepEqual(calls, ["prepare-regular-artwork.mjs", "build-homepage-bootstrap.mjs"]);
});

test("a failed publication gate restores root, Android and bootstrap bytes", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "art-refresh-"));
  const files = ["scraper/artwork-map.json", "scraper/airing-map.json", "scraper/anime_metadata.json",
    "android/app/src/main/assets/scraper/artwork-map.json", "homepage-bootstrap.json"];
  for (const file of files) {
    const target = path.join(rootDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ entries: {}, unchanged: file }));
  }
  const originals = files.map(file => fs.readFileSync(path.join(rootDir, file), "utf8"));
  try {
    await assert.rejects(refreshLatestArtwork({ rootDir,
      fetchImpl: async () => ({ ok: true, text: async () => '<article><a href="/media/neutral/1"><span class="sr-only">Ver Neutral 1</span></a></article>' }),
      run: (script) => {
        if (script !== "prepare-regular-artwork.mjs") return;
        for (const file of files) fs.writeFileSync(path.join(rootDir, file), "changed");
        throw new Error("Verification failed");
      }
    }), /Verification failed/);
    assert.deepEqual(files.map(file => fs.readFileSync(path.join(rootDir, file), "utf8")), originals);
    assert.equal(fs.existsSync(path.join(rootDir, "scratch/latest-artwork-input.json")), false);
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});
