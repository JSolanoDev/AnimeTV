import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const catalog = require("../scraper/animeneon-catalog.json");
const regularCatalog = require("../scraper/anime_metadata.json");
const server = require("../animetv-server.js");

test("AnimeNeon inventory includes Sub and Latino identities", () => {
  assert.ok(catalog.counts.Sub > 1000);
  assert.ok(catalog.counts.Lat > 500);

  const latino = server.animeNeonStaticCandidates(["One Piece"], "Lat", "TV", 1999)[0];
  const sub = server.animeNeonStaticCandidates(["One Piece"], "Sub", "TV", 1999)[0];
  assert.equal(latino?.slug, "one-piece-latino");
  assert.equal(sub?.slug, "one-piece");
  assert.ok(latino.episodes > 0);
  assert.ok(sub.episodes >= latino.episodes);
});

test("Latino availability is baked without matching the wrong installment", () => {
  const tagged = server.applyAnimeNeonAvailability({
    title: "One Piece",
    format: "TV",
    year: 1999
  });
  assert.equal(tagged.hasLatinoDub, true);
  assert.ok(tagged.latinoEpisodeCount > 0);

  assert.equal(
    server.animeNeonStaticCandidates(["One Piece Season 2"], "Lat", "TV", 1999).length,
    0
  );
  assert.equal(
    server.applyAnimeNeonAvailability({ title: "Definitely Not A Real Anime", format: "TV", year: 2026 }).hasLatinoDub,
    undefined
  );
});

test("the complete language inventory and every Latino tag have valid episode bounds", () => {
  const identities = new Set();
  const counts = {};
  for (const item of catalog.items) {
    const identity = `${item.language}:${item.slug}.${item.nanoid}`;
    assert.equal(identities.has(identity), false, `duplicate AnimeNeon identity: ${identity}`);
    identities.add(identity);
    assert.ok(Number(item.episodes) > 0, `${identity} must publish at least one episode`);
    counts[item.language] = Number(counts[item.language] || 0) + 1;
  }
  assert.deepEqual(counts, catalog.counts);

  let tagged = 0;
  for (const item of regularCatalog.items) {
    const resolved = server.applyAnimeNeonAvailability(item);
    if (!resolved.hasLatinoDub) continue;
    tagged += 1;
    assert.ok(Number(resolved.latinoEpisodeCount) > 0, `${item.id} has an invalid Latino range`);
    const matches = server.animeNeonStaticCandidates(
      [item.title, item.romajiTitle, item.englishTitle, ...(item.aliases || [])].filter(Boolean),
      "Lat",
      item.format || item.type || "",
      item.year
    );
    assert.ok(matches.length > 0, `${item.id} lost its exact Latino identity`);
    assert.equal(Number(resolved.latinoEpisodeCount), Number(matches[0].episodes));
  }
  assert.ok(tagged > 500, "expected broad Latino coverage in the regular catalog");
});
