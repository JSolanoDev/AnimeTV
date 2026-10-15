# v1024 Artwork and Runtime Recovery

## Release State

CI-only candidate, based on reviewed v1023 commit
`0c2a05a11d07d79d353fe76a9abb6104fedace4a`. Human approved committing and pushing
v1024 for CI validation, with exact-branch CI triggers and hosted-deploy guards.
Current main `6fddc953f37e862beffb1df42601f47a69061829` contains only catalog updates
since the old base; retain those updates in this review branch without changing the
reviewed runtime blobs. No main promotion, deployment or production configuration
change is authorized. Exact candidate and run evidence is recorded separately.

A fresh public HTTPS check returned Cloudflare HTTP 200 and v1022 frontend assets.
The separate native TV worktree is not included. Its emulator evidence is not a
certification of this web patch or of physical Google TV devices.

## Confirmed Causes and Fixes

- Detail backdrop validation treated a genuine TMDB landscape image as a shallow
  banner when the same URL appeared in both fields. Landscape role now takes
  precedence for explicit show/season TMDB backdrops; real banners retain their
  existing aspect validation. Late callbacks cannot paint another season/title.
- Nia Liston's pinned 1320x743 image was rejected, then a 1600x336 banner was
  stretched. Exact AniList/MAL/TMDB identity now selects the same series' verified
  1919x1080 TMDB original. No upscale, fuzzy title match, catalog crawl or API added.
- A late CSS override made pending thumbnails opaque and another rule removed
  the poster opacity transition. Restore the ready-class fade and reset readiness
  on fallback. The thin loading track uses a transform-only sweep, stops when
  settled, and respects reduced motion.
- Detail preview hid its placeholder before decoding; that placeholder was also
  inside the transparent sharp layer. Keep it in an independent layer until a
  decoded image is committed. Blur/sharp/probe still share one canonical URL.
- Runtime media-error recovery awaited shared discovery/verification without an
  overall deadline or rejection handling. Bound that existing chain to 15 seconds,
  keep the verified-source requirement, then expose existing Retry/source controls.
  Save resume before removing the failed player and dispose owned warmup/controller
  resources. Ignore its later progress/ended/duplicate error events so teardown
  cannot overwrite progress or restart recovery. Late lookup completion cannot
  automatically replay an obsolete episode.

## Validation

- Eleven new focused tests reproduce the original artwork defects and cover
  real banner fallback, warm decode reuse, stale season callbacks, reduced motion,
  hung/rejected/late recovery, navigation, saved progress and duplicate errors.
  An existing schedule-image fixture needed its missing DOM `classList.remove`
  method; the initial suite failure was a fixture incompatibility, not a shipped
  schedule regression. Full regression, check/security, release-calendar tests,
  isolated ESLint 8.57.1, production minification and static hash verification pass.
- All 28 main Android asset mirrors are byte-identical; all asset refs and the
  service-worker generation are v1024. Worker cache policy itself is unchanged.
  Cloudflare contracts pass: 23 staging, 24 container, 7 production. New GitHub
  Linux/Docker validation has NOT run for v1024; v1023's passed CI is not a substitute.
- Cache-enabled desktop and mobile browser checks cover correct HD dimensions,
  visible loading feedback, settled thumbnail fades, portrait/landscape/tablet
  overflow, one player, 1080p decoding, forward/backward seeks and fullscreen.
  Fault injection on the local page produces usable failure controls and retains
  the resume point. Browser injection is not evidence of a real provider outage.
- Production v1022 Nia Liston episode 2 played continuously for 390 seconds wall
  time; 26 samples advanced from 10.87 to 384.49 seconds and 266 to 9233 decoded
  frames, with readyState 4, no observed spinner/error. Playback was stopped.
  This did not reproduce the reported intermittent five-minute failure.
- Local warm-load ResourceTiming reported zero transfer for 18 versioned JS/CSS
  entries in one sample; not a production speedup or Cloudflare billing claim.
- One local image-proxy request failed with fetch-failed/502; the same-show
  fallback worked and one bounded confirmation returned WebP/200 in 1166 ms.
  Do not weaken failure guards or claim third-party artwork is always available.
- Screenshots were inspected inline. Export into this worktree was denied by the
  browser connector's workspace policy; no alternative-path workaround was used.

No backend, provider integration/ranking, HLS buffer configuration, player library,
Chromecast, Supabase, CSP, analytics, Cloudflare routing/capacity or credential edits.
Regular episode/source and image samples are bounded, not whole-catalog or hardware
certification. Existing provider and CSP diagnostics remain separate work.

The normal real-clock build passed. Its time-dependent homepage bootstrap removed
three expired `animeytScheduleAt` fields. A second build with the unchanged generator
and the base commit's clock keeps that unrelated generated delta out of this patch;
its output also passes hash verification. No clock override is committed or applied
to production; future CI uses real time and may regenerate those expired fields.

## Release Gate and Rollback

CI-only branch preparation/push is approved. Add its exact branch CI triggers and
hosted-deploy guard, review current main, commit the reviewed files and verify the
remote SHA/tree. Require general and Linux/Docker CI to pass.
Production approval is separate. Do not deploy the dirty worktree or include TV WIP.

Preserve the last verified v1022 runtime commit
`cb418427ed52d9303ca9e5ddd7f2fb5bbd7303e8` and its paired production container image
digest `49cd886c9ad69ca7622c729c9a273b870cce924b14e5521469a379e84bfc2498`.
The deployment record is in the sibling episode-startup worktree's private
`.cache/v1022-production-validation.md`. Routine catalog publishing can advance the
Worker UUID. A Worker-only rollback does not revert the container. Identify any
regression and request authorization before remediation; preserve older v1021/v1020
rollback evidence and do not purge production caches.

After a separately approved deployment, validate both HTTPS hostnames and the exact
asset generation with HTTP caching enabled. Compare cold/warm image requests; open
Nia and another regular title; verify landscape identity, load/fade/error states and
mobile overflow; decode an episode, seek both directions, pause/resume/fullscreen;
confirm bounded failure controls without signed-URL logging. Investigate new errors
separately from existing provider failures and CSP noise.
