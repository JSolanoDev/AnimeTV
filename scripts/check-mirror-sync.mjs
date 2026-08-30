// Guards the "android/app/src/main/assets mirrors the repo root" invariant.
//
// CLAUDE.md asks contributors to keep the Android assets in sync by hand. That
// worked until it didn't: the Android styles.css spent several releases carrying
// a comment block claiming vertical scroll snapping had been "REMOVED after
// measuring it" while the working rules sat right below it, plus an extra
// reduced-motion rule the web build never had - so the two shipped different
// behaviour. offline.html had quietly lost its no-referrer meta tag the same way.
//
// Byte equality is the check. If a file ever genuinely needs to differ per
// platform, add it to ALLOWED_DIVERGENCE with a reason rather than deleting the
// check - the point is that divergence becomes a decision instead of an accident.
//
// Run: node scripts/check-mirror-sync.mjs   (part of `npm run check`)
import { readFileSync, existsSync, readdirSync } from "node:fs";

const ANDROID = "android/app/src/main/assets";

// path -> why it is allowed to differ. Empty today, deliberately.
const ALLOWED_DIVERGENCE = {};

const mirrored = [
  "client.js", "index.html", "service-worker.js", "styles.css",
  "manifest.webmanifest", "offline.html", "update-manager.js",
  ...(existsSync("js") ? readdirSync("js").filter((f) => f.endsWith(".js")).map((f) => `js/${f}`) : [])
];

let failed = 0;
let checked = 0;
const missing = [];

if (!existsSync(ANDROID)) {
  console.log(`  SKIP  ${ANDROID} not present; nothing to mirror.`);
} else {
  for (const rel of mirrored) {
    const androidPath = `${ANDROID}/${rel}`;
    if (!existsSync(rel)) continue;
    if (!existsSync(androidPath)) { missing.push(rel); continue; }
    checked++;
    const a = readFileSync(rel);
    const b = readFileSync(androidPath);
    if (a.equals(b)) continue;
    if (ALLOWED_DIVERGENCE[rel]) {
      console.log(`  ALLOW ${rel} differs (${ALLOWED_DIVERGENCE[rel]})`);
      continue;
    }
    failed++;
    // Report the size of the drift so a stray newline reads differently from a
    // genuinely diverged file.
    const linesA = a.toString("utf8").split("\n");
    const linesB = b.toString("utf8").split("\n");
    const diffLines = Math.abs(linesA.length - linesB.length) ||
      linesA.reduce((n, line, i) => n + (line === linesB[i] ? 0 : 1), 0);
    console.log(`  FAIL  ${rel} differs from ${androidPath} (~${diffLines} line(s))`);
  }

  if (missing.length) console.log(`  WARN  not mirrored to Android: ${missing.join(", ")}`);

  // Cross-target version equality. Each target can be internally consistent and
  // still disagree with the other, which check-asset-versions.mjs would pass.
  const versionOf = (file, re) => {
    if (!existsSync(file)) return null;
    const m = readFileSync(file, "utf8").match(re);
    return m ? m[1] : null;
  };
  const versions = {
    "index.html": versionOf("index.html", /\?v=(\d+)/),
    "service-worker.js": versionOf("service-worker.js", /CACHE_NAME\s*=\s*"zenkaitv-v(\d+)"/),
    [`${ANDROID}/index.html`]: versionOf(`${ANDROID}/index.html`, /\?v=(\d+)/),
    [`${ANDROID}/service-worker.js`]: versionOf(`${ANDROID}/service-worker.js`, /CACHE_NAME\s*=\s*"zenkaitv-v(\d+)"/)
  };
  const present = Object.entries(versions).filter(([, v]) => v !== null);
  const distinct = [...new Set(present.map(([, v]) => v))];
  if (distinct.length > 1) {
    failed++;
    console.log(`  FAIL  version drift across targets: ${present.map(([k, v]) => `${k}=v${v}`).join(", ")}`);
  } else if (distinct.length === 1) {
    console.log(`  PASS  all ${present.length} targets on v${distinct[0]}`);
  }

  if (!failed) console.log(`  PASS  ${checked} mirrored file(s) byte-identical`);
}

if (failed) {
  console.log(`\nMirror sync check FAILED (${failed} problem${failed === 1 ? "" : "s"}).`);
  console.log(`Copy the root file over its ${ANDROID} counterpart, or apply the same edit to both.`);
  console.log("Run `node scripts/bump-asset-version.mjs` to move every target to one version.\n");
  process.exit(1);
}
console.log("\nAndroid mirror is in sync.\n");
