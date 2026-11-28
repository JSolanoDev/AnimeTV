// Upstream episode pages also contain thumbnails for recommended titles.
function episodeGallery(images, sources, episode) {
  const ids = new Set();
  for (const source of sources || []) {
    try {
      const watch = new URL(source.watchUrl);
      if (watch.protocol === "https:" && ["underhentai.net", "www.underhentai.net"].includes(watch.hostname)
        && watch.pathname.replace(/\/$/, "") === "/watch") ids.add(watch.searchParams.get("id"));
    } catch { /* Older snapshots can lack a watch URL. */ }
  }
  return [...new Set(images || [])].filter(image => {
    try {
      const url = new URL(image);
      const path = /^\/thumbs\/(\d+)\/(\d+)\/\d+\.(?:jpe?g|webp|png)$/i.exec(url.pathname);
      return url.origin === "https://static.underhentai.net" && path
        && ids.has(path[1]) && Number(path[2]) === Number(episode);
    } catch { return false; }
  });
}

function cleanSnapshotEpisode(episode) {
  const screenshots = episodeGallery(episode.screenshots, episode.sourceOptions, episode.episode || episode.number);
  const clean = url => episode.screenshots?.includes(url) && !screenshots.includes(url) ? "" : url;
  return { ...episode, screenshots, galleryStatus: screenshots.length ? "available" : "unavailable",
    image: clean(episode.image), thumbnail: clean(episode.thumbnail) };
}

module.exports = { episodeGallery, cleanSnapshotEpisode };
