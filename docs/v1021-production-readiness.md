# v1021 Production Readiness

Prepared October 11, 2026 (America/Denver). Production must remain v1020. The user approved only a CI review-branch push; merging main, publishing, Cloudflare changes and automatic rollback require separate authorization.

## Scope And Security Review

Baseline: current main and deployed v1020 Git commit `6ccf149ca559f1e68f44d137edffc63a7681deed`.

- Only client runtime changes: valid canonical carousel preload initialization; remove redundant iframe fullscreen attributes in three templates, retaining a feature-detected legacy fallback and the existing fullscreen allow policy.
- Required root/Android version references move together to v1021. The service-worker diff changes only its shell cache version. Persistent artwork/adult caches and v1020 storage-failure handling are unchanged.
- Behavioral tests cover href-before-insertion, link reuse, missing artwork and legacy/modern iframe feature detection without accessing getters.
- CI-only additions: exact-branch triggers in existing general CI/Linux no-deployment workflows, an exact-branch Vercel deployment block and corresponding guard assertions. Existing publishing triggers, permissions, steps and Cloudflare configuration do not change.
- No changed server, provider, source selection, HLS buffering, Cast engine, catalog snapshot/generator, Supabase, styles, dependency/lockfile, enforced/report-only CSP, analytics or monitoring code/configuration. No unrelated primary-checkout work is included.
- Record final SHA/remote tree in `.cache/v1021-ci-validation.md` after committing/pushing. Re-review future main changes; never overwrite newer catalog commits.

## Validation Gate

Local gates passed: `npm run check`, complete `npm test`, `npm run test:releases`, complete isolated ESLint 8 including service-worker, production build and build verification (57 static files per output), 54 Cloudflare contracts, version checks and all 28 Android mirror comparisons. No TypeScript configuration exists; syntax/global-collision/security gates apply instead. No coverage-percentage claim is made.

Local browser uses ordinary caching with no cache-disable override or production cache/storage purge. Desktop 1440x900 and mobile-size portrait 390x844/landscape 844x390 showed loaded canonical carousel art, one nonempty preload and no page overflow. One Piece 904 decoded at 1920x1080/readyState 4 with an advancing clock. Fullscreen enter/exit worked visually at all three dimensions, forward seek recovered, and Next opened/decoded episode 905. Both fixed warnings remained absent. The modern iframe retains prior allow permissions and omits only the redundant legacy attribute.

Required remote gate, pending at preparation: general GitHub CI plus no-deployment Linux/Docker verification on the exact candidate SHA. Linux must pass locked install, full tests/lint/security/mirrors, native Sharp, guarded outbound API/media smoke, real Worker/Durable Object/container integration and staging/production dry-runs with no upload or publishing. Prior v1020 CI is NOT evidence for v1021.

## Preserved v1020 Rollback

Verified through read-only Cloudflare API before preparing this release:

| Reference | Exact value |
| --- | --- |
| Git | `6ccf149ca559f1e68f44d137edffc63a7681deed` |
| Worker | `zenkaitv` |
| Worker version, 100% | `67501211-4f8c-4fa0-bc46-70d754927707` |
| Deployment | `86a117e6-3da7-4543-b3fe-8186541ce3c2` |
| Container application | `a03e7b17-8464-4ab7-80ef-c00efc02efa8`, version 29, maximum 1 instance |
| Container image | `registry.cloudflare.com/82846f471a6cc2b416851facadcd324b/zenkai-backend-production@sha256:08b4e8af9a2b29128c95a95f2d807f47235289d617cff4596a2bf9d23ba3ef78` |
| Live minified SW SHA256 | `11d6e9fa4b3532d2e33183250a05d78b377c4e20d29822adc1bba62360b80385` |

For a later critical regression, obtain rollback approval first. Restore the exact v1020 Worker at 100%, preserving DNS, bindings and Durable Object data. Independently reconcile the attached container image/configuration: Worker rollback does not revert those resources. Keep one basic container and five-minute idle sleep. Container rollout is nontransactional and may briefly interrupt APIs. Re-check both HTTPS domains, health/config, decoded playback, seeking and neutral MP4 Range/HLS. A rebuild needs a reviewed forward commit or approved immutable baseline; never force-push/reset main or discard newer catalog updates. No rollback is executed by this preparation.

## Before / After Checklist

| Check | Before (v1020) | After separately approved v1021 deployment |
| --- | --- | --- |
| Identity | Record main SHA, Worker/container references and SW hash above | Confirm actual successful publish/readiness, reviewed SHA, v1021 refs on both domains |
| Cache-enabled home | Cold then ordinary warm reload, comparable samples | Same settings, loaded carousel/posters, one valid preload, no invalid-href warning |
| Desktop playback | One Piece 904 -> 905, one iframe, decoded/advancing video | Same bounded sequence, seek/resume/fullscreen enter/exit, no precedence warning |
| Mobile dimensions | 390x844 portrait and 844x390 landscape; readable controls, no overflow | Same layout/framing/seek/fullscreen; physical-device verification separately |
| Storage/media | Image-cache online fallback and network-only Range/HLS contracts | No new unhandled SW/cache faults; neutral MP4 Range 206 and HLS rewrite unchanged |
| Console/providers | Separate known CSP noise and intermittent/absent-title provider failures | Report NEW actionable differences: severity, endpoint, evidence, impact and recommendation |
| Cleanup | Stop test playback; no production/user cache clearing | Leave watch, close owned test tab and reset viewport override |

## Risks / Recommendation

Recommend deployment only after exact-SHA CI/Linux/Docker passes, remote tree matches, latest main remains compatible, and the user separately approves production. No new runtime regression was observed in the bounded sample. Native fullscreen flags are unavailable through the DOM-only wrapper; UI labels/framing and continuing playback are the available proof. Viewport emulation is not physical Android/iOS Safari, legacy-browser hardware or Chromecast certification. Whole-catalog reliability and population error rates are not established. The stalled Chrome DevTools connector limits detailed network/console auditing; production cache-enabled DevTools checks belong after approval, without weakening security. Known analytics/CSP/provider and injected-extension errors remain outside this release.
