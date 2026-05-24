# Sources

AnimeTV supports:

- Metadata sources for images, titles, schedules, scores, and descriptions.
- Direct video sources for `.mp4` and `.m3u8`.
- Iframe sources for embeds that must stay isolated from the main video element.

Add custom sources in `sources.json` or through the Sources screen.

Direct episode example:

```json
{
  "title": "My Anime",
  "seasons": [
    {
      "season": 1,
      "episodes": [
        { "episode": 1, "videoUrl": "http://server/video/s01e01.mp4" }
      ]
    }
  ]
}
```
