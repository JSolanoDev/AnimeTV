# Development Workflow for AnimeTV Project

## Project Stack
This is a vanilla JavaScript application with no build step:
- `client.js` - Main SPA (~14k lines) with global scope, no modules
- `js/*.js` - Helper scripts loaded as classic `<script defer>` tags in `index.html`
- `animetv-server.js` - Node HTTP server + all `/api/*` routes
- `player/` - Video player iframe (ArtPlayer + hls.js from jsdelivr)
- `styles.css` - Single stylesheet
- `scripts/build-static.mjs` - Copies source files to `dist/` and `public/`, then minifies

## Important Directories
- `app/` - Next.js application routes (authentication, profile pages)
- `components/` - React components for UI elements  
- `lib/supabase/` - Supabase client/server libraries for authentication
- `api/` - Next.js API routes
- `js/` - JavaScript utilities for source handling, metadata, etc.
- `scraper/` - Anime data scraping scripts and catalog files
- `android/app/src/main/assets/` - Android app assets (copied from repo root)
- `docs/` - Documentation including installation, deployment, and API guides

## Important Entry Points
- `index.html` - Main web application entry point
- `animetv-server.js` - Main server implementation
- `client.js` - Client-side JavaScript logic
- `animetv-local.js` - Local development server
- `middleware.ts` - Next.js middleware for routing and authentication

## Build/Test/Lint Commands
- Install: `npm install` (already configured with package.json)
- Development: `npm run dev` or `npm start` (runs animetv-local.js on port 4180)
- Build: `npm run vercel-build` (uses scripts/build-static.mjs)
- Test: `npm run test` (runs scripts/test-grouping.mjs)
- Lint: `npm run lint` (uses ESLint with .eslintrc.json)
- Check: `npm run check` (comprehensive validation including node --check on all JS files)
- Security Audit: `npm run security:audit`
- Performance Audit: `npm run perf:audit`

## Architecture Notes
- All JavaScript files share one global namespace
- Load order in `index.html` matters for `js/*.js` helpers
- The Android WebView mirrors every file from repo root to android/app/src/main/assets/
- Cache-busting is manual with `?v=NNN` parameters that must be kept in sync
- Supabase keys served to browser must be anon/publishable key, never service_role

## Implementation Guidelines
1. **Search repository first** - Before modifying behavior, search for existing implementations
2. **Verify changes** - After implementation, run `npm run check` and test in browser
3. **Diagnose root causes** - Fix the actual problem rather than applying random patches
4. **Maintain global scope compatibility** - All code must work within shared global namespace
5. **Keep asset versions synchronized** - Update all `?v=NNN` parameters when changing assets
6. **Sync Android assets** - When modifying files in repo root, also update android/app/src/main/assets/