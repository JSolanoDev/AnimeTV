# Deployment

## Recommended: Vercel

ZenkaiTV is a static application plus one catch-all Node Function. The repository already contains:

- `vercel.json` with SPA rewrites, security headers, and CDN cache policies
- `api/[...path].js` as the serverless adapter
- `scripts/build-static.mjs` as the production build
- `dist/` as the configured output directory

### Deploy from GitHub

1. Import `JSolanoDev/AnimeTV` into Vercel.
2. Keep the framework preset as **Other**.
3. Use `npm run vercel-build` as the build command.
4. Use `dist` as the output directory.
5. Add only the optional environment variables the deployment needs.
6. Deploy. Future pushes to `main` can deploy automatically through the Git integration.

The live production site is <https://zenkaitv.com>.

### Environment variables

The bundled catalog and base UI do not require a private key. Common optional settings are:

| Variable | Purpose |
| --- | --- |
| `TMDB_API_KEY` or `TMDB_READ_ACCESS_TOKEN` | TMDB artwork and episode stills |
| `SUPABASE_URL` and `SUPABASE_KEY` | Public Supabase authentication configuration |
| `TIOANIME_API` | Hosted TioAnime/AnimeAV1-compatible bridge |
| `ANIME1V_API` and `ANIME1V_API_KEY` | Optional Anime1v provider |
| `CONSUMET_API` | Optional self-hosted Consumet provider |
| `RAPIDAPI_ANIME_HOST` and `RAPIDAPI_ANIME_KEY` | Optional RapidAPI provider |
| `API_PERF_DEBUG` | Local API timing logs; keep disabled in production |

See `.env.example` for the full list and accepted Supabase aliases. Do not put private service-role credentials in browser-readable variables.

## CDN and Function behavior

Shared metadata uses Vercel edge caching where it is safe. In particular, `/api/catalog` is public, cached, and served with stale-while-revalidate so repeated users do not each rebuild the same catalog. AniList, Jikan, TMDB, image, and provider-index routes have route-appropriate cache policies and in-flight request coalescing.

Playback URLs, media relays, resolver calls, mutations, and user-specific data are not broadly shared-cached because they can be short-lived or request-dependent.

Do not increase Function memory or duration to hide slow upstream work. Check caching, duplicate callers, response size, and provider health first. The current route audit is in [vercel-function-audit.md](vercel-function-audit.md).

## Verification

Before pushing:

```bash
npm run check
npm test
npm run vercel-build
```

After deployment:

```bash
curl -I https://zenkaitv.com/
curl -I https://zenkaitv.com/api/catalog
curl https://zenkaitv.com/api/health
```

Verify the homepage, search, title details, seasons, episode selection, playback, Cast controls, schedule, favorites, adult-mode isolation, and a mobile viewport. A warm `/api/catalog` request should report an edge cache hit in Vercel response headers.

## Self-hosting

Run the Node server directly or use the included `Dockerfile`:

```bash
npm install
npm start
```

The server binds to `0.0.0.0` and uses `PORT` when supplied, otherwise port `4173`. Put a reverse proxy with HTTPS in front of it for public use. Optional provider bridges may run as separate services and be configured through `.env.local`.

## Android clients

The Android variants currently point at `https://zenkaitv.com` from `MainActivity.java`, keeping mobile and TV clients on the same deployed application and API behavior. Build both with:

```powershell
npm run android:build
```

See [ANDROID_TV.md](ANDROID_TV.md) for output paths and ADB installation.
