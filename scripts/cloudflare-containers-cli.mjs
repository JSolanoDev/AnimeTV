import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { contextDirectory, root, verifyContainerContext } from "./prepare-cloudflare-containers.mjs";

const action = process.argv[2];
const wrangler = ["exec", "--yes", "--package=wrangler@4.149.0", "--", "wrangler"];
const config = "wrangler.container-staging.json";
const commands = {
  "dev": [...wrangler, "dev", "--config", config, "--port", "4193"],
  "dry-run": [...wrangler, "deploy", "--config", config, "--dry-run", "--minify", "--outdir", ".cache/cloudflare-container-bundle"],
  "bundle": [...wrangler, "deploy", "--config", config, "--dry-run", "--minify", "--containers-rollout=none", "--outdir", ".cache/cloudflare-container-bundle"],
  "build": ["build", "--platform", "linux/amd64", "--tag", "zenkaitv-container-staging:local", contextDirectory]
};
if (!commands[action]) {
  console.error("Only local dev, bundle, dry-run, and Docker build are supported. Hosted container deployment requires explicit paid-service approval.");
  process.exit(1);
}
verifyContainerContext();
if (action === "bundle") console.log("Worker-only bundle check: Docker image and runtime are NOT validated by this command.");
const isDocker = action === "build";
const executable = isDocker ? "docker" : process.execPath;
const args = isDocker ? commands[action] : [process.env.npm_execpath, ...commands[action]];
if (!isDocker && !args[0]) throw new Error("Run this command through npm");
const child = spawn(executable, args, {
  cwd: resolve(root), stdio: "inherit", shell: false,
  env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false", WRANGLER_SEND_METRICS: "false" }
});
child.on("error", () => { console.error(isDocker ? "Docker is unavailable; build validation is incomplete." : "Unable to run the pinned Wrangler CLI."); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
