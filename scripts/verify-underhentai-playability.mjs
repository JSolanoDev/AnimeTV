import { readFile } from "node:fs/promises";

const CATALOG = "scraper/underhentai_catalog.json";
const DETAILS = "scraper/underhentai_details.json";
const PLAYBACK_HOSTS = new Set([
  "krakenfiles.com",
  "luluvdo.com",
  "lulustream.com",
  "gupload.xyz",
  "hentaiplayer.com"
]);

function isSupportedEmbed(value) {
  try {
    const host = new URL(String(value || "")).hostname.toLowerCase().replace(/^www\./, "");
    return PLAYBACK_HOSTS.has(host);
  } catch {
    return false;
  }
}

function hasPlayableRoute(item) {
  return Array.isArray(item?.episodes) && item.episodes.some((episode) =>
    Array.isArray(episode?.sourceOptions) && episode.sourceOptions.some((source) =>
      Array.isArray(source?.embeds) && source.embeds.some(isSupportedEmbed)
    )
  );
}

function hasPlayableEpisode(episode) {
  return Array.isArray(episode?.sourceOptions) && episode.sourceOptions.some((source) =>
    source?.watchUrl && Array.isArray(source?.embeds) && source.embeds.some(isSupportedEmbed)
  );
}

function hasPlayableRelease(source) {
  return source?.watchUrl && Array.isArray(source?.embeds) && source.embeds.some(isSupportedEmbed);
}

function isPlaceholderArtwork(value = "") {
  try {
    const pathname = new URL(String(value || "")).pathname.toLowerCase();
    return pathname.endsWith("/no_image_p.jpg")
      || pathname.includes("/themes/")
      || pathname.includes("/logo");
  } catch {
    return true;
  }
}

function hasTitlePoster(item) {
  const artwork = String(item?.mainWallpaper || item?.image || item?.poster || item?.images?.poster || "").trim();
  if (!artwork) return false;
  return !isPlaceholderArtwork(artwork);
}

function hasTitleBackground(item) {
  const artwork = String(item?.highQualityBackground || item?.adultBackground || item?.backdrop || item?.banner || item?.images?.backdrop || "").trim();
  if (!artwork) return false;
  return !isPlaceholderArtwork(artwork);
}

function hasEpisodeGallery(episode) {
  return Array.isArray(episode?.screenshots) && episode.screenshots.some((value) => {
    try {
      return /^https?:$/i.test(new URL(String(value || "")).protocol);
    } catch {
      return false;
    }
  });
}

const [catalog, details] = await Promise.all([
  readFile(CATALOG, "utf8").then(JSON.parse),
  readFile(DETAILS, "utf8").then(JSON.parse)
]);

const catalogItems = Array.isArray(catalog.items) ? catalog.items : [];
const detailsBySlug = new Map((Array.isArray(details.items) ? details.items : [])
  .filter((item) => item?.slug)
  .map((item) => [item.slug, item]));
const missingDetails = [];
const missingPlayback = [];
const incompleteDetails = [];
const missingEpisodePlayback = [];
const missingReleasePlayback = [];
const invalidPosters = [];
const invalidBackgrounds = [];
const missingGallery = [];
let episodeCount = 0;
let releaseCount = 0;

for (const item of catalogItems) {
  if (!hasTitlePoster(item)) invalidPosters.push(item.slug);
  if (!hasTitleBackground(item)) invalidBackgrounds.push(item.slug);
  const detail = detailsBySlug.get(item.slug);
  if (!detail) {
    missingDetails.push(item.slug);
    continue;
  }
  if (!hasTitlePoster(detail)) invalidPosters.push(`${item.slug} details`);
  if (!hasTitleBackground(detail)) invalidBackgrounds.push(`${item.slug} details`);
  const expectedEpisodes = Math.max(1, Number(item.episodeCount || detail.episodeCount || 0));
  const expectedReleases = Math.max(1, Number(item.releaseCount || detail.releaseCount || 0));
  const episodes = Array.isArray(detail.episodes) ? detail.episodes : [];
  const actualReleases = episodes.reduce((count, episode) =>
    count + (Array.isArray(episode.sourceOptions) ? episode.sourceOptions.length : 0), 0);
  episodeCount += episodes.length;
  releaseCount += actualReleases;
  if (episodes.length < expectedEpisodes || actualReleases < expectedReleases) {
    incompleteDetails.push(`${item.slug} episodes ${episodes.length}/${expectedEpisodes}, releases ${actualReleases}/${expectedReleases}`);
  }
  for (const episode of episodes) {
    const episodeNumber = Number(episode.number || episode.episode || 0) || "?";
    if (!hasPlayableEpisode(episode)) {
      missingEpisodePlayback.push(`${item.slug}#${episodeNumber}`);
    }
    if (!hasEpisodeGallery(episode)) {
      missingGallery.push(`${item.slug}#${episodeNumber}`);
    }
    (Array.isArray(episode.sourceOptions) ? episode.sourceOptions : []).forEach((source, index) => {
      if (!hasPlayableRelease(source)) {
        missingReleasePlayback.push(`${item.slug}#${episodeNumber}r${source.releaseIndex ?? index}`);
      }
    });
  }
  if (!hasPlayableRoute(detail)) {
    missingPlayback.push(item.slug);
  }
}

if (!catalogItems.length) throw new Error("Adult catalog is empty.");
if (missingDetails.length || incompleteDetails.length || missingPlayback.length || missingEpisodePlayback.length || missingReleasePlayback.length || invalidPosters.length || invalidBackgrounds.length || missingGallery.length) {
  const examples = [
    missingDetails.length ? `missing details: ${missingDetails.slice(0, 8).join(", ")}` : "",
    incompleteDetails.length ? `incomplete details: ${incompleteDetails.slice(0, 8).join(", ")}` : "",
    missingPlayback.length ? `missing playback: ${missingPlayback.slice(0, 8).join(", ")}` : "",
    missingEpisodePlayback.length ? `missing episode playback: ${missingEpisodePlayback.slice(0, 8).join(", ")}` : "",
    missingReleasePlayback.length ? `missing release playback: ${missingReleasePlayback.slice(0, 8).join(", ")}` : "",
    invalidPosters.length ? `invalid posters: ${invalidPosters.slice(0, 8).join(", ")}` : "",
    invalidBackgrounds.length ? `invalid backgrounds: ${invalidBackgrounds.slice(0, 8).join(", ")}` : "",
    missingGallery.length ? `missing gallery: ${missingGallery.slice(0, 8).join(", ")}` : ""
  ].filter(Boolean).join("; ");
  throw new Error(`Adult catalog verification failed (${examples}).`);
}

console.log(`Verified playable details, artwork, backgrounds, and galleries for all ${catalogItems.length} adult titles, ${episodeCount} episodes, and ${releaseCount} release routes.`);
