import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const BASE_URL = "https://www.underhentai.net";
const CATALOG = resolve("scraper", "underhentai_catalog.json");
const OUTPUT = resolve("scraper", "underhentai_details.json");
const TITLE_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.UNDERHENTAI_DETAIL_CONCURRENCY || 2)));
const WATCH_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.UNDERHENTAI_WATCH_CONCURRENCY || 2)));
const REQUEST_INTERVAL_MS = Math.max(250, Number(process.env.UNDERHENTAI_REQUEST_INTERVAL_MS || 550));
const USER_AGENT = "Mozilla/5.0 (compatible; ZenkaiTVAdultCatalog/1.0)";
const ALLOWED_EMBED_HOSTS = new Set([
  "krakenfiles.com", "www.krakenfiles.com",
  "luluvdo.com", "www.luluvdo.com",
  "lulustream.com", "www.lulustream.com",
  "gupload.xyz", "www.gupload.xyz",
  "hentaiplayer.com", "www.hentaiplayer.com"
]);

function decodeHtml(value = "") {
  return String(value)
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function stripHtml(value = "") {
  return decodeHtml(String(value).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function attr(tag = "", name = "") {
  const match = String(tag).match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return decodeHtml(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
}

function normalizeImageUrl(value = "") {
  if (!value) return "";
  const url = new URL(value, BASE_URL);
  const pageSpeedMatch = url.pathname.match(/^(.*\/)x?([^/,]+\.(?:jpe?g|png|webp|avif)),[^/]*\.pagespeed\.[^/]+$/i);
  if (pageSpeedMatch) {
    url.pathname = `${pageSpeedMatch[1]}${pageSpeedMatch[2]}`;
  } else {
    const wasPageSpeed = /\.pagespeed\./i.test(url.pathname);
    const path = url.pathname.replace(/\.pagespeed\.[^/]+$/i, "");
    let file = path.split("/").pop() || "";
    file = file.replace(/^\d+x\d+x/i, "");
    if (wasPageSpeed && /^x(?=\d)/i.test(file)) file = file.slice(1);
    url.pathname = `${path.slice(0, Math.max(0, path.lastIndexOf("/") + 1))}${file}`;
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function fetchText(url, attempts = 3) {
  let lastError;
  let retryAfterMs = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await waitForRequestSlot();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
          Referer: BASE_URL
        },
        redirect: "follow",
        signal: controller.signal
      });
      if (response.ok) return await response.text();
      lastError = new Error(`${response.status} ${response.statusText}`);
      const retryAfter = Number(response.headers.get("retry-after"));
      retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    const backoff = Math.max(retryAfterMs, 1200 * (attempt + 1));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, backoff));
  }
  throw lastError || new Error(`Could not fetch ${url}`);
}

let nextRequestAt = 0;
async function waitForRequestSlot() {
  const scheduledAt = Math.max(Date.now(), nextRequestAt);
  nextRequestAt = scheduledAt + REQUEST_INTERVAL_MS;
  const delay = scheduledAt - Date.now();
  if (delay > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
}

async function mapConcurrent(items, concurrency, worker, label) {
  const result = new Array(items.length);
  let next = 0;
  let completed = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        result[index] = await worker(items[index], index);
      } catch (error) {
        console.warn(`${label} failed for ${items[index]?.url || items[index]?.watchUrl || index}: ${error.message}`);
        result[index] = null;
      }
      completed += 1;
      if (completed % 50 === 0 || completed === items.length) {
        console.log(`${label} ${completed}/${items.length}`);
      }
    }
  });
  await Promise.all(runners);
  return result;
}

function parseTitlePage(html, catalogItem) {
  const originalCover = [...html.matchAll(/<a\b[^>]*class\s*=\s*(?:"[^"]*\bglightbox\b[^"]*"|'[^']*\bglightbox\b[^']*')[^>]*>/gi)]
    .map((match) => attr(match[0], "href"))
    .find((value) => /static\.underhentai\.net\/assets\/images\//i.test(value)) || "";
  const image = normalizeImageUrl(originalCover || catalogItem.image || "");
  const sectionMatches = [...html.matchAll(/class\s*=\s*(?:"[^"]*\b(?:ep2-header|ep-header)\b[^"]*"|'[^']*\b(?:ep2-header|ep-header)\b[^']*'|(?:ep2-header|ep-header))[^>]*>([\s\S]*?)<\/div>/gi)];
  const episodes = sectionMatches.map((header, sectionIndex) => {
    const number = Number(stripHtml(header[1]).match(/(\d+)/)?.[1] || sectionIndex + 1);
    const sectionStart = header.index + header[0].length;
    const sectionEnd = sectionMatches[sectionIndex + 1]?.index ?? html.length;
    const section = html.slice(sectionStart, sectionEnd);
    const screenshots = [
      ...[...section.matchAll(/\bdata-src\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)].map((match) => match[1] || match[2] || match[3] || ""),
      ...[...section.matchAll(/https:\/\/static\.underhentai\.net\/thumbs\/[^"'\s<>]+/gi)].map((match) => match[0])
    ].map(normalizeImageUrl).filter((value, index, values) => value && values.indexOf(value) === index);
    const streamTags = [...section.matchAll(/<a\b[^>]*>/gi)].filter((stream) => {
      const className = attr(stream[0], "class");
      const href = attr(stream[0], "href");
      return /\bep2-stream\b/i.test(className) || /\/watch\/\?/i.test(href);
    });
    const sourceOptions = streamTags.map((stream, releaseIndex) => {
      const before = section.slice(0, stream.index);
      const cardStart = Math.max(
        before.lastIndexOf('class="ep2-card'),
        before.lastIndexOf("class='ep2-card"),
        before.lastIndexOf("class=ep2-card"),
        before.lastIndexOf('class="variant-header'),
        before.lastIndexOf("class='variant-header")
      );
      const card = before.slice(Math.max(0, cardStart));
      const variant = stripHtml(
        card.match(/class\s*=\s*(?:"ep2-vtype"|'ep2-vtype'|ep2-vtype)[^>]*>(?:\s*<span\b[^>]*>[\s\S]*?<\/span>)?\s*([^<]+)/i)?.[1]
        || card.match(/class\s*=\s*(?:"[^"]*\bvariant-label\b[^"]*"|'[^']*\bvariant-label\b[^']*')[^>]*>([\s\S]*?)<\//i)?.[1]
        || "Stream"
      );
      const metadata = {};
      for (const pair of card.matchAll(/<(span|div)\b[^>]*class\s*=\s*(?:"[^"]*\b(?:ep2-meta-label|meta-label)\b[^"]*"|'[^']*\b(?:ep2-meta-label|meta-label)\b[^']*')[^>]*>([\s\S]*?)<\/\1>\s*<(span|div)\b[^>]*class\s*=\s*(?:"[^"]*\b(?:ep2-meta-value|meta-value)\b[^"]*"|'[^']*\b(?:ep2-meta-value|meta-value)\b[^']*')[^>]*>([\s\S]*?)<\/\3>/gi)) {
        metadata[stripHtml(pair[2]).toLowerCase()] = stripHtml(pair[4]).replace(/^[^A-Za-z0-9]+/, "");
      }
      const watchUrl = new URL(attr(stream[0], "href"), catalogItem.url).toString();
      return {
        releaseIndex,
        label: [variant, metadata.subs, metadata.audio].filter(Boolean).join(" · ") || `Stream ${releaseIndex + 1}`,
        variant,
        format: metadata.format || "",
        size: metadata.size || "",
        subtitles: metadata.subs || "",
        audio: metadata.audio || "",
        watchUrl,
        embeds: []
      };
    });
    return {
      episode: number,
      number,
      title: `Episode ${number}`,
      image: screenshots[0] || catalogItem.banner || image,
      screenshots,
      sourceOptions,
      locked: !sourceOptions.length
    };
  });

  const screenshots = [...new Set(episodes.flatMap((episode) => episode.screenshots || []))];
  return {
    ...catalogItem,
    image,
    mainWallpaper: image,
    banner: image,
    screenshots,
    episodeCount: episodes.length || catalogItem.episodeCount || 0,
    episodes
  };
}

function parseEmbeds(html = "") {
  const embeds = [];
  const candidates = [
    ...[...String(html).matchAll(/<iframe\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)].map((match) => match[1] || match[2] || match[3] || ""),
    ...[...String(html).matchAll(/https:\/\/(?:www\.)?(?:krakenfiles\.com|luluvdo\.com|lulustream\.com|gupload\.xyz|hentaiplayer\.com)\/[^"'\s<>\\]+/gi)].map((match) => match[0])
  ];
  for (const candidate of candidates) {
    try {
      const parsed = new URL(decodeHtml(candidate).replace(/\\\//g, "/"), BASE_URL);
      if (ALLOWED_EMBED_HOSTS.has(parsed.hostname.toLowerCase()) && !embeds.includes(parsed.toString())) {
        embeds.push(parsed.toString());
      }
    } catch {
      // Ignore malformed provider URLs.
    }
  }
  return embeds;
}

function hasPlayableEmbed(sourceOption = {}) {
  return Array.isArray(sourceOption.embeds)
    && sourceOption.embeds.some((embed) => {
      try { return ALLOWED_EMBED_HOSTS.has(new URL(embed).hostname.toLowerCase()); } catch { return false; }
    });
}

async function main() {
  const catalog = JSON.parse(await readFile(CATALOG, "utf8"));
  const items = Array.isArray(catalog.items) ? catalog.items : [];
  let existing = { items: [] };
  try {
    existing = JSON.parse(await readFile(OUTPUT, "utf8"));
  } catch {
    // First build.
  }
  const existingBySlug = new Map((existing.items || []).map((item) => [item.slug, item]));
  const itemsToRefresh = existingBySlug.size === 0
    ? items
    : items.filter((item) => !existingBySlug.has(item.slug) || Number(item.sourceOrder) < 24);
  console.log(`Loading ${itemsToRefresh.length} detail pages for ${items.length} eligible titles.`);

  const parsed = await mapConcurrent(
    itemsToRefresh,
    TITLE_CONCURRENCY,
    async (item) => parseTitlePage(await fetchText(item.url), item),
    "Title pages"
  );
  const parsedBySlug = new Map(parsed.filter(Boolean).map((item) => [item.slug, item]));
  const details = items
    .map((item) => {
      const detail = parsedBySlug.get(item.slug) || existingBySlug.get(item.slug);
      if (!detail) return null;
      const titleArtwork = item.mainWallpaper || item.image || detail.mainWallpaper || detail.image || "";
      return {
        ...detail,
        ...item,
        image: titleArtwork,
        mainWallpaper: titleArtwork,
        banner: titleArtwork
      };
    })
    .filter(Boolean);
  const jobs = [];
  details.forEach((item) => {
    item.episodes.forEach((episode) => {
      episode.sourceOptions.forEach((sourceOption) => {
        if (!Array.isArray(sourceOption.embeds) || !sourceOption.embeds.length) {
          jobs.push({ item, episode, sourceOption });
        }
      });
    });
  });
  console.log(`Resolving embeds for ${jobs.length} release routes.`);

async function resolveKrakenFiles(embedUrl) {
  return null;
}

  await mapConcurrent(
    jobs,
    WATCH_CONCURRENCY,
    async (job) => {
      try {
        const watchHtml = await fetchText(job.sourceOption.watchUrl);
        const embeds = parseEmbeds(watchHtml);
        job.sourceOption.embeds = embeds;
      } catch {
        if (!Array.isArray(job.sourceOption.embeds)) {
          job.sourceOption.embeds = [];
        }
      }
      return job.sourceOption.embeds?.length || 0;
    },
    "Watch pages"
  );

  const allSourceOptions = details.flatMap((item) => item.episodes.flatMap((episode) => episode.sourceOptions));
  const allEpisodes = details.flatMap((item) => item.episodes);
  const payload = {
    source: "UnderHentai",
    generatedAt: new Date().toISOString(),
    catalogGeneratedAt: catalog.generatedAt || null,
    count: details.length,
    releaseCount: allSourceOptions.length,
    playableReleaseCount: allSourceOptions.filter(hasPlayableEmbed).length,
    episodeCount: allEpisodes.length,
    playableEpisodeCount: allEpisodes.filter((episode) => episode.sourceOptions.some(hasPlayableEmbed)).length,
    items: details
  };
  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Saved ${payload.count} titles and ${payload.playableEpisodeCount}/${payload.episodeCount} playable episodes to ${OUTPUT}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
