import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseReleases, parseReleaseDate, attachReleaseCatalog } from "./lib/underhentai-releases.mjs";

const card = (href = "/sample-series/", badge = "EP 02", date = "Sep 18, 2026") => `<article class="post-card"><a href="${href}"><img src="https://static.underhentai.net/assets/sample.jpg?w=280&amp;o=p"><div class="badge">${badge}</div><h3>Sample &amp; Series</h3></a><span class="label label-full">${date}</span></article>`;
test("release parser extracts episode dates, removes ad links and deduplicates", () => {
  const result = parseReleases(`<main>${card()}${card()}${card("https://ads.example/ad")}${card("/ad/", "AD")}${card("/sample-series/", "EP 02", "TBA")}<a href="/releases/2025/">2025</a></main>`, 2026);
  assert.equal(result.entries.length, 1);
  assert.deepEqual(result.entries[0], { id: "sample-series-e2-2026-09-18", slug: "sample-series", title: "Sample & Series", episode: 2, date: "2026-09-18", poster: "https://static.underhentai.net/assets/sample.jpg" });
  assert.deepEqual(result.years, [2025, 2026]);
});
test("invalid dates and dates from another year are rejected", () => {
  assert.equal(parseReleaseDate("Feb 30, 2026", 2026), "");
  assert.equal(parseReleaseDate("Feb 29, 2024", 2024), "2024-02-29");
  assert.equal(parseReleaseDate("Dec 31, 2025", 2026), "");
});
test("announcements without a title page remain on the calendar", () => {
  const result = parseReleases('<main><article class="post-card"><div><img src="https://static.underhentai.net/assets/announcement.jpg"><div class="badge">EP 01</div><h3>Future Series</h3></div><span class="label label-full">Nov 27, 2026</span><a href="https://static.underhentai.net/assets/trailer.mp4">Preview</a></article></main>', 2026);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].slug, "future-series");
  assert.equal(result.entries[0].date, "2026-11-27");
});
test("availability requires the exact episode, not a title-level episode count", () => {
  const entries = [1, 2, 3].map(episode => ({ slug: "sample", episode }));
  const result = attachReleaseCatalog(entries, [{ slug: "sample", episodeCount: 3, poster: "poster.jpg" }], [{ slug: "sample", episodes: [{ number: 1, sourceOptions: [{ watchUrl: "https://example.test/watch" }] }, { number: 3, sourceOptions: [] }] }]);
  assert.deepEqual(result.map(entry => entry.available), [true, false, false]);
  assert.equal(result[0].poster, "poster.jpg");
  assert.equal(attachReleaseCatalog(entries, [], [])[0].catalogId, "");
});
test("saved release calendars have unique, valid entries and matching Android data", () => {
  const body = readFileSync("scraper/underhentai_releases.json", "utf8");
  const snapshot = JSON.parse(body);
  assert.ok(Object.keys(snapshot.years).length > 0);
  for (const [year, entries] of Object.entries(snapshot.years)) {
    assert.ok(entries.length > 0);
    assert.equal(new Set(entries.map(entry => entry.id)).size, entries.length);
    for (const entry of entries) {
      assert.match(entry.date, new RegExp(`^${year}-\\d{2}-\\d{2}$`));
      assert.ok(entry.title && entry.episode > 0 && entry.poster);
      assert.ok(!entry.available || entry.catalogId);
    }
  }
  assert.equal(readFileSync("android/app/src/main/assets/scraper/underhentai_releases.json", "utf8"), body);
});
