# Contributing to AnimeTV

Thanks for helping improve AnimeTV.

## Local Setup

1. Install Node.js 18 or newer.
2. Start AnimeTV with `start-all.bat` on Windows or `node animetv-local.js`.
3. Optional: run Anime1v at `http://localhost:3001` for Japanese audio and Spanish subtitle sources.

## Pull Requests

- Keep UI changes consistent with the TV layout.
- Run `npm run check` before opening a PR.
- Do not remove upstream project credits from third-party integrations.
- Keep iframe embeds isolated from the direct `<video>` player path.

## Source Safety

AnimeTV supports user-provided and local sources. Only connect sources and video URLs you are allowed to access.
