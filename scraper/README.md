# AnimeTV Metadata Scraper

Scrapes anime metadata **and episode stream URLs** from three Spanish-language
sites using [Scrapling](https://github.com/D4Vinci/Scrapling) for stealth
fetching and resilient adaptive selectors.

| Site | Type | Metadata items |
|------|------|----------------|
| tioanime.com | Catalog + recent episodes | ≤ 500 |
| www4.animeflv.net | Catalog + recent episodes | ≤ 500 |
| jkanime.net | Catalog + recent episodes | ≤ 500 |

---

## 1. Install

```bash
# Python 3.11+
pip install -r requirements.txt

# Download Camoufox stealth browser binaries (~200 MB, one-time)
scrapling install
```

---

## 2. Run

### Metadata only (fast — default)

Collects title, image, synopsis, genre. Does **not** visit individual episode
pages.

```bash
python scraper/anime_scraper.py
```

### With episode stream URLs (slow, optional)

Visits each show's detail page to build the episode list, then visits each
episode page and extracts the playable video URL or iframe embed URL.

```bash
# Default: top 20 shows per site × 5 most-recent episodes each
python scraper/anime_scraper.py --episodes

# More shows, deeper episode history
python scraper/anime_scraper.py --episodes --top 50 --max-eps 12

# Fewer shows, faster run
python scraper/anime_scraper.py --episodes --top 10 --max-eps 3
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--episodes` | off | Enable episode page scraping |
| `--top N` | 20 | Shows per site to scrape (sorted by episode count desc) |
| `--max-eps N` | 5 | Most-recent episodes to fetch per show |
| `--ep-workers N` | 3 | Concurrent episode page fetches (across all sites) |

### Other options

```bash
# Only specific sites
python scraper/anime_scraper.py --sites tioanime jkanime

# Keep running, re-scrape every 6 hours
python scraper/anime_scraper.py --schedule 6 --episodes

# Custom output path
python scraper/anime_scraper.py --output /data/anime.json
```

---

## 3. Episode disk cache

Episode URLs are cached in `scraper/.episode_cache/` (one JSON file per show,
keyed by URL hash). Cache TTL is **24 hours**. Subsequent runs skip unchanged
shows, making the second run much faster.

```
scraper/
├── .episode_cache/
│   ├── a1b2c3d4…json   ← tioanime.com/anime/solo-leveling episodes
│   └── …
```

---

## 4. How video URL extraction works

`VideoExtractor` tries five strategies in order on each episode page's HTML:

| # | Strategy | Pattern |
|---|----------|---------|
| 1 | TioAnime-style JS array | `var videos = [["SW","https://…"], …]` |
| 2 | AnimeFLV-style JS dict | `var videos = {"SUB":[["SW","url"]],"LAT":[]}` |
| 3 | Any non-ad `<iframe src>` | skips google/disqus/doubleclick |
| 4 | `<video src>` / `<source src>` | `.mp4` / `.m3u8` only |
| 5 | Bare `.m3u8` / `.mp4` URL | anywhere in the page HTML |

Direct `.m3u8` / `.mp4` links are stored in `videoUrl`.
All other embed URLs are stored in `externalUrl` + `externalType: "iframe"`.

---

## 5. How adaptive selectors work

**First run** — `auto_save=True`:
```
Scrapling fingerprints each matched element (DOM depth, sibling count,
text density, attribute patterns) and saves to a local SQLite cache.
```

**After a site redesign** — switch to `auto_match=True`:
```python
# Change this line in anime_scraper.py when a site's CSS class names change:
cards = page.css("ul.episodes-list li", auto_save=True)
# → becomes:
cards = page.css("ul.episodes-list li", auto_match=True)
```
Scrapling uses the saved fingerprints to relocate elements without updating
selectors.

---

## 6. Output format

`anime_metadata.json` is directly consumed by AnimeTV's `/api/scraped-catalog`
route (already wired in `animetv-server.js`):

```json
{
  "ok": true,
  "source": "Scrapling Multi-Site",
  "scrapedAt": "2026-05-27T12:00:00.000Z",
  "totalResults": 847,
  "items": [
    {
      "id": "scraped-0",
      "title": "Solo Leveling",
      "image": "https://tioanime.com/uploads/posters/solo-leveling.webp",
      "siteUrl": "https://tioanime.com/anime/solo-leveling",
      "description": "En un mundo donde los cazadores…",
      "episode": 12,
      "genre": "action",
      "genres": ["Acción", "Fantasía"],
      "source": "TioAnime",
      "videoUrl": "https://…/ep1.m3u8",
      "episodes": [
        {
          "episode": 11,
          "title": "Episodio 11",
          "siteUrl": "https://tioanime.com/ver/solo-leveling-11",
          "videoUrl": "https://…/ep11.m3u8",
          "externalUrl": "",
          "externalType": "",
          "server": "TioAnime"
        },
        {
          "episode": 12,
          "title": "Episodio 12",
          "siteUrl": "https://tioanime.com/ver/solo-leveling-12",
          "videoUrl": "",
          "externalUrl": "https://some-embed.com/player?id=abc",
          "externalType": "iframe",
          "server": "TioAnime"
        }
      ]
    }
  ]
}
```

When `--episodes` is **not** used, `episodes` is an empty array and `videoUrl`
is `""`. AnimeTV will then fall back to its AniPub / AllAnime / JIMOV sources
to find a stream.

---

## 7. AnimeTV integration

### Option A — File (already wired)

`animetv-server.js` serves the JSON file at `/api/scraped-catalog`.
After running the scraper, hit the AnimeTV refresh endpoint:

```bash
curl http://localhost:4173/api/refresh-daily
```

Or restart AnimeTV (`npm start`).

### Option B — Call from Node.js

```javascript
const { runScraper } = require('./scraper/integration');

const catalog = await runScraper({ sites: ['tioanime', 'jkanime'] });
console.log(`${catalog.totalResults} items loaded`);
```

### Option C — Scheduled via `node-cron` (add to animetv-server.js)

```javascript
const cron = require("node-cron");
const { runScraper } = require("./scraper/integration");

cron.schedule("0 */6 * * *", async () => {
  console.log("[cron] Running anime scraper…");
  try {
    const catalog = await runScraper();
    console.log(`[cron] Scraped ${catalog.totalResults} items`);
  } catch (err) {
    console.error("[cron] Scraper failed:", err.message);
  }
});
```

### Option D — OS-level cron (recommended for production)

**Linux / macOS** (`crontab -e`):
```
0 */6 * * *  cd /path/to/AnimeTV && python scraper/anime_scraper.py --episodes >> logs/scraper.log 2>&1
```

**Windows Task Scheduler** (or `start-all.bat`):
```bat
python "%~dp0scraper\anime_scraper.py" --schedule 6 --episodes
```

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ModuleNotFoundError: scrapling` | Not installed | `pip install -r requirements.txt` |
| `CamoufoxNotFoundError` | Browser not installed | `scrapling install` |
| All selectors return empty | Site redesigned | Switch `auto_save=True` → `auto_match=True` and re-run |
| `TimeoutError` on a site | Site blocked or slow | Increase `PAGE_TIMEOUT_MS` or use `--sites` to skip it |
| JSON output is empty `{}` | Python 3.9 syntax error | Upgrade to Python 3.11+ |
| `episodes` arrays empty | `--episodes` flag not passed | Add `--episodes` to the command |
| Episode URLs all `""` | Site uses obfuscated JS | Open episode page manually, inspect Network tab for the stream URL; update `VideoExtractor` regex |

---

## 9. Selector maintenance

When a site changes its CSS class names, update the primary selector and log
which one worked:

```python
cards = page.css("ul.episodes-list li", auto_save=True)   # primary
if not cards:
    cards = page.css(".episodes-container li")             # fallback
    log.warning("[TioAnime] Primary selector empty — update it")
```

Use `scrapling extract fetch 'https://tioanime.com/' test.md` from the
terminal to inspect the live HTML without writing code.
