# MP4 Range bytes=0-3: 206, exactly 4 bytes and correct Content-Range; HLS: 200, valid rewritten manifest |
| Local browser media through active v1020 SW | MP4 Range: 206, 4 bytes, Content-Range bytes 0-3/1128375 |
| Desktop, 1366x768 | Home painted all sampled visible images; normal warm reload reused versioned assets; active SW reported v1020; no horizontal overflow |
| Local regular episode samplev1020 Production Readiness

Prepared October 11, 2026, using the user's America/Denver date. This is a preparation record, not deployment authorization.

## Decision

No newly introduced security or regression issue was identified in the complete release diff. Local gates pass and the release is ready for approval **with the limitations below**. Do not commit/push the release, dispatch publishing, roll back production, change account settings or deploy until the user explicitly approves.

Production remains v1019. A read-only Cloudflare API check confirmed 100% traffic on Worker version `cf3e0939-2294-410d-b1c2-c80b8c05c15f`, deployment `086c5b4e-095f-4e16-ac2d-5f2c69181dd2`. No production mutations were performed.

## Complete Diff Review

Base: `35e4b39f466127bd880b141f4e388add640aa854`, branch `codex/network-service-worker-audit`, worktree `AnimeTV-network-audit`. The origin/main fetch confirmed this base at review time; fetch and re-review again immediately before any approved push.

| Release files | Scope |
| --- | --- |
| service-worker.js and its Android mirror | Optional storage failures no longer replace successful downloads; invalid artwork is not pinned; unsupported writes are avoided; caught background writes/trims use event lifetime |
| index.html, client.js, player/player.html and their three mirrors | Only v1019 -> v1020 asset references; a normalized comparison against the base passed for all six files |
| scripts/test-api-cache-efficiency.mjs | Failure injection, cache reuse, canonical player shell, trim, delayed writes and Range passthrough tests |
| scripts/test-player-url.mjs | Source-text assertion updated to the cache helper; stronger behavioral coverage added in the cache test file |
| scripts/audit-service-worker-network.mjs | Localhost-only neutral counter fixture, excluded from deployed static/backend inputs |
| docs/network-service-worker-audit.md, this record, HANDOFF.md | Audit, readiness and handoff documentation, excluded from deployed runtime |

The full tracked diff and the new untracked fixture/report were reviewed. Checks against the base confirmed 22 protected files unchanged, including player/player.js, player/player.css, styles.css, source/router/constants helpers, backend code, dependency/lock files, Vercel/Cloudflare configuration, Worker/container/network code, Dockerfile and publishing workflow. All 25 backend build inputs are unchanged. No new dependency, access permission, source integration, database schema, login feature, media rewrite or routing change.

Specifically unchanged: HLS buffer limits (90/180 seconds and 96,000,000 bytes), codec/ABR and retry settings, Chromecast code, source selection/verification/fallbacks, disabled Supabase, CSP/security headers, Cloudflare routing/bindings, one basic container maximum and five-minute idle sleep. No DNS/registrar or Vercel changes.

The final review found the build-generated bootstrap recalculated an expired clock on one existing item. Its 96 title identities and episode inventories did not change. The working generated snapshot was regenerated using the previously verified baseline clock and checked against the base; it is excluded from the release diff. The generator itself is unchanged and production CI will regenerate clocks using the real deployment time. No production clock is frozen. Local runtime settings were also semantically unchanged; index refresh left no staged changes or unrelated file diffs.

Security review: API/media still use the original Request (including Range/cancellation) once and never enter Cache Storage. No credential, cookie or signed-source cache was introduced. Image writes require a 200 image response; 204/errors/HTML cannot become a durable poster. Vary wildcard/206 skip writes without modifying the response. Write/trim failures are contained in optional storage; online success is not replayed. Existing external-resource cache breadth was preserved rather than expanded. It still merits a separate public-static allowlist review; this patch is not that design change.

## Validation Results

| Gate | Result |
| --- | --- |
| npm run check | Pass: syntax, collision, catalog integrity, security and mirror/version guards |
| npm test | Pass: complete existing regression suite after final-review test additions |
| Focused service-worker tests | 16 pass; slow write is off the response path, FIFO deletion failure stays harmless, Range body/status/headers preserved |
| Cloudflare contracts | 53 pass: gateway, container, production guards, Range/HLS/cancellation/compression/provider errors |
| ESLint including service-worker.js | Pass via existing ESLint 8 rules; no dependency edits |
| npm run cloudflare:production:prepare | Pass: minified frontend, verified dist/public and 25 allowlisted backend inputs |
| npm run cloudflare:production:bundle | Pass with pinned Wrangler 4.149.0, dry-run and container rollout none; no upload or hosted rollout |
| Root/Android assets | All 25 index references on v1020; 28 mirrors byte-identical; no stale helper/player references |
| git diff --check | Pass |
| Existing neutral browser counter fixture | Pass: one fetch + one XHR = two origin requests; repeated/recovered artwork = one origin response each; 206 not cached |
| Local native neutral media |  | One Piece 904 decoded/advanced at 1920x1080, readyState 4, one player iframe, no media error |
| Mobile emulation, 390x844 / 844x390 | No horizontal overflow; portrait player about 390x220; seek succeeded; Next to 905 decoded/advanced at 1080p; one player frame |
| Browser Back after playback | Returned home and removed the player iframe |

HTTP cache was not disabled in these local checks; reload used ignoreCache=false. Warm asset timing showed cache/cache-storage delivery. A new isolated localhost browser context was used, not the user's production storage. This is **not** the required post-deployment production cold/warm comparison or physical phone/Chromecast validation.

The local preview and owned test page were stopped/closed (the browser later restarted to its blank default page). The user's other preview and in-app browser were not changed.

## Remaining Uncertainty

- Linux Docker/native Sharp and real Worker/DO/container integration cannot run on this Windows machine because Docker is unavailable. The existing production CI must pass these gates on the exact approved snapshot before its publish step. Do not skip or loosen them. The dry-run bundles the Worker but does not prove a Linux image or container rollout.
- Local provider/metadata requests returned some 404/502/503 responses (including TioAnime, JKAnime and TMDB proxy reads) and cancelled losing fallback candidates. The sampled HLS episode still decoded; this is not proof that those services are healthy. Backend/provider code is unchanged. Record and distinguish provider failures from startup/cache regressions during production checks.
- Local Node CSP blocks Vercel Insights; its existing policy differs from the unchanged production gateway policy. The production audit reproduced a blocked Cloudflare Insights beacon. Neither should be misclassified as a new v1020 policy change.
- The original 106 console errors, 57 grouped resource CSP issues and eval violation are not fully reproduced or resolved. Unsafe-eval is not added. Collect frame, directive, blocked host, source location and impact after approval; do not declare every warning harmless.
- Production idle-GIF caching was confirmed as max-age=0/must-revalidate. An ETag request returned 304 with no body, but repeat network revalidation is still possible. GIF URL/header changes are deliberately outside this release.
- Hardware Chromecast, physical iOS/Android, native gestures/fullscreen, Android APK execution and whole-catalog playback were not proven. Code is unchanged and regression tests pass; that is not a hardware guarantee.
- Existing broad external-response caching and whole-series metadata/probe optimization remain separately scoped follow-ups. No behavior was silently removed to improve audit counts.

## Rollback to v1019

Saved rollback references, confirmed by read-only API:

| Item | Reference |
| --- | --- |
| Git baseline | 35e4b39f466127bd880b141f4e388add640aa854 |
| Worker | zenkaitv |
| Known-good v1019 version | cf3e0939-2294-410d-b1c2-c80b8c05c15f |
| Active deployment at preparation | 086c5b4e-095f-4e16-ac2d-5f2c69181dd2 |
| Production container application | a03e7b17-8464-4ab7-80ef-c00efc02efa8, application version 28 |
| Container image | registry.cloudflare.com/82846f471a6cc2b416851facadcd324b/zenkai-backend-production@sha256:f99f974061d344e570e92d6effc28f31b6a9cb2fec66bb2c2350b78fc9490879 |
| Capacity | max_instances 1, scheduling policy default; basic instance remains in unchanged config |

Before an approved publication, recheck/save these references and record the exact new release commit, active Worker version and resulting container image/application version. Catalog publishing may advance main; never force-push the old commit over newer catalog data.

Rollback triggers: reproducible v1020 cache-caused missing artwork/scripts; new service-worker unhandled errors; failed Range/seek behavior compared with baseline; a broken/stale mixed asset generation; a new app startup or playback regression. A known provider outage or blocked optional analytics alone is not sufficient evidence of a new release regression.

1. Identify the failure and obtain/confirm authority for production rollback; none is authorized by this preparation request. Stop further publication from replacing the rollback while investigating. Temporarily pause/disable the production deployment workflow only with appropriate authorization; preserve the catalog updater and its data.
2. In Cloudflare Workers & Pages > zenkaitv > Deployments, select the **exact saved version** cf3e0939-2294-410d-b1c2-c80b8c05c15f and roll it back to 100%. Confirm old static assets/HTML references are served. Do not choose an unspecified previous version or change DNS/custom domains. [Worker rollback documentation](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).
3. A Worker rollback does not automatically reset attached resource configuration or container images. This patch changes no backend inputs, bindings or schemas, so the existing backend is compatible. Still compare the actual image and container readiness with the saved reference. If a container rollout/build failure needs recovery, use the known image or a verified baseline rebuild through an approved gated deployment, preserving the same one-instance cap. Do not delete the application or Durable Object storage. [Container rollout documentation](https://developers.cloudflare.com/containers/configuration/rollouts/).
4. On current trusted main, revert only the eventual **v1020 release commit**, preserving later catalog/data commits, then run the gates and approved deployment pipeline. This makes rollback durable; an hourly update must not republish the faulty code. Do not git reset --hard, force-push old main, overwrite unrelated WIP or revert newer catalog snapshots.
5. Recheck both HTTPS hostnames, frontend v1019, `/service-worker.js` update policy, active controller version after an ordinary reload, cached/uncached images, health/config, four-byte MP4 Range, regular HLS playback/seek/Next and Back. Existing open tabs may keep already-loaded scripts until reload; do not globally purge users' artwork, favorites or history.
6. Resume normal publishing only after the corrected/reverted snapshot and hosted behavior are verified. Save sanitized results and the final Worker/image/commit references. Keep Vercel registration/renewal and any rollback hosting intact; no registrar transfer, DNS replacement or paid-plan upgrade.

Worker rollback is a recovery plan, not a rollback rehearsal or promise of instant container recovery. Deployment activation and container rollout are not transactional, and a single-container rollout may briefly affect API availability.

## Before/After Checklist

Run the same bounded steps on baseline and, **only after approval and publication**, on production v1020. Desktop: 1366x768. Mobile: 390x844 and 844x390 emulation, followed by a physical-phone spot check when available.

| Check | Before v1019 | After v1020 |
| --- | --- | --- |
| HTTPS/version | Both domains have valid TLS; save Worker/image/asset generation | Same domains, correct new Worker, consistent v1020 scripts and controller |
| Cold browser load | Fresh isolated context; DevTools Disable cache unchecked | Another fresh isolated context; identical settings and wait budget |
| Warm load | Ordinary reload/back to home; record cache deliveries, loaded posters and bytes | Same steps; no mixed versions, empty pinned posters or storage-caused synthetic 503s |
| Catalog/layout | Same regular title set, schedule selection, desktop/mobile overflow check | Same behavior; no unrelated catalog or feature regression |
| Playback | Same episode/provider, record resolution/time advancing, one player frame | Same checks, then pause/resume, seek backward/forward, Next and Back cleanup |
| Range/fallback | Neutral four-byte MP4 GET is 206/4 bytes; real errors remain errors | Same through active SW; no Cache Storage write, replay or status disguise |
| Cache failure | Local neutral storage/open/read/write failure fixture | Healthy online response survives; unsupported/empty/error artwork is not cached |
| Console/CSP | Save deduplicated errors by frame/directive/source and functional impact | Compare new versus baseline; keep CSP, report unresolved eval/resource issues |
| Security/capacity | Disabled login, existing headers/SSRF guards, one basic instance/idle sleep | Unchanged; no credential, routing or source-selection drift |

For the production comparison, retain HTTP caching enabled even for the cold run: use a fresh **test-only** browser context rather than Disable cache. Record cold and warm sessions separately, with the same route, duration, source and bitrate where observable. Distinguish a cold browser cache from a proven container cold start; do not infer the latter from a slow first response alone. Do not clear the user's normal browsing storage or retry/buffer media artificially just to obtain favorable results.

Network totals should use actual transferred sizes/conditional responses and separate video, images, GIFs, JS, APIs and direct third-party traffic. Count only the real inner network transfer for intercepted requests. Resource Timing zeros and decoded JSON sizes are not billing totals. Sanitize cookies, authorization and signed media query values from any saved evidence. Pause promotion/rollback assessment if a new regression is found; investigate the affected frame/route before expanding scope.

## Fingerprints at Preparation

- Root worker SHA256: 4c11e134fb1c3e13ab38b135bde6d8b3ec6b40f949efde31dda9d4ff4cb5bbe4.
- Root index SHA256: 96b24864c6416895ac4478e2c32c58e3cd4391c0e5e007e9befe910b77928103.
- Prepared production inputs hash: 7aa18f2e738d650e13fa6248d9d2db5e597c37563f5acc6c9a7fae1b2d11b69d.
- Minified prepared worker SHA256: 11d6e9fa4b3532d2e33183250a05d78b377c4e20d29822adc1bba62360b80385.
- Backend context-manifest SHA256: ce53e5a90fe8e78f2b10e23d2a36ab9986a2f8e59df6ec7f1f78e4108d2811b3.
- Static build has 57 verified app files in each output; production preparation adds header/redirect/ignore metadata. No audit fixture/report or handoff is a deployed asset or backend input.

These identify this local review, not an already-published release. Production CI must build and verify the exact approved commit again; its time-sensitive bootstrap and therefore aggregate build hashes can legitimately change. No credentials are embedded in this record.

## CI-Only Push Authorization

The user subsequently authorized pushing the reviewed branch for GitHub CI validation only. Production deployment, merging/pushing main, publishing workflow dispatch and Cloudflare configuration changes remain prohibited until separate explicit approval.

Two CI-only workflow edits enable this validation: CI and no-deployment container verification accept the exact review-branch push; the latter also checks release-calendar/lint, production policy and a production dry-run after real local Linux container integration. A matching test asserts the branch cannot trigger publishing. Vercel git.deploymentEnabled is false for this exact branch only, preventing an unintended legacy preview deployment; unspecified branches retain their existing behavior. No publishing step, Cloudflare credential, new secret, write permission, staging/production deployment workflow, security header or application runtime change was added. Record the exact local/remote commit match and both workflow outcomes before recommending deployment. These CI-only differences are additional to the original runtime review and must be disclosed.

Both first GitHub runs passed on a9f51ab, but log review found the legacy Node 20 CI lint installation re-resolved dependencies through npm i --no-save, producing engine warnings for newer packages. A CI-only follow-up replaces it with isolated npm exec ESLint, leaving the lockfile and application dependencies untouched. Rerun both workflows on the final commit before recommending publication. Legacy Vercel status checks also report an account deployment block; this is not an app-test failure, and no Vercel account/payment change is authorized.
