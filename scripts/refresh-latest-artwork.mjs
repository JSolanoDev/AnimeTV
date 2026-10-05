import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const { parseAnimeAv1Latest } = createRequire(import.meta.url)("../animetv-server.js");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RETRY_MS = 24 * 60 * 60 * 1000;

export function latestArtworkRows(feed) {
  const rows = new Map();
  for (const item of feed?.items || []) {
    const slug = String(item.slug || "");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || !item.title) continue;
    const id = `animeav1-${slug}`;
    if (rows.has(id)) continue;
    rows.set(id, { id, title: item.title, image: item.image || "", source: "AnimeAV1",
      siteUrl: `https://animeav1.com/media/${slug}` });
  }
  return [...rows.values()];
}

export function selectLatestArtwork(rows, entries, now = Date.now(), limit = 12) {
  return rows.filter(({ id }) => {
    const saved = entries[id];
    const complete = saved?.status === "ok" && saved.tmdbBackdrop
      && (saved.tmdbPoster || saved.anilistCover) && saved.meta?.description && saved.meta?.genres?.length;
    if (complete) return false;
    const checkedAt = Date.parse(saved?.artworkCheckedAt || "");
    return !Number.isFinite(checkedAt) || now - checkedAt >= RETRY_MS;
  }).sort((a, b) => Number(!entries[b.id]) - Number(!entries[a.id])).slice(0, limit);
}

export function selectLatestAiring(rows, entries, now = Date.now(), limit = 50) {
  return rows.filter(({ id }) => {
    const saved = entries[id];
    if (!saved?.anilistId || ["FINISHED", "CANCELLED"].includes(saved.meta?.airingStatus)) return false;
    const checkedAt = Date.parse(saved.airingCheckedAt || "");
    return !Number.isFinite(checkedAt) || now - checkedAt >= RETRY_MS;
  }).slice(0, limit);
}

export async function refreshLatestArtwork({ base = "https://zenkaitv.com", fetchImpl = fetch, rootDir = root,
  run = (script, args) => {
    const result = spawnSync(process.execPath, [path.join(root, "scripts", script), ...args],
      { cwd: root, stdio: "inherit" });
    if (result.error || result.status !== 0) throw result.error || new Error(`${script} exited ${result.status}`);
  } } = {}) {
  const mapPath = path.join(rootDir, "scraper", "artwork-map.json");
  const before = fs.readFileSync(mapPath, "utf8");
  const saved = JSON.parse(before);
  // Reuse the provider parser offline: idle jobs invoke no Vercel Functions.
  const response = await fetchImpl("https://animeav1.com/",
    { signal: AbortSignal.timeout(15000), headers: { Accept: "text/html", "User-Agent": "ZenkaiTV-catalog-artwork/1.0" } });
  if (!response.ok) throw new Error(`Latest release feed HTTP ${response.status}; keeping saved artwork.`);
  const rows = latestArtworkRows({ items: parseAnimeAv1Latest(await response.text()) });
  if (!rows.length) throw new Error("Latest release feed contained no valid titles; keeping saved artwork.");
  const selected = selectLatestArtwork(rows, saved.entries || {});
  const scheduleRows = selectLatestAiring(rows, saved.entries || {});
  if (!selected.length && !scheduleRows.length) {
    console.log("Latest release artwork and schedules are current; no lookups or writes."); return [];
  }
  const snapshots = new Map(["scraper/artwork-map.json", "scraper/airing-map.json", "scraper/anime_metadata.json",
    "android/app/src/main/assets/scraper/artwork-map.json", "homepage-bootstrap.json"]
    .map(file => path.join(rootDir, file)).filter(file => fs.existsSync(file))
    .map(file => [file, fs.readFileSync(file)]));
  const scratch = path.join(rootDir, "scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const input = path.join(scratch, "latest-artwork-input.json");
  fs.writeFileSync(input, JSON.stringify({ items: selected }));
  const ids = [...new Set([...selected, ...scheduleRows].map(({ id }) => id))].join(",");
  try {
    if (selected.length) run("build-artwork-map.mjs", ["--catalog", input,
      "--ids", selected.map(({ id }) => id).join(","), "--base", base,
      "--concurrency", "1", "--max-minutes", "6", "--mark-checked"]);
    run("add-artwork-metadata.mjs", ["--ids", ids, "--refresh-airing", "--max-minutes", "3"]);
    // Metadata-only misses also respect the daily retry limit.
    const updated = JSON.parse(fs.readFileSync(mapPath, "utf8"));
    for (const { id } of selected) {
      if (updated.entries[id]) updated.entries[id].artworkCheckedAt = new Date().toISOString();
    }
    fs.writeFileSync(mapPath, JSON.stringify(updated));
    run("prepare-regular-artwork.mjs", ["--max-minutes", "5"]);
    run("build-homepage-bootstrap.mjs", []);
  } catch (error) {
    for (const [file, bytes] of snapshots) fs.writeFileSync(file, bytes);
    throw error;
  } finally {
    fs.rmSync(input, { force: true });
  }
  console.log(`Prepared artwork for ${selected.length} titles and checked ${ids.split(",").length} recent schedules; episode inventories unchanged.`);
  return ids.split(",");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--base");
  refreshLatestArtwork({ base: index >= 0 ? process.argv[index + 1] : undefined })
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
