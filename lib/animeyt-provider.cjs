"use strict";

const { load } = require("cheerio");
const fs = require("node:fs");

const ORIGIN = "https://animeyt.cc";
const CONTAINER_ORIGIN = "https://mytsumi.com";
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ENTRIES = 400;

function titleIdentity(value = "") {
  let title = String(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  title = title.replace(/[-_]/g, " ");
  let season = 1;
  title = title.replace(/\b(?:temporada|season)\s*(\d{1,2})\b|\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:season|temporada)\b/g, (_, a, b) => {
    if (Number(a || b) > 100) return _;
    season = Number(a || b);
    return " ";
  });
  title = title.replace(/\s+(ii|iii|iv|v)\s*$/, (_, roman) => {
    season = { ii: 2, iii: 3, iv: 4, v: 5 }[roman];
    return " ";
  });
  return { base: title.replace(/[^a-z0-9]/g, ""), season };
}

function seriesSlug(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/tv\/([a-z0-9-]+)\/?$/);
    return url.origin === ORIGIN && match && SLUG.test(match[1]) ? match[1] : "";
  } catch { return ""; }
}

function catalogRows(rows = []) {
  const $ = load("");
  return rows.map(row => {
    const slug = seriesSlug(row.link);
    const title = $("<span>").html(row.title?.rendered || "").text().trim();
    if (!slug || !title) return null;
    return { slug, title, season: titleIdentity(slug).season };
  }).filter(Boolean);
}

function parseSchedule(html) {
  const $ = load(html);
  const events = [];
  $("[data-aniyt-schedule-event]").each((_, element) => {
    const node = $(element);
    const slug = seriesSlug(node.attr("href"));
    const at = Number(node.attr("data-aniyt-ts")) * 1000;
    const episode = Number(node.text().match(/\bEP\s*(\d+)\b/i)?.[1]);
    if (slug && Number.isSafeInteger(at) && at > 0 && episode > 0) events.push({ slug, at, episode });
  });
  return events;
}

function parseEpisodes(html, expectedSeason = 0, expectedTitle = "") {
  const $ = load(html);
  const episodes = [];
  const heading = titleIdentity($("h1.aniyt-series-title-line").text());
  const inheritedSeason = expectedSeason > 0 && heading.base === titleIdentity(expectedTitle).base
    && heading.season === expectedSeason ? expectedSeason : 0;
  $("[data-episode-id]").each((_, element) => {
    const node = $(element);
    const href = node.find("a.aniyt-episode-media").attr("href");
    const episode = Number(node.find(".aniyt-episode-meta-chip--episode").text().match(/EP\s*(\d+(?:\.\d+)?)/i)?.[1]);
    const season = Number(node.find(".aniyt-episode-card-meta").text().match(/\bT\s*(\d+)\b/i)?.[1]) || inheritedSeason;
    try {
      const url = new URL(href);
      if (url.origin === ORIGIN && /^\/\d+\/anime\/[a-z0-9-]+\/?$/.test(url.pathname)
        && episode > 0 && season > 0) episodes.push({ episode, season, url: url.href });
    } catch { /* A malformed link is not an episode. */ }
  });
  return episodes;
}

function parseContainer(html) {
  const $ = load(html);
  for (const element of $("iframe[data-src], iframe[src]").toArray()) {
    try {
      const url = new URL($(element).attr("data-src") || $(element).attr("src"));
      if (url.origin !== CONTAINER_ORIGIN || url.username || url.password) continue;
      if (url.pathname === "/multiplayer/options.php" && url.searchParams.get("server") === "multi"
        && /^[a-zA-Z0-9_-]{8,64}$/.test(url.searchParams.get("value") || "")) {
        // The legacy public Play link uses the same value as contenedor.php's
        // id. Read that declared player table without running its ad scripts.
        return `${CONTAINER_ORIGIN}/multiplayer/contenedor.php?id=${encodeURIComponent(url.searchParams.get("value"))}`;
      }
      if (url.pathname !== "/container.php") continue;
      if (!/^[a-zA-Z0-9_-]{8,64}$/.test(url.searchParams.get("id") || "")) continue;
      // Follow the site's public "open" link, not an ad or a player iframe.
      const target = new URL("/container.php", CONTAINER_ORIGIN);
      target.searchParams.set("id", url.searchParams.get("id"));
      target.searchParams.set("open", "1");
      target.searchParams.set("only", "SUB");
      target.searchParams.set("lang", "SUB");
      return target.href;
    } catch { /* Ignore unrelated embeds. */ }
  }
  return "";
}

function parseNativeSources(html) {
  const $ = load(html);
  const sources = [];
  const seen = new Set();
  const admit = (value, label) => {
    if (!/^omega$/i.test(label || "")) return;
    try {
      const url = new URL(value);
      // Only the tested direct-media host. New hosted players are not silently
      // promoted to native streams, nor are download links treated as players.
      if (url.protocol !== "https:" || url.username || url.password || url.port
        || !/(^|\.)archive\.org$/i.test(url.hostname) || !/\.mp4$/i.test(url.pathname)
        || url.search || url.hash || seen.has(url.href)) return;
      seen.add(url.href);
      sources.push({ provider: "Omega", videoUrl: url.href, type: "direct", mimeType: "video/mp4" });
    } catch { /* Keep unsupported hosts on the existing fallback path. */ }
  };
  $("button[data-player-url][data-player-kind='video']").each((_, element) => {
    const node = $(element);
    admit(node.attr("data-player-url"), node.attr("data-player-label"));
  });
  $("script:not([src])").each((_, element) => {
    const data = $(element).text().match(/\bconst\s+videoTabs\s*=\s*(\[[\s\S]*?\])\s*;/)?.[1];
    if (!data) return;
    try {
      const rows = JSON.parse(data);
      rows.filter(row => row.status === "active" && row.is_mp4 === true && row.is_fake_player !== true)
        .forEach(row => admit(row.url, row.tab_name));
    } catch { /* Not a JSON player table; never execute upstream code. */ }
  });
  return sources;
}

function buildIdentityIndex(items = []) {
  const index = new Map();
  for (const row of items) {
    if (!SLUG.test(row.slug || "") || !row.title || !(row.season > 0)) continue;
    for (const value of [row.title, row.slug]) {
      const identity = titleIdentity(value);
      const key = `${identity.base}:${row.season}`;
      const bucket = index.get(key) || [];
      if (!bucket.some(item => item.slug === row.slug)) bucket.push(row);
      index.set(key, bucket);
    }
  }
  return index;
}

function matchTitle(index, titles, explicitSeason = 0) {
  for (const title of titles) {
    const identity = titleIdentity(title);
    // An explicit sequel in the title must agree with the selected season.
    if (explicitSeason && identity.season !== 1 && identity.season !== explicitSeason) continue;
    const matches = index.get(`${identity.base}:${explicitSeason || identity.season}`) || [];
    if (matches.length === 1) return matches[0];
  }
  return null;
}

function createProvider({ indexPath, snapshot: suppliedSnapshot, fetchImpl = fetch, now = Date.now, debug = false } = {}) {
  let snapshot = { items: [], schedule: [] };
  try { snapshot = JSON.parse(fs.readFileSync(indexPath, "utf8")); } catch { /* No index: retain existing providers. */ }
  if (suppliedSnapshot) snapshot = suppliedSnapshot;
  const identities = buildIdentityIndex(snapshot.items);
  const cache = new Map();
  const inflight = new Map();
  let retryAt = 0;
  const remember = (key, data, ttl) => {
    cache.delete(key);
    cache.set(key, { data, expires: now() + ttl });
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
    return data;
  };
  async function coalesced(key, ttl, task) {
    const hit = cache.get(key);
    if (hit && hit.expires > now()) {
      if (debug) console.info(`[animeyt] HIT ${key}`);
      return hit.data;
    }
    if (inflight.has(key)) return inflight.get(key);
    if (debug) console.info(`[animeyt] MISS ${key}`);
    const promise = Promise.resolve().then(task).then(data => remember(key, data, data === null ? 30000 : ttl))
      .catch(error => {
        if (!key.startsWith("source:") && hit && now() - hit.expires < 86400000) return hit.data;
        throw error;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }
  async function html(url) {
    const target = new URL(url);
    if (![ORIGIN, CONTAINER_ORIGIN].includes(target.origin)) throw new Error("Unsupported AnimeYT origin");
    if (retryAt > now()) {
      const error = new Error("AnimeYT is cooling down");
      error.retryAfter = Math.ceil((retryAt - now()) / 1000);
      throw error;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const start = now();
    try {
      const response = await fetchImpl(url, { signal: controller.signal, redirect: "error",
        headers: { Accept: "text/html", "User-Agent": "ZenkaiTV/2.0" } });
      if (!response.ok) {
        const value = response.headers.get("retry-after");
        const retryMs = /^\d+$/.test(value || "") ? Number(value) * 1000 : Math.max(0, Date.parse(value) - now()) || 0;
        if (response.status === 429 || response.status === 403 || response.status >= 500) retryAt = now() + Math.max(30000, retryMs);
        const error = new Error(`AnimeYT upstream HTTP ${response.status}`);
        error.retryAfter = Math.ceil(Math.max(0, retryAt - now()) / 1000);
        throw error;
      }
      let size = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { controller.abort(); throw new Error("AnimeYT page too large"); }
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString("utf8");
    } catch (error) {
      retryAt = Math.max(retryAt, now() + 15000);
      throw error;
    } finally {
      clearTimeout(timer);
      if (debug) console.info(`[animeyt] upstream ${target.hostname}${target.pathname} ${now() - start}ms`);
    }
  }
  function match(titles, season) { return matchTitle(identities, titles, season); }
  function enrich(item) {
    const row = match([item.title, item.romajiTitle, item.englishTitle, ...(Array.isArray(item.aliases) ? item.aliases : [])].filter(v => typeof v === "string"), Number(item.canonicalSeasonNumber) || 0);
    if (!row) return item;
    const events = (snapshot.schedule || []).filter(event => event.slug === row.slug
      && event.at > now() && event.at < now() + 7 * 86400000).sort((a, b) => a.at - b.at);
    const event = events[0];
    // Prefer the requested provider's release clock only for the same episode.
    // A different episode/reschedule remains on the existing metadata clock.
    const knownEpisode = Number(item.nextAiringEpisodeNumber);
    const supplement = event && (!(Number(item.nextAiringAt) > now())
      || (knownEpisode === event.episode && Math.abs(Number(item.nextAiringAt) - event.at) < 86400000));
    return { ...item, animeytSlug: row.slug, animeytSeason: row.season,
      ...(supplement ? { nextAiringAt: event.at, confirmedNextAiringAt: event.at,
        nextAiringEpisodeNumber: event.episode, airingTimeSource: "AnimeYT",
        animeytAiringAt: event.at, animeytAiringEpisode: event.episode } : {}) };
  }
  async function sources({ titles = [], season = 0, episode, language = "sub" }) {
    if (language !== "sub") return null;
    const row = match(titles, season);
    if (!row || !Number.isFinite(episode) || episode <= 0) return null;
    const key = `source:${row.slug}:${season || row.season}:${episode}:sub`;
    return coalesced(key, 60000, async () => {
      const episodes = await coalesced(`episodes:${row.slug}`, 300000, async () => parseEpisodes(await html(`${ORIGIN}/tv/${row.slug}/`), row.season, row.title));
      const matches = episodes.filter(entry => entry.episode === episode && entry.season === (season || row.season));
      if (matches.length !== 1) return null;
      const page = matches[0].url;
      const container = await coalesced(`container:${page}`, 300000, async () => parseContainer(await html(page)) || null);
      if (!container) return null;
      const entries = parseNativeSources(await html(container));
      if (!entries.length) return null;
      return { ok: true, source: "AnimeYT", episode, season: season || row.season, requestedLanguage: "sub",
        siteUrl: page, match: { slug: row.slug }, sources: entries };
    });
  }
  return { sources, enrich, match, snapshot };
}

module.exports = { createProvider, titleIdentity, catalogRows, seriesSlug, parseSchedule,
  parseEpisodes, parseContainer, parseNativeSources, buildIdentityIndex, matchTitle };
