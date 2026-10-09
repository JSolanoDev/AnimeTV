# Cloudflare staging migration

## What is ready

The existing vanilla-JavaScript app is copied byte-for-byte from its verified,
minified static build into `.cache/cloudflare-static`. The separate staging
configuration deploys only `zenkaitv-staging` on `workers.dev`. It has no custom
domain, production routes, cron jobs, paid storage, or database migration.
The live Vercel build, player files, Supabase, and Linux daily catalog updater
remain unchanged. The second phase below adds an opt-in hosted-runtime flag
to the Node backend and its Android mirror; existing defaults are preserved.

Static assets bypass the Worker. API requests use the existing backend at
`https://zenkaitv.com`; this is valid only while production stays on Vercel.
The Worker reuses the security headers in `vercel.json`, blocks scanner paths,
does not retry upstream failures, and caches only explicitly public successful
GET responses from image/catalog/skip-time routes. Cookies, authorization,
refreshes, range/conditional requests, and playback source lookups are not
shared-cached. All staging responses are marked `noindex`.
Cached compressed bodies retain their encoding without a second compression
pass; encoding variants have separate keys. Player HTML URLs keep their exact
paths instead of receiving Cloudflare's default HTML canonicalization redirect.

Video bytes are not relayed through the free staging Worker: `/api/source`
returns a no-store 307 to the existing media backend, preserving the URL,
method, and browser Range behavior. This adds a redirect during staging; it is
not the final production playback architecture. Verify cross-origin HLS,
HEAD, seeking, and Cast on the hosted staging URL before any cutover. A paid
approved media path or a separate HTTPS media backend must be designed first.

## First local checks

```powershell
npm run test:cloudflare
npm run cloudflare:prepare
node scripts/verify-cloudflare-staging.mjs
npm run cloudflare:dry-run
npm run cloudflare:dev
```

Local staging uses `http://127.0.0.1:4192`. The Cloudflare CLI is pinned to
Wrangler 4.149.0 and installed in npm's tool cache, without adding dependencies
to the app or changing its lockfile. The CLI wrapper disables automatic dotenv
secret loading and telemetry, so existing backend secrets are not copied into
the staging runtime. Local tests use neutral provider fixtures.
Stop the staging dev server before preparing assets again; Windows can lock the
watched output directory while Wrangler is running.
The free runtime has daily request and CPU limits; it is for validation, not
an assumption of unlimited production API traffic.

## Account and first hosted staging deployment

1. Use the existing Cloudflare account and enable MFA. A ChatGPT connection
   does not authenticate Wrangler. Do not change domain nameservers or buy a plan yet.
2. Run `npm run cloudflare:login` and complete Cloudflare's browser authorization.
   This asks only for account/user read access and Worker-script management;
   Cloudflare also adds its normal offline-access scope to refresh the login.
   No DNS-route, database, storage, email, AI, or container permissions are requested.
   Do not paste OAuth credentials, API tokens, or passwords into chat or Git.
   Wrangler may warn about omitted default scopes; those unused product scopes
   are intentionally not granted for this staging deployment.
3. Run all local checks above, then `npm run cloudflare:deploy:staging`.
   Select the intended account if prompted. This command verifies prepared
   artifacts before deployment; it cannot configure production routes.
4. Save the resulting `https://zenkaitv-staging.<account>.workers.dev` URL.
   If login needs an OAuth callback, add only that exact staging URL to the
   Supabase redirect allowlist. Keep the production site URL unchanged.

Do not expose service-role keys or an unrestricted Vercel protection-bypass
credential to the browser. Deployment protection is not something to work
around; use an explicitly authorized backend origin.

## Cutover gate

- Compare homepage, search, schedule, details, artwork, season/episode lists,
  direct watch URLs, episode switching, next, seeking, fullscreen, and phone/
  tablet/desktop layouts with production.
- Test HLS/MP4 redirects, byte ranges, HEAD, actual Chromecast hardware, codecs,
  login/logout, failed sources, and slow networks. Fixture tests alone do not
  establish that every external stream works.
- Check provider access using normal authorized requests; Cloudflare/VPS IPs
  may receive 403 even when the Linux updater works. Do not circumvent blocks.
- Measure API p50/p95 latency, Worker CPU/request counts, origin 429/5xx,
  backend memory, and relayed media GB. Caching does not make Worker requests
  free. Compare these with the existing Vercel bill before selecting a VPS.
- Establish a stable backend origin independent of `zenkaitv.com` before moving
  that domain, otherwise API requests loop back into Cloudflare. The current
  gateway rejects same-host backends and production-host requests.
- Prepare a separate reviewed production configuration, rate limits, request
  budgets, monitoring, backups, trusted-proxy handling, media routing, and a
  documented Vercel rollback. Do not reuse this staging config on production.
- Change DNS only after the gate passes and production cutover is approved.
  Preserve DNS email records and review existing DNSSEC before nameserver changes.

## Local validation on 2026-10-08

- Existing full test suite, `npm run check`, ESLint 8, minification/build hashes,
  and Wrangler deployment dry-run passed. The 16 gateway tests passed.
- 57 original app assets were preserved; 60 staging files were hash-verified.
- Real local Worker requests confirmed deep routes, direct player HTML (200,
  not a redirect), service-worker revalidation, scanner rejection, JSON health,
  and media GET/HEAD redirects with OPTIONS support.
- Real catalog responses parsed as JSON on both cache misses and hits for gzip
  and identity clients. This caught and fixed a double-compression bug that
  plain Node fixture tests alone would not expose.
- Neutral browser fixtures exercised homepage, search, schedule, detail/episode
  lists, and direct-watch failed-source handling. No JavaScript errors or page
  horizontal overflow were observed at 1920x1080, 1366x768, 768x1024, 390x844,
  and 844x390. Desktop/mobile detail screenshots were inspected.
- These are local smoke checks, not proof of hosted OAuth, genuine artwork,
  all external streams, Chromecast hardware, or production Worker usage.

## Hosted staging on 2026-10-08

- Cloudflare browser authorization succeeded with the limited scopes above.
  Staging is live at <https://zenkaitv-staging.juankisantiago.workers.dev>.
  Deployed version: `9d3e69cb-81cc-4fdd-bf80-843b5ab6c9b9`.
- The 16 gateway tests and deployment dry-run passed before publication.
  Hosted deep routes, direct player HTML, service-worker cache headers, scanner
  rejection, JSON health, media GET/HEAD redirects, and OPTIONS passed.
- Hosted catalog cache misses/hits returned valid JSON for gzip and identity
  clients, with no double compression. Neutral hosted browser fixtures passed
  homepage, search, schedule, and two-episode details at 1440x900, 768x1024,
  390x844, and 844x390 with no JavaScript errors or horizontal overflow.
- A public neutral HLS playlist returned a valid manifest through the media
  redirect. A neutral MDN MP4 returned HTTP 206 and the requested 1 KiB byte
  range with CORS. An unavailable Google sample returned 403 directly as well
  as through the existing backend; no security protections were relaxed.
- These checks do not prove actual HLS decoding, all provider streams, artwork,
  app OAuth login, Chromecast hardware, or production capacity. Complete the
  cutover gate before moving the domain. Production, DNS, backend deployment,
  database, paid plans, and daily jobs were not changed. Changes remain local.

## Cloudflare-only backend preparation

`wrangler.container-staging.json` is separate from the live free staging
configuration. Its Worker serves the same verified static assets and routes
API requests through a Durable Object to the existing Node backend in a
Linux/AMD64 container. Media bodies stream on the same origin, with Range,
HEAD and HLS rewriting preserved; playback responses are never shared-cached.
There is no Vercel fallback in this configuration. Do not replace the live
staging configuration or point the domain at this unverified backend.

Cold requests share a bounded startup/readiness check. Warm requests do not
probe again, upstream requests are never replayed, and stream cancellation
aborts the original request. One staging container is allowed; it sleeps
after five idle minutes. This limit is not a production-capacity guarantee.
The entry point avoids boot-time provider warming and catalog timers, and
uses temporary runtime caches, matching the existing hosted backend.

The build context contains only 25 allowlisted backend inputs plus generated
build metadata. No dotenv files, private keys, local runtime state, deployment
tokens or host credentials are copied. Existing locked dependencies are used
without a lockfile update. The image runs as the non-root Node user. A
container-only outbound socket policy blocks private/reserved IPs and pins
connections to validated DNS results, including redirect destinations.
Supabase browser configuration accepts only anon/publishable keys.

```powershell
npm run test:cloudflare
npm run test:cloudflare:containers
npm run cloudflare:containers:prepare
npm run cloudflare:containers:bundle
# A Linux Docker environment is required for the following checks:
npm run cloudflare:containers:build
npm run cloudflare:containers:smoke -- --network
npm run cloudflare:containers:dry-run
npm run cloudflare:containers:integration
```

The bundle command validates only the Worker, not the image. All container
CLI commands are local or dry-run operations; hosted deployment is deliberately
unavailable until paid-service approval. The GitHub workflow performs Linux
regression checks, a Docker build, API/native-Sharp/SSRF tests, neutral HLS/MP4
checks and the full Wrangler dry-run. It has read-only repository permissions,
no Cloudflare secrets, and no publishing step. It runs on manual dispatch or
isolated `cloudflare-validation/**` pushes, never a `main` push. The initial
validation snapshot disables Vercel Git deployments in that branch only;
do not merge that branch-only `vercel.json` setting into production.

Local gateway/container tests (16 each), app checks, ESLint, asset preparation
and the Worker bundle passed on 2026-10-08. Windows has no Docker. The user
chose a GitHub Linux runner instead of requiring the laptop to host the app.

The final Linux verification passed at
<https://github.com/JSolanoDev/AnimeTV/actions/runs/37887183140>, testing commit
`d4b4801e843e94818c56855cd4ac3a1d6eb86ae1` on
`cloudflare-validation/container-staging-2026-10-08`. Existing app checks and
regressions, clean locked installs, the Docker build, native Sharp, non-root/
read-only smoke checks, neutral HLS/MP4 ranges and the full Wrangler dry-run
passed without a deployment or Cloudflare credentials. Existing remote main
stayed at `abd57fc7658d4c81214a879f44780693e1f1833f`; the local checkout/index
were preserved. The lockfile was not changed.

The real local Worker -> Durable Object -> Docker test caught a decoded-body/
compressed-header mismatch that Node fixtures could not reveal. The container
gateway now automatically re-encodes decoded Fetcher streams; cached encoded
responses keep their existing manual passthrough. This fixed catalog JSON on
both cache misses and hits without changing the live free-staging path. The
final test exercised static/deep/player URLs, concurrent cold requests, public
config, scanner/private-network blocks, gzip/identity clients, cache reuse,
same-origin neutral media and cleanup. Miniflare's leftover egress helper is
explicitly stopped only after its test-owned name/image are verified.

Runner-only measurements were 616 ms for three concurrent cold health requests,
5 ms for a warm health request and 99 MiB baseline RSS. These are not hosted
Cloudflare latency, peak memory, capacity or playback-start measurements.

## Paid staging and production gate

Linux verification is preparation, not a Cloudflare-hosted deployment. The
next step requires explicit approval to enable Workers Paid and to publish
only `zenkaitv-container-staging`. Containers require Workers Paid; the base
subscription is $5/month, with container CPU, allocated memory/disk, egress,
Durable Object and excess Worker usage billed separately. The earlier
Workers-only estimate is not a full-migration quote. Measure usage and add
spend alerts before deciding whether the total meets a $10/month target.

After approval, authorize only the needed Containers, Durable Objects,
Worker-script and secret-management access. Transfer necessary backend
secrets securely, not through chat or Git; public Supabase keys remain public.
Test actual provider access, login, real HLS decoding and seeking, episode
switches, Cast hardware, mobile orientation, slow networks, container restarts
and concurrency on the new hosted staging URL. Local/runner tests cannot
establish provider access from Cloudflare's IPs or rule out signed-source IP
expiry after the container sleeps. Do not work around provider access blocks.

Catalog snapshots are baked into the image and its filesystem is ephemeral.
Before retiring Vercel, wire validated daily catalog changes to a separately
approved Cloudflare build/deployment job; preserve existing refresh jobs until
that path is verified. Review production rate limits, monitoring, capacity,
media-delivery terms/costs, OAuth redirects and rollback. Keep Vercel and DNS
unchanged until hosted checks pass and production cutover is approved.

## Paid staging authorization on 2026-10-09

The user completed payment; the dashboard confirms Workers Paid is the current
plan. The user approved an account-scoped deployment credential with only
Workers Scripts, Containers and Cloudchamber edit access, to be stored as
encrypted `CLOUDFLARE_STAGING_API_TOKEN` in the AnimeTV GitHub repository. Do not use the
dashboard's broad automatic Workers Builds token or grant DNS permissions.
The token expires October 16. An initial unused token value appeared in a tool
result; the user approved replacement and Cloudflare confirmed successful Roll,
invalidating that value. The replacement was saved directly in GitHub's encrypted
secret without displaying it or writing it to local files.

The new `cloudflare-container-staging.yml` workflow runs only on
`cloudflare-staging/container-staging-2026-10-09`, with read-only checkout and
the existing regression, Linux Docker, neutral-media and real local integration
gates before deployment. Only the deploy step receives the credential. The CLI
requires the exact repository/branch, explicit CI approval and the isolated
single basic container configuration, and rejects production/DNS/cron changes.
The previous validation workflow remains credential-free and deployment-free.
Local app checks/full tests, 16 gateway and 18 container tests, ESLint and the
57-file hash-verified minified build passed. The first Linux deploy run passed
all validation gates and published version `5976c8fc-1088-466a-829a-bfed000645bb`.
Its immediate health check received HTTP 404 while the new URL was propagating;
the deployment itself succeeded. The readiness gate now waits at most two minutes
and eight attempts, only against staging health, without retrying provider or
episode requests. Authentication errors and invalid health payloads still fail.

Hosted staging: <https://zenkaitv-container-staging.juankisantiago.workers.dev>.
Health, SPA/deep-watch/player HTML, gzip/identity catalog cache miss/hit pairs,
scanner/SSRF/method guards, same-origin neutral MP4 Range/HEAD/OPTIONS and rewritten
HLS manifests passed. A neutral HLS sample decoded at 1920x1080 with readyState 4
and advancing playback time, without console or media errors. This does not prove
all real-provider streams, episode navigation, mobile orientation, OAuth or Cast.
At initial deployment the public config reported authentication unconfigured.
The subsequent approved settings transfer is recorded below. Production, DNS and
updater jobs are unchanged.

The follow-up deployment run passed completely:
<https://github.com/JSolanoDev/AnimeTV/actions/runs/37920246605>.
Staging branch commit: `9474045f5a2e7aed55a4911a545abc44c4d90cb2`.
Code deployment version before runtime secret updates:
`be7ad3fb-3023-4b1f-8da8-0c48b320a9fd`.
Rewind/forward recovered to readyState 4 without a media error. Phone-landscape
emulation had no horizontal overflow; fullscreen UI toggled but native fullscreen
was not available in this browser. No hardware Cast or physical orientation test.
Approval was requested and received before transferring existing runtime settings.
The staging deployment token expires October 16 and must be renewed securely before
later automated deploys; do not expand its permissions or silently extend access.

## Runtime settings validation on 2026-10-09

The user approved transferring the existing settings to isolated staging. Exactly
four settings were uploaded using Wrangler secret bulk JSON through stdin:
`TMDB_API_KEY`, `TMDB_READ_ACCESS_TOKEN`, `SUPABASE_URL` and public
`SUPABASE_ANON_KEY`. No secret values were printed, stored in new local files,
committed, embedded in the image or copied into GitHub. No service-role key or
deployment credential was transferred. The public Supabase key passed the
container's public-key guard, and hosted `/api/config` matches production.

Hosted TMDB search returned HTTP 200, configured true and ten neutral results.
An opaque neutral image passed Sharp decoding at 480x720, was optimized to a
51,910-byte WebP and returned HTTP 200 on both requests. One separate TMDB request
returned a transient 503 before subsequent health/config/search checks passed;
the cause is not established and cold-start behavior still needs follow-up.

A low-volume real-provider check for the user-selected One Piece episode 904
returned one AnimeAV1 source and a valid HLS manifest through the same-origin
relay (HTTP 200). AnimeYT and TioAnime returned 404 for this sample. This is not
proof of every episode or decoded playback. The app's watch UI remained on
"Loading stream..." with no video or iframe after episode selection and explicit
Play. Preserve the screenshot in `.cache/cloudflare-runtime-watch-check.jpg`;
investigate this before domain cutover rather than treating a manifest as playback.

Both Google and Cloudflare public DNS returned NXDOMAIN for the Supabase hostname.
The user subsequently clarified that Supabase is unused and login is hidden.
`ENABLE_SUPABASE_AUTH` was already false: this external DNS check was unnecessary
and is not established as the cause of the playback stall. Authentication is not
a migration gate while deliberately disabled.

The unused `SUPABASE_URL` and `SUPABASE_ANON_KEY` settings were deleted only from
isolated staging via Wrangler secret bulk stdin, retaining both TMDB settings.
Hosted `/api/config` now reports configured false with no auth URL/key; the app
loads no Supabase SDK and keeps login hidden. Production configuration, hosting,
DNS and daily publishing remain untouched.

Fresh hosted checks subsequently decoded One Piece 904 and, through Next episode,
905 at 1920x1080, readyState 4 and advancing time, with no media error. Rewind and
forward moved the playhead about ten seconds. This recovery predates deployment
of the new startup guard and does not prove why the earlier attempt stalled.
Unexpected playback startup rejections previously reached callers that discarded
them; the narrow v1006 guard renders the existing Retry/other-source error UI
instead and cannot overwrite a newer episode. It adds no requests, retries or
provider changes. Root/Android copies match; pipeline tests now total 142, including
coalesced startup rejection and late stale rejection coverage. Full app checks,
tests, 34 gateway/container tests and targeted ESLint pass. Linux deployment and
hosted latest-fix/cold-start verification are still required before domain cutover.

## Current reference documentation

- Static assets: <https://developers.cloudflare.com/workers/static-assets/>
- SPA routing: <https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/>
- Pricing: <https://developers.cloudflare.com/workers/platform/pricing/>
- Node compatibility: <https://developers.cloudflare.com/workers/runtime-apis/nodejs/>
- Encoded responses: <https://developers.cloudflare.com/workers/runtime-apis/response/>
- CDN media terms: <https://www.cloudflare.com/service-specific-terms-application-services/>
- Containers API: <https://developers.cloudflare.com/containers/api/durable-object-container/>
- Containers configuration: <https://developers.cloudflare.com/containers/configuration/wrangler/>
- Containers pricing: <https://developers.cloudflare.com/containers/platform/pricing/>
- Local container development: <https://developers.cloudflare.com/containers/guides/local-dev/>
