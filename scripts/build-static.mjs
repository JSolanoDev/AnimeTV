import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { minify as terserMinify } from "terser";
import CleanCSS from "clean-css";
import { writeHomepageBootstrap } from "./build-homepage-bootstrap.mjs";
import { buildInputHash, canReuseStaticBuild, listStaticFiles, writeBuildManifest } from "./static-build-artifacts.mjs";

const require = createRequire(import.meta.url);

const files = [
  "index.html",
  "offline.html",
  "styles.css",
  "update-manager.js",
  "manifest.webmanifest",
  "homepage-bootstrap.json",
  "sources.json",
  "logo-mark.png",
  "logo-mark-192.png",
  "logo-mark-512.png",
  "logo-mark-transparent.png",
  "logo-mark-128.webp",
  "logo-wordmark.png",
  "logo-wordmark-480.webp",
  "logo-round.png",
  "logo-round-192.png",
  "logo-round-192.webp",
  "hero-backdrop-placeholder.webp",
  "favicon-32.png",
  "service-worker.js",
  // Crawler / SEO files — must be copied into the build output (dist) or Vercel's
  // SPA rewrite (/(.*) -> /index.html) serves index.html for them instead.
  "robots.txt",
  "llms.txt",
  "sitemap.xml"
];

const outDirs = ["dist", "public"];
const sourceDir = ".";

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

export async function minifyJsFile(filePath) {
  const code = readFileSync(filePath, "utf8");
  const result = await terserMinify(code, {
    compress: {
      passes: 3,
      pure_funcs: ["console.log", "console.debug", "console.info"],
      drop_debugger: true
    },
    mangle: true,
    format: { comments: false }
  });
  if (typeof result.code === "string") {
    const saved = code.length - result.code.length;
    writeFileSync(filePath, result.code);
    return saved;
  }
  throw new Error(`Terser returned no output for ${filePath}`);
}

export function minifyCssFile(filePath) {
  const code = readFileSync(filePath, "utf8");
  const result = new CleanCSS({ level: 2 }).minify(code);
  if (result.errors.length === 0 && typeof result.styles === "string") {
    const saved = code.length - result.styles.length;
    writeFileSync(filePath, result.styles);
    return saved;
  }
  throw new Error(`CSS minification failed for ${filePath}: ${result.errors.join(", ")}`);
}

async function minifyDir(dir) {
  let jsSaved = 0, cssSaved = 0;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await minifyDir(fullPath);
      jsSaved += sub.jsSaved;
      cssSaved += sub.cssSaved;
    } else if (extname(entry.name) === ".js") {
      jsSaved += await minifyJsFile(fullPath);
    } else if (extname(entry.name) === ".css") {
      cssSaved += minifyCssFile(fullPath);
    }
  }
  return { jsSaved, cssSaved };
}

async function buildStatic() {
  writeHomepageBootstrap();
  const assetFiles = [...files, "client.js", ...["js", "player", "mascot"].flatMap((directory) =>
    existsSync(directory) ? listStaticFiles(directory).map((file) => directory + "/" + file) : [])];
  const inputsSha256 = buildInputHash([...assetFiles, "package.json", "scripts/build-static.mjs",
    "scripts/build-homepage-bootstrap.mjs", "scripts/static-build-artifacts.mjs"], {
    terser: require("terser/package.json").version,
    cleanCss: require("clean-css/package.json").version
  });
  // Vercel's static and API builders both invoke the reserved lifecycle hook.
  // Reuse only complete, unchanged output so the API hook cannot rebuild dist.
  if (process.argv.includes("--if-needed") && outDirs.every((directory) =>
    canReuseStaticBuild(directory, inputsSha256, assetFiles))) {
    console.log("ZenkaiTV static build already verified; reusing dist and public");
    return;
  }
  for (const outDir of outDirs) {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    for (const file of files) {
      copyFileSync(join(sourceDir, file), join(outDir, file));
    }

    copyFileSync(join(sourceDir, "client.js"), join(outDir, "client.js"));
    copyDir(join(sourceDir, "js"), join(outDir, "js"));
    copyDir(join(sourceDir, "player"), join(outDir, "player"));
    // Player top-bar mascot sprites. Only js/ and player/ were copied, so these
    // existed locally but 404'd in production - the whole slot would have removed
    // itself on the deployed site while looking fine on the dev server.
    copyDir(join(sourceDir, "mascot"), join(outDir, "mascot"));

    console.log(`Minifying ${outDir}...`);
    const { jsSaved, cssSaved } = await minifyDir(outDir);
    console.log(`  JS: -${(jsSaved / 1024).toFixed(1)} KiB  |  CSS: -${(cssSaved / 1024).toFixed(1)} KiB`);
    writeBuildManifest(outDir, inputsSha256);
  }

  console.log(`\nZenkaiTV static build ready in ${outDirs.join(" and ")}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  buildStatic().catch((error) => {
    console.error(`Static build failed: ${error.message}`);
    process.exitCode = 1;
  });
}
