import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

try {
  const report = JSON.parse(await readFile(resolve("artifacts/adult-refresh-report.json"), "utf8"));
  if (!["fresh", "unchanged"].includes(report.status)) {
    throw new Error(`Adult provider check did not complete successfully (${report.status || "missing status"}). ${report.reason || ""} Existing catalog preserved; nothing published.`);
  }
  const changed = report.status === "fresh";
  if (report.changesDetected !== changed || report.webAndAndroidMatch !== true) {
    throw new Error("Adult refresh report is inconsistent; refusing to publish.");
  }
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `changes_detected=${changed}\n`);
  }
  console.log(changed ? "Validated adult catalog changes are ready to publish." : "Provider check passed; catalog unchanged, publishing skipped.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
