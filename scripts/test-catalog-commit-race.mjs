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
    assert.equal(paths.length, 24);
    assert.ok(paths.includes("scraper/animeyt-index.json"));
    assert.ok(paths.includes("homepage-bootstrap.json"));
    assert.ok(paths.includes("scraper/animeneon-catalog.json"));
    assert.ok(paths.includes("android/app/src/main/assets/scraper/animeneon-catalog.json"));
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
  assert.match(workflow, /cron: '0 6 \* \* \*'/);
  assert.match(workflow, /node-version: 24/);
  assert.match(workflow, /CATALOG_UPDATE_SCOPE: regular/);
  assert.doesNotMatch(workflow, /run: npm run adult:catalog/);
  assert.ok(workflow.indexOf("node --test scripts/test-animeav1-inventory.mjs") < workflow.indexOf("- name: Run anime scraper"));
});

test("daily adult workflow is independent, paced, validated, and publishes only changed adult data", () => {
  const workflow = readFileSync(join(repoRoot, ".github", "workflows", "refresh-adult-catalog.yml"), "utf8");
  assert.match(workflow, /cron: '17 6 \* \* \*'/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\bneeds:/);
  assert.match(workflow, /group: scrape-catalog/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /UNDERHENTAI_REQUEST_INTERVAL_MS: '550'/);
  assert.match(workflow, /timeout-minutes: 45/);
  assert.match(workflow, /CATALOG_UPDATE_SCOPE: adult/);
  assert.match(workflow, /if: steps\.refresh-status\.outputs\.changes_detected == 'true'/);
  assert.match(workflow, /run: npm run adult:verify && npm run test:releases/);
  assert.match(workflow, /if: always\(\)[\s\S]*artifacts\/adult-refresh-report\.json/);
  assert.match(workflow, /if: steps\.commit-catalog\.outputs\.changes_detected == 'true'/);
  assert.ok(workflow.indexOf("run: node scripts/check-adult-refresh-status.mjs") < workflow.indexOf("run: bash scripts/commit-catalog-update.sh"));
});

for (const scope of ["adult", "regular"]) {
  test(`${scope} publisher rebases without overwriting the other catalog`, () => {
    assert.ok(bash, "Git Bash is required on Windows");
    const root = mkdtempSync(join(tmpdir(), `catalog-${scope}-scope-`));
    const remote = join(root, "remote.git");
    const seed = join(root, "seed");
    const worker = join(root, "worker");
    const updater = join(root, "updater");
    const paths = catalogPaths();
    const adultPath = path => /\/(?:underhentai_[^/]+|adult_portrait_map)\.json$/.test(path);
    const selected = paths.filter(path => adultPath(path) === (scope === "adult"));
    const other = paths.filter(path => !selected.includes(path));
    assert.equal(selected.length, scope === "adult" ? 8 : 16);
    try {
      git(root, "init", "--bare", remote);
      git(root, "init", "--initial-branch=main", seed);
      configureIdentity(seed);
      for (const path of paths) {
        const file = join(seed, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, "initial neutral data\n");
      }
      git(seed, "add", ".");
      git(seed, "commit", "-m", "initial catalog");
      git(seed, "remote", "add", "origin", remote);
      git(seed, "push", "-u", "origin", "main");
      git(root, "clone", "--branch", "main", remote, worker);
      git(root, "clone", "--branch", "main", remote, updater);
      configureIdentity(updater);
      for (const path of selected) writeFileSync(join(worker, path), "own catalog refresh\n");
      for (const path of other) writeFileSync(join(updater, path), "other catalog refresh\n");
      git(updater, "add", ".");
      git(updater, "commit", "-m", "other catalog update");
      git(updater, "push", "origin", "main");
      run(bash, [commitScript], worker, { env: { CATALOG_UPDATE_SCOPE: scope } });
      const changed = git(worker, "diff", "--name-only", "HEAD^", "HEAD").trim().split(/\r?\n/).sort();
      assert.deepEqual(changed, [...selected].sort());
      for (const path of selected) assert.equal(git(worker, "show", `HEAD:${path}`).trim(), "own catalog refresh");
      for (const path of other) assert.equal(git(worker, "show", `HEAD:${path}`).trim(), "other catalog refresh");
      assert.equal(git(worker, "rev-parse", "HEAD").trim(), git(worker, "rev-parse", "origin/main").trim());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
