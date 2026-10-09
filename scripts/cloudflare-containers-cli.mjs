import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { contextDirectory, root, verifyContainerContext } from "./prepare-cloudflare-containers.mjs";
import { validateStagingDeployment } from "./cloudflare-staging-deploy-policy.mjs";

const action = process.argv[2];
const wrangler = ["exec", "--yes", "--package=wrangler@4.149.0", "--", "wrangler"];
const config = "wrangler.container-staging.json";
const commands = {
  "dev": [...wrangler, "dev", "--config", config, "--ip", "127.0.0.1", "--port", "4193"],
  "dry-run": [...wrangler, "deploy", "--config", config, "--dry-run", "--minify", "--outdir", ".cache/cloudflare-container-bundle"],
  "bundle": [...wrangler, "deploy", "--config", config, "--dry-run", "--minify", "--containers-rollout=none", "--outdir", ".cache/cloudflare-container-bundle"],
  "deploy-staging": [...wrangler, "deploy", "--config", config, "--minify", "--keep-vars"],
  "build": ["build", "--platform", "linux/amd64", "--tag", "zenkaitv-container-staging:local", contextDirectory]
};
if (!Object.hasOwn(commands, action) || process.argv.length !== 3) {
  console.error("Choose dev, bundle, dry-run, build, or the CI-only approved deploy-staging command.");
  process.exit(1);
}
if (action === "deploy-staging") validateStagingDeployment(JSON.parse(readFileSync(resolve(root, config), "utf8")), process.env);
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
