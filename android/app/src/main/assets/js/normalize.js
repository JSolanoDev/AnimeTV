// Data normalization — transforms raw API responses into the app's internal shape.
// Depends on: utils.js (pickGenre, cleanDescription, normalizeTitle, getShowKey, languageName, pickPlayableUrl, getEpisodeUrl, etc.)

function normalizeExternalShow(item, source, index) {
  const title = item.title || item.name || item.animeTitle;
  if (!title) return null;
  const sourceSiteUrl = item.siteUrl || item.url || "";
  const animeAv1SiteMatch = String(sourceSiteUrl).match(/animeav1\.com\/media\/([^/?#]+)/i);
  const animeAv1IdMatch = String(item.id || "").match(/^animeav1-(.+)$/i);
  const belongsToAnimeAv1 = /animeav1/i.test([
    source?.id,
    source?.name,
    source?.provider,
    item.provider,
    item.source
  ].filter(Boolean).join(" "));
  const animeAv1Slug = String(
    item.animeAv1Slug || item._av1Slug || animeAv1SiteMatch?.[1] ||
    animeAv1IdMatch?.[1] || (belongsToAnimeAv1 ? item._slug : "") || ""
  ).trim().toLowerCase();
  const sourceImage = item.image || item.poster || item.cover || item.thumbnail || "";
  const sourcePoster = animeAv1ArtworkVariant(sourceImage, "poster") || sourceImage;
  const sourceBackdrop = animeAv1ArtworkVariant(sourceImage, "backdrop");
  const rawGenres = item.genres || (item.genre ? [item.genre] : []);
  const genres = (Array.isArray(rawGenres) ? rawGenres : [rawGenres])
    .map((value) => typeof value === "string" ? value : value?.name)
    .map((value) => String(value || "").trim())
    .filter((value) => value && !/^(?:anime|animation)$/i.test(value));
  const genre = genres.length ? pickGenre(genres) : "";
  const seasons = normalizeSeasons(item);
  const episodes = seasons.flatMap((season) => season.episodes);
  const videoUrl = pickPlayableUrl(item) || getEpisodeUrl(episodes[0]) || "";
  // nextAiringAt is milliseconds. One Date for both the weekday and the clock
  // below, so the pair can never describe different moments.
  const externalAiringMs = Number(item.nextAiringAt || 0);
  const externalAiringDate = externalAiringMs > 0 ? new Date(externalAiringMs) : null;

  return {
    id: `source-${source.id || source.name}-${item.id || item.malId || item.anilistId || index}`,
    catalogAnimeId: item.catalogAnimeId || item.id || null,
    providerAnimeId: item.providerAnimeId || item.provider_anime_id || item.animeId || item.id || null,
    animeAv1Slug,
    aniPubId: item.aniPubId || item.anipubId || item._id || (source.id === "anipub-catalog" ? item.id : ""),
    consumetId: item.consumetId || item.consumet_id || item.kickAssAnimeId || item.kickassanimeId || (source.id === "consumet-kickassanime" ? item.id : ""),
    finder: item.finder || item.slug || "",
    malId: item.malId || item.idMal || item.mal_id || null,
    anilistId: item.anilistId || item.idAnilist || item.anilist_id || null,
    nativeTitle: item.nativeTitle || item.titleNative || item.title_native || "",
    romajiTitle: item.romajiTitle || item.titleRomaji || item.title_romaji || "",
    aliases: item.aliases || item.titles || [],
    title,
    episode: item.episode || item.episodeNumber || item.latestEpisode || "?",
    genre,
    genres,
    // The absolute instant the next episode airs, kept ALONGSIDE the display
    // strings below rather than folded into them. `day`/`time` are produced by
    // toLocaleDateString(), so they carry the locale of whichever machine built
    // the row - the server bakes Spanish - which makes them text to show, never
    // a value to compute with. Dropping these two fields here is what left
    // lastEpisodeAiredMs() with nothing but those strings to parse, so every
    // airing show fell out of the recently-aired pool and the carousel quietly
    // became an all-time popularity list. /api/catalog has always sent them.
    nextAiringAt: item.nextAiringAt ?? null,
    nextAiringEpisodeNumber: item.nextAiringEpisodeNumber ?? null,
    // Baked by scripts/build-airing-map.mjs and merged by /api/catalog.
    // season/seasonYear let the carousel rank by how CURRENT a title is;
    // franchiseSeasons is the ordered SEQUEL/PREQUEL chain the season picker
    // needs. All three were being dropped here - this function builds an
    // explicit field list, so anything not named simply does not survive, which
    // is the same way the airing fields went missing before.
    season: item.season || "",
    seasonYear: item.seasonYear ?? null,
    franchiseSeasons: Array.isArray(item.franchiseSeasons) ? item.franchiseSeasons : null,
    // Derived from the numeric instant above, not from whatever strings the
    // server baked. /api/catalog sends no day at all, so every one of the ~994
    // catalogue rows defaulted to "Local" - a value the Weekly Schedule
    // explicitly excludes, which is why the Schedule rendered seven empty day
    // columns. When the server DOES send a string it carries the locale of the
    // machine that built it, so the instant is the better source either way:
    // it converts in the viewer's own timezone, and the Schedule and the
    // carousel both read these fields, so both describe the same moment.
    day: externalAiringDate ? formatAiringWeekday(externalAiringDate) : (item.day || item.airDay || "Local"),
    time: externalAiringDate ? formatAiringClock(externalAiringDate) : (item.time || item.airTime || ""),
    colors: item.colors || ["#40dfc2", "#251d47"],
    score: item.score || null,
    status: item.status || item.airingStatus || "",
    format: item.format || item.type || "",
    duration: item.duration || item.durationMinutes || item.episodeDuration || "",
    year: item.year || item.seasonYear || item.releaseYear || "",
    source: source.name || "Local Source",
    image: sourcePoster,
    // Genuine banner art from the source only. The derived AnimeAV1 strip is
    // deliberately NOT here: /api/catalog sends banner:"" for scraped titles, so the
    // derived value always won, and a 1900x400 strip (39% of which 403) then
    // outranked the TMDB backdrop everywhere show.banner is read. It stays
    // available to the backdrop chain under its own name, ranked below real art.
    banner: item.banner || item.backdrop || "",
    animeAv1Backdrop: sourceBackdrop || "",
    // Pre-resolved by scripts/build-artwork-map.mjs and shipped in /api/catalog.
    // getWatchBackdropArtwork() and getCarouselArtwork() both lead with this, so a
    // present value means the show opens on a real 1080p+ backdrop with no AniList
    // or TMDB round-trip at all.
    tmdbBackdrop: item.tmdbBackdrop || "",
    // The title poster for every show that resolved - see getWatchPosterArtwork
    // and getCardPosterCandidates, both of which rank it above the scraped cover.
    tmdbPoster: item.tmdbPoster || "",
    tmdbId: item.tmdbId || null,
    // Shipped by /api/catalog from the build-time metadata map. countryOfOrigin
    // drives the CN/KR/TW English-title rule in getShowTitle(); studios feeds the
    // "Studio: ..." row on the detail page. Both were previously dropped here and
    // only appeared after a per-title AniList round-trip.
    countryOfOrigin: item.countryOfOrigin || "",
    englishTitle: item.englishTitle || "",
    // Placeholder-episode count only - see makePlaceholderEpisodes in client.js.
    anilistEpisodeCount: item.anilistEpisodeCount || null,
    // How many episodes the SOURCE actually serves, probed at build time. Not a
    // metadata guess: an airing show's planned total is not what is playable.
    sourceEpisodeCount: item.sourceEpisodeCount || null,
    studios: Array.isArray(item.studios) ? item.studios : [],
    // Artwork that came from the catalogue is curated: build-artwork-map.mjs picks
    // TMDB's primary backdrop and poster for the matched show. A later runtime
    // resolve must not replace it - see applyResolvedMatch in js/image-resolver.js.
    _artworkPinned: Boolean(item.tmdbBackdrop || item.tmdbPoster),
    siteUrl: sourceSiteUrl,
    description: cleanDescription(item.description || item.synopsis || ""),
    anime1vUrl: item.anime1vUrl || item.animeUrl || item.url || item.link || "",
    provider: item.provider || source.provider || "",
    episodeEndpoint: item.episodeEndpoint || source.episodeEndpoint || "",
    streamEndpoint: item.streamEndpoint || source.streamEndpoint || "",
    videoUrl,
    seasons,
    episodes
  };
}

function normalizeSeasons(item) {
  const rawSeasons = Array.isArray(item.seasons) ? item.seasons : [];
  if (rawSeasons.length) {
    return rawSeasons
      .map((season, index) => {
        const seasonNumber = canonicalSeasonNumber(
          season.season ?? season.seasonNumber ?? season.number,
          season.title || season.name || item.title,
          index + 1
        );
        const seasonItem = {
          ...item,
          episodes: season.episodes || season.videos || season.streams || season.files || []
        };
        return {
          season: seasonNumber,
          title: season.title || season.name || `Season ${seasonNumber}`,
          episodes: normalizeEpisodes(seasonItem, seasonNumber)
        };
      })
      .filter((season) => season.episodes.length);
  }

  const normalized = normalizeEpisodes(item);
  if (normalized.length) return groupEpisodesBySeason(normalized);

  // No episodes array — generate numbered placeholders from the episode count so
  // scraped/metadata-only catalog items (e.g. scrapled-catalog) have selectable
  // episode buttons even before a playback source is resolved.
  const totalEps = Math.min(
    2000,
    Math.max(0, Number(item.episode || item.episodeNumber || item.latestEpisode || item.total_episodes || item.episodeCount || 0))
  );
  if (totalEps > 0) {
    const seasonNumber = canonicalSeasonNumber(
      item.seasonNumber ?? item.canonicalSeason,
      item.title || item.name || item.animeTitle,
      1
    );
    return [{
      season: seasonNumber,
      title: seasonNumber > 1 ? `Season ${seasonNumber}` : "Season 1",
      episodes: Array.from({ length: totalEps }, (_, i) => ({
        id: `${item.id || item.title || "ep"}-s${seasonNumber}-e${i + 1}`,
        title: `Episode ${i + 1}`,
        animeId: item.id || null,
        catalogAnimeId: item.id || null,
        anilistId: item.anilistId || null,
        malId: item.malId || item.mal_id || null,
        tmdbId: item.tmdbId || null,
        provider: item.provider || sourceNameOf(item),
        providerAnimeId: item.providerAnimeId || item.animeAv1Slug || item._slug || item.id || null,
        providerAnimeSlug: item.animeAv1Slug || item._slug || "",
        providerEpisodeId: i + 1,
        sourceEpisodeNumber: i + 1,
        canonicalSeason: seasonNumber,
        canonicalEpisode: i + 1,
        absoluteEpisode: i + 1,
        displayEpisodeNumber: i + 1,
        season: seasonNumber,
        episode: i + 1,
        number: i + 1,
        videoUrl: "",
        server: "Auto",
        locked: true
      }))
    }];
  }

  return [];
}

function sourceNameOf(item = {}) {
  return item.server || item.provider || item.source || "";
}

function canonicalSeasonNumber(value, title = "", fallback = 1) {
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric > 0) return numeric;
  if (typeof SeasonNormalization !== "undefined" && SeasonNormalization.parseTitle) {
    const parsed = SeasonNormalization.parseTitle(title || "");
    if (Number.isInteger(parsed?.seasonNumber) && parsed.seasonNumber > 0) return parsed.seasonNumber;
  }
  return Number(fallback) > 0 ? Number(fallback) : 1;
}

// Extract a numeric episode number from varied title formats without destroying
// valid provider identities such as episode 0 or 12.5.
function parseEpisodeNumber(value, fallback = null) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  const str = String(value || "");
  const bare = str.match(/^0*(\d+(?:\.\d+)?)$/);
  if (bare) return Number(bare[1]);
  const prefixed = str.match(/(?:ep(?:isode)?|cap(?:ítulo|itulo)?|e)[\s.\-#]*0*(\d+(?:\.\d+)?)/i);
  if (prefixed) return Number(prefixed[1]);
  const trailing = str.match(/\b0*(\d+(?:\.\d+)?)\s*$/);
  if (trailing) return Number(trailing[1]);
  return fallback;
}

function getCanonicalEpisodeNumber(episode = {}, fallback = null) {
  for (const value of [
    episode.canonicalEpisode,
    episode.episode,
    episode.number,
    episode.episodeNumber,
    episode.displayEpisodeNumber
  ]) {
    const parsed = parseEpisodeNumber(value);
    if (parsed !== null) return parsed;
  }
  return fallback;
}

function getOriginalProviderEpisodeId(episode = {}) {
  for (const value of [
    episode.providerEpisodeId,
    episode.provider_episode_id,
    episode.sourceEpisodeId,
    episode.source_episode_id,
    episode.episodeId,
    episode.sourceEpisodeNumber,
    episode.originalEpisodeNumber
  ]) {
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return null;
}

function getProviderEpisodeId(episode = {}, fallback = null) {
  const original = getOriginalProviderEpisodeId(episode);
  if (original !== null) return original;
  const canonical = getCanonicalEpisodeNumber(episode);
  return canonical !== null ? canonical : fallback;
}

function canonicalEpisodeIdentity(episode = {}, context = {}) {
  const season = canonicalSeasonNumber(
    episode.canonicalSeason ?? episode.season ?? episode.seasonNumber,
    context.title || "",
    context.season || 1
  );
  const canonicalEpisode = getCanonicalEpisodeNumber(episode);
  const providerEpisodeId = getProviderEpisodeId(episode);
  const animeIdentity = episode.catalogAnimeId || episode.animeId || episode.anilistId || episode.malId || context.animeId || "anime";
  const episodeIdentity = providerEpisodeId !== null && providerEpisodeId !== undefined && String(providerEpisodeId) !== ""
    ? `provider:${String(providerEpisodeId)}`
    : canonicalEpisode !== null
      ? `episode:${canonicalEpisode}`
      : `id:${episode.id || "unknown"}`;
  return `${animeIdentity}:s${season}:${episodeIdentity}`;
}

function normalizeEpisodes(item, parentSeason = "") {
  const rawEpisodes = [item.episodes, item.videos, item.streams, item.files]
    .find((value) => Array.isArray(value)) || [];
  const fallbackSeason = parentSeason || item.season || item.seasonNumber || 1;

  return rawEpisodes
    .map((episode, index) => {
      if (typeof episode === "string") {
        return {
          id: `${item.id || item.title || "episode"}-${index}`,
          title: `Episode ${index + 1}`,
          season: fallbackSeason,
          episode: index + 1,
          canonicalSeason: fallbackSeason,
          canonicalEpisode: index + 1,
          displayEpisodeNumber: index + 1,
          providerEpisodeId: index + 1,
          sourceEpisodeNumber: index + 1,
          videoUrl: episode,
          server: "Local"
        };
      }

      const url = getEpisodeUrl(episode);
      const streamResolver = episode.streamResolver || episode.resolver || null;
      const externalUrl = episode.externalUrl || episode.embedUrl || episode.iframeUrl || "";
      const subtitles = normalizeSubtitleTracks(episode);
      // Parse episode number robustly — never leave it as a string that sorts lexically
      const rawEpNum = episode.canonicalEpisode ?? episode.episode ?? episode.number ?? episode.episodeNumber;
      const parsedEpNum = parseEpisodeNumber(rawEpNum) ?? parseEpisodeNumber(episode.title);
      const displayEpNum = parsedEpNum ?? (index + 1);
      const sourceEpisodeNumber = parseEpisodeNumber(
        episode.sourceEpisodeNumber ?? episode.originalEpisodeNumber ?? rawEpNum
      );
      const providerEpisodeId = getProviderEpisodeId(episode, sourceEpisodeNumber ?? parsedEpNum);
      const seasonNumber = canonicalSeasonNumber(
        episode.canonicalSeason ?? episode.season ?? episode.seasonNumber ?? fallbackSeason,
        item.title,
        fallbackSeason
      );
      return {
        ...episode,
        id: episode.id || episode.slug || `${item.id || item.title || "episode"}-${index}`,
        title: episode.title || episode.name || `Episode ${displayEpNum}`,
        animeId: episode.animeId || item.animeId || item.id || null,
        catalogAnimeId: episode.catalogAnimeId || item.catalogAnimeId || item.id || null,
        anilistId: episode.anilistId || item.anilistId || null,
        malId: episode.malId || item.malId || item.mal_id || null,
        tmdbId: episode.tmdbId || item.tmdbId || null,
        provider: episode.provider || episode.server || item.provider || item.source || "",
        providerAnimeId: episode.providerAnimeId || episode.provider_anime_id || item.providerAnimeId || item.animeAv1Slug || item._slug || item.id || null,
        providerAnimeSlug: episode.providerAnimeSlug || item.animeAv1Slug || item._slug || "",
        providerEpisodeId,
        sourceEpisodeNumber: sourceEpisodeNumber ?? parsedEpNum,
        originalEpisodeNumber: episode.originalEpisodeNumber ?? rawEpNum ?? null,
        canonicalSeason: seasonNumber,
        canonicalEpisode: parsedEpNum,
        absoluteEpisode: parseEpisodeNumber(episode.absoluteEpisode ?? episode.absolute_episode),
        displayEpisodeNumber: displayEpNum,
        episodeNumberSource: parsedEpNum === null ? "position" : "metadata",
        episodeType: episode.episodeType || episode.episode_type || episode.type || "episode",
        airDate: episode.airDate || episode.aired || episode.air_date || "",
        season: seasonNumber,
        episode: displayEpNum,
        number: displayEpNum,
        videoUrl: url,
        streamResolver,
        externalUrl,
        externalType: episode.externalType || (externalUrl ? "iframe" : ""),
        sourceOptions: normalizeEpisodeSourceOptions(episode),
        subtitles,
        availableAudio: episode.availableAudio || episode.audioTracks || episode.audio || [],
        availableSubs: episode.availableSubs || episode.subtitleTracks || episode.subs || [],
        defaultAudio: episode.defaultAudio || "",
        defaultSubs: episode.defaultSubs || episode.defaultSubtitles || "",
        server: episode.server || episode.provider || episode.source || "",
        locked: episode.locked ?? (!url && !externalUrl && !streamResolver)
      };
    })
    .filter(Boolean);
}

function groupEpisodesBySeason(episodes = []) {
  const bySeason = new Map();
  episodes.forEach((episode) => {
    const seasonNumber = canonicalSeasonNumber(episode.canonicalSeason ?? episode.season ?? episode.seasonNumber, "", 1);
    if (!bySeason.has(seasonNumber)) {
      bySeason.set(seasonNumber, {
        season: seasonNumber,
        title: `Season ${seasonNumber}`,
        episodes: []
      });
    }
    bySeason.get(seasonNumber).episodes.push(episode);
  });
  return [...bySeason.values()].map((season) => ({
    ...season,
    episodes: season.episodes.sort((a, b) => {
      const numA = getCanonicalEpisodeNumber(a, Number.POSITIVE_INFINITY);
      const numB = getCanonicalEpisodeNumber(b, Number.POSITIVE_INFINITY);
      if (numA !== numB) return numA - numB;
      const dateA = a.airDate || a.aired || a.air_date || "";
      const dateB = b.airDate || b.aired || b.air_date || "";
      if (dateA && dateB) return new Date(dateA) - new Date(dateB);
      return 0;
    })
  })).sort((a, b) => Number(a.season || 0) - Number(b.season || 0));
}

function pickPlayableUrl(item) {
  if (!item) return "";
  return item.videoUrl || item.streamUrl || item.file || item.urlVideo || item.playUrl || item.fileUrl || item.file_url || item.directUrl || "";
}

function normalizeEpisodeSourceOptions(episode = {}) {
  const raw = Array.isArray(episode.sourceOptions)
    ? episode.sourceOptions
    : Array.isArray(episode.sources)
      ? episode.sources
      : [];
  const options = raw.map((source, index) => {
    const videoUrl = pickPlayableUrl(source) || source.url || "";
    const externalUrl = source.externalUrl || source.embedUrl || source.iframeUrl || source.embed || "";
    const inferredType = source.type || (externalUrl ? "iframe" : "direct");
    return {
      ...source,
      id: source.id || source.sourceId || source.originalSourceId || source.source || `source-${index}`,
      originalSourceId: source.originalSourceId || source.sourceId || source.id || source.source || null,
      label: cleanPlaybackSourceLabel(source.label || source.name || source.server || source.source || `Source ${index + 1}`),
      provider: source.provider || source.server || episode.provider || episode.server || "",
      type: inferredType,
      videoUrl,
      externalUrl,
      downloadUrl: source.downloadUrl || source.download || source.download_url || source.fileUrl || source.file_url || videoUrl || "",
      streamResolver: source.streamResolver || source.resolver || null,
      mimeType: source.mimeType || source.mime || source.contentType || source.content_type || "",
      container: source.container || source.format || "",
      codec: source.codec || source.codecs || source.videoCodec || source.video_codec || "",
      audioCodec: source.audioCodec || source.audio_codec || "",
      resolution: source.resolution || source.quality || "",
      bitrate: source.bitrate ?? source.bandwidth ?? null,
      headers: source.headers || source.requestHeaders || source.request_headers || null,
      referer: source.referer || source.referrer || source.headers?.Referer || source.headers?.referer || "",
      providerEpisodeId: source.providerEpisodeId ?? source.provider_episode_id ?? getProviderEpisodeId(episode)
    };
  });
  if (pickPlayableUrl(episode)) {
    options.unshift({
      id: episode.sourceId || episode.originalSourceId || "direct",
      originalSourceId: episode.originalSourceId || episode.sourceId || null,
      label: cleanPlaybackSourceLabel(episode.server || "Direct"),
      provider: episode.provider || episode.server || "",
      type: "direct",
      videoUrl: pickPlayableUrl(episode),
      downloadUrl: episode.downloadUrl || episode.download || episode.download_url || pickPlayableUrl(episode),
      mimeType: episode.mimeType || episode.mime || episode.contentType || "",
      container: episode.container || episode.format || "",
      codec: episode.codec || episode.codecs || episode.videoCodec || "",
      audioCodec: episode.audioCodec || "",
      resolution: episode.resolution || episode.quality || "",
      bitrate: episode.bitrate ?? null,
      headers: episode.headers || episode.requestHeaders || null,
      referer: episode.referer || episode.referrer || "",
      providerEpisodeId: getProviderEpisodeId(episode)
    });
  }
  if (episode.externalUrl) {
    options.push({
      id: episode.viaAniPub ? "anipub" : isAnime1vEpisode(episode) ? "anime1v" : "external",
      label: cleanPlaybackSourceLabel(episode.viaAniPub ? "AniPub" : isAnime1vEpisode(episode) ? "Anime1v" : episode.server || "External"),
      provider: episode.provider || episode.server || "",
      type: "iframe",
      externalUrl: episode.externalUrl,
      downloadUrl: episode.downloadUrl || episode.download || episode.download_url || "",
      headers: episode.headers || episode.requestHeaders || null,
      referer: episode.referer || episode.referrer || "",
      providerEpisodeId: getProviderEpisodeId(episode)
    });
  }
  if (episode.streamResolver) {
    options.push({
      id: episode.streamResolver.type || "resolver",
      label: cleanPlaybackSourceLabel(episode.server || sourceLabelFromResolver(episode.streamResolver)),
      provider: episode.provider || episode.server || episode.streamResolver.provider || "",
      type: "resolver",
      streamResolver: episode.streamResolver,
      providerEpisodeId: getProviderEpisodeId(episode)
    });
  }
  const seen = new Set();
  const seenSingleProvider = new Set();
  return options.filter((option) => {
    const key = option.videoUrl || option.externalUrl || option.streamResolver?.endpoint || `${option.id}:${option.label}`;
    const providerKey = `${option.id || ""} ${option.label || ""} ${option.streamResolver?.type || ""}`.toLowerCase();
    const singleProvider = providerKey.includes("anipub") ? "anipub" : "";
    if (singleProvider && seenSingleProvider.has(singleProvider)) return false;
    if (singleProvider) seenSingleProvider.add(singleProvider);
    if (seen.has(key)) return false;
    seen.add(key);
    return option.videoUrl || option.externalUrl || option.streamResolver;
  }).sort(comparePlaybackSources);
}

function cleanPlaybackSourceLabel(label = "") {
  const cleaned = String(label || "")
    .replace(/^via\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "Server";
}

function isAnime1vEpisode(episode = {}) {
  return /anime1v/i.test(String(episode.server || ""))
    || episode.streamResolver?.type === "anime1v";
}

function sourceLabelFromResolver(resolver = {}) {
  if (resolver.type === "anime1v") return "Anime1v";
  if (resolver.type === "anipub") return "AniPub";
  if (resolver.type === "underhentai") return "Adult Source";
  if (resolver.type === "consumet-kickassanime") return "KickAssAnime";
  if (resolver.type === "rapid-anime") return "RapidAPI";
  return "Addon";
}

function comparePlaybackSources(a = {}, b = {}) {
  return playbackSourceRank(a) - playbackSourceRank(b);
}

function playbackSourceRank(source = {}) {
  const endpoint = `${source.streamResolver?.endpoint || ""} ${source.videoUrl || ""} ${source.externalUrl || ""}`.toLowerCase();
  const label = `${source.id || ""} ${source.label || ""} ${source.streamResolver?.type || ""} ${endpoint}`.toLowerCase();
  if (label.includes("veohentai") || label.includes("hentaiplayer") || label.includes("1hanime")) return 1;
  if (label.includes("hentaila")) return 2;
  if (label.includes("underhentai")) return 3;
  if (label.includes("anipub")) return 5;
  if (label.includes("kickassanime") || label.includes("consumet")) return 10;
  if (label.includes("anime1v")) return 20;
  if (label.includes("jimov") || label.includes("tioanime")) return 30;
  if (label.includes("rapid")) return 40;
  if (source.type === "direct") return 50;
  if (source.type === "resolver") return 60;
  return 80;
}

function addEpisodeSourceOption(episode, option) {
  if (!episode || !option) return;
  episode.sourceOptions = normalizeEpisodeSourceOptions({
    ...episode,
    sourceOptions: [...(episode.sourceOptions || []), option]
  });
}

function normalizeSubtitleTracks(item) {
  if (!item) return [];
  const rawTracks = [
    item.subtitles,
    item.captions,
    item.tracks,
    item.subtitleTracks
  ].find(Array.isArray) || [];
  const inlineTracks = [
    item.subtitleUrl && { url: item.subtitleUrl, language: item.subtitleLanguage || item.language, label: item.subtitleLabel },
    item.subtitlesUrl && { url: item.subtitlesUrl, language: item.subtitleLanguage || item.language, label: item.subtitleLabel },
    item.captionUrl && { url: item.captionUrl, language: item.captionLanguage || item.language, label: item.captionLabel },
    item.esSubtitleUrl && { url: item.esSubtitleUrl, language: "es", label: "Spanish" }
  ].filter(Boolean);
  return [...rawTracks, ...inlineTracks]
    .map((track, index) => {
      if (typeof track === "string") {
        return { url: track, language: index === 0 ? "" : "unknown", label: "Subtitles" };
      }
      const url = track.url || track.file || track.src || track.href;
      if (!url) return null;
      const language = String(track.language || track.lang || track.srclang || track.locale || "").toLowerCase();
      return {
        url,
        language,
        label: track.label || track.name || languageName(language) || "Subtitles",
        kind: track.kind || "subtitles"
      };
    })
    .filter(Boolean);
}

function getEpisodeUrl(episode) {
  if (!episode) return "";
  if (typeof episode === "string") return episode;
  return pickPlayableUrl(episode);
}

function normalizeAniListShow(entry) {
  const airingDate = entry.nextAiringEpisode?.airingAt
    ? new Date(entry.nextAiringEpisode.airingAt * 1000)
    : null;
  // Both read from the one airingDate instant, through the shared formatter, so
  // the weekday and the clock time can never describe different moments.
  const day = airingDate ? formatAiringWeekday(airingDate) : "TBA";
  const time = airingDate ? formatAiringClock(airingDate) : "TBA";
  const genre = pickGenre(entry.genres);
  const color = entry.coverImage?.color || "#40dfc2";
  const nextAiringEp = entry.nextAiringEpisode?.episode;
  const latestAiredEp = nextAiringEp && nextAiringEp > 1 ? nextAiringEp - 1 : null;

  return {
    id: `anilist-${entry.id}`,
    malId: entry.idMal,
    anilistId: entry.id,
    nativeTitle: entry.title.native || "",
    romajiTitle: entry.title.romaji || "",
    title: entry.title.english || entry.title.romaji || entry.title.native || "Untitled Anime",
    episode: latestAiredEp ?? (nextAiringEp === 1 ? "?" : nextAiringEp) ?? entry.episodes ?? "?",
    totalEpisodes: entry.episodes || null,
    latestAiredEp,
    nextAiringEpisodeNumber: nextAiringEp || null,
    // Absolute instant (ms) the NEXT episode airs — timezone-independent, unlike
    // the day/time strings (which Jikan reports in JST). Used to rank the real
    // "latest episode" drops correctly for the viewer's own timezone.
    nextAiringAt: entry.nextAiringEpisode?.airingAt ? entry.nextAiringEpisode.airingAt * 1000 : null,
    genre,
    genres: entry.genres || [genre],
    day,
    time,
    colors: [color, "#211942"],
    score: entry.averageScore,
    status: entry.status || "",
    format: entry.format || "",
    duration: entry.duration || "",
    year: entry.seasonYear || entry.startDate?.year || "",
    source: "AniList",
    image: entry.coverImage?.extraLarge || entry.coverImage?.large || "",
    banner: entry.bannerImage || "",
    images: {
      poster: entry.coverImage?.extraLarge || entry.coverImage?.large || "",
      cover: entry.coverImage?.extraLarge || entry.coverImage?.large || "",
      banner: entry.bannerImage || "",
      backdrop: entry.bannerImage || entry.coverImage?.extraLarge || entry.coverImage?.large || "",
      thumbnail: entry.coverImage?.extraLarge || entry.coverImage?.large || "",
      episodeStill: null
    },
    siteUrl: entry.siteUrl || "",
    description: cleanDescription(entry.description),
    videoUrl: ""
  };
}

function normalizeJikanShow(entry, source) {
  const genres = (entry.genres || []).map((item) => item.name);
  const genre = pickGenre(genres);
  const broadcast = entry.broadcast || {};

  return {
    id: `jikan-${entry.mal_id}`,
    malId: entry.mal_id,
    anilistId: null,
    nativeTitle: entry.title_japanese || "",
    romajiTitle: entry.title || "",
    title: entry.title_english || entry.title || "Untitled Anime",
    episode: entry.episodes || "?",
    totalEpisodes: entry.episodes || null,
    genre,
    genres,
    day: broadcast.day?.replace("s", "").slice(0, 3) || "TBA",
    time: broadcast.time || "TBA",
    colors: ["#58a8ff", "#2b1d47"],
    score: entry.score ? Math.round(entry.score * 10) : null,
    status: entry.status || "",
    format: entry.type || "",
    duration: entry.duration || "",
    year: entry.year || entry.aired?.prop?.from?.year || "",
    source,
    image: entry.images?.webp?.large_image_url || entry.images?.jpg?.large_image_url || "",
    banner: "",
    images: {
      poster: entry.images?.webp?.large_image_url || entry.images?.jpg?.large_image_url || "",
      cover: entry.images?.webp?.large_image_url || entry.images?.jpg?.large_image_url || "",
      banner: "",
      backdrop: entry.images?.webp?.large_image_url || entry.images?.jpg?.large_image_url || "",
      thumbnail: entry.images?.webp?.large_image_url || entry.images?.jpg?.large_image_url || "",
      episodeStill: null
    },
    siteUrl: entry.url || "",
    description: cleanDescription(entry.synopsis),
    videoUrl: ""
  };
}

function catalogMetadataRank(show = {}) {
  const source = String(show.source || "").toLowerCase();
  if (source.includes("anilist")) return 3;
  if (source.includes("jikan")) return 2;
  if (source.includes("animeav1")) return 1;
  return 0;
}

function mergeCatalogSourceLabels(...values) {
  const labels = [];
  const seen = new Set();
  values.forEach((value) => String(value || "").split("+").forEach((part) => {
    const label = part.trim();
    const key = label.toLowerCase();
    if (!label || seen.has(key)) return;
    seen.add(key);
    labels.push(label);
  }));
  return labels.join(" + ");
}

function clientCatalogIdentitiesAreCompatible(left, right) {
  if (!left || !right) return true;
  if (left.anilistId && right.anilistId && String(left.anilistId) !== String(right.anilistId)) return false;
  if (left.malId && right.malId && String(left.malId) !== String(right.malId)) return false;
  return true;
}

function clientCatalogIdentityKeys(show = {}) {
  return [...new Set([
    show.id ? `id:${show.id}` : "",
    show.anilistId ? `anilist:${show.anilistId}` : "",
    show.malId ? `mal:${show.malId}` : "",
    `show:${getShowKey(show)}`
  ].filter(Boolean))];
}

function mergeClientCatalogShow(current, show) {
  if (!current) return { ...show, source: mergeCatalogSourceLabels(show?.source) };
  if (!show) return current;
  const preferred = catalogMetadataRank(show) > catalogMetadataRank(current) ? show : current;
  return {
    ...current,
    ...show,
    id: current.id || show.id,
    anilistId: current.anilistId || show.anilistId,
    malId: current.malId || show.malId,
    title: preferred?.title || current.title || show.title,
    romajiTitle: preferred?.romajiTitle || current.romajiTitle || show.romajiTitle || "",
    nativeTitle: preferred?.nativeTitle || current.nativeTitle || show.nativeTitle || "",
    aliases: preferred?.aliases?.length ? preferred.aliases : (current.aliases || show.aliases || []),
    status: preferred?.status || current.status || show.status || "",
    format: preferred?.format || current.format || show.format || "",
    duration: preferred?.duration || current.duration || show.duration || "",
    year: preferred?.year || current.year || show.year || "",
    score: preferred?.score || current.score || show.score || null,
    genre: preferred?.genre || current.genre || show.genre || "anime",
    genres: preferred?.genres?.length ? preferred.genres : (current.genres || show.genres || []),
    image: current.image || show.image,
    banner: preferred?.banner || current.banner || show.banner,
    // Artwork must survive a merge. These three fall through the plain `...show`
    // spread above, so a source that carries the KEY with an empty value silently
    // erased artwork another source had already resolved - One Piece and ~110 other
    // scraped rows lost their backdrop the moment AniList rows started emitting
    // `tmdbBackdrop: ""`. Non-empty always wins, in either direction.
    tmdbId: current.tmdbId || show.tmdbId || null,
    tmdbBackdrop: current.tmdbBackdrop || show.tmdbBackdrop || "",
    tmdbPoster: current.tmdbPoster || show.tmdbPoster || "",
    images: {
      ...(current.images || {}),
      ...(show.images || {})
    },
    description: preferred?.description || current.description || show.description,
    videoUrl: show.videoUrl || current.videoUrl || "",
    episodes: mergeEpisodes(current.episodes, show.episodes),
    seasons: mergeSeasons(current.seasons, show.seasons),
    siteUrl: show.siteUrl || current.siteUrl || "",
    source: mergeCatalogSourceLabels(current.source, show.source)
  };
}

function mergeShows(items, limit = Infinity) {
  const byIdentity = new Map();
  const records = new Set();
  items.filter(Boolean).forEach((show) => {
    const keys = clientCatalogIdentityKeys(show);
    const matches = new Set(keys
      .map((key) => ({ key, candidate: byIdentity.get(key) }))
      .filter(({ key, candidate }) => candidate && (key.startsWith("id:") || clientCatalogIdentitiesAreCompatible(candidate, show)))
      .map(({ candidate }) => candidate));
    let merged = null;
    matches.forEach((match) => { merged = mergeClientCatalogShow(merged, match); });
    merged = mergeClientCatalogShow(merged, show);

    matches.forEach((match) => records.delete(match));
    records.add(merged);
    if (matches.size) {
      byIdentity.forEach((value, alias) => {
        if (matches.has(value)) byIdentity.set(alias, merged);
      });
    }
    clientCatalogIdentityKeys(merged).forEach((key) => byIdentity.set(key, merged));
  });
  // Surfaces paginate/virtualize independently; truncating here silently removed
  // the catalog tail when regular and adult sources were resident together.
  return [...records].slice(0, limit);
}

function mergeEpisodes(current = [], incoming = []) {
  const episodes = [...current, ...incoming].filter(Boolean);
  const byEpisode = new Map();
  episodes.forEach((episode) => {
    const url = getEpisodeUrl(episode);
    const providerId = getProviderEpisodeId(episode);
    const key = providerId !== null && providerId !== undefined && String(providerId) !== ""
      ? `${episode.provider || episode.server || "provider"}:${episode.providerAnimeId || episode.providerAnimeSlug || "anime"}:s${episode.canonicalSeason ?? episode.season ?? 1}:${providerId}`
      : url || canonicalEpisodeIdentity(episode, { season: episode.season || 1 });
    const existing = byEpisode.get(key);
    byEpisode.set(key, {
      ...existing,
      ...episode,
      videoUrl: url || existing?.videoUrl || "",
      locked: episode.locked ?? existing?.locked ?? !url
    });
  });
  return [...byEpisode.values()].sort((a, b) => getCanonicalEpisodeNumber(a, 0) - getCanonicalEpisodeNumber(b, 0));
}

function mergeSeasons(current = [], incoming = []) {
  const bySeason = new Map();
  [...current, ...incoming].forEach((season) => {
    if (!season?.episodes?.length) return;
    const seasonNumber = season.season || bySeason.size + 1;
    const existing = bySeason.get(seasonNumber);
    bySeason.set(seasonNumber, {
      season: seasonNumber,
      title: existing?.title || season.title || `Season ${seasonNumber}`,
      episodes: mergeEpisodes(existing?.episodes, season.episodes)
    });
  });
  return [...bySeason.values()].sort((a, b) => Number(a.season || 0) - Number(b.season || 0));
}

function countLoadedEpisodes(shows = []) {
  if (!Array.isArray(shows)) return 0;
  return shows.reduce((total, show) => total + getLoadedEpisodeCount(show), 0);
}

function getLoadedEpisodeCount(show = {}) {
  const counted = new Set();
  const addEpisode = (episode, fallbackSeason = 1, fallbackIndex = 0) => {
    if (!episode || episode.missing) return;
    if (typeof episode === "string") {
      counted.add(`${fallbackSeason}:${fallbackIndex + 1}:url`);
      return;
    }
    const season = Number(episode.season || episode.seasonNumber || fallbackSeason || 1);
    const number = Number(episode.episode || episode.number || fallbackIndex + 1);
    if (Number.isFinite(season) && Number.isFinite(number) && number > 0) {
      counted.add(`${season}:${number}`);
      return;
    }
    counted.add(`${fallbackSeason}:raw-${fallbackIndex}`);
  };

  if (Array.isArray(show.seasons) && show.seasons.length) {
    show.seasons.forEach((season, seasonIndex) => {
      const seasonNumber = season.season || season.seasonNumber || season.number || seasonIndex + 1;
      (season.episodes || []).forEach((episode, episodeIndex) => addEpisode(episode, seasonNumber, episodeIndex));
    });
  } else if (Array.isArray(show.episodes)) {
    show.episodes.forEach((episode, episodeIndex) => addEpisode(episode, episode?.season || 1, episodeIndex));
  }

  const explicitCount = [
    show.totalEpisodes,
    show.episodesCount,
    show.episodeCount,
    show.episode
  ].map(Number).find((count) => Number.isFinite(count) && count > 0) || 0;

  return Math.max(counted.size, explicitCount);
}
