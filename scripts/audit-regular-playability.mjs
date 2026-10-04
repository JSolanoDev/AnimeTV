import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
import { resolutionFailureStatus } from "./source-probe-policy.mjs";
import { fetchBoundedAuditResponse, isDownloadOnlyAuditSource, probeAuditMediaSource } from "./audit-media-probe.mjs";

const require = createRequire(import.meta.url);
const { normalizeTitle } = require("../js/utils.js");
const SeasonNormalization = require("../js/season-normalization.js");

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, "").split("=");
  return [key, rest.length ? rest.join("=") : true];
}));
const baseUrl = String(args.base || "http://localhost:4173").replace(/\/$/, "");
const episodesPerTitle = Math.max(1, Math.min(5, Number(args["episodes-per-title"] || 2)));
const concurrency = Math.max(1, Math.min(4, Number(args.concurrency || 2)));
const titleLimit = args.limit ? Math.max(1, Number(args.limit)) : Infinity;
const probeMedia = args["probe-media"] !== "false";
const inventoryOnly = args["inventory-only"] === "true";
const allEpisodes = inventoryOnly || args["all-episodes"] === "true";
const requestedSlugs = new Set(String(args.slugs || "").split(",").map(value => value.trim()).filter(Boolean));
const compareLegacy = args["compare-legacy"] === "true";
const failOnUnusable = args["fail-on-unusable"] === "true";
const requestedFormats = new Set(String(args.formats || "")
  .split(",")
  .map((value) => value.trim().toUpperCase())
  .filter(Boolean));
const requestTimeoutMs = Math.max(2500, Number(args.timeout || 12000));
const retryAttempts = Math.max(1, Math.min(2, Number(args.retries || 1)));
const requestPauseMs = Math.max(250, Number(args["pause-ms"] || 500));
let requestGate = Promise.resolve();
let stopReason = "";
let requestsMade = 0;
let consecutiveServiceFailures = 0;
const startedAt = new Date();

function stripSeasonWords(title = "") {
  return String(title)
    .replace(/\bseason\s*\d+\b/ig, " ")
    .replace(/\b\d+(st|nd|rd|th)\s*season\b/ig, " ")
    .replace(/\bpart\s*\d+\b/ig, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function ordinal(value) {
  const number = Number(value) || 0;
  const mod100 = number % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${number}th`;
  const suffix = number % 10 === 1 ? "st" : number % 10 === 2 ? "nd" : number % 10 === 3 ? "rd" : "th";
  return `${number}${suffix}`;
}

function seasonTitleVariants(title = "") {
  const text = String(title || "").trim();
  if (!text) return [];
  const values = new Set([text]);
  const seasonMatch = text.match(/\bseason\s*(\d+)\b/i) || text.match(/\b(\d+)(?:st|nd|rd|th)\s*season\b/i);
  const partMatch = text.match(/\bpart\s*(\d+)\b/i);
  const base = stripSeasonWords(text);
  if (seasonMatch && base) {
    const number = Number(seasonMatch[1]);
    values.add(`${base} ${number}`);
    values.add(`${base} season ${number}`);
    values.add(`${base} ${ordinal(number)} season`);
    values.add(`${base} ${ordinal(number)}`);
  }
  if (partMatch && base) {
    const number = Number(partMatch[1]);
    values.add(`${base} part ${number}`);
    values.add(`${base} ${number}`);
  }
  return [...values];
}

function equivalentKeys(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return [];
  const variants = new Set([
    raw,
    raw.replace(/\bre\s*[:\-]?\s*zero\b/ig, "rezero"),
    raw.replace(/\brezero\b/ig, "re zero"),
    raw.replace(/[:.'’]/g, " "),
    raw.replace(/[:.'’]/g, "")
  ]);
  return [...variants].map(normalizeTitle).filter(Boolean);
}

function slugToTitle(slug = "") {
  return String(slug).replace(/-/g, " ").replace(/\b\w/g, (character) => character.toUpperCase()).trim();
}

function legacyTitleKeys(title = "", slug = "") {
  const raw = [
    title,
    stripSeasonWords(title),
    slugToTitle(slug),
    stripSeasonWords(slugToTitle(slug)),
    ...seasonTitleVariants(title),
    ...seasonTitleVariants(slugToTitle(slug))
  ];
  return [...new Set(raw.flatMap(equivalentKeys))];
}

function authoritativeSlug(item = {}) {
  const siteMatch = String(item.siteUrl || "").match(/animeav1\.com\/media\/([^/?#]+)/i);
  const idMatch = String(item.id || "").match(/^animeav1-(.+)$/i);
  return String(item.animeAv1Slug || item._av1Slug || item._slug || siteMatch?.[1] || idMatch?.[1] || "")
    .trim().toLowerCase();
}

function applyVerifiedFallback(item = {}, fallbackEntries = {}) {
  const entry = fallbackEntries[item.id] || fallbackEntries[authoritativeSlug(item)] || null;
  if (!entry || entry.verified !== true) return item;
  const episodeMap = Object.fromEntries(Object.entries(entry.episodeMap || {})
    .map(([canonical, providerEpisode]) => [Number(canonical), Number(providerEpisode)])
    .filter(([canonical, providerEpisode]) => (
      Number.isInteger(canonical) && canonical > 0
      && Number.isFinite(providerEpisode) && providerEpisode >= 0
    )));
  const fallbackEpisodeIds = Object.keys(episodeMap).map(Number).sort((a, b) => a - b);
  const providerKey = String(entry.provider || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!fallbackEpisodeIds.length || !entry.providerAnimeSlug || !["tioanime", "jkanime"].includes(providerKey)) return item;
  return {
    ...item,
    fallbackProvider: entry.provider,
    fallbackProviderKey: providerKey,
    fallbackProviderAnimeSlug: entry.providerAnimeSlug,
    fallbackEpisodeMap: episodeMap,
    fallbackEpisodeIds,
    fallbackPlayableEpisodeCount: fallbackEpisodeIds.length,
    fallbackInventoryChecked: true,
    sourceFallbackVerified: true
  };
}

function hasVerifiedFallback(item = {}) {
  return item.sourceFallbackVerified === true
    && item.fallbackInventoryChecked === true
    && Boolean(item.fallbackProviderAnimeSlug)
    && Number(item.fallbackPlayableEpisodeCount || 0) > 0;
}

function isActiveAnimeAv1CatalogItem(item = {}) {
  const isAnimeAv1 = /animeav1/i.test(String(item.source || item.id || item.siteUrl || ""));
  const confirmedUnavailable = item.sourceInventoryChecked === true
    && Number(item.sourcePlayableEpisodeCount || 0) <= 0;
  return isAnimeAv1 && (!confirmedUnavailable || hasVerifiedFallback(item));
}

function episodeNumber(item = {}) {
  for (const value of [item.canonicalEpisode, item.episode, item.number, item.episodeNumber]) {
    const number = Number(value);
    if (value !== "" && value != null && Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

function catalogEpisodeLimit(item = {}) {
  if (item.sourceInventoryChecked && Number(item.sourcePlayableEpisodeCount || 0) > 0) {
    return Number(item.sourcePlayableEpisodeCount || item.sourceEpisodeIds?.length || 0);
  }
  if (hasVerifiedFallback(item)) return Number(item.fallbackPlayableEpisodeCount || item.fallbackEpisodeIds?.length || 0);
  const format = String(item.format || item.type || "").toUpperCase();
  if (format === "MOVIE") return 1;
  const servedBySource = Number(item.sourceEpisodeCount || 0);
  if (Number.isFinite(servedBySource) && servedBySource > 0) return servedBySource;
  const episodes = Array.isArray(item.episodes) ? item.episodes : [];
  const maxSourceEpisode = Math.max(0, ...episodes.map(episodeNumber).filter(Number.isFinite));
  const status = String(item.status || "").toUpperCase();
  if (status === "RELEASING" || status === "AIRING") {
    return Number(item.latestAiredEp || item.latestEpisode || item.episode) || maxSourceEpisode || null;
  }
  return Number(item.anilistEpisodeCount || item.totalEpisodes || item.episodeCount || item.episodesCount || item.episode)
    || maxSourceEpisode
    || null;
}

function sampledEpisodeNumbers(item = {}) {
  if (item.sourceInventoryChecked && Array.isArray(item.sourceEpisodeIds) && item.sourceEpisodeIds.length) {
    const ids = [...new Set(item.sourceEpisodeIds.map(Number).filter((number) => Number.isFinite(number) && number >= 0))]
      .sort((a, b) => a - b);
    if (!ids.length) return [];
    const soleZero = ids.length === 1 && ids[0] === 0;
    const display = ids.map((number) => soleZero ? 1 : number);
    if (allEpisodes) return [...new Set(display)];
    const candidates = [display[0]];
    if (episodesPerTitle >= 3) candidates.push(display[Math.floor((display.length - 1) / 2)]);
    if (episodesPerTitle >= 2) candidates.push(display.at(-1));
    return [...new Set(candidates)];
  }
  if (hasVerifiedFallback(item) && Array.isArray(item.fallbackEpisodeIds)) {
    const ids = [...new Set(item.fallbackEpisodeIds.map(Number).filter((number) => Number.isInteger(number) && number > 0))]
      .sort((a, b) => a - b);
    if (allEpisodes) return ids;
    const candidates = [ids[0]];
    if (episodesPerTitle >= 3) candidates.push(ids[Math.floor((ids.length - 1) / 2)]);
    if (episodesPerTitle >= 2) candidates.push(ids.at(-1));
    return [...new Set(candidates)];
  }
  const sourceNumbers = (Array.isArray(item.episodes) ? item.episodes : []).map(episodeNumber).filter(Number.isFinite);
  const specials = sourceNumbers.filter((number) => number === 0 || !Number.isInteger(number));
  const limit = catalogEpisodeLimit(item);
  const candidates = [];
  if (limit && limit > 0) {
    if (allEpisodes) return Array.from({ length: limit }, (_, index) => index + 1);
    candidates.push(1);
    if (episodesPerTitle >= 3) candidates.push(Math.max(1, Math.ceil(limit / 2)));
    if (episodesPerTitle >= 2) candidates.push(limit);
  } else if (sourceNumbers.length) {
    const sorted = [...new Set(sourceNumbers)].sort((a, b) => a - b);
    candidates.push(sorted[0]);
    if (episodesPerTitle >= 2) candidates.push(sorted.at(-1));
  } else {
    candidates.push(1);
  }
  specials.slice(0, 2).forEach((number) => candidates.push(number));
  return [...new Set(candidates)].slice(0, episodesPerTitle + 2);
}

function providerEpisodeNumber(item = {}, displayedEpisodeNumber) {
  if (hasVerifiedFallback(item)) {
    const mapped = Number(item.fallbackEpisodeMap?.[String(displayedEpisodeNumber)]);
    if (Number.isFinite(mapped) && mapped >= 0) return mapped;
  }
  const ids = Array.isArray(item.sourceEpisodeIds)
    ? item.sourceEpisodeIds.map(Number).filter((number) => Number.isFinite(number) && number >= 0)
    : [];
  if (ids.length === 1 && ids[0] === 0 && Number(displayedEpisodeNumber) === 1) return 0;
  if (ids.includes(Number(displayedEpisodeNumber))) return Number(displayedEpisodeNumber);
  return Number(item.providerEpisodeOffset || 0) + Number(displayedEpisodeNumber);
}

function safeUrl(value = "") {
  try {
    const parsed = new URL(value, baseUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "";
  }
}

function failureCode(status, detail = "") {
  if (status === 403) return "SOURCE_403";
  if (status === 404) return "SOURCE_404";
  if (status === 429) return "SOURCE_RATE_LIMIT";
  if (status === 408 || /timeout|abort/i.test(detail)) return "SOURCE_TIMEOUT";
  return "NO_SOURCE";
}

async function fetchWithDeadline(url, options = {}, timeoutMs = requestTimeoutMs, maxBytes) {
  const slot = requestGate.then(async () => {
    if (stopReason) throw new Error(stopReason);
    await new Promise(resolve => setTimeout(resolve, requestPauseMs));
  });
  requestGate = slot.catch(() => {});
  await slot;
  if (stopReason) throw new Error(stopReason);
  requestsMade++;
  const response = await fetchBoundedAuditResponse(url, options, timeoutMs, maxBytes);
  if (response.status === 429) {
    stopReason = `Stopped on HTTP 429; Retry-After=${response.headers.get("retry-after") || "unspecified"}`;
  } else if (response.status === 403 && /Vercel Security Checkpoint|verify you are human/i.test(await response.text())) {
    stopReason = "Stopped: Vercel Security Checkpoint prevents application-level testing";
  }
  if (response.status >= 500) consecutiveServiceFailures++;
  else consecutiveServiceFailures = 0;
  if (consecutiveServiceFailures >= 5) stopReason = "Stopped after five consecutive upstream/server failures";
  return response;
}

async function validateMediaSource(source = {}) {
  return probeAuditMediaSource(source, { baseUrl, request: fetchWithDeadline, timeoutMs: requestTimeoutMs });
}

const sourceResolutionCache = new Map();
const mediaValidationCache = new Map();

function isTransientResolutionFailure(result = {}) {
  const status = resolutionFailureStatus(result);
  return result.failure === "SOURCE_TIMEOUT"
    || !Number.isFinite(status)
    || status === 408
    || status === 429
    || status >= 500;
}

async function resolveEpisodeCached(providerKey, slug, providerEpisodeId) {
  const key = `${providerKey}:${slug}:${providerEpisodeId}`;
  if (!sourceResolutionCache.has(key)) {
    sourceResolutionCache.set(key, (async () => {
      const route = providerKey === "tioanime"
        ? "/api/tioanime/sources"
        : providerKey === "jkanime"
          ? "/api/jkanime/sources"
          : "/api/animeav1/sources";
      const variant = providerKey === "animeav1" ? "&variant=SUB" : "";
      const url = `${baseUrl}${route}?slug=${encodeURIComponent(slug)}&episode=${encodeURIComponent(providerEpisodeId)}${variant}`;
      try {
        const response = await fetchWithDeadline(url);
        const payload = await response.json().catch(() => null);
        const sources = [
          ...(Array.isArray(payload?.sources) ? payload.sources : []),
          ...(providerKey === "animeav1" && Array.isArray(payload?.castSources) ? payload.castSources : [])
        ].filter((source, index, list) => {
          const identity = source?.videoUrl || source?.url || source?.externalUrl || source?.id || "";
          return identity && list.findIndex((candidate) => (
            (candidate?.videoUrl || candidate?.url || candidate?.externalUrl || candidate?.id || "") === identity
          )) === index;
        });
        if (!response.ok || !payload?.ok || !sources.length) {
          return {
            resolverOk: false,
            resolverStatus: response.status,
            sourceCount: sources.length,
            sourceTypes: [...new Set(sources.map((source) => source.container || source.type || "unknown"))],
            usable: false,
            failure: failureCode(response.status, payload?.detail || payload?.error || ""),
            providerEpisodeId: payload?.providerEpisodeId ?? providerEpisodeId,
            media: null
          };
        }
        let media = { usable: false, failure: "NOT_PROBED", httpStatus: null, manifestType: "not-probed" };
        if (probeMedia) {
          const ranked = sources.filter((source) => !isDownloadOnlyAuditSource(source)
            && (source.videoUrl || source.url || source.externalUrl));
          media = { usable: false, failure: "NO_SOURCE", httpStatus: null, manifestType: "" };
          for (const source of ranked) {
            const mediaKey = JSON.stringify([
              source.videoUrl || source.url || source.externalUrl,
              source.mediaReferer || source.referer || payload.episodeUrl || ""
            ]);
            if (!mediaValidationCache.has(mediaKey)) {
              mediaValidationCache.set(mediaKey, validateMediaSource({
                ...source, referer: source.referer || payload.episodeUrl || ""
              }));
            }
            const result = await mediaValidationCache.get(mediaKey);
            if (result.usable) {
              media = result;
              break;
            }
            if (isTransientResolutionFailure(result)) mediaValidationCache.delete(mediaKey);
            media = result;
          }
        }
        return {
          resolverOk: true,
          resolverStatus: response.status,
          sourceCount: sources.length,
          sourceTypes: [...new Set(sources.map((source) => source.container || source.type || "unknown"))],
          sourceUrls: sources.map((source) => safeUrl(source.videoUrl || source.url)).filter(Boolean),
          usable: media.usable,
          failure: media.failure,
          providerEpisodeId: payload.providerEpisodeId ?? providerEpisodeId,
          media
        };
      } catch (error) {
        return {
          resolverOk: false,
          resolverStatus: null,
          sourceCount: 0,
          sourceTypes: [],
          usable: false,
          failure: failureCode(408, error.message),
          providerEpisodeId,
          detail: error.message,
          media: null
        };
      }
    })());
  }
  return sourceResolutionCache.get(key);
}

async function resolveEpisode(providerKey, slug, providerEpisodeId) {
  const key = `${providerKey}:${slug}:${providerEpisodeId}`;
  let result = null;
  for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
    if (attempt > 1) sourceResolutionCache.delete(key);
    result = await resolveEpisodeCached(providerKey, slug, providerEpisodeId);
    if (stopReason || result?.usable || !isTransientResolutionFailure(result) || attempt === retryAttempts) break;
    await new Promise((resolve) => setTimeout(resolve, 1000 * (2 ** (attempt - 1))));
  }
  return result;
}

async function mapConcurrent(items, worker, size = concurrency) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length && !stopReason) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
      if ((!inventoryOnly || (index + 1) % 10000 === 0) || index + 1 === items.length) {
        process.stdout.write(`Audited ${index + 1}/${items.length} episode ${inventoryOnly ? "mappings" : "samples"}\n`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
  return results.filter(Boolean);
}

function relationMetrics(catalog) {
  const chains = new Map();
  catalog.forEach((item) => {
    const chain = Array.isArray(item.franchiseSeasons) ? item.franchiseSeasons : [];
    if (chain.length < 2) return;
    const key = chain.map((entry) => entry.anilistId || entry.malId || entry.title).join(":");
    if (!chains.has(key)) chains.set(key, chain);
  });
  let entries = 0;
  let legacyWrongSeasonEntries = 0;
  let legacyProviderOffsetEntries = 0;
  const examples = [];
  for (const chain of chains.values()) {
    const groups = SeasonNormalization.normalizeFranchise(chain.map((entry) => ({ ...entry, mainline: true }))).groups;
    const canonicalById = new Map();
    const offsets = new Map();
    groups.forEach((group) => {
      const season = Number(group.seasonNumber) || 1;
      const offset = offsets.get(season) || 0;
      (group.items || []).forEach((entry) => canonicalById.set(String(entry.anilistId || entry.malId || entry.title), {
        season,
        part: group.partNumber || null,
        offset
      }));
      offsets.set(season, offset + (Number(group.episodeCount) || 0));
    });
    chain.forEach((entry, index) => {
      const canonical = canonicalById.get(String(entry.anilistId || entry.malId || entry.title));
      if (!canonical) return;
      entries += 1;
      const oldSeason = index + 1;
      if (oldSeason !== canonical.season) legacyWrongSeasonEntries += 1;
      if (canonical.offset > 0) legacyProviderOffsetEntries += 1;
      if (examples.length < 12 && (oldSeason !== canonical.season || canonical.offset > 0)) {
        examples.push({ title: entry.title, oldSeason, canonicalSeason: canonical.season, part: canonical.part, providerEpisodeOffset: canonical.offset });
      }
    });
  }
  return {
    chains: chains.size,
    entries,
    legacyWrongSeasonEntries,
    fixedWrongSeasonEntries: 0,
    legacyProviderOffsetEntries,
    fixedProviderOffsetEntries: 0,
    examples
  };
}

function summarize(records, phase) {
  const correct = records.filter((record) => record[phase].correctMapping);
  const withSources = correct.filter((record) => record[phase].resolution.sourceCount > 0);
  const usable = correct.filter((record) => record[phase].resolution.usable);
  const deadOnly = withSources.filter((record) => !record[phase].resolution.usable);
  return {
    episodesTested: records.length,
    correctlyMapped: correct.length,
    correctlyMappedPercent: Number((correct.length * 100 / Math.max(1, records.length)).toFixed(2)),
    episodesResolvingToSource: withSources.length,
    zeroSource: correct.filter((record) => record[phase].resolution.sourceCount === 0 && record[phase].resolution.failure !== "NOT_PROBED").length,
    notMediaProbed: correct.filter(record => record[phase].resolution.failure === "NOT_PROBED").length,
    deadOnlySource: deadOnly.length,
    confirmedUsable: usable.length,
    confirmedUsablePercent: Number((usable.length * 100 / Math.max(1, records.length)).toFixed(2)),
    wrongSeason: records.length - correct.length,
    failures: records.reduce((counts, record) => {
      const key = record[phase].correctMapping ? (record[phase].resolution.failure || "USABLE") : "WRONG_SEASON";
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {})
  };
}

const metadataPath = fileURLToPath(new URL("../scraper/anime_metadata.json", import.meta.url));
const metadataPayload = JSON.parse(await readFile(metadataPath, "utf8"));
async function readOptionalSnapshot(relativePath) {
  try {
    return JSON.parse(await readFile(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8"));
  } catch {
    return {};
  }
}
const [airingPayload, artworkPayload, fallbackPayload] = await Promise.all([
  readOptionalSnapshot("../scraper/airing-map.json"),
  readOptionalSnapshot("../scraper/artwork-map.json"),
  readOptionalSnapshot("../scraper/regular-source-fallbacks.json")
]);
const catalogWithFallbacks = (Array.isArray(metadataPayload.items) ? metadataPayload.items : [])
  .map((item) => applyVerifiedFallback(item, fallbackPayload.entries || {}));
const slugItems = catalogWithFallbacks
  .filter(isActiveAnimeAv1CatalogItem)
  .map((item) => ({ slug: authoritativeSlug(item), title: item.title || item.name || "" }))
  .filter((item) => item.slug && item.title);
const catalog = catalogWithFallbacks
  .filter(isActiveAnimeAv1CatalogItem)
  .map((item) => {
    const airing = airingPayload.entries?.[item.id] || {};
    const artwork = artworkPayload.entries?.[item.id] || {};
    const metadata = artwork.meta || {};
    return {
      ...item,
      anilistId: item.anilistId || artwork.anilistId || null,
      malId: item.malId || artwork.malId || null,
      tmdbPoster: item.tmdbPoster || artwork.tmdbPoster || "",
      tmdbBackdrop: item.tmdbBackdrop || artwork.tmdbBackdrop || "",
      coverImageLarge: item.coverImageLarge || artwork.anilistCover || artwork.metadataCover || "",
      highQualityBackground: item.highQualityBackground || artwork.anilistBanner || "",
      // The provider's own media type and measured episode count outrank
      // enrichment metadata, matching normalizeExternalShow/getSeasonEpisodeLimit.
      format: item.format || item.type || metadata.format || "",
      status: item.status || airing.airingStatus || metadata.status || "",
      sourceEpisodeCount: item.sourceEpisodeCount || airing.sourceEpisodeCount || null,
      anilistEpisodeCount: item.anilistEpisodeCount || airing.anilistEpisodeCount || metadata.episodes || null,
      latestAiredEp: item.latestAiredEp || airing.latestAiredEp || null,
      nextAiringEpisodeNumber: item.nextAiringEpisodeNumber || airing.nextAiringEpisodeNumber || null,
      franchiseSeasons: item.franchiseSeasons || airing.franchiseSeasons || null
    };
  })
  .filter((item) => !requestedFormats.size || requestedFormats.has(String(item.format || item.type || "").toUpperCase()))
  .filter((item) => !requestedSlugs.size || requestedSlugs.has(authoritativeSlug(item)))
  .slice(0, titleLimit);
const legacyByTitle = new Map();
slugItems.forEach((item) => {
  legacyTitleKeys(item.title, item.slug).forEach((key) => {
    if (key && !legacyByTitle.has(key)) legacyByTitle.set(key, item.slug);
  });
});

const tasks = catalog.flatMap((item) => sampledEpisodeNumbers(item).map((number) => ({ item, number })));
const records = await mapConcurrent(tasks, async ({ item, number }) => {
  const expectedSlug = authoritativeSlug(item);
  const usesVerifiedFallback = hasVerifiedFallback(item)
    && Number(item.sourcePlayableEpisodeCount || 0) <= 0;
  const targetProviderKey = usesVerifiedFallback ? item.fallbackProviderKey : "animeav1";
  const targetSlug = usesVerifiedFallback ? item.fallbackProviderAnimeSlug : expectedSlug;
  const legacyCatalogSlug = legacyByTitle.get(normalizeTitle(item.title || "")) || "";
  // A map miss was not automatically broken in the previous client: it fell
  // through to the slower AniList ID/title search. Model that conservatively as
  // recovering the authoritative row. Only a non-empty, different map slug is
  // a proven old mapping defect.
  const legacySlug = legacyCatalogSlug || expectedSlug;
  const providerNumber = providerEpisodeNumber(item, number);
  const mappingValid = Boolean(targetSlug) && Number.isFinite(providerNumber) && providerNumber >= 0;
  const afterResolution = inventoryOnly ? {
    resolverOk: null, resolverStatus: null, sourceCount: 0, sourceTypes: [], usable: false,
    failure: "NOT_PROBED", providerEpisodeId: providerNumber, media: null
  } : mappingValid ? await resolveEpisode(targetProviderKey, targetSlug, providerNumber) : {
    resolverOk: false, resolverStatus: null, sourceCount: 0, sourceTypes: [], usable: false, failure: "BAD_NORMALIZATION", providerEpisodeId: number
  };
  const beforeResolution = compareLegacy && !inventoryOnly && !usesVerifiedFallback && legacySlug && legacySlug !== expectedSlug
    ? await resolveEpisode("animeav1", legacySlug, providerNumber)
    : afterResolution;
  const internalEpisode = (item.episodes || []).find((episode) => episodeNumber(episode) === number);
  return {
    catalogAnimeId: item.id,
    anilistId: item.anilistId || null,
    malId: item.malId || null,
    title: item.title,
    season: Number(item.seasonNumber) || 1,
    displayedEpisodeNumber: number,
    internalEpisodeId: internalEpisode?.id || `${item.id}-s${Number(item.seasonNumber) || 1}-e${number}`,
    provider: usesVerifiedFallback ? item.fallbackProvider : "AnimeAV1",
    providerEpisodeId: providerNumber,
    expectedSlug: targetSlug,
    legacySlug,
    legacyCatalogSlug,
    before: {
      correctMapping: usesVerifiedFallback || Boolean(legacySlug && legacySlug === expectedSlug),
      resolution: beforeResolution
    },
    after: {
      correctMapping: mappingValid,
      resolution: afterResolution
    }
  };
});

const rawDuplicateEpisodes = catalog.reduce((total, item) => {
  const seen = new Set();
  return total + (item.episodes || []).reduce((count, episode) => {
    const number = episodeNumber(episode);
    const key = `${Number(episode.season) || 1}:${number}`;
    if (seen.has(key)) return count + 1;
    seen.add(key);
    return count;
  }, 0);
}, 0);
const sourceGapCount = catalog.reduce((total, item) => {
  const numbers = new Set((item.episodes || []).map(episodeNumber));
  // Most rows are generated from the provider inventory by the client. Missing
  // enriched metadata is not the same as a missing playable episode.
  return total + sampledEpisodeNumbers(item).filter(number => !numbers.has(number)).length;
}, 0);

const report = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  configuration: {
    episodesPerTitle,
    allEpisodes,
    formats: [...requestedFormats],
    concurrency,
    probeMedia,
    requestTimeoutMs,
    retryAttempts,
    failOnUnusable, inventoryOnly, compareLegacy, requestPauseMs,
    requestedSlugs: [...requestedSlugs]
  },
  evidence: inventoryOnly ? "Full static provider inventory/mapping audit; no remote media tested"
    : "Bounded metadata/media reachability samples; not a browser decode, complete-stream, or buffering certification",
  requestsMade,
  stopReason: stopReason || null,
  completed: records.length === tasks.length,
  catalog: {
    animeTested: catalog.length,
    seasonsRepresented: new Set(catalog.map((item) => `${item.anilistId || item.id}:${Number(item.seasonNumber) || 1}`)).size,
    logicalEpisodesRepresented: catalog.reduce((sum, item) => sum + (catalogEpisodeLimit(item) || 0), 0),
    episodeMappingsChecked: records.length,
    episodeSamplesTested: inventoryOnly ? 0 : records.length,
    episodeSamplesPlanned: inventoryOnly ? 0 : tasks.length,
    rawDuplicateEpisodes,
    generatedEpisodeRowsWithoutEnrichment: sourceGapCount,
    titlesWithPoster: catalog.filter((item) => Boolean(item.tmdbPoster || item.coverImageLarge || item.poster || item.image)).length,
    titlesWithBackground: catalog.filter((item) => Boolean(
      item.tmdbBackdrop
      || item.highQualityBackground
      || item.banner
      || item.tmdbPoster
      || item.coverImageLarge
      || item.poster
      || item.image
    )).length
  },
  before: compareLegacy ? { ...summarize(records, "before"), evidence: "Counterfactual legacy mapping analysis; NOT a measured before/after performance comparison" } : null,
  after: summarize(records, "after"),
  relations: relationMetrics(catalog),
  records: inventoryOnly ? records.filter(record => !record.after.correctMapping) : records
};

const outputPath = args.output
  ? path.resolve(String(args.output))
  : path.resolve("artifacts", `regular-playability-audit-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`);
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

process.stdout.write(`${JSON.stringify({
  outputPath,
  catalog: report.catalog,
  before: report.before,
  after: report.after,
  evidence: report.evidence,
  requestsMade,
  stopReason: report.stopReason,
  completed: report.completed,
  relations: report.relations
}, null, 2)}\n`);

if (failOnUnusable && (stopReason || (inventoryOnly
  ? report.after.correctlyMapped !== tasks.length
  : report.after.confirmedUsable !== tasks.length))) {
  process.exitCode = 1;
}
