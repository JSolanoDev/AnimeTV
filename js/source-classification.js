/**
 * Source classification and ranking.
 *
 * Extracted verbatim from client.js. These decide WHICH playback source wins:
 * what a source is (AnimeAV1 / JKAnime / HLS / MP4Upload / adult), whether it is
 * blocked, and how candidates are ordered - sourcePreferenceScore() is why an
 * AnimeAV1 HLS stream opens first.
 *
 * Pure by design: no `state`, no DOM, nothing runs at load time. It is a classic
 * script sharing the one global scope, loaded BEFORE client.js, so the few
 * externals it calls (normalizeEpisodeSourceOptions, isLocalSourceProxyUrl,
 * AdultMode.isAdultContent) resolve at CALL time once client.js has loaded.
 */

function sourceIdentityText(source = {}) {
  return [
    source.id,
    source.label,
    source.provider,
    source.server,
    source.type,
    source.videoUrl,
    source.externalUrl,
    source.siteUrl,
    source.streamResolver?.type,
    source.streamResolver?.endpoint
  ].filter(Boolean).join(" ").toLowerCase();
}

function isBlockedPlaybackUrl(value = "") {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "candy.ai" || host === "www.candy.ai" || host === "player.zilla-networks.com";
  } catch {
    return false;
  }
}

function isBlockedPlaybackSource(source = {}) {
  const urls = [source.videoUrl, source.externalUrl, source.url, source.href].filter(Boolean);
  const identitySource = {
    ...source,
    videoUrl: isLocalSourceProxyUrl(source.videoUrl) ? "" : source.videoUrl,
    externalUrl: isLocalSourceProxyUrl(source.externalUrl) ? "" : source.externalUrl,
    url: isLocalSourceProxyUrl(source.url) ? "" : source.url,
    href: isLocalSourceProxyUrl(source.href) ? "" : source.href
  };
  return urls.some((url) => !isLocalSourceProxyUrl(url) && isBlockedPlaybackUrl(url))
    || /\b(?:candy\.ai|player\.zilla-networks\.com)\b/i.test(sourceIdentityText(identitySource));
}

function isPreferredAdultSource(source = {}) {
  return isAdultFallbackSource(source) && source.type === "direct" && !isBlockedPlaybackSource(source);
}

function isAdultFallbackSource(source = {}) {
  return Boolean(KNOWN_SOURCE_SERVERS.find((def) => def.key === "underhentai")?.match(source));
}

function isAnimeAv1Source(source = {}) {
  const text = sourceIdentityText(source);
  return text.includes("animeav1") || Boolean(KNOWN_SOURCE_SERVERS.find((d) => d.key === "animeav1")?.match(source));
}

function isJKAnimeSource(source = {}) {
  const text = sourceIdentityText(source);
  return text.includes("jkanime") || Boolean(KNOWN_SOURCE_SERVERS.find((d) => d.key === "jkanime")?.match(source));
}

function isHlsSource(source = {}) {
  const url = (source.videoUrl || source.externalUrl || "").toLowerCase();
  const text = sourceIdentityText(source);
  return /\.m3u8(\?|#|$)/i.test(url) || /\bhls\b/.test(text);
}

function isMp4UploadSource(source = {}) {
  return /mp4\s*upload|mp4upload/.test(sourceIdentityText(source));
}

function sourcePreferredFilterValue(source = {}) {
  return PRIMARY_SOURCE_FILTERS.find((filter) => filter.match(source))?.value || "";
}

function getPrimarySourceFilterOptions(show = null) {
  if (typeof AdultMode !== "undefined" && AdultMode.isAdultContent(show)) return [];
  return PRIMARY_SOURCE_FILTERS.map(({ value, label }) => ({ value, label }));
}

// Provider group for source ordering: preferred scrapers on top, then AniPub,
// then anything else.
function _sourceGroupPriority(source = {}) {
  const text = sourceIdentityText(source);
  if (isAnimeAv1Source(source) || isJKAnimeSource(source)) return 0;
  if (text.includes("tioanime")) return 1;
  if (KNOWN_SOURCE_SERVERS.find(d => d.key === "anipub")?.match(source)) return 1;
  return 2;
}

// Fine-grained "best server" preference. Lower = shown / auto-selected first.
// AnimeAV1 is the most reliable provider — its HLS stream is the #1 pick.
function sourcePreferenceScore(source = {}) {
  const label = (source.label || "").toLowerCase();
  const url   = (source.videoUrl || source.externalUrl || "").toLowerCase();
  const identity = sourceIdentityText(source);
  const isDirect = source.type === "direct";
  const isHls    = isHlsSource(source);
  const isAnimeAv1 = isAnimeAv1Source(source);
  const isJKAnime = isJKAnimeSource(source);
  const isMega = /\bmega\b/.test(label) || /mega\.nz/.test(url);
  const isMp4  = isMp4UploadSource(source);
  const isAdFree = /yourupload|you\s*upload|youupload|ok\.?ru|okru|streamwish|filelions/.test(label);
  const isAdWalled = /\bvoe\b|netu|hqq|streamsb|embedsb|\bsb\b|dood|filemoon|vidhide|mixdrop/.test(label);

  // Adult catalog: use a resolved direct stream before an in-page provider.
  if (isPreferredAdultSource(source))    return 0;
  if (identity.includes("hentaila"))     return 1;

  // ── AnimeAV1 first (most reliable) — HLS is the very top pick ────────────
  if (isAnimeAv1 && isHls)              return 0; // AnimeAV1 — HLS  (best)
  if (isJKAnime && isMp4)               return 1; // JKAnime — MP4Upload
  if (isAnimeAv1 && isDirect)           return 2; // AnimeAV1 — other direct
  if (isAnimeAv1 && (isMega || isMp4))  return 3; // AnimeAV1 — Mega / MP4Upload
  if (isAnimeAv1 && !isAdWalled)        return 4; // AnimeAV1 — other ad-free embed
  // ── Then the other dependable, ad-free servers ─────────────────────────
  if (isHls || isDirect)               return 5; // any other direct / HLS stream
  if (isMega || isMp4)                 return 6; // Mega / MP4Upload (TioAnime etc.)
  if (isAdFree)                        return 7; // YourUpload / Ok.ru / …
  if (isAdultFallbackSource(source))    return 8; // UnderHentai/Kraken fallback
  // ── Ad-walled hosts sink to the bottom ─────────────────────────────────
  if (isAdWalled)                      return 9;
  return 8;                                       // neutral / unknown
}

// Order sources so the auto-selected one (index 0) is the best playable pick:
//   1. preference tier   → AnimeAV1-HLS / Mega / MP4Upload float to the very top
//   2. scraper group     → TioAnime/AnimeAV1 before AniPub before others
//   3. ad-free rank      → ad-walled hosts sink (no "Sandbox not allowed" wall)
//   4. stable arrival    → first server that resolved wins on a tie
function orderSourceOptions(sources = []) {
  return sources
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const pa = sourcePreferenceScore(a.s), pb = sourcePreferenceScore(b.s);
      if (pa !== pb) return pa - pb;
      const ga = _sourceGroupPriority(a.s), gb = _sourceGroupPriority(b.s);
      if (ga !== gb) return ga - gb;
      const ra = Number.isFinite(a.s.sourceRank) ? a.s.sourceRank : 1;
      const rb = Number.isFinite(b.s.sourceRank) ? b.s.sourceRank : 1;
      if (ra !== rb) return ra - rb;
      return a.i - b.i;
    })
    .map(o => o.s);
}

// The stream the player is ACTUALLY using. normalizeEpisodeSourceOptions rebuilds
// it as { id: "direct", label: "Auto" } carrying the upstream host, so after
// normalization its identity text no longer contains the provider name - and the
// whitelist below dropped it. Measured on Kami no Shizuku S1E9: one real source,
// isAnimeAv1Source false, zero picker entries, for an episode that plays fine.
// This admits exactly that one option and nothing else: it is matched by URL
// against the episode's own resolved stream, so it can neither invent a source nor
// leak an adult fallback into regular anime (or the reverse).
function isActivePlaybackSource(source = {}, episode = {}) {
  if (typeof pickPlayableUrl !== "function") return false;
  const playable = pickPlayableUrl(episode);
  if (!playable) return false;
  return String(source.videoUrl || "") === String(playable);
}

function getEpisodePlaybackSources(episode = {}) {
  return orderSourceOptions(normalizeEpisodeSourceOptions(episode).filter((source) => (
    !isBlockedPlaybackSource(source)
    && (isAnimeAv1Source(source) || isAdultFallbackSource(source) || isActivePlaybackSource(source, episode))
  )));
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    sourceIdentityText,
    isBlockedPlaybackUrl,
    isBlockedPlaybackSource,
    isPreferredAdultSource,
    isAdultFallbackSource,
    isAnimeAv1Source,
    isJKAnimeSource,
    isHlsSource,
    isMp4UploadSource,
    sourcePreferredFilterValue,
    getPrimarySourceFilterOptions,
    sourcePreferenceScore,
    orderSourceOptions,
    getEpisodePlaybackSources
  };
}
