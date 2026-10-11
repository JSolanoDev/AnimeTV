# ZenkaiTV Cloudflare Performance Audit

Date: October 11, 2026. Branch: `codex/cloudflare-performance-audit`.
Audited base: `d8e635d08a59569bcf79a0de66f165dcc509b160` (frontend v1019).
Audit status: completed locally. The user subsequently approved deployment on October 11; publication is pending the existing gated Linux workflow. Production settings were read, not changed.
The primary dirty checkout, live catalog, DNS, billing, credentials, security rules and database remain untouched.

## 1. Prioritized Findings

| Priority | Evidence / root cause | Action and safety |
| --- | --- | --- |
| 1: correctness | Catalog MISS advertised browser `max-age=300`; HIT advertised `max-age=14400`. Gateway replaced the origin policy on storage; the zone's Browser Cache TTL is 14,400 seconds. | Locally preserve origin browser policy separately, restore it on HIT, carry Age forward and enforce a hard edge expiry. Never serve an expired entry even if a zone override retains it. Production/browser override interaction still needs post-deployment verification and approval before changing the zone setting. |
| 2: backend work | 2,995 successful TMDB searches, 458 season lookups and 267 TV lookups in the measured day; these routes advertised public caching but always bypassed the Worker cache. Airing/latest also bypassed it in native probes. Hosted checks also confirmed Node's `sendJson` uses chunked responses without Content-Length, preventing initial metadata cache admission. | Add short caching only for five anonymous public metadata routes, with the origin TTL as an upper bound. Those five routes may omit declared length only because their decoded payload is independently bounded/validated before storage. This avoids container calls on HIT, not Worker executions. |
| 3: real HTTP failures | Zero Worker exceptions coexist with 339 HTTP 5xx and 41 HTTP 429 responses in zone analytics. Image 504s and TMDB search 403s were visible. | Preserve failure codes, Retry-After, private-address/scanner guards and existing fallbacks. No fake 200s or aggressive retries. Diagnosing provider/WAF failures individually remains necessary. |
| 4: first visit | Clean desktop LCP 4,636ms; catalog request 4,432ms; initial image requests 2,542/3,647ms. Native catalog body was 16,248,998 bytes after decompression. | Keep existing compressed catalog, bootstrap-first delivery, identity merging and lazy enrichment. Reducing the catalog schema or changing artwork delivery requires separate profiling/contract work, not a speculative rewrite. |
| 5: cost | Successful `/api/source` responses accounted for 5.17GB of edge response bytes in one day. | Do not extend caching of signed URLs, rewrite media paths or redirect playback to unverified providers. This audit does not eliminate media/container bandwidth. |

The prioritized audit was presented before implementation. Changes were staged conceptually: cache correctness, metadata reuse, then regression/runtime validation. No frontend rewrite or new dependency was added.

## 2. Actual Architecture

- Vanilla classic-script SPA, not Next.js/React/TypeScript. No SSR adapter or React hydration/effect refetching applies. `client.js` and ordered global helpers share scope; Android mirrors and manual asset versions remain intact.
- Node HTTP backend: `animetv-server.js`; legacy Vercel catch-all: `api/[...path].js`. Current Cloudflare production entry: `ops/cloudflare/production-worker.mjs` -> production/container gateway -> one Durable Object -> Node container. Staging entry points remain separate.
- `wrangler.production.json` serves static assets directly. Only `/api*` and scanner patterns run Worker-first; versioned assets already avoid executing Worker code. One basic container, max one instance, five-minute idle sleep are unchanged.
- `scripts/build-static.mjs` uses Terser/CleanCSS. Production assets are already minified; no unnecessary minification/framework change was needed.
- `prepare-cloudflare.mjs` supplies static headers: versioned assets immutable for a year; HTML, service worker and unversioned bootstrap revalidate. Worker cache is explicitly `caches.default`; general Cache Rules are not assumed to cache generated APIs. Cache API is datacenter-local, not Tiered Cache. [Cloudflare cache behavior](https://developers.cloudflare.com/workers/reference/how-the-cache-works/).
- Homepage uses static bootstrap before full catalog; catalog fetches are coalesced, and airing data has an independent compact cache. Search/filtering use the saved catalog plus bounded provider/metadata enrichment; not every metadata request is a duplicate.
- Discovery refresh is visibility/route-gated, every 15 minutes, and disabled during playback and adult mode. Airing refresh is coalesced and hourly. Metadata warming has budgets, failure backoff and a three-failure stop. These safeguards were preserved.
- `fetchMetadataJson` already canonicalizes/deduplicates supported public metadata, has a bounded cache and respects HTTP age/cooldowns. Some TMDB call sites use the existing artwork-specific caches instead. No proven duplicate-request loop was removed during this audit.
- Supabase login remains disabled; SDK/login and user data work stay gated. No connections, credentials, permissions, session contracts or queries were changed. Browser config must never expose a service-role key.
- Image proxy uses Sharp and approved public-host/DNS guards. Client/SW image caches, responsive dimensions, decoder checks and fallback ladders remain unchanged. Catalog integrity warns that 1,445 regular titles and 2,010 season identities use exact-poster detail-background fallbacks; reference integrity is not a full visual-quality audit.
- Source resolution uses provider maps, generation/cancellation guards and verified HLS preference, then existing fallbacks. Player is one iframe, with HLS/native handling, codec protection and Cast ladder. Signed resolution, media Range, timers, listeners and cancellation were not rewritten.
- Existing Node rate limits, source-specific budgets, scanner blocking, CORS/CSP, private-address validation, bounded provider backoff and catalog publication protections remain in place. Shared-cache eligibility excludes cookies/auth and never routes private requests around the backend.

## 3. Production Baseline

Read-only authenticated Cloudflare GraphQL analytics; adaptive dataset counts may be sampled/estimated. User-supplied metrics and newly queried windows are not exactly the same snapshot.

| Metric | User baseline | Queried production baseline |
| --- | --- | --- |
| Total HTTP requests | 17,230 | 17,721 |
| Worker executions | 12,160 | 12,099 for production script `zenkaitv` |
| Worker errors | 0 | 0 |
| Edge cache hit percentage | 20.18% | 20.12%: 3,565 `hit` responses / 17,721 |
| Worker CPU P50 / P90 / P99 | P90 25ms | 1.870 / 25.078 / 79.005ms |
| HTTP 5xx | Not supplied | 339 / 17,721 = 1.91% |
| HTTP 429 | Not supplied | 41 / 17,721 = 0.23% |
| Build minutes | 0 | Supplied value; not independently queried |

Worker window: October 10 21:42:22.192 through October 11 21:42:22.192 UTC. HTTP window: October 10 21:43:48.962 through October 11 21:43:48.962 UTC.
CPU units were verified using the GraphQL schema descriptions: microseconds, converted to milliseconds. Percentiles are not a billable CPU sum or average.
HTTP failures: 156 x 504, 139 x 503, 44 x 502. Worker exceptions and HTTP errors are different metrics. Cache API's internal HIT header is not interchangeable with zone-level `cacheStatus`.

Successful endpoint samples from the same HTTP window:

| Endpoint | Requests | Edge response bytes | Interpretation |
| --- | --- | --- | --- |
| `/api/source` | 3,475 | 5,170,558,000 | Dominant observed bandwidth; not a proven CPU bottleneck |
| `/api/tmdb/search` | 2,995 | 6,047,584 | Reusable public metadata; additional 1,162 responses were 403 |
| `/api/image` | 1,167 | 137,610,118 | Artwork bandwidth; additional 134 image responses were 504/miss |
| `/api/anilist/media` | 585 | 2,253,859 | Existing client/server caching; unchanged |
| `/api/tmdb/season` | 458 | 2,520,884 | Reusable small metadata |
| `/api/tmdb/tv` | 267 | 682,457 | Reusable small metadata |

No per-endpoint Worker CPU allocation was available. Zone API TTFB P50/P95 fields were denied by the account's analytics entitlement, so they are not invented.

Bounded native probes: three sequential requests per endpoint, 250ms gaps, 30-second deadline, no retries. All 15 probes returned 200; no 429/5xx in this small sample. TTFB and total-body times in milliseconds:

| Endpoint | Cache observations | TTFB samples | Total samples | Decoded bytes |
| --- | --- | --- | --- | --- |
| Versioned client JS | HIT/HIT/HIT | 243, 78, 80 | 298, 95, 93 | 606,381 |
| Catalog | MISS/HIT/HIT | 546, 46, 49 | 1,679, 1,294, 1,306 | 16,248,998 |
| Airing | BYPASS x3 | 67, 56, 62 | 68, 59, 65 | 18,978 |
| TMDB season, neutral regular ID | BYPASS x3 | 93, 62, 75 | 94, 62, 75 | 4,370-4,401 |
| Latest feed | BYPASS x3 | 69, 62, 57 | 75, 65, 62 | 30,042 |

These are network samples, not a controlled hosted A/B or a reliable population P95. Decoded bytes are not transfer/billing bytes. The catalog had 4,475 rows during the live probe; the independently validated branch snapshot has 4,473.

## 4. Local Optimizations and Verification

| Change | Why safe | Verification |
| --- | --- | --- |
| Preserve browser policy, validators and Age; explicit expiry; versioned internal cache key | No contract/payload change; legacy cache entries are not reused; no expired edge success; no production zone setting edited | Simulated four-hour header override, expired/missing envelope, origin Age, ETag/Last-Modified and real workerd MISS/HIT |
| TMDB search/TV/season 300s, airing 120s, latest 60s caps | Only previously public anonymous GETs; never exceeds upstream shared TTL; release timestamps/time zones are unchanged | Per-route TTL, exact payload equality, empty/unconfigured/unavailable/stale rejection |
| Validate new small public metadata off the response path | Maximum 256KiB decoded inspection; media/catalog remain streamed; malformed/oversized/negative payloads are not reused | Neutral oversized, incorrect shape, empty, failed, stale and unconfigured fixtures; runtime JSON/gzip tests |
| Canonical parameter order; preserve all query values and encoding variant | Equivalent order can reuse one result, while ID/year/season/language/adult flag and repeated-value ordering stay isolated | Query-order reuse; different flags/values and gzip/identity isolation |
| Honor request no-cache/no-store/max-age=0/Pragma | Explicit reload/cache bypass requests stay fresh; conditional requests continue to backend | Bypass tests alongside auth, cookies, ranges, HEAD/POST and refresh flags |

Cache failure still falls through to the backend; upstream errors keep their status and Retry-After, with one request and no automatic retry. Metadata processing is tied to `ctx.waitUntil`, and tests include the real workerd Cache API, not only mutable Node Response mocks.

## 5. Endpoint Policies

Edge TTL below means the explicit Worker Cache API cap, not a promise about global CDN cache hit percentage. Every cached response requires status 200, explicit public headers, approved type, no Set-Cookie, and no Vary dimension except Accept-Encoding. Images/catalog/skip-time responses require bounded declared length; the five small metadata routes instead allow chunked bodies only after bounded decoded validation. Authorization/cookie/range/conditional/bypass requests never share this cache.

| Content | Browser / existing origin policy | Worker edge policy after local changes |
| --- | --- | --- |
| Versioned JS/CSS/fonts/images | 1 year immutable | Static asset binding, no Worker execution |
| HTML, service worker, bootstrap JSON | Revalidate; no new long-lived policy | Static asset delivery unchanged |
| `/api/catalog` | 300s; existing shared/stale directives preserved | 300s cap, explicit expiry; no gateway stale-while-revalidate implementation |
| `/api/image` | Existing immutable artwork policy | 86,400s cap; failures/204 never cached |
| `/api/skip-times` | Existing public response policy | 300s cap |
| `/api/tmdb/search` | Existing 300s | 300s cap; only nonempty healthy results |
| `/api/tmdb/tv` | Existing 1,800s | 300s cap; only healthy show objects |
| `/api/tmdb/season` | Existing 900s | 300s cap; only healthy episode metadata |
| `/api/anilist/airing` | Existing 120s | 120s cap; only healthy nonempty data |
| `/api/animeav1/latest` | Existing 60s | 60s cap; only healthy nonempty data |
| Other AniList/Jikan/provider metadata/search | Existing origin/browser/client policies and cooldowns | BYPASS; no generic broad cache |
| Source resolution, streams, signed URL maps, media Range | Existing verified route-specific policies only | BYPASS; no new Cache API media reuse or URL rewrite |
| Auth/config/user preferences/translation/admin POSTs | Existing private/no-store or method-specific contracts | BYPASS; no user-specific shared caching |
| Failed, partial, unconfigured or stale new metadata | Existing status, browser policy and backoff retained | Not stored by the new metadata cache |

`cache.match` hits restore the origin policy, not the internal edge-storage policy. Hard expiry protects the gateway even if zone settings retain a stored object longer. The live Browser TTL remains four hours; "Respect Existing Headers" is a recommended separately approved setting, not a change made here. Old browser entries cannot be remotely purged by clearing edge cache. [Browser TTL](https://developers.cloudflare.com/cache/how-to/edge-browser-cache-ttl/), [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/).

## 6. Before / After: Controlled Local Simulation

`node scripts/benchmark-cloudflare-cache.mjs` compares the audited base and local gateway with identical neutral data, 20 rounds of four requests, maximum concurrency four, and 25ms fixture backend delay. No production/upstream load testing.

| Metric | Base | Local changes |
| --- | --- | --- |
| Gateway executions | 80 | 80 |
| Backend calls | 80 | 4 |
| Cache hits | 0 | 76 (95%) |
| Latency P50 | 29.99ms | 0.57ms |
| Latency P95 | 44.85ms | 1.16ms |

The measured backend-call reduction is 95% for this deliberately reusable local workload, not a prediction for the live catalog. Cold same-key concurrency is not globally coalesced at the edge; existing backend coalescing remains. Different colos/queries, eviction, cookies and TTL expiry reduce real-world reuse. No post-deployment Worker CPU, invocation reduction, bandwidth savings or global cache-hit improvement is claimed.

## 7. Browser and Bundle Measurements

- Clean isolated-context desktop, 1366x768: TTFB 75ms, FCP 324ms, LCP 4,636ms, CLS 0.011. Full catalog 4,432ms; first images 2,542/3,647ms. Noncritical Jikan full request took 8,095ms while the page remained usable.
- Warm phone, 390x844, 4x CPU slowdown + Fast 4G: FCP 196ms, LCP 576ms, CLS 0.0068. This is a warm-cache lab result, not a cold low-end-phone guarantee.
- The desktop trace reported CLS 0.03 and 48ms forced layout in `syncRailOverflow`; no estimated savings were supplied by that insight. No speculative layout rewrite was made. No CrUX field data or valid INP measurement was available.
- Homepage/schedule/detail smoke at 320x568, 390x844, 430x932, 768x1024, 1024x768, 1366x768, 1920x1080 and 2560x1440 found no page horizontal overflow. Schedule displayed all seven nonempty day counts and current Sunday selected, with 12-hour clocks and America/Denver labels. Visible schedule/detail posters were present in the inspected samples, not a whole-catalog guarantee.
- Search for One Piece rendered the correct base show first and related releases after it. Regular carousel remained populated; adult mode/media were not opened. Existing automated tests cover adult-metadata eligibility/isolation using neutral fixtures.
- Direct One Piece episode 904 in 844x390 phone landscape: one iframe, 1920x1080 decoded video, readyState 4, advancing playback, no video error. Next opened 905; it also decoded/advanced (968 frames, 40.13s at one observation), with one iframe. Forward/rewind controls responded; browser Back returned to details with zero player iframes. A screenshot was returned inline by the browser tool; its file export was unavailable.
- Startup was not instrumented at first decoded frame: episode 904 was ready at the 18.8-second observation, already at 14.8s playback. This is an upper-bound observation, not a precise startup benchmark or proof of faster playback.
- Production build: 57 verified files in each output. First-load 15 scripts/styles total 992.6KiB raw, estimated 254.5KiB gzip / 203.8KiB Brotli. Client alone 592.2KiB minified / 156.1KiB gzip. Player JS 54.4KiB minified / 18.0KiB gzip, loaded in its iframe. These estimates exclude JSON/media and are not measured wire compression ratios.
- Existing console issues: injected Cloudflare Insights beacon is blocked by CSP; an invalid preload warning; provider 503/404 responses; an iframe allow/allowfullscreen precedence warning. Security policy was not weakened to allow analytics. The successful playback sample still needed a TioAnime 404 fallback. Hardware Chromecast, real Smart TVs, iOS Safari and native fullscreen/orientation-lock behavior were not tested.

Browser observations are of the unchanged live UI, not deployed local cache changes. New gateway behavior was separately verified in Node and local workerd. No claim of a frontend Core Web Vitals improvement is made.

## 8. Costs and Usage

At 12,099 Worker executions/day, a constant 30-day month would be about 363,000 executions, already below Workers Paid's included 10 million requests. The $5 base fee does not disappear with better caching; incremental request-fee savings may be $0. CPU percentiles cannot establish a CPU overage. Other account workloads, taxes and paid products are not included in this scenario. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

The intended saving is fewer container fetches/wakeups and provider calls, conditional on real query/colo reuse. No reliable dollar amount can be inferred without container uptime/active CPU and billing data. One basic container provisions 1GiB RAM and 4GB disk; memory/disk bill while running, active CPU separately. Media traffic and staging usage remain. [Container pricing](https://developers.cloudflare.com/containers/platform/pricing/).

The 5.17GB/day source sample would be about 155GB over 30 days if repeated; this is an edge-byte observation, not measured billable container egress. No guaranteed total monthly bill or savings percentage is promised. Deployment/billing/security/capacity settings are unchanged.

## 9. Validation and Remaining Work

Passed at audit completion: `npm ci --ignore-scripts` (zero reported vulnerabilities), `npm run check`, full `npm test`, `npm run test:cloudflare` (22 tests), container unit/contract suite (23), production policy suite (7), pinned local workerd cache runtime, bounded benchmark, ESLint 8.57.1 across existing scripts and edited Worker/fixture files, `npm run build`, `npm run build:verify`, built-output performance inventory, `node --check` and `git diff --check`. The hosted chunked-response correction adds a 23rd gateway regression and declared/undeclared runtime variants; repeat those gates before republishing.
No TypeScript configuration exists; syntax/global/version/security checks are the applicable type/safety gate. Full app tests include catalog preservation, season/stills, date/time conversion, source ranking/races, Cast/codec contracts, cache efficiency, publication/outage handling and Android mirror checks. Catalog playability checks validate stored routes, not every live episode on every device.

Before any approved deployment: review the diff, rebase code over current main without overwriting newer automated catalog data, rerun gates, and use the existing GitHub Linux runner for the real Docker/container integration. The new Cache API workerd test requires no Docker; the complete new Linux container image was not built on this Windows machine.
After separate deployment approval: verify HIT/MISS headers, age/expiry and compression on both hostnames; consider approving Browser TTL "Respect Existing Headers"; compare a comparable 24-hour category/status window and container billing/uptime. No production telemetry was enabled here.
Further profiling priorities: cold artwork/image 504s, full catalog payload/parse cost, provider/WAF 403s, per-source first-frame timing and cold container latency. Do not remove fallbacks or publish stale/partial catalogs to improve a score. Cloudflare Insights injection should be reconciled with the existing CSP through a separately approved setting/policy decision.

## 10. Files and Rollback

- `ops/cloudflare/gateway.mjs`: the only application runtime change; cache admission, envelope/freshness, query key and request bypass behavior.
- `scripts/test-cloudflare-staging.mjs`: new freshness, route, failure, shape, age and isolation regression cases.
- `scripts/benchmark-cloudflare-cache.mjs`: reproducible bounded before/after neutral workload.
- `scripts/fixtures/cloudflare-cache-worker.mjs` and `scripts/test-cloudflare-cache-runtime.mjs`: real local Cache API/encoding regression harness, using the repository's pinned tooling without adding dependencies.
- This report and `HANDOFF.md`: audit/review status. No app assets, player, provider adapters, catalog schema, dependency manifests/lockfiles, Android copies, DNS, secrets or CI publishing configuration were intentionally changed. Build/bootstrap generation is output, not an optimization to publish.

At audit completion nothing was deployed. The subsequent user-approved publication uses the existing production CI gates; record the actual run and hosted checks before claiming completion. To discard local work, remove only this audit's changes or archive the dedicated worktree after preserving the report; do not reset the primary dirty checkout. To disable metadata reuse after deployment, remove only the five new metadata entries from `PUBLIC_CACHE_TTLS`, retain the browser-policy/expiry fix, rerun gates and publish through the existing approved process. Alternatively revert only the reviewed gateway optimization commit, not a whole old catalog/frontend snapshot. The internal key version isolates cache entries without a production-wide purge.

## API Inventory

AST inspection found 100 literal API path comparisons, plus the parameterized AniPub episode route. This is a code inventory, not 101 live upstream probes. Unknown API paths use the existing catch-all 404. Braces below expand to individual route suffixes:

```text
/api/{catalog,scraped-catalog,health,server-info,config,image,skip-times,source,resolve,description,translate,crawl,refresh-daily,check-update,apply-update}
/api/language/preferences
/api/anilist/{airing,media,search,trailers}
/api/jikan/{episodes,full,search}
/api/tmdb/{search,tv,season}
/api/animeav1/{catalog-search,health,latest,search,slugs,sources}
/api/animeneon/{health,sources}
/api/animeyt/{health,sources}
/api/tioanime/{catalog,health,search,slugs,sources}
/api/jkanime/{health,search,slugs,sources}
/api/animeonlineninja/{health,search,sources}
/api/allanime/{search,stream,watch}
/api/anime1v/{catalog,episode,episodes,health,info,providers,search,stream,trending}
/api/anipub/{catalog,catalog/all,catalog/total,debug-page,health,play,episodes/:id}
/api/apk-1anime/{catalog,episodes,info,stream,watch}
/api/consumet/kickassanime/{catalog,episodes,health,info,search,servers,stream,watch}
/api/jimov/tioanime/{catalog,episodes,health,info}
/api/rapid-anime/{catalog,episodes,health,info,recent,search,stream,watch}
/api/adult/debug
/api/adult/hanime/artwork
/api/adult/hentaiocean/{catalog,details,stream}
/api/adult/underhentai/{catalog,details,releases,stream}
```
