const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VEOHENTAI_BASE = 'https://veohentai.com';
const HENTAILA_BASE = 'https://hentaila.tv';

const VEOHENTAI_CATALOG_FILE = path.join(__dirname, 'veohentai_catalog.json');
const VEOHENTAI_DETAILS_FILE = path.join(__dirname, 'veohentai_details.json');
const HENTAILA_CATALOG_FILE = path.join(__dirname, 'hentaila_catalog.json');
const HENTAILA_DETAILS_FILE = path.join(__dirname, 'hentaila_details.json');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
};

async function fetchWithRetry(url, options = {}, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { ...options, headers: { ...HEADERS, ...options.headers } });
      if (res.ok) return res;
      if (res.status === 404) return { ok: false, status: 404 };
    } catch (err) {
      if (i === retries) return { ok: false, status: 500, error: err.message };
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return { ok: false, status: 500, error: "Failed after retries" };
}

async function runInChunks(items, fetchFn, chunkSize = 30) {
  const results = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    console.log(`Processing chunk ${Math.floor(i / chunkSize) + 1}/${Math.ceil(items.length / chunkSize)}...`);
    const chunkResults = await Promise.all(chunk.map(item => fetchFn(item).catch(err => {
      console.error(`Error processing ${item.slug || item}:`, err.message);
      return null;
    })));
    results.push(...chunkResults.filter(Boolean));
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  return results;
}

function cleanTitle(title) {
  return title.replace(/&amp;/g, '&').replace(/&#8230;/g, '...').trim();
}

async function scrapeVeoHentai() {
  console.log('--- Scraping VeoHentai ---');
  try {
    const res = await fetchWithRetry(`${VEOHENTAI_BASE}/directorio-hentai/`);
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const html = await res.text();
    
    const linkRegex = /href\s*=\s*"https:\/\/veohentai\.com\/serie\/([^"]+)\/"[^>]*>([\s\S]*?)<\/a>/gi;
    const seriesList = [];
    const seenSlugs = new Set();
    
    let match;
    while ((match = linkRegex.exec(html)) !== null) {
      const slug = match[1].toLowerCase().trim();
      const title = cleanTitle(match[2].replace(/<[^>]+>/g, ' ').trim());
      if (slug && !seenSlugs.has(slug)) {
        seenSlugs.add(slug);
        seriesList.push({
          slug,
          title,
          url: `${VEOHENTAI_BASE}/serie/${slug}/`
        });
      }
    }
    
    console.log(`Found ${seriesList.length} series on VeoHentai. Fetching details...`);
    
    const detailsItems = await runInChunks(seriesList, async (series) => {
      const detailRes = await fetchWithRetry(series.url);
      if (!detailRes.ok) return null;
      const detailHtml = await detailRes.text();
      
      const imgMatch = detailHtml.match(/<img\b[^>]*src\s*=\s*"([^"]+)"[^>]*class\s*=\s*"[^"]*\bwp-post-image\b[^"]*"[^>]*>/i) ||
                       detailHtml.match(/<img\b[^>]*class\s*=\s*"[^"]*\bwp-post-image\b[^"]*"[^>]*src\s*=\s*"([^"]+)"[^>]*>/i);
      const image = imgMatch ? imgMatch[1] : '';
      
      const genreMatches = [...detailHtml.matchAll(/href\s*=\s*"https:\/\/veohentai\.com\/genero\/([^"]+)\/"/gi)];
      const genres = [...new Set(genreMatches.map(m => m[1].replace(/-/g, ' ')))].map(g => g.charAt(0).toUpperCase() + g.slice(1));
      
      const descMatch = detailHtml.match(/<div class="sinopsis text-whitegray text-sm pb-4"[^>]*>([\s\S]*?)<\/div>/i) ||
                        detailHtml.match(/class\s*=\s*"[^"]*\bsinopsis\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
      const description = descMatch ? descMatch[1].replace(/<[^>]+>/g, ' ').trim() : '';

      const brandMatch = detailHtml.match(/href\s*=\s*"https:\/\/veohentai\.com\/brand\/([^"]+)\/"/i);
      const brand = brandMatch ? brandMatch[1].replace(/-/g, ' ').toUpperCase() : '';
      
      const epRegex = /href\s*=\s*"(https:\/\/veohentai\.com\/ver\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      const episodes = [];
      const seenEps = new Set();
      let epMatch;
      while ((epMatch = epRegex.exec(detailHtml)) !== null) {
        const epUrl = epMatch[1];
        if (epUrl.includes('-episodio-') && !seenEps.has(epUrl)) {
          seenEps.add(epUrl);
          const numMatch = epUrl.match(/-episodio-(\d+)/i);
          const number = numMatch ? parseInt(numMatch[1], 10) : 1;
          episodes.push({
            episode: number,
            number: number,
            title: `Episodio ${number}`,
            url: epUrl,
            image: image,
            sourceOptions: [
              {
                releaseIndex: 0,
                label: 'Subbed · ESP',
                variant: 'Subbed',
                format: 'MP4',
                size: '',
                subtitles: 'Spanish',
                audio: 'Japanese',
                watchUrl: epUrl
              }
            ],
            locked: false
          });
        }
      }
      
      episodes.sort((a, b) => a.number - b.number);
      
      // Concurrently resolve direct stream URLs for this title's episodes!
      await Promise.all(episodes.map(async (episode) => {
        try {
          console.log(`[VeoHentai] Resolving stream for: ${series.title} - Episode ${episode.number}`);
          const epRes = await fetchWithRetry(episode.url);
          if (epRes.ok) {
            const epHtml = await epRes.text();
            // Extracted embeds using parseEmbedsFromHtml logic
            const embedMatch = epHtml.match(/<iframe\b[^>]*src\s*=\s*["']([^"']+)["']/i) || 
                               epHtml.match(/\b(?:href|src)\s*=\s*["']([^"']*(?:hentaiplayer|player\.php)[^"']*)["']/i);
            if (embedMatch) {
              const rawEmbed = embedMatch[1];
              // Normalize URL
              let embedUrl = rawEmbed;
              if (rawEmbed.startsWith("//")) {
                embedUrl = "https:" + rawEmbed;
              } else if (rawEmbed.startsWith("/")) {
                embedUrl = "https://hentaiplayer.com" + rawEmbed;
              }
              
              if (embedUrl) {
                episode.embeds = [embedUrl];
                episode.sourceOptions[0].embeds = [embedUrl];
              }
            } else {
              console.warn(`[VeoHentai] No embed found in HTML for: ${series.title} - Episode ${episode.number}`);
            }
          }
        } catch (err) {
          console.error(`[VeoHentai] Error pre-resolving episode ${episode.number}:`, err.message);
        }
      }));

      return {
        slug: series.slug,
        title: series.title,
        url: series.url,
        image: image,
        officialTitle: series.title,
        brand: brand || 'VEOHENTAI',
        aired: '',
        genres: genres.length ? genres : ['Hentai'],
        banner: image,
        episodeCount: episodes.length,
        releaseCount: episodes.length,
        safetyExcluded: false,
        description: description || `Anime: ${series.title}`,
        episodes
      };
    }, 5);
    
    fs.writeFileSync(VEOHENTAI_DETAILS_FILE, JSON.stringify({
      source: 'VeoHentai',
      generatedAt: new Date().toISOString(),
      items: detailsItems
    }, null, 2), 'utf8');
    
    const catalogItems = detailsItems.map(item => ({
      slug: item.slug,
      title: item.title,
      url: item.url,
      image: item.image,
      page: 1,
      sourceOrder: 0,
      officialTitle: item.officialTitle,
      brand: item.brand,
      aired: item.aired,
      genres: item.genres,
      banner: item.banner,
      episodeCount: item.episodeCount,
      releaseCount: item.releaseCount,
      safetyExcluded: false
    }));
    
    fs.writeFileSync(VEOHENTAI_CATALOG_FILE, JSON.stringify({
      source: 'VeoHentai',
      generatedAt: new Date().toISOString(),
      totalFound: catalogItems.length,
      items: catalogItems
    }, null, 2), 'utf8');
    
    console.log(`VeoHentai scraping complete. Saved ${catalogItems.length} items.`);
  } catch (err) {
    console.error('VeoHentai scrape error:', err.message);
  }
}

async function scrapeHentaiLA() {
  console.log('--- Scraping HentaiLA ---');
  try {
    const res = await fetchWithRetry(HENTAILA_BASE);
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const homeHtml = await res.text();
    
    // Extract all genres from homepage links
    const genreSlugRegex = /href="https:\/\/hentaila\.tv\/genero\/([^"/]+)\/"/gi;
    const genreSlugs = new Set();
    let genreMatch;
    while ((genreMatch = genreSlugRegex.exec(homeHtml)) !== null) {
      genreSlugs.add(genreMatch[1].toLowerCase().trim());
    }
    
    const genreArray = Array.from(genreSlugs);
    console.log(`Found ${genreArray.length} genres:`, genreArray);
    
    const seriesMap = new Map();
    
    // Scrape each genre paginated
    for (const genre of genreArray) {
      console.log(`Scraping HentaiLA genre: ${genre}...`);
      let page = 1;
      let hasMore = true;
      
      while (hasMore) {
        const url = page === 1 ? `${HENTAILA_BASE}/genero/${genre}/` : `${HENTAILA_BASE}/genero/${genre}/page/${page}/`;
        const genreRes = await fetchWithRetry(url);
        if (!genreRes.ok) {
          hasMore = false;
          break;
        }
        
        const html = await genreRes.text();
        const cardRegex = /<div class="item_card">[\s\S]*?<a href="https:\/\/hentaila\.tv\/ver\/([^"/]+)\/" class="card__cover">[\s\S]*?<img[^>]*src="([^"]+)"[^>]*>[\s\S]*?<h3 class="card__title">([^<]+)<\/h3>/gi;
        let match;
        let count = 0;
        while ((match = cardRegex.exec(html)) !== null) {
          const slug = match[1].toLowerCase().trim();
          const image = match[2];
          const title = cleanTitle(match[3].trim());
          if (slug && !seriesMap.has(slug)) {
            seriesMap.set(slug, {
              slug,
              title,
              image,
              url: `${HENTAILA_BASE}/ver/${slug}/`
            });
          }
          count++;
        }
        
        console.log(`Genre ${genre} page ${page}: parsed ${count} items.`);
        if (count === 0 || page >= 20) {
          hasMore = false;
        } else {
          page++;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    
    const seriesList = Array.from(seriesMap.values());
    console.log(`Found ${seriesList.length} unique series on HentaiLA. Fetching details...`);
    
    const detailsItems = await runInChunks(seriesList, async (series) => {
      const detailRes = await fetchWithRetry(series.url);
      if (!detailRes.ok) return null;
      const detailHtml = await detailRes.text();
      
      const genreMatches = [...detailHtml.matchAll(/href\s*=\s*"https:\/\/hentaila\.tv\/genero\/([^"]+)\/"/gi)];
      const genres = [...new Set(genreMatches.map(m => m[1].replace(/-/g, ' ')))].map(g => g.charAt(0).toUpperCase() + g.slice(1));
      
      const descMatch = detailHtml.match(/<div class="card__description"[^>]*>([\s\S]*?)<\/div>/i) ||
                        detailHtml.match(/class\s*=\s*"[^"]*\bdescription\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
      const description = descMatch ? descMatch[1].replace(/<[^>]+>/g, ' ').trim() : '';

      const epRegex = /href\s*=\s*"(https:\/\/hentaila\.tv\/ver\/[^"/]+\/episodio-(\d+))"[^>]*>([\s\S]*?)<\/a>/gi;
      const episodes = [];
      const seenEps = new Set();
      let epMatch;
      while ((epMatch = epRegex.exec(detailHtml)) !== null) {
        const epUrl = epMatch[1];
        const number = parseInt(epMatch[2], 10);
        if (epUrl && !seenEps.has(epUrl)) {
          seenEps.add(epUrl);
          episodes.push({
            episode: number,
            number: number,
            title: `Episodio ${number}`,
            url: epUrl,
            image: series.image,
            sourceOptions: [
              {
                releaseIndex: 0,
                label: 'Subbed · ESP',
                variant: 'Subbed',
                format: 'MP4',
                size: '',
                subtitles: 'Spanish',
                audio: 'Japanese',
                watchUrl: epUrl
              }
            ],
            locked: false
          });
        }
      }
      
      episodes.sort((a, b) => a.number - b.number);
      
      return {
        slug: series.slug,
        title: series.title,
        url: series.url,
        image: series.image,
        officialTitle: series.title,
        brand: 'HENTAILA',
        aired: '',
        genres: genres.length ? genres : ['Hentai'],
        banner: series.image,
        episodeCount: episodes.length,
        releaseCount: episodes.length,
        safetyExcluded: false,
        description: description || `Anime: ${series.title}`,
        episodes
      };
    }, 40);
    
    fs.writeFileSync(HENTAILA_DETAILS_FILE, JSON.stringify({
      source: 'HentaiLA',
      generatedAt: new Date().toISOString(),
      items: detailsItems
    }, null, 2), 'utf8');
    
    const catalogItems = detailsItems.map(item => ({
      slug: item.slug,
      title: item.title,
      url: item.url,
      image: item.image,
      page: 1,
      sourceOrder: 0,
      officialTitle: item.officialTitle,
      brand: item.brand,
      aired: item.aired,
      genres: item.genres,
      banner: item.banner,
      episodeCount: item.episodeCount,
      releaseCount: item.releaseCount,
      safetyExcluded: false
    }));
    
    fs.writeFileSync(HENTAILA_CATALOG_FILE, JSON.stringify({
      source: 'HentaiLA',
      generatedAt: new Date().toISOString(),
      totalFound: catalogItems.length,
      items: catalogItems
    }, null, 2), 'utf8');
    
    console.log(`HentaiLA scraping complete. Saved ${catalogItems.length} items.`);
  } catch (err) {
    console.error('HentaiLA scrape error:', err.message);
  }
}

async function run() {
  await scrapeVeoHentai();
  await scrapeHentaiLA();
}

run();

async function resolveHentaiPlayerEmbed(embedUrl) {
  if (!embedUrl.includes("/v/")) return embedUrl;
  try {
    const upstream = await fetch(embedUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Referer": "https://veohentai.com/"
      }
    });
    if (!upstream.ok) return embedUrl;
    const html = await upstream.text();
    const match = html.match(/data-id="(\/player\.php\?[^"]+)"/i) || html.match(/data-id='(\/player\.php\?[^']+)'/i);
    if (match) {
      return `https://hentaiplayer.com${match[1]}`;
    }
  } catch (err) {
    console.error("resolveHentaiPlayerEmbed failed:", err.message);
  }
  return embedUrl;
}

async function resolveHentaiPlayer(embedUrl) {
  try {
    let playerUrl = embedUrl;
    if (embedUrl.includes("/v/")) {
      playerUrl = await resolveHentaiPlayerEmbed(embedUrl);
    }
    if (!playerUrl.includes("player.php")) {
      return null;
    }

    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "Referer": "https://veohentai.com/"
    };

    const pageRes = await fetch(playerUrl, { headers });
    if (!pageRes.ok) return null;
    const pageHtml = await pageRes.text();

    let cookies = [];
    if (typeof pageRes.headers.getSetCookie === "function") {
      const setCookie = pageRes.headers.getSetCookie();
      if (setCookie && setCookie.length > 0) {
        cookies = setCookie.map(c => c.split(";")[0]);
      }
    }
    if (cookies.length === 0) {
      const cookieHeader = pageRes.headers.get("set-cookie");
      if (cookieHeader) {
        cookies = [cookieHeader.split(";")[0]];
      }
    }
    const cookieString = cookies.join("; ");

    const pVMatch = pageHtml.match(/window\._pV\s*=\s*({[^}]+});/);
    if (!pVMatch) return null;

    const pVStr = pVMatch[1];
    const vid = (pVStr.match(/vid\s*:\s*["']([^"']+)["']/) || [])[1];
    const ct = (pVStr.match(/c\s*:\s*["']([^"']+)["']/) || pVStr.match(/ct\s*:\s*["']([^"']+)["']/) || [])[1];
    const pid = (pVStr.match(/pid\s*:\s*["']([^"']+)["']/) || [])[1];
    const st = (pVStr.match(/st\s*:\s*["']([^"']+)["']/) || [])[1];

    if (!vid || !ct) return null;

    const scriptSrcMatch = pageHtml.match(/<script\s+src=["'](player-core-v2\.php\?[^"']+)["']/i);
    if (!scriptSrcMatch) return null;

    const scriptUrl = "https://hentaiplayer.com/" + scriptSrcMatch[1];
    const scriptRes = await fetch(scriptUrl, {
      headers: {
        ...headers,
        "Cookie": cookieString,
        "Referer": playerUrl
      }
    });
    if (!scriptRes.ok) return null;
    const scriptContent = await scriptRes.text();

    const sc = (scriptContent.match(/var\s+[a-zA-Z0-9_$]+=\s*['"]([a-f0-9]{8}\.[a-f0-9]{16})['"]/i) || [])[1];
    const rid = (scriptContent.match(/var\s+[a-f0-9]{16}/gi) || [])[0]; // grab hex sequence
    // If not matching rid, fallback
    const ridParsed = rid ? rid.replace(/var\s+[a-zA-Z0-9_$]+=\s*['"]/i, '').replace(/['"]/g, '') : "";
    const scParsed = sc || "";

    const cleanRid = (scriptContent.match(/var\s+[a-zA-Z0-9_$]+=\s*['"]([a-f0-9]{16})['"]/i) || [])[1] || ridParsed;
    
    if (!scParsed || !cleanRid) return null;

    const idMatches = [...scriptContent.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
    const attrMatches = [...scriptContent.matchAll(/getAttribute\(['"](data-[^'"]+)['"]\)/g)].map(m => m[1]);

    if (idMatches.length < 5 || attrMatches.length < 3) return null;

    const [id1, id2, id3, id4, id5] = idMatches;
    const [attr1, attr2, attr3] = attrMatches;

    const e1Match = pageHtml.match(new RegExp(`<[^>]*id=["']${id1}["'][^>]*${attr1}=["']([^"']+)["']`, 'i'));
    const p1 = e1Match ? e1Match[1] : "";

    const e2Match = pageHtml.match(new RegExp(`<input[^>]*id=["']${id2}["'][^>]*value=["']([^"']+)["']`, 'i')) ||
                    pageHtml.match(new RegExp(`<input[^>]*value=["']([^"']+)["'][^>]*id=["']${id2}["']`, 'i'));
    const p2 = e2Match ? e2Match[1] : "";

    const e3Match = pageHtml.match(new RegExp(`<[^>]*id=["']${id3}["'][^>]*${attr2}=["']([^"']+)["']`, 'i'));
    const p3 = e3Match ? e3Match[1] : "";

    const tplMatch = pageHtml.match(new RegExp(`<template[^>]*id=["']${id4}["'][^>]*>([\\s\\S]*?)<\\/template>`, 'i'));
    const p4 = tplMatch ? tplMatch[1].replace(/<[^>]+>/g, "").trim() : "";

    const e5Match = pageHtml.match(new RegExp(`<[^>]*id=["']${id5}["'][^>]*${attr3}=["']([^"']+)["']`, 'i'));
    const ts = e5Match ? e5Match[1] : "";

    if (!p1 || !p2 || !p3 || !p4 || !ts) return null;

    const powChallenge = p1 + p2 + p3 + p4 + ts;
    let pow = null;
    let n = 0;
    while (n < 10000000) {
      const hex = n.toString(16);
      const hash = crypto.createHash("sha256").update(powChallenge + hex).digest();
      if (hash[0] === 0 && hash[1] === 0) {
        pow = hex;
        break;
      }
      n++;
    }
    if (!pow) return null;

    const mockFpData = {
      t: 2500,
      mm: [[100, 100, 100], [105, 105, 120], [110, 112, 140]],
      tm: [],
      cl: [[100, 100, 2000]],
      kp: [],
      sc: [],
      i: 1,
      mc: 3,
      tc: 0,
      cc: 1,
      kc: 0,
      b: { w: "ANGLE", v: "Google Inc.", sw: 1920, sh: 1080, aw: 1920, ah: 1080, cd: 24, pd: 24, tz: -120, hc: 8, dm: 8, pl: "Win32", lang: "en-US", langs: "en-US,en", dpr: 1, ww: 1920, wh: 1080, touch: false, pdf: true, fonts: 0 }
    };
    const fp = Buffer.from(JSON.stringify(mockFpData)).toString("base64");

    const params = new URLSearchParams({ vid, c: ct, p1, p2, p3, p4, t: ts, sc: scParsed, rid: cleanRid, fp, df: "", pow, pid: pid || "", st: st || "" });
    const getUrl = `https://hentaiplayer.com/get-video-url-v2.php?${params.toString()}`;
    const getRes = await fetch(getUrl, {
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": headers["User-Agent"],
        "Referer": playerUrl,
        "Cookie": cookieString
      }
    });
    if (!getRes.ok) return null;
    const payload = await getRes.json();
    return payload.url || null;
  } catch (err) {
    console.error("resolveHentaiPlayer error:", err.message);
    return null;
  }
}
