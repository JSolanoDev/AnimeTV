# ZenkaiTV

![ZenkaiTV banner](docs/branding/zenkai-banner.png)

<p align="center">
  <strong>A modern, TV-first anime streaming hub for the Web and Android TV — powered by AniList metadata with smart multi-source playback.</strong>
</p>

<p align="center">
  <strong>🌐 <a href="https://zenkaitv.com">zenkaitv.com</a></strong>
</p>

<p align="center">
  <a href="https://zenkaitv.com">Live Site</a>
  ·
  <a href="docs/DEPLOY.md">Deployment</a>
  ·
  <a href="docs/ANDROID_TV.md">Android TV</a>
  ·
  <a href="docs/API.md">API</a>
  ·
  <a href="docs/TROUBLESHOOTING.md">Troubleshooting</a>
</p>

<p align="center">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-20%2B-3B82F6?style=for-the-badge&logo=node.js&logoColor=white">
  <img alt="AniList" src="https://img.shields.io/badge/Metadata-AniList-2563EB?style=for-the-badge&logo=anilist&logoColor=white">
  <img alt="Android TV" src="https://img.shields.io/badge/Android%20TV-ready-5C9BFF?style=for-the-badge&logo=androidtv&logoColor=white">
  <img alt="License" src="https://img.shields.io/badge/License-MIT-0D1B2A?style=for-the-badge">
</p>

---

## Overview

ZenkaiTV organises anime by **seasons and episodes using AniList as the source of truth**, then matches your configured video sources to the correct season. It's built remote-first for Android TV, runs as a fast static site on the web, and keeps a clean, ad-free playback experience by preferring the most reliable servers.

> ZenkaiTV stores no copyrighted video. Metadata comes from public APIs (AniList, Jikan); playback links are provided by the third-party sources you configure.

## Highlights

- **AniList-powered seasons** — franchise grouping via AniList relations (prequel/sequel chains), real episode counts, split-cour merging, and correct ordering for movies, OVAs, ONAs and specials.
- **Smart source selection** — servers are ranked so the most reliable, ad-free options play first: **AnimeAV1 (HLS) → Mega → MP4Upload**, with ad-walled hosts pushed to the bottom.
- **Multi-provider playback** — TioAnime and AnimeAV1 scrapers, AniPub catalog, plus optional AllAnime / JIMOV / Consumet / RapidAPI addons.
- **TV-first UI** — compact icon sidebar with an integrated push animation, remote-friendly focus states, cinema-mode player with prev/next episode navigation, and a polished settings console.
- **Weekly schedule & carousel** — Monday→Sunday airing-only schedule and a "most recently aired" featured carousel.
- **Personal & private** — favorites, watch history, resume positions, English→Spanish subtitle translation, light/dark theme. All data stays in your browser's `localStorage`; no accounts, analytics, or telemetry.
- **Cross-platform** — one codebase ships as a web app, an installable PWA, and an Android TV APK.

## Architecture

ZenkaiTV is two cooperating services:

| Service | Stack | Responsibility |
|---|---|---|
| **Web app** | Node 20 (zero runtime deps) | UI, AniList/Jikan metadata, AniPub, and a proxy to the scraper |
| **Scraper** | Python 3.12 + Flask | TioAnime & AnimeAV1 episode sources |

The browser only talks to the web app via relative `/api/*` calls, so it runs on any domain unchanged. The web app calls the scraper server-to-server through the `TIOANIME_API` environment variable.

```
Browser ──/api──► Web app (Node) ──TIOANIME_API──► Scraper (Python)
                       │
                       └──► AniList · Jikan · AniPub
```

## Quick start (local)

```bash
# 1. Web app
git clone https://github.com/JSolanoDev/ZenkaiTV.git
cd ZenkaiTV
cp .env.example .env.local        # set TIOANIME_API=http://localhost:5000
npm start                          # → http://localhost:4180

# 2. Scraper (separate terminal, Python project)
pip install -r requirements.txt
python app.py                      # → http://localhost:5000
```

No `npm install` is required — the web app has **zero runtime npm dependencies**.

On Windows, `./start-all.bat` can supervise the app and companion services and restart them after crashes.

## Deployment

See **[docs/DEPLOY.md](docs/DEPLOY.md)** for the full guide. In short:

1. **Scraper** → deploy the Python project (Render Blueprint / Railway / Fly). Copy its URL.
2. **Web app** → deploy this repo and set `TIOANIME_API` to the scraper URL.

The web app is live at **[https://zenkaitv.com](https://zenkaitv.com)** (front-end + serverless `/api`, hosted on Vercel). For the TioAnime/AnimeAV1 sources to work online, host the scraper separately and point `TIOANIME_API` at it — the Python scraper cannot run inside Vercel's serverless runtime.

| Variable | Required | Notes |
|---|---|---|
| `TIOANIME_API` | For scraper sources | URL of the deployed Python scraper. |
| `PORT` / `HOST` | Host-provided | Server binds `0.0.0.0:$PORT`. |
| `ANIME1V_AUTO_START` | Recommended `false` | Never spawn the local Anime1v addon on a host. |
| `CONSUMET_API`, `RAPIDAPI_*`, `JIMOV_API`, `LOG_LEVEL` | Optional | See `.env.example`; skipped gracefully if unset. |

Health check: `GET /api/health` → `{"ok":true,"app":"ZenkaiTV","api":"ready", ...}`.

## Android TV

The APK wraps the app in a WebView. It ships the bundled build (browse the full AniList/Jikan catalog offline) and exposes a one-line backend switch for full playback:

```java
// android/app/src/main/java/com/animetv/app/MainActivity.java
private static final String SITE_URL = "";   // set to your deployed site for full sources
```

Build the APK:

```bash
npm run android:build
# → android/app/build/outputs/apk/debug/app-debug.apk
```

## Sources & smart ordering

| Provider | Type | Notes |
|---|---|---|
| **AnimeAV1** | HLS / direct + embeds | Most reliable; **HLS is the #1 auto-selected source**. |
| **TioAnime** | Embeds (Mega, MP4Upload, …) | Mega / MP4Upload preferred; ad-walled hosts (VOE/Netu) sink. |
| **AniPub** | Resolver | Catalog + external playback when available. |
| AllAnime / JIMOV / Consumet / RapidAPI | Optional | Enabled per `.env.example`. |

The player auto-selects the best available server using the preference order above, so playback starts on a clean, ad-free source whenever one exists.

## Tech stack

- **Frontend** — vanilla JS (no framework), CSS with a cohesive motion layer, PWA + service worker.
- **Backend** — Node HTTP server (no dependencies), with serverless adapters for Vercel.
- **Metadata** — AniList GraphQL (franchise/season graph) + Jikan, cached 24h.
- **Scraper** — Python + Flask + Requests.
- **Android** — native WebView wrapper (Leanback launcher).

## Privacy & legal

ZenkaiTV is a personal media organiser and catalog browser. It does **not** host, store, or distribute copyrighted video. All streams come from third-party sources you configure, and you are responsible for ensuring your use complies with the law in your jurisdiction. All user data is stored locally — no accounts, no tracking. See the in-app **Settings → Legal** for the full Terms and Privacy notice.

## License

[MIT](LICENSE) — © ZenkaiTV contributors.

<p align="center"><sub>Metadata by <a href="https://anilist.co">AniList</a> &amp; <a href="https://jikan.moe">Jikan</a>. Built for the couch.</sub></p>
