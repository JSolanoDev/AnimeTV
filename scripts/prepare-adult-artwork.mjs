import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { AdultUpstreamUnavailableError } from "./lib/adult-upstream.mjs";
import { createArtworkChecker } from "./lib/artwork-availability.mjs";

const HOSTS = new Set(["static.underhentai.net", "img.hentaihaven.xxx", "shikimori.one", "lain.bgm.tv"]);
const POSTER_FIELDS = ["mainWallpaper", "image", "poster", "cover", "thumbnail", "coverImage"];
const BACKGROUND_FIELDS = ["highQualityBackground", "underHentaiBackdrop", "adultBackground", "backdrop", "banner"];
const FILES = ["underhentai_catalog.json", "underhentai_details.json", "adult_portrait_map.json"];

const usableUrl = createArtworkChecker({ hosts: HOSTS }).usable;

function candidates(item = {}, fields = []) {
  return fields.map(field => item[field]).filter(usableUrl);
}

function knownArtwork(snapshot) {
  const urls = new Set();
  for (const file of FILES) {
    const body = snapshot.get(`scraper/${file}`);
    if (!body) continue;
    const payload = JSON.parse(body.toString("utf8"));
    const items = Array.isArray(payload.items) ? payload.items : Object.values(payload.items || {});
    for (const item of items) {
      for (const value of [item.url, ...candidates(item, [...POSTER_FIELDS, ...BACKGROUND_FIELDS]),
        ...Object.values(item.images || {}), ...(item.screenshots || [])]) {
        if (usableUrl(value)) urls.add(value);
      }
    }
  }
  return urls;
}

export async function prepareAdultArtwork({ root, baseline = new Map(), fetchImpl = globalThis.fetch,
  timeoutMs = 6000, intervalMs = 550, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const read = async name => JSON.parse(await readFile(resolve(root, `scraper/${name}`), "utf8"));
  const [catalog, details, portraits] = await Promise.all(FILES.map(read));
  const original = structuredClone({ catalog, details, portraits });
  const detailsBySlug = new Map((details.items || []).map(item => [item.slug, item]));
  const priorCatalog = baseline.get("scraper/underhentai_catalog.json");
  const priorBySlug = new Map((priorCatalog ? JSON.parse(priorCatalog.toString("utf8")).items || [] : []).map(item => [item.slug, item]));
  const { check, pick, stats } = createArtworkChecker({ hosts: HOSTS, known: knownArtwork(baseline),
    fetchImpl, timeoutMs, intervalMs, sleep, maxChecks: Infinity,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ZenkaiTVAdultCatalog/1.0)", Referer: "https://www.underhentai.net/" },
    unavailableError: (message, options) => new AdultUpstreamUnavailableError(message, options) });
  stats.repairedTitles = 0;

  for (const item of catalog.items || []) {
    const detail = detailsBySlug.get(item.slug);
    if (!detail) throw new Error("Artwork preparation requires a complete detail snapshot.");
    const previous = priorBySlug.get(item.slug) || {};
    const poster = await pick([...candidates(item, POSTER_FIELDS), ...candidates(detail, POSTER_FIELDS),
      ...candidates(previous, POSTER_FIELDS), ...(detail.screenshots || [])]);
    const background = await pick([...candidates(item, BACKGROUND_FIELDS), ...candidates(detail, BACKGROUND_FIELDS),
      ...(detail.screenshots || []), ...candidates(previous, BACKGROUND_FIELDS), poster]);
    if (!poster || !background) throw new Error("New title artwork is unavailable; refusing to publish an incomplete catalog.");
    let repaired = false;
    for (const target of [item, detail]) {
      const before = structuredClone(target);
      for (const field of POSTER_FIELDS) target[field] = poster;
      for (const field of BACKGROUND_FIELDS) target[field] = background;
      target.images = { ...target.images, poster, cover: poster, thumbnail: poster, banner: background, backdrop: background };
      repaired ||= !isDeepStrictEqual(before, target);
    }
    const portrait = portraits.items?.[item.slug];
    if (portrait && !(await check(portrait.url))) {
      delete portraits.items[item.slug];
      repaired = true;
    }
    if (repaired) stats.repairedTitles++;
  }
  portraits.total = Object.keys(portraits.items || {}).length;
  for (const [name, payload, before] of [
    [FILES[0], catalog, original.catalog], [FILES[1], details, original.details], [FILES[2], portraits, original.portraits]
  ]) {
    if (isDeepStrictEqual(payload, before)) continue;
    const body = `${JSON.stringify(payload, null, 2)}\n`;
    for (const prefix of ["scraper", "android/app/src/main/assets/scraper"]) {
      await writeFile(resolve(root, prefix, name), body);
    }
  }
  return stats;
}
