import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const BASE_URL = "https://www.underhentai.net";
const OUTPUT = resolve("scraper", "underhentai_catalog.json");
const CONCURRENCY = Math.max(2, Math.min(16, Number(process.env.UNDERHENTAI_CRAWL_CONCURRENCY || 8)));
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
  const searchable = normalizeSafetyText([
    item.title,
    item.officialTitle,
    item.description,
    ...(Array.isArray(item.genres) ? item.genres : [])
  ].filter(Boolean).join(" "));
  const padded = ` ${searchable} `;
  if (UNSAFE_MINOR_MARKERS.some((marker) => padded.includes(` ${normalizeSafetyText(marker)} `))) return false;
  return !UNSAFE_MINOR_PATTERNS.some((pattern) => pattern.test(searchable));
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

async function fetchText(url, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 18000);
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
        signal: controller.signal
      });
      if (response.ok) return await response.text();
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500 * (attempt + 1)));
  }
  throw lastError || new Error(`Could not fetch ${url}`);
}

function parseListing(html, page) {
  const items = [];
  const articlePattern = /<article\b[^>]*>([\s\S]*?)<\/article>/gi;
  for (const match of html.matchAll(articlePattern)) {
    const block = match[1];
    const heading = block.match(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/i);
    const linkTag = block.match(/<a\b[^>]*href\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>[\s\S]*?<h[23]\b/i)?.[0]
      || block.match(/<h[23]\b[^>]*>[\s\S]*?<a\b[^>]*href\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>/i)?.[0]
      || block.match(/<a\b[^>]*href\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>/i)?.[0];
    const title = stripHtml(heading?.[1] || "");
    const href = attr(linkTag, "href");
    const imgTag = block.match(/<img\b[^>]*>/i)?.[0] || "";
    const image = normalizeImageUrl(attr(imgTag, "src"));
    if (!title || !href) continue;
    const url = new URL(href, BASE_URL).toString();
    const parsedUrl = new URL(url);
    if (!["underhentai.net", "www.underhentai.net"].includes(parsedUrl.hostname.toLowerCase())) continue;
    const slug = parsedUrl.pathname.split("/").filter(Boolean).pop() || "";
    if (!slug) continue;
    items.push({ slug, title, url, image, page });
  }
  return items;
}

function extractMetadata(html, item) {
  const genreBlock = html.match(/<p>\s*Genres\s*<\/p>([\s\S]*?)<\/div>/i)?.[1] || "";
  const currentGenreBlock = html.match(/class\s*=\s*(?:"[^"]*\brow-tags\b[^"]*"|'[^']*\brow-tags\b[^']*')[^>]*>[\s\S]*?<ul\b[^>]*class\s*=\s*(?:"[^"]*\btags-list\b[^"]*"|'[^']*\btags-list\b[^']*')[^>]*>([\s\S]*?)<\/ul>/i)?.[1] || "";
  const genreSource = genreBlock || currentGenreBlock;
  const genres = [...genreSource.matchAll(/<a\b[^>]*href\s*=\s*(?:"[^"]*\/genre\/[^"]*"|'[^']*\/genre\/[^']*')[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => stripHtml(match[1]))
    .filter((value, index, values) => value && values.indexOf(value) === index);
  const titleMatch = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const officialBlock = html.match(/<p>\s*Official Title\s*<\/p>([\s\S]*?)<\/div>/i)?.[1] || "";
  const currentOfficial = html.match(/class\s*=\s*(?:"[^"]*\bsection-header\b[^"]*"|'[^']*\bsection-header\b[^']*')[^>]*>[\s\S]*?<h1\b[^>]*>[\s\S]*?<\/h1>\s*<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] || "";
  const brandBlock = html.match(/<p>\s*Brand\s*<\/p>([\s\S]*?)<\/div>/i)?.[1] || "";
  const airedBlock = html.match(/<p>\s*Aired\s*<\/p>([\s\S]*?)<\/div>/i)?.[1] || "";
  const descriptionBlock = html.match(/class\s*=\s*(?:"[^"]*\brow-desc\b[^"]*"|'[^']*\brow-desc\b[^']*')[^>]*>[\s\S]*?class\s*=\s*(?:"[^"]*\brow-label\b[^"]*"|'[^']*\brow-label\b[^']*')[^>]*>[\s\S]*?<\/div>([\s\S]*?)<\/div>\s*<hr/i)?.[1] || "";
  const originalCover = [...html.matchAll(/<a\b[^>]*class\s*=\s*(?:"[^"]*\bglightbox\b[^"]*"|'[^']*\bglightbox\b[^']*')[^>]*>/gi)]
    .map((match) => attr(match[0], "href"))
    .find((value) => /static\.underhentai\.net\/assets\/images\//i.test(value)) || "";
  const coverTags = [...html.matchAll(/<img\b[^>]*(?:fetchpriority\s*=\s*(?:"high"|'high'|high)|\/uploads\/)[^>]*>/gi)];
  const cover = normalizeImageUrl(originalCover || coverTags.map((match) => attr(match[0], "src")).find(Boolean) || item.image);
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
    title: stripHtml(titleMatch?.[1] || item.title),
    officialTitle: stripHtml(officialBlock || currentOfficial),
    brand: stripHtml(brandBlock) || currentMetaRow(html, "Brand"),
    aired: stripHtml(airedBlock) || currentMetaRow(html, "Aired"),
    description: stripHtml(descriptionBlock),
    genres,
    image: cover,
    banner: screenshots[0] || cover,
    episodeCount: new Set(episodeNumbers).size || Math.max(1, episodeNumbers.length),
    releaseCount: streamCount
  };
  metadata.safetyExcluded = !isSafeAdultMetadata(metadata);
  return metadata;
}

async function mapConcurrent(items, worker) {
  const result = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: CONCURRENCY }, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        result[index] = await worker(items[index], index);
      } catch (error) {
        console.warn(`Skipping metadata for ${items[index].url}: ${error.message}`);
        result[index] = { ...items[index], episodeCount: 0, releaseCount: 0, genres: [], safetyExcluded: true };
      }
      if ((index + 1) % 25 === 0) console.log(`Metadata ${index + 1}/${items.length}`);
    }
  });
  await Promise.all(runners);
  return result;
}

async function main() {
  const firstHtml = await fetchText(`${BASE_URL}/`);
  const pageNumbers = [...firstHtml.matchAll(/page\/(\d+)\//gi)].map((match) => Number(match[1]));
  const lastPage = Math.max(1, ...pageNumbers);
  const pageUrls = Array.from({ length: lastPage }, (_, index) => index === 0 ? `${BASE_URL}/` : `${BASE_URL}/page/${index + 1}/`);
  const pages = await mapConcurrent(pageUrls, async (url, index) => parseListing(await fetchText(url), index + 1));
  const seen = new Set();
  const listed = pages.flat()
    .filter((item) => item.slug && !seen.has(item.slug) && seen.add(item.slug))
    .map((item, sourceOrder) => ({ ...item, sourceOrder }));
  console.log(`Found ${listed.length} title pages across ${lastPage} listing pages.`);

  const enriched = await mapConcurrent(listed, async (item) => extractMetadata(await fetchText(item.url), item));
  const safeItems = enriched.filter((item) => !item.safetyExcluded && item.episodeCount > 0);
  const payload = {
    source: "UnderHentai",
    generatedAt: new Date().toISOString(),
    totalFound: enriched.length,
    excludedForSafety: enriched.length - safeItems.length,
    items: safeItems
  };
  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Saved ${safeItems.length} adult-only titles to ${OUTPUT}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
