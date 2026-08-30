const CACHE_NAME = "zenkaitv-v459";
// Remote artwork lives in its OWN cache that survives version bumps. It used
// to share CACHE_NAME, so every deploy wiped every poster and the app
// re-downloaded all artwork from scratch.
const IMAGE_CACHE = "zenkaitv-images-v1";
const IMAGE_CACHE_MAX = 500;
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./offline.html",
  "./manifest.webmanifest",
  "./logo-mark-128.webp",
  "./logo-round-192.webp",
  "./logo-wordmark-480.webp",
  "./hero-backdrop-placeholder.webp"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME && key !== IMAGE_CACHE).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

// Keep the artwork cache bounded (FIFO): drop the oldest entries past the cap.
let trimPending = false;
function trimImageCache(cache) {
  if (trimPending) return;
  trimPending = true;
  cache.keys().then((keys) => {
    const excess = keys.length - IMAGE_CACHE_MAX;
    if (excess > 0) return Promise.all(keys.slice(0, excess).map((k) => cache.delete(k)));
  }).catch(() => {}).then(() => { trimPending = false; });
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  // Navigation requests: network-first, offline fallback
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => caches.match("./offline.html"))
    );
    return;
  }

  // API calls: network-only (always fresh)
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(event.request).catch(() => new Response("", { status: 503 })));
    return;
  }

  // Versioned static assets (?v=NNN): cache-first (they are immutable by URL)
  if (url.search.includes("v=")) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => caches.match("./offline.html"));
      })
    );
    return;
  }

  // External images and CDN resources: stale-while-revalidate
  if (url.origin !== self.location.origin) {
    event.respondWith(
      caches.open(IMAGE_CACHE).then((cache) =>
        cache.match(event.request).then((cached) => {
          const networkFetch = fetch(event.request).then((response) => {
            if (response.ok) {
              cache.put(event.request, response.clone()).then(() => trimImageCache(cache));
            }
            return response;
          }).catch(() => cached);
          // Serve the cached copy immediately when we have one; only revalidate
          // in the background so repeat visits do not re-request every poster.
          return cached || networkFetch;
        })
      )
    );
    return;
  }

  // Everything else: network-first with cache fallback
  event.respondWith(
    fetch(event.request).catch(() =>
      caches.match(event.request).then((cached) => cached || caches.match("./offline.html"))
    )
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
    event.waitUntil(fetch("/api/check-update").catch(() => null));
  }
});
