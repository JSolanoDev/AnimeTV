import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const source = (path) => JSON.parse(readFileSync(new URL(path, root), "utf8"));

function preview(value, limit = 320) {
  const text = String(value || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= limit) return text;
  const cutoff = text.slice(0, limit);
  return `${cutoff.slice(0, cutoff.lastIndexOf(" ") > limit / 2 ? cutoff.lastIndexOf(" ") : limit).trimEnd()}…`;
}

// Keep roughly two weeks of releases so the live latest feed can match titles
// whose baked airing timestamp is a week behind their newly posted episode.
export function buildHomepageBootstrap(catalog, artwork, airing, limit = 96) {
  const artById = artwork?.entries || {};
  const airingById = airing?.entries || {};
  const rows = (catalog?.items || [])
    .filter((row) => row?.id && row?.title && (
      Number(row.sourcePlayableEpisodeCount) > 0 || Number(row.fallbackPlayableEpisodeCount) > 0
    ))
    .sort((a, b) => {
      const recency = (Date.parse(airingById[b.id]?.lastEpisodeAt || "") || 0)
        - (Date.parse(airingById[a.id]?.lastEpisodeAt || "") || 0);
      return recency || String(a.id).localeCompare(String(b.id));
    })
    .slice(0, limit);

  const items = rows.map((row) => {
    const art = artById[row.id] || {};
    const meta = art.meta || {};
    const air = airingById[row.id] || {};
    const episode = Math.max(1, Number(row.episode || row.sourcePlayableEpisodeCount || row.fallbackPlayableEpisodeCount) || 1);
    return {
      id: row.id,
      title: row.title,
      malId: row.malId || meta.malId || art.malId || null,
      anilistId: art.anilistId || air.anilistId || null,
      romajiTitle: meta.romajiTitle || row.title,
      englishTitle: meta.englishTitle || "",
      episode,
      totalEpisodes: Number(row.totalEpisodes) || episode,
      sourceEpisodeCount: row.sourceEpisodeCount ?? null,
      sourcePlayableEpisodeCount: row.sourcePlayableEpisodeCount ?? null,
      sourceEpisodeIds: row.sourceEpisodeIds?.length <= 32 ? row.sourceEpisodeIds : undefined,
      sourceInventoryChecked: Boolean(row.sourceInventoryChecked),
      status: meta.airingStatus || row.status || air.airingStatus || "",
      format: meta.format || row.type || "",
      year: meta.year || row.year || air.seasonYear || "",
      season: air.season || row.season || "",
      seasonYear: air.seasonYear || meta.year || row.year || null,
      genres: meta.genres?.length ? meta.genres : row.genres || [],
      genre: row.genre || "",
      score: meta.score || row.score || null,
      duration: meta.duration || "",
      studios: meta.studio ? [meta.studio] : [],
      countryOfOrigin: meta.country || "",
      description: preview(meta.description || row.description || row.synopsis),
      image: art.tmdbPoster || art.anilistCover || art.metadataCover || row.image || row.poster || "",
      banner: art.anilistBanner || row.banner || "",
      tmdbId: art.tmdbId || null,
      tmdbBackdrop: art.tmdbBackdrop || "",
      tmdbPoster: art.tmdbPoster || "",
      lastEpisodeAt: air.lastEpisodeAt || "",
      nextAiringAt: air.nextAiringAt || null,
      nextAiringEpisodeNumber: air.nextAiringEpisodeNumber || null,
      broadcastDay: air.broadcastDay || "",
      broadcastTime: air.broadcastTime || "",
      broadcastTimezone: air.broadcastTimezone || "",
      franchiseSeasons: air.franchiseSeasons?.length ? air.franchiseSeasons : undefined,
      fallbackProvider: row.fallbackProvider || "",
      fallbackProviderKey: row.fallbackProviderKey || "",
      fallbackProviderAnimeSlug: row.fallbackProviderAnimeSlug || "",
      fallbackEpisodeMap: row.fallbackEpisodeMap || undefined,
      fallbackEpisodeIds: row.fallbackEpisodeIds || undefined,
      fallbackPlayableEpisodeCount: row.fallbackPlayableEpisodeCount ?? null,
      fallbackInventoryChecked: Boolean(row.fallbackInventoryChecked),
      sourceFallbackVerified: Boolean(row.sourceFallbackVerified),
      siteUrl: row.siteUrl || "",
      source: "AnimeAV1"
    };
  });
  const generatedAt = new Date(Math.max(0,
    Date.parse(catalog?.scrapedAt || "") || 0,
    Date.parse(artwork?.generatedAt || "") || 0,
    Date.parse(airing?.generatedAt || "") || 0
  )).toISOString();
  return { ok: true, source: "ZenkaiTV Bootstrap", generatedAt, count: items.length, items };
}

export function writeHomepageBootstrap() {
  const payload = buildHomepageBootstrap(
    source("scraper/anime_metadata.json"),
    source("scraper/artwork-map.json"),
    source("scraper/airing-map.json")
  );
  if (!payload.items.length) throw new Error("Cannot build a homepage without playable catalog rows");
  const path = new URL("homepage-bootstrap.json", root);
  const content = `${JSON.stringify(payload)}\n`;
  if (readFileSync(path, "utf8") !== content) writeFileSync(path, content);
  return payload;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const payload = writeHomepageBootstrap();
  console.log(`Updated homepage bootstrap: ${payload.count} releases as of ${payload.generatedAt}`);
}
