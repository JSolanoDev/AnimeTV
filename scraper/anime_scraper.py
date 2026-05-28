#!/usr/bin/env python3
"""
anime_scraper.py — AnimeTV online metadata + episode scraper
============================================================

Phase 1  (always runs)  — Jikan public API (free, no auth, no browser)
  • Current season  → https://api.jikan.moe/v4/seasons/now
  • Top-airing      → https://api.jikan.moe/v4/top/anime?filter=airing
  Works reliably from GitHub Actions with no special setup.

Phase 2  (--episodes flag)  — Episode URL enrichment via lightweight HTTP
  Tries AnimeFLV, TioAnime, JKAnime with rotating user-agents + retry.
  Per-site failure is isolated: if one site blocks, the next is tried.
  If all episode sites are unavailable, Phase 1 metadata is still saved.

Safety
------
  • Never overwrites anime_metadata.json with 0 items.
  • Backs up current file to anime_metadata.previous.json before saving.
  • Exits with code 1 (no commit triggered) if validation fails.
  • Previous file is kept as fallback by the /api/scraped-catalog endpoint.

Usage
-----
  pip install requests
  python anime_scraper.py                             # metadata only (fast)
  python anime_scraper.py --episodes                  # + episode URLs (slower)
  python anime_scraper.py --episodes --top 30 --max-eps 12
  python anime_scraper.py --episodes --sites animeflv tioanime
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import re
import shutil
import sys
import time
from datetime import datetime, timezone
from itertools import cycle
from pathlib import Path
from typing import Optional

try:
    import requests
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry
except ImportError:
    sys.exit(
        "\n[ERROR] 'requests' is not installed.\n"
        "  pip install requests\n"
    )

# ──────────────────────────────────────────────────────────────────────────────
# Config
# ──────────────────────────────────────────────────────────────────────────────
SCRIPT_DIR  = Path(__file__).parent
OUTPUT_JSON = SCRIPT_DIR / "anime_metadata.json"
PREV_JSON   = SCRIPT_DIR / "anime_metadata.previous.json"
OUTPUT_CSV  = SCRIPT_DIR / "anime_metadata.csv"

JIKAN_BASE  = "https://api.jikan.moe/v4"
JIKAN_DELAY = 0.5    # seconds between Jikan calls — stays under the 3 req/s limit
JIKAN_PAGES = 4      # pages per endpoint (25 items/page → up to 100 per endpoint)
HTTP_TIMEOUT = 22    # seconds per request
MAX_RETRIES  = 3

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
]
_ua_cycle = cycle(USER_AGENTS)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("anime-scraper")

# ──────────────────────────────────────────────────────────────────────────────
# HTTP session
# ──────────────────────────────────────────────────────────────────────────────

def _make_session() -> requests.Session:
    session = requests.Session()
    retry = Retry(
        total=MAX_RETRIES,
        backoff_factor=1.2,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET"],
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session

_session = _make_session()


def _base_headers(accept: str = "text/html,application/xhtml+xml,*/*;q=0.8") -> dict:
    return {
        "User-Agent":      next(_ua_cycle),
        "Accept":          accept,
        "Accept-Language": "es-419,es;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept-Encoding": "gzip, deflate, br",
        "DNT":             "1",
        "Connection":      "keep-alive",
        "Cache-Control":   "no-cache",
        "Pragma":          "no-cache",
    }


def http_get(url: str, params=None, json_mode=False, label="") -> requests.Response | None:
    """GET with rotating UA, returns Response or None on failure."""
    headers = _base_headers("application/json" if json_mode else "text/html,*/*;q=0.8")
    try:
        resp = _session.get(url, params=params, headers=headers, timeout=HTTP_TIMEOUT)
        if resp.status_code == 200:
            return resp
        log.warning("[%s] HTTP %d  %s", label or "http", resp.status_code, url[:100])
        return None
    except Exception as exc:
        log.warning("[%s] Request error  %s  — %s", label or "http", url[:80], exc)
        return None


def get_json(url: str, params=None, delay=0.0, label="") -> dict | list | None:
    resp = http_get(url, params=params, json_mode=True, label=label)
    if resp is None:
        return None
    if delay:
        time.sleep(delay)
    try:
        return resp.json()
    except Exception as exc:
        log.warning("[%s] JSON parse error: %s", label, exc)
        return None


def get_html(url: str, delay=0.5, label="") -> str | None:
    resp = http_get(url, label=label)
    if resp is None:
        return None
    if delay:
        time.sleep(delay)
    return resp.text


# ──────────────────────────────────────────────────────────────────────────────
# Shared utilities
# ──────────────────────────────────────────────────────────────────────────────

def clean(value) -> str:
    if not value:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def abs_url(href: str, base: str) -> str:
    if not href:
        return ""
    href = href.strip()
    if href.startswith("http"):
        return href
    if href.startswith("//"):
        return "https:" + href
    if href.startswith("/"):
        from urllib.parse import urlparse
        p = urlparse(base)
        return f"{p.scheme}://{p.netloc}{href}"
    return href


def detect_season_number(title: str) -> int:
    """Infer season number from title strings like 'Season 2', '2nd Season', 'Part II'."""
    t = title.lower()
    patterns = [
        r'\bseason\s+(\d+)\b',
        r'\b(\d+)(?:st|nd|rd|th)\s+season\b',
        r'\btemporada\s+(\d+)\b',
        r'\bparte?\s+(\d+)\b',
        r'\bpart\s+(\d+)\b',
        r'\b(\d+)\s*parte?\b',
        r'\bcour\s+(\d+)\b',
    ]
    for p in patterns:
        m = re.search(p, t)
        if m:
            return int(m.group(1))
    roman = {
        r'\bii\b': 2, r'\biii\b': 3, r'\biv\b': 4,
        r'\bv\b': 5, r'\bvi\b': 6, r'\bvii\b': 7, r'\bviii\b': 8,
    }
    for p, n in roman.items():
        if re.search(p, t):
            return n
    return 1


_GENRE_MAP = {
    "accion": "action", "acción": "action", "action": "action",
    "adventure": "action", "aventura": "action",
    "comedy": "comedy", "comedia": "comedy",
    "fantasy": "fantasy", "fantasia": "fantasy", "fantasía": "fantasy",
    "sci-fi": "fantasy", "science fiction": "fantasy",
    "supernatural": "fantasy", "sobrenatural": "fantasy",
    "isekai": "fantasy", "magic": "fantasy",
    "romance": "romance", "shoujo": "romance",
    "drama": "drama", "slice of life": "drama",
    "horror": "drama", "terror": "drama",
    "mystery": "drama", "misterio": "drama",
    "psychological": "drama", "thriller": "drama",
    "sports": "action", "sport": "action",
    "shounen": "action", "mecha": "action",
    "school": "comedy",
    "music": "comedy",
    "seinen": "drama",
}


def pick_genre(genres: list[str]) -> str:
    for g in genres:
        mapped = _GENRE_MAP.get(g.lower().strip())
        if mapped:
            return mapped
    return genres[0].lower().strip() if genres else "anime"


def stable_id(source: str, title: str, mal_id=None) -> str:
    if mal_id:
        return f"jikan-{mal_id}"
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:60]
    return f"{source.lower()}-{slug}"


# ──────────────────────────────────────────────────────────────────────────────
# Phase 1 — Jikan API (MyAnimeList wrapper, free, no auth)
# ──────────────────────────────────────────────────────────────────────────────

def _jikan_get(path: str, params: dict | None = None) -> dict | None:
    return get_json(f"{JIKAN_BASE}{path}", params=params, delay=JIKAN_DELAY, label="Jikan")


def fetch_jikan_catalog(pages: int = JIKAN_PAGES) -> list[dict]:
    """
    Collect anime metadata from two Jikan endpoints:
      • /seasons/now        current-season shows
      • /top/anime airing   highest-rated currently airing
    Returns deduplicated list of normalized anime dicts.
    """
    log.info("[Jikan] Starting catalog fetch (pages=%d per endpoint)", pages)
    seen: set[int] = set()
    results: list[dict] = []

    def _ingest(batch: list[dict], label: str) -> int:
        added = 0
        for anime in batch:
            mid = anime.get("mal_id")
            if not mid or mid in seen:
                continue
            seen.add(mid)
            results.append(_normalize_jikan(anime))
            added += 1
        return added

    # Current season
    for page in range(1, pages + 1):
        data = _jikan_get("/seasons/now", {"page": page, "limit": 25})
        if not data:
            log.warning("[Jikan] /seasons/now page %d returned no data", page)
            break
        added = _ingest(data.get("data", []), f"seasons/now p{page}")
        log.info("[Jikan] seasons/now page %d → +%d  (total %d)", page, added, len(results))
        if not data.get("pagination", {}).get("has_next_page"):
            break

    # Top airing
    top_pages = max(1, pages // 2)
    for page in range(1, top_pages + 1):
        data = _jikan_get("/top/anime", {"page": page, "filter": "airing", "limit": 25})
        if not data:
            log.warning("[Jikan] /top/anime page %d returned no data", page)
            break
        added = _ingest(data.get("data", []), f"top/airing p{page}")
        log.info("[Jikan] top/airing  page %d → +%d  (total %d)", page, added, len(results))
        if not data.get("pagination", {}).get("has_next_page"):
            break

    log.info("[Jikan] Catalog complete: %d unique anime", len(results))
    return results


def _normalize_jikan(anime: dict) -> dict:
    """Convert a raw Jikan anime object into our app schema."""
    mal_id = anime.get("mal_id")
    title  = clean(anime.get("title") or "")

    # Alternative titles
    alt_titles: list[str] = []
    for t in anime.get("titles", []):
        v = clean(t.get("title") or "")
        if v and v != title and v not in alt_titles:
            alt_titles.append(v)

    # Images
    jpg    = (anime.get("images") or {}).get("jpg") or {}
    poster = jpg.get("large_image_url") or jpg.get("image_url") or ""

    # Banner from trailer thumbnail (best available)
    trailer = anime.get("trailer") or {}
    banner  = (trailer.get("images") or {}).get("maximum_image_url") or ""

    # Genres (genres + themes + demographics)
    genres_raw: list[str] = []
    for key in ("genres", "themes", "demographics", "explicit_genres"):
        for g in anime.get(key) or []:
            name = g.get("name") or ""
            if name and name not in genres_raw:
                genres_raw.append(name)

    # Year / season / aired
    aired_obj  = anime.get("aired") or {}
    aired_from = (aired_obj.get("from") or "")[:10]
    year       = anime.get("year") or None
    if not year and aired_from:
        try:
            year = int(aired_from[:4])
        except (ValueError, TypeError):
            pass
    season_str = (anime.get("season") or "").capitalize()

    # Season number from title
    season_num = detect_season_number(title)

    # Episode count and score
    total_eps = anime.get("episodes") or None
    score     = anime.get("score") or None

    # Broadcast day/time
    broadcast = anime.get("broadcast") or {}
    air_day   = clean((broadcast.get("day") or "")).split()[0] or "Local"
    air_time  = clean(broadcast.get("time") or "")

    item_id = f"jikan-{mal_id}" if mal_id else stable_id("jikan", title)

    return {
        # Identity
        "id":                item_id,
        "malId":             mal_id,
        "title":             title,
        "alternativeTitles": alt_titles,
        # Media
        "image":             poster,
        "poster":            poster,
        "banner":            banner,
        # Text
        "description":       clean(anime.get("synopsis") or ""),
        "synopsis":          clean(anime.get("synopsis") or ""),
        # Classification
        "genres":            genres_raw,
        "genre":             pick_genre(genres_raw) if genres_raw else "anime",
        "status":            clean(anime.get("status") or ""),
        "type":              clean(anime.get("type") or "TV"),
        "year":              year,
        "season":            season_str,
        "aired":             aired_from,
        "rating":            score,
        "score":             score,
        # Links
        "source":            "Jikan",
        "siteUrl":           anime.get("url") or f"https://myanimelist.net/anime/{mal_id}",
        # Episodes
        "totalEpisodes":     total_eps,
        "episode":           total_eps,   # normalize.js uses this as episode count
        "episodes":          [],
        "seasons":           [],
        # Broadcast
        "day":               air_day,
        "time":              air_time,
        # Season detection
        "seasonNumber":      season_num,
        # Colors (theme)
        "colors":            ["#40dfc2", "#251d47"],
        # Scrape timestamp
        "lastScrapedAt":     datetime.now(timezone.utc).isoformat(),
    }


# ──────────────────────────────────────────────────────────────────────────────
# Shared video URL extraction
# ──────────────────────────────────────────────────────────────────────────────

_RE_VIDS_ARRAY  = re.compile(r'var\s+videos\s*=\s*(\[[\s\S]*?\]);', re.DOTALL)
_RE_VIDS_DICT   = re.compile(r'var\s+videos\s*=\s*(\{[\s\S]*?\});', re.DOTALL)
_RE_EPISODES    = re.compile(r'var\s+episodes\s*=\s*(\[[\s\S]*?\]);', re.DOTALL)
_RE_IFRAME      = re.compile(r'<iframe[^>]+\bsrc=["\']([^"\'#][^"\']*)["\']', re.IGNORECASE)
_RE_DIRECT      = re.compile(r'https?://[^\s"\'<>]+\.(?:m3u8|mp4)(?:\?[^\s"\'<>]*)?')
_SKIP_NAMES     = frozenset({"yt", "youtube", "trailer", "ad", "ads", "promo", "zippyshare"})
_BAD_IFRAME_DOM = (
    "googlesyndication", "google-analytics", "facebook.com/plugins",
    "disqus", "doubleclick", "googletag", "amazon-adsystem", "scorecardresearch",
)


def extract_video(html: str, page_url: str, server: str) -> dict:
    """
    Try multiple patterns to find a playable or embeddable URL in episode HTML.
    Returns dict with keys: videoUrl, externalUrl, externalType, server, siteUrl.
    """
    out = {"videoUrl": "", "externalUrl": "", "externalType": "", "server": server, "siteUrl": page_url}

    # 1. var videos = [["ServerName", "url"], ...]
    m = _RE_VIDS_ARRAY.search(html)
    if m:
        try:
            arr = json.loads(m.group(1))
            for entry in arr:
                if not isinstance(entry, (list, tuple)) or len(entry) < 2:
                    continue
                name = str(entry[0]).strip().lower()
                url  = str(entry[1]).strip()
                if not url or name in _SKIP_NAMES:
                    continue
                if url.endswith(".m3u8") or url.endswith(".mp4"):
                    out["videoUrl"] = url
                    return out
                if not out["externalUrl"] and url.startswith("http"):
                    out["externalUrl"] = url
                    out["externalType"] = "iframe"
        except Exception:
            pass

    # 2. var videos = {"SUB": [["Server", "url"]], "LAT": [...], ...}
    m = _RE_VIDS_DICT.search(html)
    if m:
        try:
            obj = json.loads(m.group(1))
            for track in ("SUB", "LAT", "ESP", "DUB"):
                for entry in obj.get(track, []):
                    if not isinstance(entry, (list, tuple)) or len(entry) < 2:
                        continue
                    name = str(entry[0]).strip().lower()
                    url  = str(entry[1]).strip()
                    if not url or name in _SKIP_NAMES:
                        continue
                    if url.endswith(".m3u8") or url.endswith(".mp4"):
                        out["videoUrl"] = url
                        return out
                    if not out["externalUrl"] and url.startswith("http"):
                        out["externalUrl"] = url
                        out["externalType"] = "iframe"
                if out["videoUrl"] or out["externalUrl"]:
                    break
        except Exception:
            pass

    if out["externalUrl"]:
        return out

    # 3. Any non-ad iframe src
    for m in _RE_IFRAME.finditer(html):
        src = m.group(1).strip()
        if not src or any(bad in src for bad in _BAD_IFRAME_DOM):
            continue
        out["externalUrl"] = abs_url(src, page_url)
        out["externalType"] = "iframe"
        return out

    # 4. Bare .m3u8 / .mp4 URL
    m = _RE_DIRECT.search(html)
    if m:
        out["videoUrl"] = m.group(0)

    return out


def episode_nums_from_html(html: str) -> list[int]:
    """Extract sorted episode numbers from `var episodes = [[N, ...], ...]`."""
    m = _RE_EPISODES.search(html)
    if not m:
        return []
    try:
        arr = json.loads(m.group(1))
        nums: set[int] = set()
        for entry in arr:
            if isinstance(entry, (list, tuple)) and entry:
                n = entry[0]
            elif isinstance(entry, (int, float)):
                n = entry
            else:
                continue
            if isinstance(n, (int, float)) and int(n) > 0:
                nums.add(int(n))
        return sorted(nums)
    except Exception:
        return []


def build_episode(item_id: str, ep_num: int, video: dict, season: int = 1) -> dict:
    """Build a normalized episode dict from extracted video info."""
    return {
        "id":           f"{item_id}-ep-{ep_num}",
        "season":       season,
        "episode":      ep_num,
        "number":       ep_num,
        "title":        f"Episodio {ep_num}",
        "siteUrl":      video.get("siteUrl", ""),
        "videoUrl":     video.get("videoUrl", ""),
        "externalUrl":  video.get("externalUrl", ""),
        "externalType": video.get("externalType", ""),
        "server":       video.get("server", ""),
        "language":     "es",
        "subtitles":    [],
        "duration":     "",
        "scrapedAt":    datetime.now(timezone.utc).isoformat(),
    }


# ──────────────────────────────────────────────────────────────────────────────
# Phase 2a — AnimeFLV
# ──────────────────────────────────────────────────────────────────────────────

ANIMEFLV_BASE   = "https://www3.animeflv.net"
ANIMEFLV_SEARCH = f"{ANIMEFLV_BASE}/api/animes/search"

def _animeflv_find_slug(query: str) -> Optional[str]:
    data = get_json(ANIMEFLV_SEARCH, params={"value": query}, label="AnimeFLV")
    if not data or not isinstance(data, list):
        return None
    q = query.lower()
    for item in data[:8]:
        slug  = (item.get("slug") or item.get("id") or "").strip()
        title = (item.get("title") or "").lower()
        if slug and (q in title or title in q or
                     any(w in title for w in q.split() if len(w) > 3)):
            return slug
    return (data[0].get("slug") or data[0].get("id") or "").strip() or None if data else None


def enrich_animeflv(show: dict, max_eps: int) -> list[dict]:
    title  = show["title"]
    mal_id = show.get("malId")

    # Try primary + alternative titles
    search_titles = _search_titles(show)
    slug = None
    for t in search_titles:
        slug = _animeflv_find_slug(t)
        if slug:
            log.debug("[AnimeFLV] Found '%s' via query '%s'", slug, t)
            break

    if not slug:
        log.debug("[AnimeFLV] Not found: %s", title)
        return []

    # Get episode numbers from show page
    html = get_html(f"{ANIMEFLV_BASE}/anime/{slug}", label="AnimeFLV")
    if not html:
        return []
    ep_nums = episode_nums_from_html(html)
    if not ep_nums:
        # fallback: find /ver/slug-N links
        found = {int(m) for m in re.findall(rf'/ver/{re.escape(slug)}-(\d+)', html) if int(m) > 0}
        ep_nums = sorted(found)
    if not ep_nums:
        return []

    to_fetch = ep_nums[-max_eps:]
    log.info("[AnimeFLV] %-40s  slug=%-30s  %d eps to fetch",
             title[:40], slug[:30], len(to_fetch))

    item_id = stable_id("jikan", title, mal_id)
    season  = show.get("seasonNumber", 1) or 1
    episodes: list[dict] = []

    for n in to_fetch:
        url  = f"{ANIMEFLV_BASE}/ver/{slug}-{n}"
        html = get_html(url, delay=0.6, label="AnimeFLV")
        if html is None:
            continue
        video = extract_video(html, url, "AnimeFLV")
        episodes.append(build_episode(item_id, n, video, season))

    found_url = sum(1 for e in episodes if e["videoUrl"] or e["externalUrl"])
    log.info("[AnimeFLV] %-40s  %d/%d episodes with URL", title[:40], found_url, len(to_fetch))
    return episodes


# ──────────────────────────────────────────────────────────────────────────────
# Phase 2b — TioAnime
# ──────────────────────────────────────────────────────────────────────────────

TIOANIME_BASE   = "https://tioanime.com"
TIOANIME_SEARCH = f"{TIOANIME_BASE}/api/search"

def _tioanime_find_slug(query: str) -> Optional[str]:
    data = get_json(TIOANIME_SEARCH, params={"q": query}, label="TioAnime")
    if not data:
        return None
    items = data if isinstance(data, list) else (
        data.get("animes") or data.get("data") or data.get("results") or []
    )
    if not items:
        return None
    q = query.lower()
    for item in items[:8]:
        raw  = (item.get("slug") or item.get("id") or item.get("url") or "").strip()
        slug = raw.rstrip("/").rsplit("/", 1)[-1] if "/" in raw else raw
        title = (item.get("title") or "").lower()
        if slug and (q in title or title in q or
                     any(w in title for w in q.split() if len(w) > 3)):
            return slug
    first = items[0]
    raw = (first.get("slug") or first.get("id") or first.get("url") or "").strip()
    slug = raw.rstrip("/").rsplit("/", 1)[-1] if "/" in raw else raw
    return slug or None


def enrich_tioanime(show: dict, max_eps: int) -> list[dict]:
    title  = show["title"]
    mal_id = show.get("malId")

    search_titles = _search_titles(show)
    slug = None
    for t in search_titles:
        slug = _tioanime_find_slug(t)
        if slug:
            log.debug("[TioAnime] Found '%s' via query '%s'", slug, t)
            break

    if not slug:
        log.debug("[TioAnime] Not found: %s", title)
        return []

    html = get_html(f"{TIOANIME_BASE}/anime/{slug}", label="TioAnime")
    if not html:
        return []
    ep_nums = episode_nums_from_html(html)
    if not ep_nums:
        found = {int(m) for m in re.findall(rf'/ver/{re.escape(slug)}-(\d+)', html) if int(m) > 0}
        ep_nums = sorted(found)
    if not ep_nums:
        return []

    to_fetch = ep_nums[-max_eps:]
    log.info("[TioAnime] %-40s  slug=%-30s  %d eps to fetch",
             title[:40], slug[:30], len(to_fetch))

    item_id = stable_id("jikan", title, mal_id)
    season  = show.get("seasonNumber", 1) or 1
    episodes: list[dict] = []

    for n in to_fetch:
        url  = f"{TIOANIME_BASE}/ver/{slug}-{n}"
        html = get_html(url, delay=0.6, label="TioAnime")
        if html is None:
            continue
        video = extract_video(html, url, "TioAnime")
        episodes.append(build_episode(item_id, n, video, season))

    found_url = sum(1 for e in episodes if e["videoUrl"] or e["externalUrl"])
    log.info("[TioAnime] %-40s  %d/%d episodes with URL", title[:40], found_url, len(to_fetch))
    return episodes


# ──────────────────────────────────────────────────────────────────────────────
# Phase 2c — JKAnime
# ──────────────────────────────────────────────────────────────────────────────

JKANIME_BASE = "https://jkanime.net"

def _jkanime_find_slug(query: str) -> Optional[str]:
    url  = f"{JKANIME_BASE}/buscar/{requests.utils.quote(query)}/"
    html = get_html(url, delay=0.6, label="JKAnime")
    if not html:
        return None
    # href="https://jkanime.net/SLUG/"
    m = re.search(r'href="https://jkanime\.net/([a-z0-9][a-z0-9\-]+)/"', html)
    if m:
        return m.group(1)
    # href="/SLUG/"
    m = re.search(r'href="/([a-z0-9][a-z0-9\-]+)/"', html)
    return m.group(1) if m else None


def enrich_jkanime(show: dict, max_eps: int) -> list[dict]:
    title  = show["title"]
    mal_id = show.get("malId")

    search_titles = _search_titles(show)
    slug = None
    for t in search_titles:
        slug = _jkanime_find_slug(t)
        if slug:
            log.debug("[JKAnime] Found '%s' via query '%s'", slug, t)
            break

    if not slug:
        log.debug("[JKAnime] Not found: %s", title)
        return []

    html = get_html(f"{JKANIME_BASE}/{slug}/", label="JKAnime")
    if not html:
        return []
    ep_nums = episode_nums_from_html(html)
    if not ep_nums:
        found = {int(m) for m in re.findall(rf'/{re.escape(slug)}/(\d+)/', html) if int(m) > 0}
        ep_nums = sorted(found)
    if not ep_nums:
        return []

    to_fetch = ep_nums[-max_eps:]
    log.info("[JKAnime] %-40s  slug=%-30s  %d eps to fetch",
             title[:40], slug[:30], len(to_fetch))

    item_id = stable_id("jikan", title, mal_id)
    season  = show.get("seasonNumber", 1) or 1
    episodes: list[dict] = []

    for n in to_fetch:
        url  = f"{JKANIME_BASE}/{slug}/{n}/"
        html = get_html(url, delay=0.6, label="JKAnime")
        if html is None:
            continue
        video = extract_video(html, url, "JKAnime")
        episodes.append(build_episode(item_id, n, video, season))

    found_url = sum(1 for e in episodes if e["videoUrl"] or e["externalUrl"])
    log.info("[JKAnime] %-40s  %d/%d episodes with URL", title[:40], found_url, len(to_fetch))
    return episodes


# ──────────────────────────────────────────────────────────────────────────────
# Enrichment orchestrator
# ──────────────────────────────────────────────────────────────────────────────

_ENRICHERS = [
    ("AnimeFLV", enrich_animeflv),
    ("TioAnime", enrich_tioanime),
    ("JKAnime",  enrich_jkanime),
]


def _search_titles(show: dict) -> list[str]:
    """Build list of titles to try for site search (no Japanese)."""
    _JP = re.compile(r'[぀-ヿ一-鿿＀-￯]')
    titles = [show["title"]]
    for t in show.get("alternativeTitles", [])[:4]:
        if t and t not in titles and not _JP.search(t):
            titles.append(t)
    return titles


def enrich_show(show: dict, max_eps: int, sites: list[str] | None = None) -> None:
    """
    Try each enricher site in order; stop at the first one that returns episodes.
    Updates show in-place (episodes + seasons + source).
    """
    enrichers = _ENRICHERS
    if sites:
        sl = [s.lower() for s in sites]
        enrichers = [(n, fn) for n, fn in _ENRICHERS if n.lower() in sl]

    title = show["title"]
    for site_name, fn in enrichers:
        try:
            episodes = fn(show, max_eps)
            if episodes:
                show["episodes"] = episodes
                show["source"]   = site_name
                # Build seasons array so normalize.js can group them
                season_num = show.get("seasonNumber", 1) or 1
                show["seasons"] = [{
                    "season":   season_num,
                    "title":    f"Season {season_num}",
                    "episodes": episodes,
                }]
                log.info("[enrich] %-45s → %d eps from %s",
                         title[:45], len(episodes), site_name)
                return
        except Exception as exc:
            log.warning("[enrich] %s on %s raised: %s", title[:40], site_name, exc)

    log.info("[enrich] %-45s → no episode URLs (metadata-only)", title[:45])


# ──────────────────────────────────────────────────────────────────────────────
# Validation + Save
# ──────────────────────────────────────────────────────────────────────────────

def build_catalog(items: list[dict]) -> dict:
    ep_count = sum(len(i.get("episodes") or []) for i in items)
    return {
        "ok":           True,
        "source":       "Jikan + AnimeFLV/TioAnime/JKAnime",
        "scrapedAt":    datetime.now(timezone.utc).isoformat(),
        "totalResults": len(items),
        "episodeCount": ep_count,
        "items":        items,
    }


def validate(catalog: dict) -> tuple[bool, str]:
    items = catalog.get("items") or []
    n = len(items)
    if n == 0:
        return False, "Catalog has 0 items — refusing to overwrite previous catalog"
    ep_count = sum(len(i.get("episodes") or []) for i in items)
    return True, f"{n} anime, {ep_count} episode URLs"


def save_catalog(catalog: dict) -> None:
    """Backup existing → write new."""
    if OUTPUT_JSON.exists():
        shutil.copy2(OUTPUT_JSON, PREV_JSON)
        log.info("[save] Backed up existing catalog → %s", PREV_JSON.name)
    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
        json.dump(catalog, f, ensure_ascii=False, indent=2)
    log.info("[save] ✓ Wrote %s  (%d items, %d episode URLs)",
             OUTPUT_JSON.name, catalog["totalResults"], catalog.get("episodeCount", 0))


def save_csv(items: list[dict]) -> None:
    if not items:
        return
    fields = [
        "id", "title", "type", "status", "year", "season",
        "genre", "rating", "totalEpisodes", "source", "siteUrl",
    ]
    with open(OUTPUT_CSV, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(items)
    log.info("[save] ✓ Wrote %s", OUTPUT_CSV.name)


# ──────────────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────────────

def run(
    do_episodes: bool       = False,
    top_n:       int        = 20,
    max_eps:     int        = 5,
    sites:       list[str] | None = None,
    jikan_pages: int        = JIKAN_PAGES,
) -> int:
    """Return 0 on success, 1 if validation fails (causes CI to skip commit)."""
    print("=" * 65)
    print("  AnimeTV Scraper  (online — Jikan API + site enrichment)")
    if do_episodes:
        site_str = ", ".join(sites) if sites else "AnimeFLV, TioAnime, JKAnime"
        print(f"  Episodes  ON : top {top_n} shows × max {max_eps} eps via {site_str}")
    else:
        print("  Episodes OFF : metadata-only run (fast)")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 65)

    # ── Phase 1: Jikan metadata ────────────────────────────────────────────
    log.info("Phase 1 started: Jikan metadata")
    try:
        items = fetch_jikan_catalog(pages=jikan_pages)
    except Exception as exc:
        log.error("Jikan catalog fetch failed: %s", exc)
        items = []

    if not items:
        log.error("Phase 1 returned 0 items. Aborting — old catalog preserved.")
        return 1

    log.info("Phase 1 complete: %d anime", len(items))

    # ── Phase 2: Episode URL enrichment (optional) ─────────────────────────
    if do_episodes:
        log.info("Phase 2 started: episode URL enrichment")
        # Pick top_n by rating desc, then by total episodes
        to_enrich = sorted(
            items,
            key=lambda x: (x.get("rating") or 0, x.get("totalEpisodes") or 0),
            reverse=True,
        )[:top_n]

        for idx, show in enumerate(to_enrich, 1):
            log.info("[%d/%d] %s", idx, len(to_enrich), show["title"])
            try:
                enrich_show(show, max_eps, sites)
            except Exception as exc:
                log.warning("Enrichment error for %s: %s", show["title"], exc)

        ep_total = sum(len(i.get("episodes") or []) for i in items)
        shows_with_eps = sum(1 for i in items if i.get("episodes"))
        log.info("Phase 2 complete: %d episode URLs across %d shows", ep_total, shows_with_eps)

    # ── Validate + save ────────────────────────────────────────────────────
    catalog = build_catalog(items)
    ok, reason = validate(catalog)

    if not ok:
        log.error("Validation FAILED: %s — old catalog NOT overwritten", reason)
        return 1

    log.info("Validation PASSED: %s", reason)
    save_catalog(catalog)
    save_csv(items)

    print(f"\n  ✓ Done")
    print(f"    Anime     : {catalog['totalResults']}")
    print(f"    Episodes  : {catalog.get('episodeCount', 0)}")
    print("=" * 65)
    return 0


# ──────────────────────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="AnimeTV online metadata + episode scraper",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples
--------
  # Metadata only (Jikan, fast, ~1 min):
  python anime_scraper.py

  # With episode URLs for top 20 shows, 5 eps each (~5-15 min):
  python anime_scraper.py --episodes

  # More shows, deeper episode history:
  python anime_scraper.py --episodes --top 40 --max-eps 12

  # Only AnimeFLV for episode enrichment:
  python anime_scraper.py --episodes --sites animeflv

  # More Jikan pages (more anime titles):
  python anime_scraper.py --episodes --jikan-pages 6
""",
    )
    parser.add_argument(
        "--episodes", action="store_true",
        help="Enrich top shows with episode URLs from AnimeFLV/TioAnime/JKAnime",
    )
    parser.add_argument(
        "--top", type=int, default=20, metavar="N",
        help="How many top shows to enrich with episode URLs (default 20)",
    )
    parser.add_argument(
        "--max-eps", type=int, default=5, metavar="N",
        help="Max recent episodes to scrape per show (default 5)",
    )
    parser.add_argument(
        "--sites", nargs="+", metavar="SITE",
        help="Limit episode enrichment to specific sites: animeflv tioanime jkanime",
    )
    parser.add_argument(
        "--jikan-pages", type=int, default=JIKAN_PAGES, metavar="N",
        help=f"Jikan pages per endpoint (default {JIKAN_PAGES}; 25 anime/page)",
    )
    args = parser.parse_args()

    code = run(
        do_episodes=args.episodes,
        top_n=args.top,
        max_eps=args.max_eps,
        sites=args.sites,
        jikan_pages=args.jikan_pages,
    )
    sys.exit(code)


if __name__ == "__main__":
    main()
