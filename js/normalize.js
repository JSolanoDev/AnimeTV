// Data normalization — transforms raw API responses into the app's internal shape.
// Depends on: utils.js (pickGenre, cleanDescription, normalizeTitle, getShowKey, languageName, pickPlayableUrl, getEpisodeUrl, etc.)

function normalizeExternalShow(item, source, index) {
  const title = item.title || item.name || item.animeTitle;
  if (!title) return null;
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

  return {
    id: `source-${source.id || source.name}-${item.id || item.malId || item.anilistId || index}`,
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
    day: item.day || item.airDay || "Local",
    time: item.time || item.airTime || "",
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
    studios: Array.isArray(item.studios) ? item.studios : [],
    // Artwork that came from the catalogue is curated: build-artwork-map.mjs picks
    // TMDB's primary backdrop and poster for the matched show. A later runtime
    // resolve must not replace it - see applyResolvedMatch in js/image-resolver.js.
    _artworkPinned: Boolean(item.tmdbBackdrop || item.tmdbPoster),
    siteUrl: item.siteUrl || item.url || "",
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
        const seasonNumber = season.season || season.seasonNumber || season.number || index + 1;
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
    return [{
      season: 1,
      title: "Season 1",
      episodes: Array.from({ length: totalEps }, (_, i) => ({
        id: `${item.id || item.title || "ep"}-s1-e${i + 1}`,
        title: `Episode ${i + 1}`,
        season: 1,
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

// Extract a numeric episode number from varied title formats:
//   "Episode 01", "E3", "Ep. 12", "Capitulo 5", "Capítulo 05", "EP. 12", 42, "42"
function parseEpisodeNumber(value, fallback = null) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  const str = String(value || "");
  // Bare integer string
  const bare = str.match(/^0*(\d+)$/);
  if (bare) return Number(bare[1]);
  // Prefixed: E3, Ep.12, Episode 01, EP. 5, Capitulo 3, Cap. 3
  const prefixed = str.match(/(?:ep(?:isode)?|cap(?:ítulo|itulo)?|e)[\s.\-#]*0*(\d+)/i);
  if (prefixed) return Number(prefixed[1]);
  // Trailing number: "Titulo 12", "Title - 04"
  const trailing = str.match(/\b0*(\d+)\s*$/);
  if (trailing) return Number(trailing[1]);
  return fallback;
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
          videoUrl: episode,
          server: "Local"
        };
      }

      const url = getEpisodeUrl(episode);
      const streamResolver = episode.streamResolver || episode.resolver || null;
      const externalUrl = episode.externalUrl || episode.embedUrl || episode.iframeUrl || "";
      const subtitles = normalizeSubtitleTracks(episode);
      // Parse episode number robustly — never leave it as a string that sorts lexically
      const rawEpNum = episode.episode ?? episode.number;
      const epNum = parseEpisodeNumber(rawEpNum) ??
                    parseEpisodeNumber(episode.title) ??
                    (index + 1);
      return {
        id: episode.id || episode.slug || `${item.id || item.title || "episode"}-${index}`,
        title: episode.title || episode.name || `Episode ${epNum}`,
        season: Number(episode.season || episode.seasonNumber || fallbackSeason) || fallbackSeason,
        episode: epNum,
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
    const seasonNumber = Number(episode.season || episode.seasonNumber || 1) || 1;
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
      const numA = Number(a.episode || a.number || a.episodeNumber || 0);
      const numB = Number(b.episode || b.number || b.episodeNumber || 0);
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
  const options = raw.map((source, index) => ({
    id: source.id || source.source || `source-${index}`,
    label: cleanPlaybackSourceLabel(source.label || source.name || source.server || source.source || `Source ${index + 1}`),
    type: source.type || (source.externalUrl || source.embedUrl || source.iframeUrl ? "iframe" : "direct"),
    videoUrl: pickPlayableUrl(source) || source.url || "",
    externalUrl: source.externalUrl || source.embedUrl || source.iframeUrl || source.embed || "",
    downloadUrl: source.downloadUrl || source.download || source.download_url || source.fileUrl || source.file_url || pickPlayableUrl(source) || "",
    streamResolver: source.streamResolver || source.resolver || null
  }));
  if (pickPlayableUrl(episode)) {
    options.unshift({
      id: "direct",
      label: cleanPlaybackSourceLabel(episode.server || "Direct"),
      type: "direct",
      videoUrl: pickPlayableUrl(episode),
      downloadUrl: episode.downloadUrl || episode.download || episode.download_url || pickPlayableUrl(episode)
    });
  }
  if (episode.externalUrl) {
    options.push({
      id: episode.viaAniPub ? "anipub" : isAnime1vEpisode(episode) ? "anime1v" : "external",
      label: cleanPlaybackSourceLabel(episode.viaAniPub ? "AniPub" : isAnime1vEpisode(episode) ? "Anime1v" : episode.server || "External"),
      type: "iframe",
      externalUrl: episode.externalUrl,
      downloadUrl: episode.downloadUrl || episode.download || episode.download_url || ""
    });
  }
  if (episode.streamResolver) {
    options.push({
      id: episode.streamResolver.type || "resolver",
      label: cleanPlaybackSourceLabel(episode.server || sourceLabelFromResolver(episode.streamResolver)),
      type: "resolver",
      streamResolver: episode.streamResolver
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
  const day = airingDate ? airingDate.toLocaleDateString([], { weekday: "short" }) : "TBA";
  const time = airingDate ? airingDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "TBA";
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
    const key = url || `${episode.season || 1}-${episode.episode || episode.title || byEpisode.size}`;
    const existing = byEpisode.get(key);
    byEpisode.set(key, {
      ...existing,
      ...episode,
      videoUrl: url || existing?.videoUrl || "",
      locked: episode.locked ?? existing?.locked ?? !url
    });
  });
  return [...byEpisode.values()].sort((a, b) => Number(a.episode || 0) - Number(b.episode || 0));
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
