import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, extname } from "node:path";
import { minify as terserMinify } from "terser";
import CleanCSS from "clean-css";

const files = [
  "index.html",
  "offline.html",
  "styles.css",
  "update-manager.js",
  "manifest.webmanifest",
  "sources.json",
  "logo-mark.png",
  "logo-mark-192.png",
  "logo-mark-512.png",
  "logo-mark-transparent.png",
  "logo-wordmark.png",
  "logo-round.png",
  "logo-round-192.png",
  "favicon-32.png",
  "service-worker.js"
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

async function minifyJsFile(filePath) {
  try {
    const code = readFileSync(filePath, "utf8");
    const result = await terserMinify(code, {
      compress: { passes: 2 },
      mangle: true,
      format: { comments: false }
    });
    if (result.code) {
      const saved = code.length - result.code.length;
      writeFileSync(filePath, result.code);
      return saved;
    }
  } catch (err) {
    console.warn(`  ⚠ terser skipped ${filePath}: ${err.message}`);
  }
  return 0;
}

function minifyCssFile(filePath) {
  try {
    const code = readFileSync(filePath, "utf8");
    const result = new CleanCSS({ level: 2 }).minify(code);
    if (result.styles && result.errors.length === 0) {
      const saved = code.length - result.styles.length;
      writeFileSync(filePath, result.styles);
      return saved;
    }
    if (result.errors.length) console.warn(`  ⚠ clean-css errors in ${filePath}:`, result.errors);
  } catch (err) {
    console.warn(`  ⚠ clean-css skipped ${filePath}: ${err.message}`);
  }
  return 0;
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

(async () => {
  for (const outDir of outDirs) {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    for (const file of files) {
      copyFileSync(join(sourceDir, file), join(outDir, file));
    }

    copyFileSync(join(sourceDir, "client.js"), join(outDir, "client.js"));
    copyDir(join(sourceDir, "js"), join(outDir, "js"));
    copyDir(join(sourceDir, "player"), join(outDir, "player"));

    console.log(`Minifying ${outDir}...`);
    const { jsSaved, cssSaved } = await minifyDir(outDir);
    console.log(`  JS: -${(jsSaved / 1024).toFixed(1)} KiB  |  CSS: -${(cssSaved / 1024).toFixed(1)} KiB`);
  }

  console.log(`\nZenkaiTV static build ready in ${outDirs.join(" and ")}`);
})();
