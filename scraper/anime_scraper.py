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
import unicodedata
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
TIOANIME_SLUG_CATALOG_PAGES = 120
_TIOANIME_SLUG_INDEX: Optional[dict] = None

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

# Set to True via --debug flag: prints every URL requested + response headers
DEBUG_MODE = False

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


def _headers(json_mode: bool = False, referer: str = "") -> dict:
    # NOTE: Do NOT add "br" (brotli) to Accept-Encoding unless the `brotli`
    # Python package is installed.  Without it, requests returns raw compressed
    # bytes and r.text / r.json() silently garble the content (shows as \x1b…).
    h = {
        "User-Agent":      next(_ua_cycle),
        "Accept":          ("application/json, text/javascript, */*; q=0.01"
                            if json_mode else
                            "text/html,application/xhtml+xml,application/xml;"
                            "q=0.9,application/json;q=0.8,*/*;q=0.7"),
        "Accept-Language": "es-419,es;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept-Encoding": "gzip, deflate",   # no br — need brotli pkg to decode
        "DNT":             "1",
        "Connection":      "keep-alive",
        "Cache-Control":   "no-cache",
        "Pragma":          "no-cache",
    }
    if referer:
        h["Referer"] = referer
    return h


def http_get(url: str, params=None, json_mode=False, label="",
             referer: str = "") -> Optional[requests.Response]:
    try:
        r = _session.get(url, params=params,
                         headers=_headers(json_mode, referer),
                         timeout=HTTP_TIMEOUT)
        if DEBUG_MODE:
            log.debug("[%s] %d  ct=%s  ce=%s  len=%d  url=%s",
                      label or "http", r.status_code,
                      r.headers.get("Content-Type", "?")[:60],
                      r.headers.get("Content-Encoding", "none"),
                      len(r.content), url[:120])
        if r.status_code == 200:
            return r
        log.warning("[%s] HTTP %d  ct=%s  url=%s",
                    label or "http", r.status_code,
                    r.headers.get("Content-Type", "?")[:50], url[:100])
        return None
    except Exception as exc:
        log.warning("[%s] Error  %s — %s", label or "http", url[:80], exc)
        return None


def _safe_text(r: requests.Response, label: str = "") -> Optional[str]:
    """
    Return the decoded text of a response.
    Warns when the body looks like raw binary (likely un-decoded brotli / zstd).
    """
    try:
        text = r.text
        # Heuristic: if more than 5 % of the first 512 chars are non-printable
        # (outside ASCII printable range), the content was not decoded.
        sample = text[:512]
        non_printable = sum(1 for c in sample if ord(c) < 32 and c not in "\t\n\r")
        if len(sample) > 20 and non_printable / len(sample) > 0.05:
            ct = r.headers.get("Content-Type", "?")
            ce = r.headers.get("Content-Encoding", "none")
            log.warning("[%s] Response body looks binary/compressed — "
                        "ct=%s  ce=%s  body(hex)=%s",
                        label, ct, ce, r.content[:32].hex())
            return None
        return text
    except Exception as exc:
        log.warning("[%s] Text decode error: %s", label, exc)
        return None


def get_html(url: str, delay: float = CATALOG_DELAY, label: str = "",
             referer: str = "") -> Optional[str]:
    r = http_get(url, label=label, referer=referer)
    if r is None:
        return None
    if delay:
        time.sleep(delay)
    return _safe_text(r, label)


def get_json(url: str, params=None, delay: float = 0.0, label: str = "",
             referer: str = ""):
    r = http_get(url, params=params, json_mode=True, label=label, referer=referer)
    if r is None:
        return None
    if delay:
        time.sleep(delay)
    try:
        return r.json()
    except Exception as exc:
        ct = r.headers.get("Content-Type", "?")
        ce = r.headers.get("Content-Encoding", "none")
        log.warning("[%s] JSON parse error: %s  ct=%s  ce=%s  body=%r",
                    label, exc, ct, ce, r.content[:200])
        return None


def _ajax_get_json(url: str, params=None, referer: str = "", label: str = ""):
    """
    GET JSON with XMLHttpRequest (AJAX) headers.

    TioAnime /api/search and AnimeFLV /api/animes/search check for the
    X-Requested-With header and return an empty body (200 but no content)
    when a normal browser GET is made.  This wrapper adds the required
    headers so the server returns proper JSON.

    Accept-Encoding intentionally omits "br" (brotli) — the brotli Python
    package is not installed so compressed brotli responses cannot be decoded.
    Without the header the server falls back to gzip or plain text.
    """
    headers = {
        "User-Agent":       next(_ua_cycle),
        "Accept":           "application/json, text/javascript, */*; q=0.01",
        "Accept-Language":  "es-419,es;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept-Encoding":  "gzip, deflate",   # no br — need brotli pkg to decode
        "X-Requested-With": "XMLHttpRequest",
        "Referer":          referer or url,
        "DNT":              "1",
        "Connection":       "keep-alive",
        "Cache-Control":    "no-cache",
        "Pragma":           "no-cache",
    }
    try:
        r = _session.get(url, params=params, headers=headers, timeout=HTTP_TIMEOUT)
        if DEBUG_MODE:
            log.debug("[%s] AJAX %d  ct=%s  ce=%s  len=%d  url=%s",
                      label or "ajax", r.status_code,
                      r.headers.get("Content-Type", "?")[:60],
                      r.headers.get("Content-Encoding", "none"),
                      len(r.content), url[:120])
        if r.status_code == 200:
            try:
                return r.json()
            except Exception as exc:
                ct  = r.headers.get("Content-Type", "?")
                ce  = r.headers.get("Content-Encoding", "none")
                log.warning("[%s] AJAX JSON parse error: %s  ct=%s  ce=%s  body=%r",
                            label or "ajax", exc, ct, ce, r.content[:200])
                return None
        log.warning("[%s] AJAX HTTP %d  ct=%s  url=%s",
                    label or "ajax", r.status_code,
                    r.headers.get("Content-Type", "?")[:50], url[:100])
        return None
    except Exception as exc:
        log.warning("[%s] AJAX error  %s — %s", label or "ajax", url[:80], exc)
        return None


# ─────────────────────────────────────────────────────────────────────────────
# Shared utilities
# ─────────────────────────────────────────────────────────────────────────────

def clean(v) -> str:
    return re.sub(r"\s+", " ", str(v or "")).strip()


def normalize_lookup_title(value: str) -> str:
    text = unicodedata.normalize("NFD", str(value or "").lower())
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = re.sub(r"[^a-z0-9]+", " ", text)
    text = re.sub(r"\b(season|part|tv|ova|ona|the|a|an)\b", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def strip_season_words(title: str) -> str:
    return clean(
        re.sub(
            r"\b(?:season|part|cour)\s*\d+\b|\b\d+(?:st|nd|rd|th)\s*season\b",
            " ",
            str(title or ""),
            flags=re.IGNORECASE,
        )
    )


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

    The link regex accepts both relative paths (/anime/slug) and absolute
    URLs with ANY host (https://www4.animeflv.net/anime/slug,
    https://animeflv.net/anime/slug, etc.) so subdomain variants don't
    cause silent misses.
    """
    link_re = re.compile(
        r'href=["\'](?:https?://[^/"\']{0,120})?'
        r'(/(?:anime|ver-anime|animes)/([a-z0-9][a-z0-9\-_%]{1,150}))["\']',
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
        link_pos_in_ctx = m.start() - cs
        ctx_after = ctx[link_pos_in_ctx:]
        for pat in [
            r'<h[1-4][^>]*>\s*(?:<a[^>]*>)?\s*([^<\n]{2,100}?)\s*(?:</a>)?\s*</h[1-4]>',
            r'class="[^"]*(?:title|titulo|nombre|name)[^"]*"[^>]*>\s*(?:<a[^>]*>)?\s*([^<\n]{2,100}?)\s*',
            r'<p[^>]*>\s*([A-Z][^<\n]{1,90})\s*</p>',
            r'title=["\']([^"\']{2,100})["\']',
        ]:
            tm = re.search(pat, ctx_after, re.IGNORECASE)
            if tm and tm.start() < 350:
                cand = clean(tm.group(1))
                if 2 <= len(cand) <= 120 and not cand.startswith(("<", "http", "{")):
                    title = cand
                    break

        if not title:
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
# Title-matching helpers (used for slug search / cross-site episode fetching)
# ─────────────────────────────────────────────────────────────────────────────

_RE_CJK = re.compile(r'[　-鿿豈-﫿︰-﹏一-鿿]')


def _is_cjk_heavy(text: str) -> bool:
    """Return True when text contains CJK (Japanese/Chinese) script characters."""
    return bool(_RE_CJK.search(text or ""))


def _search_titles(show: dict) -> list:
    """
    Return an ordered list of search-friendly titles for a show.

    Priority order:
    1. Pure ASCII alternative titles (typically English/Spanish)
    2. Non-CJK alternative titles
    3. The main title

    When Jikan is the catalog source the main title is often Japanese-romanized
    (e.g. "Tongari Boushi no Atelier") while the English alternative
    (e.g. "Witch Hat Atelier") matches the site slug better.
    """
    main = show.get("title") or ""
    alts = show.get("alternativeTitles") or []

    result: list = []
    seen: set = set()

    def _add(t: str) -> None:
        t = clean(t)
        if t and t not in seen:
            seen.add(t)
            result.append(t)

    # ASCII-only alts first (most likely to be Spanish/English display titles)
    for alt in alts:
        if re.match(r'^[\x00-\x7f]+$', alt or ""):
            _add(alt)

    # Non-CJK alts next
    for alt in alts:
        if not _is_cjk_heavy(alt):
            _add(alt)

    # Main title last
    _add(main)

    return result


def _titles_match(a: str, b: str, threshold: float = 0.45) -> bool:
    """
    Fuzzy title comparison — True when the titles likely refer to the same anime.

    Uses word-overlap ratio so minor punctuation/article differences are ignored.
    threshold=0.45 means ~half the meaningful words must overlap.
    """
    def _norm(t: str) -> set:
        return {w for w in re.split(r'[^a-z0-9]+', t.lower()) if len(w) >= 3}

    if not a or not b:
        return False
    a_clean = re.sub(r'[^a-z0-9 ]', ' ', a.lower()).strip()
    b_clean = re.sub(r'[^a-z0-9 ]', ' ', b.lower()).strip()
    if a_clean == b_clean:
        return True
    if len(a_clean) > 5 and (a_clean in b_clean or b_clean in a_clean):
        return True
    wa, wb = _norm(a), _norm(b)
    if not wa or not wb:
        return False
    overlap = len(wa & wb) / min(len(wa), len(wb))
    return overlap >= threshold


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
        html = get_html(url, delay=CATALOG_DELAY, label="TioAnime",
                        referer=TIOANIME_BASE)
        if not html:
            log.warning("[TioAnime] Could not fetch directorio page %d", page)
            break
        items = _parse_catalog_html(html, TIOANIME_BASE, "TioAnime")
        if not items:
            break
        n = _add(items)
        html_found = True
        log.info("[TioAnime] /directorio page %d → +%d  (total %d)", page, n, len(results))
        if len(items) < 5:
            break  # last page

    # ── Strategy 2: /emision (currently airing) ──
    html = get_html(f"{TIOANIME_BASE}/emision", delay=CATALOG_DELAY, label="TioAnime",
                    referer=TIOANIME_BASE)
    if html:
        items = _parse_catalog_html(html, TIOANIME_BASE, "TioAnime")
        n = _add(items)
        log.info("[TioAnime] /emision → +%d  (total %d)", n, len(results))
        html_found = html_found or bool(items)

    # ── Strategy 3: search-API fallback (uses XHR headers — required!) ──
    if not html_found or len(results) < 10:
        log.info("[TioAnime] Falling back to AJAX search API")
        for term in BROAD_TERMS[:20]:
            data = _ajax_get_json(
                f"{TIOANIME_BASE}/api/search",
                params={"q": term},
                referer=TIOANIME_BASE,
                label="TioAnime",
            )
            time.sleep(SEARCH_DELAY)
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


def _tioanime_slug_title_keys(title: str, slug: str = "") -> list:
    keys = []
    for value in [title, strip_season_words(title), slug.replace("-", " ")]:
        key = normalize_lookup_title(value)
        if key and key not in keys:
            keys.append(key)
    return keys


def _ensure_tioanime_slug_index(max_pages: int = TIOANIME_SLUG_CATALOG_PAGES) -> dict:
    """
    Build a title -> slug map from TioAnime's full directory.
    This is used before AJAX search so metadata/Jikan titles can resolve to
    exact /anime/<slug> values from tioanime.com.
    """
    global _TIOANIME_SLUG_INDEX
    if _TIOANIME_SLUG_INDEX is not None:
        return _TIOANIME_SLUG_INDEX

    by_title = {}
    seen = set()
    log.info("[TioAnime] Building full slug index (%d directory pages max)", max_pages)

    def _add(items: list) -> int:
        added = 0
        for item in items:
            slug = item.get("_slug") or item.get("slug") or ""
            title = item.get("title") or ""
            if not slug or not title:
                continue
            if slug not in seen:
                seen.add(slug)
                added += 1
            for key in _tioanime_slug_title_keys(title, slug):
                by_title.setdefault(key, slug)
        return added

    for page in range(1, max_pages + 1):
        url = f"{TIOANIME_BASE}/directorio?p={page}" if page > 1 else f"{TIOANIME_BASE}/directorio"
        html = get_html(url, delay=CATALOG_DELAY, label="TioAnime", referer=TIOANIME_BASE)
        if not html:
            break
        parsed = _parse_catalog_html(html, TIOANIME_BASE, "TioAnime")
        added = _add(parsed)
        if not parsed or len(parsed) == 0:
            break

    html = get_html(f"{TIOANIME_BASE}/emision", delay=CATALOG_DELAY, label="TioAnime", referer=TIOANIME_BASE)
    if html:
        _add(_parse_catalog_html(html, TIOANIME_BASE, "TioAnime"))

    _TIOANIME_SLUG_INDEX = by_title
    log.info("[TioAnime] Slug index ready: %d title keys for %d slugs", len(by_title), len(seen))
    return _TIOANIME_SLUG_INDEX


def _tioanime_find_slug_by_catalog(show: dict) -> str:
    index = _ensure_tioanime_slug_index()
    for title in _search_titles(show):
        for value in [title, strip_season_words(title)]:
            slug = index.get(normalize_lookup_title(value))
            if slug:
                log.debug("[TioAnime] slug-index hit: '%s' → %s", title[:40], slug)
                return slug
    return ""


def _tioanime_find_slug_by_search(show: dict) -> str:
    """
    Search TioAnime by title to find the correct slug when the item's own
    slug (often derived from a Japanese-romanized Jikan title) returns 404.

    Uses the AJAX search endpoint with X-Requested-With headers which is
    required for TioAnime to return JSON instead of an empty body.

    Returns the best-matching slug string, or "" if nothing found.
    """
    indexed = _tioanime_find_slug_by_catalog(show)
    if indexed:
        return indexed

    queries = _search_titles(show)[:3]
    main_title = show.get("title") or ""

    for query in queries:
        data = _ajax_get_json(
            f"{TIOANIME_BASE}/api/search",
            params={"q": query[:60]},
            referer=TIOANIME_BASE,
            label="TioAnime",
        )
        time.sleep(SEARCH_DELAY)
        if not data:
            continue
        entries = (
            data if isinstance(data, list)
            else (data.get("animes") or data.get("data") or data.get("results") or [])
        )
        for entry in entries:
            slug = (entry.get("slug") or entry.get("id") or "").strip()
            if not slug:
                continue
            entry_title = clean(entry.get("title") or entry.get("name") or "")
            if _titles_match(query, entry_title) or _titles_match(main_title, entry_title):
                log.debug("[TioAnime] slug-search hit: '%s' → %s", query[:40], slug)
                return slug

    return ""


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
        slug = su.rstrip("/").rsplit("/", 1)[-1] if (su and "tioanime.com" in su) else ""
    if not slug:
        log.debug("[TioAnime] No slug for %s", show["title"])
        return []

    ep_nums = _tio_ep_nums_from_detail(slug)

    # ── Slug mismatch? Try title-based search ──────────────────────────────
    # Happens when the catalog came from Jikan: slugs are derived from
    # Japanese-romanized titles but TioAnime uses English/Spanish slugs.
    if not ep_nums:
        found = _tioanime_find_slug_by_search(show)
        if found and found != slug:
            log.info("[TioAnime] Slug resolved via search: %r → %r  ('%s')",
                     slug, found, show["title"][:40])
            slug = found
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

    AnimeFLV catalog lives at /browse (paginated with ?page=N).
    Tries: 1) /browse?order=updated&page=N  2) /browse?page=N  3) AJAX search API.

    Slugs are extracted directly from the /anime/<slug> hrefs on the browse
    pages — no Jikan-derived path guessing.
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

    # ── Strategy 1: /browse pages (explicit URL construction) ──
    # Page 1: /browse?order=updated
    # Page N: /browse?order=updated&page=N
    html_found = False
    for page in range(1, catalog_pages + 1):
        if page == 1:
            url = f"{ANIMEFLV_BASE}/browse?order=updated"
        else:
            url = f"{ANIMEFLV_BASE}/browse?order=updated&page={page}"
        html = get_html(url, delay=CATALOG_DELAY, label="AnimeFLV",
                        referer=ANIMEFLV_BASE)
        if not html:
            log.warning("[AnimeFLV] Could not fetch /browse page %d", page)
            break
        items = _parse_catalog_html(html, ANIMEFLV_BASE, "AnimeFLV")
        if not items:
            log.info("[AnimeFLV] /browse page %d parsed 0 items — stopping", page)
            # Try plain /browse on page 1 in case order= param broke it
            if page == 1:
                html2 = get_html(f"{ANIMEFLV_BASE}/browse", delay=CATALOG_DELAY,
                                 label="AnimeFLV", referer=ANIMEFLV_BASE)
                if html2:
                    items = _parse_catalog_html(html2, ANIMEFLV_BASE, "AnimeFLV")
            if not items:
                break
        n = _add(items)
        html_found = True
        log.info("[AnimeFLV] /browse page %d → +%d  (total %d)", page, n, len(results))
        if len(items) < 5:
            break   # reached last page

    # ── Strategy 2: AJAX search-API fallback (uses XHR headers — required!) ──
    if not html_found or len(results) < 10:
        log.info("[AnimeFLV] Falling back to AJAX search API")
        for term in BROAD_TERMS[:20]:
            data = _ajax_get_json(
                f"{ANIMEFLV_BASE}/api/animes/search",
                params={"value": term},
                referer=ANIMEFLV_BASE,
                label="AnimeFLV",
            )
            time.sleep(SEARCH_DELAY)
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


def _animeflv_find_slug_by_search(show: dict) -> str:
    """
    Search AnimeFLV by title to find the correct slug when the item's own
    slug doesn't match AnimeFLV's URL convention.

    AnimeFLV /api/animes/search also requires X-Requested-With: XMLHttpRequest.

    Returns the best-matching slug string, or "" if nothing found.
    """
    queries = _search_titles(show)[:3]
    main_title = show.get("title") or ""

    for query in queries:
        data = _ajax_get_json(
            f"{ANIMEFLV_BASE}/api/animes/search",
            params={"value": query[:60]},
            referer=ANIMEFLV_BASE,
            label="AnimeFLV",
        )
        time.sleep(SEARCH_DELAY)
        if not data or not isinstance(data, list):
            continue
        for entry in data:
            slug = (entry.get("slug") or entry.get("id") or "").strip()
            if not slug:
                continue
            entry_title = clean(entry.get("title") or entry.get("name") or "")
            if _titles_match(query, entry_title) or _titles_match(main_title, entry_title):
                log.debug("[AnimeFLV] slug-search hit: '%s' → %s", query[:40], slug)
                return slug

    return ""


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
        slug = su.rstrip("/").rsplit("/", 1)[-1] if (su and "animeflv" in su) else ""
    if not slug:
        log.debug("[AnimeFLV] No slug for %s", show["title"])
        return []

    ep_nums = _flv_ep_nums_from_detail(slug)

    # ── Slug mismatch? Try title-based search ──────────────────────────────
    if not ep_nums:
        found = _animeflv_find_slug_by_search(show)
        if found and found != slug:
            log.info("[AnimeFLV] Slug resolved via search: %r → %r  ('%s')",
                     slug, found, show["title"][:40])
            slug = found
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


def _animeav1_discover_catalog_url(homepage_html: str) -> Optional[str]:
    """
    Scan AnimeAV1 homepage HTML for a nav-level catalog/directory link.
    Returns the first match as an absolute URL, or None.
    """
    # Common Spanish/English catalog path names
    _CATALOG_RE = re.compile(
        r'href=["\'](?:' + re.escape(ANIMEAV1_BASE) + r')?'
        r'(/(?:directorio|catalogo|catalog|series|anime-list|lista|browse|animes?)[^"\'?#]{0,60})["\']',
        re.IGNORECASE,
    )
    m = _CATALOG_RE.search(homepage_html)
    if m:
        return abs_url(m.group(1), ANIMEAV1_BASE)
    return None


def _animeav1_paginate_catalog(catalog_base_url: str, catalog_pages: int,
                                add_fn) -> bool:
    """
    Fetch catalog_pages pages starting from catalog_base_url.
    Appends ?p=N or &p=N for pages > 1 (AnimeAV1/TioAnime convention).
    Returns True if at least one page yielded anime cards.
    """
    found_any = False
    sep = "&" if "?" in catalog_base_url else "?"
    for page in range(1, catalog_pages + 1):
        url = catalog_base_url if page == 1 else f"{catalog_base_url}{sep}p={page}"
        html = get_html(url, delay=CATALOG_DELAY, label="AnimeAV1",
                        referer=ANIMEAV1_BASE)
        if not html:
            log.warning("[AnimeAV1] Page %d fetch failed: %s", page, url)
            break
        items = _parse_catalog_html(html, ANIMEAV1_BASE, "AnimeAV1")
        if not items:
            log.debug("[AnimeAV1] Page %d parsed 0 items — stopping pagination", page)
            break
        n = add_fn(items)
        found_any = True
        log.info("[AnimeAV1] catalog page %d  url=%s  → +%d", page, url[:80], n)
        if len(items) < 5:
            break   # last page
    return found_any


def fetch_catalog_animeav1(catalog_pages: int = 3) -> list:
    """
    Fetch anime catalog from AnimeAV1.

    Strategy:
    1. Fetch homepage → discover catalog/directory URL from nav links
    2. Paginate that catalog URL
    3. Also parse homepage itself for recent/featured anime
    4. Try /emision (currently airing) page
    5. AJAX search-API fallback with XHR headers
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

    html_found = False

    # ── Strategy 1: Fetch homepage → discover catalog URL ──
    homepage_html = get_html(ANIMEAV1_BASE, delay=CATALOG_DELAY, label="AnimeAV1",
                             referer=ANIMEAV1_BASE)
    if homepage_html:
        # Parse homepage itself for recent anime cards
        items = _parse_catalog_html(homepage_html, ANIMEAV1_BASE, "AnimeAV1")
        n = _add(items)
        if n:
            html_found = True
            log.info("[AnimeAV1] homepage → +%d  (total %d)", n, len(results))

        # Discover and paginate the catalog URL from nav links
        cat_url = _animeav1_discover_catalog_url(homepage_html)
        if cat_url:
            log.info("[AnimeAV1] Discovered catalog URL: %s", cat_url)
            ok = _animeav1_paginate_catalog(cat_url, catalog_pages, _add)
            html_found = html_found or ok
        else:
            log.info("[AnimeAV1] No catalog URL discovered in homepage nav")

    # ── Strategy 2: /emision (currently airing) ──
    if not html_found or len(results) < 5:
        html = get_html(f"{ANIMEAV1_BASE}/emision", delay=CATALOG_DELAY,
                        label="AnimeAV1", referer=ANIMEAV1_BASE)
        if html:
            items = _parse_catalog_html(html, ANIMEAV1_BASE, "AnimeAV1")
            n = _add(items)
            html_found = html_found or bool(items)
            log.info("[AnimeAV1] /emision → +%d  (total %d)", n, len(results))

    # ── Strategy 3: AJAX search-API fallback (with XHR headers) ──
    if not results:
        log.info("[AnimeAV1] Falling back to AJAX search API")
        for term in BROAD_TERMS[:15]:
            data = _ajax_get_json(
                f"{ANIMEAV1_BASE}/api/search", params={"q": term},
                referer=ANIMEAV1_BASE, label="AnimeAV1",
            )
            time.sleep(SEARCH_DELAY)
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
        log.info("[AnimeAV1] After AJAX search: %d anime", len(results))

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
        log.info("[save] Backed up to %s", PREV_JSON.name)
    clean_items = [_strip_internal(i) for i in catalog["items"]]
    catalog_to_save = {**catalog, "items": clean_items}
    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
        json.dump(catalog_to_save, f, ensure_ascii=False, indent=2)
    log.info("[save] Wrote %s  (%d items, %d episode URLs)",
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
    log.info("[save] Wrote %s", OUTPUT_CSV.name)


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

    print("\n  OK Done")
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

  # Debug mode (print every URL + response headers):
  python anime_scraper.py --debug --sites tioanime
""",
    )
    parser.add_argument(
        "--episodes", action="store_true",
        help="Fetch episode URLs for top N shows",
    )
    parser.add_argument(
        "--debug", action="store_true", default=False,
        help="Print every requested URL and response headers (verbose)",
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

    # Apply debug mode globally before any network calls
    if args.debug:
        global DEBUG_MODE
        DEBUG_MODE = True
        logging.getLogger("anime-scraper").setLevel(logging.DEBUG)
        log.debug("Debug mode ON — all URLs and response headers will be logged")

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
