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
- Generic `fetchWithRetry` stops on 429 so stale/fallback behavior can take over; other retryable failures wait only between attempts. The shared metadata loader respects `Retry-After` before requesting the same key again.
- Full episode streaming and Chromecast receivers require live provider/device tests; unit and local browser checks cover the unchanged player integration, not the two physical TVs.

## Production follow-up: 2026-10-03

Read-only Vercel queries used a fixed **25-hour** production window:
2026-10-02 21:00 UTC through 2026-10-03 22:00 UTC. These measurements precede
the v940 changes. They are not a post-change comparison or a load test.

| Route | Function invocations | Function duration P75 |
| --- | ---: | ---: |
| `/api/tmdb/search` | 5,440 | 53 ms |
| `/api/image` | 3,608 | 253 ms |
| `/api/source` | 1,665 | 1,165 ms |
| `/api/animeneon/sources` | 867 | 339 ms |
| `/api/anilist/media` | 739 | 115 ms |
| `/api/tmdb/season` | 647 | 33 ms |
| `/api/jikan/episodes` | 592 | 8,004 ms |
| `/api/anilist/search` | 414 | 128 ms |
| `/api/jikan/full` | 400 | 8,004 ms |
| `/api/catalog` | 40 | 1,214 ms |

Across all routes the query returned 17,418 invocations, 945 HTTP 5xx responses
(5.43%), and 111 invocations marked `errorCode=timeout` (0.64%). Those timeouts
had HTTP 206 responses and occurred on `/api/source`; response headers alone
would miss them. No 429 responses appeared in this function summary. This is
not a guarantee that edge security never blocked requests.

Failures were concentrated in AnimeNeon sources (711 HTTP 502), JKAnime sources
(190 HTTP 503), image retrieval (181 HTTP 403), and the media relay. These
metrics identify failing routes, not the exact underlying provider failures.
Provider availability and media-relay timeouts remain unresolved by this change.

### Existing CDN and resource settings

- Two sequential production reads of `/api/catalog` returned MISS then HIT:
  960 ms then 149 ms. AniList media ID 21 returned MISS then HIT: 268 ms then
  30 ms. These are individual smoke measurements, not latency percentiles.
- Fluid Compute is enabled. The function still has a 30-second maximum duration;
  no memory, duration, region, or protection setting was changed.
- Current-cycle project usage reported 118.650 GB Fast Origin Transfer
  ($7.13 attributed cost) versus approximately 332,627 Function Invocations
  ($0.20 attributed cost). Transfer is the larger cost driver. These are
  project usage figures, not a final invoice; team subscription/agent charges
  are separate. The billing cycle is September 8 through October 8, 2026.
- Broadly caching `/api/source` is unsafe: it relays media and range requests,
  not just metadata, and can involve signed or client-bound URLs. Existing
  narrow media-cache policies remain unchanged.

### Targeted v940 changes

1. Share identical anonymous AniList, Jikan, and TMDB JSON requests across
   metadata hydration, franchise loading, and artwork resolution. Cache only
   responses whose HTTP headers permit it, subtract `Age`, limit storage to
   128 entries, and return independent objects to consumers. URL keys preserve
   language, season, and expected-episode parameters. Explicit season artwork
   refresh still bypasses the completed browser cache.
2. Coalesce simultaneous identical `/api/image` upstream fetches and Sharp
   transforms within a warm function instance. Keep no completed image buffers
   in memory. Preserve image quality, transform limits, host allowlist, response
   contracts, and immutable CDN headers. Apply the existing 10-second deadline
   through upstream body consumption, not only until headers arrive.
3. Stop client retry loops immediately on HTTP 429, cancel failed response
   bodies, and avoid sleeping after the final attempt. Shared metadata keys
   honor numeric or HTTP-date `Retry-After` values before another request.

These changes do not coalesce across separate Vercel instances. CDN hits remain
the mechanism for sharing responses across users. Stream lifetimes, source
selection, player/Cast code, adult classification, and UI were not changed.

### Validation and limits

- `npm test`, `npm run check`, `npm run vercel-build`, and `git diff --check`
  passed. Checks include security, catalog integrity, asset versions, and
  byte-identical Android mirrors. `isSafeAdultMetadata()` remains unchanged.
- Deterministic tests: 100 identical metadata consumers share one HTTP request;
  100 simultaneous image misses share one upstream fetch. Tests also cover
  distinct cache keys, freshness, refresh, 429 cooldown/recovery, transient
  failures, bounded cache size, and transform/host isolation. This is fixture
  evidence, not a distributed 100-user production capacity test.
- Local v940 browser checks loaded the homepage/carousel and anime details with
  all 12 episodes, descriptions, and thumbnails; no browser errors were recorded.
- Production savings and after-change latency/error rates have not been
  measured. Physical Chromecast and full live-stream playback were not retested
  in this audit. Catalog inventories do not prove every remote video is playable.

## UPNShare preference (local v943)

- Prefer eligible UPNShare candidates before other regular hosts. Reuse the
  existing AnimeAV1 payload, including its UPN embed, rather than adding an API
  route or a background scan of every episode. Local Sub intent/discovery uses
  AnimeAV1 first; successful primary discovery leaves other providers dormant.
- Keep complete-media verification, bounded fallback concurrency, signed-URL
  freshness, codec checks, and the existing automatic recovery ladder. Recent
  UPN failures share one host-family cooldown across episodes. Latino discovery
  and candidate selection keep the requested audio ahead of Sub candidates.
- Do not remove the production IP-bound-source guard: AnimeAV1 UPN remains
  ineligible for hosted primary playback. A successful local stream is not proof
  that a signed stream survives separate Vercel workers. No Vercel settings,
  stream-cache lifetimes, media relay, player/Cast implementation, or adult
  source admission rules were changed for this preference update.
- Live local metadata samples exposed UPN for One Piece 901 and Yasei Season 2
  Episode 2. Initial probes returned 200 for master/child playlists but 403 for
  both sampled media fragments of each episode. Later browser playback of Yasei
  Episode 2 succeeded through UPN, advancing beyond 80 seconds; a sample at
  63.7 seconds had readyState 4 and about 148 seconds of buffered headroom.
  This demonstrates variable availability, not universal episode coverage or
  a sub-second startup guarantee. The test was paused afterward.
- The final v943 browser smoke test also mounted One Piece 901 through UPN HLS.
  Its DOM sample showed readyState 4 and about 180 seconds buffered ahead of
  the sampled 99-second position. No console warnings/errors were captured;
  playback was paused and the temporary tab closed.
- Regression coverage includes primary ordering, single-provider discovery,
  missing/failed UPN recovery, cross-episode host cooldown, production admission,
  supported codecs, and Latino priority (including progressive dub mirrors).
  `npm test`, `npm run check`, `npm run vercel-build`, and `git diff --check`
  passed; Android mirrors are byte-identical. Production invocation savings and physical Chromecast have not been measured
  for this update. Not deployed.

## Daily catalog retention (local v944, 2026-10-03)

### Confirmed failure

- The last five scheduled GitHub runs failed. In run
  [37117520238](https://github.com/JSolanoDev/AnimeTV/actions/runs/37117520238),
  scraping and metadata preparation succeeded, but validation rejected eight
  movies/ONAs whose published episode-zero routes had been cleared by the
  inventory builder. Embed-only UPNShare pages were incorrectly treated as
  confirmed unavailable when the direct-media probe could not run. The guarded
  publisher correctly restored the previous catalog instead of publishing it.
- Independently, a recent-episode scrape replaced saved episodes/seasons, a
  partial inventory could replace older routes, and missing catalog partitions
  were restored only when the overall title count shrank. New titles could
  therefore hide losses in another partition. Long-series starter snapshots
  omitted exact IDs but did not retain partial-inventory provenance.

### Targeted changes

- Merge episode updates by canonical season/episode, retain other seasons and
  saved nonempty metadata, and skip malformed numeric provider fields.
- Retain every missing saved catalog identity regardless of total-count growth.
  Merge observed routes with the saved same-slug inventory. Respect explicit
  confirmed removals without inventing gaps, future episodes, or sibling IDs.
- Merge rendered routes with the exact title's serialized inventory in both the
  offline builder and existing server parser. Client merges retain same-title
  routes across stale responses; compact starters remain explicitly partial.
- An embed-only page, or a failed direct mirror with an untested embed fallback,
  is inconclusive rather than proof of a deleted episode. Probe media with a
  bounded range, cancel its body after the first chunk, and retain explicit
  404/410 handling.
- Stop new inventory requests after an HTTP 429, preserve saved inventories and
  their verification dates, and record `Retry-After`; no immediate retry loop.
- Add a per-title/per-episode retention validation gate, run inventory regression
  tests before the daily crawl, and use Node 24 for that GitHub job. The existing
  daily schedule remains `06:00 UTC`; publication remains guarded.

These changes add no API endpoint, background client fetch, or Vercel Function
call. Existing catalog CDN caching, provider/Cast playback paths, adult safety,
security, and Vercel resource settings remain unchanged by this catalog fix.

### Verification and remaining limits

- Full JavaScript tests, safety/mirror checks, the Vercel build, and whitespace
  checks passed. The focused retention suite passes 96 tests; Python passes 7.
- A real builder subprocess against a mock rate-limited provider made one
  request, kept both saved inventories, and stopped further upstream calls.
- Bounded live inventory reads recovered episode zero for all eight rejected
  movies/ONAs. Yasei Season 2 reported `[1, 2]`; Tensei shitara Ken deshita II
  reported `[1]`, so no second episode was fabricated. Local browser testing
  showed both Yasei episodes before and after reload without console errors.
- The local saved catalog still predates the failed daily jobs. Ken, absent
  from that saved snapshot and the current latest feed, did not resolve on a
  direct local anime URL. This data freshness limitation is not reported as
  fixed by a publication that has not occurred. A successful full daily run
  must still be verified after activation; the entire remote video inventory
  was not replayed or proven universally available.
- The user explicitly requested local review. No commit, push, workflow dispatch,
  or deployment was performed; GitHub and production do not have these fixes.

## Daily updater and fresh releases (v945, 2026-10-03)

The user subsequently authorized pushing the validated fixes and deploying.
The previous local-only status above describes the earlier review checkpoint.

- The six scheduled runs from September 28 through October 3 failed at the
  regular catalog validation gate on the same old commit. The latest normal
  push CI succeeded. The gate is retained; it must not publish lost episodes.
- Reproduced the schedule error: the 25 aliased Media queries returned HTTP
  400, complexity 925 versus the allowed 500. The equivalent single Page query
  returned HTTP 200 and all 25 records. Batches now use that query and 2.5-second
  pacing. HTTP 400/403/429 stops that provider pass, keeping saved/fallback data.
- Prioritize new and identity-repaired artwork rows before old failed matches.
  Offline metadata without a synopsis is topped up with batched AniList data;
  missing/null upstream values no longer erase saved metadata.
- Attach exact-slug, compact static artwork/description fields to the existing
  latest endpoint and reuse them in new-title client rows. No new API endpoint,
  per-user upstream query, background scanner, or Vercel resource increase.
- Recovered the October 3 rejected snapshot, preserving local curated records
  and all saved episode inventories. Ten bounded live title-page reads added
  releases posted afterward; ten further reads refreshed the recovered new
  titles. Catalog grew from 4,420 to 4,440 titles and passes retention validation.
  Yasei Season 2 has [1, 2]; Ken II has [1], with no future episodes fabricated.
- One metadata request filled descriptions for all 20 new titles. Nineteen have
  exact wide artwork; Zombie Sagashitemasu currently has only an exact poster
  fallback. No unrelated artwork was substituted. Artwork quality/availability
  cannot be guaranteed before the upstream publishes it.
- The existing source schedule was refreshed with one provider request. The
  daily cron, security protections, stream lifetimes, and Chromecast behavior
  remain unchanged. A complete newly published GitHub daily run must still be
  observed; local validation is not a claim that the remote run completed.
- Validation passed: `npm test`, `npm run check`, `npm run lint`,
  `npm run vercel-build`, seven Python scraper tests, and `git diff --check`.
  All 28 Android mirrors are byte-identical on v945. Local Ken II details have
  a synopsis, correct artwork, and a real episode still; Gensou details have
  no horizontal overflow at 390x844 or 1024x768. Yasei shows both saved episodes.
  Local source-metadata samples returned HTTP 200 in 366 ms (Yasei S2E2) and
  498 ms (One Piece 901), exposing embed candidates. These are single reads,
  not latency percentiles or proof of first-frame playback for every episode.
- Yasei S2E2 played locally through the existing embed recovery path. At 119.3
  seconds, its video had readyState 4 and 180.7 seconds buffered ahead. An embed
  resolution timeout was logged before successful recovery. The test was
  paused; physical Cast and every remote episode were not reverified.
