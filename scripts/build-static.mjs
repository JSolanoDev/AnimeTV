import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const files = [
  "index.html",
  "offline.html",
  "styles.css",
  "update-manager.js",
  "manifest.webmanifest",
  "sources.json",
  "icon.svg",
  "service-worker.js"
];

const outDirs = ["dist", "public"];
const sourceDir = existsSync("vercel-static") ? "vercel-static" : ".";

function copyDir(source, target) {
  if (!existsSync(source)) return;
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) copyDir(sourcePath, targetPath);
    else copyFileSync(sourcePath, targetPath);
  }
}

for (const outDir of outDirs) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  for (const file of files) {
    copyFileSync(join(sourceDir, file), join(outDir, file));
  }

  copyFileSync(join(sourceDir, "client.js"), join(outDir, "client.js"));
  copyDir(join(sourceDir, "js"), join(outDir, "js"));
}

console.log(`AnimeTV static build ready in ${outDirs.join(" and ")}`);
