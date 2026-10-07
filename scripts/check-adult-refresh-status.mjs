import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

try {
  const report = JSON.parse(await readFile(resolve("artifacts/adult-refresh-report.json"), "utf8"));
  const preservedOutage = report.status === "stale" && process.argv.includes("--allow-preserved-outage");
  if (preservedOutage && (report.failureCode !== "ADULT_UPSTREAM_UNAVAILABLE"
      || report.snapshotValidated !== true || report.retainedSnapshot !== true
      || typeof report.reason !== "string" || !report.reason.trim())) {
    throw new Error("Adult outage report does not confirm a validated retained snapshot; refusing to continue.");
  }
  if (!preservedOutage && !["fresh", "unchanged"].includes(report.status)) {
    throw new Error(`Adult provider check did not complete successfully (${report.status || "missing status"}). ${report.reason || ""} Existing catalog preserved; nothing published.`);
  }
  const changed = report.status === "fresh";
  if (report.changesDetected !== changed || report.webAndAndroidMatch !== true) {
    throw new Error("Adult refresh report is inconsistent; refusing to publish.");
  }
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `changes_detected=${changed}\n`);
  }
  if (preservedOutage) {
    const reason = report.reason.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
    console.warn(`::warning::Adult provider unavailable. ${reason} Validated catalog preserved; publishing and deployment skipped. The next scheduled run will check again.`);
  } else {
    console.log(changed ? "Validated adult catalog changes are ready to publish." : "Provider check passed; catalog unchanged, publishing skipped.");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
