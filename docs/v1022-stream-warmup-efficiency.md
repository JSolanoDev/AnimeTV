# v1022 Stream Warmup Efficiency Candidate

October 12, 2026 (America/Denver). Reviewed candidate on
`codex/episode-startup-v1022`, based on GitHub main
`e746d05606dfa77193e09b6a12fd07cb3b8bef03`. Human approved pushing this branch
for CI-only validation, not main promotion or production publishing. No deployment,
cache purge, monitoring change, paid-service change, or Cloudflare configuration change.
The separate Android TV reliability candidate remains untouched.

## Confirmed Findings

1. `warmPlayableStream` previously cleared its timeout after fetch returned headers,
   without consuming or cancelling the response body. Every caller only warms the
   connection; none consumes that body. A server ignoring the one-byte Range can
   continue sending media beside the real player and its verification requests.
2. A cache-enabled production homepage reload had observed LCP 176ms, CLS 0.03,
   DOMContentLoaded 232ms and load 259ms. These are one warm lab sample, not field
   metrics or a reason to change the entire JS architecture.
3. On the bounded One Piece 904 production sample, the first AnimeAV1 source request
   took 4716ms and AnimeNeon took 6910ms. The first media check began around 5388ms;
   subsequent checks included 2393ms/1109ms fragment requests. Existing availability
   checks and provider/network latency remain part of startup; they were not removed.
4. The same page requested 25 TMDB season payloads while enriching a continuous
   long series. Catalog and image decoded-resource sizes were substantial, but
   top-window transferSize values were zero under service-worker interception.
   Those fields are not billing measurements or proof of duplicate transfers.
   Lazy season metadata/catalog payload work needs separate identity and correctness
   evidence; neither was changed in this release.

The playback observer attached after playback started, so this sample does not
establish precise click-to-first-frame time. No episode-startup percentage improvement
or universal provider/device reliability is claimed.

## Targeted Change

- Cancel the unused warmup response body immediately after headers, keeping cleanup
  under the existing timeout. Preserve URL-specific coalescing, credentials=omit,
  no-store policy and Range bytes=0-0.
- HLS and already-verified/preconnect-only intents still perform no warmup media GET.
- Do not change actual video requests, Range/seek behavior, HLS buffering, source
  preference/verification/fallbacks, signed-URL caching, Chromecast, Supabase, CSP,
  provider behavior or Cloudflare routes/container limits.
- Synchronize required v1022 asset/cache references and all 28 Android mirrors.
- Add four regression tests to the existing pipeline test command and an opt-in
  local neutral benchmark/browser fixture. Neither diagnostic contacts providers.
- Add this exact review branch to general CI and no-deploy Linux/Docker validation,
  and block its Vercel preview deployment. Existing publishing workflows unchanged.

## Validation

- The new tests failed on v1021's unclosed response, then passed with the patch.
- `npm run check`, full `npm test`, isolated ESLint 8.57.1: passed.
- `npm run build` and `npm run build:verify`: passed, 57 verified static files in
  each output. No catalog changes remain in the candidate diff.
- Cloudflare staging/container/production contracts: 54 passed.
- Pinned Wrangler/workerd Cache API fixture: passed for metadata MISS/HIT,
  JSON/gzip, validators, privacy, error handling and scanner blocking.
  Its initial invocation without Wrangler was a harness error; the prescribed
  pinned-toolchain invocation passed. No production action was executed.
- Five local neutral ignored-Range benchmark pairs: baseline origin wrote 655360
  bytes/20 chunks per run and remained open before cleanup; candidate wrote 32768
  bytes/one chunk and closed. Reduction: 95% in this fixture only. Origin write
  counts are not measured Cloudflare billable bytes or episode startup timings.
- Real Chrome fixture independently confirmed status 200, one 32768-byte chunk,
  closed connection and preserved Range bytes=0-0.
- Local desktop home: 12/12 sampled images loaded, valid preload, v1022 worker,
  no horizontal overflow. Mobile 390x844: 8/8 visible images, no overflow.
- Local mobile MP4 decoded 960x540 and advanced 0.148 to 2.287s; local desktop HLS
  decoded 512x288 and advanced 0.100 to 2.225s. Both readyState 4, no media error;
  the HLS warning/error console window was empty. Playback was paused and left.
- Through the active local service worker, MP4 Range returned 206/four bytes and
  a neutral HLS manifest returned 200 with the existing same-origin rewrite.
  Desktop screenshot was inspected inline; file export to the new worktree was
  denied, and no path workaround was attempted.
- Production baseline One Piece 904: one iframe, 1920x1080, readyState 4,
  28.843 to 30.903s advancing, no media error. This is baseline evidence, not
  a hosted v1022 rollout test.

Reproduce locally:

```text
node --test scripts/test-stream-warmups.mjs
node scripts/benchmark-stream-warmups.mjs
npm run check
npm test
npm exec --yes --package=eslint@8.57.1 -- eslint client.js animetv-local.js animetv-server.js "js/*.js" "player/*.js" "scripts/*.mjs" "api/**/*.js"
npm run build
npm run build:verify
node --test scripts/test-cloudflare-staging.mjs scripts/test-cloudflare-containers.mjs scripts/test-cloudflare-production.mjs
npm exec --yes --package=wrangler@4.149.0 -- node scripts/test-cloudflare-cache-runtime.mjs
```

## Release And Rollback

CI-only branch push approved; GitHub/Linux/Docker results remain outstanding.
Hosted v1022 publishing and validation require separate deployment authorization.
Record the exact SHA and CI readback in .cache/v1022-ci-validation.md. Verify the exact candidate
against the latest main before any promotion; preserve newer catalog commits.
Current v1021 stays live, along with its existing v1020 rollback reference.

The v1021 runtime release is Git `a24920d280b62d961adc97e9162a42f76f960c6c`;
this candidate's base `e746d05606dfa77193e09b6a12fd07cb3b8bef03` retains the
newer catalog snapshots with that same v1021 runtime. The original v1021 Worker
`4ccf264c-747f-48f4-a38b-4cdd7ff373fc` and container version 30/digest
`850052fba8078d0915770cf45f32dcd4b254e119e8bccb50ee306afd57f7303b`
remain documented in the separate production-validation evidence; catalog publishing
has since advanced Worker/container versions. Select a verified matching snapshot,
not an assumed still-active UUID, before any separately authorized rollback.
The prior v1020 Git reference is `6ccf149ca559f1e68f44d137edffc63a7681deed`,
Worker `67501211-4f8c-4fa0-bc46-70d754927707`, container version 29/digest
`08b4e8af9a2b29128c95a95f2d807f47235289d617cff4596a2bf9d23ba3ef78`.

For a rejected candidate, retain the v1021 runtime and its prior asset/cache
generation; do not deploy the modified worktree. A separately authorized hosted
rollback must use the saved release references and account for container versions,
because a Worker rollback does not revert the attached container. Do not clear
user data, purge caches or alter security to work around provider failures.

## Next Evidence-Based Work

Prioritize an exact click-to-first-frame cold/warm baseline and lazy long-series
metadata experiments. Preserve episode identities and two-fragment verification.
Measure origin transfers separately from paired XHR/service-worker entries. Existing
provider 503/404 and Cloudflare analytics CSP noise are not fixed by this candidate.
No whole-catalog, physical TV/mobile, or hardware Chromecast certification.
