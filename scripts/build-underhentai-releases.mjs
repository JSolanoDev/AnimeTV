import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseReleases, attachReleaseCatalog } from "./lib/underhentai-releases.mjs";

const OUTPUTS = ["scraper/underhentai_releases.json", "android/app/src/main/assets/scraper/underhentai_releases.json"];
const currentYear = new Date().getUTCFullYear();
const readJson = path => readFile(path, "utf8").then(JSON.parse);
const previous = await readJson(OUTPUTS[0]).catch(() => ({ years: {} }));
const catalog = await readJson("scraper/underhentai_catalog.json");
const details = await readJson("scraper/underhentai_details.json");

async function fetchYear(year) {
  const response = await fetch(`https://www.underhentai.net/releases/${year}/`, {
    headers: { "User-Agent": "ZenkaiTVReleaseCalendar/1.0", Accept: "text/html" },
    signal: AbortSignal.timeout(25000)
  });
  if (!response.ok) throw new Error(`Release year ${year}: HTTP ${response.status}`);
  const parsed = parseReleases(await response.text(), year);
  if (!parsed.entries.length) throw new Error(`Release year ${year} returned no dated episodes; retaining the saved calendar.`);
  return parsed;
}

const latest = await fetchYear(currentYear);
const firstYear = Math.max(2012, Math.min(...latest.years));
const lastYear = Math.min(currentYear + 1, Math.max(...latest.years));
const years = { ...previous.years, [currentYear]: latest.entries };
for (let year = firstYear; year <= lastYear; year++) {
  if (year === currentYear || (!process.argv.includes("--all") && years[year]?.length && year < currentYear - 1)) continue;
  await new Promise(resolve => setTimeout(resolve, 600));
  try {
    years[year] = (await fetchYear(year)).entries;
  } catch (error) {
    if (!years[year]?.length) throw error;
    console.warn(error.message);
  }
}
for (const year of Object.keys(years)) years[year] = attachReleaseCatalog(years[year], catalog.items, details.items);
const payload = { source: "UnderHentai", generatedAt: new Date().toISOString(), years };
const body = `${JSON.stringify(payload, null, 2)}\n`;
for (const output of OUTPUTS) {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, body);
}
console.log(`Saved ${Object.values(years).reduce((sum, entries) => sum + entries.length, 0)} release dates across ${Object.keys(years).length} years to web and Android.`);
