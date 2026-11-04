# November 4 security and performance review

Date: November 4, 2026 (America/Denver; analytics day boundaries are UTC).
Isolated worktree AnimeTV-security-performance, branch codex/security-performance-nov4.
Base/HEAD48556995b6daa03f930b126c26ad1517c67a08c6 from fresh origin/main.
No commit/push/application rollout performed. The premium UI experiment and older
unpublished v1025/v1026 fixes are separate and were not included.

## Confirmed findings

1. The emailed83% automated share is a classification alert, not proof of compromise.
   The API currently reports the zone as Free Website with Bot Fight Mode enabled.
   Do not purchase Pro/enable Super Bot Fight Mode to match the marketing email.
   Bot-decision details and firewall-event aggregates were denied for this plan/token;
   no broader permissions, raw client logs, IPs, cookies or signed source URLs collected.
2. Existing selective Worker-first asset routing covers root private-file paths, but
   misses nested paths. /bot/.env and /dashboard/.env returned200 text/html,45349bytes,
   a SPA document. This is not evidence that environment values were exposed.
   On November2 adaptive aggregates reported31 and28 such200 responses respectively.
3. TMDB search dominated the sampled November2 request-path groups:2905 HTTP200,
   993 managed-challenge403 and4 cancellations499. Cause/intent of those individual
   callers cannot be established from aggregates. Do not classify all as attackers.
   The client redundantly queried without year after the server already did that
   fallback. This is confirmed in executable tests and a real browser fixture.
4. Warm cache-enabled desktop trace: LCP365ms, CLS0.03, TTFB115ms at1x CPU/no network
   throttle. No CrUX field data; this is one warm lab sample, not universal speed.
   Forced rail reflow14ms had no estimated savings, so it was not changed.
   The catalog remains a large decoded payload; ResourceTiming through service workers
   is not wire-byte accounting. Existing compression/shared caching is retained.
5. Homepage visible artwork loaded in sampled desktop and390x844 mobile; mobile had
   no horizontal overflow. Existing Cloudflare analytics beacon is blocked by CSP.
   No CSP weakening, analytics injection change or broad code removal was made.

Daily zone counters (not browser request counts; November4 is incomplete):

| UTC day | Requests | Response bytes | Cached requests | Threats |
| --- | ---: | ---: | ---: | ---: |
| November1 |11,188|1,925,842,023|2,334|1|
| November2 |7,506|622,603,425|1,944|146|
| November3 |8,326|1,138,008,814|1,393|8|
| November4 partial |12,215|884,298,463|3,818|21|

November2 did not have118% more total requests than November1. Adaptive groups also
show existing managed challenges and blocks. Counts in adaptive samples need not
exactly equal daily fixed aggregates. Cache ratios do not measure all Workers Cache API
hits; uncached playback is intentional. No global API error rate inferred from probes.

## Live mitigation completed

At2026-11-04T22:54:57Z added ONE reversible, host-scoped custom WAF rule:
- Ruleset2593c42988a042dea54e07e3a2f4b04b, rule dc2aa99a8da04dbe8f0b72d5be59bc43.
- Exact proposal: ops/cloudflare/private-file-rule.json.
- Blocks path segments beginning/.env and .git directories on apex/www before SPA.
  Checks only URL path, not embedded media/search URL query parameters.
- Readback confirmed enabled/action block. No prior custom-phase ruleset existed.
  Existing leaked-credential rate limit, Bot Fight Mode, managed rules and DDoS untouched.
- Post-change /bot/.env, /dashboard/.env and/deep/.git/config HEAD403.
  Homepage, /anime/one-piece and /api/health HEAD200.
- No DNS, paid plan, capacity, token, CSP, database, player setting or app deployment.
  Runtime remains v1024. Last observed pre-change Workerfd078174-ea73-4cfc-9e36-d84622ff408b;
  routine catalog publishers may replace UUID independently of this mitigation.

Rollback: PATCH only this rule's enabled=false using its exact IDs and existing API.
Do not delete/replace unrelated rulesets, disable Bot Fight Mode or roll back the app
to undo this narrow protection. Save/read current rule before any separately needed rollback.

## Scoped local source improvements (not live)

- All three asset configs route nested/.env*/.git probes to the existing small no-store
 404 guard. Existing SPA, real static assets and API source query routing preserved.
- TMDB proxy adds yearFallbackApplied:true only after successful unfiltered fallback,
  including its existing cached response. New resolver skips that redundant HTTP lookup
  only for explicit successful/configured/non-stale responses. Legacy/error/stale
  payloads and movie-to-TV fallback retain their existing behavior.
- No new match cache, changed TTL, missing-title decision, retry loop, source selection,
  media buffering, HLS/Range/Cast logic, image-quality downgrade or catalog trimming.
- Asset generation1031; all28 Android web mirrors byte-identical.
- Added exact review-branch triggers to CI and no-deploy Linux/Docker workflow, with a
  Vercel branch deployment block and matching contract checks. Production workflow and
  Vercel security headers are unchanged. These prepare a safe future CI push only.

Minified-browser fixture using the actual modified handler, no external API/media:
old resolver2 HTTPlookups, candidate1; both resolved to the existing no-match fallback.
This is50% fewer lookups for this specific empty year-fallback case, not a site-wide
speed/bandwidth claim. An old cached API response without the flag stays compatible.

## Validation

- Full npm test PASS;15 Linux-only skips on Windows disclosed.
- npm run check PASS, global/security guards PASS, all28 mirrors/version1031 PASS.
- ESLint8.57.1 across existing repository globs PASS, reused installed cache.
- npm run build + build:verify PASS,57 hash-verified files per dist/public.
- Cloudflare gateway/container/production contracts54/54 PASS.
- New targeted tests10/10 PASS; five meaningful pre-fix failures reproduced after
  correcting the test response capture harness. Includes legacy/error/stale/movie
  fallback, exact match preservation, nested deny and legitimate route coverage.
- Build uses fresh catalog data; content-identical homepage-bootstrap stat drift may
  appear in status. No catalog content change belongs in this patch.
- Browser, caching enabled: One Piece904 decoded at8.16s,200frames/readyState4/no error,
  one iframe. After+20s seek, time29.12->31.12/readyState4/no error, then paused and
  left watch route to stop buffering.
- Known neutral CC0 MP4 through real Chrome:206,4bytes, Content-Range0-3/1128375.
  HLS manifest200,#EXTM3U,1077bytes; segments not downloaded for this probe.
- Native Python media probes received Cloudflare1010 before and after the new rule;
  real Chrome probes/playback passed. This is existing browser-integrity rejection,
  not evidence the new path rule broke media. Security was not bypassed.
- Only the known beacon/CSP console error after return Home; no new JS exception observed.
- No real GoogleTV/hardware Cast, every-provider or full-catalog playback guarantee.
  Remote Linux/Docker CI remains pending an approved review-branch push.

Private sanitized evidence: .cache/nov4-audit-evidence.json, nov4-public-probes.json,
nov4-post-waf-probes.json, nov4-tests.log, nov4-check.log, nov4-lint.log,
nov4-build.log, nov4-cloudflare-tests.log and nov4-preservation.json.
No credentials or signed media URLs logged. No raw private user traffic inspected.

## Publication boundary and follow-up

The human subsequently approved committing and pushing this reviewed branch for
CI-only validation. This does not authorize production rollout or configuration changes.
Remote run results and exact committed SHA will be recorded in the local CI evidence.

The live private-file WAF mitigation is complete. The scoped app optimization and asset
routing hardening are ready for CI-only review. No push or app deployment has occurred.
Obtain publication approval; push only this explicit review branch, verify remote SHA,
run general and Linux/Docker CI, reconcile fresh main catalog updates, and preserve the
paired current production Worker/container rollback before a separately approved rollout.

Keep the premium UI experiment, v1025/v1026 fixes and unrelated provider/CSP work separate.
Next investigations: retain cache-enabled baselines, inspect legitimate TMDB miss demand
with available aggregate coverage, and plan measured catalog slimming separately.

References: [Worker selective routing](https://developers.cloudflare.com/workers/static-assets/binding/),
[Bot Fight Mode considerations](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/),
[Super Bot Fight Mode](https://developers.cloudflare.com/bots/get-started/super-bot-fight-mode/).
