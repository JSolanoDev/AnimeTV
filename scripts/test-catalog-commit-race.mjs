import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1"));
const commitScript = join(repoRoot, "scripts", "commit-catalog-update.sh");
const bash = process.platform === "win32"
  ? ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"].find(existsSync)
  : "bash";

function run(command, args, cwd, options = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: options.stdio || "pipe",
    env: { ...process.env, ...options.env }
  });
}

function git(cwd, ...args) {
  return run("git", args, cwd);
}

function configureIdentity(cwd) {
  git(cwd, "config", "user.name", "Catalog Test");
  git(cwd, "config", "user.email", "catalog-test@example.test");
}

function catalogPaths() {
  const source = readFileSync(commitScript, "utf8");
  const block = source.match(/catalog_files=\(([\s\S]*?)\n\)/)?.[1] || "";
  return [...block.matchAll(/^\s+"([^"]+)"$/gm)].map(match => match[1]);
}

test("catalog commit rebases over a concurrent main update without losing either change", () => {
  assert.ok(bash, "Git Bash is required on Windows");
  const root = mkdtempSync(join(tmpdir(), "catalog-commit-race-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const worker = join(root, "worker");
  const updater = join(root, "updater");
  const verifier = join(root, "verifier");
  const output = join(root, "github-output.txt");

  try {
    git(root, "init", "--bare", remote);
    git(root, "init", "--initial-branch=main", seed);
    configureIdentity(seed);

    const paths = catalogPaths();
    assert.equal(paths.length, 20);
    for (const path of paths) {
      const file = join(seed, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `initial ${path}\n`);
    }
    git(seed, "add", ".");
    git(seed, "commit", "-m", "initial catalog");
    git(seed, "remote", "add", "origin", remote);
    git(seed, "push", "-u", "origin", "main");

    git(root, "clone", "--branch", "main", remote, worker);
    git(root, "clone", "--branch", "main", remote, updater);
    configureIdentity(worker);
    configureIdentity(updater);

    writeFileSync(join(worker, paths[0]), "catalog refresh\n");
    writeFileSync(join(updater, "concurrent-change.txt"), "keep this change\n");
    git(updater, "add", "concurrent-change.txt");
    git(updater, "commit", "-m", "concurrent app update");
    git(updater, "push", "origin", "main");

    run(bash, [commitScript], worker, {
      env: {
        GITHUB_OUTPUT: output,
        CATALOG_PUSH_RETRY_DELAY_SECONDS: "0"
      }
    });

    assert.match(readFileSync(output, "utf8"), /changes_detected=true/);
    git(root, "clone", "--branch", "main", remote, verifier);
    assert.equal(readFileSync(join(verifier, paths[0]), "utf8").trim(), "catalog refresh");
    assert.equal(readFileSync(join(verifier, "concurrent-change.txt"), "utf8").trim(), "keep this change");
    assert.match(git(verifier, "log", "-2", "--pretty=%s"), /chore: update anime catalog/);

    writeFileSync(output, "");
    run(bash, [commitScript], worker, { env: { GITHUB_OUTPUT: output } });
    assert.equal(readFileSync(output, "utf8").trim(), "changes_detected=false");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("catalog publisher commits both regenerated adult portrait maps", () => {
  assert.ok(bash, "Git Bash is required on Windows");
  const root = mkdtempSync(join(tmpdir(), "catalog-portrait-commit-"));
  const remote = join(root, "remote.git");
  const worker = join(root, "worker");
  const output = join(root, "github-output.txt");
  const rootMap = "scraper/adult_portrait_map.json";
  const androidMap = "android/app/src/main/assets/scraper/adult_portrait_map.json";

  try {
    git(root, "init", "--bare", remote);
    git(root, "init", "--initial-branch=main", worker);
    configureIdentity(worker);
    const paths = catalogPaths();
    assert.ok(paths.includes(rootMap));
    assert.ok(paths.includes(androidMap));
    for (const path of paths) {
      const file = join(worker, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `initial ${path}\n`);
    }
    git(worker, "add", ".");
    git(worker, "commit", "-m", "initial catalog");
    git(worker, "remote", "add", "origin", remote);
    git(worker, "push", "-u", "origin", "main");

    for (const path of [rootMap, androidMap]) writeFileSync(join(worker, path), "updated portrait map\n");
    writeFileSync(join(worker, paths[0]), "updated catalog\n");

    run(bash, [commitScript], worker, { env: { GITHUB_OUTPUT: output } });

    assert.match(readFileSync(output, "utf8"), /changes_detected=true/);
    assert.equal(git(worker, "status", "--porcelain").trim(), "");
    assert.equal(git(worker, "show", `HEAD:${rootMap}`).trim(), "updated portrait map");
    assert.equal(git(worker, "show", `HEAD:${androidMap}`).trim(), "updated portrait map");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scrape workflow uses the guarded catalog publisher", () => {
  const workflow = readFileSync(join(repoRoot, ".github", "workflows", "scrape-catalog.yml"), "utf8");
  assert.match(workflow, /fetch-depth: 50/);
  assert.match(workflow, /run: bash scripts\/commit-catalog-update\.sh/);
  assert.doesNotMatch(workflow, /git-auto-commit-action/);
  assert.doesNotMatch(readFileSync(commitScript, "utf8"), /push[^\n]*--force/);
});
