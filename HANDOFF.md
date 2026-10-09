# Handoff (Claude <-> ChatGPT/Codex)
Read this first; update before stopping. Keep under ~40 lines. Rules: AGENTS.md.

## Last tool / date
- Codex, 2026-10-09: Unused Supabase settings removed from isolated staging; login remains disabled. Startup exceptions now show recovery controls; production/DNS untouched.

## Live state
- Production zenkaitv.com remains on Vercel, app v1005. DNS, Supabase and daily updater unchanged; Workers Paid now active.
- Free staging: https://zenkaitv-staging.juankisantiago.workers.dev; version 9d3e69cb-81cc-4fdd-bf80-843b5ab6c9b9. Static frontend on Cloudflare, API/media still Vercel.
- Backend staging: https://zenkaitv-container-staging.juankisantiago.workers.dev; last code deployment be7ad3fb-3023-4b1f-8da8-0c48b320a9fd, followed by secret updates. One Piece 904/905 decoded at 1080p; new v1006 startup guard pending staging deployment.
- Account 82846f471a6cc2b416851facadcd324b; existing OAuth only account/user read + Worker scripts. No credentials committed.

## Prepared
- Separate wrangler.container-staging.json, Worker/DO controller, Linux Node image, sanitized 25-file context, local build/smoke/dry-run commands and verification-only GitHub workflow.
- No framework rewrite or dependency-version changes. New backend hosted flag is opt-in and mirrored to Android; existing defaults preserved.
- Container path streams media same-origin, preserves HLS/Range/HEAD, has shared bounded startup, request cancellation and no upstream retries.
- One staging basic container, five-minute idle sleep; not a production sizing guarantee. No boot-time warming/timers; caches ephemeral.
- Non-root image, no baked secrets; socket DNS/IP guard blocks private/reserved destinations. Public Supabase config rejects privileged keys.
- Existing free gateway retains defaults/security/cache exclusions. CI-only deploy gate allows exact staging branch/account, one basic instance; rejects DNS/cron/production targets.
- Existing full tests/check, ESLint, minified build and Worker-only Wrangler bundle passed; 16 gateway + 18 container tests pass.
- Local Windows lacks Docker. Laptop 192.168.0.169 unreachable from this PC network; user chose GitHub Linux runner.
- Linux run passed: https://github.com/JSolanoDev/AnimeTV/actions/runs/37887183140; Docker/native Sharp/neutral HLS-MP4/full dry-run plus real Worker -> DO -> container/cache/deep routes/cleanup. Baseline RSS 99 MiB, local cold health 616 ms and warm 5 ms; not hosted measurements.
- Validation branch d4b4801e843e94818c56855cd4ac3a1d6eb86ae1; remote main now 53423a7c765d2bff8b77f3a70a14f71ad8b2c4ee from normal daily catalog updater, not us. Main checkout/index preserved.
- Validation snapshot must include branch-only vercel.json git.deploymentEnabled=false; never merge that setting into production. Main and local checkout/index stay unchanged.
- Earlier neutral browser checks passed desktop/tablet/phone landscape; hosted HLS/MP4 Range passed. Selected real HLS episodes decoded; no hardware Cast test. Auth is intentionally disabled, not a migration gate.

## Next
- Real integration caught/fixed decoded catalog bodies carrying compressed headers; automatic response encoding restores gzip/cache correctness. Hosted neutral container checks passed; real providers/OAuth/Cast remain unverified.
- Staging branch 9474045f5a2e7aed55a4911a545abc44c4d90cb2; run https://github.com/JSolanoDev/AnimeTV/actions/runs/37920246605 SUCCESS, full checks/build/Linux media/integration/deploy/readiness. First run only failed immediate 404 before propagation; bounded readiness fix passes 18 tests/lint.
- Token: Workers Scripts/Containers/Cloudchamber Edit, this account only, expires Oct 16. Old exposed value invalidated by confirmed Roll; replacement saved as CLOUDFLARE_STAGING_API_TOKEN, never logged or written locally. No broad auto-build token.
- $5 Workers base is not the full migration price: container RAM/disk/CPU/egress and DO usage are additional. Measure before promising <=$10.
- TMDB settings retained; unused SUPABASE_URL/SUPABASE_ANON_KEY deleted only from staging via Wrangler stdin. Public config now has no auth URL/key; no SDK/login UI. No credentials logged/committed; production configuration untouched.
- Fresh hosted 904 selection, seek +/-10s and Next to 905 played at readyState 4/1080p with no media error. Earlier loader stall's cause remains unestablished; catching startup exceptions prevents silently rejected runs and ignores stale episodes. Pipeline now 142 tests; full checks/tests/lint pass. One transient TMDB 503 and cold startup still need follow-up.
- Catalog snapshots are image-baked: add separately approved Cloudflare publishing to daily jobs before retiring Vercel; preserve current jobs meanwhile.
- Conditional domain cutover approved, not immediate: finish hosted latest-fix/cold player checks, daily Cloudflare publishing, production config/security/capacity/cost monitoring and rollback first. Preserve email DNS records; keep Vercel for rollback. No registrar transfer or Vercel cancellation authorized.

## Gotchas
- Working tree deployments include WIP; preserve all preexisting edits. No package-lock.json or deploy-vercel.ps1 changes in this phase.
- Stop Wrangler dev before rebuilding watched assets on Windows. Never load dotenv secrets into staging automatically.
- Free frontend staging is not a completed backend migration; free CDN/Tunnel is not unlimited video hosting.
