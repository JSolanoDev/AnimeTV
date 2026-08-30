# ZenkaiTV (AnimeTV) — Project Guide

TV-first anime streaming hub. Production: https://zenkaitv.com (Vercel auto-deploys on push to `main`).
Repo: `JSolanoDev/AnimeTV`.

## Stack — read this before proposing changes

This is a **vanilla-JavaScript app**, deliberately. There is no build step for the app code.

- `client.js` — the whole SPA (~14k lines). Classic script, **global scope**, no modules.
- `js/*.js` — helpers loaded as separate classic `<script defer>` tags (`constants`, `utils`,
  `normalize`, `season-normalization`, `image-resolver`, `adult-mode`, `router`, …).
  They share one global namespace with `client.js`; load order in `index.html` matters.
- `animetv-server.js` — Node HTTP server + all `/api/*` routes. On Vercel it runs as a
  serverless function via `api/[...path].js`.
- `player/` — the video player iframe (ArtPlayer + hls.js from jsdelivr).
- `styles.css` — single stylesheet.
- `scripts/build-static.mjs` — copies `sourceDir = "."` → `dist/` + `public/`, then minifies.

**Do NOT migrate to ESM / Vite / Next.js / TypeScript / Tailwind / shadcn without an explicit,
scoped decision.** Blockers: everything shares global scope, inline HTML attributes call globals
(e.g. `onerror="handleWatchPosterError(this)"`), the service worker hardcodes asset URLs, the
Android WebView mirrors every file, and cache-busting is manual `?v=NNN`. A rewrite touches all of
it at once and cannot be verified locally (see "Verification" below).

## Non-negotiables

1. **Never commit `package-lock.json` or `deploy-vercel.ps1`.** If a rebase drags them in:
   `git stash push deploy-vercel.ps1 package-lock.json` → rebase → `git stash pop`.
2. **Bump the cache version on every asset change.** In `index.html` bump *every* `?v=NNN`
   (including `js/*.js` — forgetting these serves a stale helper against fresh `client.js` and
   throws `ReferenceError`), and bump `CACHE_NAME` in `service-worker.js`. Keep them in sync.
3. **Keep `android/app/src/main/assets/` in sync with the repo root.** These copies sometimes carry
   their own edits — diff before overwriting; prefer applying the same targeted edit to both.
4. **Deploys upload the working tree**, not just committed files. Uncommitted WIP can leak to
   production. Check `git status` before deploying.
5. **Supabase keys served to the browser must be the anon/publishable key — never `service_role`.**

## Conventions

- Line endings are **CRLF**. Scripted patches must match `\r\n` or they silently fail.
- Files are large; prefer targeted string replacement over rewriting a whole file.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Validate before committing: `node --check client.js` (and any edited `js/*.js`), plus a
  brace-balance check on `styles.css`. `npm run check` runs the project's own gate.

## Verification — important

`npm run dev` (`animetv-local.js`, port 4180) **hangs during the initial catalog load**, so the
local preview usually cannot be used to verify UI or playback. Consequences:

- Static validation (`node --check`, grep, brace balance) is the reliable local gate.
- Playback, scrapers, and login realistically get verified **on the deployed site** after a push.
- Don't claim playback works without evidence; say what was and wasn't verified.
- If port 4180 is stuck: find the orphaned `node animetv-local.js` and `Stop-Process -Id <PID> -Force`.

## Architecture notes

- **Routing** — hash/path SPA routing via `setRoute()` + `VALID_ROUTES`; `#anime/<id>` deep links
  open a show directly (cards are real `<a>` tags so right-click → "Open in new tab" works).
- **Rendering** — `render()` is called very frequently during catalog enrichment. Anything it calls
  must be cheap or memoized. Existing guards: `renderCards` card signature, `renderSchedule`
  `schedSig` + a 500 ms memo on the airing-show computation, and an O(1) `refreshFocusables`.
  Adding unmemoized whole-catalog work to `render()` will make routes feel laggy.
- **Caching** — `RESPONSE_CACHE_TTL` (5 min) is for short-lived lookups; `CATALOG_CACHE_TTL` (6 h)
  is for catalog snapshots, which refresh in the background. The service worker keeps remote artwork
  in a **separate, unversioned** cache (`zenkaitv-images-v1`) so deploys don't wipe every poster.
- **Metadata warming** — `warmVisibleShowMetadata` retries failed shows with backoff and gives up
  after 3 failures. Never reset that guard unconditionally: external APIs return 429/502 constantly,
  and an unbounded retry re-requests on every render.
- **Sources** — pluggable providers (AllAnime, AnimeAV1, TioAnime, AniPub, Jimov, …) resolved per
  episode; the player fails over to the next server automatically and shows a full-screen error with
  "Try another source" only when every server has failed.
- **Env** — `TIOANIME_API` defaults to `http://localhost:5000` (a separate Python service); in
  production it must point at a hosted scraper or those sources 404.

## Known-tricky areas

- **Season grouping** (`js/season-normalization.js`) — split-cour handling is subtle; there are
  tests at `npm test` (`scripts/test-grouping.mjs`). Run them after touching it.
- **Episode thumbnails** come from TMDB only; repeated images mean TMDB stills didn't resolve.
- **Player iframe** — must stay same-origin-friendly (`X-Frame-Options: SAMEORIGIN`), and URLs are
  resolved against `location.origin`, not relative paths.
