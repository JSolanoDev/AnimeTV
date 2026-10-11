# Handoff (Claude <-> ChatGPT/Codex)

Read this first; update it before you stop. Keep it under ~40 lines.
Rules live in AGENTS.md. Do not duplicate them here.

## Last tool / date
- Codex, October 11, 2026: Cloudflare performance audit; deployment approved.

## Done
- Dedicated native worktree `AnimeTV-performance-audit`, branch `codex/cloudflare-performance-audit`, base d8e635d (v1019).
- Read-only production analytics/header/browser baseline recorded in docs/cloudflare-performance-audit.md.
- Gateway preserves origin browser policy/Age, enforces expiry, and briefly caches five healthy anonymous metadata routes.
- Full app checks/tests, 23 gateway tests, 23 container contracts, 7 production policy tests, local workerd cache test, lint and minified build passed.
- Local neutral 80-request simulation: backend calls 80 -> 4; Worker calls unchanged. This is not hosted savings.
- Production One Piece 904 -> 905 decoded/advanced in phone landscape; one iframe, seek controls, Back cleanup checked.

## Next
- User requested deployment after the completed audit. Publish only reviewed audit changes through existing gated production CI.
- First publication c3903bc passed Linux/Docker CI (run 38179948530); initial backend 503s recovered, catalog HIT policy verified at 300s.
- Republish the tested bounded chunked-metadata admission fix, then verify live metadata HITs and playback before claiming completion.
- Live four-hour Browser TTL and provider/image HTTP failures remain; production setting/security changes need separate approval.

## Gotchas / do not touch
- Working tree is deployed, not git: commit or stash WIP before switching tools.
- One tool edits at a time (or use separate git worktrees).
- Primary checkout contains unrelated already-live changes; never reset it.
- Keep Supabase disabled, source/media/cache contracts, security guards, one basic container cap and idle sleep.
