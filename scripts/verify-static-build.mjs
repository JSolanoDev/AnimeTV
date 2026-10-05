import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_MANIFEST, sha256, validateBuildManifest, verifyLocalBuild } from "./static-build-artifacts.mjs";

export async function verifyPublishedBuild(baseUrl, fetcher = fetch) {
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol)) throw new Error("Expected an HTTP deployment URL");
  const manifestResponse = await fetcher(new URL(BUILD_MANIFEST, base), { signal: AbortSignal.timeout(15000) });
  if (!manifestResponse.ok) throw new Error(`Build manifest returned HTTP ${manifestResponse.status}`);
  const manifest = validateBuildManifest(await manifestResponse.json());
  // Only HTML/JS/CSS are fetched: no catalog APIs, remote artwork, or video streams.
  const assets = Object.entries(manifest.assets).filter(([name]) => /\.(html|js|css)$/.test(name));
  let totalBytes = 0;
  for (const [name, expected] of assets) {
    const url = new URL(name.split("/").map(encodeURIComponent).join("/"), base);
    url.searchParams.set("build", manifest.inputsSha256);
    const response = await fetcher(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`${name} returned HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) {
      throw new Error(`Published asset differs from minified build: ${name}`);
    }
    totalBytes += bytes.length;
  }
  return { assets: assets.length, bytes: totalBytes };
}

async function main() {
  const remote = process.argv.find((arg) => arg.startsWith("--url="));
  if (remote) {
    const result = await verifyPublishedBuild(remote.slice("--url=".length));
    console.log(`PASS: ${result.assets} published HTML/JS/CSS assets match the production build (${result.bytes} bytes)`);
    return;
  }
  for (const directory of ["dist", "public"]) {
    const manifest = JSON.parse(readFileSync(join(directory, BUILD_MANIFEST), "utf8"));
    console.log(`PASS: ${verifyLocalBuild(directory, manifest)} hash-verified static files in ${directory}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`Static build verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
