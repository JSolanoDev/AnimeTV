# AnimeTV Scraper

Fully online daily scraper — **no local machine required for production.**

Metadata comes from the free [Jikan API](https://jikan.moe/) (MyAnimeList wrapper).
Episode URLs are enriched from AnimeFLV, TioAnime, and JKAnime via simple HTTP requests.
Everything runs automatically in GitHub Actions every day.

---

## Architecture

### Phase 1 — Jikan API (always runs, always works from CI)

Fetches from two endpoints (no auth, no browser, no rate-limit issues):

| Endpoint | Content |
|---|---|
| `/seasons/now` | Current-season anime |
| `/top/anime?filter=airing` | Top-rated currently airing |

Every anime item includes: title, alternative titles, synopsis, poster, banner,
genres, type (TV/Movie/OVA/Special), status, year, season, aired date, score/rating,
MAL URL, total episode count, and season number detected from the title.

### Phase 2 — Episode URL enrichment (optional, `--episodes` flag)

For the top N shows by rating, tries each site in order until one succeeds:

1. **AnimeFLV** (`www3.animeflv.net`) — JSON search API
2. **TioAnime** (`tioanime.com`) — JSON search API
3. **JKAnime** (`jkanime.net`) — HTML search

Per-site failure is isolated. If a site blocks the request, the next is tried.
If all episode sites fail, Phase 1 metadata is still saved — the catalog never goes empty.

---

## Production: Automatic daily runs via GitHub Actions

The workflow `.github/workflows/scrape-catalog.yml` runs **daily at 06:00 UTC**.

Pipeline:
1. Install `requests` (only ~1 sec, no browser download)
2. Run `python anime_scraper.py --episodes --top 20 --max-eps 5`
3. Validate output (≥ 1 item required)
4. Commit `anime_metadata.json` back to repo (if valid)
5. Vercel detects the push → auto-deploys → fresh data online within minutes

**You never need to run anything locally.**

### Manual trigger

Go to **Actions → "Scrape anime catalog" → Run workflow**

| Input | Default | Description |
|---|---|---|
| `scrapeEpisodes` | `true` | Also scrape episode URLs |
| `top` | `20` | Top N shows to enrich with episodes |
| `maxEpisodes` | `5` | Max recent episodes per show |
| `jikanPages` | `4` | Jikan pages per endpoint (25 anime/page) |
| `sites` | *(all)* | Limit to specific sites: `animeflv tioanime jkanime` |

---

## Fallback behavior (never goes empty)

The `/api/scraped-catalog` endpoint:
1. Reads `anime_metadata.json`
2. If missing, empty, or corrupt → reads `anime_metadata.previous.json`
3. If both missing → returns 404 with a helpful message

The scraper also protects good data:
- If the new catalog has 0 items → exits with code 1 → nothing is committed
- The previous `anime_metadata.json` is preserved on disk
- `anime_metadata.previous.json` is written before every overwrite

---

## Output files

| File | Purpose |
|---|---|
| `scraper/anime_metadata.json` | Primary catalog served at `/api/scraped-catalog` |
| `scraper/anime_metadata.previous.json` | Previous run (fallback) |
| `scraper/anime_metadata.csv` | Human-readable spreadsheet |

---

## Local testing (optional)

```bash
cd scraper
pip install -r requirements.txt   # just 'requests' — no browser needed

# Verify Python syntax:
python -m py_compile anime_scraper.py

# Metadata only (~1 min):
python anime_scraper.py

# With episode URLs for top 20 shows, 5 eps each (~5-20 min):
python anime_scraper.py --episodes

# More shows, deeper history:
python anime_scraper.py --episodes --top 40 --max-eps 12

# Only AnimeFLV:
python anime_scraper.py --episodes --sites animeflv

# More Jikan pages (more anime titles):
python anime_scraper.py --episodes --jikan-pages 6
```

After running locally, `git commit scraper/anime_metadata.json` and push to trigger Vercel.

---

## Output schema

```json
{
  "ok": true,
  "source": "Jikan + AnimeFLV/TioAnime/JKAnime",
  "scrapedAt": "2026-05-28T06:00:00.000Z",
  "totalResults": 85,
  "episodeCount": 400,
  "items": [
    {
      "id": "jikan-52991",
      "malId": 52991,
      "title": "Frieren: Beyond Journey's End",
      "alternativeTitles": ["Sousou no Frieren", "葬送のフリーレン"],
      "image": "https://cdn.myanimelist.net/images/anime/1015/138006.jpg",
      "poster": "https://cdn.myanimelist.net/images/anime/1015/138006.jpg",
      "banner": "",
      "description": "The adventure is over...",
      "synopsis": "The adventure is over...",
      "genres": ["Adventure", "Drama", "Fantasy"],
      "genre": "fantasy",
      "status": "Finished Airing",
      "type": "TV",
      "year": 2023,
      "season": "Fall",
      "aired": "2023-09-29",
      "rating": 9.4,
      "score": 9.4,
      "source": "AnimeFLV",
      "siteUrl": "https://myanimelist.net/anime/52991",
      "totalEpisodes": 28,
      "episode": 28,
      "lastScrapedAt": "2026-05-28T06:00:00Z",
      "episodes": [
        {
          "id": "jikan-52991-ep-28",
          "season": 1,
          "episode": 28,
          "number": 28,
          "title": "Episodio 28",
          "siteUrl": "https://www3.animeflv.net/ver/frieren-beyond-journeys-end-28",
          "videoUrl": "",
          "externalUrl": "https://embed.example.com/player?id=abc123",
          "externalType": "iframe",
          "server": "AnimeFLV",
          "language": "es",
          "subtitles": [],
          "duration": "",
          "scrapedAt": "2026-05-28T06:12:34Z"
        }
      ],
      "seasons": [
        {
          "season": 1,
          "title": "Season 1",
          "episodes": [...]
        }
      ]
    }
  ]
}
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Catalog has 0 items | Jikan API unreachable | Check GitHub Actions logs; retry manually |
| Episodes are empty | Site blocked GitHub Actions IPs | Normal; metadata is still saved. Try different `--sites`. |
| `ModuleNotFoundError: requests` | Not installed | `pip install requests` |
| `json.JSONDecodeError` in logs | Episode page returned non-JSON | Ignored automatically; scraper continues |
| Vercel not updating | No commit was made | Check Actions log — scraper may have exited 1 (0 items) |
