import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_MANIFEST, verifyLocalBuild } from "./static-build-artifacts.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function verifyCloudflareStaging() {
  const config = JSON.parse(readFileSync(join(root, "wrangler.staging.json"), "utf8"));
  assert.equal(config.name, "zenkaitv-staging");
  assert.equal(config.workers_dev, true);
  assert.ok(!config.routes && !config.route && !config.crons && !config.triggers,
    "Staging must not attach production routes or replace scheduled jobs");
  assert.equal(config.assets.directory, ".cache/cloudflare-static");
  assert.equal(config.assets.html_handling, "none", "Player HTML URLs must not gain a redirect");
  assert.deepEqual(config.assets.run_worker_first.slice(0, 2), ["/api", "/api/*"]);
  const backend = new URL(config.vars.BACKEND_ORIGIN);
  assert.equal(backend.protocol, "https:");
  assert.equal(backend.pathname, "/");
  assert.ok(!backend.username && !backend.password && !backend.search && !backend.hash);
  const source = JSON.parse(readFileSync(join(root, "dist", BUILD_MANIFEST), "utf8"));
  verifyLocalBuild(join(root, "dist"), source);
  const directory = join(root, config.assets.directory);
  const staging = JSON.parse(readFileSync(join(directory, BUILD_MANIFEST), "utf8"));
  const count = verifyLocalBuild(directory, staging);
  assert.equal(staging.inputsSha256, source.inputsSha256);
  for (const [name, asset] of Object.entries(source.assets)) assert.deepEqual(staging.assets[name], asset, `App asset changed: ${name}`);
  assert.match(readFileSync(join(directory, "_headers"), "utf8"), /X-Robots-Tag: noindex, nofollow/);
  assert.match(readFileSync(join(directory, ".assetsignore"), "utf8"), /^build-manifest\.json$/m);
  console.log(`Cloudflare staging verified: ${count} files, original app bytes preserved, no production DNS/routes or cron changes.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) verifyCloudflareStaging();
