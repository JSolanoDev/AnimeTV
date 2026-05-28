# AnimeTV Scraper

Fully online daily scraper — **no local machine required for production.**

Primary catalog and episode data comes directly from **AnimeAV1**, **TioAnime**, and **AnimeFLV**.
Jikan/MyAnimeList is an *optional* enrichment step (synopsis, score, poster) and is **not required** for the scraper to work.

---

## Architecture

### Phase 1 — Catalog from AnimeAV1, TioAnime, AnimeFLV (always runs)

Each site adapter tries multiple strategies in order:

| Strategy | TioAnime | AnimeFLV | AnimeAV1 |
|---|---|---|---|
| 1st | `/directorio?p=N` HTML | `/browse?order=updated` HTML | `/directorio?p=N` HTML |
| 2nd | `/emision` HTML | `/browse` HTML | Homepage HTML |
| 3rd | `/api/search?q=TERM` JSON | `/api/animes/search?value=TERM` JSON | `/emision` HTML |
| 4th | — | — | `/api/search?q=TERM` JSON |

One site failing **never stops the others**. If AnimeAV1 is blocked, TioAnime and AnimeFLV still run.

Every anime item includes: id, title, alternative titles, synopsis, poster, banner,
genres, type (TV/Movie/OVA/Special), status, year, season, aired, rating, MAL URL,
total episode count, season number detected from title.

### Phase 2 — Episode URL scraping (default ON via `--episodes`)

For the top N shows (sorted by type: TV first), tries to fetch episode URLs from the show's own source site:

1. Fetches the anime detail page to get episode numbers (`var episodes = [...]`)
2. Fetches individual episode pages
3. Extracts video URLs via four strategies:
   - `var videos = [["Server", "url"], ...]` (AnimeFLV-style array)
   - `var videos = {"SUB": [...], "LAT": [...]}` (TioAnime-style dict)
   - `<iframe src="...">` embed URLs
   - Bare `.m3u8` / `.mp4` URLs

Per-episode failure is isolated — one broken page never stops the rest.

### Phase 3 — Jikan enrichment (optional, `--jikan-enrich` flag only)

Adds MAL metadata (synopsis, score, poster, banner, alternative titles) using the free Jikan API.
**This phase is disabled by default** and is never required for the scraper to work.

---

## Production: Automatic daily runs via GitHub Actions

The workflow `.github/workflows/scrape-catalog.yml` runs **daily at 06:00 UTC**.

Pipeline:
1. Install `requests` (only ~1 sec, no browser download)
2. Run `python scraper/anime_scraper.py --episodes --sites animeav1,tioanime,animeflv --top 20 --max-eps 5 --no-jikan`
3. Validate output (≥ 1 item required)
4. Commit `anime_metadata.json` back to repo (if valid)
5. Vercel detects the push → auto-deploys → fresh data online within minutes

**You never need to run anything locally.**

### Manual trigger

Go to **Actions → "Scrape anime catalog" → Run workflow**

| Input | Default | Description |
|---|---|---|
| `sites` | `animeav1,tioanime,animeflv` | Comma-separated sites to scrape |
| `scrapeEpisodes` | `true` | Fetch episode URLs |
| `top` | `20` | Top N shows to enrich with episodes |
| `maxEpisodes` | `5` | Max recent episodes per show |
| `catalogPages` | `3` | Catalog pages per site (more = more anime) |
| `jikanEnrich` | `false` | Add Jikan/MAL metadata (optional) |

---

## Failure handling (never goes empty)

### Site isolation

- If AnimeAV1 fails → TioAnime and AnimeFLV still run
- If TioAnime fails → AnimeAV1 and AnimeFLV still run
- If AnimeFLV fails → AnimeAV1 and TioAnime still run
- If **all 3 fail** but a previous catalog exists → previous catalog is kept, exit code 0
- If **all 3 fail** and no previous catalog exists → exit code 1 (workflow fails, no empty commit)

### The `/api/scraped-catalog` endpoint fallback chain

1. Reads `scraper/anime_metadata.json`
2. If missing, empty, or corrupt → reads `scraper/anime_metadata.previous.json`
3. If both missing → returns 404 with a helpful message

### Data safety guards

- If the new catalog has 0 items → no file is written, old catalog is preserved
- `anime_metadata.previous.json` is written before every overwrite
- GitHub Actions only commits if the file is valid

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

# Metadata catalog only (~1-3 min, no episodes):
python anime_scraper.py

# With episode URLs (default online command):
python anime_scraper.py --episodes

# Only TioAnime and AnimeFLV:
python anime_scraper.py --episodes --sites tioanime,animeflv

# More catalog pages (more anime titles):
python anime_scraper.py --episodes --catalog-pages 6

# More shows, deeper episode history:
python anime_scraper.py --episodes --top 40 --max-eps 12

# With Jikan metadata enrichment:
python anime_scraper.py --episodes --jikan-enrich
```

After running locally, `git commit scraper/anime_metadata.json` and push to trigger Vercel.

---

## Output schema

```json
{
  "ok": true,
  "source": "AnimeAV1 + AnimeFLV + TioAnime",
  "sources": ["AnimeAV1", "AnimeFLV", "TioAnime"],
  "scrapedAt": "2026-05-29T06:00:00.000Z",
  "totalResults": 120,
  "episodeCount": 450,
  "items": [
    {
      "id": "tioanime-frieren-beyond-journeys-end",
      "malId": null,
      "title": "Frieren: Beyond Journey's End",
      "alternativeTitles": [],
      "synopsis": "...",
      "poster": "https://tioanime.com/uploads/portadas/frieren.jpg",
      "banner": "",
      "genres": ["Fantasy", "Drama"],
      "genre": "fantasy",
      "status": "Finished Airing",
      "type": "TV",
      "year": 2023,
      "season": "",
      "aired": "",
      "rating": null,
      "score": null,
      "source": "TioAnime",
      "siteUrl": "https://tioanime.com/anime/frieren-beyond-journeys-end",
      "totalEpisodes": null,
      "lastScrapedAt": "2026-05-29T06:00:00Z",
      "episodes": [
        {
          "id": "tioanime-frieren-beyond-journeys-end-ep-28",
          "season": 1,
          "episode": 28,
          "number": 28,
          "title": "Episode 28",
          "siteUrl": "https://tioanime.com/ver/frieren-beyond-journeys-end-28",
          "videoUrl": "",
          "externalUrl": "https://embed.example.com/player?id=abc",
          "externalType": "iframe",
          "server": "TioAnime",
          "language": "es",
          "subtitles": [],
          "duration": "",
          "scrapedAt": "2026-05-29T06:12:34Z"
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
| Catalog has 0 items from all sites | All 3 sites blocked GitHub Actions IPs | Previous catalog is kept. Try running again or use `--jikan-enrich` for metadata. |
| Episodes are empty | Episode pages blocked | Normal; metadata catalog is still saved. |
| `ModuleNotFoundError: requests` | Not installed | `pip install requests` |
| `json.JSONDecodeError` in logs | Episode page returned non-JSON | Ignored automatically; scraper continues |
| Vercel not updating | No commit was made | Check Actions log — scraper may have exited 1 (0 items, no previous catalog) |
| Source shows as "Jikan + ..." | Old `anime_metadata.json` in place | Run workflow manually to generate fresh catalog from AnimeAV1/TioAnime/AnimeFLV |
