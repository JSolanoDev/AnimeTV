#!/usr/bin/env python3
"""
anime_scraper.py — AnimeTV primary scraper
==========================================
Primary catalog sources: AnimeAV1, TioAnime, AnimeFLV
Automatic fallback catalog: Jikan/MyAnimeList (when all 3 primary sites fail)
Optional metadata enrichment: Jikan (--jikan-enrich flag)

Phases:
  1. Catalog  — fetch anime list directly from AnimeAV1 + TioAnime + AnimeFLV
               If all 3 fail → automatically try Jikan as fallback (free, CI-reliable)
  2. Episodes — for top-N shows, fetch episode list + video/embed URLs
  3. Enrich   — optional Jikan metadata (poster, synopsis, score) via --jikan-enrich

CLI defaults (matches GitHub Actions daily run):
  python anime_scraper.py --episodes --top 20 --max-eps 5
  python anime_scraper.py --episodes --sites animeav1,tioanime,animeflv

Safety:
  • Never overwrites anime_metadata.json with 0 items.
  • Backs up current file → anime_metadata.previous.json before saving.
  • Never exits code 1 due to site unavailability — Jikan fallback ensures data.
  • Exits code 1 only on genuine errors (no sites AND Jikan also unreachable AND
    no previous valid catalog).

Isolation:
  • One site failing never stops the others.
  • Jikan failure never stops the primary scrape.
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

# ─────────────────────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR  = Path(__file__).parent
OUTPUT_JSON = SCRIPT_DIR / "anime_metadata.json"
PREV_JSON   = SCRIPT_DIR / "anime_metadata.previous.json"
OUTPUT_CSV  = SCRIPT_DIR / "anime_metadata.csv"

# Primary sources
ANIMEAV1_BASE  = "https://animeav1.com"
TIOANIME_BASE  = "https://tioanime.com"
ANIMEFLV_BASE  = "https://www4.animeflv.net"

# Optional enrichment
JIKAN_BASE  = "https://api.jikan.moe/v4"
JIKAN_DELAY = 0.6   # stay under the 3 req/s limit

HTTP_TIMEOUT    = 25
MAX_RETRIES     = 2
CATALOG_DELAY   = 1.0   # seconds between catalog page requests
EPISODE_DELAY   = 0.8   # seconds between episode page requests
SEARCH_DELAY    = 0.8

# When catalog HTML scraping yields nothing, fall back to search API with broad terms
BROAD_TERMS = [
    "dragon", "hero", "magic", "sword", "black", "demon",
    "school", "attack", "spirit", "death", "love", "time",
    "world", "god", "master", "ninja", "pirate", "knight",
    "princess", "battle", "adventure", "fantasy", "zero",
    "one", "blue", "red", "fire", "water", "legend",
]

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
]
_ua_cycle = cycle(USER_AGENTS)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("anime-scraper")

# ─────────────────────────────────────────────────────────────────────────────
# HTTP session
# ─────────────────────────────────────────────────────────────────────────────

def _make_session() -> requests.Session:
    s = requests.Session()
    retry = Retry(
        total=MAX_RETRIES,
        backoff_factor=1.5,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET"],
        raise_on_status=False,
    )
    s.mount("http://",  HTTPAdapter(max_retries=retry))
    s.mount("https://", HTTPAdapter(max_retries=retry))
    return s

_session = _make_session()


def _headers(json_mode: bool = False) -> dict:
    return {
        "User-Agent":      next(_ua_cycle),
        "Accept":          "application/json" if json_mode
                           else "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "es-419,es;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept-Encoding": "gzip, deflate, br",
        "DNT":             "1",
        "Connection":      "keep-alive",
        "Cache-Control":   "no-cache",
        "Pragma":          "no-cache",
    }


def http_get(url: str, params=None, json_mode=False, label="") -> Optional[requests.Response]:
    try:
        r = _session.get(url, params=params, headers=_headers(json_mode), timeout=HTTP_TIMEOUT)
        if r.status_code == 200:
            return r
        log.warning("[%s] HTTP %d  %s", label or "http", r.status_code, url[:100])
        return None
    except Exception as exc:
        log.warning("[%s] Error  %s — %s", label or "http", url[:80], exc)
        return None


def get_html(url: str, delay: float = CATALOG_DELAY, label: str = "") -> Optional[str]:
    r = http_get(url, label=label)
    if r is None:
        return None
    if delay:
        time.sleep(delay)
    return r.text


def get_json(url: str, params=None, delay: float = 0.0, label: str = ""):
    r = http_get(url, params=params, json_mode=True, label=label)
    if r is None:
        return None
    if delay:
        time.sleep(delay)
    try:
        return r.json()
    except Exception as exc:
        log.warning("[%s] JSON parse error: %s", label, exc)
        return None


# ─────────────────────────────────────────────────────────────────────────────
# Shared utilities
# ─────────────────────────────────────────────────────────────────────────────

def clean(v) -> str:
    return re.sub(r"\s+", " ", str(v or "")).strip()


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


def slug_id(source: str, slug: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", slug.lower()).strip("-")[:80]
    return f"{source.lower()}-{s}"


def detect_season_number(title: str) -> int:
    """Infer season number from title strings."""
    t = title.lower()
    # Spelled-out ordinals in Spanish
    if re.search(r'\bsegunda\s+temporada\b', t):  return 2
    if re.search(r'\btercera\s+temporada\b', t):  return 3
    if re.search(r'\bcuarta\s+temporada\b', t):   return 4
    if re.search(r'\bquinta\s+temporada\b', t):   return 5

    patterns = [
        r'\bseason\s*(\d+)\b',
        r'\b(\d+)(?:st|nd|rd|th)\s+season\b',
        r'\btemporada\s*(\d+)\b',
        r'\bparte?\s*(\d+)\b',
        r'\bpart\s*(\d+)\b',
        r'\bcour\s*(\d+)\b',
        r'\bs(\d{1,2})\b',           # S2, S3
    ]
    for p in patterns:
        m = re.search(p, t)
        if m:
            try:
                return int(m.group(1))
            except (ValueError, IndexError):
                pass
    roman = {r'\bii\b': 2, r'\biii\b': 3, r'\biv\b': 4, r'\bv\b': 5,
             r'\bvi\b': 6, r'\bvii\b': 7, r'\bviii\b': 8}
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
    "isekai": "fantasy", "magic": "fantasy", "magia": "fantasy",
    "romance": "romance", "shoujo": "romance",
    "drama": "drama", "slice of life": "drama",
    "horror": "drama", "terror": "drama",
    "mystery": "drama", "misterio": "drama",
    "psychological": "drama", "thriller": "drama",
    "sports": "action", "sport": "action", "deportes": "action",
    "shounen": "action", "mecha": "action",
    "school": "comedy", "escolar": "comedy",
    "music": "comedy", "seinen": "drama",
}


def pick_genre(genres: list) -> str:
    for g in genres:
        m = _GENRE_MAP.get(g.lower().strip())
        if m:
            return m
    return genres[0].lower().strip() if genres else "anime"


def _make_catalog_item(
    *,
    source: str,
    slug: str,
    title: str,
    poster: str = "",
    site_url: str = "",
    type_str: str = "TV",
    status_str: str = "",
    year = None,
    genres: list = None,
    synopsis: str = "",
    base_url: str = "",
    score = None,
    mal_id = None,
    total_episodes = None,
) -> dict:
    genres = genres or []
    return {
        "id":                slug_id(source, slug),
        "malId":             mal_id,
        "title":             title,
        "alternativeTitles": [],
        "synopsis":          synopsis,
        "description":       synopsis,
        "poster":            poster,
        "image":             poster,
        "banner":            "",
        "genres":            genres,
        "genre":             pick_genre(genres) if genres else "anime",
        "status":            status_str,
        "type":              type_str,
        "year":              year,
        "season":            "",
        "aired":             "",
        "rating":            score,
        "score":             score,
        "source":            source,
        "siteUrl":           site_url,
        "totalEpisodes":     total_episodes,
        "episode":           total_episodes,
        "lastScrapedAt":     datetime.now(timezone.utc).isoformat(),
        "episodes":          [],
        "seasons":           [],
        "seasonNumber":      detect_season_number(title),
        "colors":            ["#40dfc2", "#251d47"],
        # Internal — stripped before saving
        "_slug":             slug,
        "_base":             base_url,
    }


def _strip_internal(item: dict) -> dict:
    """Remove internal helpers before saving."""
    return {k: v for k, v in item.items() if not k.startswith("_")}


# ─────────────────────────────────────────────────────────────────────────────
# Video / episode extraction (shared across all sites)
# ─────────────────────────────────────────────────────────────────────────────

_RE_VIDS_ARR  = re.compile(r'var\s+videos\s*=\s*(\[[\s\S]*?\]);', re.DOTALL)
_RE_VIDS_DICT = re.compile(r'var\s+videos\s*=\s*(\{[\s\S]*?\});', re.DOTALL)
_RE_EPISODES  = re.compile(r'var\s+episodes\s*=\s*(\[[\s\S]*?\]);', re.DOTALL)
_RE_IFRAME    = re.compile(r'<iframe[^>]+\bsrc=["\']([^"\'#][^"\']*)["\']', re.IGNORECASE)
_RE_DIRECT    = re.compile(r'https?://[^\s"\'<>]+\.(?:m3u8|mp4)(?:\?[^\s"\'<>]*)?')
_SKIP_NAMES   = frozenset({"yt", "youtube", "trailer", "ad", "ads", "promo", "zippyshare"})
_BAD_IFRAMES  = (
    "googlesyndication", "google-analytics", "facebook.com/plugins",
    "disqus", "doubleclick", "googletag", "amazon-adsystem", "scorecardresearch",
)


def extract_video(html: str, page_url: str, server: str) -> dict:
    """
    Try multiple strategies to find a playable or embeddable URL in episode HTML.
    """
    out = {"videoUrl": "", "externalUrl": "", "externalType": "", "server": server, "siteUrl": page_url}

    # 1. var videos = [["ServerName", "url"], ...]
    m = _RE_VIDS_ARR.search(html)
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
                if url.endswith((".m3u8", ".mp4")):
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
                    if url.endswith((".m3u8", ".mp4")):
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

    # 3. Non-ad iframes
    for m in _RE_IFRAME.finditer(html):
        src = m.group(1).strip()
        if not src or any(bad in src for bad in _BAD_IFRAMES):
            continue
        out["externalUrl"] = abs_url(src, page_url)
        out["externalType"] = "iframe"
        return out

    # 4. Bare .m3u8 / .mp4 URL anywhere on page
    m = _RE_DIRECT.search(html)
    if m:
        out["videoUrl"] = m.group(0)

    return out


def episode_nums_from_html(html: str) -> list:
    """Extract sorted episode numbers from `var episodes = [[N, ...], ...]`."""
    m = _RE_EPISODES.search(html)
    if not m:
        return []
    try:
        arr = json.loads(m.group(1))
        nums: set = set()
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
    return {
        "id":           f"{item_id}-ep-{ep_num}",
        "season":       season,
        "episode":      ep_num,
        "number":       ep_num,
        "title":        f"Episode {ep_num}",
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


# ─────────────────────────────────────────────────────────────────────────────
# General HTML catalog parser (site-agnostic)
# ─────────────────────────────────────────────────────────────────────────────

_SKIP_IMG = ("1x1", "blank", "pixel", "loader", "icon", "logo", "flag", "ads", "banner", "spinner")
_KNOWN_GENRES = [
    "Acción", "Accion", "Action", "Aventura", "Adventure", "Comedia",
    "Comedy", "Drama", "Fantasía", "Fantasia", "Fantasy", "Romance",
    "Sci-Fi", "Misterio", "Mystery", "Horror", "Terror",
    "Slice of Life", "Deportes", "Sports", "Mecha",
    "Sobrenatural", "Supernatural", "Escolar", "School",
    "Isekai", "Seinen", "Shounen", "Shoujo", "Magia", "Magic",
]


def _parse_catalog_html(html: str, base_url: str, source: str) -> list:
    """
    Extract anime cards from HTML.
    Uses position-based context extraction around /anime/slug links.
    Handles TioAnime, AnimeFLV, AnimeAV1, and similar Bootstrap-grid layouts.
    """
    link_re = re.compile(
        r'href=["\'](?:' + re.escape(base_url) + r')?'
        r'(/(?:anime|ver-anime|animes)/([a-z0-9][a-z0-9\-_%]+))["\']',
        re.IGNORECASE,
    )

    items = []
    seen: set = set()

    for m in link_re.finditer(html):
        path, slug = m.group(1), m.group(2)
        slug = slug.split("%")[0]  # strip URL-encoded chars

        # Skip episode-like slugs (slug-N)
        if re.search(r'-\d+$', slug) or re.match(r'^\d+$', slug):
            continue
        if slug in seen or len(slug) < 2:
            continue

        # Context window: 600 chars before the link, 1200 after
        cs = max(0, m.start() - 600)
        ce = min(len(html), m.end() + 1200)
        ctx = html[cs:ce]

        # ── Find poster image ──
        poster = ""
        for img_m in re.finditer(
            r'<img[^>]+src=["\']([^"\']{8,}(?:jpg|png|webp|jpeg)[^"\']{0,120})["\']',
            ctx, re.IGNORECASE
        ):
            src = img_m.group(1)
            if any(skip in src.lower() for skip in _SKIP_IMG):
                continue
            poster = abs_url(src, base_url)
            break
        # Also try data-src (lazy-loaded images)
        if not poster:
            for img_m in re.finditer(
                r'<img[^>]+data-src=["\']([^"\']{8,}(?:jpg|png|webp|jpeg)[^"\']{0,120})["\']',
                ctx, re.IGNORECASE
            ):
                src = img_m.group(1)
                if any(skip in src.lower() for skip in _SKIP_IMG):
                    continue
                poster = abs_url(src, base_url)
                break

        # ── Find title ──
        title = ""
        for pat in [
            r'<h[1-4][^>]*>\s*(?:<a[^>]*>)?\s*([^<\n]{2,100}?)\s*(?:</a>)?\s*</h[1-4]>',
            r'class="[^"]*(?:title|titulo|nombre|name)[^"]*"[^>]*>\s*(?:<a[^>]*>)?\s*([^<\n]{2,100}?)\s*',
            r'<p[^>]*>\s*([A-Z][^<\n]{1,90})\s*</p>',
            r'title=["\']([^"\']{2,100})["\']',
        ]:
            tm = re.search(pat, ctx, re.IGNORECASE)
            if tm:
                cand = clean(tm.group(1))
                if 2 <= len(cand) <= 120 and not cand.startswith(("<", "http", "{")):
                    title = cand
                    break

        if not title or len(title) < 2:
            continue

        # ── Type ──
        type_str = "TV"
        tm = re.search(r'\b(TV|OVA|ONA|Movie|Special|Especial|Pel[íi]cula)\b', ctx[:700], re.IGNORECASE)
        if tm:
            t = tm.group(1).upper()
            type_str = "Movie" if t in ("PELICULA", "PELÍCULA") else t

        # ── Status ──
        status_str = ""
        if re.search(r'\b(?:en emisi[oó]n|currently\s*airing|airing|estreno)\b', ctx, re.IGNORECASE):
            status_str = "Currently Airing"
        elif re.search(r'\b(?:finalizado|finished|completed|completado)\b', ctx, re.IGNORECASE):
            status_str = "Finished Airing"

        # ── Year ──
        year = None
        ym = re.search(r'\b(20[12]\d)\b', ctx[:800])
        if ym:
            year = int(ym.group(1))

        # ── Genres ──
        genres = []
        gl = ctx[:900]
        for g in _KNOWN_GENRES:
            if re.search(r'\b' + re.escape(g) + r'\b', gl, re.IGNORECASE):
                genres.append(g)

        seen.add(slug)
        items.append(_make_catalog_item(
            source=source,
            slug=slug,
            title=title,
            poster=poster,
            site_url=abs_url(path, base_url),
            type_str=type_str,
            status_str=status_str,
            year=year,
            genres=genres,
            base_url=base_url,
        ))

    return items


def _dedup(items: list, key="_slug") -> list:
    seen: set = set()
    out = []
    for item in items:
        k = item.get(key) or item.get("id") or item.get("title", "")
        if k and k not in seen:
            seen.add(k)
            out.append(item)
    return out


# ─────────────────────────────────────────────────────────────────────────────
# TioAnime adapter
# ─────────────────────────────────────────────────────────────────────────────

def _tio_normalize_search_item(item: dict) -> Optional[dict]:
    """Normalize one TioAnime search-API result."""
    slug = (
        item.get("slug") or item.get("id") or
        item.get("url", "").rstrip("/").rsplit("/", 1)[-1]
    ).strip()
    if not slug:
        return None
    title = clean(item.get("title") or item.get("name") or "")
    if not title:
        return None
    poster = item.get("poster") or item.get("cover") or item.get("image") or ""
    poster = abs_url(poster, TIOANIME_BASE)
    genres_raw = item.get("genres") or item.get("genre") or []
    if isinstance(genres_raw, str):
        genres_raw = [genres_raw]
    type_str = clean(item.get("type") or "TV").upper()
    if type_str in ("PELICULA", "PELÍCULA", "MOVIE"):
        type_str = "Movie"
    elif type_str not in ("TV", "OVA", "ONA", "SPECIAL"):
        type_str = "TV"
    return _make_catalog_item(
        source="TioAnime",
        slug=slug,
        title=title,
        poster=poster,
        site_url=f"{TIOANIME_BASE}/anime/{slug}",
        type_str=type_str,
        genres=genres_raw,
        base_url=TIOANIME_BASE,
    )


def fetch_catalog_tioanime(catalog_pages: int = 3) -> list:
    """
    Fetch anime catalog from TioAnime.
    Tries: 1) /directorio HTML  2) /emision HTML  3) search-API fallback.
    """
    log.info("[TioAnime] Starting catalog fetch (catalog_pages=%d)", catalog_pages)
    seen: set = set()
    results = []

    def _add(new_items: list) -> int:
        added = 0
        for item in new_items:
            k = item.get("_slug", "")
            if k and k not in seen:
                seen.add(k)
                results.append(item)
                added += 1
        return added

    # ── Strategy 1: /directorio?p=N ──
    html_found = False
    for page in range(1, catalog_pages + 1):
        url = f"{TIOANIME_BASE}/directorio?p={page}" if page > 1 else f"{TIOANIME_BASE}/directorio"
        html = get_html(url, delay=CATALOG_DELAY, label="TioAnime")
        if not html:
            log.warning("[TioAnime] Could not fetch directorio page %d", page)
            break
        items = _parse_catalog_html(html, TIOANIME_BASE, "TioAnime")
        if not items:
            break
        n = _add(items)
        html_found = True
        log.info("[TioAnime] /directorio page %d → +%d  (total %d)", page, n, len(results))
        if n < 5:
            break  # last page

    # ── Strategy 2: /emision (currently airing) ──
    html = get_html(f"{TIOANIME_BASE}/emision", delay=CATALOG_DELAY, label="TioAnime")
    if html:
        items = _parse_catalog_html(html, TIOANIME_BASE, "TioAnime")
        n = _add(items)
        log.info("[TioAnime] /emision → +%d  (total %d)", n, len(results))
        html_found = html_found or bool(items)

    # ── Strategy 3: search-API fallback ──
    if not html_found or len(results) < 10:
        log.info("[TioAnime] Falling back to search API")
        for term in BROAD_TERMS[:20]:
            data = get_json(
                f"{TIOANIME_BASE}/api/search", params={"q": term},
                delay=SEARCH_DELAY, label="TioAnime",
            )
            if not data:
                continue
            entries = (
                data if isinstance(data, list)
                else data.get("animes") or data.get("data") or data.get("results") or []
            )
            for entry in entries:
                item = _tio_normalize_search_item(entry)
                if item:
                    k = item.get("_slug", "")
                    if k and k not in seen:
                        seen.add(k)
                        results.append(item)
        log.info("[TioAnime] After search fallback: %d anime", len(results))

    log.info("[TioAnime] Catalog complete: %d unique anime", len(results))
    return results


def _tio_ep_nums_from_detail(slug: str) -> list:
    """Fetch TioAnime anime detail page and extract episode numbers."""
    html = get_html(f"{TIOANIME_BASE}/anime/{slug}", delay=CATALOG_DELAY, label="TioAnime")
    if not html:
        return []
    ep_nums = episode_nums_from_html(html)
    if not ep_nums:
        found = {
            int(m) for m in re.findall(
                rf'href=["\'][^"\']*ver/{re.escape(slug)}-(\d+)["\']', html
            ) if int(m) > 0
        }
        ep_nums = sorted(found)
    return ep_nums


def fetch_episodes_tioanime(show: dict, max_eps: int) -> list:
    slug = show.get("_slug", "")
    if not slug:
        # Try to derive from siteUrl
        su = show.get("siteUrl", "")
        slug = su.rstrip("/").rsplit("/", 1)[-1] if su else ""
    if not slug:
        log.debug("[TioAnime] No slug for %s", show["title"])
        return []

    ep_nums = _tio_ep_nums_from_detail(slug)
    if not ep_nums:
        log.debug("[TioAnime] No episodes found for %s (slug=%s)", show["title"], slug)
        return []

    to_fetch = ep_nums[-max_eps:]
    season = show.get("seasonNumber", 1) or 1
    item_id = show["id"]
    episodes = []

    log.info("[TioAnime] %-40s  slug=%-28s  fetching %d eps",
             show["title"][:40], slug[:28], len(to_fetch))

    for n in to_fetch:
        url = f"{TIOANIME_BASE}/ver/{slug}-{n}"
        html = get_html(url, delay=EPISODE_DELAY, label="TioAnime")
        if html is None:
            log.warning("[TioAnime] Failed episode page: %s", url)
            continue
        video = extract_video(html, url, "TioAnime")
        episodes.append(build_episode(item_id, n, video, season))

    found_url = sum(1 for e in episodes if e["videoUrl"] or e["externalUrl"])
    log.info("[TioAnime] %-40s  %d/%d eps with URL", show["title"][:40], found_url, len(to_fetch))
    return episodes


# ─────────────────────────────────────────────────────────────────────────────
# AnimeFLV adapter
# ─────────────────────────────────────────────────────────────────────────────

def _flv_normalize_search_item(item: dict) -> Optional[dict]:
    slug = (item.get("slug") or item.get("id") or "").strip()
    if not slug:
        return None
    title = clean(item.get("title") or item.get("name") or "")
    if not title:
        return None
    cover = item.get("cover") or item.get("poster") or item.get("image") or ""
    if cover and cover.startswith("/"):
        cover = f"{ANIMEFLV_BASE}{cover}"
    elif cover and not cover.startswith("http"):
        cover = f"{ANIMEFLV_BASE}/uploads/portadas/{cover}" if "/" not in cover else cover
    type_raw = clean(item.get("type") or "TV").upper()
    type_str = "Movie" if type_raw in ("PELICULA", "PELÍCULA", "MOVIE") else type_raw
    if type_str not in ("TV", "OVA", "ONA", "SPECIAL", "MOVIE"):
        type_str = "TV"
    return _make_catalog_item(
        source="AnimeFLV",
        slug=slug,
        title=title,
        poster=cover,
        site_url=f"{ANIMEFLV_BASE}/anime/{slug}",
        type_str=type_str,
        base_url=ANIMEFLV_BASE,
    )


def fetch_catalog_animeflv(catalog_pages: int = 3) -> list:
    """
    Fetch anime catalog from AnimeFLV.
    Tries: 1) /browse HTML  2) /browse?order=updated HTML  3) search-API fallback.
    """
    log.info("[AnimeFLV] Starting catalog fetch (catalog_pages=%d)", catalog_pages)
    seen: set = set()
    results = []

    def _add(new_items: list) -> int:
        added = 0
        for item in new_items:
            k = item.get("_slug", "")
            if k and k not in seen:
                seen.add(k)
                results.append(item)
                added += 1
        return added

    # ── Strategy 1: /browse HTML pages ──
    browse_urls = [
        f"{ANIMEFLV_BASE}/browse?order=updated",
        f"{ANIMEFLV_BASE}/browse",
    ]
    html_found = False
    for browse_url in browse_urls:
        for page in range(1, catalog_pages + 1):
            url = f"{browse_url}&page={page}" if "?" in browse_url else f"{browse_url}?page={page}"
            if page == 1:
                url = browse_url
            html = get_html(url, delay=CATALOG_DELAY, label="AnimeFLV")
            if not html:
                log.warning("[AnimeFLV] Could not fetch browse page %d", page)
                break
            items = _parse_catalog_html(html, ANIMEFLV_BASE, "AnimeFLV")
            if not items:
                break
            n = _add(items)
            html_found = True
            log.info("[AnimeFLV] /browse page %d → +%d  (total %d)", page, n, len(results))
            if n < 5:
                break
        if html_found:
            break

    # ── Strategy 2: search-API fallback ──
    if not html_found or len(results) < 10:
        log.info("[AnimeFLV] Falling back to search API")
        for term in BROAD_TERMS[:20]:
            data = get_json(
                f"{ANIMEFLV_BASE}/api/animes/search", params={"value": term},
                delay=SEARCH_DELAY, label="AnimeFLV",
            )
            if not data or not isinstance(data, list):
                continue
            for entry in data:
                item = _flv_normalize_search_item(entry)
                if item:
                    k = item.get("_slug", "")
                    if k and k not in seen:
                        seen.add(k)
                        results.append(item)
        log.info("[AnimeFLV] After search fallback: %d anime", len(results))

    log.info("[AnimeFLV] Catalog complete: %d unique anime", len(results))
    return results


def _flv_ep_nums_from_detail(slug: str) -> list:
    html = get_html(f"{ANIMEFLV_BASE}/anime/{slug}", delay=CATALOG_DELAY, label="AnimeFLV")
    if not html:
        return []
    ep_nums = episode_nums_from_html(html)
    if not ep_nums:
        found = {
            int(m) for m in re.findall(
                rf'href=["\'][^"\']*ver/{re.escape(slug)}-(\d+)["\']', html
            ) if int(m) > 0
        }
        ep_nums = sorted(found)
    return ep_nums


def fetch_episodes_animeflv(show: dict, max_eps: int) -> list:
    slug = show.get("_slug", "")
    if not slug:
        su = show.get("siteUrl", "")
        slug = su.rstrip("/").rsplit("/", 1)[-1] if su else ""
    if not slug:
        log.debug("[AnimeFLV] No slug for %s", show["title"])
        return []

    ep_nums = _flv_ep_nums_from_detail(slug)
    if not ep_nums:
        log.debug("[AnimeFLV] No episodes found for %s (slug=%s)", show["title"], slug)
        return []

    to_fetch = ep_nums[-max_eps:]
    season = show.get("seasonNumber", 1) or 1
    item_id = show["id"]
    episodes = []

    log.info("[AnimeFLV] %-40s  slug=%-28s  fetching %d eps",
             show["title"][:40], slug[:28], len(to_fetch))

    for n in to_fetch:
        url = f"{ANIMEFLV_BASE}/ver/{slug}-{n}"
        html = get_html(url, delay=EPISODE_DELAY, label="AnimeFLV")
        if html is None:
            log.warning("[AnimeFLV] Failed episode page: %s", url)
            continue
        video = extract_video(html, url, "AnimeFLV")
        episodes.append(build_episode(item_id, n, video, season))

    found_url = sum(1 for e in episodes if e["videoUrl"] or e["externalUrl"])
    log.info("[AnimeFLV] %-40s  %d/%d eps with URL", show["title"][:40], found_url, len(to_fetch))
    return episodes


# ─────────────────────────────────────────────────────────────────────────────
# AnimeAV1 adapter
# ─────────────────────────────────────────────────────────────────────────────

def _animeav1_normalize_search_item(item: dict) -> Optional[dict]:
    slug = (item.get("slug") or item.get("id") or "").strip()
    if not slug:
        return None
    title = clean(item.get("title") or item.get("name") or "")
    if not title:
        return None
    poster = item.get("poster") or item.get("cover") or item.get("image") or ""
    poster = abs_url(poster, ANIMEAV1_BASE)
    type_raw = clean(item.get("type") or "TV").upper()
    type_str = "Movie" if type_raw in ("PELICULA", "PELÍCULA", "MOVIE") else type_raw
    return _make_catalog_item(
        source="AnimeAV1",
        slug=slug,
        title=title,
        poster=poster,
        site_url=f"{ANIMEAV1_BASE}/anime/{slug}",
        type_str=type_str,
        base_url=ANIMEAV1_BASE,
    )


def fetch_catalog_animeav1(catalog_pages: int = 3) -> list:
    """
    Fetch anime catalog from AnimeAV1.
    Tries multiple catalog-page URL patterns; falls back to search-API if available.
    """
    log.info("[AnimeAV1] Starting catalog fetch (catalog_pages=%d)", catalog_pages)
    seen: set = set()
    results = []

    def _add(new_items: list) -> int:
        added = 0
        for item in new_items:
            k = item.get("_slug", "")
            if k and k not in seen:
                seen.add(k)
                results.append(item)
                added += 1
        return added

    # ── Strategy 1: Try multiple catalog URL patterns (common among anime sites) ──
    catalog_url_templates = [
        f"{ANIMEAV1_BASE}/directorio?p={{page}}",
        f"{ANIMEAV1_BASE}/lista?p={{page}}",
        f"{ANIMEAV1_BASE}/catalog?p={{page}}",
        f"{ANIMEAV1_BASE}/anime?p={{page}}",
    ]
    html_found = False
    for tmpl in catalog_url_templates:
        for page in range(1, catalog_pages + 1):
            url = tmpl.format(page=page) if page > 1 else tmpl.format(page=1).split("?")[0]
            html = get_html(url, delay=CATALOG_DELAY, label="AnimeAV1")
            if not html:
                break
            items = _parse_catalog_html(html, ANIMEAV1_BASE, "AnimeAV1")
            if not items:
                break
            n = _add(items)
            html_found = True
            log.info("[AnimeAV1] catalog page %d → +%d  (total %d)", page, n, len(results))
            if n < 5:
                break
        if html_found:
            break

    # ── Strategy 2: Homepage (may list recent/popular anime) ──
    if not html_found or len(results) < 5:
        html = get_html(ANIMEAV1_BASE, delay=CATALOG_DELAY, label="AnimeAV1")
        if html:
            items = _parse_catalog_html(html, ANIMEAV1_BASE, "AnimeAV1")
            n = _add(items)
            html_found = html_found or bool(items)
            log.info("[AnimeAV1] homepage → +%d  (total %d)", n, len(results))

    # ── Strategy 3: /emision page (if the site has one) ──
    if not html_found or len(results) < 5:
        html = get_html(f"{ANIMEAV1_BASE}/emision", delay=CATALOG_DELAY, label="AnimeAV1")
        if html:
            items = _parse_catalog_html(html, ANIMEAV1_BASE, "AnimeAV1")
            n = _add(items)
            html_found = html_found or bool(items)
            log.info("[AnimeAV1] /emision → +%d  (total %d)", n, len(results))

    # ── Strategy 4: search-API fallback (if the site has one like TioAnime) ──
    if not results:
        log.info("[AnimeAV1] Falling back to search API")
        for term in BROAD_TERMS[:15]:
            data = get_json(
                f"{ANIMEAV1_BASE}/api/search", params={"q": term},
                delay=SEARCH_DELAY, label="AnimeAV1",
            )
            if not data:
                continue
            entries = (
                data if isinstance(data, list)
                else data.get("animes") or data.get("data") or data.get("results") or []
            )
            for entry in entries:
                item = _animeav1_normalize_search_item(entry)
                if item:
                    k = item.get("_slug", "")
                    if k and k not in seen:
                        seen.add(k)
                        results.append(item)

    if not results:
        log.warning("[AnimeAV1] Catalog returned 0 items — site may be inaccessible from CI")

    log.info("[AnimeAV1] Catalog complete: %d unique anime", len(results))
    return results


def _av1_ep_nums_from_detail(slug: str) -> list:
    html = get_html(f"{ANIMEAV1_BASE}/anime/{slug}", delay=CATALOG_DELAY, label="AnimeAV1")
    if not html:
        return []
    ep_nums = episode_nums_from_html(html)
    if not ep_nums:
        found = {
            int(m) for m in re.findall(
                rf'href=["\'][^"\']*ver/{re.escape(slug)}-(\d+)["\']', html
            ) if int(m) > 0
        }
        ep_nums = sorted(found)
    return ep_nums


def fetch_episodes_animeav1(show: dict, max_eps: int) -> list:
    slug = show.get("_slug", "")
    if not slug:
        su = show.get("siteUrl", "")
        slug = su.rstrip("/").rsplit("/", 1)[-1] if su else ""
    if not slug:
        log.debug("[AnimeAV1] No slug for %s", show["title"])
        return []

    ep_nums = _av1_ep_nums_from_detail(slug)
    if not ep_nums:
        log.debug("[AnimeAV1] No episodes found for %s (slug=%s)", show["title"], slug)
        return []

    to_fetch = ep_nums[-max_eps:]
    season = show.get("seasonNumber", 1) or 1
    item_id = show["id"]
    episodes = []

    log.info("[AnimeAV1] %-40s  slug=%-28s  fetching %d eps",
             show["title"][:40], slug[:28], len(to_fetch))

    for n in to_fetch:
        url = f"{ANIMEAV1_BASE}/ver/{slug}-{n}"
        html = get_html(url, delay=EPISODE_DELAY, label="AnimeAV1")
        if html is None:
            log.warning("[AnimeAV1] Failed episode page: %s", url)
            continue
        video = extract_video(html, url, "AnimeAV1")
        episodes.append(build_episode(item_id, n, video, season))

    found_url = sum(1 for e in episodes if e["videoUrl"] or e["externalUrl"])
    log.info("[AnimeAV1] %-40s  %d/%d eps with URL", show["title"][:40], found_url, len(to_fetch))
    return episodes


# ─────────────────────────────────────────────────────────────────────────────
# Episode enrichment orchestrator
# ─────────────────────────────────────────────────────────────────────────────

_SITE_EPISODE_FETCHERS = {
    "animeav1":  ("AnimeAV1", fetch_episodes_animeav1),
    "tioanime":  ("TioAnime", fetch_episodes_tioanime),
    "animeflv":  ("AnimeFLV", fetch_episodes_animeflv),
}


def enrich_episodes(show: dict, max_eps: int, site_keys: list) -> None:
    """
    Try fetching episodes from the show's own source site first,
    then fall back to other sites if that fails.
    Updates show in-place.
    """
    # Prefer the show's own source
    source_lower = show.get("source", "").lower()
    ordered_keys = [source_lower] + [k for k in site_keys if k != source_lower]
    ordered_keys = [k for k in ordered_keys if k in _SITE_EPISODE_FETCHERS]

    for key in ordered_keys:
        site_name, fetcher = _SITE_EPISODE_FETCHERS[key]
        try:
            episodes = fetcher(show, max_eps)
        except Exception as exc:
            log.warning("[episodes] %s raised on %s: %s", site_name, show["title"][:40], exc)
            episodes = []

        if episodes:
            show["episodes"] = episodes
            show["source"]   = site_name
            season_num = show.get("seasonNumber", 1) or 1
            show["seasons"] = [{
                "season":   season_num,
                "title":    f"Season {season_num}",
                "episodes": episodes,
            }]
            log.info("[episodes] %-45s → %d eps from %s",
                     show["title"][:45], len(episodes), site_name)
            return

    log.info("[episodes] %-45s → no episode URLs (metadata-only)", show["title"][:45])


# ─────────────────────────────────────────────────────────────────────────────
# Optional Jikan enrichment
# ─────────────────────────────────────────────────────────────────────────────

def _jikan_search(title: str) -> Optional[dict]:
    """Search Jikan for an anime by title, return first matching raw result."""
    data = get_json(f"{JIKAN_BASE}/anime", params={"q": title, "limit": 5}, delay=JIKAN_DELAY, label="Jikan")
    if not data:
        return None
    results = data.get("data") or []
    if not results:
        return None
    q = title.lower()
    for r in results:
        t = (r.get("title") or "").lower()
        if q in t or t in q or any(w in t for w in q.split() if len(w) > 3):
            return r
    return results[0] if results else None


def enrich_with_jikan(items: list) -> None:
    """
    Optionally enrich catalog items with MAL metadata.
    Adds: synopsis, poster (if missing), score, malId, banner, alternativeTitles.
    One item failure does not affect others.
    """
    log.info("[Jikan] Enriching %d items with MAL metadata", len(items))
    enriched = 0
    for item in items:
        try:
            raw = _jikan_search(item["title"])
            if not raw:
                continue
            mal_id = raw.get("mal_id")
            if mal_id:
                item["malId"] = mal_id
                item["siteUrl"] = item.get("siteUrl") or f"https://myanimelist.net/anime/{mal_id}"
            if not item.get("synopsis"):
                item["synopsis"] = clean(raw.get("synopsis") or "")
                item["description"] = item["synopsis"]
            if not item.get("poster"):
                jpg = (raw.get("images") or {}).get("jpg") or {}
                item["poster"] = jpg.get("large_image_url") or jpg.get("image_url") or ""
                item["image"]  = item["poster"]
            if not item.get("banner"):
                trailer = raw.get("trailer") or {}
                item["banner"] = (trailer.get("images") or {}).get("maximum_image_url") or ""
            if not item.get("score"):
                item["score"]  = raw.get("score")
                item["rating"] = raw.get("score")
            if not item.get("alternativeTitles"):
                alts = []
                for t in raw.get("titles") or []:
                    v = clean(t.get("title") or "")
                    if v and v != item["title"] and v not in alts:
                        alts.append(v)
                item["alternativeTitles"] = alts
            if not item.get("year"):
                aired_obj = raw.get("aired") or {}
                aired_from = (aired_obj.get("from") or "")[:10]
                year = raw.get("year")
                if not year and aired_from:
                    try:
                        year = int(aired_from[:4])
                    except (ValueError, TypeError):
                        pass
                item["year"] = year
            if not item.get("genres"):
                genres_raw = []
                for key in ("genres", "themes", "demographics"):
                    for g in raw.get(key) or []:
                        name = g.get("name") or ""
                        if name and name not in genres_raw:
                            genres_raw.append(name)
                item["genres"] = genres_raw
                item["genre"]  = pick_genre(genres_raw) if genres_raw else item.get("genre", "anime")
            if not item.get("totalEpisodes"):
                item["totalEpisodes"] = raw.get("episodes")
                item["episode"]       = raw.get("episodes")
            enriched += 1
        except Exception as exc:
            log.warning("[Jikan] Enrichment error for '%s': %s", item.get("title", "?"), exc)

    log.info("[Jikan] Enriched %d/%d items", enriched, len(items))


# ─────────────────────────────────────────────────────────────────────────────
# Jikan fallback catalog (used automatically when all primary sites return 0)
# ─────────────────────────────────────────────────────────────────────────────

JIKAN_PAGES_DEFAULT = 4   # 25 items/page × 4 pages = up to 100 per endpoint


def _normalize_jikan_item(anime: dict) -> Optional[dict]:
    """Convert a raw Jikan anime object into our shared schema."""
    mal_id = anime.get("mal_id")
    title  = clean(anime.get("title") or "")
    if not title:
        return None

    # Alternative titles
    alt_titles: list = []
    for t in anime.get("titles") or []:
        v = clean(t.get("title") or "")
        if v and v != title and v not in alt_titles:
            alt_titles.append(v)

    # Images
    jpg    = (anime.get("images") or {}).get("jpg") or {}
    poster = jpg.get("large_image_url") or jpg.get("image_url") or ""

    # Banner from trailer thumbnail
    trailer = anime.get("trailer") or {}
    banner  = (trailer.get("images") or {}).get("maximum_image_url") or ""

    # Genres
    genres_raw: list = []
    for key in ("genres", "themes", "demographics", "explicit_genres"):
        for g in (anime.get(key) or []):
            name = g.get("name") or ""
            if name and name not in genres_raw:
                genres_raw.append(name)

    # Year / aired
    aired_obj  = anime.get("aired") or {}
    aired_from = (aired_obj.get("from") or "")[:10]
    year       = anime.get("year") or None
    if not year and aired_from:
        try:
            year = int(aired_from[:4])
        except (ValueError, TypeError):
            pass

    season_str   = (anime.get("season") or "").capitalize()
    season_num   = detect_season_number(title)
    total_eps    = anime.get("episodes") or None
    score        = anime.get("score") or None

    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:60]
    item_id = f"jikan-{mal_id}" if mal_id else f"jikan-{slug}"

    return {
        "id":                item_id,
        "malId":             mal_id,
        "title":             title,
        "alternativeTitles": alt_titles,
        "synopsis":          clean(anime.get("synopsis") or ""),
        "description":       clean(anime.get("synopsis") or ""),
        "poster":            poster,
        "image":             poster,
        "banner":            banner,
        "genres":            genres_raw,
        "genre":             pick_genre(genres_raw) if genres_raw else "anime",
        "status":            clean(anime.get("status") or ""),
        "type":              clean(anime.get("type") or "TV"),
        "year":              year,
        "season":            season_str,
        "aired":             aired_from,
        "rating":            score,
        "score":             score,
        "source":            "Jikan",
        "siteUrl":           anime.get("url") or (f"https://myanimelist.net/anime/{mal_id}" if mal_id else ""),
        "totalEpisodes":     total_eps,
        "episode":           total_eps,
        "lastScrapedAt":     datetime.now(timezone.utc).isoformat(),
        "episodes":          [],
        "seasons":           [],
        "seasonNumber":      season_num,
        "colors":            ["#40dfc2", "#251d47"],
        "_slug":             slug,
        "_base":             "",
    }


def fetch_catalog_jikan(pages: int = JIKAN_PAGES_DEFAULT) -> list:
    """
    Fallback catalog fetch from Jikan (MyAnimeList wrapper).
    Used automatically when all primary sites (AnimeAV1/TioAnime/AnimeFLV) return 0 items.
    Always works from GitHub Actions — free, public, no auth.
    Endpoints: /seasons/now (current season) + /top/anime?filter=airing (top-rated airing).
    """
    log.info("[Jikan] Fallback catalog fetch started (pages=%d per endpoint)", pages)
    seen: set = set()
    results: list = []

    def _ingest(batch: list) -> int:
        added = 0
        for anime in batch:
            mid = anime.get("mal_id")
            if not mid or mid in seen:
                continue
            seen.add(mid)
            item = _normalize_jikan_item(anime)
            if item:
                results.append(item)
                added += 1
        return added

    # /seasons/now — current season
    for page in range(1, pages + 1):
        data = get_json(f"{JIKAN_BASE}/seasons/now", params={"page": page, "limit": 25},
                        delay=JIKAN_DELAY, label="Jikan")
        if not data:
            log.warning("[Jikan] /seasons/now page %d: no data", page)
            break
        added = _ingest(data.get("data") or [])
        log.info("[Jikan] /seasons/now page %d → +%d  (total %d)", page, added, len(results))
        if not (data.get("pagination") or {}).get("has_next_page"):
            break

    # /top/anime?filter=airing — top-rated currently airing
    top_pages = max(1, pages // 2)
    for page in range(1, top_pages + 1):
        data = get_json(f"{JIKAN_BASE}/top/anime", params={"page": page, "filter": "airing", "limit": 25},
                        delay=JIKAN_DELAY, label="Jikan")
        if not data:
            log.warning("[Jikan] /top/anime page %d: no data", page)
            break
        added = _ingest(data.get("data") or [])
        log.info("[Jikan] /top/airing page %d → +%d  (total %d)", page, added, len(results))
        if not (data.get("pagination") or {}).get("has_next_page"):
            break

    log.info("[Jikan] Fallback catalog complete: %d unique anime", len(results))
    return results


# ─────────────────────────────────────────────────────────────────────────────
# Validation + Save
# ─────────────────────────────────────────────────────────────────────────────

def build_catalog(items: list, sources_used: list) -> dict:
    ep_count = sum(len(i.get("episodes") or []) for i in items)
    source_label = " + ".join(sorted(set(sources_used))) if sources_used else "AnimeAV1/TioAnime/AnimeFLV"
    return {
        "ok":           True,
        "source":       source_label,
        "sources":      sorted(set(sources_used)),
        "scrapedAt":    datetime.now(timezone.utc).isoformat(),
        "totalResults": len(items),
        "count":        len(items),
        "episodeCount": ep_count,
        "items":        items,
    }


def validate(catalog: dict, require_episodes: bool = False) -> tuple:
    items = catalog.get("items") or []
    n = len(items)
    if n == 0:
        return False, "Catalog has 0 items"
    ep_count = sum(len(i.get("episodes") or []) for i in items)
    if require_episodes and ep_count == 0:
        return False, f"{n} anime but 0 episode URLs — episode scraping may have been blocked"
    return True, f"{n} anime, {ep_count} episode URLs"


def save_catalog(catalog: dict) -> None:
    if OUTPUT_JSON.exists():
        shutil.copy2(OUTPUT_JSON, PREV_JSON)
        log.info("[save] Backed up → %s", PREV_JSON.name)
    clean_items = [_strip_internal(i) for i in catalog["items"]]
    catalog_to_save = {**catalog, "items": clean_items}
    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
        json.dump(catalog_to_save, f, ensure_ascii=False, indent=2)
    log.info("[save] ✓ Wrote %s  (%d items, %d episode URLs)",
             OUTPUT_JSON.name, catalog["totalResults"], catalog.get("episodeCount", 0))


def save_csv(items: list) -> None:
    if not items:
        return
    fields = ["id", "title", "type", "status", "year", "season",
              "genre", "rating", "totalEpisodes", "source", "siteUrl"]
    with open(OUTPUT_CSV, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(items)
    log.info("[save] ✓ Wrote %s", OUTPUT_CSV.name)


def load_previous_catalog() -> Optional[dict]:
    """Load the previous catalog if it exists and is non-empty."""
    for path in (PREV_JSON, OUTPUT_JSON):
        if path.exists():
            try:
                with open(path, encoding="utf-8") as f:
                    data = json.load(f)
                if data.get("items"):
                    log.info("[save] Loaded previous catalog from %s (%d items)",
                             path.name, len(data["items"]))
                    return data
            except Exception:
                pass
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

_CATALOG_FETCHERS = {
    "animeav1": ("AnimeAV1", fetch_catalog_animeav1),
    "tioanime": ("TioAnime", fetch_catalog_tioanime),
    "animeflv": ("AnimeFLV", fetch_catalog_animeflv),
}


def run(
    do_episodes:      bool  = True,
    top_n:            int   = 20,
    max_eps:          int   = 5,
    site_keys:        list  = None,
    catalog_pages:    int   = 3,
    jikan_enrich:     bool  = False,
    jikan_fallback:   bool  = True,   # auto-use Jikan when all primary sites fail
    jikan_pages:      int   = JIKAN_PAGES_DEFAULT,
) -> int:
    """
    Main scraper entry point.
    Returns 0 on success.
    Returns 1 only when 0 items from ALL sources (including Jikan fallback)
    AND no valid previous catalog exists.
    """
    site_keys = site_keys or ["animeav1", "tioanime", "animeflv"]
    site_keys = [s.strip().lower() for s in site_keys]
    site_keys = [k for k in site_keys if k in _CATALOG_FETCHERS]
    if not site_keys:
        log.error("No valid sites specified. Use: animeav1, tioanime, animeflv")
        return 1

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print("=" * 70)
    print("  AnimeTV Scraper  (AnimeAV1 + TioAnime + AnimeFLV)")
    print(f"  Sites      : {', '.join(site_keys)}")
    print(f"  Episodes   : {'ON — top ' + str(top_n) + ' shows × max ' + str(max_eps) + ' eps' if do_episodes else 'OFF (metadata-only)'}")
    print(f"  Jikan      : {'fallback ON' if jikan_fallback else 'OFF'}"
          + (" + enrich" if jikan_enrich else ""))
    print(f"  {now_str}")
    print("=" * 70)

    # ── Phase 1: Catalog from primary sites ───────────────────────────────────
    log.info("=== Phase 1: Catalog fetch from %s ===", ", ".join(site_keys))
    all_items: list = []
    sources_used: list = []

    for key in site_keys:
        site_name, fetcher = _CATALOG_FETCHERS[key]
        log.info("[Phase 1] Starting %s", site_name)
        try:
            items = fetcher(catalog_pages)
        except Exception as exc:
            log.error("[Phase 1] %s catalog FAILED: %s", site_name, exc)
            items = []

        if items:
            sources_used.append(site_name)
            log.info("[Phase 1] %s → %d anime", site_name, len(items))
        else:
            log.warning("[Phase 1] %s returned 0 items — may be blocking CI IPs", site_name)

        all_items.extend(items)

    all_items = _dedup(all_items, "_slug")
    log.info("Phase 1 complete: %d unique anime from primary sites (%s)",
             len(all_items), ", ".join(sources_used) or "none")

    # ── Phase 1b: Jikan fallback catalog (when all primary sites return 0) ────
    if not all_items and jikan_fallback:
        log.warning("All primary sites returned 0 items. Trying Jikan fallback catalog...")
        try:
            jikan_items = fetch_catalog_jikan(jikan_pages)
        except Exception as exc:
            log.error("[Jikan fallback] Failed: %s", exc)
            jikan_items = []

        if jikan_items:
            all_items = jikan_items
            sources_used = ["Jikan"]
            log.info("[Jikan fallback] Provided %d anime — catalog will be populated", len(all_items))
        else:
            log.error("[Jikan fallback] Also returned 0 items.")

    # ── No data from any source ───────────────────────────────────────────────
    if not all_items:
        log.error("No items from any source (all sites + Jikan all failed).")
        prev = load_previous_catalog()
        if prev:
            log.warning("Keeping previous valid catalog (%d items). File unchanged, no commit.",
                        len(prev["items"]))
            return 0   # exit 0 — file unchanged → git-auto-commit skips
        log.error("No previous catalog exists. Exiting with code 1.")
        return 1

    # ── Phase 2: Episode scraping ─────────────────────────────────────────────
    if do_episodes and site_keys:
        log.info("=== Phase 2: Episode scraping (top %d shows × max %d eps) ===", top_n, max_eps)

        def _sort_key(x):
            type_order = {"TV": 0, "ONA": 1, "OVA": 2, "SPECIAL": 3, "MOVIE": 4}
            return type_order.get((x.get("type") or "TV").upper(), 9)

        to_enrich = sorted(all_items, key=_sort_key)[:top_n]

        for idx, show in enumerate(to_enrich, 1):
            log.info("[%d/%d] %s  (source=%s)", idx, len(to_enrich),
                     show["title"], show.get("source", "?"))
            try:
                enrich_episodes(show, max_eps, site_keys)
            except Exception as exc:
                log.warning("[Phase 2] Error on %s: %s", show["title"][:40], exc)

        ep_total      = sum(len(i.get("episodes") or []) for i in all_items)
        shows_with_ep = sum(1 for i in all_items if i.get("episodes"))
        video_urls    = sum(sum(1 for e in i.get("episodes", []) if e.get("videoUrl"))  for i in all_items)
        ext_urls      = sum(sum(1 for e in i.get("episodes", []) if e.get("externalUrl")) for i in all_items)
        log.info("Phase 2 complete: %d eps across %d shows | %d videoUrls | %d externalUrls",
                 ep_total, shows_with_ep, video_urls, ext_urls)

    # ── Phase 3 (optional): Jikan metadata enrichment ─────────────────────────
    if jikan_enrich and sources_used != ["Jikan"]:
        # Skip enrichment when Jikan IS the source (items already have full Jikan metadata)
        log.info("=== Phase 3: Jikan metadata enrichment ===")
        try:
            enrich_with_jikan(all_items)
        except Exception as exc:
            log.error("[Phase 3] Jikan enrichment failed: %s — continuing without it", exc)

    # ── Validate + save ───────────────────────────────────────────────────────
    catalog = build_catalog(all_items, sources_used)
    ok, reason = validate(catalog)

    if not ok:
        log.error("Validation FAILED: %s — not overwriting existing catalog", reason)
        return 0   # Don't fail the workflow; just don't write

    log.info("Validation PASSED: %s", reason)
    save_catalog(catalog)
    save_csv(all_items)

    print(f"\n  ✓ Done")
    print(f"    Anime          : {catalog['totalResults']}")
    print(f"    Episode URLs   : {catalog.get('episodeCount', 0)}")
    print(f"    Sources used   : {', '.join(catalog.get('sources') or [])}")
    print("=" * 70)
    return 0


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="AnimeTV primary scraper — AnimeAV1, TioAnime, AnimeFLV",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Full run (default online daily):
  python anime_scraper.py --episodes

  # Top 30 shows, 8 eps each:
  python anime_scraper.py --episodes --top 30 --max-eps 8

  # Only TioAnime and AnimeFLV:
  python anime_scraper.py --episodes --sites tioanime,animeflv

  # With Jikan enrichment for better metadata:
  python anime_scraper.py --episodes --jikan-enrich

  # Disable the automatic Jikan fallback (not recommended for CI):
  python anime_scraper.py --episodes --no-jikan-fallback

  # More catalog pages (more anime in the list):
  python anime_scraper.py --episodes --catalog-pages 6
""",
    )
    parser.add_argument(
        "--episodes", action="store_true",
        help="Fetch episode URLs for top N shows",
    )
    parser.add_argument(
        "--top", type=int, default=20, metavar="N",
        help="How many shows to enrich with episode URLs (default 20)",
    )
    parser.add_argument(
        "--max-eps", type=int, default=5, metavar="N",
        help="Max recent episodes to scrape per show (default 5)",
    )
    parser.add_argument(
        "--sites", type=str, default="animeav1,tioanime,animeflv", metavar="SITES",
        help="Comma-separated site keys: animeav1,tioanime,animeflv (default all)",
    )
    parser.add_argument(
        "--catalog-pages", type=int, default=3, metavar="N",
        help="Catalog HTML pages to fetch per site (default 3)",
    )
    parser.add_argument(
        "--jikan-enrich", action="store_true", default=False,
        help="Add Jikan/MAL metadata enrichment (synopsis, score, poster) to all items",
    )
    parser.add_argument(
        "--jikan-fallback", action="store_true", default=True,
        help="[default ON] Use Jikan as fallback catalog when all primary sites return 0 items",
    )
    parser.add_argument(
        "--no-jikan-fallback", action="store_true", default=False,
        help="Disable the automatic Jikan fallback (not recommended for CI)",
    )
    parser.add_argument(
        "--jikan-pages", type=int, default=JIKAN_PAGES_DEFAULT, metavar="N",
        help=f"Jikan pages per endpoint for fallback catalog (default {JIKAN_PAGES_DEFAULT}; 25 anime/page)",
    )
    # Legacy compat
    parser.add_argument(
        "--no-jikan", action="store_true", default=False,
        help="[legacy] Same as --no-jikan-fallback",
    )

    args = parser.parse_args()

    site_keys      = [s.strip().lower() for s in args.sites.split(",") if s.strip()]
    jikan_enrich   = args.jikan_enrich
    jikan_fallback = not (args.no_jikan_fallback or args.no_jikan)

    code = run(
        do_episodes=args.episodes,
        top_n=args.top,
        max_eps=args.max_eps,
        site_keys=site_keys,
        catalog_pages=args.catalog_pages,
        jikan_enrich=jikan_enrich,
        jikan_fallback=jikan_fallback,
        jikan_pages=args.jikan_pages,
    )
    sys.exit(code)


if __name__ == "__main__":
    main()
