# Console Warning Fixes

Prepared October 11, 2026 (America/Denver), branch codex/console-reliability-v1021, based on approved v1020 commit 6ccf149ca559f1e68f44d137edffc63a7681deed. The user approved a CI-only branch push for Linux/Docker validation; production deployment remains prohibited pending separate approval. No production cache purge, Cloudflare configuration or monitoring change was performed.

## Fixed Locally

1. Carousel image preload: renderCarousel appended a preload link before assigning href. The new code prepares its canonical URL before connecting it, reuses the same element on slide changes, retains high priority and skips unresolved/empty canonical artwork. Added behavioral tests reproduced the invalid insertion before the fix and now pass.
2. Iframe fullscreen warning: all three player/embed/trailer templates had both a modern fullscreen allow policy and allowfullscreen. Modern implementations now use only the existing allow policy. A shared feature-detection helper retains the legacy boolean attribute for older implementations. Sandbox/referrer policy, source URLs and other feature permissions are unchanged. Modern/legacy/unknown-API tests pass, without invoking a potentially unsupported getter.

All eight asset/version-reference files are consistently v1021; all 28 Android mirrors are byte-identical. The service-worker change is ONLY its cache-version bump: v1020 reliability logic and persistent artwork caches remain intact. Backend/provider/player-engine/CSP/Cloudflare code, package/dependency files, styles and publishing workflows are unchanged. Two existing validation workflows now also listen to this exact review branch, with a matching Vercel branch deployment block and guard tests. These approved CI-only changes neither broaden publishing triggers nor change live routing or settings.

## Screenshot Findings Not Silenced

| Message | Finding / action |
| --- | --- |
| EventEmitter MaxListenersExceeded / ObjectMultiplex orphaned streams in contentscript.js | Those emitters/messages are absent from application source. The named content script points to injected browser code; the exact extension cannot be proven from the cropped screenshot alone. Inspect its source URL or compare a clean profile before changing an extension. Do not increase app listener limits or suppress console warnings to hide it. |
| Grammarly-check.js unload permission violation | An injected Grammarly script is trying to use unload. Keep the site's permission policy; update/report the extension rather than changing app security. |
| Cloudflare analytics beacon blocked by enforced CSP | Existing Cloudflare automatic Web Analytics injection supplies a script not admitted by the unchanged app CSP. A configuration-only proposal is to disable unnecessary automatic Web Analytics beacon injection, separately authorized, while preserving script/security monitoring, WAF and enforced CSP. No setting was changed. [Cloudflare automatic setup documentation](https://developers.cloudflare.com/web-analytics/get-started/). |
| AnimeNeon sources 404 | A bounded live check for the pictured regular title's episode 2 returned ok:false, notFound:true, sources:[]: genuine provider unavailability for that lookup, not a service-worker cache failure. Retain fallback sources and truthful HTTP status. |
| JKAnime sources 503 | A bounded live check returned upstreamStatus:403, detail "JKAnime episode HTTP 403", retryAfterMs:60000. The origin blocks access; the app preserves a transient error/cooldown. Do not bypass its challenge, broaden permissions or pretend the lookup succeeded. |
| TioAnime | The same regular-title episode lookup currently returned HTTP 200, ok:true and two sources. This verifies source resolution, not independent decoding of those two sources. No provider was removed or reprioritized. |
| 503 (Offline) row | The screenshot lacks the failed request's actual URL/initiator. Existing SW asset/non-API fallback emits this status for a genuine network rejection with no cached response. The v1020 patch already contains storage failures. The exact cause of this row was not reproduced or established; do not assume every 503 is a storage bug or change genuine errors to 200. A sanitized path/initiator is needed if it recurs. |
| script.js net::ERR_FAILED | The shortened filename alone is insufficient to identify its host or blocker. It was not independently traced from the screenshot; do not remove a script solely on that label. |
| beforeinstallprompt banner message | Native install prompting is intentionally deferred to the existing custom install UI, whose action invokes the saved prompt. No install behavior was changed. |
| Metadata timing / ArtPlayer banner | Informational logs, not application failures. |

Cloudflare report-only script-monitoring reports are distinct from the enforced beacon block. No unsafe-eval, extra CSP origin or reduced security setting was introduced. External failures are not hidden to make the console appear clean.

## Verification

- npm run check passed: syntax, security, global collisions, asset generations, mirror sync and catalog guards.
- Complete npm test passed, including new preload/fullscreen behavioral checks and existing playback/Cast/service-worker regression coverage.
- Complete repository ESLint 8 passed without dependency edits.
- npm run build and build:verify passed: minified JavaScript/CSS, 57 verified app files each in dist/public.
- 54 Cloudflare contracts passed (23 gateway, 24 container, 7 production policy); no hosted publishing was run.
- Local browser at http://127.0.0.1:4195/ shows v1021, both preloads have nonempty hrefs, all 10 sampled visible images loaded and no horizontal overflow. No invalid-preload warning appeared.
- Actual player iframe has the existing autoplay/fullscreen/encrypted-media/picture-in-picture allow policy and no redundant boolean attribute; no allowfullscreen precedence warning appeared.
- Local One Piece 904 decoded at 1920x1080, readyState 4, advancing from about 91 seconds to 118 seconds, no media error. Fullscreen was clicked and the video visibly filled the viewport; a later sample remained 1080p/readyState 4 at about 232 seconds. Native fullscreen-state flags were not exposed through the read-only DOM inspection API, so no hardware/physical-device guarantee is made.
- Final checks at desktop 1440x900 and mobile-sized 390x844/844x390 passed fullscreen enter/exit, full-viewport video framing and continuing decoded 1080p playback (about 292 -> 326 seconds), readyState 4, no media error. The player label changes to Exit Fullscreen. Viewport emulation is not physical mobile hardware or iOS Safari; native fullscreen flags remain unavailable through the DOM wrapper.
- A 10-second forward seek resumed at readyState 4; Next opened episode 905 and decoded/advanced at 1080p (about 47 seconds), with one iframe. Invalid-preload and duplicate-fullscreen warnings remained absent.
- Leaving the watch route removed the player iframe and stopped the test stream. The browser sample's remaining warning was a cancelled embed lookup, not either fixed warning.
- The build recalculated five time-sensitive fields on one existing bootstrap row. This generated-only change was restored through the unchanged generator using the previously verified baseline clock and checked against HEAD. No title, inventory, generator or production clock behavior changed; future CI still builds with real time.
- Final public HTTPS check still serves v1020 and minified SW SHA256 11d6e9fa4b3532d2e33183250a05d78b377c4e20d29822adc1bba62360b80385.

## Review / Limits

The local preview is loopback-only, background Node PID 39048; no public exposure, extra paid service or production setting was enabled. Local Node preview and unit contracts are not a hosted v1021 rollout, Linux Docker rebuild, hardware Chromecast or physical Android/iOS test. The unchanged hosted backend was already validated for v1020. The Chrome DevTools connector stalled on a read; local browser verification used the available in-app browser instead. The actual user-profile content-script faults and ambiguous failed-resource rows remain unproven.

Production must remain v1020 pending separate approval. Promoting this candidate or disabling analytics auto-injection is NOT authorized. See docs/v1021-production-readiness.md for the release gate and preserved v1020 rollback reference; never overwrite newer catalog commits or unrelated primary-checkout work.
