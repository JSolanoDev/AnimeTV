import fs from "node:fs";
import path from "node:path";
import { prepareCarouselArtwork } from "./lib/carousel-artwork.mjs";
import { buildHomepageBootstrap, writeHomepageBootstrap } from "./build-homepage-bootstrap.mjs";

// One-time seeding uses the same bounded checker as the daily/hourly updater.
const root = process.cwd();
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const artwork = read("scraper/artwork-map.json");
const idsIndex = process.argv.indexOf("--ids");
const ids = idsIndex >= 0 ? String(process.argv[idsIndex + 1] || "").split(",").filter(Boolean)
  : buildHomepageBootstrap(read("scraper/anime_metadata.json"), artwork, read("scraper/airing-map.json")).items.map(row => row.id);
try {
  const stats = await prepareCarouselArtwork(artwork.entries, ids);
  if (stats.checkedTitles) {
    const content = JSON.stringify(artwork);
    fs.writeFileSync(path.join(root, "scraper/artwork-map.json"), content);
    fs.writeFileSync(path.join(root, "android/app/src/main/assets/scraper/artwork-map.json"), content);
    writeHomepageBootstrap();
  }
  console.log(JSON.stringify(stats));
} catch (error) {
  console.error(error.message);
  if (error.retryAfter) console.error(`Retry-After: ${error.retryAfter}; no immediate retry.`);
  process.exitCode = 1;
}
