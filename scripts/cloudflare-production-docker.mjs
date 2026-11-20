#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// Wrangler tags the production image with the first eight digits of its Worker
// version. The version can serve traffic before the bindings API can read it.
export async function waitForPushedVersion(prefix, read, pause = sleep, now = Date.now) {
  const deadline = now() + 90000;
  let versionId;
  while (now() < deadline) {
    if (!versionId) {
      const list = await read("deployments");
      if (!list?.success) return false;
      const versions = list.result.deployments.flatMap(deployment => deployment.versions);
      versionId = versions.find(v => v.version_id.startsWith(prefix))?.version_id;
    }
    if (versionId) {
      const version = await read("versions/" + encodeURIComponent(versionId));
      if (version?.success && version.result?.id === versionId) return true;
      if (!version?.errors?.some(error => error.code === 100146)) return false;
    }
    await pause(Math.min(4000, Math.max(0, deadline - now())));
  }
  return false;
}

async function main() {
  const args = process.argv.slice(2);
  const result = spawnSync("docker", args, { stdio: "inherit" });
  if (result.status !== 0) { process.exitCode = result.status ?? 1; return; }
  if (args.length !== 2 || args[0] !== "push") return;
  const config = JSON.parse(readFileSync(new URL("../wrangler.production.json", import.meta.url)));
  const repository = `registry.cloudflare.com/${config.account_id}/${config.containers[0].name}:`;
  if (!args[1].startsWith(repository)) return;
  const prefix = args[1].slice(repository.length);
  if (!/^[a-f0-9]{8}$/.test(prefix)) return;
  const base = `https://api.cloudflare.com/client/v4/accounts/${config.account_id}/workers/scripts/${config.name}/`;
  const read = async path => {
    const response = await fetch(base + path, {
      headers: { Authorization: "Bearer " + process.env.CLOUDFLARE_API_TOKEN },
      redirect: "error", signal: AbortSignal.timeout(5000)
    });
    return response.json();
  };
  // This is only a readiness hint. Wrangler retains all authority over the
  // namespace, image rollout, credentials, and final deployment result.
  const ready = await waitForPushedVersion(prefix, read).catch(() => false);
  console.log(ready ? "Published Worker version is readable." : "Continuing with Wrangler's version and binding checks.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
