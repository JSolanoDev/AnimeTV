# Vercel Function and API audit

Snapshot: 2026-09-17. The site is a static client plus one catch-all Node Function
(`api/[...path].js` -> `animetv-server.js`), not a Next.js/React app. Production
metrics below are from the one-hour window before these changes. A CDN HIT does
not invoke the Function; in-memory coalescing only helps requests landing in the
same warm instance.

## Highest-volume avoidable work

| Route group | Function invocations/hour | Finding | Action |
| --- | ---: | --- | --- |
| AniList media + Jikan episodes | 299 | Nine scheduling sites could restart the same background card hydration; even complete baked cards requested extras. | Coalesce identical warm queues, skip complete baked cards, preserve on-open hydration. |
| TMDB season | 115 | Long-running series fetched the selected season twice while building global stills. | Reuse the first successful payload in the multi-season pass. |
| Image proxy | 115 | Unique artwork variants are first-time CDN misses, not repeated upstream calls for an identical URL; 20.1 MB Function egress/hour. | Keep the existing immutable CDN cache and proxy, since direct third-party images can fail and resizing is part of the UI. |
| Catalog | 7 Function invocations / 12 edge requests | CDN served 5 hits; 7.65 MB JSON and generic shared-IP rate limit produced 429s under repeat load. | Retain existing 1-hour edge TTL, remove unused scrape timestamp, remove unnecessary `Vary: Origin`, and give public catalog reads their own bounded limiter. |

## Route inventory and disposition

All routes below are dispatched by `animetv-server.js`. `sendJson` defaults to
`no-store`; only a route's explicit cache headers override it. Dynamic source
URLs may contain short-lived tokens, so they must not be broadly shared-cached.

| Category | Paths | Audit decision |
| --- | --- | --- |
| Shared catalog | `/api/catalog`, `/api/scraped-catalog` | Bundled snapshot; `/api/catalog` already has CDN SWR, in-memory TTL, in-flight coalescing and stale fallback. Trim only a field unused by the client. Keep scraped-catalog behavior intact. |
| Artwork and description | `/api/image`, `/api/description`, `/api/skip-times` | Image is immutable CDN-cached after a first miss; description and skip times are bounded metadata lookups. Do not bypass the poster proxy or change episode-derived timestamps. |
| AniList | `/api/anilist/media`, `/api/anilist/search`, `/api/anilist/airing`, `/api/anilist/trailers` | Media/search/airing already have edge TTLs (24h/1h/10m), in-flight maps, 429 cooldown and stale handling. Reduce needless callers instead of increasing concurrency or retrying. |
| Jikan | `/api/jikan/full`, `/api/jikan/search`, `/api/jikan/episodes` | Shared headers, memory caches, in-flight maps, serialized rate budget, 429 cooldown, stale fallback and timeouts already exist. Episode payloads are expensive, so avoid speculative card hydration. |
| TMDB | `/api/tmdb/search`, `/api/tmdb/tv`, `/api/tmdb/season` | Search is low latency and was not rewritten. TV/season have CDN and origin caching; removed a duplicate season fetch on long shows. |
| AnimeAV1 | `/api/animeav1/health`, `/api/animeav1/latest`, `/api/animeav1/search`, `/api/animeav1/catalog-search`, `/api/animeav1/slugs`, `/api/animeav1/sources` | Slugs/latest are public metadata; episode sources can change. Keep current short TTL and source fallback behavior. |
| JKAnime | `/api/jkanime/health`, `/api/jkanime/search`, `/api/jkanime/slugs`, `/api/jkanime/sources` | Provider fallback; do not remove or reorder. Slugs have a shared-cache policy. |
| AnimeOnlineNinja | `/api/animeonlineninja/health`, `/api/animeonlineninja/search`, `/api/animeonlineninja/sources` | Provider fallback; current timeout and resolution behavior retained. |
| TioAnime | `/api/tioanime/catalog`, `/api/tioanime/slugs`, `/api/tioanime/health`, `/api/tioanime/search`, `/api/tioanime/sources` | Catalog/slugs can be reused; search and sources depend on the live provider. No change without evidence of meaningful traffic. |
| Jimov TioAnime | `/api/jimov/tioanime/catalog`, `/api/jimov/tioanime/health`, `/api/jimov/tioanime/info`, `/api/jimov/tioanime/episodes` | Fallback catalog and episode metadata; no broad cache added because upstream freshness and identities vary. |
| AniPub | `/api/anipub/catalog`, `/api/anipub/catalog/all`, `/api/anipub/catalog/total`, `/api/anipub/debug-page`, `/api/anipub/health`, `/api/anipub/episodes/:id`, `/api/anipub/play` | Catalog/page caches already exist in the handler; play is dynamic. Debug/health are not shared metadata. |
| AllAnime | `/api/allanime/search`, `/api/allanime/watch`, `/api/allanime/stream` | Search and signed playback fallback; leave cache policy and source order unchanged. |
| Anime1v | `/api/anime1v/health`, `/api/anime1v/providers`, `/api/anime1v/search`, `/api/anime1v/trending`, `/api/anime1v/catalog`, `/api/anime1v/info`, `/api/anime1v/episodes`, `/api/anime1v/stream`, `/api/anime1v/episode` | Optional provider; dynamic stream and quota behavior retained. |
| APK OneAnime | `/api/apk-1anime/catalog`, `/api/apk-1anime/info`, `/api/apk-1anime/episodes`, `/api/apk-1anime/stream`, `/api/apk-1anime/watch` | Optional provider; live episode and stream lookup retained. |
| Rapid Anime | `/api/rapid-anime/health`, `/api/rapid-anime/catalog`, `/api/rapid-anime/recent`, `/api/rapid-anime/search`, `/api/rapid-anime/info`, `/api/rapid-anime/episodes`, `/api/rapid-anime/watch`, `/api/rapid-anime/stream` | Optional provider; existing catalog memory cache and source lookup retained. |
| Consumet KickAssAnime | `/api/consumet/kickassanime/health`, `/api/consumet/kickassanime/catalog`, `/api/consumet/kickassanime/search`, `/api/consumet/kickassanime/info`, `/api/consumet/kickassanime/episodes`, `/api/consumet/kickassanime/servers`, `/api/consumet/kickassanime/watch`, `/api/consumet/kickassanime/stream` | Optional fallback; server choices and playback links can expire, so no new shared cache. |
| Adult catalogs | `/api/adult/underhentai/catalog`, `/api/adult/underhentai/releases`, `/api/adult/hentaiocean/catalog`, `/api/adult/hanime/artwork` | Public provider metadata with bundled or memory fallback; existing adult catalog read bucket retained. Adult mode classification unchanged. |
| Adult detail/playback | `/api/adult/underhentai/details`, `/api/adult/underhentai/stream`, `/api/adult/hentaiocean/details`, `/api/adult/hentaiocean/stream`, `/api/adult/debug` | Provider details or signed playback; avoid shared caching of stream links. Debug route is diagnostic, not a catalog. |
| Media and resolver | `/api/source`, `/api/resolve`, `/api/crawl` | Media relay/range requests and short-lived embed resolution must keep their narrow cache rules and headers for playback and Chromecast. No generalized CDN cache. |
| App operations | `/api/health`, `/api/server-info`, `/api/config`, `/api/check-update`, `/api/apply-update`, `/api/refresh-daily`, `/api/language/preferences`, `/api/translate` | Status, configuration, mutation or input-dependent translation; do not share-cache indiscriminately. Update and preference behavior unchanged. |

## Guardrails and verification

- Fluid Compute is already enabled (`resourceConfig.fluid: true` in the Vercel project API); no memory/duration change was made.
- `API_PERF_DEBUG=1` on a local server prints route, origin-cache hint, upstream host/status/header duration and total route duration. It is disabled on hosted runtimes and never logs query strings or media tokens.
- The catalog browser request is already deferred and made once after the homepage bootstrap. No React effects or duplicate server/client catalog fetch were found.
- Generic `fetchWithRetry` stops on 429 and carries `Retry-After` to the caller so stale/fallback behavior can take over; other retryable failures wait only between attempts.
- Full episode streaming and Chromecast receivers require live provider/device tests; unit and local browser checks cover the unchanged player integration, not the two physical TVs.
