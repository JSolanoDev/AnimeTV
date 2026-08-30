// Detects duplicate top-level declarations across the classic scripts that
// index.html loads into ONE shared global scope (js/*.js + client.js).
//
// This is the structural risk of the monolith. It has already bitten once:
// client.js declared `let supabase`, the Supabase CDN bundle declares its own
// global `supabase`, and the collision threw
//   "Identifier 'supabase' has already been declared"
// which stopped the library loading and silently broke login. `node --check`
// passes on each file individually, because each file is valid on its own -
// only looking at them TOGETHER finds it.
//
// Also flags collisions against well-known browser/library globals.
//
// Run: node scripts/check-global-collisions.mjs   (part of `npm run check`)

import { readFileSync, existsSync } from "node:fs";

// Scripts index.html loads, in load order.
const html = existsSync("index.html") ? readFileSync("index.html", "utf8") : "";
const FILES = [...html.matchAll(/<script[^>]+src="([^"?]+)(?:\?[^"]*)?"/g)]
  .map((m) => m[1].replace(/^\.?\//, ""))
  .filter((p) => p.endsWith(".js") && !/^https?:/.test(p) && existsSync(p));

// Globals supplied by the browser or by CDN bundles the app loads. Redeclaring
// any of these at top level shadows or collides with the real one.
const RESERVED = new Set([
  "supabase", "Hls", "Artplayer", "videojs",
  "location", "history", "navigator", "document", "window", "screen",
  "name", "status", "origin", "length", "top", "parent", "self", "closed",
  "event", "external", "frames", "menubar", "toolbar"
]);

// Top-level (column-0) declarations only - anything indented is inside a scope.
const DECL = /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/;
const ASYNC_FN = /^async\s+function\s+([A-Za-z_$][\w$]*)/;

const owners = new Map();   // identifier -> [files]
let failed = 0;

for (const file of FILES) {
  const seenHere = new Set();
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(DECL) || line.match(ASYNC_FN);
    if (!m) continue;
    const id = m[1];
    if (seenHere.has(id)) continue;      // same file re-declaring is eslint's job
    seenHere.add(id);
    owners.set(id, [...(owners.get(id) || []), file]);
  }
}

const crossFile = [...owners.entries()].filter(([, files]) => files.length > 1);
if (crossFile.length) {
  failed += crossFile.length;
  console.log(`  FAIL  ${crossFile.length} identifier(s) declared at top level in more than one script:`);
  for (const [id, files] of crossFile) console.log(`          ${id} - ${files.join(", ")}`);
}

const reserved = [...owners.entries()].filter(([id]) => RESERVED.has(id));
if (reserved.length) {
  failed += reserved.length;
  console.log(`  FAIL  ${reserved.length} identifier(s) collide with a browser/library global:`);
  for (const [id, files] of reserved) console.log(`          ${id} - ${files.join(", ")}`);
}

if (failed) {
  console.log("\nGlobal collision check FAILED.");
  console.log("These scripts share ONE global scope. Rename the local one, or scope it inside an IIFE/function.\n");
  process.exit(1);
}
console.log(`\nNo global collisions across ${FILES.length} scripts (${owners.size} top-level identifiers).\n`);
