import { readFile } from "node:fs/promises";

const baseUrl = String(process.env.AUDIT_BASE_URL || "http://localhost:4173").replace(/\/$/, "");
const concurrency = Math.max(1, Math.min(24, Number(process.env.AUDIT_CONCURRENCY || 10)));
const timeoutMs = Math.max(5000, Number(process.env.AUDIT_TIMEOUT_MS || 20000));
const auditAllReleases = process.env.AUDIT_ALL_RELEASES !== "0";
const details = JSON.parse(await readFile("scraper/underhentai_details.json", "utf8"));
const titles = Array.isArray(details.items) ? details.items : [];
const unavailableReleases = [];
const episodesWithoutPlayback = [];
let nextTitle = 0;
let checkedTitles = 0;
let checkedEpisodes = 0;
let checkedReleases = 0;
let galleryEpisodes = 0;

async function checkRelease(title, episode, source, releaseIndex) {
  const endpoint = new URL("/api/adult/underhentai/stream", baseUrl);
  endpoint.searchParams.set("slug", title.slug);
  endpoint.searchParams.set("episode", String(episode.number || episode.episode));
  endpoint.searchParams.set("release", String(source.releaseIndex ?? releaseIndex));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 429 && attempt < 2) {
        const retryAfterMs = Math.max(1000, Number(response.headers.get("retry-after") || payload.retryAfterSeconds || 1) * 1000);
        await new Promise((resolve) => setTimeout(resolve, retryAfterMs + Math.floor(Math.random() * 500)));
        continue;
      }
      const directSources = (Array.isArray(payload.sourceOptions) ? payload.sourceOptions : [])
        .filter((option) => option?.type === "direct" && option.videoUrl);
      if (!response.ok || payload.ok !== true || !directSources.length) {
        unavailableReleases.push({
          slug: title.slug,
          episode: episode.number || episode.episode,
          release: source.releaseIndex ?? releaseIndex,
          status: response.status,
          error: payload.error || "No verified direct source"
        });
        checkedReleases += 1;
        return false;
      }
      checkedReleases += 1;
      return true;
    } catch (error) {
      if (attempt < 2) continue;
      unavailableReleases.push({
        slug: title.slug,
        episode: episode.number || episode.episode,
        release: source.releaseIndex ?? releaseIndex,
        status: 0,
        error: error.message
      });
      checkedReleases += 1;
      return false;
    }
  }
  checkedReleases += 1;
  return false;
}

async function checkTitle(title) {
  for (const episode of title.episodes || []) {
    checkedEpisodes += 1;
    if (Array.isArray(episode.screenshots) && episode.screenshots.some(Boolean)) galleryEpisodes += 1;
    const sources = Array.isArray(episode.sourceOptions) ? episode.sourceOptions : [];
    if (!sources.length) {
      episodesWithoutPlayback.push({ slug: title.slug, episode: episode.number || episode.episode, error: "No release routes" });
      continue;
    }
    let episodePlayable = false;
    for (let index = 0; index < sources.length; index += 1) {
      if (await checkRelease(title, episode, sources[index], index)) {
        episodePlayable = true;
        if (!auditAllReleases) break;
      }
    }
    if (!episodePlayable) {
      episodesWithoutPlayback.push({
        slug: title.slug,
        episode: episode.number || episode.episode,
        error: "Every release route failed"
      });
    }
  }
  checkedTitles += 1;
  if (checkedTitles % 25 === 0 || checkedTitles === titles.length) {
    console.log(`Checked ${checkedTitles}/${titles.length} titles and ${checkedReleases} releases`);
  }
}

async function worker() {
  while (nextTitle < titles.length) {
    const index = nextTitle;
    nextTitle += 1;
    await checkTitle(titles[index]);
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));

console.log(JSON.stringify({
  baseUrl,
  titles: checkedTitles,
  episodes: checkedEpisodes,
  releases: checkedReleases,
  episodesWithGallery: galleryEpisodes,
  unavailableReleases: unavailableReleases.length,
  episodesWithoutPlayback: episodesWithoutPlayback.length
}, null, 2));

if (episodesWithoutPlayback.length) {
  console.error(JSON.stringify(episodesWithoutPlayback.slice(0, 50), null, 2));
  process.exitCode = 1;
}
