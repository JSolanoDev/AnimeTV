# Handoff (Claude <-> ChatGPT/Codex)

Read this first; update it before you stop. Keep it under ~40 lines.
Rules live in AGENTS.md. Do not duplicate them here.

## Last tool / date
- Codex, October 11, 2026 (America/Denver): user approved review-branch push for CI ONLY; production/configuration changes remain prohibited.

## Done
- Current worktree `AnimeTV-network-audit`, branch `codex/network-service-worker-audit`, base 35e4b39 (live v1019).
- Prior approved audit deployed through CI 38180798427, Worker cf3e0939-2294-410d-b1c2-c80b8c05c15f; gateway cache fixes are already live.
- New report: docs/network-service-worker-audit.md. Two bounded 90-second episode 904 samples decoded/advanced at 1080p.
- Screenshot has Disable cache checked. XHR/SW pairs are interception, not double transfers; numbered source paths are HLS fragments.
- Local v1020 patch fixes cache read/write failures, synthetic image 503s, pinned 204 artwork and unsupported 206/Vary writes.
- Network-only source/Range/provider-error contracts, player behavior and CSP unchanged; all 28 Android mirrors match.
- Full checks/tests/lint/production preparation and dry-run bundle pass; 53 Cloudflare contracts and 16 focused SW tests pass.
- Neutral real-browser counter fixture passes: fetch+XHR -> two origin requests, cached/recovered images -> one each, 206 uncached; clean console.
- Native catalog GET is gzip, about 2.93 MB received versus about 16.25 MB JavaScript-visible. Body-volume tables are NOT wire/billing totals.
- Final readiness/rollback/checklist: docs/v1020-production-readiness.md; runtime diff is SW + version refs only, 25 backend inputs unchanged.
- Local v1020 desktop/mobile 904 -> 905 decoded/advanced at 1080p; seek, browser Back/frame cleanup and SW MP4 Range 206/4 bytes passed.
- Read-only rollback record: active v1019 Worker cf3e0939-2294-410d-b1c2-c80b8c05c15f; container image digest saved in readiness doc; max 1 unchanged.

## Next
- Push ONLY codex/network-service-worker-audit for CI. Never merge/push main or dispatch a publishing workflow without separate approval.
- CI-only additions: exact branch push triggers on CI/no-deploy verification; Linux job adds release-calendar/lint, production-policy tests and production dry-run.
- Vercel auto-deploy disabled for this exact review branch only; no main/global deployment setting or Cloudflare config changed.
- One CSP-blocked injected analytics script reproduced; original eval issue/57 resource issues/106 errors were NOT individually reproduced.
- Do not enable unsafe-eval or dismiss all original errors; original DevTools history is not available through the connected audit browser.
- Higher-risk follow-ups: exact successful probe reuse, lazy long-series metadata, public-static external cache allowlist; no playback edits yet.
- Fixture server/tab were stopped after testing. Screenshot returned inline; browser tool denied workspace-file export, not bypassed.
- Local preview stopped. Generated bootstrap excluded/restored to baseline using its prior verification clock; CI still uses real time.
- Production GIF idle response revalidates (max-age=0); conditional GET 304/0 bytes. Policy changes remain outside this release.
- Linux Docker/native Sharp/real container integration remain gated CI requirements after approval; no Docker here, no zero-downtime/hardware guarantee.

## Gotchas / do not touch
- Working tree is deployed, not git: commit or stash WIP before switching tools.
- One tool edits at a time (or use separate git worktrees).
- Primary checkout contains unrelated already-live changes; never reset it.
- Keep Supabase disabled, source/media/cache contracts, security guards, one basic container cap and idle sleep.
