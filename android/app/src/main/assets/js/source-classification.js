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

function knownSourceServer(key) {
  if (typeof KNOWN_SOURCE_SERVERS === "undefined" || !Array.isArray(KNOWN_SOURCE_SERVERS)) return null;
  return KNOWN_SOURCE_SERVERS.find((definition) => definition.key === key) || null;
}

function isAdultFallbackSource(source = {}) {
  return Boolean(knownSourceServer("underhentai")?.match(source));
}

function isHentaiOceanSource(source = {}) {
  return sourceIdentityText(source).includes("hentaiocean")
    || sourceIdentityText(source).includes("hentai ocean");
}

function isAnimeAv1Source(source = {}) {
  const text = sourceIdentityText(source);
  return text.includes("animeav1") || Boolean(knownSourceServer("animeav1")?.match(source));
}

function isJKAnimeSource(source = {}) {
  const text = sourceIdentityText(source);
  return text.includes("jkanime") || Boolean(knownSourceServer("jkanime")?.match(source));
}

function isTioAnimeSource(source = {}) {
  const text = sourceIdentityText(source);
  return text.includes("tioanime") || Boolean(knownSourceServer("tioanime")?.match(source));
}

function isHlsSource(source = {}) {
  const url = (source.videoUrl || source.externalUrl || "").toLowerCase();
  const text = sourceIdentityText(source);
  return /\.m3u8(\?|#|$)/i.test(url) || /\bhls\b/.test(text);
}

function isMp4UploadSource(source = {}) {
  return /mp4\s*upload|mp4upload/.test(sourceIdentityText(source));
}

function declaredVideoCodec(source = {}) {
  const value = [source.codec, source.codecs, source.videoCodec, source.mimeType]
    .filter(Boolean).join(" ").toLowerCase();
  if (/\b(?:av01|av1)\b/.test(value)) return "av1";
  if (/\b(?:avc1|avc3|h\.?264)\b/.test(value)) return "h264";
  if (/\b(?:hvc1|hev1|hevc|h\.?265)\b/.test(value)) return "hevc";
  if (/\b(?:vp09|vp9)\b/.test(value)) return "vp9";
  return "";
}

function browserSupportsDeclaredCodec(source = {}) {
  const codec = declaredVideoCodec(source);
  if (!codec) return null;
  const probes = {
    av1: ['video/mp4; codecs="av01.0.05M.08"', 'video/webm; codecs="av01.0.05M.08"'],
    h264: ['video/mp4; codecs="avc1.42E01E"'],
    hevc: ['video/mp4; codecs="hvc1.1.6.L93.B0"', 'video/mp4; codecs="hev1.1.6.L93.B0"'],
    vp9: ['video/webm; codecs="vp09.00.10.08"']
  }[codec] || [];
  let checked = false;
  try {
    if (typeof MediaSource !== "undefined" && typeof MediaSource.isTypeSupported === "function") {
      checked = true;
      if (probes.some((mime) => MediaSource.isTypeSupported(mime))) return true;
    }
  } catch { /* fall through to HTMLMediaElement */ }
  try {
    if (typeof document !== "undefined") {
      const video = document.createElement("video");
      if (typeof video.canPlayType === "function") {
        checked = true;
        if (probes.some((mime) => Boolean(video.canPlayType(mime)))) return true;
      }
    }
  } catch { /* capability remains unknown */ }
  return checked ? false : null;
}

function sourcePreferredFilterValue(source = {}) {
  return PRIMARY_SOURCE_FILTERS.find((filter) => filter.match(source))?.value || "";
}

function getPrimarySourceFilterOptions(show = null) {
  if (typeof AdultMode !== "undefined" && AdultMode.isAdultContent(show)) return [];
  return PRIMARY_SOURCE_FILTERS.map(({ value, label }) => ({ value, label }));
}

// Provider group for source ordering: AnimeAV1 and its regular backups first,
// then anything else.
function _sourceGroupPriority(source = {}) {
  if (isAnimeAv1Source(source) || isJKAnimeSource(source)) return 0;
  if (isTioAnimeSource(source)) return 1;
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
  const compatibilityPenalty = browserSupportsDeclaredCodec(source) === false ? 50 : 0;

  // Adult catalog: use a resolved direct stream before an in-page provider.
  // Hentai Ocean is deliberately the final provider: its direct AV1/H.264 files
  // are useful when UnderHentai has no release, but it must never displace the
  // ad-free primary catalog merely because its resolver finished first.
  if (isHentaiOceanSource(source))       return 40 + compatibilityPenalty;
  if (isPreferredAdultSource(source))    return 0 + compatibilityPenalty;
  if (identity.includes("hentaila"))     return 1 + compatibilityPenalty;

  // ── AnimeAV1 first (most reliable) — HLS is the very top pick ────────────
  if (isAnimeAv1 && isHls)              return 0 + compatibilityPenalty; // AnimeAV1 — HLS  (best)
  if (isAnimeAv1 && isDirect)           return 1 + compatibilityPenalty; // AnimeAV1 — other direct
  if (isAnimeAv1 && (isMega || isMp4))  return 2 + compatibilityPenalty; // AnimeAV1 — Mega / MP4Upload
  if (isAnimeAv1 && !isAdWalled)        return 3 + compatibilityPenalty; // AnimeAV1 — other ad-free embed
  if (isJKAnime && isMp4)               return 4 + compatibilityPenalty; // JKAnime — MP4Upload fallback
  // ── Then the other dependable, ad-free servers ─────────────────────────
  if (isHls || isDirect)               return 5 + compatibilityPenalty; // any other direct / HLS stream
  if (isMega || isMp4)                 return 6 + compatibilityPenalty; // Mega / MP4Upload (TioAnime etc.)
  if (isAdFree)                        return 7 + compatibilityPenalty; // YourUpload / Ok.ru / …
  if (isAdultFallbackSource(source))    return 8 + compatibilityPenalty; // UnderHentai/Kraken fallback
  // ── Ad-walled hosts sink to the bottom ─────────────────────────────────
  if (isAdWalled)                      return 9 + compatibilityPenalty;
  return 8 + compatibilityPenalty;                // neutral / unknown
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
    && (
      isAnimeAv1Source(source)
      || isJKAnimeSource(source)
      || isTioAnimeSource(source)
      || isAdultFallbackSource(source)
      || isActivePlaybackSource(source, episode)
    )
  )));
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    sourceIdentityText,
    isBlockedPlaybackUrl,
    isBlockedPlaybackSource,
    isPreferredAdultSource,
    isAdultFallbackSource,
    isHentaiOceanSource,
    isAnimeAv1Source,
    isJKAnimeSource,
    isTioAnimeSource,
    isHlsSource,
    isMp4UploadSource,
    declaredVideoCodec,
    browserSupportsDeclaredCodec,
    sourcePreferredFilterValue,
    getPrimarySourceFilterOptions,
    sourcePreferenceScore,
    orderSourceOptions,
    getEpisodePlaybackSources
  };
}
