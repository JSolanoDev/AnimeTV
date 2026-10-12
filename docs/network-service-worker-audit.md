# ZenkaiTV Network and Service-Worker Audit

Date: October 11, 2026. Production baseline: v1019, commit 35e4b39.
Local candidate: v1020 on `codex/network-service-worker-audit` in `AnimeTV-network-audit`.
No push, deployment, Cloudflare settings changes, DNS changes or credential changes were authorized or performed for this audit.

## Findings and Priorities

1. **Confirmed, fixed locally: Cache Storage failures could break healthy responses.** An image download returning 200 became a synthetic 503 when `cache.put()` rejected. Cache open/read failures prevented some online artwork, scripts and external resources from reaching the network. An old cached 204 image stayed pinned in the persistent image cache. Three focused tests failed before the patch and pass afterward. These bugs are independently reproduced; they have not been proven to explain the original 106 console errors.
2. **Confirmed: the screenshot measures browsing with HTTP caching disabled.** The Disable cache checkbox is checked. The timeline also extends past 130 seconds, so the footer is not an independently verified exact 90-second sample. This setting changes HTTP-cache reuse, not every application or Cache Storage cache. It can cause repeated GIF downloads and extra API/media requests; it does not establish that caching is broken in normal browsing. [Chrome documentation](https://developer.chrome.com/docs/devtools/network/reference/).
3. **Confirmed: the paired XHR/service-worker rows do not mean two network transfers.** The outer entries say `(ServiceWorker)` while the inner fetch entries have the byte sizes. The service worker forwards `/api/source` once. A real browser fixture with one fetch and one XHR to the same no-store endpoint recorded exactly two origin requests and 88 response-body bytes, not four requests. Separate verification/prefetch calls must still be counted separately.
4. **Confirmed: the numbered source requests shown are sequential media fragments, not episode-source polling.** The screenshot shows different fragment paths ending in 019, 020, 021, 022 and 023. Inspected production responses have video/mp4 media types, even though these provider paths end in .html. Manifest responses use an HLS MIME type. Existing MIME corrections must remain.
5. **Confirmed: playback buffers well ahead and does extra bounded verification.** HLS settings allow 90 seconds of normal forward buffering, a 180-second maximum, and 96,000,000 bytes. Startup verification reads the manifest and two complete initial fragments; adjacent-episode preparation can do the same. This helps explain response-body volume. Changing these is higher risk than fixing optional storage. No buffer, probe, codec, playback source, fallback, seeking or Cast behavior was changed.
6. **Confirmed but not fixed: an injected analytics script is blocked by CSP.** Both playback captures reproduced an enforced script-src-elem violation for Cloudflare Insights. Playback still decoded and advanced. No security policy was relaxed. Reviewing/removing redundant analytics injection would require a separately approved production settings change.
7. **Still unresolved: the original 57 resource issues, eval issue and 106 errors.** The screenshot is a grouped count, not an inventory of blocked URLs or proof of 57 report POSTs. Neither fresh playback capture reproduced the eval violation or that error count. Do not assume these all come from analytics, are all harmless, or enable unsafe-eval to suppress them. The connected audit browser does not expose the original Chrome DevTools log; a fresh capture cannot reconstruct that missing history.

## Capture Method and Limits

- Read-only production homepage trace and bounded regular-anime playback samples, with no CPU/network throttling configured in the audit browser.
- First direct One Piece episode 904 capture: 22:50:37.911 UTC, 90,011 ms.
- Repeat direct episode 904 capture: 23:08:22.348 UTC, 90,001 ms. This was a warm/repeat session, not a clean first-visitor benchmark.
- Collected Resource Timing and CSP violation events from the top document and accessible frames; Chrome network and console inspection supplemented the event collector.
- Duplicate PerformanceObserver deliveries were removed using URL identity, frame, start time, duration, byte lengths and status. First capture: 238 raw events became 202 distinct observations. Repeat: 222 became 164. This collector issue is not an application duplicate-request finding.
- Same-origin service-worker responses and cross-origin resources frequently expose transferSize 0. Some cross-origin entries expose no response-body sizes either. Zero is not proof of a free or absent transfer. Consequently the table below is **browser-visible response-body volume, not unique network transfers, an HAR bandwidth total, or Cloudflare billed bytes**.
- Full upstream URLs, signed query parameters, cookies, authorization headers and credential values are omitted. Resource identities are opaque numeric IDs inside the collector. No explicit adult media was inspected.
- The browser tool could return a privacy-safe neutral-fixture screenshot inline but denied exporting it to this worktree. The fixture and its counter evidence below provide reproducible proof without bypassing that restriction.

## Response-Body Breakdown

Decimal MB; distinct observed entries after removing collector duplicates. Separate application requests for the same URL remain separate observations.

| Category | First entries | First recorded body MB | Repeat entries | Repeat recorded body MB |
| --- | ---: | ---: | ---: | ---: |
| Video, including manifests and probes | 28 | 66.762 | 30 | 52.041 |
| APIs and catalog/bootstrap JSON | 42 | 18.204 | 15 | 17.498 |
| Images with visible body sizes | 92 | 5.325 | 92 | 6.121 |
| JavaScript with visible body sizes | 27 | 0.907 | 12 | 0.139 |
| GIFs | 6 | 0.365 | 8 | 0.476 |
| Other, including styles and challenge resources | 7 | 0.300 | 7 | 0.051 |

Each capture included 84 direct third-party Resource Timing entries. They overlap the categories above and must not be added as another bandwidth category. Their body sizes were not exposed in these captures. Observed hosts included image.tmdb.org, cdn.myanimelist.net, cdn.animeav1.com, cdn.jsdelivr.net, www.gstatic.com, cdn.vercel-insights.com and static.cloudflareinsights.com; the last is CSP-blocked. Video from the external provider is proxied through the first-party `/api/source` route, not a separate direct third-party transfer category.

**Compression check:** a separate normal-resolver HTTPS GET of `/api/catalog` advertised gzip and received 2,928,013 compressed response-body bytes, HTTP 200, Server cloudflare, gateway MISS. Browser-visible catalog bodies in the captures were approximately 16.25 MB. These are different-time requests, not an exact compression A/B, but they confirm the large JavaScript-visible catalog is already compressed on the wire. Its browser policy remained max-age=300. No catalog body content was logged during this native check.

The original 101 MB/129 MB footer cannot be precisely apportioned from the screenshot alone. The response-body table above is a new measurement with stated limitations, not a reconstructed breakdown of that original recording.

## Source Requests, Polling and Prefetch

The first capture included 22 distinct video URL identities across 28 observations. The current episode's manifest and initial two fragments were inspected before player playback. Adjacent episode 905 had its own distinct manifest and initial fragment identities. Repeated manifest requests inspected in Chrome retained the same Cf-Ray and Date, supporting HTTP response reuse for that example; this does not prove every repeated media request avoids a transfer.

- `/api/animeav1/sources`: two observations, for current/adjacent episode preparation, not a rapid repeated polling loop.
- Catalog and provider slug index: one each per captured direct navigation. The catalog accounted for about 16.25 MB of JavaScript-visible data; the slug index about 1.07 MB. Neither was continuously polled during the sample.
- First capture TMDB season reads: 25 observations with 23 distinct query identities, about 0.52 MB visible body volume. Continuous long-series metadata can load multiple historical seasons for absolute episode names/stills. The repeat capture needed none. Making this strictly visible-season-only is a possible future optimization but needs metadata/season navigation regression coverage before implementation.
- Mounted-player guards and in-flight promises constrain episode warming. Adjacent warming begins after readiness/adequate buffering and near the ending; it is not an unrestricted whole-catalog prefetch.
- The 30-second `checkSourceRefreshes()` startup task refreshes user-added old full-site sources, not every anime episode. Discovery refreshes every 15 minutes only on eligible visible discovery views, and not during playback. No unbounded source retry or polling loop was reproduced here.
- Remaining fallback requests and real provider errors must not be reclassified as successful responses or eliminated without source-availability evidence.

Relevant code: `client.js` functions `probeHlsManifest`, `warmEpisodePlaybackIntent`, `renderDirectVideoPlayer`, `checkSourceRefreshes`; HLS configuration and mascot lifecycle in `player/player.js`.

## GIF Audit

The player cycles three existing local files: review, idle and waving. Their combined on-disk size is 193,028 bytes. It creates an Image preloader for each pose transition and assigns the visible image afterward, so logical image requests can recur. The animation stops its main timer when hidden, honors reduced motion, and cleans up its timers/listeners on disposal.

The screenshot's repeated inner fetch rows show roughly 63.3 KB, 83.9 KB and 49.1 KB responses under Disable cache. A final native production header check found `public, max-age=0, must-revalidate` for the idle GIF, not an immutable policy. Its ETag-based conditional GET returned 304 with zero response-body bytes. Normal browsing can therefore revalidate and reuse this file, but repeat network requests are possible even with HTTP caching enabled. Other GIF headers were not individually checked. GIFs are small relative to video here, and no player animation or static-header policy was changed. A separately reviewed versioned-URL/cache-policy fix could reduce revalidation; memoizing pose URLs alone does not guarantee fewer transferred bytes.

## CSP and Console Audit

| Observed issue | Attribution / functionality | Action |
| --- | --- | --- |
| Enforced script-src-elem, Cloudflare Insights | Analytics collection blocked; 1080p video still played | Keep CSP; separately review analytics injection |
| Invalid preload href | App creates the LCP preload link before assigning href in renderCarousel | Low-priority ordering cleanup proposed, not implemented |
| allow versus allowfullscreen precedence | App iframe declares overlapping permissions | No playback failure observed; no policy change |
| Deprecated StorageType.persistent | Chrome issue source is `/cdn-cgi/challenge-platform/scripts/jsd/main.js` | Cloudflare challenge code, not app cache code; do not remove security checks |
| Deprecated Protected Audience API | Same Cloudflare challenge script | Vendor warning; no app functionality failure observed |
| Screenshot's eval CSP issue | Not reproduced; owning script/frame unavailable | Still needs the original issue details or reproduction; unsafe-eval remains blocked |
| Other original resource CSP issues/errors | Screenshot does not enumerate affected resources | Not individually validated; no blanket harmlessness claim |

There was one actual ZenkaiTV player iframe. A separate 1x1 same-origin iframe held Cloudflare challenge scripts; it was not a second video player. No report POST inventory was observed in these bounded samples. All event-captured CSP violations were enforced, not report-only. [SecurityPolicyViolationEvent documentation](https://developer.mozilla.org/en-US/docs/Web/API/SecurityPolicyViolationEvent).

## Service-Worker Cache Findings and Local Patch

The persistent image cache is separate from the versioned shell and remains capped at 500 entries. The patch keeps both existing cache namespaces and does not wipe warm artwork.

- Cache open/read failures now fall through to the network.
- Successful online responses are returned without awaiting optional writes. `waitUntil` holds caught cache writes and trimming; quota or storage failures do not invent a 503 or replay a healthy download.
- Cached empty/non-image artwork is ignored so a future healthy response can replace it. New artwork writes require HTTP 200 and an image Content-Type; 204/404/503/HTML are not stored as posters.
- HTTP 206 and `Vary: *` responses are passed through without unsupported writes. The Cache.put algorithm rejects these cases. [Service Workers specification](https://w3c.github.io/ServiceWorker/#cache-put).
- Existing canonical cached player-document navigation remains, including its transport-error fallback. Source query parameters still belong to the requested iframe URL.
- External resource stale-while-revalidate remains; its background request and cache write have bounded event lifetime and handled rejections. It still starts a refresh on a hit, which can be served by the browser HTTP cache. This audit does not claim it is always free.
- `/api/source`, source-discovery APIs, Range headers, cancellation and real provider HTTP errors retain the network-only behavior. No media caching policy or source URL rewriting was added.
- The existing external-resource branch is broad and may store successful non-image CDN responses in IMAGE_CACHE. Tightening it to an explicit public-static allowlist is a separate security/caching design change; it was not silently combined with this failure-handling patch.
- Install/activation shell-fill tolerance, offline fallbacks, separate adult cache and production cache/security settings are preserved.

Runtime changes are confined to root/Android service workers plus required v1020 cache-busting references. `client.js` and player.html changes only bump asset references, not application/playback behavior. All 28 mirrored files are byte-identical. No dependency or lockfile changes.

## Browser Counter Proof

Run `node scripts/audit-service-worker-network.mjs`, then open its printed localhost URL in a browser. The fixture uses the actual candidate worker, neutral JSON, the existing logo as an opaque image, and a second localhost origin for partial responses. It never contacts content providers or alters production caches.

Observed results:

```json
{
  "controlled": true,
  "originCounts": {
    "source": 2,
    "sourceBodyBytes": 88,
    "healthyImage": 1,
    "legacyImage": 1,
    "partial": 2
  },
  "recoveredStatus": 200,
  "partialStatuses": [206, 206],
  "partialCached": false,
  "passed": true
}
```

Each image was requested twice by the page but reached its origin once. The seeded 204 recovered to 200. Each external partial response stayed 206, was not cached, and was not retried. No console errors or warnings appeared in this fixture. The owned fixture server and browser tab were stopped/closed after validation.

## Cloudflare Cost Opportunities

1. Ship the reviewed storage-failure patch only after deployment approval. It improves reliability and avoids unnecessary recovery downloads where browsers cannot use Cache Storage; no fixed billing saving is claimed.
2. Measure normal cache-enabled production browsing before extrapolating the cache-disabled screenshot. One service-worker interception pair is not two Worker invocations; only actual requests reaching Cloudflare count.
3. Preserve existing compressed catalog delivery, immutable artwork, frontend/static asset routing and short healthy public metadata cache TTLs. They reduce payload or backend/container work without hiding provider failures.
4. Next investigate safe reuse of *successful* exact-episode verification and lazy long-series metadata. Require matched source identity, expiry/cancellation handling, broken-provider tests, names/stills coverage and real playback checks before changes. Do not blindly remove probes or lower buffers.
5. Review unnecessary analytics injection before expanding CSP. Static GIF loader bookkeeping and the invalid preload warning are lower priority than video and catalog delivery.

Worker execution, container runtime/egress and direct third-party traffic are different cost dimensions. An edge cache hit can avoid backend work without avoiding a Worker invocation. Static assets served directly have different accounting from API/media routes. No full-site media relay, signed-source shared cache, free-video-egress promise or monthly saving extrapolation was introduced. [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

## Validation

- Three reproduced image-cache regressions failed before implementation; all 16 focused service-worker tests now pass, including final-review additions for slow writes, FIFO trim failures and exact partial Range responses.
- Full `npm run check`, `npm test` and ESLint including service-worker.js pass. One old source-text assertion for the player shell needed updating to the cache-read helper; additional behavioral tests verify canonical reuse and read/write-failure behavior.
- All 53 Cloudflare gateway/container/production contract tests pass, including HLS/MP4 Range, cancellation, private-address guards, provider-error status and compressed responses.
- `npm run build` and `npm run build:verify` pass: 57 verified static files in each output. Build-generated homepage-bootstrap.json is semantically unchanged.
- Asset guards pass: all 25 root/Android references are v1020, no stale helper versions, all 28 mirrors byte-identical. `git diff --check` passes.
- Production playback baseline decoded at 1920x1080, advanced time and had readyState 4 with no video error. Repeat sample had approximately 95 seconds buffered ahead at inspection. This is evidence for those bounded samples, not every episode or provider.
- No new hosted version was published. Supabase remains disabled; CSP, sources, source verification, codec/fallback/Cast behavior, production container caps and idle sleep are unchanged.
- The original complete error/CSP inventory and exact original transferred-byte breakdown remain unavailable. Hardware Chromecast, Smart TVs, native mobile gesture/fullscreen and the whole catalog were not tested in this audit.

Final production preparation, scope review, sampled local desktop/mobile playback, known limitations, v1019 rollback target and the post-approval cold/warm checklist are recorded in `docs/v1020-production-readiness.md`. No release commit, push or deployment has occurred.
