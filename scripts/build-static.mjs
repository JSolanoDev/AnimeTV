import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const files = [
  "index.html",
  "offline.html",
  "styles.css",
  "app.js",
  "update-manager.js",
  "manifest.webmanifest",
  "sources.json",
  "icon.svg",
  "service-worker.js"
];

const outDir = "dist";
const sourceDir = existsSync("vercel-static") ? "vercel-static" : ".";
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const file of files) {
  copyFileSync(join(sourceDir, file), join(outDir, file));
}

console.log(`AnimeTV static build ready in ${outDir}`);
