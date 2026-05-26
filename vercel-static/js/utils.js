// Pure utility functions — no DOM or state dependencies.
// readUiPreferences and readAniPubFallbackCache are here because state.js calls them during init.

function readUiPreferences() {
  try {
    return {
      motion: true,
      focusGlow: true,
      autoplayHero: true,
      ...JSON.parse(localStorage.getItem(APP_UI_PREFS_KEY) || "{}")
    };
  } catch (error) {
    return { motion: true, focusGlow: true, autoplayHero: true };
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
  return normalizeTitle(value)
    .replace(/\b(season|cour|part|chapter)\s*\d+\b/g, "")
    .replace(/\b\d+(st|nd|rd|th)?\s*season\b/g, "")
    .replace(/\b(final|new)\s*season\b/g, "")
    .replace(/\b(s\d+|season\s*[ivxlcdm]+)\b/g, "")
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

function cleanDescription(value) {
  if (!value) return "No synopsis is available yet. You can still favorite it and connect your own playback link.";
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?[^>]+(>|$)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
}

function formatCount(value, label) {
  const count = Number(value) || 0;
  return `${count.toLocaleString()} ${label}${count === 1 ? "" : "s"}`;
}

function getShowKey(show) {
  if (show.malId) return `mal-${show.malId}`;
  if (show.anilistId) return `anilist-${show.anilistId}`;
  const titles = [show.title, ...(show.aliases || [])].filter(Boolean);
  return `title-${normalizeTitle(titles[0] || "")}`;
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
