// Sanity-checks vercel.json against the shape Vercel actually accepts.
//
// vercel.json is schema-validated by Vercel BEFORE the build runs, and it
// supports no comments. A single unknown property - a "_comment" key added to a
// headers entry to explain a caching decision - made the deployment fail
// instantly with status Error and duration "?", never reaching the build step.
// Nothing local caught it: the file was valid JSON, `npm run check` passed,
// `npm run vercel-build` passed, and the push succeeded. Production silently
// stayed on the previous release.
//
// That is the worst failure mode available here - a green local run and a dead
// deploy - so it gets a check.
//
// Run: node scripts/check-vercel-config.mjs   (part of `npm run check`)
import { readFileSync, existsSync } from "node:fs";

const FILE = "vercel.json";

// Properties Vercel allows on each entry of these arrays.
const ENTRY_KEYS = {
  headers: ["source", "headers", "has", "missing"],
  rewrites: ["source", "destination", "has", "missing"],
  redirects: ["source", "destination", "permanent", "statusCode", "has", "missing"]
};

const TOP_LEVEL_KEYS = [
  "$schema", "version", "framework", "buildCommand", "devCommand", "installCommand",
  "ignoreCommand", "outputDirectory", "public", "regions", "functions", "routes",
  "rewrites", "redirects", "headers", "cleanUrls", "trailingSlash", "crons", "images",
  "git", "github"
];

if (!existsSync(FILE)) {
  console.log(`  SKIP  ${FILE} not found`);
  process.exit(0);
}

let config;
try {
  config = JSON.parse(readFileSync(FILE, "utf8"));
} catch (error) {
  console.log(`  FAIL  ${FILE} is not valid JSON: ${error.message}`);
  console.log("\nvercel.json check FAILED.\n");
  process.exit(1);
}

let failed = 0;

for (const key of Object.keys(config)) {
  if (!TOP_LEVEL_KEYS.includes(key)) {
    failed++;
    console.log(`  FAIL  unknown top-level key "${key}" - Vercel rejects the config before building`);
  }
}

for (const [section, allowed] of Object.entries(ENTRY_KEYS)) {
  const entries = config[section];
  if (!Array.isArray(entries)) continue;
  entries.forEach((entry, index) => {
    for (const key of Object.keys(entry)) {
      if (allowed.includes(key)) continue;
      failed++;
      const where = entry.source ? ` (source: ${entry.source})` : "";
      console.log(`  FAIL  ${section}[${index}] has unsupported key "${key}"${where}`);
      if (key.startsWith("_") || /comment|note|todo/i.test(key)) {
        console.log("        vercel.json supports NO comments. Put the explanation in the code it describes.");
      }
    }
    if (section === "headers" && Array.isArray(entry.headers)) {
      entry.headers.forEach((h, hi) => {
        const bad = Object.keys(h).filter((k) => !["key", "value"].includes(k));
        if (bad.length) {
          failed++;
          console.log(`  FAIL  headers[${index}].headers[${hi}] has unsupported key(s): ${bad.join(", ")}`);
        }
      });
    }
  });
}

if (failed) {
  console.log(`\nvercel.json check FAILED (${failed} problem${failed === 1 ? "" : "s"}).`);
  console.log("Vercel validates this file before building; an invalid key fails the deploy with no build log.\n");
  process.exit(1);
}
console.log(`  PASS  ${FILE} keys are all supported by Vercel`);
