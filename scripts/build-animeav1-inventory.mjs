import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CATALOG = fileURLToPath(new URL("../scraper/anime_metadata.json", import.meta.url));
const DEFAULT_PREVIOUS = fileURLToPath(new URL("../scraper/anime_metadata.previous.json", import.meta.url));
const DEFAULT_BASE = "https://animeav1.com";

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (const raw of argv) {
    const [key, ...rest] = String(raw).replace(/^--/, "").split("=");
    args[key] = rest.length ? rest.join("=") : true;
  }
  return args;
}

function escapeRegex(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function animeAv1Slug(item = {}) {
  const direct = String(item.animeAv1Slug || item._av1Slug || "").trim();
  if (direct) return direct;
  const site = String(item.siteUrl || "").match(/animeav1\.com\/media\/([^/?#]+)/i)?.[1];
  const id = String(item.id || "").match(/^animeav1-(.+)$/i)?.[1];
  return String(site || id || "").trim();
}

export function parseAnimeAv1EpisodeInventory(html = "", slug = "") {
  const safeSlug = String(slug || "").trim().toLowerCase();
  if (!safeSlug) return null;

  const ids = new Set();
  const routePattern = new RegExp(`/media/${escapeRegex(safeSlug)}/(\\d+(?:\\.\\d+)?)`, "gi");
  for (const match of String(html).matchAll(routePattern)) ids.add(Number(match[1]));

  // SvelteKit also serializes the current title's inventory as
  // episodes:[{id:123,number:0},...]. Use it only when exact route links were
  // absent; exact slug routes cannot accidentally absorb a related title.
  if (!ids.size) {
    const block = String(html).match(/episodes:\[((?:\{[^{}]*\},?\s*)+)\]/i)?.[1] || "";
    for (const match of block.matchAll(/\bnumber\s*:\s*(\d+(?:\.\d+)?)/gi)) ids.add(Number(match[1]));
  }

  const declaredMatch = String(html).match(/\bepisodesCount\s*:\s*(\d+)/i);
  const declaredCount = declaredMatch ? Number(declaredMatch[1]) : null;
  const episodeIds = [...ids].filter(Number.isFinite).sort((a, b) => a - b);
  if (!episodeIds.length && declaredCount !== 0) return null;

  const positive = episodeIds.filter((number) => number > 0);
  const latestDisplayEpisode = positive.length ? positive.at(-1) : (episodeIds.includes(0) ? 1 : 0);
  return {
    sourceEpisodeIds: episodeIds,
    // A page can advertise the planned season total before those routes exist.
    // Only an episode id printed by the provider is playable today.
    sourceEpisodeCount: latestDisplayEpisode,
    sourcePlayableEpisodeCount: episodeIds.length,
    sourceInventoryChecked: true,
    sourceDeclaredEpisodeCount: declaredCount
  };
}

export function expandAnimeAv1PaginatedInventory(inventory) {
  if (!inventory || !Array.isArray(inventory.sourceEpisodeIds)) return inventory;
  const declaredCount = Number(inventory.sourceDeclaredEpisodeCount);
  const positiveIds = inventory.sourceEpisodeIds
    .map(Number)
    .filter((number) => Number.isInteger(number) && number > 0)
    .sort((a, b) => a - b);
  const observedLast = positiveIds.at(-1) || 0;
  if (!Number.isInteger(declaredCount) || declaredCount <= observedLast || declaredCount > 10000) return inventory;

  // AnimeAV1 paginates long shows after 50 links. Callers must probe both the
  // next hidden route and the declared final route before using this expansion.
  // Preserve any confirmed holes in the visible window (for example a deleted
  // episode 2) while restoring the provider's verified contiguous hidden tail.
  const sourceEpisodeIds = [...new Set([
    ...inventory.sourceEpisodeIds.map(Number).filter(Number.isFinite),
    ...Array.from({ length: declaredCount - observedLast }, (_, index) => observedLast + index + 1)
  ])].sort((a, b) => a - b);
  return {
    ...inventory,
    sourceEpisodeIds,
    sourceEpisodeCount: declaredCount,
    sourcePlayableEpisodeCount: sourceEpisodeIds.length,
    sourceInventoryRangeVerified: true,
    sourceInventoryRangeProbeStatus: "verified"
  };
}

export function preserveVerifiedEpisodeRange(inventory, previous = {}) {
  if (!inventory || inventory.sourceInventoryRangeProbeStatus !== "inconclusive") return inventory;
  const declaredCount = Number(inventory.sourceDeclaredEpisodeCount);
  const previousDeclaredCount = Number(previous.sourceDeclaredEpisodeCount);
  const currentCount = Number(inventory.sourcePlayableEpisodeCount || 0);
  const previousCount = Number(previous.sourcePlayableEpisodeCount || 0);
  if (!previous.sourceInventoryRangeVerified
      || !Number.isInteger(declaredCount)
      || declaredCount !== previousDeclaredCount
      || previousCount <= currentCount
      || !Array.isArray(previous.sourceEpisodeIds)) {
    return inventory;
  }
  return {
    ...inventory,
    sourceEpisodeIds: [...previous.sourceEpisodeIds],
    sourceEpisodeCount: Number(previous.sourceEpisodeCount) || declaredCount,
    sourcePlayableEpisodeCount: previousCount,
    sourceUnavailableEpisodeIds: Array.isArray(previous.sourceUnavailableEpisodeIds)
      ? [...previous.sourceUnavailableEpisodeIds]
      : undefined,
    sourceInventoryRangeVerified: true,
    sourceInventoryRangeProbeStatus: "restored"
  };
}

export function parseAnimeAv1PageMetadata(html = "", slug = "") {
  const source = String(html || "");
  const safeSlug = String(slug || "").trim();
  if (!source || !safeSlug) return {};
  const marker = new RegExp(`slug:"${escapeRegex(safeSlug)}"`, "i").exec(source);
  if (!marker) return {};

  const before = source.slice(Math.max(0, marker.index - 7000), marker.index);
  const after = source.slice(marker.index, marker.index + 1800);
  const lastNumber = (name) => {
    const matches = [...before.matchAll(new RegExp(`\\b${name}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, "gi"))];
    const value = Number(matches.at(-1)?.[1]);
    return Number.isFinite(value) ? value : null;
  };
  const lastString = (name) => {
    const matches = [...before.matchAll(new RegExp(`\\b${name}\\s*:\\s*"([^"]*)"`, "gi"))];
    return String(matches.at(-1)?.[1] || "").trim();
  };
  const malId = Number(after.match(/\bmalId\s*:\s*(\d+)/i)?.[1]) || null;
  const category = String(after.match(/category\s*:\s*\{[^{}]*\bmalId\s*:\s*"([^"]+)"/i)?.[1] || "").trim();
  return {
    sourceMalId: malId,
    sourceRuntime: lastNumber("runtime"),
    sourceScore: lastNumber("score"),
    sourceStartDate: lastString("startDate"),
    sourceEndDate: lastString("endDate"),
    sourceType: category
  };
}

export function parseAnimeAv1DirectMediaUrls(html = "") {
  const urls = [];
  const seen = new Set();
  for (const match of String(html).matchAll(/server:"([^"]+)",url:"([^"]+)"/gi)) {
    const rawUrl = String(match[2] || "").replace(/\\u002F/gi, "/").replace(/\\\//g, "/");
    const zilla = rawUrl.match(/^https?:\/\/player\.zilla-networks\.com\/play\/([a-f0-9]{32})(?:[?#].*)?$/i);
    const directUrl = zilla
      ? `https://player.zilla-networks.com/m3u8/${zilla[1]}`
      : /\.(?:m3u8|mp4|webm|m4v)(?:$|[?#])/i.test(rawUrl) ? rawUrl : "";
    if (!directUrl || seen.has(directUrl)) continue;
    seen.add(directUrl);
    urls.push(directUrl);
  }
  return urls;
}

export function excludeUnavailableEpisodeIds(inventory, episodeIds = []) {
  if (!inventory || !Array.isArray(inventory.sourceEpisodeIds)) return inventory;
  const unavailable = new Set(episodeIds.map(Number).filter(Number.isFinite));
  if (!unavailable.size) return inventory;
  const sourceEpisodeIds = inventory.sourceEpisodeIds.filter((id) => !unavailable.has(Number(id)));
  const positive = sourceEpisodeIds.filter((number) => number > 0);
  return {
    ...inventory,
    sourceEpisodeIds,
    sourceEpisodeCount: positive.length ? positive.at(-1) : (sourceEpisodeIds.includes(0) ? 1 : 0),
    sourcePlayableEpisodeCount: sourceEpisodeIds.length,
    sourceUnavailableEpisodeIds: [...new Set([
      ...(inventory.sourceUnavailableEpisodeIds || []),
      ...episodeIds
    ].map(Number).filter(Number.isFinite))].sort((a, b) => a - b)
  };
}

const INVENTORY_FIELDS = [
  "sourceEpisodeIds",
  "sourceEpisodeCount",
  "sourcePlayableEpisodeCount",
  "sourceDeclaredEpisodeCount",
  "sourceUnavailableEpisodeIds",
  "sourceInventoryRangeVerified",
  "sourceInventoryRangeProbeStatus",
  "sourceInventoryChecked",
  "sourceInventoryCheckedAt"
];

function copyInventory(target, source) {
  if (!source?.sourceInventoryChecked) return false;
  for (const field of INVENTORY_FIELDS) {
    if (source[field] !== undefined) target[field] = source[field];
  }
  return true;
}

export function applyAnimeAv1EpisodeInventory(item, inventory, checkedAt) {
  if (!item || !inventory) return false;
  item.sourceEpisodeIds = [...inventory.sourceEpisodeIds];
  item.sourceEpisodeCount = inventory.sourceEpisodeCount;
  item.sourcePlayableEpisodeCount = inventory.sourcePlayableEpisodeCount;
  if (inventory.sourceUnavailableEpisodeIds?.length) {
    item.sourceUnavailableEpisodeIds = [...inventory.sourceUnavailableEpisodeIds];
  } else {
    delete item.sourceUnavailableEpisodeIds;
  }
  if (inventory.sourceInventoryRangeVerified) item.sourceInventoryRangeVerified = true;
  else delete item.sourceInventoryRangeVerified;
  if (inventory.sourceInventoryRangeProbeStatus) {
    item.sourceInventoryRangeProbeStatus = inventory.sourceInventoryRangeProbeStatus;
  } else {
    delete item.sourceInventoryRangeProbeStatus;
  }
  if (inventory.sourceDeclaredEpisodeCount != null) item.sourceDeclaredEpisodeCount = inventory.sourceDeclaredEpisodeCount;
  else delete item.sourceDeclaredEpisodeCount;
  item.sourceInventoryChecked = true;
  item.sourceInventoryCheckedAt = checkedAt;
  if (inventory.sourceMalId && !item.malId) item.malId = inventory.sourceMalId;
  if (inventory.sourceRuntime && !item.duration) item.duration = inventory.sourceRuntime;
  if (inventory.sourceStartDate && !item.aired) item.aired = inventory.sourceStartDate;
  if (inventory.sourceStartDate && !item.year) item.year = Number(inventory.sourceStartDate.slice(0, 4)) || null;
  if (inventory.sourceType) item.type = inventory.sourceType;
  if (Number(inventory.sourceScore) > 0 && !Number(item.score)) {
    item.score = Math.round(Number(inventory.sourceScore) * 10);
    item.rating = item.score;
  }
  if (Number(inventory.sourceEpisodeCount) > 0) {
    item.totalEpisodes = Number(inventory.sourceEpisodeCount);
    item.episode = Number(inventory.sourceEpisodeCount);
  }
  delete item.sourceInventoryUnavailableReason;
  return true;
}

export function markAnimeAv1InventoryUnavailable(item, error, checkedAt) {
  if (!item) return false;
  item.sourceEpisodeIds = [];
  item.sourceEpisodeCount = 0;
  item.sourcePlayableEpisodeCount = 0;
  delete item.sourceDeclaredEpisodeCount;
  delete item.sourceUnavailableEpisodeIds;
  delete item.sourceInventoryRangeVerified;
  delete item.sourceInventoryRangeProbeStatus;
  item.sourceInventoryChecked = true;
  item.sourceInventoryCheckedAt = checkedAt;
  item.sourceInventoryUnavailableReason = String(error?.message || error || "Provider published no episode routes");
  return true;
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function fetchInventory(base, slug, timeoutMs, attempts = 2) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${base}/media/${encodeURIComponent(slug)}`, {
        cache: "no-store",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "Mozilla/5.0 (compatible; ZenkaiTV catalog inventory/1.0)"
        }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      let inventory = parseAnimeAv1EpisodeInventory(html, slug);
      if (!inventory) throw new Error("episode inventory missing from page");
      inventory = { ...inventory, ...parseAnimeAv1PageMetadata(html, slug) };
      // AnimeAV1 occasionally leaves an Episode 0 link in a TV page after its HLS
      // object has been deleted. Ordinary numbered routes have proven reliable,
      // while 0 is also legitimately used by movies and specials, so probe only
      // this ambiguous id and remove it only after an explicit dead-media result.
      if (inventory.sourceEpisodeIds.includes(0)) {
        const zeroAvailable = await probeAnimeAv1Episode(base, slug, 0, timeoutMs);
        if (zeroAvailable === false) inventory = excludeUnavailableEpisodeIds(inventory, [0]);
      }
      const declaredCount = Number(inventory.sourceDeclaredEpisodeCount);
      const observedLast = Math.max(0, ...inventory.sourceEpisodeIds.filter((number) => number > 0));
      if (Number.isInteger(declaredCount) && declaredCount > observedLast && observedLast > 0) {
        const boundaryIds = [...new Set([observedLast + 1, declaredCount])];
        const boundaryResults = await Promise.all(
          boundaryIds.map((episodeId) => probeAnimeAv1Episode(base, slug, episodeId, timeoutMs))
        );
        if (boundaryResults.every((available) => available === true)) {
          inventory = expandAnimeAv1PaginatedInventory(inventory);
        } else {
          inventory.sourceInventoryRangeProbeStatus = boundaryResults.some((available) => available === null)
            && boundaryResults.every((available) => available !== false)
            ? "inconclusive"
            : "rejected";
        }
      }
      return inventory;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("inventory request failed");
}

async function probeAnimeAv1Episode(base, slug, episodeId, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const pageUrl = `${base}/media/${encodeURIComponent(slug)}/${encodeURIComponent(episodeId)}`;
    const page = await fetch(pageUrl, {
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 (compatible; ZenkaiTV catalog inventory/1.0)"
      }
    });
    if (page.status === 404 || page.status === 410) return false;
    if (!page.ok) return null;
    const mediaUrls = parseAnimeAv1DirectMediaUrls(await page.text());
    if (!mediaUrls.length) return false;

    let retryableFailure = false;
    for (const mediaUrl of mediaUrls) {
      try {
        const media = await fetch(mediaUrl, {
          cache: "no-store",
          redirect: "follow",
          signal: controller.signal,
          headers: {
            Accept: "application/vnd.apple.mpegurl,video/*,*/*;q=0.8",
            Referer: new URL(mediaUrl).origin + "/",
            "User-Agent": "Mozilla/5.0 (compatible; ZenkaiTV catalog inventory/1.0)"
          }
        });
        if (media.ok) {
          const body = await media.text();
          if (body.trim()) return true;
        } else if (media.status !== 404 && media.status !== 410) {
          retryableFailure = true;
        }
      } catch {
        retryableFailure = true;
      }
    }
    return retryableFailure ? null : false;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = parseArgs();
  const catalogPath = path.resolve(String(args.catalog || DEFAULT_CATALOG));
  const previousPath = path.resolve(String(args.previous || DEFAULT_PREVIOUS));
  const base = String(args.base || DEFAULT_BASE).replace(/\/$/, "");
  const concurrency = Math.max(1, Math.min(24, Number(args.concurrency || 8)));
  const timeoutMs = Math.max(2500, Number(args.timeout || 12000));
  const limit = args.limit ? Math.max(1, Number(args.limit)) : Infinity;
  const write = Boolean(args.write);
  const checkedAt = new Date().toISOString();

  const payload = await readJson(catalogPath);
  if (!payload || !Array.isArray(payload.items) || !payload.items.length) {
    throw new Error(`No catalog items found in ${catalogPath}`);
  }
  const previous = await readJson(previousPath, { items: [] });
  const previousBySlug = new Map((previous.items || []).map((item) => [animeAv1Slug(item).toLowerCase(), item]));
  const targets = payload.items
    .map((item) => ({ item, slug: animeAv1Slug(item) }))
    .filter((entry) => entry.slug)
    .slice(0, limit);

  let cursor = 0;
  let refreshed = 0;
  let restored = 0;
  let restoredRanges = 0;
  const unresolved = [];
  async function worker() {
    while (cursor < targets.length) {
      const index = cursor++;
      const { item, slug } = targets[index];
      try {
        const previousItem = previousBySlug.get(slug.toLowerCase());
        const fetchedInventory = await fetchInventory(base, slug, timeoutMs);
        const inventory = preserveVerifiedEpisodeRange(fetchedInventory, previousItem);
        if (inventory.sourceInventoryRangeProbeStatus === "restored") restoredRanges += 1;
        applyAnimeAv1EpisodeInventory(item, inventory, checkedAt);
        refreshed += 1;
      } catch (error) {
        if (copyInventory(item, previousBySlug.get(slug.toLowerCase()))) restored += 1;
        else {
          markAnimeAv1InventoryUnavailable(item, error, checkedAt);
          unresolved.push({ slug, error: String(error?.message || error) });
        }
      }
      if ((index + 1) % 100 === 0 || index + 1 === targets.length) {
        process.stdout.write(`Episode inventory ${index + 1}/${targets.length}\n`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));

  const checked = targets.filter(({ item }) => item.sourceInventoryChecked).length;
  const playable = targets.filter(({ item }) => Number(item.sourcePlayableEpisodeCount) > 0).length;
  payload.sourceInventory = {
    checkedAt,
    titles: targets.length,
    checked,
    playable,
    zeroEpisodeTitles: checked - playable,
    refreshed,
    restored,
    restoredRanges,
    unresolved: unresolved.length
  };

  if (write) await writeFile(catalogPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ catalogPath, write, ...payload.sourceInventory, unresolved: unresolved.slice(0, 20) }, null, 2)}\n`);

  const minimumCoverage = Number(args["minimum-coverage"] || 0.98);
  if (targets.length && checked / targets.length < minimumCoverage) process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
