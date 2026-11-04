# Provider reliability and analytics CSP repair — November 4, 2026

Status: provider application patch locally validated, not pushed or deployed. Asset generation 1032. Production application stays on v1031, commit 1207ed76661362e2a1c4350bc27142744c686126. Separate premium redesign and catalog/TV worktrees are untouched.

## Confirmed causes

- JKAnime /api/jkanime/sources (regular One Piece 904 sample) returns 503 because the upstream episode request returns 403. Existing upstream cooldown/Retry-After is correct; no provider block bypass, proxy expansion or fabricated success was introduced. Availability cannot be restored by an application-only fix.
- TioAnime /api/tioanime/sources returns a genuine 404 for that same title/episode. Ordinary reads of its episode/title paths also return 404; the directory snapshot has films and specials, not the main-series mapping. Do not replace it with a different installment.
- TioAnime incorrectly converted all upstream HTTP failures and unrecognized 200 pages to cached missing episodes. A configured remote-service failure could also be cached and replayed as 404. The client repeatedly requested misses and promoted failed guessed slugs before validation.
- Cloudflare Web Analytics automatic injection added a beacon blocked by the existing enforced CSP.

## Changes and boundaries

- TioAnime distinguishes true 404/410 absence from upstream blocks, rate limits, server failures and missing/changed source markup. Only verified absence enters its miss cache. Transient failures return 503, private/no-store and Retry-After, using the existing shared provider cooldown.
- Expired known-good TioAnime payloads remain available as marked stale/no-store fallback during a transient outage. Recognized download-only pages do not become missing-title responses. Existing download-host exclusions remain intact.
- Both clients keep at most 1000 per-episode miss markers for 60 seconds; different episodes/providers remain independent. Manual refresh bypasses a miss but respects outage cooldowns. Positive cached sources remain usable during cooldown. No automatic polling, source removal or provider-priority changes.
- A guessed TioAnime slug becomes confirmed only after usable source options pass the existing filtering and merge. Primary options remain intact.
- Live scoped analytics fix: existing RUM ruleset enabled=false; auto_install=true and lite=true retained. No new analytics site/token or permissions. Both public hostnames now return 200 without beacon injection; enforced CSP SHA256 remains 51d93d618ecaf7a744791bf196d5872257147c009c5215a2c12184fc6e410171. Edge request analytics remain separate. No CSP relaxation, cache purge, WAF/DNS/routing/container/Supabase change.
- Generation 1032 and all 28 Android asset mirrors synchronized. Player/HLS/Chromecast logic, source selection, service-worker caching logic, security filters and production deployment workflow are unchanged; player HTML and service worker changes are version references only.
- Prepared exact review-branch CI triggers and Vercel deploy guard for codex/provider-analytics-reliability. Main and hosted deployment triggers unchanged; no remote push performed.

## Validation and limits

- 21 new deterministic outcome/cache/source-preservation tests pass; initial 11 failing regression cases demonstrated the defects before the patch.
- Full npm test PASS; npm run check/security/global-collision/asset/mirror checks PASS; ESLint PASS; production build and build:verify PASS (57 hashed files per output); 124 API-cache/Cloudflare routing/production/container contract tests PASS; 5 release-calendar tests PASS. Windows skips 15 Linux-only cases; new GitHub Linux/Docker run remains pending CI-only push authorization.
- Fresh cache-enabled Chrome production pages on apex/www: no Cloudflare beacon elements/requests or analytics CSP errors. Both native HTTPS responses preserve the exact enforced CSP hash above.
- Real local v1032 browser fixture: concurrent and repeated 404 lookups make one HTTP request per provider; explicit refresh recovers both. Existing primary source remains and valid TioAnime source merges.
- Real local v1032 One Piece 904: one player iframe, decoded 1920x1080, currentTime 15.88 seconds/386 frames and subsequently 32 seconds; seek to 300 advances to 302.05 seconds, readyState 4, no media error, then paused and left watch route. This is one bounded reference sample, not all-title/long-session/physical Google TV/Chromecast validation.
- Known third-party failures still occur during fallback: JKAnime block, TioAnime unavailable title, an embed host 404/timeout and occasional metadata 502. They are not removed or silenced. Local default CSP also blocks the existing Vercel analytics script; production policy already allows that script and fresh production pages have no such warning. Neither policy was loosened.
- No new production playback patch or site-wide availability guarantee. Do not claim external providers have recovered.

## Release and rollback

1. Obtain CI-only push approval for this concrete candidate; verify remote commit/tree matches local and general CI plus Linux/Docker pass.
2. Report any differences/failures before separately requesting production deployment approval. Reconcile fresh main/catalog updates without force-pushing or overwriting data.
3. Before publishing, retain the current paired v1031 rollback: commit 1207ed76661362e2a1c4350bc27142744c686126, Worker 868ebb96-a13c-47c2-85a5-f803928982af, deployment 328163e3-601b-4599-aa55-83db45d718c6; application a03e7b17-8464-4ab7-80ef-c00efc02efa8 version 160; immutable backend digest sha256:d1370e2b3c86011071bca09d5a19e321ec29a84b62e442dbbd9e1a9cd59a59e9. Re-read current pair if routine publishing advances it. A Worker-only rollback is insufficient if the backend image changes.
4. After approved deployment: both HTTPS hosts/version/hash, health/config, warm caching, independent 404 vs no-store 503, bounded regular decode/seek, one iframe, Range/HLS contracts and no new exceptions. Do not stress-test or poll all providers.
5. Analytics is independent of the app rollback. Restoring injection would set the same existing RUM ruleset enabled=true; this would reintroduce the CSP conflict and is not recommended. No automatic rollback performed.
