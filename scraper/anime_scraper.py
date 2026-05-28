#!/usr/bin/env python3
"""
AnimeTV Metadata Scraper  —  anime_scraper.py
==============================================
Scrapes anime metadata AND episode stream URLs from three Spanish-language sites:

  • https://tioanime.com
  • https://www4.animeflv.net
  • https://jkanime.net

Powered by Scrapling  (pip install "scrapling[all]")
  StealthyFetcher  – stealth Playwright/Camoufox browser, bypasses Cloudflare
  auto_save=True   – fingerprints each matched element on first run
  auto_match=True  – relocates elements by fingerprint after site redesigns

NOTE — Scrapling API clarifications vs. common misconceptions
--------------------------------------------------------------
  ✗  StealthyFetcher(auto_match=True)   ← auto_match is NOT a constructor arg
  ✓  StealthyFetcher()                  ← create the fetcher without options

  ✗  StealthyFetcher.adaptive = True    ← not a class attribute
  ✓  page.css(".sel", auto_match=True)  ← pass per selector call

  ✗  item.css("a").attrib["href"]       ← css() returns a list, not one element
  ✓  item.css_first("a").attrib["href"] ← css_first() returns one Adaptor or None

Quick start
-----------
  pip install "scrapling[all]"
  scrapling install                  # download Camoufox browser binaries (~200 MB)
  python anime_scraper.py            # metadata only (fast)
  python anime_scraper.py --episodes --top 20 --max-eps 5   # + video URLs (slow)
  python anime_scraper.py --schedule 6   # repeat every 6 hours

Episode URL scraping
--------------------
  By default the scraper only collects metadata (title, image, synopsis, etc.)
  which is fast. Pass --episodes to also visit each show's episode pages and
  extract playable video URLs / iframe embed URLs.

  --top N       only scrape episodes for the N most-active shows per site
                (sorted by latest-episode number, default 20)
  --max-eps N   max episodes to scrape per show (most-recent first, default 5)
  --ep-workers N  concurrent episode-page fetches across all sites (default 3)

  Episode URLs are cached in scraper/.episode_cache/ for 24 hours so re-runs
  skip unchanged shows.

Output
------
  scraper/anime_metadata.json  →  served by AnimeTV at /api/scraped-catalog
  scraper/anime_metadata.csv   →  human-readable backup
"""

from __future__ import annotations

import asyncio
import csv
import hashlib
import json
import re
import sys
import time
import argparse
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Scrapling import (with helpful error if not installed)
# ---------------------------------------------------------------------------
try:
    from scrapling.fetchers import StealthyFetcher
except ImportError:
    sys.exit(
        "\n[ERROR] Scrapling is not installed.\n"
        "  pip install \"scrapling[all]\"\n"
        "  scrapling install\n"
    )

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SCRIPT_DIR         = Path(__file__).parent
OUTPUT_JSON        = SCRIPT_DIR / "anime_metadata.json"
OUTPUT_CSV         = SCRIPT_DIR / "anime_metadata.csv"
EPISODE_CACHE_DIR  = SCRIPT_DIR / ".episode_cache"
MAX_ITEMS_PER_SITE = 500
PAGE_TIMEOUT_MS    = 35_000   # ms — passed to StealthyFetcher
CONCURRENT_SITES   = 3        # how many site scrapers run concurrently
EP_CACHE_TTL       = 60 * 60 * 24  # seconds — 24h episode cache

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("anime-scraper")


# ---------------------------------------------------------------------------
# General helpers
# ---------------------------------------------------------------------------

def clean(value: str | None) -> str:
    """Strip and collapse whitespace."""
    if not value:
        return ""
    return re.sub(r"\s+", " ", str(value).strip())


def abs_url(href: str | None, base: str) -> str:
    """Make relative URLs absolute."""
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
    return base.rstrip("/") + "/" + href.lstrip("/")


def lazy_img(el) -> str:
    """Many anime sites use data-src for lazy-loaded images."""
    if el is None:
        return ""
    return el.attrib.get("data-src") or el.attrib.get("src") or ""


def parse_episode_number(text: str) -> Optional[int]:
    """Extract the last integer from a string like 'Episodio 12' → 12."""
    if not text:
        return None
    nums = re.findall(r"\d+", text)
    return int(nums[-1]) if nums else None


def _get_html(page) -> str:
    """Get raw HTML string from a Scrapling page/Adaptor object."""
    try:
        if hasattr(page, "html") and page.html:
            return str(page.html)
        if hasattr(page, "body") and page.body:
            return str(page.body)
    except Exception:
        pass
    return str(page)


# Genre normalisation map (mirrors client-side pickGenre in js/utils.js)
_GENRE_MAP = {
    "accion": "action", "acción": "action", "action": "action",
    "comedia": "comedy", "comedy": "comedy",
    "fantasia": "fantasy", "fantasía": "fantasy", "fantasy": "fantasy",
    "romance": "romance",
    "drama": "drama",
    "aventura": "action", "adventure": "action",
    "terror": "drama", "horror": "drama",
    "misterio": "drama", "mystery": "drama",
    "sobrenatural": "fantasy", "supernatural": "fantasy",
    "sci-fi": "fantasy", "ciencia ficcion": "fantasy",
}


def pick_genre(genres: list[str]) -> str:
    for g in genres:
        mapped = _GENRE_MAP.get(g.lower().strip())
        if mapped:
            return mapped
    return genres[0].lower().strip() if genres else "anime"


# ---------------------------------------------------------------------------
# Episode disk cache
# ---------------------------------------------------------------------------

def _cache_key(url: str) -> str:
    return hashlib.md5(url.encode()).hexdigest()


def _read_ep_cache(url: str) -> list[dict] | None:
    """Return cached episodes, or None if missing / older than EP_CACHE_TTL."""
    path = EPISODE_CACHE_DIR / f"{_cache_key(url)}.json"
    if not path.exists():
        return None
    if time.time() - path.stat().st_mtime > EP_CACHE_TTL:
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _write_ep_cache(url: str, episodes: list[dict]) -> None:
    """Persist episodes list to disk for 24 h caching."""
    EPISODE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = EPISODE_CACHE_DIR / f"{_cache_key(url)}.json"
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(episodes, f, ensure_ascii=False)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# VideoExtractor — multi-strategy playable URL extraction
# ---------------------------------------------------------------------------

class VideoExtractor:
    """
    Extract a playable video URL or iframe embed URL from an episode page's
    raw HTML. Tries multiple patterns in priority order, returns the first hit.

    Supported patterns
    ------------------
    1.  TioAnime / generic array :  var videos = [["SW","url"], ...]
    2.  AnimeFLV-style dict      :  var videos = {"SUB":[["SW","url"]],...}
    3.  Any non-ad iframe embed
    4.  <video>/<source> tag src
    5.  Bare .m3u8 / .mp4 URL anywhere in HTML
    """

    # JS variable patterns
    _RE_ARRAY  = re.compile(r'var\s+videos\s*=\s*(\[[\s\S]*?\]);',  re.DOTALL)
    _RE_DICT   = re.compile(r'var\s+videos\s*=\s*(\{[\s\S]*?\});',  re.DOTALL)

    # HTML patterns
    _RE_IFRAME = re.compile(
        r'<iframe[^>]+\bsrc=["\']([^"\'#][^"\']*)["\']', re.IGNORECASE
    )
    _RE_VIDEO  = re.compile(
        r'<(?:video|source)[^>]+\bsrc=["\']([^"\']+\.(?:mp4|m3u8)[^"\']*)["\']',
        re.IGNORECASE,
    )
    _RE_DIRECT = re.compile(
        r'https?://[^\s"\'<>]+\.(?:m3u8|mp4)(?:\?[^\s"\'<>]*)?'
    )

    # Provider names we skip (trailers, ads)
    _SKIP_NAMES = frozenset({"yt", "youtube", "trailer", "ad", "ads", "promo"})

    # Domains we skip for iframes (analytics, ads)
    _BAD_IFRAME_DOMAINS = (
        "googlesyndication", "google-analytics", "facebook.com/plugins",
        "disqus", "addthis", "doubleclick", "googletag", "amazon-adsystem",
        "scorecardresearch",
    )

    @classmethod
    def extract(cls, html: str, page_url: str, site: str) -> dict:
        """
        Returns a dict with keys:
            videoUrl     – direct .mp4/.m3u8 URL, or empty string
            externalUrl  – iframe embed URL, or empty string
            externalType – "iframe" when externalUrl is set, else empty string
            server       – site name
        """
        out = {"videoUrl": "", "externalUrl": "", "externalType": "", "server": site}

        # ── 1. TioAnime/generic array ─────────────────────────────────────
        m = cls._RE_ARRAY.search(html)
        if m:
            direct, embed = cls._pick_from_array(m.group(1))
            if direct:
                out["videoUrl"] = direct
                return out
            if embed:
                out["externalUrl"] = embed
                out["externalType"] = "iframe"
                return out

        # ── 2. AnimeFLV-style dict ────────────────────────────────────────
        m = cls._RE_DICT.search(html)
        if m:
            direct, embed = cls._pick_from_dict(m.group(1))
            if direct:
                out["videoUrl"] = direct
                return out
            if embed:
                out["externalUrl"] = embed
                out["externalType"] = "iframe"
                return out

        # ── 3. Any plausible iframe ───────────────────────────────────────
        for m in cls._RE_IFRAME.finditer(html):
            src = m.group(1).strip()
            if src and not any(bad in src for bad in cls._BAD_IFRAME_DOMAINS):
                out["externalUrl"] = abs_url(src, page_url)
                out["externalType"] = "iframe"
                return out

        # ── 4. <video>/<source> tag ───────────────────────────────────────
        m = cls._RE_VIDEO.search(html)
        if m:
            out["videoUrl"] = abs_url(m.group(1), page_url)
            return out

        # ── 5. Bare .m3u8 / .mp4 URL ─────────────────────────────────────
        m = cls._RE_DIRECT.search(html)
        if m:
            out["videoUrl"] = m.group(0)
            return out

        return out  # nothing found

    @classmethod
    def _pick_from_array(cls, raw: str) -> tuple[str, str]:
        """Parse  [["SW","url"],...].  Returns (direct_url, embed_url)."""
        try:
            arr = json.loads(raw)
        except Exception:
            return "", ""
        if not isinstance(arr, list):
            return "", ""
        direct = embed = ""
        for entry in arr:
            if not isinstance(entry, (list, tuple)) or len(entry) < 2:
                continue
            name = str(entry[0]).strip().lower()
            url  = str(entry[1]).strip()
            if not url or name in cls._SKIP_NAMES:
                continue
            if url.endswith(".m3u8") or url.endswith(".mp4"):
                if not direct:
                    direct = url
            elif not embed:
                embed = url
        return direct, embed

    @classmethod
    def _pick_from_dict(cls, raw: str) -> tuple[str, str]:
        """Parse  {"SUB":[["SW","url"]],...}.  Returns (direct_url, embed_url)."""
        try:
            obj = json.loads(raw)
        except Exception:
            return "", ""
        if not isinstance(obj, dict):
            return "", ""
        direct = embed = ""
        for track in ("SUB", "LAT", "ESP", "DUB"):
            for entry in obj.get(track, []):
                if not isinstance(entry, (list, tuple)) or len(entry) < 2:
                    continue
                name = str(entry[0]).strip().lower()
                url  = str(entry[1]).strip()
                if not url or name in cls._SKIP_NAMES:
                    continue
                if url.endswith(".m3u8") or url.endswith(".mp4"):
                    if not direct:
                        direct = url
                elif not embed:
                    embed = url
            if direct or embed:
                break
        return direct, embed


# ---------------------------------------------------------------------------
# Episode-number extractor (shared utility)
# ---------------------------------------------------------------------------

# Regex shared across all sites: var episodes = [[12,0],[11,0],...]
_RE_EP_VAR = re.compile(r'var\s+episodes\s*=\s*(\[[\s\S]*?\]);', re.DOTALL)


def _ep_nums_from_script(html: str) -> list[int]:
    """
    Extract episode numbers from 'var episodes = [[N,...],...]' JS variable.
    Returns sorted unique list ascending, e.g. [1,2,3,...,24].
    """
    m = _RE_EP_VAR.search(html)
    if not m:
        return []
    try:
        arr = json.loads(m.group(1))
        nums = []
        for entry in arr:
            if isinstance(entry, (list, tuple)) and entry:
                n = entry[0]
                if isinstance(n, (int, float)) and n > 0:
                    nums.append(int(n))
            elif isinstance(entry, (int, float)) and entry > 0:
                nums.append(int(entry))
        return sorted(set(nums))
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Base scraper
# ---------------------------------------------------------------------------

class BaseScraper:
    """
    Base class for per-site scrapers.
    Each subclass implements scrape() → list of raw metadata dicts.

    Required keys per dict
    ----------------------
    title, url, image_url, synopsis, type, latest_episode (int|None),
    source (str), genres (list[str]), episodes (list[dict])
    """
    site_name: str = "Unknown"
    base_url:  str = ""

    def __init__(self) -> None:
        # One StealthyFetcher (Camoufox browser) per scraper instance
        self.fetcher = StealthyFetcher()

    async def fetch(self, url: str):
        log.info("[%s] Fetching: %s", self.site_name, url)
        # async_fetch is the asyncio interface in Scrapling ≥ 0.3
        # If your version only has sync .fetch() use:
        #   return await asyncio.to_thread(self.fetcher.fetch, url, timeout=PAGE_TIMEOUT_MS)
        return await self.fetcher.async_fetch(url, timeout=PAGE_TIMEOUT_MS)

    async def scrape(self) -> list[dict]:
        raise NotImplementedError

    async def scrape_show_episodes(
        self,
        show: dict,
        semaphore: asyncio.Semaphore,
        max_eps: int,
    ) -> list[dict]:
        """
        Fetch the show's detail page to build an episode list, then visit
        each episode page to extract its video/iframe URL.
        Results are cached to disk for EP_CACHE_TTL seconds.

        Returns a list of episode dicts ready for normalize.js consumption.
        """
        show_url = show.get("url", "")
        if not show_url:
            return []

        cached = _read_ep_cache(show_url)
        if cached is not None:
            log.debug("[%s] episode cache hit: %s", self.site_name, show_url)
            return cached

        async with semaphore:
            try:
                episodes = await self._do_scrape_episodes(show, max_eps)
                _write_ep_cache(show_url, episodes)
                return episodes
            except Exception as exc:
                log.warning(
                    "[%s] episode scrape failed for %s : %s",
                    self.site_name, show_url, exc,
                )
                return []

    async def _do_scrape_episodes(self, show: dict, max_eps: int) -> list[dict]:
        """Site-specific implementation — override in each subclass."""
        raise NotImplementedError


# ---------------------------------------------------------------------------
# TioAnime scraper
# ---------------------------------------------------------------------------

class TioAnimeScraper(BaseScraper):
    """
    tioanime.com — Spanish subtitles, very large catalog.

    Page structure (verified 2025):
      Home           → shows recent episode cards     (ul.episodes-list li)
      /directorio    → full paginated anime catalog    (ul.animes-grid li)
      /anime/{slug}  → show detail, episode list in JS var episodes = [[N,0],...]
      /ver/{slug}-N  → episode page, video in JS  var videos = [["SW","url"],...]
    """
    site_name = "TioAnime"
    base_url  = "https://tioanime.com"

    async def scrape(self) -> list[dict]:
        results: list[dict] = []
        seen: set[str] = set()

        # ── 1. Home page – recent episodes ──────────────────────────────────
        try:
            page  = await self.fetch(self.base_url)
            cards = page.css("ul.episodes-list li", auto_save=True)
            if not cards:
                cards = page.css(".ListEpisodios li, .episodes-container li")
                log.warning("[%s] Primary home selector empty, used fallback", self.site_name)

            for card in cards:
                item = self._parse_episode_card(card)
                if item and item["url"] not in seen:
                    seen.add(item["url"])
                    results.append(item)

            log.info("[%s] Home page: %d cards", self.site_name, len(results))
        except Exception as exc:
            log.error("[%s] Home page failed: %s", self.site_name, exc)

        # ── 2. Full directory – paginated ────────────────────────────────────
        page_num = 1
        while len(results) < MAX_ITEMS_PER_SITE:
            dir_url = (
                f"{self.base_url}/directorio"
                f"?p={page_num}&genero=false&estado=false&tipo=false&orden=titulo"
            )
            try:
                dir_page = await self.fetch(dir_url)
                cards = dir_page.css("ul.animes-grid li, .animes-list li", auto_save=True)
                if not cards:
                    break

                new_on_page = 0
                for card in cards:
                    item = self._parse_catalog_card(card)
                    if item and item["url"] not in seen:
                        seen.add(item["url"])
                        results.append(item)
                        new_on_page += 1

                if new_on_page == 0:
                    break
                page_num += 1
            except Exception as exc:
                log.error("[%s] Directory page %d failed: %s", self.site_name, page_num, exc)
                break

        log.info("[%s] Total: %d items", self.site_name, len(results))
        return results

    def _parse_episode_card(self, card) -> dict | None:
        try:
            link  = card.css_first("a")
            if not link:
                return None
            href  = link.attrib.get("href", "")
            title = clean(card.css(".title::text, h3::text, strong::text").get(""))
            if not title:
                title = clean(link.attrib.get("title", ""))
            img   = card.css_first("img")
            src   = lazy_img(img)
            ep    = clean(card.css(".episode::text, .capitulo::text, .ep::text").get(""))

            if not title or not href:
                return None

            return {
                "title":          title,
                "url":            abs_url(href, self.base_url),
                "image_url":      abs_url(src, self.base_url),
                "synopsis":       "",
                "type":           "Anime",
                "latest_episode": parse_episode_number(ep),
                "source":         self.site_name,
                "genres":         [],
                "episodes":       [],
            }
        except Exception:
            return None

    def _parse_catalog_card(self, card) -> dict | None:
        try:
            link     = card.css_first("a")
            if not link:
                return None
            href     = link.attrib.get("href", "")
            title    = clean(card.css("h3::text, .title::text").get("") or link.attrib.get("title", ""))
            img      = card.css_first("img")
            src      = lazy_img(img)
            synopsis = clean(card.css("p::text, .synopsis::text").get(""))
            atype    = clean(card.css(".type::text, .kind::text").get("Anime"))
            genres   = [clean(g.text) for g in card.css(".genres a, .genres span") if clean(g.text)]

            if not title or not href:
                return None

            return {
                "title":          title,
                "url":            abs_url(href, self.base_url),
                "image_url":      abs_url(src, self.base_url),
                "synopsis":       synopsis,
                "type":           atype or "Anime",
                "latest_episode": None,
                "source":         self.site_name,
                "genres":         genres,
                "episodes":       [],
            }
        except Exception:
            return None

    # ── Episode URL scraping ─────────────────────────────────────────────────

    async def _do_scrape_episodes(self, show: dict, max_eps: int) -> list[dict]:
        """
        1. Fetch show page (e.g. /anime/solo-leveling) to get episode numbers.
        2. Visit /ver/{slug}-{N} for the N most-recent episodes.
        3. Extract video URL from each episode page.
        """
        show_url = show["url"]
        # Derive slug from show URL: https://tioanime.com/anime/solo-leveling → solo-leveling
        slug = show_url.rstrip("/").rsplit("/", 1)[-1]

        # Step 1 — episode list from show detail page
        page = await self.fetch(show_url)
        html = _get_html(page)

        ep_nums = _ep_nums_from_script(html)

        if not ep_nums:
            # Fallback: parse episode links from the page
            links = page.css("ul.episodes-list li a, .episodes-list a")
            nums_set: set[int] = set()
            for link in links:
                href = link.attrib.get("href", "")
                n = parse_episode_number(href)
                if n is not None:
                    nums_set.add(n)
            ep_nums = sorted(nums_set)

        if not ep_nums:
            # Last resort: generate from latest_episode
            latest = show.get("latest_episode")
            if latest and int(latest) > 0:
                ep_nums = list(range(1, int(latest) + 1))

        if not ep_nums:
            log.debug("[%s] No episode numbers found for %s", self.site_name, slug)
            return []

        # Take the most-recent max_eps episodes
        ep_nums_to_fetch = ep_nums[-max_eps:]

        # Step 2 & 3 — fetch each episode page and extract URL
        episodes: list[dict] = []
        for n in ep_nums_to_fetch:
            ep_url = f"{self.base_url}/ver/{slug}-{n}"
            try:
                ep_page = await self.fetch(ep_url)
                ep_html = _get_html(ep_page)
                video   = VideoExtractor.extract(ep_html, ep_url, self.site_name)
                episodes.append({
                    "episode":      n,
                    "title":        f"Episodio {n}",
                    "siteUrl":      ep_url,
                    "videoUrl":     video["videoUrl"],
                    "externalUrl":  video["externalUrl"],
                    "externalType": video["externalType"],
                    "server":       video["server"],
                })
                log.debug(
                    "[%s] %s ep%d → video=%s embed=%s",
                    self.site_name, slug, n,
                    video["videoUrl"][:60] if video["videoUrl"] else "—",
                    video["externalUrl"][:60] if video["externalUrl"] else "—",
                )
            except Exception as exc:
                log.debug("[%s] episode %d fetch failed: %s", self.site_name, n, exc)

        log.info("[%s] %s → %d/%d episode URLs scraped",
                 self.site_name, slug, len(episodes), len(ep_nums_to_fetch))
        return episodes


# ---------------------------------------------------------------------------
# AnimeFLV scraper
# ---------------------------------------------------------------------------

class AnimeFLVScraper(BaseScraper):
    """
    www4.animeflv.net — One of the largest Spanish-language anime archives.

    Home:       ul.ListEpisodios article.Anime   → recent episodes
    /browse:    ul.ListAnimes li article.Anime   → full catalog
    /anime/{slug}: var episodes = [[N,1],...]; on page
    /ver/{slug}-N: var videos = {"SUB":[["SW","url",""]],"LAT":[...]}
    """
    site_name = "AnimeFLV"
    base_url  = "https://www4.animeflv.net"

    async def scrape(self) -> list[dict]:
        results: list[dict] = []
        seen: set[str] = set()

        # ── 1. Home – recent episodes ────────────────────────────────────────
        try:
            page  = await self.fetch(self.base_url)
            cards = page.css("ul.ListEpisodios article.Anime, ul.ListEpisodios li", auto_save=True)
            if not cards:
                cards = page.css(".ListEpisodios article, .episode-list li")
                log.warning("[%s] Primary home selector empty, used fallback", self.site_name)

            for card in cards:
                item = self._parse_episode_card(card)
                if item and item["url"] not in seen:
                    seen.add(item["url"])
                    results.append(item)

            log.info("[%s] Home page: %d cards", self.site_name, len(results))
        except Exception as exc:
            log.error("[%s] Home page failed: %s", self.site_name, exc)

        # ── 2. /browse – paginated catalog ───────────────────────────────────
        page_num = 1
        while len(results) < MAX_ITEMS_PER_SITE:
            browse_url = f"{self.base_url}/browse?page={page_num}&order=default"
            try:
                br    = await self.fetch(browse_url)
                cards = br.css("ul.ListAnimes li article.Anime, ul.ListAnimes article", auto_save=True)
                if not cards:
                    break

                new_on_page = 0
                for card in cards:
                    item = self._parse_catalog_card(card)
                    if item and item["url"] not in seen:
                        seen.add(item["url"])
                        results.append(item)
                        new_on_page += 1

                if new_on_page == 0:
                    break
                page_num += 1
            except Exception as exc:
                log.error("[%s] Browse page %d failed: %s", self.site_name, page_num, exc)
                break

        log.info("[%s] Total: %d items", self.site_name, len(results))
        return results

    def _parse_episode_card(self, card) -> dict | None:
        try:
            link  = card.css_first("a")
            if not link:
                return None
            href  = link.attrib.get("href", "")
            title = clean(card.css("h3.Title::text, strong.Title::text, h3::text").get(""))
            img   = card.css_first("img")
            src   = lazy_img(img)
            ep    = clean(card.css(".Capi::text, span.Capi::text, .episode::text").get(""))
            atype = clean(card.css(".Type::text").get("Anime"))

            if not title or not href:
                return None

            return {
                "title":          title,
                "url":            abs_url(href, self.base_url),
                "image_url":      abs_url(src, self.base_url),
                "synopsis":       "",
                "type":           atype or "Anime",
                "latest_episode": parse_episode_number(ep),
                "source":         self.site_name,
                "genres":         [],
                "episodes":       [],
            }
        except Exception:
            return None

    def _parse_catalog_card(self, card) -> dict | None:
        try:
            link     = card.css_first("a")
            if not link:
                return None
            href     = link.attrib.get("href", "")
            title    = clean(card.css("h3.Title::text, strong.Title::text").get(""))
            img      = card.css_first("img")
            src      = lazy_img(img)
            synopsis = clean(card.css(".Description p::text").get(""))
            atype    = clean(card.css(".Type::text").get("Anime"))
            genres   = [clean(g.text) for g in card.css(".Genres a") if clean(g.text)]

            if not title or not href:
                return None

            return {
                "title":          title,
                "url":            abs_url(href, self.base_url),
                "image_url":      abs_url(src, self.base_url),
                "synopsis":       synopsis,
                "type":           atype or "Anime",
                "latest_episode": None,
                "source":         self.site_name,
                "genres":         genres,
                "episodes":       [],
            }
        except Exception:
            return None

    # ── Episode URL scraping ─────────────────────────────────────────────────

    async def _do_scrape_episodes(self, show: dict, max_eps: int) -> list[dict]:
        """
        AnimeFLV show page has:  var episodes = [[24,1],[23,1],...,[1,1]]
        Episode pages are at:    /ver/{slug}-{N}
        Video JS variable:       var videos = {"SUB":[["SW","url",""]],"LAT":[]}
        """
        show_url = show["url"]
        # URL: https://www4.animeflv.net/anime/solo-leveling → slug = solo-leveling
        slug = show_url.rstrip("/").rsplit("/", 1)[-1]

        page = await self.fetch(show_url)
        html = _get_html(page)

        ep_nums = _ep_nums_from_script(html)

        if not ep_nums:
            latest = show.get("latest_episode")
            if latest and int(latest) > 0:
                ep_nums = list(range(1, int(latest) + 1))

        if not ep_nums:
            return []

        ep_nums_to_fetch = ep_nums[-max_eps:]

        episodes: list[dict] = []
        for n in ep_nums_to_fetch:
            ep_url = f"{self.base_url}/ver/{slug}-{n}"
            try:
                ep_page = await self.fetch(ep_url)
                ep_html = _get_html(ep_page)
                video   = VideoExtractor.extract(ep_html, ep_url, self.site_name)
                episodes.append({
                    "episode":      n,
                    "title":        f"Episodio {n}",
                    "siteUrl":      ep_url,
                    "videoUrl":     video["videoUrl"],
                    "externalUrl":  video["externalUrl"],
                    "externalType": video["externalType"],
                    "server":       video["server"],
                })
                log.debug(
                    "[%s] %s ep%d → video=%s embed=%s",
                    self.site_name, slug, n,
                    video["videoUrl"][:60] if video["videoUrl"] else "—",
                    video["externalUrl"][:60] if video["externalUrl"] else "—",
                )
            except Exception as exc:
                log.debug("[%s] episode %d fetch failed: %s", self.site_name, n, exc)

        log.info("[%s] %s → %d/%d episode URLs scraped",
                 self.site_name, slug, len(episodes), len(ep_nums_to_fetch))
        return episodes


# ---------------------------------------------------------------------------
# JKAnime scraper
# ---------------------------------------------------------------------------

class JKAnimeScraper(BaseScraper):
    """
    jkanime.net — Popular Spanish-language streaming and simulcast site.

    Home:        .anime__item            → recent cards
    /directorio/: .anime__item           → paginated sorted directory
    /{slug}/: episode links + pagination
    /{slug}/{N}/: episode page (usually iframe embed)
    """
    site_name = "JKAnime"
    base_url  = "https://jkanime.net"

    async def scrape(self) -> list[dict]:
        results: list[dict] = []
        seen: set[str] = set()

        # ── 1. Home ──────────────────────────────────────────────────────────
        try:
            page  = await self.fetch(self.base_url)
            cards = page.css(".anime__item, .anime-card, .card.anime", auto_save=True)
            if not cards:
                cards = page.css(".list-anime li, .recent-anime li")
                log.warning("[%s] Primary home selector empty, used fallback", self.site_name)

            for card in cards:
                item = self._parse_episode_card(card)
                if item and item["url"] not in seen:
                    seen.add(item["url"])
                    results.append(item)

            log.info("[%s] Home page: %d cards", self.site_name, len(results))
        except Exception as exc:
            log.error("[%s] Home page failed: %s", self.site_name, exc)

        # ── 2. /directorio/ – paginated ──────────────────────────────────────
        page_num = 1
        while len(results) < MAX_ITEMS_PER_SITE:
            dir_url = f"{self.base_url}/directorio/?p={page_num}&orden=rating"
            try:
                dir_page = await self.fetch(dir_url)
                cards = dir_page.css(".anime__item, .anime-card, .card.anime", auto_save=True)
                if not cards:
                    break

                new_on_page = 0
                for card in cards:
                    item = self._parse_catalog_card(card)
                    if item and item["url"] not in seen:
                        seen.add(item["url"])
                        results.append(item)
                        new_on_page += 1

                if new_on_page == 0:
                    break
                page_num += 1
            except Exception as exc:
                log.error("[%s] Directory page %d failed: %s", self.site_name, page_num, exc)
                break

        log.info("[%s] Total: %d items", self.site_name, len(results))
        return results

    def _parse_episode_card(self, card) -> dict | None:
        try:
            link  = card.css_first("a")
            if not link:
                return None
            href  = link.attrib.get("href", "")
            title = clean(card.css("h5::text, h4::text, .title::text").get("") or link.attrib.get("title", ""))
            img   = card.css_first("img")
            src   = lazy_img(img)
            ep    = clean(card.css(".capitulo::text, .episode::text, span.number::text").get(""))

            if not title or not href:
                return None

            return {
                "title":          title,
                "url":            abs_url(href, self.base_url),
                "image_url":      abs_url(src, self.base_url),
                "synopsis":       "",
                "type":           "Anime",
                "latest_episode": parse_episode_number(ep),
                "source":         self.site_name,
                "genres":         [],
                "episodes":       [],
            }
        except Exception:
            return None

    def _parse_catalog_card(self, card) -> dict | None:
        try:
            link     = card.css_first("a")
            if not link:
                return None
            href     = link.attrib.get("href", "")
            title    = clean(card.css("h5::text, h4::text, .title::text").get(""))
            img      = card.css_first("img")
            src      = lazy_img(img)
            synopsis = clean(card.css("p::text, .sinopsis::text").get(""))
            atype    = clean(card.css(".type::text, .formato::text").get("Anime"))
            genres   = [clean(g.text) for g in card.css(".genres a, .genre-list a") if clean(g.text)]

            if not title or not href:
                return None

            return {
                "title":          title,
                "url":            abs_url(href, self.base_url),
                "image_url":      abs_url(src, self.base_url),
                "synopsis":       synopsis,
                "type":           atype or "Anime",
                "latest_episode": None,
                "source":         self.site_name,
                "genres":         genres,
                "episodes":       [],
            }
        except Exception:
            return None

    # ── Episode URL scraping ─────────────────────────────────────────────────

    async def _do_scrape_episodes(self, show: dict, max_eps: int) -> list[dict]:
        """
        JKAnime show page is at /{slug}/ and lists episodes via links or JS.
        Episode pages are at /{slug}/{N}/.
        Video is usually an iframe embed.
        """
        show_url = show["url"]
        # URL: https://jkanime.net/solo-leveling/ → slug = solo-leveling
        slug = show_url.rstrip("/").rsplit("/", 1)[-1]

        page = await self.fetch(show_url)
        html = _get_html(page)

        # Try JS variable
        ep_nums = _ep_nums_from_script(html)

        if not ep_nums:
            # Fallback: count from episode links like /solo-leveling/12/
            ep_link_re = re.compile(
                rf'/{re.escape(slug)}/(\d+)/', re.IGNORECASE
            )
            nums_set = {int(m) for m in ep_link_re.findall(html) if int(m) > 0}
            ep_nums = sorted(nums_set)

        if not ep_nums:
            # Last resort: paginated episode count from the total shown on page
            total_el = page.css_first(".episodes-num, .anime_info_body_bg p")
            if total_el:
                total = parse_episode_number(total_el.text or "")
                if total and total > 0:
                    ep_nums = list(range(1, total + 1))

        if not ep_nums:
            latest = show.get("latest_episode")
            if latest and int(latest) > 0:
                ep_nums = list(range(1, int(latest) + 1))

        if not ep_nums:
            return []

        ep_nums_to_fetch = ep_nums[-max_eps:]

        episodes: list[dict] = []
        for n in ep_nums_to_fetch:
            ep_url = f"{self.base_url}/{slug}/{n}/"
            try:
                ep_page = await self.fetch(ep_url)
                ep_html = _get_html(ep_page)
                video   = VideoExtractor.extract(ep_html, ep_url, self.site_name)
                episodes.append({
                    "episode":      n,
                    "title":        f"Episodio {n}",
                    "siteUrl":      ep_url,
                    "videoUrl":     video["videoUrl"],
                    "externalUrl":  video["externalUrl"],
                    "externalType": video["externalType"],
                    "server":       video["server"],
                })
                log.debug(
                    "[%s] %s ep%d → video=%s embed=%s",
                    self.site_name, slug, n,
                    video["videoUrl"][:60] if video["videoUrl"] else "—",
                    video["externalUrl"][:60] if video["externalUrl"] else "—",
                )
            except Exception as exc:
                log.debug("[%s] episode %d fetch failed: %s", self.site_name, n, exc)

        log.info("[%s] %s → %d/%d episode URLs scraped",
                 self.site_name, slug, len(episodes), len(ep_nums_to_fetch))
        return episodes


# ---------------------------------------------------------------------------
# Post-processing
# ---------------------------------------------------------------------------

def deduplicate(items: list[dict]) -> list[dict]:
    """
    Merge items with the same normalised title.
    Prefers the entry with: more episodes > longer synopsis > has image.
    """
    def norm(title: str) -> str:
        t = title.lower()
        for accent, plain in [("áàäâã", "a"), ("éèëê", "e"), ("íìïî", "i"),
                               ("óòöôõ", "o"), ("úùüû", "u")]:
            for ch in accent:
                t = t.replace(ch, plain)
        t = re.sub(r"[^a-z0-9 ]+", " ", t)
        t = re.sub(r"\b(season|temporada|parte|part|cour)\b", " ", t)
        return re.sub(r"\s+", " ", t).strip()

    seen: dict[str, dict] = {}
    for item in items:
        k = norm(item["title"])
        if k not in seen:
            seen[k] = item
        else:
            old = seen[k]
            score_new = (
                len(item.get("episodes", [])) * 100
                + bool(item.get("image_url")) * 10
                + len(item.get("synopsis", ""))
            )
            score_old = (
                len(old.get("episodes", [])) * 100
                + bool(old.get("image_url")) * 10
                + len(old.get("synopsis", ""))
            )
            if score_new > score_old:
                seen[k] = item
            else:
                # Merge episodes from both sources (union by episode number)
                existing_ep_nums = {e["episode"] for e in old.get("episodes", [])}
                for ep in item.get("episodes", []):
                    if ep["episode"] not in existing_ep_nums:
                        old.setdefault("episodes", []).append(ep)

    return list(seen.values())


def to_app_catalog(items: list[dict]) -> dict:
    """
    Shape raw items into the structure AnimeTV's normalizeExternalShow() expects.

    Episodes format consumed by normalize.js
    -----------------------------------------
    {
      episode:      1,             # episode number (int)
      title:        "Episodio 1",
      siteUrl:      "https://...", # source page URL
      videoUrl:     "https://...", # direct .mp4 / .m3u8 (or "")
      externalUrl:  "https://...", # iframe embed URL   (or "")
      externalType: "iframe",      # or ""
      server:       "TioAnime",
    }
    """
    app_items = []
    for idx, item in enumerate(items):
        genres   = item.get("genres") or []
        raw_eps  = item.get("episodes") or []

        # Sort episodes ascending by episode number
        raw_eps = sorted(raw_eps, key=lambda e: e.get("episode") or 0)

        app_items.append({
            "id":          f"scraped-{idx}",
            "title":       item["title"],
            "image":       item.get("image_url", ""),
            "banner":      "",
            "siteUrl":     item.get("url", ""),
            "description": item.get("synopsis", ""),
            "episode":     item.get("latest_episode"),
            "genre":       pick_genre(genres),
            "genres":      genres,
            "day":         "Local",
            "time":        "",
            "colors":      ["#40dfc2", "#251d47"],
            "score":       None,
            "source":      item.get("source", "Scraped"),
            # Top-level videoUrl: first episode's direct URL (convenience field)
            "videoUrl":    (raw_eps[0].get("videoUrl") or "") if raw_eps else "",
            # Full episode list so the app can show a proper episode picker
            "episodes":    raw_eps,
            "seasons":     [],
        })

    return {
        "ok":           True,
        "source":       "Scrapling Multi-Site",
        "scrapedAt":    datetime.now(timezone.utc).isoformat(),
        "totalResults": len(app_items),
        "items":        app_items,
    }


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def save_json(catalog: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(catalog, f, ensure_ascii=False, indent=2)
    print(f"[✓] JSON → {path}  ({catalog['totalResults']} items)")


def save_csv(items: list[dict], path: Path) -> None:
    if not items:
        return
    fields = ["title", "url", "image_url", "synopsis", "type", "latest_episode", "source"]
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(items)
    print(f"[✓] CSV  → {path}")


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

async def run_all(
    sites:      list[str] | None = None,
    do_episodes: bool            = False,
    top_n:       int             = 20,
    max_eps:     int             = 5,
    ep_workers:  int             = 3,
) -> dict:
    """
    Run all scrapers concurrently and return the merged catalog dict.

    Parameters
    ----------
    sites       : filter to specific site names (tioanime / animeflv / jkanime)
    do_episodes : also scrape individual episode pages for video URLs
    top_n       : how many shows per site get episode scraping (sorted by
                  latest_episode desc)
    max_eps     : max episodes to fetch per show (most-recent first)
    ep_workers  : max concurrent episode-page fetches across all sites
    """
    all_scrapers: list[BaseScraper] = [
        TioAnimeScraper(),
        AnimeFLVScraper(),
        JKAnimeScraper(),
    ]

    if sites:
        sites_lower = {s.lower() for s in sites}
        all_scrapers = [
            s for s in all_scrapers
            if any(tok in s.site_name.lower() for tok in sites_lower)
        ]
        if not all_scrapers:
            sys.exit(
                f"No scrapers matched: {sites}. "
                f"Valid names: tioanime, animeflv, jkanime"
            )

    print("=" * 60)
    print(f"  AnimeTV Scraper  —  {len(all_scrapers)} site(s)")
    if do_episodes:
        print(f"  Episode URLs ON  (top {top_n} shows × max {max_eps} eps, {ep_workers} workers)")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 60)

    t0 = time.monotonic()

    # ── Phase 1: metadata scrape ─────────────────────────────────────────────
    per_site_results = await asyncio.gather(
        *[s.scrape() for s in all_scrapers],
        return_exceptions=True,
    )

    # Keep raw items per scraper so we can attach episode data before dedup
    site_raw: list[list[dict]] = []
    for scraper, result in zip(all_scrapers, per_site_results):
        if isinstance(result, Exception):
            log.error("[%s] Unhandled exception: %s", scraper.site_name, result)
            site_raw.append([])
        elif isinstance(result, list):
            site_raw.append(result)
        else:
            site_raw.append([])

    # ── Phase 2 (optional): episode URL scraping ─────────────────────────────
    if do_episodes:
        ep_sem = asyncio.Semaphore(ep_workers)

        async def scrape_site_episodes(
            scraper: BaseScraper,
            raw_items: list[dict],
        ) -> None:
            # Sort by latest_episode desc, take top_n shows
            sorted_items = sorted(
                raw_items,
                key=lambda x: x.get("latest_episode") or 0,
                reverse=True,
            )
            target_shows = sorted_items[:top_n]
            log.info(
                "[%s] Episode scraping: %d shows selected (top %d by episode count)",
                scraper.site_name, len(target_shows), top_n,
            )
            for show in target_shows:
                episodes = await scraper.scrape_show_episodes(show, ep_sem, max_eps)
                show["episodes"] = episodes

        await asyncio.gather(
            *[scrape_site_episodes(sc, raw) for sc, raw in zip(all_scrapers, site_raw)],
            return_exceptions=True,
        )

    # ── Phase 3: merge, dedup, shape ────────────────────────────────────────
    all_raw: list[dict] = []
    for raw in site_raw:
        all_raw.extend(raw)

    ep_total = sum(len(x.get("episodes", [])) for x in all_raw)
    print(f"\n  Raw items     : {len(all_raw)}")
    if do_episodes:
        print(f"  Episode URLs  : {ep_total} across all shows")
    unique = deduplicate(all_raw)
    print(f"  After dedup   : {len(unique)}")

    catalog = to_app_catalog(unique)
    save_json(catalog, OUTPUT_JSON)
    save_csv(all_raw, OUTPUT_CSV)

    elapsed = time.monotonic() - t0
    print(f"\n[✓] Done in {elapsed:.1f}s")
    print(f"    Restart AnimeTV (or hit /api/refresh-daily) to load new metadata")
    print("=" * 60)

    return catalog


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    global OUTPUT_JSON
    parser = argparse.ArgumentParser(
        description="AnimeTV metadata + episode URL scraper (Scrapling)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples
--------
  # Fast: metadata only
  python anime_scraper.py

  # With episode URLs for the 20 most-active shows, 5 episodes each
  python anime_scraper.py --episodes

  # Episode URLs for fewer shows, wider episode depth
  python anime_scraper.py --episodes --top 10 --max-eps 12

  # Specific sites + custom output
  python anime_scraper.py --sites tioanime jkanime --output /data/anime.json

  # Keep running (re-scrapes every 6 hours)
  python anime_scraper.py --schedule 6 --episodes
""",
    )
    parser.add_argument(
        "--sites", nargs="+", metavar="SITE",
        help="Only scrape these sites: tioanime, animeflv, jkanime (default: all)",
    )
    parser.add_argument(
        "--episodes", action="store_true",
        help="Also scrape individual episode pages for video / iframe URLs (slow)",
    )
    parser.add_argument(
        "--top", type=int, default=20, metavar="N",
        help="Episode scraping: top N shows per site sorted by episode count (default 20)",
    )
    parser.add_argument(
        "--max-eps", type=int, default=5, metavar="N",
        help="Episode scraping: max episodes per show (most-recent first, default 5)",
    )
    parser.add_argument(
        "--ep-workers", type=int, default=3, metavar="N",
        help="Episode scraping: concurrent page fetches across all sites (default 3)",
    )
    parser.add_argument(
        "--schedule", type=float, metavar="HOURS",
        help="Keep running, re-scraping every HOURS hours",
    )
    parser.add_argument(
        "--output", type=Path, metavar="FILE",
        help=f"JSON output path (default: {OUTPUT_JSON})",
    )
    args = parser.parse_args()

    if args.output:
        OUTPUT_JSON = args.output

    kwargs = dict(
        sites       = args.sites,
        do_episodes = args.episodes,
        top_n       = args.top,
        max_eps     = args.max_eps,
        ep_workers  = args.ep_workers,
    )

    if args.schedule:
        interval_s = args.schedule * 3600
        log.info("Scheduler active — running every %.1fh. Ctrl+C to stop.", args.schedule)
        while True:
            asyncio.run(run_all(**kwargs))
            log.info("Next run in %.1fh…", args.schedule)
            time.sleep(interval_s)
    else:
        asyncio.run(run_all(**kwargs))


if __name__ == "__main__":
    main()
