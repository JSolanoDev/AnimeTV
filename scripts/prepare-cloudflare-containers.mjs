import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareCloudflare } from "./prepare-cloudflare.mjs";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const contextDirectory = resolve(root, ".cache/cloudflare-container-context");
export const BACKEND_FILES = ["package.json", "package-lock.json", "animetv-server.js",
  "lib/animeyt-provider.cjs", "js/apk-oneanime.js", "scraper/anime_metadata.json",
  "scraper/anime_metadata.previous.json", "scraper/animeyt-index.json", "scraper/animeneon-catalog.json",
  "scraper/tioanime_slugs.json", "scraper/aniskip-map.json", "scraper/artwork-map.json",
  "scraper/airing-map.json", "scraper/adult_portrait_map.json", "scraper/underhentai_catalog.json",
  "scraper/underhentai_details.json", "scraper/underhentai_releases.json", "scraper/veohentai_catalog.json",
  "scraper/veohentai_details.json", "scraper/hentaila_catalog.json", "scraper/hentaila_details.json",
  "scraper/regular-source-fallbacks.json"];
const sources = new Map(BACKEND_FILES.map((name) => [name, name]));
sources.set("container-entry.cjs", "ops/cloudflare/container-entry.cjs");
sources.set("container-network.cjs", "ops/cloudflare/container-network.cjs");
sources.set("Dockerfile", "ops/cloudflare/Dockerfile");

function safePath(name) {
  const candidate = join(root, name);
  const actual = realpathSync(candidate);
  if (!actual.startsWith(realpathSync(root) + sep) || !lstatSync(candidate).isFile()) {
    throw new Error(`Refusing non-regular or escaped build input: ${name}`);
  }
  return candidate;
}

export function verifyContainerContext() {
  const allowed = new Set([...sources.keys(), ".dockerignore", "context-manifest.json"]);
  function checkDirectory(directory, prefix = "") {
    for (const name of readdirSync(directory)) {
      const relative = prefix + name;
      const stat = lstatSync(join(directory, name));
      if (stat.isDirectory() && !stat.isSymbolicLink()) checkDirectory(join(directory, name), relative + "/");
      else if (!stat.isFile() || !allowed.has(relative)) throw new Error(`Unexpected container input: ${relative}`);
    }
  }
  checkDirectory(contextDirectory);
  const manifest = JSON.parse(readFileSync(join(contextDirectory, "context-manifest.json"), "utf8"));
  if (JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify([...sources.keys()].sort())) {
    throw new Error("Container context whitelist mismatch");
  }
  for (const [target, source] of sources) {
    const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
    if (hash(join(contextDirectory, target)) !== manifest.files[target] || hash(safePath(source)) !== manifest.files[target]) {
      throw new Error(`Stale or modified container input: ${target}`);
    }
  }
  return manifest;
}

export function prepareContainerContext() {
  const pkg = JSON.parse(readFileSync(safePath("package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(safePath("package-lock.json"), "utf8"));
  const locked = lock.packages?.[""];
  if (!lock.packages?.["node_modules/cheerio"]?.dependencies?.undici || !lock.packages?.["node_modules/undici"] || lock.packages["node_modules/undici"].dev) {
    throw new Error("Container network policy requires Cheerio's locked production Undici dependency");
  }
  for (const group of ["dependencies", "devDependencies"]) {
    if (JSON.stringify(Object.entries(pkg[group] || {}).sort()) !== JSON.stringify(Object.entries(locked?.[group] || {}).sort())) {
      throw new Error("Existing dependency lockfile does not match package.json");
    }
  }
  for (const source of sources.values()) safePath(source);
  mkdirSync(dirname(contextDirectory), { recursive: true });
  if (realpathSync(dirname(contextDirectory)) !== resolve(realpathSync(root), ".cache")) {
    throw new Error("Build context parent must stay inside the repository cache");
  }
  if (lstatIfExists(contextDirectory)?.isSymbolicLink()) throw new Error("Refusing linked build context");
  rmSync(contextDirectory, { recursive: true, force: true });
  mkdirSync(contextDirectory);
  const files = {};
  for (const [target, source] of sources) {
    mkdirSync(dirname(join(contextDirectory, target)), { recursive: true });
    copyFileSync(safePath(source), join(contextDirectory, target));
    files[target] = createHash("sha256").update(readFileSync(join(contextDirectory, target))).digest("hex");
  }
  writeFileSync(join(contextDirectory, ".dockerignore"), ".env*\n.git\n.vercel\nnode_modules\ncontext-manifest.json\n");
  writeFileSync(join(contextDirectory, "context-manifest.json"), JSON.stringify({ files }, null, 2) + "\n");
  verifyContainerContext();
  return files;
}

function lstatIfExists(file) {
  try { return lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareCloudflare();
  console.log(`Prepared ${Object.keys(prepareContainerContext()).length} allowlisted backend inputs. No deployment or paid services enabled.`);
}
