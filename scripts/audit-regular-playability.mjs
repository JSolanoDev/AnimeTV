import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { normalizeTitle } = require("../js/utils.js");
const SeasonNormalization = require("../js/season-normalization.js");

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, "").split("=");
  return [key, rest.length ? rest.join("=") : true];
}));
const baseUrl = String(args.base || "http://localhost:4173").replace(/\/$/, "");
const episodesPerTitle = Math.max(1, Math.min(5, Number(args["episodes-per-title"] || 2)));
const concurrency = Math.max(1, Math.min(16, Number(args.concurrency || 6)));
const titleLimit = args.limit ? Math.max(1, Number(args.limit)) : Infinity;
const probeMedia = args["probe-media"] !== "false";
const requestTimeoutMs = Math.max(2500, Number(args.timeout || 12000));
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

function episodeNumber(item = {}) {
  for (const value of [item.canonicalEpisode, item.episode, item.number, item.episodeNumber]) {
    const number = Number(value);
    if (value !== "" && value != null && Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

function catalogEpisodeLimit(item = {}) {
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
  const sourceNumbers = (Array.isArray(item.episodes) ? item.episodes : []).map(episodeNumber).filter(Number.isFinite);
  const specials = sourceNumbers.filter((number) => number === 0 || !Number.isInteger(number));
  const limit = catalogEpisodeLimit(item);
  const candidates = [];
  if (limit && limit > 0) {
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
  if (status === 408 || /timeout|abort/i.test(detail)) return "SOURCE_TIMEOUT";
  return "NO_SOURCE";
}

async function fetchWithDeadline(url, options = {}, timeoutMs = requestTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { redirect: "follow", ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, timeoutMs = requestTimeoutMs) {
  const response = await fetchWithDeadline(url, {}, timeoutMs);
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) throw new Error(`${url} returned HTTP ${response.status}`);
  return payload;
}

async function validateMediaSource(source = {}) {
  const rawUrl = source.videoUrl || source.url || "";
  if (!rawUrl) return { usable: false, failure: "NO_SOURCE", httpStatus: null, manifestType: "" };
  const url = new URL(rawUrl, baseUrl).toString();
  const hls = source.container === "hls"
    || /mpegurl/i.test(source.mimeType || source.contentType || "")
    || /\.m3u8(?:$|[?#])/i.test(url)
    || /\/api\/(?:source|stream)/.test(new URL(url).pathname);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    // Keep the abort signal alive until the body is consumed. A media proxy can
    // send headers and then stall; timing only fetch() would leave the scanner
    // waiting forever in response.text()/arrayBuffer().
    const response = await fetch(url, {
      redirect: "follow",
      ...(hls ? {} : { headers: { Range: "bytes=0-1023" } }),
      signal: controller.signal
    });
    if (!response.ok && response.status !== 206) {
      return { usable: false, failure: failureCode(response.status), httpStatus: response.status, manifestType: "" };
    }
    const contentType = response.headers.get("content-type") || "";
    if (hls || /mpegurl/i.test(contentType)) {
      const text = await response.text();
      if (!/^#EXTM3U/m.test(text)) {
        return { usable: false, failure: "BAD_MANIFEST", httpStatus: response.status, manifestType: "invalid" };
      }
      const manifestType = /#EXT-X-STREAM-INF/i.test(text) ? "master" : /#EXTINF/i.test(text) ? "media" : "hls";
      const firstReference = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#"));
      let relativeReferenceResolves = null;
      if (firstReference) {
        try {
          relativeReferenceResolves = Boolean(new URL(firstReference, response.url || url));
        } catch {
          relativeReferenceResolves = false;
        }
      }
      if (relativeReferenceResolves === false) {
        return { usable: false, failure: "BAD_MANIFEST", httpStatus: response.status, manifestType, relativeReferenceResolves };
      }
      return { usable: true, failure: "", httpStatus: response.status, manifestType, relativeReferenceResolves };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      usable: bytes.byteLength > 0,
      failure: bytes.byteLength ? "" : "BAD_MANIFEST",
      httpStatus: response.status,
      manifestType: "file"
    };
  } catch (error) {
    return { usable: false, failure: failureCode(408, error.message), httpStatus: null, manifestType: "", detail: error.message };
  } finally {
    clearTimeout(timer);
  }
}

const sourceResolutionCache = new Map();
const mediaValidationCache = new Map();

async function resolveEpisode(slug, providerEpisodeId) {
  const key = `${slug}:${providerEpisodeId}`;
  if (!sourceResolutionCache.has(key)) {
    sourceResolutionCache.set(key, (async () => {
      const url = `${baseUrl}/api/animeav1/sources?slug=${encodeURIComponent(slug)}&episode=${encodeURIComponent(providerEpisodeId)}&variant=SUB`;
      try {
        const response = await fetchWithDeadline(url);
        const payload = await response.json().catch(() => null);
        const sources = Array.isArray(payload?.sources) ? payload.sources : [];
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
        let media = { usable: true, failure: "", httpStatus: null, manifestType: "not-probed" };
        if (probeMedia) {
          const ranked = sources.filter((source) => source.videoUrl || source.url);
          media = { usable: false, failure: "NO_SOURCE", httpStatus: null, manifestType: "" };
          for (const source of ranked) {
            const mediaKey = source.videoUrl || source.url;
            if (!mediaValidationCache.has(mediaKey)) {
              mediaValidationCache.set(mediaKey, validateMediaSource(source));
            }
            const result = await mediaValidationCache.get(mediaKey);
            if (result.usable) {
              media = result;
              break;
            }
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

async function mapConcurrent(items, worker, size = concurrency) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
      if ((index + 1) % 100 === 0 || index + 1 === items.length) {
        process.stdout.write(`Audited ${index + 1}/${items.length} episode samples\n`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
  return results;
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
    zeroSource: correct.filter((record) => record[phase].resolution.sourceCount === 0).length,
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
const slugItems = (Array.isArray(metadataPayload.items) ? metadataPayload.items : [])
  .filter((item) => /animeav1/i.test(String(item.source || item.id || item.siteUrl || "")))
  .map((item) => ({ slug: authoritativeSlug(item), title: item.title || item.name || "" }))
  .filter((item) => item.slug && item.title);
async function readOptionalSnapshot(relativePath) {
  try {
    return JSON.parse(await readFile(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8"));
  } catch {
    return {};
  }
}
const [airingPayload, artworkPayload] = await Promise.all([
  readOptionalSnapshot("../scraper/airing-map.json"),
  readOptionalSnapshot("../scraper/artwork-map.json")
]);
const catalog = (Array.isArray(metadataPayload.items) ? metadataPayload.items : [])
  .filter((item) => /animeav1/i.test(String(item.source || item.id || item.siteUrl || "")))
  .map((item) => {
    const airing = airingPayload.entries?.[item.id] || {};
    const artwork = artworkPayload.entries?.[item.id] || {};
    const metadata = artwork.meta || {};
    return {
      ...item,
      anilistId: item.anilistId || artwork.anilistId || null,
      malId: item.malId || artwork.malId || null,
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
  const legacyCatalogSlug = legacyByTitle.get(normalizeTitle(item.title || "")) || "";
  // A map miss was not automatically broken in the previous client: it fell
  // through to the slower AniList ID/title search. Model that conservatively as
  // recovering the authoritative row. Only a non-empty, different map slug is
  // a proven old mapping defect.
  const legacySlug = legacyCatalogSlug || expectedSlug;
  const afterResolution = expectedSlug ? await resolveEpisode(expectedSlug, number) : {
    resolverOk: false, resolverStatus: null, sourceCount: 0, sourceTypes: [], usable: false, failure: "BAD_NORMALIZATION", providerEpisodeId: number
  };
  const beforeResolution = legacySlug && legacySlug !== expectedSlug
    ? await resolveEpisode(legacySlug, number)
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
    provider: "AnimeAV1",
    providerEpisodeId: number,
    expectedSlug,
    legacySlug,
    legacyCatalogSlug,
    before: {
      correctMapping: Boolean(legacySlug && legacySlug === expectedSlug),
      resolution: beforeResolution
    },
    after: {
      correctMapping: Boolean(expectedSlug),
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
  const numbers = new Set((item.episodes || []).map(episodeNumber).filter((number) => Number.isInteger(number) && number > 0));
  const limit = catalogEpisodeLimit(item) || 0;
  let missing = 0;
  for (let number = 1; number <= Math.min(limit, 2000); number += 1) if (!numbers.has(number)) missing += 1;
  return total + missing;
}, 0);

const report = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  configuration: { episodesPerTitle, concurrency, probeMedia, requestTimeoutMs },
  catalog: {
    animeTested: catalog.length,
    seasonsRepresented: new Set(catalog.map((item) => `${item.anilistId || item.id}:${Number(item.seasonNumber) || 1}`)).size,
    logicalEpisodesRepresented: catalog.reduce((sum, item) => sum + (catalogEpisodeLimit(item) || 0), 0),
    episodeSamplesTested: records.length,
    rawDuplicateEpisodes,
    sourceMetadataGaps: sourceGapCount
  },
  before: summarize(records, "before"),
  after: summarize(records, "after"),
  relations: relationMetrics(catalog),
  records
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
  relations: report.relations
}, null, 2)}\n`);
