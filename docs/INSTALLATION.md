# Installation

## Requirements

- Node.js 18 or newer
- Windows PowerShell for the provided launcher
- Android Studio or Gradle wrapper for APK builds

## AnimeTV

```powershell
npm start
```

## Anime1v Optional API

Clone Anime1v separately and run it on port `3001`. AnimeTV auto-detects it through `start-all.bat`.

```powershell
cd C:\anime1v-api
npm install
npm run dev
```

If Anime1v reaches its daily request quota, AnimeTV pauses that source and keeps the rest of the app working.
