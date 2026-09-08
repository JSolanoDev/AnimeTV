// Fail closed before a daily scrape can replace the last known-good catalogue.
// This validates provider identity, duplicate episode keys, artwork coverage,
// ordered season chains, and AniSkip intervals. With --restore-on-failure the
// rejected scrape is preserved for diagnosis and yesterday's snapshot is copied
// back into place.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function entriesOf(value) {
  return value && typeof value.entries === "object" && value.entries ? value.entries : {};
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function percent(part, total) {
  return total ? Number(((part / total) * 100).toFixed(2)) : 0;
}

function sourceSlug(item = {}) {
  const explicit = String(item.animeAv1Slug || "").trim().toLowerCase();
  if (explicit) return explicit;
  const url = String(item.siteUrl || "").match(/animeav1\.com\/media\/([^/?#]+)/i);
  if (url) return url[1].toLowerCase();
  const id = String(item.id || "").match(/^animeav1-(.+)$/i);
  return id ? id[1].toLowerCase() : "";
}

function validSegment(segment) {
  if (!segment || typeof segment !== "object") return false;
  const start = Number(segment.start);
  const end = Number(segment.end);
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start;
}

export function auditCatalogIntegrity({
  catalog,
  previous = null,
  artwork = null,
  airing = null,
  skipTimes = null,
  minimumRetainedRatio = 0.9,
  minimumIdentityRatio = 0.9,
  minimumArtworkRatio = 0.95
} = {}) {
  const errors = [];
  const warnings = [];
  const items = Array.isArray(catalog?.items) ? catalog.items : [];
  const oldItems = Array.isArray(previous?.items) ? previous.items : [];
  const artEntries = entriesOf(artwork);
  const airingEntries = entriesOf(airing);
  const skipEntries = entriesOf(skipTimes);
  const ambiguousMalIds = Array.isArray(skipTimes?.ambiguousMalIds) ? skipTimes.ambiguousMalIds : [];

  if (!items.length) errors.push("regular catalog has no titles");
  if (oldItems.length && items.length < Math.ceil(oldItems.length * minimumRetainedRatio)) {
    errors.push(`regular catalog shrank from ${oldItems.length} to ${items.length} titles`);
  }

  const seenIds = new Set();
  const seenSlugs = new Set();
  let sourceArtwork = 0;
  let identityRows = 0;
  let highQualityPosters = 0;
  let highQualityBackgrounds = 0;
  let wideBackgrounds = 0;
  let episodeRows = 0;
  let playableEpisodeRoutes = 0;

  for (const item of items) {
    const id = String(item?.id || "").trim();
    const title = String(item?.title || item?.name || "").trim();
    const slug = sourceSlug(item);
    if (!id) errors.push(`title without id: ${title || "(untitled)"}`);
    else if (seenIds.has(id)) errors.push(`duplicate catalog id: ${id}`);
    else seenIds.add(id);
    if (!title) errors.push(`catalog row ${id || "(missing id)"} has no title`);
    if (!slug) errors.push(`catalog row ${id || title} has no AnimeAV1 provider slug`);
    else if (seenSlugs.has(slug)) errors.push(`duplicate AnimeAV1 slug: ${slug}`);
    else seenSlugs.add(slug);

    if (item?.poster || item?.image || item?.cover || item?.thumbnail) sourceArtwork += 1;
    else errors.push(`catalog row ${id || title} has no source artwork`);

    const art = artEntries[id] || {};
    if (finitePositive(item?.malId || art.malId || art.meta?.malId)
      || finitePositive(item?.anilistId || art.anilistId)) identityRows += 1;
    const hasPoster = Boolean(art.tmdbPoster || art.anilistCover || art.metadataCover);
    const hasWideBackground = Boolean(art.tmdbBackdrop || art.anilistBanner);
    if (hasPoster) highQualityPosters += 1;
    if (hasWideBackground) wideBackgrounds += 1;
    // The watch surface deliberately uses the exact full-size poster as its
    // cover-cropped background when no trustworthy widescreen asset exists.
    // Count the source the UI really renders, while reporting wide coverage as
    // a separate metric so a fallback can never masquerade as a backdrop.
    if (hasWideBackground || hasPoster) highQualityBackgrounds += 1;

    const seenEpisodes = new Set();
    for (const [index, episode] of (Array.isArray(item?.episodes) ? item.episodes : []).entries()) {
      episodeRows += 1;
      const season = Number(episode?.canonicalSeason ?? episode?.season ?? item?.seasonNumber ?? 1);
      const number = Number(episode?.canonicalEpisode ?? episode?.episode ?? episode?.number);
      if (!Number.isFinite(season) || season <= 0 || !Number.isFinite(number) || number < 0) {
        errors.push(`${id || title} has an episode with invalid season/number at index ${index}`);
        continue;
      }
      const key = `${season}:${number}`;
      if (seenEpisodes.has(key)) errors.push(`${id || title} repeats canonical episode ${key}`);
      else seenEpisodes.add(key);
      if (episode?.siteUrl || episode?.videoUrl || episode?.externalUrl || episode?.streamResolver) {
        playableEpisodeRoutes += 1;
      } else {
        errors.push(`${id || title} episode ${key} has no provider playback route`);
      }
    }
  }

  const identityRatio = items.length ? identityRows / items.length : 0;
  const posterRatio = items.length ? highQualityPosters / items.length : 0;
  const backgroundRatio = items.length ? highQualityBackgrounds / items.length : 0;
  if (items.length && identityRatio < minimumIdentityRatio) {
    errors.push(`metadata identity coverage is ${percent(identityRows, items.length)}%, below ${minimumIdentityRatio * 100}%`);
  }
  if (items.length && posterRatio < minimumArtworkRatio) {
    errors.push(`high-quality poster coverage is ${percent(highQualityPosters, items.length)}%, below ${minimumArtworkRatio * 100}%`);
  }
  if (items.length && backgroundRatio < minimumArtworkRatio) {
    errors.push(`high-quality background coverage is ${percent(highQualityBackgrounds, items.length)}%, below ${minimumArtworkRatio * 100}%`);
  }
  if (items.length && wideBackgrounds < items.length) {
    warnings.push(`${items.length - wideBackgrounds} regular titles use their exact poster as the detail background fallback`);
  }

  let chainRows = 0;
  const seasonIdentities = new Set();
  let seasonIdentityPosters = 0;
  let seasonWideBackgrounds = 0;
  let seasonBackgroundSources = 0;
  let seasonMetadataRows = 0;
  let seasonDatedRows = 0;
  let seasonEpisodeCountRows = 0;
  for (const [rowId, entry] of Object.entries(airingEntries)) {
    if (entry?.sourceEpisodeCount != null && (!Number.isFinite(Number(entry.sourceEpisodeCount)) || Number(entry.sourceEpisodeCount) < 0)) {
      errors.push(`${rowId} has an invalid sourceEpisodeCount`);
    }
    const chain = Array.isArray(entry?.franchiseSeasons) ? entry.franchiseSeasons : [];
    if (!chain.length) continue;
    chainRows += 1;
    const ids = new Set();
    let previousStartedAt = 0;
    chain.forEach((season, index) => {
      // Jikan-only relations use a stable "mal-123" surrogate when the offline
      // database has no AniList cross-reference yet. It is still a trustworthy,
      // provider-backed identity and must remain valid until the next DB release.
      const id = String(season?.anilistId || season?.malId || "");
      if (!/^(?:\d+|mal-\d+)$/.test(id)) errors.push(`${rowId} season chain entry ${index + 1} has no stable identity`);
      else if (ids.has(id)) errors.push(`${rowId} season chain repeats identity ${id}`);
      else ids.add(id);
      if (/^(?:\d+|mal-\d+)$/.test(id) && !seasonIdentities.has(id)) {
        seasonIdentities.add(id);
        const artworkKey = /^\d+$/.test(id) ? `anilist-${id}` : id;
        const seasonArt = artEntries[artworkKey] || {};
        const hasPoster = Boolean(seasonArt.metadataCover || seasonArt.anilistCover || seasonArt.tmdbPoster);
        const hasWideBackground = Boolean(seasonArt.anilistBanner || seasonArt.tmdbBackdrop);
        if (hasPoster) seasonIdentityPosters += 1;
        else errors.push(`${rowId} season identity ${id} has no exact high-quality poster`);
        if (hasWideBackground) seasonWideBackgrounds += 1;
        if (hasWideBackground || hasPoster) seasonBackgroundSources += 1;
        else errors.push(`${rowId} season identity ${id} has no usable background source`);
        if (seasonArt.meta) seasonMetadataRows += 1;
        else errors.push(`${rowId} season identity ${id} has no canonical metadata`);
        if (season?.startedAt || season?.seasonYear || seasonArt.meta?.year) seasonDatedRows += 1;
        if (finitePositive(season?.episodes ?? seasonArt.meta?.episodes)) seasonEpisodeCountRows += 1;
      }
      if (Number(season?.order) !== index + 1) errors.push(`${rowId} season chain order is not contiguous`);
      if (!String(season?.title || "").trim()) errors.push(`${rowId} season chain entry ${index + 1} has no title`);
      const startedAt = Number(season?.startedAt || 0);
      if (startedAt && previousStartedAt && startedAt < previousStartedAt) {
        errors.push(`${rowId} season chain is not in release order`);
      }
      if (startedAt) previousStartedAt = startedAt;
    });
  }
  if (seasonIdentities.size && seasonWideBackgrounds < seasonIdentities.size) {
    warnings.push(`${seasonIdentities.size - seasonWideBackgrounds} season identities use their exact poster as the detail background fallback`);
  }

  let introRows = 0;
  let outroRows = 0;
  for (const [key, record] of Object.entries(skipEntries)) {
    if (!/^\d+:\d+$/.test(key)) errors.push(`invalid AniSkip key: ${key}`);
    if (record?.intro) {
      introRows += 1;
      if (!validSegment(record.intro)) errors.push(`invalid opening interval: ${key}`);
    }
    if (record?.outro) {
      outroRows += 1;
      if (!validSegment(record.outro)) errors.push(`invalid ending interval: ${key}`);
    }
    if (!record?.checkedAt && !record?.intro && !record?.outro) warnings.push(`empty AniSkip record: ${key}`);
  }
  if (skipTimes && Number(skipTimes.count || 0) !== Object.keys(skipEntries).length) {
    errors.push("AniSkip count does not match its entry map");
  }
  if (new Set(ambiguousMalIds.map(String)).size !== ambiguousMalIds.length
    || ambiguousMalIds.some((id) => !finitePositive(id))) {
    errors.push("AniSkip ambiguous MAL identity list is malformed");
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    metrics: {
      regularTitles: items.length,
      previousTitles: oldItems.length,
      sourceArtwork,
      metadataIdentities: identityRows,
      highQualityPosters,
      highQualityBackgrounds,
      wideBackgrounds,
      embeddedEpisodeRows: episodeRows,
      providerPlaybackRoutes: playableEpisodeRoutes,
      seasonChainRows: chainRows,
      uniqueSeasonIdentities: seasonIdentities.size,
      seasonIdentityPosters,
      seasonWideBackgrounds,
      seasonBackgroundSources,
      seasonMetadataRows,
      seasonDatedRows,
      seasonEpisodeCountRows,
      skipRecords: Object.keys(skipEntries).length,
      openingRecords: introRows,
      endingRecords: outroRows,
      ambiguousSkipIdentities: ambiguousMalIds.length,
      coverage: {
        identitiesPercent: percent(identityRows, items.length),
        postersPercent: percent(highQualityPosters, items.length),
        backgroundsPercent: percent(highQualityBackgrounds, items.length),
        wideBackgroundsPercent: percent(wideBackgrounds, items.length),
        seasonPostersPercent: percent(seasonIdentityPosters, seasonIdentities.size),
        seasonBackgroundSourcesPercent: percent(seasonBackgroundSources, seasonIdentities.size),
        seasonWideBackgroundsPercent: percent(seasonWideBackgrounds, seasonIdentities.size),
        seasonMetadataPercent: percent(seasonMetadataRows, seasonIdentities.size)
      }
    }
  };
}

export function restoreLastKnownGood(catalogPath, previousPath, rejectedPath) {
  const previous = JSON.parse(fs.readFileSync(previousPath, "utf8"));
  if (!Array.isArray(previous?.items) || !previous.items.length) {
    throw new Error("last-known-good catalog is missing or empty");
  }
  fs.mkdirSync(path.dirname(rejectedPath), { recursive: true });
  fs.copyFileSync(catalogPath, rejectedPath);
  fs.copyFileSync(previousPath, catalogPath);
}

function argOf(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function readJson(file, optional = false) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (optional) return null;
    throw new Error(`${path.relative(ROOT, file)}: ${error.message}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const catalogPath = path.resolve(argOf(args, "--catalog", path.join(ROOT, "scraper", "anime_metadata.json")));
  const previousPath = path.resolve(argOf(args, "--previous", path.join(ROOT, "scraper", "anime_metadata.previous.json")));
  const artworkPath = path.resolve(argOf(args, "--artwork", path.join(ROOT, "scraper", "artwork-map.json")));
  const airingPath = path.resolve(argOf(args, "--airing", path.join(ROOT, "scraper", "airing-map.json")));
  const skipPath = path.resolve(argOf(args, "--skip-times", path.join(ROOT, "scraper", "aniskip-map.json")));
  const rejectedPath = path.resolve(argOf(args, "--rejected", path.join(ROOT, "scraper", "anime_metadata.rejected.json")));
  const reportPath = argOf(args, "--report", "");

  const report = auditCatalogIntegrity({
    catalog: readJson(catalogPath),
    previous: readJson(previousPath, true),
    artwork: readJson(artworkPath),
    airing: readJson(airingPath),
    skipTimes: readJson(skipPath)
  });

  console.log(JSON.stringify(report.metrics, null, 2));
  report.warnings.forEach((warning) => console.warn(`WARN  ${warning}`));
  report.errors.forEach((error) => console.error(`FAIL  ${error}`));
  if (reportPath) {
    const absoluteReport = path.resolve(reportPath);
    fs.mkdirSync(path.dirname(absoluteReport), { recursive: true });
    fs.writeFileSync(absoluteReport, JSON.stringify(report, null, 2) + "\n", "utf8");
  }
  if (report.ok) {
    console.log("Catalog integrity OK");
    return;
  }
  if (args.includes("--restore-on-failure")) {
    restoreLastKnownGood(catalogPath, previousPath, rejectedPath);
    console.error(`Restored ${path.relative(ROOT, catalogPath)} from the last-known-good snapshot.`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Catalog integrity check failed: ${error.message}`);
    process.exit(1);
  });
}
