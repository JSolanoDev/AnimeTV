import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { latestArtworkRows, selectLatestArtwork, refreshLatestArtwork } from "./refresh-latest-artwork.mjs";

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

test("refresh uses existing identity, metadata and availability gates before publication", () => {
  const source = fs.readFileSync(new URL("refresh-latest-artwork.mjs", import.meta.url), "utf8");
  assert.match(source, /"--concurrency", "1"/);
  assert.match(source, /AbortSignal\.timeout\(15000\)/);
  assert.match(source, /build-artwork-map\.mjs[\s\S]*add-artwork-metadata\.mjs[\s\S]*prepare-regular-artwork\.mjs/);
  assert.match(source, /catch \(error\)[\s\S]*\[file, bytes\] of snapshots[\s\S]*writeFileSync\(file, bytes\)/);
  const workflow = fs.readFileSync(new URL("../.github/workflows/refresh-latest-artwork.yml", import.meta.url), "utf8");
  assert.match(workflow, /group: scrape-catalog/);
  assert.match(workflow, /changes_detected == 'true'/);
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

test("a failed publication gate restores root, Android and bootstrap bytes", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "art-refresh-"));
  const files = ["scraper/artwork-map.json", "scraper/anime_metadata.json",
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
