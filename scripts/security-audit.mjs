import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const trackedFiles = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((file) => !/\.(png|jpg|jpeg|gif|webp|ico|jar|apk|aab|zip)$/i.test(file));

const riskyFiles = [/^\.env/i, /(^|\/)\.env/i, /\.local$/i];
const secretPatterns = [
  { name: "GitHub token", pattern: /ghp_[A-Za-z0-9_]{20,}/ },
  { name: "RapidAPI key assignment", pattern: /\b(?:RAPIDAPI|X_RAPIDAPI)[A-Z0-9_]*\s*[:=]\s*["']?[A-Za-z0-9_-]{20,}/i },
  { name: "Generic private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)?PRIVATE KEY-----/ },
  { name: "Hard-coded API key", pattern: /\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*["'][^"']{16,}["']/i }
];

const findings = [];

for (const file of trackedFiles) {
  if (/^\.env\.example$/i.test(file) || /(^|\/)\.env\.example$/i.test(file)) continue;
  if (riskyFiles.some((pattern) => pattern.test(file))) {
    findings.push(`${file}: env-like file is tracked`);
    continue;
  }

  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }

  for (const check of secretPatterns) {
    if (check.pattern.test(text)) {
      findings.push(`${file}: ${check.name}`);
    }
  }
}

if (findings.length) {
  console.error("Security audit failed. Rotate any exposed credentials and remove them from tracked files.");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log("Security audit passed: no tracked env files or obvious hard-coded secrets found.");
