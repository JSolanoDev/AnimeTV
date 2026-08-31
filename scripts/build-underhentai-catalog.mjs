import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const BASE_URL = "https://www.underhentai.net";
const SITEMAP_INDEX_URL = `${BASE_URL}/sitemap.xml`;
const DEFAULT_TITLE_ARTWORK = "https://static.underhentai.net/themes/undernet-bs5/assets/images/no_image_p.jpg";
const OUTPUT = resolve("scraper", "underhentai_catalog.json");
const DETAILS_FALLBACK = resolve("scraper", "underhentai_details.json");
const ANDROID_OUTPUT = resolve("android", "app", "src", "main", "assets", "scraper", "underhentai_catalog.json");
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.UNDERHENTAI_CRAWL_CONCURRENCY || 2)));
const REQUEST_INTERVAL_MS = Math.max(250, Number(process.env.UNDERHENTAI_REQUEST_INTERVAL_MS || 550));
const RECENT_DETAIL_LIMIT = Math.max(12, Math.min(120, Number(process.env.UNDERHENTAI_RECENT_DETAIL_LIMIT || 24)));
const EXCLUDED_RECHECK_LIMIT = Math.max(0, Math.min(1200, Number(process.env.UNDERHENTAI_EXCLUDED_RECHECK_LIMIT || 48)));
const USER_AGENT = "Mozilla/5.0 (compatible; ZenkaiTVAdultCatalog/1.0)";
const UNSAFE_MINOR_MARKERS = [
  "child", "children", "elementary", "junior high", "loli", "lolicon",
  "middle school", "minor", "schoolboy", "schoolgirl", "shota", "shotacon",
  "teen", "teenage", "underage", "young boy", "young girl",
  "high school", "joshi kousei", "joshi kosei", "gakuen", "kodomo",
  "shojo", "shoujo", "shonen", "shounen"
];
const UNSAFE_MINOR_PATTERNS = [/\bjk\b/i];

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

function isTitleArtworkUrl(value = "") {
  try {
    const url = new URL(decodeHtml(value), BASE_URL);
    const pathname = url.pathname.toLowerCase();
    if (pathname.endsWith("/no_image_p.jpg")) return true;
    return url.hostname.toLowerCase() === "static.underhentai.net"
      && (pathname.startsWith("/assets/") || pathname.startsWith("/uploads/"))
      && /\.(?:avif|jpe?g|png|webp)$/.test(pathname)
      && !pathname.includes("/themes/");
  } catch {
    return false;
  }
}

function normalizeSafetyText(value = "") {
  const confusables = {
    "а": "a", "е": "e", "і": "i", "ј": "j", "к": "k", "м": "m",
    "о": "o", "р": "p", "с": "c", "т": "t", "у": "y", "х": "x",
    "α": "a", "β": "b", "ε": "e", "η": "h", "ι": "i", "κ": "k",
    "μ": "m", "ν": "n", "ο": "o", "ρ": "p", "τ": "t", "χ": "x"
  };
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[аеіјкморстухαβεηικμνορτχ]/g, (character) => confusables[character] || character)
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSafeAdultMetadata(item = {}) {
  return !adultSafetyMarker(item);
}

function adultSafetyMarker(item = {}) {
  const title = normalizeSafetyText(item.title || "");
  const description = normalizeSafetyText(item.description || "");
  const genres = (item.genres || []).map((genre) => normalizeSafetyText(genre));
  const tags = (item.tags || []).map((tag) => normalizeSafetyText(tag));
  const allText = [title, description, ...genres, ...tags].join(" ");
  if (!allText) return "";
  const matches = [];
  for (const marker of UNSAFE_MINOR_MARKERS) {
    if (new RegExp(`\\b${marker}\\b`, "i").test(allText)) {
      matches.push(marker);
    }
  }
  for (const pattern of UNSAFE_MINOR_PATTERNS) {
    if (pattern.test(allText)) {
      matches.push("jk");
    }
  }
  return matches.length ? matches[0] : "";
}

function currentMetaRow(html = "", label = "") {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<([a-z0-9]+)\\b[^>]*class\\s*=\\s*(?:"[^"]*\\brow-label\\b[^"]*"|'[^']*\\brow-label\\b[^']*')[^>]*>\\s*${escaped}\\s*<\\/\\1>`
      + `[\\s\\S]*?<([a-z0-9]+)\\b[^>]*class\\s*=\\s*(?:"[^"]*\\brow-value\\b[^"]*"|'[^']*\\brow-value\\b[^']*')[^>]*>([\\s\\S]*?)<\\/\\2>`,
    "i"
  );
  return stripHtml(html.match(pattern)?.[3] || "");
}

let nextRequestAt = 0;
async function waitForRequestSlot() {
  const scheduledAt = Math.max(Date.now(), nextRequestAt);
  nextRequestAt = scheduledAt + REQUEST_INTERVAL_MS;
  const delay = scheduledAt - Date.now();
  if (delay > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
}

async function fetchText(url, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await waitForRequestSlot();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 18000);
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
          Connection: "close"
        },
        redirect: "follow",
        signal: controller.signal
      });
      if (response.ok) return await response.text();
      lastError = new Error(`${response.status} ${response.statusText}`);
      const retryAfter = Number(response.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(retryAfter * 1000, 30000)));
      }
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1200 * (attempt + 1)));
  }
  throw lastError || new Error(`Could not fetch ${url}`);
}

async function mapConcurrent(items, worker) {
  const result = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, Math.max(1, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        result[index] = await worker(items[index], index);
      } catch (error) {
        console.warn(`Skipping ${items[index]?.url || `item ${index}`}: ${error.message}`);
        result[index] = null;
      }
    }
  });
  await Promise.all(runners);
  return result;
}

function parseListing(html, page) {
  const items = [];
  for (const match of String(html).matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)) {
    const block = match[1];
    const heading = block.match(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/i);
    const linkTag = block.match(/<a\b[^>]*href\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>[\s\S]*?<h[23]\b/i)?.[0]
      || block.match(/<h[23]\b[^>]*>[\s\S]*?<a\b[^>]*href\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>/i)?.[0]
      || block.match(/<a\b[^>]*href\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>/i)?.[0];
    const title = stripHtml(heading?.[1] || "");
    const href = attr(linkTag, "href");
    const image = [...block.matchAll(/<img\b[^>]*>/gi)]
      .map((imageMatch) => attr(imageMatch[0], "src") || attr(imageMatch[0], "data-src"))
      .find(isTitleArtworkUrl) || "";
    if (!title || !href) continue;
    try {
      const url = new URL(href, BASE_URL);
      if (!["underhentai.net", "www.underhentai.net"].includes(url.hostname.toLowerCase())) continue;
      const slug = url.pathname.split("/").filter(Boolean).pop() || "";
      if (slug) items.push({ slug, title, url: url.toString(), image, page });
    } catch { /* malformed listing link */ }
  }
  return items;
}

function sitemapLocations(xml = "") {
  return [...String(xml).matchAll(/<loc>([\s\S]*?)<\/loc>/gi)]
    .map((match) => decodeHtml(match[1]).trim())
    .filter(Boolean);
}

async function loadSitemapListings() {
  try {
    const sitemapHtml = await fetchText(SITEMAP_INDEX_URL);
    const postSitemaps = sitemapLocations(sitemapHtml).filter((url) => /\/post-sitemap\d*\.xml(?:\?|$)/i.test(url));
    const documents = await Promise.allSettled(postSitemaps.map((url) => fetchText(url)));
    const listings = [];
    const seen = new Set();
    for (const result of documents) {
      if (result.status !== "fulfilled") continue;
      for (const value of sitemapLocations(result.value)) {
        try {
          const url = new URL(value, BASE_URL);
          const parts = url.pathname.split("/").filter(Boolean);
          if (!["underhentai.net", "www.underhentai.net"].includes(url.hostname.toLowerCase()) || parts.length !== 1) continue;
          const slug = parts[0].toLowerCase();
          if (!slug || seen.has(slug)) continue;
          seen.add(slug);
          listings.push({ slug, title: slug.replace(/[-_]+/g, " "), url: url.toString(), image: "", page: 0, discoveredFrom: "sitemap" });
        } catch { /* malformed sitemap entry */ }
      }
    }
    return listings;
  } catch (error) {
    console.warn(`Sitemap discovery unavailable: ${error.message}`);
    return [];
  }
}

function extractMetadata(html, item) {
  const genreBlock = html.match(/<p>\s*Genres\s*<\/p>([\s\S]*?)<\/div>/i)?.[1] || "";
  const currentGenreBlock = html.match(/class\s*=\s*(?:"[^"]*\brow-tags\b[^"]*"|'[^']*\brow-tags\b[^']*')[^>]*>[\s\S]*?<ul\b[^>]*class\s*=\s*(?:"[^"]*\btags-list\b[^"]*"|'[^']*\btags-list\b[^']*')[^>]*>([\s\S]*?)<\/ul>/i)?.[1] || "";
  const genreSource = currentGenreBlock || genreBlock;
  const genres = [...genreSource.matchAll(/<a\b[^>]*href\s*=\s*(?:"[^"]*\/genre\/[^"]*"|'[^']*\/genre\/[^']*')[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => stripHtml(match[1]))
    .filter((value, index, values) => value && values.indexOf(value) === index);
  const title = stripHtml(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || item.title);
  const currentOfficial = html.match(/class\s*=\s*(?:"[^"]*\bsection-header\b[^"]*"|'[^']*\bsection-header\b[^']*')[^>]*>[\s\S]*?<h1\b[^>]*>[\s\S]*?<\/h1>\s*<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] || "";
  const descriptionBlock = html.match(/class\s*=\s*(?:"[^"]*\brow-desc\b[^"]*"|'[^']*\brow-desc\b[^']*')[^>]*>[\s\S]*?class\s*=\s*(?:"[^"]*\brow-label\b[^"]*"|'[^']*\brow-label\b[^']*')[^>]*>[\s\S]*?<\/div>([\s\S]*?)<\/div>\s*<hr/i)?.[1] || "";
  const originalCover = [...html.matchAll(/<a\b[^>]*class\s*=\s*(?:"[^"]*\bglightbox\b[^"]*"|'[^']*\bglightbox\b[^']*')[^>]*>/gi)]
    .map((match) => attr(match[0], "href"))
    .find(isTitleArtworkUrl) || "";
  const inlineCover = [...html.matchAll(/<img\b[^>]*>/gi)]
    .map((match) => attr(match[0], "src") || attr(match[0], "data-src"))
    .find(isTitleArtworkUrl) || "";
  const cover = normalizeImageUrl(originalCover || inlineCover || item.image || DEFAULT_TITLE_ARTWORK);
  const screenshots = [
    ...[...html.matchAll(/\bdata-src\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)].map((match) => match[1] || match[2] || match[3] || ""),
    ...[...html.matchAll(/https:\/\/static\.underhentai\.net\/thumbs\/[^"'\s<>]+/gi)].map((match) => match[0])
  ].map(normalizeImageUrl).filter((value, index, values) => value && values.indexOf(value) === index);
  const episodeNumbers = [...html.matchAll(/class\s*=\s*(?:"[^"]*\b(?:ep2-header|ep-header)\b[^"]*"|'[^']*\b(?:ep2-header|ep-header)\b[^']*'|(?:ep2-header|ep-header))[^>]*>([\s\S]*?)<\/div>/gi)]
    .map((match) => Number(stripHtml(match[1]).match(/(\d+)/)?.[1] || 0))
    .filter((number) => number > 0);
  const streamCount = [...html.matchAll(/<a\b[^>]*(?:class\s*=\s*(?:"[^"]*\bep2-stream\b[^"]*"|'[^']*\bep2-stream\b[^']*')|href\s*=\s*(?:"[^"]*\/watch\/\?[^"]*"|'[^']*\/watch\/\?[^']*'))[^>]*>/gi)].length;
  const metadata = {
    ...item,
    title,
    officialTitle: stripHtml(currentOfficial),
    description: stripHtml(descriptionBlock),
    aired: currentMetaRow(html, "Aired"),
    brand: currentMetaRow(html, "Brand"),
    genres,
    image: cover,
    mainWallpaper: cover,
    banner: cover,
    screenshots,
    episodeCount: new Set(episodeNumbers).size || (streamCount > 0 ? 1 : 0),
    releaseCount: streamCount,
    metadataCheckedAt: new Date().toISOString()
  };
  metadata.safetyExcluded = !isSafeAdultMetadata(metadata);
  return metadata;
}

async function main() {
  let existing = { items: [] };
  let detailsFallback = { items: [] };
  try { existing = JSON.parse(await readFile(OUTPUT, "utf8")); } catch { /* first build */ }
  try { detailsFallback = JSON.parse(await readFile(DETAILS_FALLBACK, "utf8")); } catch { /* optional */ }
  const existingItems = Array.isArray(existing.items) && existing.items.length
    ? existing.items
    : (Array.isArray(detailsFallback.items) ? detailsFallback.items : []);
  const recoveredFromDetails = !existing.items?.length && existingItems.length > 0;
  const existingBySlug = new Map(existingItems.filter((item) => item?.slug).map((item) => [item.slug, item]));

  const firstHtml = await fetchText(`${BASE_URL}/`);
  const pageNumbers = [...firstHtml.matchAll(/page\/(\d+)\//gi)].map((match) => Number(match[1]));
  const lastPage = Math.max(1, ...pageNumbers);
  const pageUrls = Array.from({ length: lastPage }, (_, index) => index === 0 ? `${BASE_URL}/` : `${BASE_URL}/page/${index + 1}/`);
  const [pages, sitemapItems] = await Promise.all([
    mapConcurrent(pageUrls, async (url, index) => parseListing(await fetchText(url), index + 1)),
    loadSitemapListings()
  ]);
  const seen = new Set();
  const listed = [...pages.flat(), ...sitemapItems]
    .filter((item) => item.slug && !seen.has(item.slug) && seen.add(item.slug))
    .map((item, sourceOrder) => ({ ...item, sourceOrder }));
  console.log(`Found ${listed.length} title pages across ${lastPage} listing pages and ${sitemapItems.length} sitemap entries.`);
  if (!listed.length) {
    throw new Error("Catalog discovery returned zero titles; preserving the last verified snapshot.");
  }

  const explicitExcluded = new Set(Array.isArray(existing.excludedSlugs) ? existing.excludedSlugs : []);
  const knownExcluded = explicitExcluded.size
    ? explicitExcluded
    : recoveredFromDetails
      ? new Set(listed.filter((item) => !existingBySlug.has(item.slug)).map((item) => item.slug))
      : new Set();
  const mergedListings = listed.map((listedItem) => {
    const previous = existingBySlug.get(listedItem.slug) || {};
    const listingArtwork = isTitleArtworkUrl(listedItem.image) ? normalizeImageUrl(listedItem.image) : "";
    const previousCandidate = String(previous.mainWallpaper || previous.image || "").trim();
    const previousArtwork = isTitleArtworkUrl(previousCandidate) ? normalizeImageUrl(previousCandidate) : "";
    const titleArtwork = listingArtwork || previousArtwork || DEFAULT_TITLE_ARTWORK;
    return {
      ...previous,
      ...listedItem,
      image: titleArtwork,
      mainWallpaper: titleArtwork,
      banner: titleArtwork
    };
  });

  const excludedCandidates = mergedListings.filter((item) => knownExcluded.has(item.slug));
  const recheckStart = excludedCandidates.length
    ? (Math.floor(Date.now() / 86400000) * Math.max(1, EXCLUDED_RECHECK_LIMIT)) % excludedCandidates.length
    : 0;
  const excludedRechecks = new Set(Array.from(
    { length: Math.min(EXCLUDED_RECHECK_LIMIT, excludedCandidates.length) },
    (_, offset) => excludedCandidates[(recheckStart + offset) % excludedCandidates.length]?.slug
  ).filter(Boolean));
  const metadataTargets = mergedListings.filter((item) => (
    item.sourceOrder < RECENT_DETAIL_LIMIT
    || (!existingBySlug.has(item.slug) && !knownExcluded.has(item.slug))
    || (existingBySlug.has(item.slug) && !Number(item.episodeCount))
    || excludedRechecks.has(item.slug)
  ));
  console.log(`Refreshing ${metadataTargets.length} new, recent, or previously excluded title pages.`);
  const enriched = await mapConcurrent(metadataTargets, async (item) => extractMetadata(await fetchText(item.url), item));
  const freshBySlug = new Map(enriched.filter(Boolean).map((item) => [item.slug, item]));
  const resolvedItems = mergedListings.map((item) => freshBySlug.get(item.slug) || item);
  const safeItems = [];
  const safetyExcluded = [];
  const incompleteMetadata = [];
  for (const item of resolvedItems) {
    if (!item?.slug) continue;
    const refreshed = freshBySlug.has(item.slug);
    const verified = Boolean(item.metadataCheckedAt || Number(item.episodeCount) > 0 || item.officialTitle || item.brand || item.aired || item.description || item.genres?.length);
    const blocked = item.safetyExcluded === true
      || (verified && !isSafeAdultMetadata(item))
      || (!refreshed && knownExcluded.has(item.slug));
    if (blocked) safetyExcluded.push(item);
    else if (verified && Number(item.episodeCount) > 0) safeItems.push({ ...item, safetyExcluded: false });
    else incompleteMetadata.push(item);
  }
  if (!safeItems.length && existingItems.length) {
    throw new Error("Refresh produced zero verified titles; preserving the last verified snapshot.");
  }

  const safeSlugs = new Set(safeItems.map((item) => item.slug));
  const safetyBySlug = new Map(safetyExcluded.map((item) => [item.slug, item]));
  const exclusions = listed.filter((item) => !safeSlugs.has(item.slug)).map((item) => ({
    slug: item.slug,
    reason: safetyBySlug.has(item.slug) || knownExcluded.has(item.slug) ? "safety" : "metadata-unavailable",
    ...((safetyBySlug.has(item.slug) || knownExcluded.has(item.slug))
      ? { marker: adultSafetyMarker(safetyBySlug.get(item.slug) || {}) || "review-required" }
      : {})
  }));
  const catalogItems = safeItems.map((item) => {
    const { episodes, ...catalogItem } = item;
    return {
      ...catalogItem,
      episodeCount: Math.max(Number(catalogItem.episodeCount || 0), Array.isArray(episodes) ? episodes.length : 0),
      releaseCount: Math.max(
        Number(catalogItem.releaseCount || 0),
        Array.isArray(episodes)
          ? episodes.reduce((sum, episode) => sum + Number(episode?.sourceOptions?.length || 0), 0)
          : 0
      )
    };
  });

  const payload = {
    source: "UnderHentai",
    generatedAt: new Date().toISOString(),
    totalFound: listed.length,
    listingPageCount: lastPage,
    sitemapCount: sitemapItems.length,
    eligibleTitleCount: safeItems.length,
    excludedForSafety: safetyExcluded.length,
    incompleteMetadataCount: incompleteMetadata.length,
    exclusions,
    excludedSlugs: exclusions.map((item) => item.slug),
    items: catalogItems
  };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  await Promise.all([OUTPUT, ANDROID_OUTPUT].map(async (output) => {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, serialized, "utf8");
  }));
  console.log(
    `Saved ${safeItems.length} verified-adult titles; `
    + `${safetyExcluded.length} safety exclusions; ${incompleteMetadata.length} metadata retries pending.`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
