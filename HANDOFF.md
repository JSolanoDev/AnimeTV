# Handoff (Claude <-> ChatGPT/Codex)

Read this first; update it before stopping. Rules live in AGENTS.md.

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
