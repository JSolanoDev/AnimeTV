# Handoff (Claude <-> ChatGPT/Codex)

Read this first; update it before stopping. Rules live in AGENTS.md.

## Current Task: Local v1023 Seek Reliability
- October 13, 2026, America/Denver. Human requested faster loading, intermittent seek-failure investigation and APK emulation; no specific failing episode is known. New worktree AnimeTV-seek-reliability, branch codex/seek-startup-reliability-v1023, base current main f803e66a4dded65f640abdf82e94b64c4802cd1c. Main differs from deployed cb418427ed52d9303ca9e5ddd7f2fb5bbd7303e8 only by catalog data. Human approved CI-only branch preparation/push, exact CI triggers and Vercel branch deploy block. No main promotion, production deployment or live configuration changes authorized.
- Confirmed with failing-then-passing executable regression tests: MP4 recovery load() discarded the seek position; queued recovery could resume paused/ended/hidden video or act on a replacement; seek/load discontinuities reset retry budgets without real progress. Narrow player-only fix retains latest position after metadata and guards recovery identity/intent. URLs, source selection/admission, HLS configuration, Chromecast, Supabase, CSP, backend and Cloudflare config unchanged. Generic recovery guards also apply to HLS without changing its startLoad path or buffering.
- Required v1023 version refs/cache generation and all 28 main Android web mirrors synchronized. Added scripts/test-player-recovery.mjs to normal pipeline tests. Native TV WIP stays separate in ../AnimeTV-network-audit; its final emulator suite passes 7/7 and separate regular decoding canary passes, with earlier transient/harness failures documented.
- Local checks, full regression, isolated ESLint 8.57.1, production build/hash verification and 54 Cloudflare contracts pass. No GitHub/Linux/Docker CI run for this new unpushed candidate yet. Sanitized detailed evidence: .cache/v1023-validation.md.
- Preview raw app remains at http://127.0.0.1:4197, Node PID 12924, loopback-only with process-local daily refresh start delayed 24 hours. Built-assets test preview on 4198 passed exact minified player hash/playback/seek/fullscreen checks and was stopped (owned PID 20728); ignored .cache/built-preview.cjs reuses original routing/security headers. No environment/config file edits. Owned test pages closed and their viewport overrides reset.
- Cache-enabled browser checks: desktop/mobile artwork/layout, one player, decoded regular One Piece 904, large forward/backward seeks. Seek failure fault cases are deterministic tests, not proof of the unknown intermittent provider cause. Warm local assets report zero transfer in sampled ResourceTiming; no production speedup percentage or universal reliability claim.
- Production remains the previously deployed v1022; exact validation and rollback evidence live in ../AnimeTV-episode-startup/.cache/v1022-production-validation.md. v1023 would roll back to that runtime/container pair, not only its Worker UUID. Do not publish a dirty tree or include older TV WIP.
- The old read-only monitor expired and was deleted. Do not restart or backfill it. Completion summary already delivered and private .cache/v1020-monitor-state.json retained in the TV tree.

## Current Task: v1022 Candidate
- Human requested episode-startup/website/Cloudflare optimization. Work is isolated in AnimeTV-episode-startup on codex/episode-startup-v1022, based on current main e746d05606dfa77193e09b6a12fd07cb3b8bef03. Remote main still matched before CI preparation. Human approved CI-only branch push and exact-branch validation/hosted-deploy guards; no main promotion or production deployment/configuration change is authorized.
- One runtime change: warmPlayableStream cancels its unused response body after headers. Callers only warm connections; Range-ignoring origins otherwise keep sending media. Existing one-byte Range, no-store/credentials policy, URL coalescing, source verification/selection, HLS buffering, player/Cast, Supabase and CSP remain unchanged.
- Required v1022 version refs/cache generation synchronized; all 28 main Android mirrors match. Do not mix this with the separate uncommitted TV reliability candidate in AnimeTV-network-audit.
- Four new warmup tests reproduced the v1021 failure and now pass, included in test:pipeline. Five bounded neutral local pairs wrote 640 KiB baseline versus 32 KiB candidate per warmup (95% reduction in origin writes for this fixture, NOT episode startup or Cloudflare billable-byte improvement). Real Chrome independently confirmed one chunk and closed connection.
- npm check/full tests/isolated ESLint/build/build:verify pass. Cloudflare contracts 54/54 and pinned Wrangler/workerd cache runtime fixture pass. Initial benchmark buffer/timer assumptions and the bare-Node workerd invocation were harness issues repaired before final verification.
- Production warm homepage trace: LCP 176ms/CLS 0.03, one lab sample. One Piece 904 baseline decoded/advanced at 1080p with one iframe. Source lookup took about 4.7s/6.9s and continuous-series artwork requested 25 TMDB seasons. Neither provider behavior nor long-series identity mapping was changed; precise click-to-first-frame improvement is not measured.
- Local v1022 desktop/mobile home image/overflow checks pass. Neutral mobile MP4 and desktop HLS decode/advance without media errors; active SW preserves four-byte Range 206 and HLS rewrite. All test playback stopped/owned test tabs closed. Screenshot inspected inline; export to this new worktree was denied, and no path workaround was used.
- Preview http://127.0.0.1:4196/, background Node PID 48620, bound only to loopback. Startup daily refresh delayed 24h for this preview; this is process-local, not a production config change. Owned warmup fixture PID 63940 was stopped. Shared ignored node_modules junction reuses unchanged existing dependencies; no package-lock edits.
- docs/v1022-stream-warmup-efficiency.md records scope, evidence, limits, commands and rollback. Exact v1022 branch added only to general CI/no-deploy Linux check, with matching Vercel preview block and regression assertions. Publishing workflows unchanged. Linux/Docker GitHub CI and hosted v1022 validation remain outstanding; production publishing requires separate approval and latest-main recheck. Production stays on approved v1021; existing v1020 rollback retained. Exact candidate SHA and CI readback will be saved in .cache/v1022-ci-validation.md after the approved push.
- Older release notes below are historical, not a new deployment instruction.

## Current Release
- Codex, October 11, 2026 (America/Denver): preparing v1021; CI-only branch push approved, no production/configuration/monitoring changes.
- Checkout AnimeTV-network-audit, branch codex/console-reliability-v1021, based on current main/v1020 6ccf149ca559f1e68f44d137edffc63a7681deed.
- Two runtime fixes: carousel preload gets canonical href before insertion; player/embed/trailer use modern fullscreen policy with legacy boolean fallback when needed.
- Required v1021 asset/cache version bumps; all 28 Android mirrors byte-identical. No HLS/Cast/source/Supabase/cache-policy/CSP changes.
- Approved CI-only guards: exact branch triggers general CI/no-deploy Linux check; matching Vercel branch block. Publishing workflows/live settings unchanged.
- Full local checks/tests/release-calendar/lint/build/54 Cloudflare contracts pass. Exact final SHA/remote CI evidence goes in .cache/v1021-ci-validation.md after pushing.
- Docs: docs/v1021-console-warning-fixes.md and docs/v1021-production-readiness.md cover scope, validation, checklist and rollback.
- Desktop 1440x900 and mobile 390x844/844x390: carousel art/preload valid, fullscreen enter/exit, decoded 1080p 904 -> 905 and seek pass locally.
- Native fullscreen flags unavailable through DOM wrapper; physical phones, Android APKs, old browser hardware and Chromecast not certified.
- Loopback preview http://127.0.0.1:4195/, background Node PID 39048. Stop streams before closing owned tabs; reset viewport overrides.
- Build-only bootstrap delta excluded through unchanged generator at prior baseline clock; CI still uses real time.

## Production / Rollback
- Keep v1020 live: Git 6ccf149ca559f1e68f44d137edffc63a7681deed; Worker 67501211-4f8c-4fa0-bc46-70d754927707 at 100%.
- Deployment 86a117e6-3da7-4543-b3fe-8186541ce3c2; container a03e7b17-8464-4ab7-80ef-c00efc02efa8, version 29, max 1.
- v1020 image digest 08b4e8af9a2b29128c95a95f2d807f47235289d617cff4596a2bf9d23ba3ef78; exact registry reference in readiness doc.
- Live SW hash 11d6e9fa4b3532d2e33183250a05d78b377c4e20d29822adc1bba62360b80385; .cache/v1020-production-validation.md retains baseline evidence.
- Older v1019 rollback retained. Worker rollback does NOT revert container configuration; no rollback authorized now.
- Read-only monitor monitor-zenkaitv-v1020-for-24-hours unchanged; ends October 13 UTC 04:08 (October 12 22:08 MDT).
- Analytics enforced-CSP block/report-only noise and existing provider faults belong to separate releases; do not hide them.
- No main push, publishing dispatch, purge, DNS/security/credential/billing change without explicit new approval.

## Gotchas
- Primary AnimeTV checkout contains unrelated WIP; never reset it or mix it into this release.
- Deployment uploads working tree: verify exact SHA/tree/cleanliness before any future authorized publish.
- Preserve disabled Supabase, all security/media/source contracts, one basic container and five-minute idle sleep.
- Chrome DevTools stalled previously; in-app browser works. No TLS bypass or signed-media URL/token logging.
- Isolated ESLint avoids dependency edits. No package-lock.json/deploy-vercel.ps1 commits without scoped exception.
