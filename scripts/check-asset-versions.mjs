// Guards the cache-busting invariant documented in CLAUDE.md.
//
// index.html references every asset as `name.ext?v=NNN`, and the service worker
// caches under `zenkaitv-vNNN`. If those drift apart, browsers can serve a STALE
// js/*.js helper against a FRESH client.js — the helper's constants are missing,
// client.js throws a ReferenceError at module scope, and the whole app
// white-screens. That has happened twice in this repo, so it is checked here
// rather than remembered.
//
// Run: node scripts/check-asset-versions.mjs   (also part of `npm run check`)

import { readFileSync, existsSync, readdirSync } from "node:fs";

const TARGETS = [
  { html: "index.html", sw: "service-worker.js", label: "root" },
  {
    html: "android/app/src/main/assets/index.html",
    sw: "android/app/src/main/assets/service-worker.js",
    label: "android"
  }
];

let failed = 0;

for (const { html, sw, label } of TARGETS) {
  if (!existsSync(html)) { console.log(`  SKIP  ${label}: ${html} not found`); continue; }

  const markup = readFileSync(html, "utf8");
  const versions = [...markup.matchAll(/\?v=(\d+)/g)].map((m) => m[1]);
  const unique = [...new Set(versions)];

  if (!versions.length) {
    console.log(`  WARN  ${label}: no ?v= cache-busters found in ${html}`);
    continue;
  }

  if (unique.length !== 1) {
    failed++;
    console.log(`  FAIL  ${label}: ${unique.length} different asset versions in ${html} -> ${unique.join(", ")}`);
    // Name the odd ones out so the fix is obvious.
    const counts = Object.fromEntries(unique.map((v) => [v, versions.filter((x) => x === v).length]));
    const majority = unique.sort((a, b) => counts[b] - counts[a])[0];
    for (const m of markup.matchAll(/(?:src|href)="([^"]+)\?v=(\d+)"/g)) {
      if (m[2] !== majority) console.log(`          ${m[1]} is v${m[2]} (most files are v${majority})`);
    }
  } else {
    console.log(`  PASS  ${label}: all ${versions.length} asset refs on v${unique[0]}`);
  }

  if (!existsSync(sw)) { console.log(`  WARN  ${label}: ${sw} not found`); continue; }
  const swText = readFileSync(sw, "utf8");
  const swMatch = swText.match(/CACHE_NAME\s*=\s*"zenkaitv-v(\d+)"/);
  if (!swMatch) {
    failed++;
    console.log(`  FAIL  ${label}: could not read CACHE_NAME from ${sw}`);
  } else if (unique.length === 1 && swMatch[1] !== unique[0]) {
    failed++;
    console.log(`  FAIL  ${label}: service worker is v${swMatch[1]} but assets are v${unique[0]}`);
  } else if (unique.length === 1) {
    console.log(`  PASS  ${label}: service worker matches at v${swMatch[1]}`);
  }
}

// JS files also hardcode local asset URLs (e.g. the hero placeholder that
// renderCarousel falls back to). Those were never checked here, so one sat at
// ?v=338 for ~150 versions: a cache MISS on every carousel reset, silently
// re-fetching a file the shell had already cached. Cheap to check, invisible
// otherwise.
const SCANNED_JS = [
  "client.js",
  ...(existsSync("js") ? readdirSync("js").filter((f) => f.endsWith(".js")).map((f) => `js/${f}`) : [])
];
const ASSET_REF = /["'`]([\w./-]+\.(?:webp|png|jpe?g|svg|css|js|json))\?v=(\d+)/g;
const rootVersionMatch = existsSync("index.html")
  ? readFileSync("index.html", "utf8").match(/\?v=(\d+)/)
  : null;

if (rootVersionMatch) {
  const rootVersion = rootVersionMatch[1];
  let jsDrift = 0;
  for (const file of SCANNED_JS) {
    if (!existsSync(file)) continue;
    for (const m of readFileSync(file, "utf8").matchAll(ASSET_REF)) {
      if (m[2] !== rootVersion) {
        jsDrift++;
        failed++;
        console.log(`  FAIL  js: ${file} references ${m[1]}?v=${m[2]} but index.html is on v${rootVersion}`);
      }
    }
  }
  if (!jsDrift) console.log(`  PASS  js: no stale ?v= asset refs across ${SCANNED_JS.length} script files`);
}

if (failed) {
  console.log(`\nAsset version check FAILED (${failed} problem${failed === 1 ? "" : "s"}).`);
  console.log("Bump EVERY ?v= in index.html and CACHE_NAME in service-worker.js to the same value.\n");
  process.exit(1);
}
console.log("\nAsset versions are consistent.\n");
