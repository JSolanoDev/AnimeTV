# Handoff (Claude <-> ChatGPT/Codex)

Read this first; update before stopping. Keep under ~40 lines. Rules: AGENTS.md.

## Last tool / date
- Codex, 2026-10-09: Workers Paid active; limited staging token rotated after exposure, replacement saved in encrypted GitHub secret. Publishing guarded staging branch, no hosted backend yet.

## Live state
- Production zenkaitv.com remains on Vercel, app v1005. DNS, Supabase and daily updater unchanged; Workers Paid now active.
- Free staging: https://zenkaitv-staging.juankisantiago.workers.dev; version 9d3e69cb-81cc-4fdd-bf80-843b5ab6c9b9. Static frontend on Cloudflare, API/media still Vercel.
- Account 82846f471a6cc2b416851facadcd324b; existing OAuth only account/user read + Worker scripts. No credentials committed.

## Prepared
- Separate wrangler.container-staging.json, Worker/DO controller, Linux Node image, sanitized 25-file context, local build/smoke/dry-run commands and verification-only GitHub workflow.
- No framework rewrite or dependency-version changes. New backend hosted flag is opt-in and mirrored to Android; existing defaults preserved.
- Container path streams media same-origin, preserves HLS/Range/HEAD, has shared bounded startup, request cancellation and no upstream retries.
- One staging basic container, five-minute idle sleep; not a production sizing guarantee. No boot-time warming/timers; caches ephemeral.
- Non-root image, no baked secrets; socket DNS/IP guard blocks private/reserved destinations. Public Supabase config rejects privileged keys.
- Existing free gateway retains defaults/security/cache exclusions. CI-only deploy gate allows exact staging branch/account, one basic instance; rejects DNS/cron/production targets.
- Existing full tests/check, ESLint, minified build verification passed locally; 16 gateway + 16 container tests and Worker-only Wrangler bundle pass.
- Local Windows lacks Docker. Laptop 192.168.0.169 unreachable from this PC network; user chose GitHub Linux runner.
- Linux run passed: https://github.com/JSolanoDev/AnimeTV/actions/runs/37887183140; Docker/native Sharp/neutral HLS-MP4/full dry-run plus real Worker -> DO -> container/cache/deep routes/cleanup. Baseline RSS 99 MiB, local cold health 616 ms and warm 5 ms; not hosted measurements.
- Branch cloudflare-validation/container-staging-2026-10-08 at d4b4801e843e94818c56855cd4ac3a1d6eb86ae1; remote main unchanged abd57fc7658d4c81214a879f44780693e1f1833f. Job contents:read, no Cloudflare secrets or publishing.
- Validation snapshot must include branch-only vercel.json git.deploymentEnabled=false; never merge that setting into production. Main and local checkout/index stay unchanged.
- Earlier free-staging neutral browser checks passed desktop/tablet/phone landscape; hosted HLS manifest/MP4 Range passed. Real decode/providers/OAuth/Cast not proven.
- Existing language-test sandbox fixed to account for v1005 flag. Normal build regenerated homepage-bootstrap.json; no manual catalog content edits.

## Next
- Real integration caught/fixed decoded catalog bodies carrying compressed headers; automatic response encoding restores gzip/cache correctness. Free path unchanged. No hosted container/provider/OAuth/Cast validation yet.
- New local staging workflow + deployment-policy module pass app tests/check/lint/build, 16 gateway + 17 container tests. Not pushed; remote main and validation branch unchanged.
- Token: Workers Scripts/Containers/Cloudchamber Edit, this account only, expires Oct 16. Old exposed value invalidated by confirmed Roll; replacement saved as CLOUDFLARE_STAGING_API_TOKEN, never logged or written locally. No broad auto-build token.
- $5 Workers base is not the full migration price: container RAM/disk/CPU/egress and DO usage are additional. Measure before promising <=$10.
- Publish exact cloudflare-staging/container-staging-2026-10-09 branch and verify Linux gates/deploy/hosted tests. Runtime secrets still pending; do not change production/DNS.
- Catalog snapshots are image-baked: add separately approved Cloudflare publishing to daily jobs before retiring Vercel; preserve current jobs meanwhile.
- Production configuration/rate limits/monitoring/spend alerts/media terms/rollback still needed; Vercel stays available until cutover approval.

## Gotchas
- Working tree deployments include WIP; preserve all preexisting edits. No package-lock.json or deploy-vercel.ps1 changes in this phase.
- Stop Wrangler dev before rebuilding watched assets on Windows. Never load dotenv secrets into staging automatically.
- Free frontend staging is not a completed backend migration; free CDN/Tunnel is not unlimited video hosting.
