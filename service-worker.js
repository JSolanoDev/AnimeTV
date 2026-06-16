const CACHE_NAME = "zenkaitv-v310";
const ASSETS = [
  "./",
  "./index.html",
  "./offline.html",
  "./styles.css",
  "./client.js",
  "./update-manager.js",
  "./manifest.webmanifest",
  "./sources.json",
  "./logo-mark.png",
  "./logo-mark-192.png",
  "./logo-mark-512.png",
  "./logo-mark-transparent.png",
  "./logo-wordmark.png",
  "./player/player.html",
  "./player/video.min.js",
  "./js/constants.js",
  "./js/translations.js",
  "./js/utils.js",
  "./js/season-normalization.js",
  "./js/normalize.js",
  "./js/anilist-metadata.js",
  "./js/smart-source.js",
  "./js/image-resolver.js",
  "./js/adult-source-adapter.js",
  "./js/adult-mode.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => caches.match("./offline.html"))
    );
    return;
  }
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request).then((cached) => cached || caches.match("./offline.html")))
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data?.type === "CLEAR_CACHE") {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))));
  }
});

self.addEventListener("sync", (event) => {
  if (event.tag === "animetv-update-check") {
    event.waitUntil(fetch("./api/check-update").catch(() => null));
  }
});
