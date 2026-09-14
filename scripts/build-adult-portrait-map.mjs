import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const UNDERHENTAI_CATALOG = resolve("scraper", "underhentai_catalog.json");
const HENTAILA_CATALOG = resolve("scraper", "hentaila_catalog.json");
const CURRENT_MAP = resolve("scraper", "adult_portrait_map.json");
const OUTPUTS = [
  CURRENT_MAP,
  resolve("android", "app", "src", "main", "assets", "scraper", "adult_portrait_map.json")
];
const RETIRED_HOSTS = new Set(["veohentai.com", "www.veohentai.com"]);

const readJson = (file) => readFile(file, "utf8").then(JSON.parse);

function titleKey(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(?:the\s+)?animation\b/g, " ")
    .replace(/\b(?:ova|ona)\b/g, " ")
    .replace(/\bepisode\s*\d+\b/g, " ")
    .replace(/\s+\d+$/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleKeys(item = {}) {
  return [...new Set([
    item.title,
    item.officialTitle,
    item.nativeTitle,
    item.romajiTitle,
    ...(Array.isArray(item.aliases) ? item.aliases : [])
  ].map(titleKey).filter(Boolean))];
}

function usableArtwork(value = "") {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "https:" && !RETIRED_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

const [underHentai, hentaiLa, previous] = await Promise.all([
  readJson(UNDERHENTAI_CATALOG),
  readJson(HENTAILA_CATALOG),
  readJson(CURRENT_MAP).catch(() => ({ items: {} }))
]);

const underItems = Array.isArray(underHentai.items) ? underHentai.items : [];
const validSlugs = new Set(underItems.map((item) => String(item.slug || "").trim()).filter(Boolean));
const items = new Map(Object.entries(previous.items || {}).filter(([slug, artwork]) => (
  validSlugs.has(slug) && usableArtwork(artwork?.url)
)));

const hentaiLaByTitle = new Map();
for (const candidate of Array.isArray(hentaiLa.items) ? hentaiLa.items : []) {
  const url = String(candidate.image || candidate.poster || candidate.cover || "").trim();
  if (!usableArtwork(url)) continue;
  for (const key of titleKeys(candidate)) {
    if (!hentaiLaByTitle.has(key)) hentaiLaByTitle.set(key, { url, source: "HentaiLA" });
  }
}

let added = 0;
for (const item of underItems) {
  const slug = String(item.slug || "").trim();
  if (!slug || items.has(slug)) continue;
  const artwork = titleKeys(item).map((key) => hentaiLaByTitle.get(key)).find(Boolean);
  if (!artwork) continue;
  items.set(slug, artwork);
  added += 1;
}

const sortedItems = Object.fromEntries([...items.entries()].sort(([a], [b]) => a.localeCompare(b)));
const payload = {
  version: 2,
  generatedAt: new Date().toISOString(),
  total: items.size,
  items: sortedItems
};
const serialized = `${JSON.stringify(payload, null, 2)}\n`;

for (const output of OUTPUTS) {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, serialized, "utf8");
}

console.log(`Saved ${items.size} stable adult portrait mappings (${added} exact HentaiLA additions).`);
