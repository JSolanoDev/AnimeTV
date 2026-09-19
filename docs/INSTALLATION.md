# Installation

## Requirements

- Node.js 20.9 or newer
- npm
- Git
- Optional for APK builds: Android SDK, ADB, and a compatible JDK

## Local web application

```bash
git clone https://github.com/JSolanoDev/AnimeTV.git
cd AnimeTV
npm install
cp .env.example .env.local
npm run dev
```

Open <http://localhost:4173>.

On Windows PowerShell, create the local environment file with:

```powershell
Copy-Item .env.example .env.local
```

The application starts with its bundled catalog. Optional metadata keys and provider bridges can be added to `.env.local`; unavailable optional services are skipped rather than preventing startup.

## Useful environment variables

| Variable | Purpose |
| --- | --- |
| `TMDB_API_KEY` or `TMDB_READ_ACCESS_TOKEN` | Higher-quality backdrops, posters, and episode stills |
| `SUPABASE_URL` and `SUPABASE_KEY` | Optional public Supabase authentication configuration |
| `TIOANIME_API` | Optional hosted TioAnime/AnimeAV1-compatible bridge |
| `ANIME1V_API` | Optional Anime1v-compatible provider |
| `CONSUMET_API` | Optional self-hosted Consumet provider |

Use only the public Supabase anon/publishable key in browser configuration. Never expose a `service_role` key.

## Verify the installation

```bash
npm run check
npm test
npm run vercel-build
```

The production build is written to `dist/`.

## Android phone, tablet, and TV

```powershell
npm run android:build
```

This produces:

- `android/app/build/outputs/apk/mobile/debug/app-mobile-debug.apk`
- `android/app/build/outputs/apk/tv/debug/app-tv-debug.apk`

See [ANDROID_TV.md](ANDROID_TV.md) for installation commands and device-specific checks.

## Optional provider services

Provider bridges are not required to render the catalog, search, metadata, schedules, or local library. When enabling one, run it on a public HTTPS endpoint for hosted deployments and set the matching variable from `.env.example`. ZenkaiTV keeps the remaining provider ladder available if one service reaches a quota or becomes unavailable.
