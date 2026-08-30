// Bumps every ?v=NNN in index.html, CACHE_NAME in service-worker.js, and the
// local asset refs inside client.js / js/*.js — for both the repo root and the
// Android assets mirror — to one new version.
//
// Doing this by hand is how the shell ended up on v486 while client.js still
// asked for /update-manager.js?v=338: a cache-first service worker then pins
// users to a script ~150 versions stale. Run this instead of editing by hand.
//
// Run: node scripts/bump-asset-version.mjs [version]   (default: current + 1)
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";

const cur = Number(readFileSync("index.html", "utf8").match(/\?v=(\d+)/)?.[1]);
if (!Number.isFinite(cur)) { console.error("Could not read current version from index.html"); process.exit(1); }
const next = Number(process.argv[2] || cur + 1);
if (!Number.isFinite(next) || next <= 0) { console.error(`Bad target version: ${process.argv[2]}`); process.exit(1); }

const files = [
  "index.html", "service-worker.js", "client.js",
  // player.html carries its OWN ?v= refs to player.css/player.js. They were not
  // bumped here, so they sat at v504 while the shell moved to v506 - and since
  // .js/.css are served immutable for a year, anyone who had cached v504 kept a
  // stale player until the URL changed. Same failure as /update-manager.js?v=338.
  "player/player.html",
  "android/app/src/main/assets/player/player.html",
  "android/app/src/main/assets/index.html",
  "android/app/src/main/assets/service-worker.js",
  "android/app/src/main/assets/client.js",
  ...(existsSync("js") ? readdirSync("js").filter((f) => f.endsWith(".js")).map((f) => `js/${f}`) : [])
];

let touched = 0;
for (const f of files) {
  if (!existsSync(f)) continue;
  const before = readFileSync(f, "utf8");
  const after = before
    .replace(/\?v=\d+/g, `?v=${next}`)
    .replace(/CACHE_NAME\s*=\s*"zenkaitv-v\d+"/, `CACHE_NAME = "zenkaitv-v${next}"`);
  if (after !== before) { writeFileSync(f, after); touched++; console.log(`  bumped ${f}`); }
}
console.log(`\nv${cur} -> v${next} across ${touched} file(s).`);
