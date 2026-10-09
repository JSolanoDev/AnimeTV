# Handoff (Claude <-> ChatGPT/Codex)

Read this first; update before stopping. Keep under ~40 lines. Rules: AGENTS.md.

## Last tool / date
- Codex, 2026-10-08: preparing Cloudflare-only Containers; user authorized a GitHub Linux validation runner, not paid activation or production cutover.

## Live state
- Production zenkaitv.com remains on Vercel, app v1005. DNS, Supabase, paid plans and daily updater unchanged.
- Free staging: https://zenkaitv-staging.juankisantiago.workers.dev; version 9d3e69cb-81cc-4fdd-bf80-843b5ab6c9b9. Static frontend on Cloudflare, API/media still Vercel.
- Account 82846f471a6cc2b416851facadcd324b; existing OAuth only account/user read + Worker scripts. No credentials committed.

## Prepared
- Separate wrangler.container-staging.json, Worker/DO controller, Linux Node image, sanitized 25-file context, local build/smoke/dry-run commands and verification-only GitHub workflow.
- No framework rewrite or dependency-version changes. New backend hosted flag is opt-in and mirrored to Android; existing defaults preserved.
- Container path streams media same-origin, preserves HLS/Range/HEAD, has shared bounded startup, request cancellation and no upstream retries.
- One staging basic container, five-minute idle sleep; not a production sizing guarantee. No boot-time warming/timers; caches ephemeral.
- Non-root image, no baked secrets; socket DNS/IP guard blocks private/reserved destinations. Public Supabase config rejects privileged keys.
- Existing free gateway retains defaults/security/cache exclusions. Container CLI rejects hosted deploy commands until explicit paid-service approval.
- Existing full tests/check, ESLint, minified build verification passed locally; 16 gateway + 16 container tests and Worker-only Wrangler bundle pass.
- Local Windows lacks Docker. Laptop 192.168.0.169 unreachable from this PC network; user chose GitHub Linux runner.
- GitHub job runs only manual or cloudflare-validation/** pushes, contents:read, no Cloudflare secrets/publishing. Linux Docker/native Sharp/neutral media/full dry-run still pending.
- Validation snapshot must include branch-only vercel.json git.deploymentEnabled=false; never merge that setting into production. Main and local checkout/index stay unchanged.
- Earlier free-staging neutral browser checks passed desktop/tablet/phone landscape; hosted HLS manifest/MP4 Range passed. Real decode/providers/OAuth/Cast not proven.
- Existing language-test sandbox fixed to account for v1005 flag. Normal build regenerated homepage-bootstrap.json; no manual catalog content edits.

## Next
- Finish isolated GitHub Docker validation and record run URL/result. Do not claim Linux or Cloudflare-hosted validation prematurely.
- Follow docs/cloudflare-migration.md. Ask before Workers Paid, broader OAuth, container staging publication, or DNS/cutover.
- $5 Workers base is not the full migration price: container RAM/disk/CPU/egress and DO usage are additional. Measure before promising <=$10.
- After payment approval: securely transfer necessary secrets, publish isolated backend staging, verify live providers/HLS/seeking/OAuth/Cast/orientation/restarts/latency/capacity.
- Catalog snapshots are image-baked: add separately approved Cloudflare publishing to daily jobs before retiring Vercel; preserve current jobs meanwhile.
- Production configuration/rate limits/monitoring/spend alerts/media terms/rollback still needed; Vercel stays available until cutover approval.

## Gotchas
- Working tree deployments include WIP; preserve all preexisting edits. No package-lock.json or deploy-vercel.ps1 changes in this phase.
- Stop Wrangler dev before rebuilding watched assets on Windows. Never load dotenv secrets into staging automatically.
- Free frontend staging is not a completed backend migration; free CDN/Tunnel is not unlimited video hosting.
