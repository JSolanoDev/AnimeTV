import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { catalogRows, parseSchedule } = require("../lib/animeyt-provider.cjs");
const file = path.resolve("scraper/animeyt-index.json");
const incremental = process.argv.includes("--incremental");
let previous = { items: [], schedule: [] };
try { previous = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* First snapshot. */ }
async function request(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(12000), redirect: "error" });
  if (!response.ok) throw new Error(`AnimeYT index HTTP ${response.status}`);
  return response;
}
try {
  const url = "https://animeyt.cc/wp-json/wp/v2/anime?per_page=100&_fields=id,slug,link,title";
  const first = await request(url);
  const pages = Number(first.headers.get("x-wp-totalpages"));
  if (!Number.isInteger(pages) || pages < 1 || pages > 60) throw new Error("Invalid catalog page count");
  const rows = await first.json();
  if (!incremental || !previous.items.length) {
    // One paced request at a time; no per-episode or per-video catalog scan.
    for (let page = 2; page <= pages; page++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      rows.push(...await (await request(`${url}&page=${page}`)).json());
    }
  }
  const discovered = catalogRows(rows);
  if (!discovered.length || (!incremental && discovered.length < previous.items.length * 0.8)) throw new Error("Incomplete catalog; keeping prior snapshot");
  const bySlug = new Map(previous.items.map(row => [row.slug, row]));
  discovered.forEach(row => bySlug.set(row.slug, row));
  const schedule = parseSchedule(await (await request("https://animeyt.cc/horario/")).text());
  if (!schedule.length) throw new Error("Empty schedule; keeping prior snapshot");
  const snapshot = { schema: 1, generatedAt: new Date().toISOString(),
    items: [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug)), schedule };
  if (JSON.stringify(snapshot.items) === JSON.stringify(previous.items)
    && JSON.stringify(snapshot.schedule) === JSON.stringify(previous.schedule)) {
    console.log("AnimeYT index unchanged; no publication needed.");
    process.exit(0);
  }
  const text = JSON.stringify(snapshot, null, 2) + "\n";
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
  console.log(`AnimeYT index: ${snapshot.items.length} titles, ${schedule.length} timestamped schedule events (${incremental ? "incremental" : "full"}).`);
} catch (error) {
  console.error(`AnimeYT index not published: ${error.message}. Prior snapshot preserved.`);
  process.exitCode = 1;
}
