const CACHE_NAME = "zenkaitv-v559";
// Remote artwork lives in its OWN cache that survives version bumps. It used
// to share CACHE_NAME, so every deploy wiped every poster and the app
// re-downloaded all artwork from scratch.
const IMAGE_CACHE = "zenkaitv-images-v1";
const IMAGE_CACHE_MAX = 500;
// The page requests these WITH the cache-busting query (logo-mark-128.webp?v=NNN),
// so precaching the bare path never matched a single request - the whole precache
// was dead weight. Derive the version from CACHE_NAME so the two can never drift.
const ASSET_VERSION = CACHE_NAME.split("-v").pop() || "";
const versioned = (path) => (ASSET_VERSION ? path + "?v=" + ASSET_VERSION : path);
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./offline.html",
  "./manifest.webmanifest",
  versioned("./logo-mark-128.webp"),
  versioned("./logo-round-192.webp"),
  versioned("./logo-wordmark-480.webp"),
  versioned("./hero-backdrop-placeholder.webp")
];

// Caches only the shell assets that are not already stored, one at a time, and
// swallows individual failures.
//
// Per-asset (never cache.addAll): addAll is all-or-nothing, so a single 404
// rejects the install, the new worker never activates, and the client stays on
// the OLD worker forever - a genuine way to pin users on a stale shell.
//
// The cost of that tolerance is that a network blip during install leaves the
// offline shell incomplete, and install does not run again until the next
// version bump - so a user could sit for a whole release cycle with no cached
// offline.html. Activation therefore runs this a second time. The match() check
// makes the common case free: assets already cached by install are not
// re-requested, so the retry costs nothing when nothing is missing.
function cacheMissingShellAssets() {
  return caches.open(CACHE_NAME).then((cache) =>
    // One keys() call, compared on absolute URLs. Per-asset cache.match() with
    // these relative paths did not resolve reliably inside the worker and left
    // the whole precache empty, so presence is decided against the cache's own
    // request URLs instead - which is also one IDB round trip rather than eight.
    cache.keys().then((existing) => {
      const have = new Set(existing.map((request) => request.url));
      return Promise.all(SHELL_ASSETS.map((asset) => {
        const href = new URL(asset, self.location.href).href;
        if (have.has(href)) return null;          // already stored: no re-download
        return cache.add(asset).catch(() => {});  // one failure must not reject the batch
      }));
    })
  ).catch(() => {});
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheMissingShellAssets());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      // Generation cleanup first, so the retry below refills the CURRENT cache
      // and never resurrects an old one. IMAGE_CACHE is unversioned and kept.
      Promise.all(keys.filter((key) => key !== CACHE_NAME && key !== IMAGE_CACHE).map((key) => caches.delete(key)))
    ).then(cacheMissingShellAssets)
  );
  // Claimed synchronously: clients are taken over immediately whether or not the
  // refill succeeds, so a failing asset can never hold up activation.
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

  // The optimized same-origin artwork endpoint is immutable by its full URL.
  // Keep it in the persistent image cache so returning to a season does not
  // resize and download the same backdrop and episode stills again.
  if (url.origin === self.location.origin && url.pathname === "/api/image") {
    event.respondWith(
      caches.open(IMAGE_CACHE).then(async (cache) => {
        const cached = await cache.match(event.request);
        const refresh = () => fetch(event.request).then(async (response) => {
          if (response.ok) {
            await cache.put(event.request, response.clone());
            trimImageCache(cache);
          }
          return response;
        });
        if (cached) {
          event.waitUntil(refresh().catch(() => {}));
          return cached;
        }
        return refresh().catch(() => new Response("", { status: 503 }));
      })
    );
    return;
  }

  // Other API calls: network-only (always fresh)
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(event.request).catch(() => new Response("", { status: 503 })));
    return;
  }

  // Versioned static assets (?v=NNN): cache-first (they are immutable by URL).
  // Checks for a real `v` parameter: the old url.search.includes("v=") also
  // matched things like ?rev=2 and pinned them as permanently immutable.
  if (url.origin === self.location.origin && url.searchParams.has("v")) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        }).catch(() =>
          // NEVER fall back to offline.html here. This branch serves .js and .css;
          // returning an HTML page makes the browser parse "<!doctype html>" as
          // JavaScript ("Unexpected token '<'"), so one failed asset took the whole
          // app down with a syntax error instead of degrading to a missing file.
          new Response("/* ZenkaiTV: asset unavailable offline */", {
            status: 503,
            statusText: "Offline",
            headers: { "Content-Type": "text/plain; charset=utf-8" }
          })
        );
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
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        // Only a document may fall back to the offline page - see above.
        if (event.request.destination === "document") return caches.match("./offline.html");
        return new Response("", { status: 503, statusText: "Offline" });
      })
    )
  );
});

self.addEventListener("message", (event) => {
  // Lets the page compare the worker's generation against the one its HTML was
  // built for, so a mismatch is observable instead of silent. Reported only - the
  // page must not force a reload on it (that is how update loops start).
  if (event.data?.type === "GET_VERSION") {
    event.ports?.[0]?.postMessage({ cacheName: CACHE_NAME, assetVersion: ASSET_VERSION });
    return;
  }
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
