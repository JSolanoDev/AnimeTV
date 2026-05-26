// Data normalization — transforms raw API responses into the app's internal shape.
// Depends on: utils.js (pickGenre, cleanDescription, normalizeTitle, getShowKey, languageName, pickPlayableUrl, getEpisodeUrl, etc.)

function normalizeExternalShow(item, source, index) {
  const title = item.title || item.name || item.animeTitle;
  if (!title) return null;
  const genres = item.genres || (item.genre ? [item.genre] : []);
  const genre = pickGenre(genres.length ? genres : ["anime"]);
  const seasons = normalizeSeasons(item);
  const episodes = seasons.flatMap((season) => season.episodes);
  const videoUrl = pickPlayableUrl(item) || getEpisodeUrl(episodes[0]) || "";

  return {
    id: `source-${source.id || source.name}-${item.id || item.malId || item.anilistId || index}`,
    aniPubId: item.aniPubId || item.anipubId || item._id || (source.id === "anipub-catalog" ? item.id : ""),
    finder: item.finder || item.slug || "",
    malId: item.malId || item.idMal || item.mal_id || null,
    anilistId: item.anilistId || item.idAnilist || item.anilist_id || null,
    aliases: item.aliases || item.titles || [],
    title,
    episode: item.episode || item.episodeNumber || item.latestEpisode || "?",
    genre,
    genres,
    day: item.day || item.airDay || "Local",
    time: item.time || item.airTime || "",
    colors: item.colors || ["#40dfc2", "#251d47"],
    score: item.score || null,
    source: source.name || "Local Source",
    image: item.image || item.poster || item.cover || item.thumbnail || "",
    banner: item.banner || item.backdrop || "",
    siteUrl: item.siteUrl || item.url || "",
    description: cleanDescription(item.description || item.synopsis || "Local source title."),
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

  return groupEpisodesBySeason(normalizeEpisodes(item));
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
      return {
        id: episode.id || episode.slug || `${item.id || item.title || "episode"}-${index}`,
        title: episode.title || episode.name || `Episode ${episode.episode || episode.number || index + 1}`,
        season: episode.season || episode.seasonNumber || fallbackSeason,
        episode: episode.episode || episode.number || index + 1,
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
        locked: episode.locked ?? (!url && !streamResolver)
      };
    })
    .filter(Boolean);
}

function groupEpisodesBySeason(episodes = []) {
  const bySeason = new Map();
  episodes.forEach((episode) => {
    const seasonNumber = episode.season || 1;
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
    episodes: season.episodes.sort((a, b) => Number(a.episode || 0) - Number(b.episode || 0))
  }));
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
  if (resolver.type === "rapid-anime") return "RapidAPI";
  return "Addon";
}

function comparePlaybackSources(a = {}, b = {}) {
  return playbackSourceRank(a) - playbackSourceRank(b);
}

function playbackSourceRank(source = {}) {
  const label = `${source.id || ""} ${source.label || ""} ${source.streamResolver?.type || ""}`.toLowerCase();
  if (label.includes("anipub")) return 10;
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

  return {
    id: `anilist-${entry.id}`,
    malId: entry.idMal,
    title: entry.title.english || entry.title.romaji || entry.title.native || "Untitled Anime",
    episode: entry.nextAiringEpisode?.episode || entry.episodes || "?",
    genre,
    genres: entry.genres || [genre],
    day,
    time,
    colors: [color, "#211942"],
    score: entry.averageScore,
    source: "AniList",
    image: entry.coverImage?.extraLarge || entry.coverImage?.large || "",
    banner: entry.bannerImage || "",
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
    title: entry.title_english || entry.title || "Untitled Anime",
    episode: entry.episodes || "?",
    genre,
    genres,
    day: broadcast.day?.replace("s", "").slice(0, 3) || "TBA",
    time: broadcast.time || "TBA",
    colors: ["#58a8ff", "#2b1d47"],
    score: entry.score ? Math.round(entry.score * 10) : null,
    source,
    image: entry.images?.webp?.large_image_url || entry.images?.jpg?.large_image_url || "",
    banner: "",
    siteUrl: entry.url || "",
    description: cleanDescription(entry.synopsis),
    videoUrl: ""
  };
}

function mergeShows(items) {
  const byKey = new Map();
  items.forEach((show) => {
    const key = getShowKey(show);
    const current = byKey.get(key);
    byKey.set(key, {
      ...current,
      ...show,
      image: current?.image || show.image,
      banner: current?.banner || show.banner,
      description: current?.description || show.description,
      videoUrl: show.videoUrl || current?.videoUrl || "",
      episodes: mergeEpisodes(current?.episodes, show.episodes),
      seasons: mergeSeasons(current?.seasons, show.seasons),
      siteUrl: show.siteUrl || current?.siteUrl || "",
      source: current ? `${current.source} + ${show.source}` : show.source
    });
  });
  return [...byKey.values()].slice(0, 320);
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
