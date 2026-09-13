import assert from "node:assert/strict";
import test from "node:test";
import { createEnrichmentBudget } from "./lib/enrichment-budget.mjs";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

test("enrichment requests have a timeout and cannot start after the save deadline", async () => {
  let now = 0;
  let calls = 0;
  const budget = createEnrichmentBudget([], 1, { now: () => now, request: async (_, options) => {
    calls++;
    assert.ok(options.signal instanceof AbortSignal);
    return "ok";
  } });
  assert.equal(await budget.fetch("https://example.test"), "ok");
  now = 60_000;
  assert.equal(budget.expired(), true);
  assert.throws(() => budget.fetch("https://example.test"), /budget exhausted/);
  assert.equal(calls, 1);
  await budget.sleep(60_000);
});

test("enrichment rejects invalid budgets and preserves caller cancellation", async () => {
  assert.throws(() => createEnrichmentBudget(["--max-minutes", "oops"], 1), /positive/);
  const controller = new AbortController();
  controller.abort();
  const budget = createEnrichmentBudget([], 1, { request: async (_, options) => options.signal.aborted });
  assert.equal(await budget.fetch("https://example.test", { signal: controller.signal }), true);
});

test("season seeding hydrates newly baked identities without replacing existing covers", () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-seeding-"));
  try {
    const map = join(dir, "artwork.json");
    const db = join(dir, "offline.jsonl");
    const airing = join(dir, "airing.json");
    writeFileSync(map, JSON.stringify({ entries: { "anilist-1": { anilistId: 1, metadataCover: "https://example.test/chosen.jpg", meta: { year: 2020 } } } }));
    writeFileSync(airing, JSON.stringify({ entries: { show: { franchiseSeasons: [{ anilistId: 1 }, { anilistId: 2 }, { anilistId: "mal-3", malId: 3 }] } } }));
    writeFileSync(db, [1, 2, 3].map(id => JSON.stringify({
      title: `Fixture ${id}`, sources: [`https://myanimelist.net/anime/${id}`, ...(id < 3 ? [`https://anilist.co/anime/${id}`] : [])],
      picture: `https://cdn.myanimelist.net/images/anime/1/${id}.jpg`, type: "TV", animeSeason: { year: 2020 }, episodes: 12
    })).join("\n"));
    for (const script of ["seed-anilist-rows", "fill-meta-from-offline-db"]) {
      execFileSync(process.execPath, [`scripts/${script}.mjs`, "--db", db, "--artwork", map, "--airing", airing, "--write"]);
    }
    const entries = JSON.parse(readFileSync(map, "utf8")).entries;
    assert.equal(entries["anilist-1"].metadataCover, "https://example.test/chosen.jpg");
    for (const key of ["anilist-2", "mal-3"]) {
      assert.ok(entries[key].metadataCover.endsWith("l.jpg"));
      assert.equal(entries[key].meta.episodes, 12);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workflow enrichment budgets finish before Actions step timeouts", () => {
  const workflow = readFileSync(".github/workflows/scrape-catalog.yml", "utf8");
  for (const step of workflow.split(/\n\s+- name:/).filter(step => step.includes("--max-minutes"))) {
    assert.ok(Number(step.match(/--max-minutes (\d+)/)?.[1]) < Number(step.match(/timeout-minutes: (\d+)/)?.[1]));
  }
  const artwork = readFileSync("scripts/build-artwork-map.mjs", "utf8");
  assert.match(artwork, /map\[item.id\] = \{ \.\.\.map\[item.id\], status: "error"/);
});
