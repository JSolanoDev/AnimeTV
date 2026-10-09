import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_MANIFEST, verifyLocalBuild, writeBuildManifest } from "./static-build-artifacts.mjs";
import { SECURITY_HEADERS } from "../ops/cloudflare/gateway.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const stagingDirectory = resolve(root, ".cache/cloudflare-static");

export function prepareCloudflare(sourceDirectory = resolve(root, "dist"), outputDirectory = stagingDirectory, { production = false } = {}) {
  if (resolve(outputDirectory) !== stagingDirectory) throw new Error("Cloudflare output must stay in the staging cache directory");
  const manifest = JSON.parse(readFileSync(join(sourceDirectory, BUILD_MANIFEST), "utf8"));
  verifyLocalBuild(sourceDirectory, manifest);
  const files = Object.keys(manifest.assets);
  if (files.length > 19990 || files.some((name) => manifest.assets[name].bytes > 25 * 1024 * 1024)) {
    throw new Error("Static build exceeds Cloudflare Free asset limits");
  }
  rmSync(stagingDirectory, { recursive: true, force: true });
  mkdirSync(stagingDirectory, { recursive: true });
  for (const name of files) {
    const target = join(stagingDirectory, name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(sourceDirectory, name), target);
  }
  const headers = ["/*", ...Object.entries({ ...SECURITY_HEADERS, ...(production ? {} : { "X-Robots-Tag": "noindex, nofollow" }) })
    .map(([key, value]) => `  ${key}: ${value}`)];
  for (const name of files) {
    let policy = "public, max-age=0, must-revalidate";
    if (/\.(?:js|css|svg|webmanifest|ico|png|webp|jpg|jpeg|woff2?|ttf|eot)$/i.test(name)) {
      policy = "public, max-age=31536000, immutable";
    }
    if (name === "service-worker.js") policy = "no-cache, max-age=0, must-revalidate";
    headers.push("", `/${name}`, `  Cache-Control: ${policy}`);
  }
  if (files.length + 1 > 100 || headers.some((line) => line.length > 2000)) {
    throw new Error("Generated static headers exceed Cloudflare header limits");
  }
  writeFileSync(join(stagingDirectory, "_headers"), headers.join("\n") + "\n");
  writeFileSync(join(stagingDirectory, "_redirects"),
    "/favicon.ico /logo-round.png 200\n/anime/player/player.html /player/player.html 302\n");
  writeFileSync(join(stagingDirectory, ".assetsignore"), "build-manifest.json\n.assetsignore\n");
  writeBuildManifest(stagingDirectory, manifest.inputsSha256);
  return files.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Prepared ${prepareCloudflare()} unchanged app assets for Cloudflare staging; dist/public were not modified.`);
}
