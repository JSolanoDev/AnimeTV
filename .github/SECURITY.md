# Security Policy

## Supported Versions

The current `main` branch is supported.

## Reporting a Vulnerability

Please open a private security advisory or contact the maintainer through GitHub.

## Playback Safety

AnimeTV separates direct video streams from iframe embeds. Direct `.mp4` and `.m3u8` streams can enter the main video player. Iframe sources stay in the embedded iframe player and should not be treated as direct video URLs.

## Secret Hygiene

Never commit `.env`, `.env.local`, API keys, GitHub tokens, RapidAPI keys, or provider passwords. Keep real credentials in local environment files or deployment environment variables only.

Run this before committing:

```bash
npm run security:audit
```

If a real key was ever shared in a zip, chat, screenshot, or repository history, rotate it in the provider dashboard immediately. Removing the file from the repo does not make the old key safe again.

## Runtime Protection

The server includes process-level error logging, API rate limiting, `/api/health`, and a small persistent server cache under `.cache/server`. The cache folder is ignored and can be deleted safely if you need a cold refresh.
