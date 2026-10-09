import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { root, verifyContainerContext } from "./prepare-cloudflare-containers.mjs";
import { validateProductionDeployment } from "./cloudflare-production-policy.mjs";

const action = process.argv[2];
if (!["bundle", "dry-run", "deploy"].includes(action) || process.argv.length !== 3) throw new Error("Choose bundle, dry-run or the approved CI-only deploy");
if (action === "deploy") {
  validateProductionDeployment(JSON.parse(readFileSync("wrangler.production.json", "utf8")), process.env,
    process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : {});
}
verifyContainerContext();
if (!process.env.npm_execpath) throw new Error("Run this command through npm");
const args = [process.env.npm_execpath, "exec", "--yes", "--package=wrangler@4.149.0", "--", "wrangler", "deploy",
  "--config", "wrangler.production.json", "--minify", "--keep-vars"];
if (action !== "deploy") args.push("--dry-run", "--outdir", ".cache/cloudflare-production-bundle");
if (action === "bundle") args.push("--containers-rollout=none");
const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit", shell: false,
  env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false", WRANGLER_SEND_METRICS: "false" } });
child.on("error", () => { console.error("Unable to run pinned Wrangler"); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
