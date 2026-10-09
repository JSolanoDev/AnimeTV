import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCloudflareStaging } from "./verify-cloudflare-staging.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commands = {
  dev: ["dev", "--config", "wrangler.staging.json", "--ip", "127.0.0.1", "--port", "4192"],
  login: ["login", "--scopes", "account:read", "user:read", "workers_scripts:write"],
  whoami: ["whoami"],
  "dry-run": ["deploy", "--config", "wrangler.staging.json", "--dry-run", "--outdir", ".cache/cloudflare-bundle"],
  "deploy-staging": ["deploy", "--config", "wrangler.staging.json"]
};
const action = process.argv[2];
if (!Object.hasOwn(commands, action) || process.argv.length !== 3) throw new Error("Choose dev, login, whoami, dry-run or deploy-staging");
if (!["login", "whoami"].includes(action)) verifyCloudflareStaging();
const npmCli = process.env.npm_execpath || join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
if (!existsSync(npmCli)) throw new Error("Run this command through the matching npm script");
const child = spawn(process.execPath, [npmCli, "exec", "--yes", "--package=wrangler@4.149.0", "--", "wrangler", ...commands[action]], {
  cwd: root, stdio: "inherit", env: {
    ...process.env,
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    WRANGLER_SEND_METRICS: "false"
  }
});
child.on("error", () => { console.error("Unable to launch the Cloudflare CLI"); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
