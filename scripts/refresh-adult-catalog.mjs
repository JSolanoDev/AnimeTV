import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { prepareAdultArtwork } from "./prepare-adult-artwork.mjs";

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

function comparableSnapshot(body) {
  const payload = JSON.parse(body.toString("utf8"));
  delete payload.generatedAt;
  delete payload.catalogGeneratedAt;
  for (const item of Array.isArray(payload.items) ? payload.items : []) delete item.metadataCheckedAt;
  return payload;
}

export async function refreshAdultCatalog({ root = process.cwd(), run = execute,
  prepareArtwork = prepareAdultArtwork, report = "artifacts/adult-refresh-report.json" } = {}) {
  // A failed run must not leave an older successful report for CI to upload.
  await rm(resolve(root, report), { force: true });
  const baseline = await readSnapshot(root);
  let artwork = null;
  const hasBaseline = [...baseline.values()].some((body) => body !== null);
  const validate = async () => {
    checkSnapshot(await readSnapshot(root));
    await run("verify-underhentai-playability.mjs", root);
    await run("test-adult-releases.mjs", root);
  };
  const saveReport = async (status, error = null) => {
    const path = resolve(root, report);
    const catalog = JSON.parse(await readFile(resolve(root, "scraper/underhentai_catalog.json"), "utf8"));
    const generatedAt = catalog.generatedAt || null;
    const generatedMs = Date.parse(generatedAt);
    const result = { status, checkedAt: new Date().toISOString(), reason: error?.message || null,
      failureCode: error?.code || null, snapshotValidated: true,
      catalogGeneratedAt: generatedAt,
      catalogAgeHours: Number.isFinite(generatedMs) ? Math.max(0, Math.round((Date.now() - generatedMs) / 3600000)) : null,
      titleCount: Array.isArray(catalog.items) ? catalog.items.length : 0,
      retainedSnapshot: status !== "fresh", changesDetected: status === "fresh", webAndAndroidMatch: true, artwork };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  };
  // Only a complete, already-validated snapshot may be served during an outage.
  if (hasBaseline) await validate();
  try {
    for (const script of BUILDERS) {
      await run(script, root);
      if (script === "build-underhentai-details.mjs") artwork = await prepareArtwork({ root, baseline });
    }
    await validate();
    const candidate = await readSnapshot(root);
    const unchanged = hasBaseline && ADULT_SNAPSHOT_FILES.every((file) =>
      isDeepStrictEqual(comparableSnapshot(baseline.get(file)), comparableSnapshot(candidate.get(file))));
    if (unchanged) {
      // Keep byte-identical assets to avoid a build for check timestamps alone.
      await restoreSnapshot(root, baseline);
      return await saveReport("unchanged");
    }
    return await saveReport("fresh");
  } catch (error) {
    await restoreSnapshot(root, baseline);
    if (!hasBaseline || error.code !== "ADULT_UPSTREAM_UNAVAILABLE") throw error;
    await validate();
    const restored = await readSnapshot(root);
    if (!ADULT_SNAPSHOT_FILES.every((file) => restored.get(file)?.equals(baseline.get(file)))) {
      await restoreSnapshot(root, baseline);
      throw new Error("Adult snapshot changed during outage validation; refusing to report a safe rollback.");
    }
    return await saveReport("stale", error);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  refreshAdultCatalog().then(({ status, reason, catalogGeneratedAt, catalogAgeHours, titleCount }) => {
    if (status === "stale") console.warn(`::warning::Adult provider unavailable; retained the validated adult snapshot. ${reason}`);
    else if (status === "unchanged") console.log("Adult provider checked successfully; catalog unchanged, no publish needed.");
    else console.log("Adult refresh completed and validated for web and Android.");
    if (process.env.GITHUB_STEP_SUMMARY) {
      return writeFile(process.env.GITHUB_STEP_SUMMARY,
        `### Adult catalog refresh\nStatus: **${status}**\n`
        + `Snapshot: ${catalogGeneratedAt || "unknown"}; age: ${catalogAgeHours ?? "unknown"} hours; titles: ${titleCount}.\n`
        + `${reason || (status === "unchanged" ? "Provider check passed; no catalog content changed, so no deployment is needed." : "Updated snapshot passed validation.")}\n`
        + (status === "stale" ? "No new titles were published. Existing titles were preserved; provider access must recover before the next refresh can succeed.\n" : ""), { flag: "a" });
    }
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
