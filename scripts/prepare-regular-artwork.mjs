import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { createArtworkChecker } from "./lib/artwork-availability.mjs";
import { createEnrichmentBudget } from "./lib/enrichment-budget.mjs";
import { prepareCarouselArtwork } from "./lib/carousel-artwork.mjs";
import { buildHomepageBootstrap } from "./build-homepage-bootstrap.mjs";

const { animeAv1ArtworkVariant } = createRequire(import.meta.url)("../js/utils.js");
const HOSTS = new Set(["cdn.animeav1.com", "image.tmdb.org", "s4.anilist.co", "cdn.myanimelist.net",
  "media.kitsu.app", "cdn.anime-planet.com", "cdn.anisearch.com"]);
const POSTERS = ["tmdbPoster", "anilistCover", "metadataCover"];
const BACKGROUNDS = ["tmdbBackdrop", "anilistBanner"];
const THUMBNAILS = ["episodeThumbnailFallback"];
const ROW_POSTERS = ["tmdbPoster", "coverImageLarge", "poster", "image", "cover", "thumbnail"];
const ROW_BACKGROUNDS = ["tmdbBackdrop", "highQualityBackground", "banner", "backdrop"];
const values = (item, fields) => fields.map(field => item?.[field]).filter(Boolean);

function sameIdentity(current, previous) {
  return ["anilistId", "malId", "tmdbId"].every(field => {
    const a = current?.[field] || (field === "malId" ? current?.meta?.malId : null);
    const b = previous?.[field] || (field === "malId" ? previous?.meta?.malId : null);
    return !a || !b || String(a) === String(b);
  });
}

export async function prepareRegularArtwork({ catalog, artwork, previousCatalog = {}, previousArtwork = {},
  fetchImpl = globalThis.fetch, intervalMs = 550, timeoutMs = 6000, maxChecks = 500, sleep }) {
  const result = structuredClone({ catalog, artwork });
  const entries = result.artwork.entries || (result.artwork.entries = {});
  const priorEntries = previousArtwork.entries || {};
  const priorRows = new Map((previousCatalog.items || []).map(item => [item.id, item]));
  const rows = new Map((result.catalog.items || []).map(item => [item.id, item]));
  const known = new Set([
    ...Object.values(priorEntries).flatMap(item => values(item, [...POSTERS, ...BACKGROUNDS, ...THUMBNAILS])),
    ...(previousCatalog.items || []).flatMap(item => values(item, [...ROW_POSTERS, ...ROW_BACKGROUNDS]))
  ]);
  const { check, pick, stats } = createArtworkChecker({ hosts: HOSTS, known, fetchImpl, intervalMs,
    timeoutMs, maxChecks, sleep, headers: { "User-Agent": "ZenkaiTV-catalog-artwork/1.0" } });
  const repaired = new Set();

  async function repairFields(target, fields, previous = {}) {
    for (const field of fields) {
      if (!target[field] || await check(target[field])) continue;
      target[field] = previous[field] && await check(previous[field]) ? previous[field] : "";
    }
  }

  // Only exact source keys or already-resolved season identities are used here.
  // Never search by title or borrow another season's artwork to pass this gate.
  for (const id of new Set([...Object.keys(entries), ...rows.keys()])) {
    const row = rows.get(id);
    const originalArt = entries[id];
    const art = originalArt || {};
    const before = structuredClone({ row, art });
    const previousArt = sameIdentity(art, priorEntries[id]) ? priorEntries[id] || {} : {};
    await repairFields(art, [...POSTERS, ...BACKGROUNDS, ...THUMBNAILS], previousArt);
    if (row) await repairFields(row, [...ROW_POSTERS, ...ROW_BACKGROUNDS], priorRows.get(id));
    const sourcePoster = row ? await pick([...values(row, ROW_POSTERS),
      ...values(priorRows.get(id), ROW_POSTERS), ...values(art, POSTERS),
      ...values(row, ROW_BACKGROUNDS).map(url => animeAv1ArtworkVariant(url, "poster"))]) : "";
    const poster = await pick([...values(art, POSTERS), ...values(previousArt, POSTERS), sourcePoster]);
    if (!poster) {
      if (row || values(before.art, [...POSTERS, ...BACKGROUNDS]).length) {
        throw new Error(`Artwork unavailable for exact identity ${id}; refusing partial publication.`);
      }
      continue;
    }
    if (!values(art, POSTERS).length) art.metadataCover = poster;
    if (row) {
      row.poster ||= sourcePoster || poster;
      row.image ||= sourcePoster || poster;
      // A full-size exact poster is the existing fallback when no wide art exists.
      const background = await pick([...values(art, BACKGROUNDS), ...values(row, ROW_BACKGROUNDS),
        ...values(previousArt, BACKGROUNDS), poster]);
      if (!background) throw new Error(`Background unavailable for ${id}; refusing partial publication.`);
      if (!priorRows.has(id) || values(before.row, ROW_BACKGROUNDS).length) row.banner ||= background;
    }
    if (!isDeepStrictEqual(before.art, art)) {
      art.status = "artwork-fallback";
      entries[id] = art;
    }
    if (!isDeepStrictEqual(before, { row, art })) repaired.add(id);
  }
  if (!isDeepStrictEqual(result.artwork.entries, artwork.entries)) {
    result.artwork.count = Object.keys(entries).length;
  }
  return { ...result, stats: { ...stats, repairedTitles: repaired.size } };
}

export async function prepareRegularArtworkFiles({ root = process.cwd(), fetchImpl = globalThis.fetch,
  maxMinutes = 10, maxChecks = 500, carouselIds } = {}) {
  const catalogPath = "scraper/anime_metadata.json";
  const artworkPath = "scraper/artwork-map.json";
  const read = async file => JSON.parse(await readFile(resolve(root, file), "utf8"));
  const baseline = file => JSON.parse(execFileSync("git", ["show", `HEAD:${file}`],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  const [catalog, artwork] = await Promise.all([read(catalogPath), read(artworkPath)]);
  const budget = createEnrichmentBudget(["--max-minutes", String(maxMinutes)], maxMinutes, { request: fetchImpl });
  const result = await prepareRegularArtwork({ catalog, artwork, previousCatalog: baseline(catalogPath),
    previousArtwork: baseline(artworkPath), fetchImpl: budget.fetch, maxChecks });
  const airing = await read("scraper/airing-map.json").catch(() => ({}));
  const ids = carouselIds || buildHomepageBootstrap(result.catalog, result.artwork, airing).items.map(row => row.id);
  result.stats.carousel = await prepareCarouselArtwork(result.artwork.entries, ids, { fetchImpl: budget.fetch });
  // No file is touched until every candidate passes. A failed gate cannot publish.
  for (const [file, payload, original] of [[catalogPath, result.catalog, catalog], [artworkPath, result.artwork, artwork]]) {
    if (isDeepStrictEqual(payload, original)) continue;
    await writeFile(resolve(root, file), `${JSON.stringify(payload)}\n`);
  }
  await writeFile(resolve(root, "android/app/src/main/assets", artworkPath), await readFile(resolve(root, artworkPath)));
  const report = resolve(root, "artifacts/regular-artwork-report.json");
  await mkdir(dirname(report), { recursive: true });
  await writeFile(report, `${JSON.stringify(result.stats, null, 2)}\n`);
  return result.stats;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--max-minutes");
  const maxMinutes = index >= 0 ? Number(process.argv[index + 1]) || 10 : 10;
  const idsIndex = process.argv.indexOf("--carousel-ids");
  const carouselIds = idsIndex >= 0 ? String(process.argv[idsIndex + 1] || "").split(",").filter(Boolean) : undefined;
  prepareRegularArtworkFiles({ maxMinutes, carouselIds }).then(stats => console.log(JSON.stringify(stats))).catch(error => {
    console.error(error.message);
    if (error.retryAfter) console.error(`Retry-After: ${error.retryAfter}; no immediate retry.`);
    process.exitCode = 1;
  });
}
