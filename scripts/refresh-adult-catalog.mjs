import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NAMES = ["underhentai_catalog.json", "adult_portrait_map.json", "underhentai_details.json", "underhentai_releases.json"];
export const ADULT_SNAPSHOT_FILES = NAMES.flatMap((name) => [
  `scraper/${name}`, `android/app/src/main/assets/scraper/${name}`
]);
const BUILDERS = ["build-underhentai-catalog.mjs", "build-adult-portrait-map.mjs", "build-underhentai-details.mjs", "build-underhentai-releases.mjs"];

function execute(script, root) {
  const args = script === "test-adult-releases.mjs" ? ["--test", `scripts/${script}`] : [`scripts/${script}`];
  const result = spawnSync(process.execPath, args, { cwd: root, env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`${script} failed (exit ${result.status ?? result.signal})`);
    error.code = result.status === 75 ? "ADULT_UPSTREAM_UNAVAILABLE" : "ADULT_REFRESH_FAILED";
    throw error;
  }
}

async function readSnapshot(root) {
  const snapshot = new Map();
  for (const file of ADULT_SNAPSHOT_FILES) {
    try { snapshot.set(file, await readFile(resolve(root, file))); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      snapshot.set(file, null);
    }
  }
  return snapshot;
}

function checkSnapshot(snapshot) {
  for (const name of NAMES) {
    const web = snapshot.get(`scraper/${name}`);
    const android = snapshot.get(`android/app/src/main/assets/scraper/${name}`);
    if (!web?.length || !android?.equals(web)) throw new Error(`Missing or mismatched adult snapshot: ${name}`);
    JSON.parse(web.toString("utf8"));
  }
}

async function restoreSnapshot(root, snapshot) {
  for (const [file, body] of snapshot) {
    const path = resolve(root, file);
    if (body === null) await rm(path, { force: true });
    else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    }
  }
}

export async function refreshAdultCatalog({ root = process.cwd(), run = execute, report = "artifacts/adult-refresh-report.json" } = {}) {
  const baseline = await readSnapshot(root);
  const hasBaseline = [...baseline.values()].some((body) => body !== null);
  const validate = async () => {
    checkSnapshot(await readSnapshot(root));
    await run("verify-underhentai-playability.mjs", root);
    await run("test-adult-releases.mjs", root);
  };
  const saveReport = async (status, reason = null) => {
    const path = resolve(root, report);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ status, checkedAt: new Date().toISOString(), reason,
      retainedSnapshot: status === "stale", webAndAndroidMatch: true }, null, 2)}\n`);
    return { status, reason };
  };
  // Only a complete, already-validated snapshot may be served during an outage.
  if (hasBaseline) await validate();
  try {
    for (const script of BUILDERS) await run(script, root);
    await validate();
    return await saveReport("fresh");
  } catch (error) {
    await restoreSnapshot(root, baseline);
    if (!hasBaseline || error.code !== "ADULT_UPSTREAM_UNAVAILABLE") throw error;
    await validate();
    return await saveReport("stale", error.message);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  refreshAdultCatalog().then(({ status, reason }) => {
    if (status === "stale") console.warn(`::warning::Adult provider unavailable; retained the validated adult snapshot. ${reason}`);
    else console.log("Adult refresh completed and validated for web and Android.");
    if (process.env.GITHUB_STEP_SUMMARY) {
      return writeFile(process.env.GITHUB_STEP_SUMMARY,
        `### Adult catalog refresh\nStatus: **${status}**\n${reason || "Updated snapshot passed validation."}\n`, { flag: "a" });
    }
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
