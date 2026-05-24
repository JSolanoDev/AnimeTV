# AnimeTV

Modern anime TV web app and Android TV wrapper with multi-source catalogs, embedded playback, Japanese audio preference, and Spanish subtitle preference.

## Features

- TV-first interface with remote-friendly focus states and compact sidebar navigation.
- Multi-source catalogs: AniList/Jikan metadata, AniPub iframe catalog, JIMOV/TioAnime, Anime1v proxy, and custom local addons.
- Embedded playback for direct video files and safe iframe embeds.
- Source chooser for playable episodes when multiple servers are available.
- Favorites, watch history, resume positions, settings, light/dark theme, language preferences, and daily API refresh.
- Android TV WebView wrapper with bundled assets and debug APK build.
- Supervised Windows launcher that starts AnimeTV, tries to start Anime1v, checks health, and restarts crashed services.

## Quick Start

```powershell
npm start
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173).

For Android TV on the same network, use the computer LAN IP instead of `127.0.0.1`, for example:

```text
http://192.168.1.25:4173
```

## Start All Servers On Windows

Use the supervised launcher:

```powershell
.\start-all.bat
```

It starts AnimeTV, starts Anime1v if found at `C:\anime1v-api` or a nearby `anime1v-api` folder, monitors both services, restarts them after crashes, and opens AnimeTV.

Useful options:

```powershell
.\start-all.bat -NoBrowser
.\start-all.bat -Anime1vPath "C:\anime1v-api"
```

## Build Android APK

```powershell
cd android
.\gradlew.bat assembleDebug
```

APK output:

```text
android\app\build\outputs\apk\debug\app-debug.apk
```

## Sources

| Source | Playback | Notes |
| --- | --- | --- |
| AniList + Jikan | Metadata only | High quality titles, images, scores, descriptions, and schedules. |
| AniPub | Iframe embeds | Iframe URLs stay in the embedded iframe player and never enter the `<video>` element. |
| JIMOV/TioAnime | Spanish subtitle source | Used as a Spanish-friendly addon source when available. |
| Anime1v | Direct video when quota allows | Local API at `http://localhost:3001`; AnimeTV pauses it automatically if the daily quota is reached. |
| Custom sources | Direct video or iframe | Add JSON sources through `sources.json` or the Sources screen. |

## Safe Playback Rules

AnimeTV only sends direct `.mp4`, `.m3u8`, `videoUrl`, `streamUrl`, or `file` values to the main `<video>` player.

Iframe embeds are treated separately:

- Server returns `externalUrl` + `externalType: "iframe"`.
- Client detects iframe episodes before direct playback.
- Iframe embeds render inside the AnimeTV embedded iframe container.
- Direct video and iframe playback paths stay separate.

## Language Preferences

Default playback preference:

- Audio: Japanese
- Subtitles: Spanish

For direct text subtitle tracks, AnimeTV can translate an English subtitle track into Spanish in the browser when the translated Spanish option is selected. Cross-origin iframe subtitles cannot be rewritten directly, so iframe players receive best-effort language hints and keep their native controls.

## API

Core endpoints:

```text
GET /api/health
GET /api/catalog
GET /api/anipub/catalog/all?limit=12000
GET /api/anipub/episodes/:id
GET /api/anime1v/health
GET /api/anime1v/trending
GET /api/anime1v/search?q=naruto
GET /api/jimov/tioanime/catalog
GET /api/refresh-daily?background=1
```

More details are in [docs/API.md](docs/API.md).

## Repository Setup

This folder is ready to publish as:

```text
https://github.com/JSolanoDev/AnimeTV
```

Create the empty GitHub repository first, then from this folder run:

```powershell
git init
git add .
git commit -m "Initial AnimeTV release"
git branch -M main
git remote add origin https://github.com/JSolanoDev/AnimeTV.git
git push -u origin main
```

## License

MIT. See [LICENSE](LICENSE).
