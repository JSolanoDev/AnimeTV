// Pure utility functions — no DOM or state dependencies.
// readUiPreferences and readAniPubFallbackCache are here because state.js calls them during init.

function readUiPreferences() {
  const defaults = {
    motion: true,
    focusGlow: true,
    autoplayHero: true,
    defaultVolume: 0.1,
    playerFit: "cover",
    playerEngine: "apk",
    playerQuality: 0,
    metadataDetail: true,
    subtitleTranslation: true,
    titleLanguage: "romaji",  // "english" | "romaji"
  };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(APP_UI_PREFS_KEY) || "{}") };
  } catch (error) {
    return defaults;
  }
}

function readAniPubFallbackCache() {
  try {
    const cache = JSON.parse(localStorage.getItem(ANIPUB_FALLBACK_CACHE_KEY) || "{}");
    if (!cache.timestamp || Date.now() - cache.timestamp > ANIPUB_FALLBACK_CACHE_TTL) {
      localStorage.removeItem(ANIPUB_FALLBACK_CACHE_KEY);
      return {};
    }
    return cache.items || {};
  } catch (error) {
    return {};
  }
}

/**
 * Return the display title for a show, respecting the user's titleLanguage setting.
 * Falls back gracefully: romaji -> english -> title field -> "Untitled Anime".
 */
function getShowTitle(show) {
  if (!show) return "Untitled Anime";
  // Defensive: a title may be a plain string OR an AniList object
  // ({english, romaji, native}). Always resolve to a string so callers like the
  // weekly schedule (escapeHtml/normalizeTitle) never get an object.
  const asString = (value) => {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      return value.english || value.userPreferred || value.romaji || value.native || "";
    }
    return "";
  };
  const english = asString(show.title) || (show.title && typeof show.title === "object" ? asString(show.title.english) : "");
  const romaji = asString(show.romajiTitle)
    || (show.title && typeof show.title === "object" ? asString(show.title.romaji) : "");
  const pref = (state?.uiPreferences?.titleLanguage) || "english";
  if (pref === "romaji") return romaji || english || "Untitled Anime";
  return english || romaji || "Untitled Anime";
}

function saveAniPubFallbackCache() {
  localStorage.setItem(ANIPUB_FALLBACK_CACHE_KEY, JSON.stringify({
    timestamp: Date.now(),
    items: state.anipubFallbackCache
  }));
}

function readResponseCache(key) {
  try {
    const cached = JSON.parse(localStorage.getItem(`${RESPONSE_CACHE_PREFIX}${key}`) || "null");
    if (!cached?.timestamp || Date.now() - cached.timestamp > RESPONSE_CACHE_TTL) {
      localStorage.removeItem(`${RESPONSE_CACHE_PREFIX}${key}`);
      return null;
    }
    return cached.data;
  } catch (error) {
    return null;
  }
}

function writeResponseCache(key, data) {
  try {
    localStorage.setItem(`${RESPONSE_CACHE_PREFIX}${key}`, JSON.stringify({
      timestamp: Date.now(),
      data
    }));
  } catch (error) {
    // Cache writes are best-effort on Android TV WebView storage.
  }
}

async function timedRequest(label, task) {
  console.time(label);
  try {
    return await task();
  } finally {
    console.timeEnd(label);
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = API_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

async function fetchWithRetry(url, options = {}, attempts = 1) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, options);
      if (response.ok || ![408, 429, 500, 502, 503, 504].includes(response.status)) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(650 * (attempt + 1));
  }
  throw lastError || new Error("Request failed");
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function normalizeTitle(value) {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(season|part|tv|ova|ona|the|a|an)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getFranchiseKey(value) {
  // Strip season markers from the RAW title first — normalizeTitle removes the
  // word "season" itself, so patterns that rely on it must run beforehand.
  const stripped = String(value || "")
    // "4th Season: subtitle" / "4th Season Part 2" etc.
    .replace(/\s+\d+(st|nd|rd|th)\s*season\b.*/gi, "")
    // "Season 2" / "Season II" / "Season IV" and everything after
    .replace(/\s+season\s*\d+\b.*/gi, "")
    .replace(/\s+season\s+(iv|iii|ii|v|vi|vii|viii|ix|x)\b.*/gi, "")
    // ": The Final Season" / ": Final Season" etc.
    .replace(/:\s*(the\s+)?(final|new)\s+season\b.*/gi, "")
    // " Final Season" / " New Season" at end
    .replace(/\s+(final|new)\s+season\b.*/gi, "")
    // "Part N" / "Cour N" and everything after
    .replace(/\s+(cour|part)\s*\d+\b.*/gi, "");

  return normalizeTitle(stripped)
    // Catch any leftover season tokens that survived normalizeTitle
    .replace(/\b(s\d+)\b/g, "")
    .replace(/\b(2nd|3rd|4th|5th)\b/g, "")
    .replace(/\b\d+\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSeasonNumber(title, fallback = 1) {
  const text = String(title || "").toLowerCase();
  const explicit = text.match(/(?:season|part|cour|s)\s*[\[(]*(\d+)|(\d+)(st|nd|rd|th)\s*season|第\s*(\d+)\s*期|(\d+)\s*期/);
  const roman = text.match(/season\s*[\[(]*(iv|iii|ii|v|vi|vii|viii|ix|x)\b/);
  const words = text.match(/\b(second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+season\b/);
  if (explicit) return Number(explicit[1] || explicit[2] || explicit[4] || explicit[5]);
  if (roman) return romanToNumber(roman[1]);
  if (words) return wordSeasonToNumber(words[1]);
  return fallback;
}

function romanToNumber(value) {
  const table = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
  return table[String(value).toLowerCase()] || 1;
}

function wordSeasonToNumber(value) {
  const table = { second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
  return table[String(value).toLowerCase()] || 1;
}

function pickGenre(genres = []) {
  const normalized = genres.map((genre) => genre.toLowerCase());
  if (normalized.includes("action")) return "action";
  if (normalized.includes("comedy")) return "comedy";
  if (normalized.includes("fantasy")) return "fantasy";
  if (normalized.includes("romance")) return "romance";
  if (normalized.includes("drama")) return "drama";
  return normalized[0] || "anime";
}

function cleanDescription(value, maxLength = 320) {
  if (!value) return "No synopsis is available yet. You can still favorite it and connect your own playback link.";
  // Strip HTML safely (incl. entities), collapse whitespace.
  const text = String(value)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?[^>]+(>|$)/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLength) return text;
  // Truncate at the last COMPLETE word (never mid-word like "...No") and add "…".
  const clipped = text.slice(0, maxLength);
  const lastSpace = clipped.lastIndexOf(" ");
  const safe = (lastSpace > maxLength * 0.5 ? clipped.slice(0, lastSpace) : clipped)
    .replace(/[\s,.;:!?-]+$/, "");
  return `${safe}…`;
}

function formatCount(value, label) {
  const count = Number(value) || 0;
  return `${count.toLocaleString()} ${label}${count === 1 ? "" : "s"}`;
}

function getShowKey(show) {
  // Stable identifiers first (AniList, then MAL) so different adaptations with
  // the same title (Doraemon 1973 / 1979 / 2005) never collapse together.
  if (show.anilistId) return `anilist-${show.anilistId}`;
  if (show.malId) return `mal-${show.malId}`;
  // Last resort: title + start year + format — never title alone.
  const titles = [show.title, ...(show.aliases || [])].filter(Boolean);
  const base = normalizeTitle(titles[0] || "");
  const year = show.year || show.seasonYear || show.startDate?.year || "unknown";
  const fmt = String(show.format || show.type || "unknown").toLowerCase();
  return `title-${base}:${year}:${fmt}`;
}

function cssSafeId(value) {
  return String(value || "addon").replace(/[^a-z0-9_-]+/gi, "-");
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[char]));
}

function fullDayName(day) {
  return {
    Mon: "Monday",
    Tue: "Tuesday",
    Wed: "Wednesday",
    Thu: "Thursday",
    Fri: "Friday",
    Sat: "Saturday",
    Sun: "Sunday"
  }[day] || day;
}

function isSpanishLanguage(value) {
  return /\b(es|spa|spanish|español|castellano)\b/i.test(String(value || ""));
}

function languageName(value) {
  const code = String(value || "").toLowerCase();
  return {
    es: "Spanish",
    spa: "Spanish",
    en: "English",
    eng: "English",
    ja: "Japanese",
    jpn: "Japanese",
    fr: "French",
    pt: "Portuguese",
    de: "German",
    it: "Italian"
  }[code] || value;
}

function simpleHash(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash |= 0;
  }
  return String(hash).replace("-", "n");
}

function sortCarouselQuality(items) {
  return [...items].sort((a, b) => {
    const bannerScore = Number(Boolean(b.banner)) - Number(Boolean(a.banner));
    if (bannerScore) return bannerScore;
    const sourceScore = Number(String(b.source).includes("AniList")) - Number(String(a.source).includes("AniList"));
    if (sourceScore) return sourceScore;
    return Number(b.score || 0) - Number(a.score || 0);
  });
}

function normalizeSourceUrl(value) {
  try {
    const url = new URL(String(value).trim());
    if (!/^https?:$/i.test(url.protocol)) return "";
    return url.toString();
  } catch (error) {
    return "";
  }
}

function isOnlineSource(endpoint) {
  try {
    const { hostname } = new URL(endpoint);
    return !["127.0.0.1", "localhost", "::1"].includes(hostname) && !/^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);
  } catch (error) {
    return true;
  }
}

function setDefaultLanguage(audio = "japanese", subtitles = "spanish") {
  const preferences = { audio, subtitles };
  localStorage.setItem(LANGUAGE_PREFERENCES_KEY, JSON.stringify(preferences));
  fetch("./api/language/preferences", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(preferences)
  }).catch(() => {});
  return preferences;
}

// ── Season grouping validation ───────────────────────────────────────────────
// Different adaptations/remakes must NOT be grouped as seasons of one anime,
// even when AniList chains them via SEQUEL/PREQUEL (e.g. Doraemon 1973 TV ->
// 1979 TV_SHORT -> 2005 TV) or they share a normalized title.

function mediaStartYear(m) {
  if (!m) return null;
  const y = Number(m.seasonYear || m.startDate?.year || m.year || m.startYear);
  return Number.isFinite(y) && y > 0 ? y : null;
}

function mediaFormat(m) {
  return String(m?.format || m?.type || "").toUpperCase();
}

// Should a SEQUEL/PREQUEL link be followed as the SAME continuous anime (a real
// next/previous season) rather than a separate adaptation? A format change
// almost always means a different adaptation (Doraemon TV <-> TV_SHORT), UNLESS
// it aired within ~3 years — e.g. a "Final Chapters" SPECIAL right after a TV
// finale, which is a genuine continuation.
function canFollowSeasonLink(fromMedia, candidate) {
  const f1 = mediaFormat(fromMedia);
  const f2 = mediaFormat(candidate);
  if (f1 && f2 && f1 !== f2) {
    const y1 = mediaStartYear(fromMedia);
    const y2 = mediaStartYear(candidate);
    if (y1 && y2 && Math.abs(y2 - y1) > 3) return false;
  }
  return true;
}

// Validate whether `candidate` is a true season of `parent`. Works on AniList
// media objects (with `.relations.edges`) and on catalog show objects.
//   1. same stable id (AniList) or idMal  -> same work
//   2. otherwise require an explicit SEQUEL/PREQUEL relation
//   3. and a compatible format / air-year (reject remakes)
function canGroupAsSeason(parent, candidate) {
  if (!parent || !candidate) return false;

  const pid = parent.id ?? parent.anilistId;
  const cid = candidate.id ?? candidate.anilistId;
  if (pid != null && cid != null && pid === cid) return true;

  const pmal = parent.idMal ?? parent.malId;
  const cmal = candidate.idMal ?? candidate.malId;
  if (pmal != null && cmal != null && pmal === cmal) return true;

  const edges = parent.relations?.edges || [];
  if (!edges.length) return false; // no relation data -> cannot assert a season

  const validRelation = edges.some((edge) =>
    edge.node && (edge.node.id === cid) &&
    (edge.relationType === "SEQUEL" || edge.relationType === "PREQUEL")
  );
  if (!validRelation) return false;

  return canFollowSeasonLink(parent, candidate);
}

// Node export so the logic can be unit-tested without a browser/DOM.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    normalizeTitle,
    getFranchiseKey,
    extractSeasonNumber,
    getShowKey,
    cleanDescription,
    mediaStartYear,
    mediaFormat,
    canFollowSeasonLink,
    canGroupAsSeason
  };
}
