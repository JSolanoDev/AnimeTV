import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BUILD_MANIFEST = "build-manifest.json";
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function listStaticFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = prefix + entry.name;
    if (entry.isDirectory()) return listStaticFiles(join(directory, entry.name), name + "/");
    return name === BUILD_MANIFEST ? [] : [name];
  }).sort();
}

export function buildInputHash(files, toolVersions) {
  const hash = createHash("sha256").update(JSON.stringify(toolVersions));
  for (const file of [...files].sort()) {
    hash.update(JSON.stringify([file, sha256(readFileSync(file))]));
  }
  return hash.digest("hex");
}

export function validateBuildManifest(manifest) {
  if (manifest?.version !== 1 || !/^[a-f0-9]{64}$/.test(manifest.inputsSha256 || "")) {
    throw new Error("Invalid static build manifest");
  }
  if (!manifest.assets || typeof manifest.assets !== "object" || Array.isArray(manifest.assets)) {
    throw new Error("Missing static build assets");
  }
  for (const [name, asset] of Object.entries(manifest.assets)) {
    if (name.includes("\\") || name.includes(":") || name.includes("?") || name.includes("#") ||
        name.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error(`Unsafe static asset path: ${name}`);
    }
    if (!/^[a-f0-9]{64}$/.test(asset?.sha256 || "") || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0) {
      throw new Error(`Invalid static asset digest: ${name}`);
    }
  }
  for (const name of ["index.html", "client.js", "styles.css", "service-worker.js", "player/player.html", "player/player.js"]) {
    if (!manifest.assets[name]?.bytes) throw new Error(`Missing or empty required static asset: ${name}`);
  }
  return manifest;
}

export function writeBuildManifest(directory, inputsSha256) {
  const assets = Object.fromEntries(listStaticFiles(directory).map((name) => {
    const bytes = readFileSync(join(directory, name));
    return [name, { bytes: bytes.length, sha256: sha256(bytes) }];
  }));
  const manifest = validateBuildManifest({ version: 1, inputsSha256, assets });
  writeFileSync(join(directory, BUILD_MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

export function verifyLocalBuild(directory, manifest) {
  validateBuildManifest(manifest);
  const names = Object.keys(manifest.assets).sort();
  if (JSON.stringify(names) !== JSON.stringify(listStaticFiles(directory))) {
    throw new Error(`Static file inventory does not match ${directory}/${BUILD_MANIFEST}`);
  }
  for (const name of names) {
    const bytes = readFileSync(join(directory, name));
    const expected = manifest.assets[name];
    if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) {
      throw new Error(`Static asset differs from built output: ${name}`);
    }
  }
  return names.length;
}

export function canReuseStaticBuild(directory, inputsSha256, expectedFiles) {
  try {
    const manifest = JSON.parse(readFileSync(join(directory, BUILD_MANIFEST), "utf8"));
    if (manifest.inputsSha256 !== inputsSha256 ||
        JSON.stringify(Object.keys(manifest.assets || {}).sort()) !== JSON.stringify([...expectedFiles].sort())) return false;
    verifyLocalBuild(directory, manifest);
    return true;
  } catch {
    return false;
  }
}
