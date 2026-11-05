# AnimeNeon reliability fix — v1033 local candidate

Status: locally implemented and validated; not pushed/deployed. Base is current productionv1032 commit71a2cc1188c6c75e5f8418e498a2673f6dcba3e2. Branchcodex/animeneon-reliability-v1033 in isolatedAnimeTV-animeneon-reliability. Other worktrees and v1032 production evidence preserved.

## Findings and confidence

The earlier production OnePiece reference showed AnimeNeon HTTP502 while fallback playback worked. Its response body was not captured; the exact historical upstream trigger remains unproven. On November5 at01:53:25UTC, the bounded normal production request for OnePiece904/Sub returned200/ok with5sources in1108ms. No signed URLs retained. This establishes intermittent behavior, not permanent provider failure or proof that an upstream service cannot fail again.

Code inspection plus RED tests confirmed independent application defects: malformed/empty/mismatched provider data could become cached missing episodes; stale known-good sources could be re-labelled as fresh CDN-cacheable success; simultaneous forced refreshes sent duplicate client requests, and older results/cleanup could overwrite or remove newer work.

## Targeted repair

- Search/episode JSON and expected data shape must be valid. Invalid data and mismatched episode identity remain explicit retryable502 errors, never false missing-title cache entries. Existing cooldowns/backoff preserved. True upstream404 still has its scoped miss TTL.
- Unavailable optional mirrors cannot discard an independent usable source. If no usable sources remain, report an honest transient failure rather than caching absence.
- Existing same-identity known-good server payload may still be returned during an outage, now explicitly marked stale and private/no-store. Client stale grace is15seconds; it no longer receives a fresh ten-minute client lifetime or public CDN lifetime.
- Forced refreshes coalesce within their own lookup key. Monotonic request sequence prevents late old successes/misses replacing a newer response; cleanup removes only its own in-flight entry. Normal vs forced cache modes and provider cooldowns remain intact. A failed refresh keeps a still-valid good cached payload.
- No provider removal, provider-order change, HLS/player/Chromecast logic, CSP/analytics/TLS/proxy/SSRF/security-policy change, new dependencies or credential expansion. Raw source URLs remain opaque and go through the existing filtering/resolution/admission paths.
- Generation1033 and28 Android web mirrors synchronized. Exact CI-only branch triggers and hosted-deploy guard prepared; production publishing workflows unchanged.

## Verification

-16 deterministic behavior tests pass. Initial12 cases had11 RED failures before the patch; all now green, with4 additional optional-mirror/cache-preservation checks.
- Full npm test PASS; npm run check/security/global collision/version/mirror checks PASS; ESLint PASS; production build/build:verify PASS,57hashed files in each output;54Cloudflare gateway/container/production contracts PASS;5release tests PASS. Windows has15Linux-only skipped cases. No GitHub Linux/Docker run for this unpushed candidate yet.
- Existing shared-cache/outage/Retry-After tests also pass (initial combined82tests before adding4new cases).
- Chrome inspector remained unresponsive from the previous release; no forced close/restart. Reused locally cached Playwright1.62.1 and launched a separate temporary headless installed Chrome profile, then closed only that owned browser. No app dependency installation or browser security/TLS/CSP bypass.
- Minified client browser fixture hash e821255f3ea4ac58a210bcfb214fd148bb0f66e9a0a3ffcfd175afb1e2b29ad5: concurrent normal+two forced calls made2requests; both final results used newer source, in-flight map empty. Only the local client asset was fulfilled from its exact built bytes for the fixture; no production API mutation.
- Separate normal-cache context, actual local v1033 app/regularOnePiece904: decoded1920x1080, time advanced, seek300->302.016523, no media error, one iframe. Paused/left watch,0player iframes.390px mobile no horizontal overflow; screenshot .cache/v1033-browser-proof.png reviewed. No page exceptions/provider warnings in this sample.2local CSP diagnostics remain from the existing local analytics-policy mismatch; no CSP policy was altered or disabled. This is bounded desktop/mobile emulation, not a whole-catalog/long-session/physicalTV/Chromecast guarantee.

## Publishing and rollback

No new production approval or CI-only branch push approval has been given for this v1033 candidate. Prepare exact local commit, then request CI-only push for generalCI and Linux/Docker validation; keep production onv1032 until separately approved. Do not treat a future real upstream502 as solved merely by these local tests.

Rollback for a future approved release is the paired currentv1032 reference: commit71a2cc1188c6c75e5f8418e498a2673f6dcba3e2, Worker6b81e53e-746c-4776-b846-12fcb468d32f, applicationa03e7b17-8464-4ab7-80ef-c00efc02efa8 version161 with image@sha256:66af660214856ad914b8dd399ce4f475a212e71eaab3edcb1c44a172dd339f7a. Re-read and preserve current Worker/backend pair before publication, reconcile fresh main/catalog updates, no force push.

Evidence: private .cache/animeneon-initial.json, animeneon-red.log, animeneon-targeted.log, full-tests.log, check.log, lint.log, build*.log, cloudflare-contracts.log, releases.log, v1033-browser-validation.json and v1033-browser-proof.png. No credentials, cookies, signed media URLs or raw user logs recorded.
