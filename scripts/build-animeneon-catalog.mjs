import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const BASE_URL = "https://animeneon.net";
const OUTPUT_PATH = resolve("scraper", "animeneon-catalog.json");
const LANGUAGES = ["Sub", "Lat", "Cast"];
const CONCURRENCY = Math.max(1, Math.min(3, Number(process.env.ANIMENEON_CATALOG_CONCURRENCY || 2)));
const REQUEST_TIMEOUT_MS = 12_000;
const REQUEST_GAP_MS = Math.max(100, Number(process.env.ANIMENEON_REQUEST_GAP_MS || 250));
const writeOutput = process.argv.includes("--write");

const headers = {
  Accept: "application/json",
  "Accept-Language": "es-419,es;q=0.9,en;q=0.5",
  Referer: `${BASE_URL}/browse`,
  "User-Agent": "ZenkaiTV-catalog-builder/1.0"
};

function wait(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function decodeSvelteData(values = []) {
  const cache = new Map();
  const decode = (index) => {
    if (index === -1 || index === -2) return undefined;
    if (index === -3) return NaN;
    if (index === -4) return Infinity;
    if (index === -5) return -Infinity;
    if (index === -6) return -0;
    if (typeof index !== "number") return index;
    if (cache.has(index)) return cache.get(index);
    const value = values[index];
    if (Array.isArray(value)) {
      if (value[0] === "Date") return new Date(value[1]);
      if (value[0] === "BigInt") return BigInt(value[1]);
      if (value[0] === "RegExp") return new RegExp(value[1], value[2] || "");
      const output = [];
      cache.set(index, output);
      value.forEach((item) => output.push(decode(item)));
      return output;
    }
    if (value && typeof value === "object") {
      const output = {};
      cache.set(index, output);
      Object.entries(value).forEach(([key, item]) => { output[key] = decode(item); });
      return output;
    }
    return value;
  };
  return decode(0);
}

function decodedDataNode(payload = {}) {
  const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (Array.isArray(nodes[index]?.data)) return decodeSvelteData(nodes[index].data);
  }
  return null;
}

function retryAfterMs(response) {
  const raw = response?.headers?.get("retry-after") || "";
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 30_000)) : 0;
}

async function fetchPage(language, page, attempt = 0) {
  const endpoint = new URL("/browse/__data.json", BASE_URL);
  endpoint.searchParams.set("lang", language);
  endpoint.searchParams.set("page", String(page));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, { headers, signal: controller.signal });
    if (response.status === 429 && attempt < 2) {
      await wait(retryAfterMs(response) || 1500 * (2 ** attempt));
      return fetchPage(language, page, attempt + 1);
    }
    if (!response.ok) throw new Error(`${language} page ${page}: HTTP ${response.status}`);
    const data = decodedDataNode(await response.json());
    return {
      items: Array.isArray(data?.animes) ? data.animes : [],
      totalPages: Math.max(1, Number(data?.pagination?.totalPages || data?.totalPages || 1))
    };
  } finally {
    clearTimeout(timeout);
  }
}

function compactItem(item = {}, fallbackLanguage = "") {
  const href = String(item.href || "");
  const pathname = new URL(href, BASE_URL).pathname.replace(/^\/anime\//, "").replace(/\/$/, "");
  const separator = pathname.lastIndexOf(".");
  if (separator <= 0) return null;
  const slug = pathname.slice(0, separator);
  const nanoid = pathname.slice(separator + 1);
  if (!/^[a-z0-9-]+$/i.test(slug) || !/^[a-z0-9_-]+$/i.test(nanoid)) return null;
  const title = String(item.title || "").trim();
  if (!title) return null;
  const episodes = Math.max(0, Number(item.episodes || 0));
  // Upcoming placeholders cannot resolve a playback route yet. Keeping them in
  // the source index makes the app spend a cold request proving episode 1 is
  // absent, so publish them only after the provider exposes an episode.
  if (episodes <= 0) return null;
  return {
    title,
    slug,
    nanoid,
    language: String(item.language || fallbackLanguage),
    type: String(item.type || ""),
    episodes,
    year: Math.max(0, Number(item.year || 0))
  };
}

async function mapLimit(values, limit, worker) {
  const output = new Array(values.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      output[index] = await worker(values[index], index);
      await wait(REQUEST_GAP_MS);
    }
  });
  await Promise.all(runners);
  return output;
}

function readPrevious() {
  try {
    const payload = JSON.parse(readFileSync(OUTPUT_PATH, "utf8"));
    return Array.isArray(payload.items) ? payload.items : [];
  } catch {
    return [];
  }
}

async function buildLanguage(language) {
  const first = await fetchPage(language, 1);
  const pages = Array.from({ length: Math.max(0, first.totalPages - 1) }, (_, index) => index + 2);
  const rest = await mapLimit(pages, CONCURRENCY, (page) => fetchPage(language, page));
  return [first, ...rest]
    .flatMap((result) => result.items)
    .map((item) => compactItem(item, language))
    .filter(Boolean);
}

async function main() {
  const previous = readPrevious();
  const groups = [];
  for (const language of LANGUAGES) {
    try {
      const items = await buildLanguage(language);
      if (!items.length) throw new Error(`${language} returned an empty catalog`);
      groups.push(items);
      console.log(`${language}: ${items.length} titles`);
    } catch (error) {
      const fallback = previous.filter((item) => item.language === language);
      if (!fallback.length) throw error;
      groups.push(fallback);
      console.warn(`${language}: kept ${fallback.length} previous titles (${error.message})`);
    }
  }

  const deduped = new Map();
  groups.flat().forEach((item) => deduped.set(`${item.language}:${item.slug}.${item.nanoid}`, item));
  const items = [...deduped.values()].sort((left, right) => (
    left.language.localeCompare(right.language) || left.title.localeCompare(right.title)
  ));
  const counts = Object.fromEntries(LANGUAGES.map((language) => [
    language,
    items.filter((item) => item.language === language).length
  ]));
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: `${BASE_URL}/browse`,
    counts,
    items
  };

  console.log(`Total: ${items.length} titles`);
  if (!writeOutput) {
    console.log("Dry run only; pass --write to update scraper/animeneon-catalog.json.");
    return;
  }
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  const tempPath = `${OUTPUT_PATH}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(payload)}\n`, "utf8");
  renameSync(tempPath, OUTPUT_PATH);
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
