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

for (const item of catalogItems) {
  const detail = detailsBySlug.get(item.slug);
  if (!detail) {
    missingDetails.push(item.slug);
  } else if (!hasPlayableRoute(detail)) {
    missingPlayback.push(item.slug);
  }
}

if (!catalogItems.length) throw new Error("Adult catalog is empty.");
if (missingDetails.length || missingPlayback.length) {
  const examples = [
    missingDetails.length ? `missing details: ${missingDetails.slice(0, 8).join(", ")}` : "",
    missingPlayback.length ? `missing playback: ${missingPlayback.slice(0, 8).join(", ")}` : ""
  ].filter(Boolean).join("; ");
  throw new Error(`Adult catalog verification failed (${examples}).`);
}

console.log(`Verified a supported in-app playback route for all ${catalogItems.length} adult titles.`);
