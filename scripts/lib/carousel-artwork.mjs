import sharp from "sharp";
import { createRequire } from "node:module";
import { ArtworkUpstreamUnavailableError } from "./artwork-availability.mjs";

const { verifiedCarouselArtwork } = createRequire(import.meta.url)("../../js/utils.js");
const RETRY_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 8 * 1024 * 1024;

export function selectCarouselArtworkIds(ids, entries, now = Date.now(), limit = 12) {
  return [...new Set(ids)].filter(id => {
    const art = entries[id];
    if (!art?.tmdbBackdrop || verifiedCarouselArtwork(art.carouselArtwork, art.tmdbBackdrop)) return false;
    const checked = Date.parse(art.carouselArtworkCheckedAt || "");
    return art.carouselArtworkCheckedUrl !== art.tmdbBackdrop || !Number.isFinite(checked) || now - checked >= RETRY_MS;
  }).slice(0, limit);
}

export async function prepareCarouselArtwork(entries, ids, { fetchImpl = fetch, now = Date.now(),
  intervalMs = 550, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const selected = selectCarouselArtworkIds(ids, entries, now);
  const probes = new Map();
  let lastRequestAt = 0;
  let checkedUrls = 0;
  for (const id of selected) {
    const art = entries[id];
    const url = art.tmdbBackdrop;
    // The same URL can serve exact seasons of one franchise. Decode it once.
    if (!probes.has(url)) {
      probes.set(url, (async () => {
        if (!verifiedCarouselArtwork({ version: 1, url, width: 1920, height: 1080 }, url)) return null;
        const delay = Math.max(0, lastRequestAt + intervalMs - Date.now());
        if (delay) await sleep(delay);
        lastRequestAt = Date.now();
        checkedUrls++;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        let response;
        try {
          response = await fetchImpl(url, { signal: controller.signal, redirect: "error",
            headers: { Accept: "image/*", "User-Agent": "ZenkaiTV-carousel-artwork/1.0" } });
          if ([403, 408, 429].includes(response.status) || response.status >= 500) {
            throw new ArtworkUpstreamUnavailableError(`Carousel artwork HTTP ${response.status}`,
              { status: response.status, retryAfter: response.headers.get("retry-after") });
          }
          if (!response.ok || !/^image\//i.test(response.headers.get("content-type") || "")) return null;
          if (Number(response.headers.get("content-length")) > MAX_BYTES || !response.body) return null;
          const chunks = [];
          let bytes = 0;
          for await (const chunk of response.body) {
            bytes += chunk.byteLength;
            if (bytes > MAX_BYTES) return null;
            chunks.push(Buffer.from(chunk));
          }
          let metadata;
          try {
            metadata = await sharp(Buffer.concat(chunks), { limitInputPixels: 36_000_000 }).metadata();
          } catch { return null; }
          const proof = { version: 1, url, width: metadata.width, height: metadata.height };
          return verifiedCarouselArtwork(proof, url) ? proof : null;
        } catch (error) {
          if (error instanceof ArtworkUpstreamUnavailableError) throw error;
          throw new ArtworkUpstreamUnavailableError("Carousel artwork request failed or timed out", { cause: error });
        } finally {
          clearTimeout(timer);
          controller.abort();
          await response?.body?.cancel().catch(() => {});
        }
      })());
    }
    const proof = await probes.get(url);
    if (proof) art.carouselArtwork = proof;
    else delete art.carouselArtwork;
    art.carouselArtworkCheckedAt = new Date(now).toISOString();
    art.carouselArtworkCheckedUrl = url;
  }
  return { checkedUrls, checkedTitles: selected.length };
}
