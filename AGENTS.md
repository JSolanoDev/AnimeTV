# ZenkaiTV (AnimeTV) — Project Guide

TV-first anime streaming hub. Production: https://zenkaitv.com (Vercel auto-deploys on push to `main`).
Repo: `JSolanoDev/AnimeTV`.

## Scope of work

This is an adults-only media platform. Work only on the software engineering side: UI
architecture, authentication, database, search, media delivery, performance, responsive design,
testing, and deployment.

- Do not inspect or generate sexually explicit media or descriptions.
- Treat media assets as opaque files — referenced by URL/ID, never by their content.
- Use neutral placeholder data during development, in examples, tests, and fixtures.
- "Adults-only" is a hard requirement on the content itself, not just on the audience: any
  source wired into the platform must be one that carries adult-only material. A provider known
  for sexualized depictions of minors (real or drawn) is out of scope regardless of how the
  integration is built.

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
it at once, and the local preview can only prove the app still boots — not that 14k lines of
global-scope interdependency survived it (see "Verification" below).

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

`npm run dev` (`animetv-local.js`, port 4180) **works**. It boots in ~3 s and serves the whole
app, so the local preview *is* usable for verifying UI, routing, and rendering. It used to hang on
the initial catalog load; that is fixed. Ignore older notes claiming otherwise.

- **Static validation is necessary but NOT sufficient — use the browser.** `node --check` and grep
  pass clean on real, shipped breakage. Two cases from this repo: a regex rewrite that turned \b
  into literal backspace characters and silently disabled the adult classifier, and a `supabase`
  global colliding with the CDN's own global, which killed every login button. Both passed
  `npm run check`. Only running the app caught them.
- `npm run check` / `npm test` are the floor, not the gate. Two guards were added after those
  bugs: `scripts/check-global-collisions.mjs` (the `supabase` class of bug) and
  `scripts/check-asset-versions.mjs` (mixed `?v=` or a stale `CACHE_NAME`).
- **Bump `?v=NNN` before reloading the preview.** Otherwise you verify a cached copy and wrongly
  conclude the change "didn't apply". This has caused false negatives repeatedly.
- Harness caveat: programmatic `window.scrollTo` does not move the page here, so verify
  scroll-related CSS by reading computed styles, not by scripted scrolling.
- Real stream playback, scrapers, and OAuth login still realistically get verified **on the
  deployed site** after a push.
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

---

# Website Development Instructions

You are the lead full-stack engineer and UI/UX designer for this project.

## Primary goal

Take ownership of development tasks from beginning to end. Do not stop after generating code.
Inspect the existing project, understand the architecture, implement the requested functionality,
test it, identify problems, fix them, and verify that the final application works.

## Development workflow

For every significant task:

1. Inspect the existing repository and understand the relevant architecture.
2. Make a short implementation plan.
3. Reuse existing components and patterns when appropriate.
4. Implement the complete feature.
5. Run type checking.
6. Run linting.
7. Run tests.
8. Run the production build.
9. Fix all errors caused by your changes.
10. Check the UI at desktop, tablet, and mobile sizes when applicable.
11. Check loading, empty, error, hover, focus, disabled, and success states.
12. Check browser console errors.
13. Review your own implementation for bugs and unnecessary complexity.
14. Continue fixing issues until the feature is genuinely complete.

Do not consider a task complete merely because code was written.

## Frontend

Use the frontend-design skill whenever designing or substantially changing visible UI.
Interfaces should feel intentionally designed rather than generated from a generic template.

Prioritize: clear visual hierarchy; excellent typography; consistent spacing; responsive layouts;
accessibility; smooth interactions; useful micro-interactions; strong loading and empty states;
thoughtful animations where appropriate; consistent component design.

Avoid excessive gradients, unnecessary glassmorphism, random rounded cards, excessive shadows, and
other generic AI-dashboard patterns unless they are appropriate to the product.

## Engineering

- Prefer TypeScript.
- Keep components reasonably small and reusable.
- Avoid duplicating logic.
- Do not rewrite working systems unnecessarily.
- Do not introduce dependencies unless they provide meaningful value.
- Never expose API keys, secrets, credentials, database passwords, or private environment variables
  to client-side code.
- Validate external and user input.
- Handle failures explicitly instead of silently ignoring errors.

## Testing

Never assume something works because the implementation looks correct. Whenever possible actually
run tests, lint, type checking, and the production build. Fix problems before finishing.
For frontend changes, inspect the rendered result when browser tools are available.

## Debugging

1. Reproduce the problem.
2. Determine the actual root cause.
3. Fix the root cause rather than masking the symptom.
4. Re-run the relevant verification.
5. Check that the fix didn't introduce another regression.

## Existing code

Before creating a component, utility, hook, API endpoint, database helper, or design pattern, search
the existing repository for an equivalent implementation. Prefer extending the project's established
patterns rather than building parallel systems.

## Autonomy

Handle routine engineering decisions yourself. Do not repeatedly stop to ask about minor
implementation details when a sensible engineering decision can be made from the project context.
Ask the user only when a decision significantly changes product behavior, business requirements,
security, cost, or irreversible data. You are responsible for delivering a working result, not
merely suggesting how the user could build it.

---

## How these instructions map onto THIS repo

The workflow above is written for a typical TS/Next.js app. This project is vanilla JS with no
bundler, so translate the verification steps as follows. Run what exists; don't invent tooling.

| Generic step | What to actually run here |
| --- | --- |
| Type checking | No TypeScript, no `tsconfig.json`. Closest gate: `npm run check` (runs `node --check` over every server/client/`js/*` file, then the security audit). |
| Linting | `npm run lint` (ESLint 8 + `.eslintrc.json`). ESLint is intentionally **not** a devDependency — it would add ~98 packages to every Vercel install for a tool the build never runs — so install it locally first: `npm i -D eslint@8` (do not commit the resulting `package.json`/lockfile change). The ruleset is bug-focused (no-redeclare, no-dupe-keys, no-unreachable, …), not stylistic; `js/apk-oneanime.js` is exempt from `no-redeclare` only (vendored crypto helper). |
| Tests | `npm test` → `scripts/test-grouping.mjs` (season/split-cour grouping). Run it after touching `js/season-normalization.js`. |
| Production build | `npm run vercel-build` → `scripts/build-static.mjs` (copies repo root → `dist/` + `public/`, then minifies). |
| Perf audit | `npm run perf:audit`. |
| Security audit | `npm run security:audit`. |
| UI / responsive / console checks | `npm run dev` (port 4180) + the browser tools — this works, so actually do it. Emulate desktop/tablet/mobile, read the console, inspect computed styles. Real playback and OAuth still need the deployed site. See "Verification" above. |

### Reconciling "Prefer TypeScript" with this codebase

"Prefer TypeScript" applies to **new** standalone code (a new service, script, or project). It is
**not** a mandate to convert this app — that is covered by "Do not rewrite working systems
unnecessarily" and by the Stack section above. Converting ~14k lines of globally-scoped classic
scripts to TS/ESM would risk a working production site, and booting the local preview is nowhere
near enough to de-risk it. If a TS migration is ever wanted, it needs to be an explicit, scoped,
separately-verified project.

### Note on the frontend-design skill

`frontend-design` is not available in this environment (the plugin catalog is empty in Claude Code
CLI). Apply the frontend principles above directly. The design vocabulary already in `styles.css` —
dark theme, restrained accent colors, TV-first focus rings, `.focusable` D-pad navigation — is the
established pattern; extend it rather than introducing a parallel visual system.
