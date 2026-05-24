# Security Policy

## Supported Versions

The current `main` branch is supported.

## Reporting a Vulnerability

Please open a private security advisory or contact the maintainer through GitHub.

## Playback Safety

AnimeTV separates direct video streams from iframe embeds. Direct `.mp4` and `.m3u8` streams can enter the main video player. Iframe sources stay in the embedded iframe player and should not be treated as direct video URLs.
