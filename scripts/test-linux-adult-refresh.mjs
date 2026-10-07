import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const wrapper = join(root, "scripts/run-adult-refresh-linux.sh");
const source = readFileSync(wrapper, "utf8");
const linux = process.platform === "linux";

test("Linux updater preserves pacing, locks, publication gates, and private logs", () => {
  assert.match(source, /flock -n 9/);
  assert.match(source, /now - previous < 3600/);
  assert.match(source, /umask 077/);
  assert.match(source, /git status --porcelain/);
  assert.match(source, /git merge --ff-only/);
  assert.match(source, /npm ci --ignore-scripts --no-audit --no-fund/);
  assert.match(source, /timeout --kill-after=10s 60s gh auth status/);
  assert.match(source, /timeout --kill-after=30s 5m git -c credential\.helper= clone/);
  assert.match(source, /timeout --kill-after=30s 5m git fetch/);
  assert.match(source, /IdentityAgent=none/);
  assert.match(source, /StrictHostKeyChecking=yes/);
  assert.match(source, /git push --dry-run origin HEAD:main/);
  assert.match(source, /UNDERHENTAI_CRAWL_CONCURRENCY=2/);
  assert.match(source, /UNDERHENTAI_REQUEST_INTERVAL_MS=550/);
  assert.match(source, /45m node scripts\/refresh-adult-catalog\.mjs/);
  assert.match(source, /check-adult-refresh-status\.mjs --allow-preserved-outage/);
  assert.match(source, /case "\$status" in\s+fresh\)[\s\S]*CATALOG_UPDATE_SCOPE=adult/);
  assert.ok(source.indexOf('run "Validate publication eligibility"') < source.indexOf('run "Publish only validated adult assets"'));
  assert.doesNotMatch(source, /git reset|git push .*--force|gh auth token|sudo|VERCEL_DEPLOY_HOOK/);
});

test("daily timer is persistent, unprivileged, and isolated from regular scheduling", () => {
  const service = readFileSync(join(root, "ops/systemd/zenkaitv-adult-refresh.service"), "utf8");
  const deployKeyOverride = readFileSync(join(root, "ops/systemd/zenkaitv-adult-refresh-deploy-key.conf"), "utf8");
  const timer = readFileSync(join(root, "ops/systemd/zenkaitv-adult-refresh.timer"), "utf8");
  const workflow = readFileSync(join(root, ".github/workflows/refresh-adult-catalog.yml"), "utf8");
  assert.match(service, /NoNewPrivileges=true/);
  assert.match(service, /ProtectSystem=strict/);
  assert.match(service, /ProtectHome=read-only/);
  assert.match(service, /ReadWritePaths=%h\/\.local\/state\/zenkaitv-adult-refresh/);
  assert.match(service, /EnvironmentFile=-%h\/\.local\/state\/zenkaitv-adult-refresh\/auth\.env/);
  assert.match(deployKeyOverride, /EnvironmentFile=\r?\nEnvironmentFile=%h\/\.local\/state\/zenkaitv-adult-refresh\/auth\.env/);
  assert.match(deployKeyOverride, /UnsetEnvironment=DBUS_SESSION_BUS_ADDRESS SSH_AUTH_SOCK GH_TOKEN GITHUB_TOKEN/);
  assert.match(timer, /OnCalendar=\*-\*-\* 06:17:00 UTC/);
  assert.match(timer, /Persistent=true/);
  assert.match(workflow, /if: github\.event_name != 'schedule' \|\| vars\.ADULT_REFRESH_EXTERNAL != 'true'/);
});

function command(executable, args, cwd, env = {}) {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${executable} failed: ${result.stderr}`);
  return result.stdout;
}

function fixture({ deployKey = false } = {}) {
  const temp = mkdtempSync(join(tmpdir(), "linux-catalog-neutral-"));
  const state = join(temp, "state");
  const seed = join(temp, "seed");
  const remote = join(temp, "remote.git");
  const bin = join(temp, "bin");
  mkdirSync(state);
  mkdirSync(bin);
  const git = (...args) => command("git", args, temp);
  git("init", "--bare", remote);
  git("--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
  git("init", "--initial-branch=main", seed);
  git("-C", seed, "config", "user.name", "Neutral Catalog Test");
  git("-C", seed, "config", "user.email", "catalog@example.test");
  const write = (path, body) => {
    const absolute = join(seed, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, body);
  };
  const pkg = { name: "neutral-catalog-fixture", version: "1.0.0", scripts: {
    "adult:verify": "node scripts/verify.mjs", "test:releases": "node scripts/verify.mjs"
  } };
  write("package.json", JSON.stringify(pkg));
  write("package-lock.json", JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3,
    packages: { "": { name: pkg.name, version: pkg.version } } }));
  write(".gitignore", "node_modules/\nartifacts/\n");
  write("scripts/verify.mjs", "if (process.env.FIXTURE_VALIDATION_FAIL === '1') process.exit(4);\n");
  for (const name of ["test-adult-refresh.mjs", "test-linux-adult-refresh.mjs", "test-catalog-commit-race.mjs", "test-adult-releases.mjs"]) {
    write(`scripts/${name}`, 'import test from "node:test"; test("neutral validation", () => {});\n');
  }
  write("scripts/check-adult-refresh-status.mjs", readFileSync(join(root, "scripts/check-adult-refresh-status.mjs"), "utf8"));
  write("scripts/refresh-adult-catalog.mjs", `import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
appendFileSync(join(process.env.ZENKAITV_ADULT_STATE_DIR, "calls"), "check\\n");
if (process.env.FIXTURE_REFRESH_FAIL === "1") process.exit(3);
const status = process.env.FIXTURE_STATUS || "unchanged";
const stale = status === "stale";
mkdirSync("artifacts", { recursive: true });
writeFileSync("artifacts/adult-refresh-report.json", JSON.stringify({ status, checkedAt: new Date().toISOString(),
  reason: stale ? "Provider HTTP 403" : null, failureCode: stale ? "ADULT_UPSTREAM_UNAVAILABLE" : null,
  snapshotValidated: true, titleCount: 1, retainedSnapshot: status !== "fresh",
  changesDetected: status === "fresh", webAndAndroidMatch: process.env.FIXTURE_INVALID_REPORT !== "1" }));
`);
  write("scripts/commit-catalog-update.sh", '#!/usr/bin/env bash\nset -eu\n[[ "$CATALOG_UPDATE_SCOPE" == "adult" ]]\nprintf published >"$ZENKAITV_ADULT_STATE_DIR/published"\n');
  writeFileSync(join(bin, "gh"), '#!/usr/bin/env bash\nif [[ "${FIXTURE_FORBID_GH:-0}" == "1" ]]; then exit 97; fi\nif [[ "${FIXTURE_AUTH_HANG:-0}" == "1" ]]; then sleep 60; fi\nexit 0\n');
  chmodSync(join(bin, "gh"), 0o700);
  writeFileSync(join(bin, "timeout"), '#!/usr/bin/env bash\nset -eu\nprintf "%s %s %s\\n" "$1" "$2" "$3" >>"$ZENKAITV_ADULT_STATE_DIR/timeout-calls"\nwhile [[ "$1" == --* ]]; do shift; done\nshift\nexec /usr/bin/timeout --kill-after=2s "${FIXTURE_TEST_TIMEOUT:-30s}" "$@"\n');
  chmodSync(join(bin, "timeout"), 0o700);
  git("-C", seed, "add", ".");
  git("-C", seed, "commit", "-m", "Neutral fixture");
  git("-C", seed, "remote", "add", "origin", remote);
  git("-C", seed, "push", "origin", "main");
  const env = { PATH: `${bin}:${process.env.PATH}`, ZENKAITV_ADULT_STATE_DIR: state,
    GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "", GH_TOKEN: "", GITHUB_TOKEN: "",
    ZENKAITV_ADULT_DEPLOY_KEY: "", ZENKAITV_ADULT_KNOWN_HOSTS: "",
    ZENKAITV_ADULT_REPOSITORY_URL: remote };
  if (deployKey) {
    const key = join(state, "neutral_key");
    const hosts = join(state, "neutral_hosts");
    writeFileSync(key, "Opaque neutral fixture; not a real credential.\n", { mode: 0o600 });
    writeFileSync(hosts, "Opaque neutral host fixture; no network access.\n");
    Object.assign(env, { ZENKAITV_ADULT_DEPLOY_KEY: key, ZENKAITV_ADULT_KNOWN_HOSTS: hosts,
      ZENKAITV_ADULT_REPOSITORY_URL: "https://github.com/JSolanoDev/AnimeTV.git",
      FIXTURE_FORBID_GH: "1", FIXTURE_REMOTE: remote,
      FIXTURE_GIT_EXECUTABLE: command("sh", ["-c", "command -v git"], temp).trim() });
    writeFileSync(join(bin, "git"), `#!/usr/bin/env bash
set -eu
if [[ "$1" == "-c" && "$2" == "credential.helper=" ]]; then shift 2; fi
case "$1" in
  clone)
    args=("$@")
    for index in "\${!args[@]}"; do
      if [[ "\${args[$index]}" == "https://github.com/JSolanoDev/AnimeTV.git" ]]; then args[$index]="$FIXTURE_REMOTE"; fi
    done
    "$FIXTURE_GIT_EXECUTABLE" "\${args[@]}"
    "$FIXTURE_GIT_EXECUTABLE" -C "$ZENKAITV_ADULT_STATE_DIR/checkout" config remote.origin.url "https://github.com/JSolanoDev/AnimeTV.git"
    ;;
  fetch)
    args=("$@")
    for index in "\${!args[@]}"; do
      if [[ "\${args[$index]}" == "origin" ]]; then args[$index]="$FIXTURE_REMOTE"; fi
    done
    exec "$FIXTURE_GIT_EXECUTABLE" "\${args[@]}"
    ;;
  push)
    [[ "$*" == "push --dry-run origin HEAD:main" ]]
    [[ "$GIT_SSH_COMMAND" == *"IdentityAgent=none"* && "$GIT_SSH_COMMAND" == *"StrictHostKeyChecking=yes"* ]]
    [[ -z "\${GH_TOKEN:-}" && -z "\${GITHUB_TOKEN:-}" && -z "\${SSH_AUTH_SOCK:-}" ]]
    printf checked >"$ZENKAITV_ADULT_STATE_DIR/key-auth-checked"
    exit "\${FIXTURE_SSH_EXIT:-0}"
    ;;
  *) exec "$FIXTURE_GIT_EXECUTABLE" "$@" ;;
esac
`);
    chmodSync(join(bin, "git"), 0o700);
  }
  return { state, git, run: (extra = {}, args = [wrapper]) => spawnSync("bash", args, {
    cwd: temp, encoding: "utf8", env: { ...process.env, ...env, ...extra }
  }), cleanup: () => rmSync(temp, { recursive: true, force: true }) };
}

for (const status of ["fresh", "unchanged", "stale"]) {
  test(`Linux ${status} refresh publishes only eligible changes and records the result`, { skip: !linux }, () => {
    const f = fixture();
    try {
      const result = f.run({ FIXTURE_STATUS: status });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(existsSync(join(f.state, "published")), status === "fresh");
      assert.equal(JSON.parse(readFileSync(join(f.state, "latest-report.json"), "utf8")).status, status);
      const repeat = f.run({ FIXTURE_STATUS: status });
      assert.equal(repeat.status, 0);
      assert.match(repeat.stdout, /last hour/);
      assert.equal(readFileSync(join(f.state, "calls"), "utf8"), "check\n");
    } finally { f.cleanup(); }
  });
}

for (const failure of ["FIXTURE_REFRESH_FAIL", "FIXTURE_INVALID_REPORT", "FIXTURE_VALIDATION_FAIL"]) {
  test(`Linux ${failure} fails without publishing or recording success`, { skip: !linux }, () => {
    const f = fixture();
    try {
      const result = f.run({ [failure]: "1", FIXTURE_STATUS: "fresh" });
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(join(f.state, "published")), false);
      assert.equal(existsSync(join(f.state, "last-completed-at")), false);
      assert.equal(existsSync(join(f.state, "latest-report.json")), false);
    } finally { f.cleanup(); }
  });
}

test("Linux refuses dirty checkouts without discarding existing work", { skip: !linux }, () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    const note = join(f.state, "checkout", "keep.txt");
    writeFileSync(note, "Preserve this local work.");
    const result = f.run({ ZENKAITV_ADULT_FORCE_REFRESH: "1" });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /pending changes/);
    assert.equal(readFileSync(note, "utf8"), "Preserve this local work.");
    assert.equal(readFileSync(join(f.state, "calls"), "utf8"), "check\n");
  } finally { f.cleanup(); }
});

test("Linux bounds network stages and preserves a failed authentication attempt", { skip: !linux }, () => {
  const f = fixture();
  try {
    const failed = f.run({ FIXTURE_AUTH_HANG: "1", FIXTURE_TEST_TIMEOUT: "0.2s" });
    assert.equal(failed.status, 124);
    assert.match(failed.stderr, /Check GitHub authentication \(exit 124\)/);
    assert.equal(existsSync(join(f.state, "checkout")), false);
    assert.equal(existsSync(join(f.state, "calls")), false);
    assert.equal(existsSync(join(f.state, "last-completed-at")), false);
    const recovered = f.run();
    assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
    const calls = readFileSync(join(f.state, "timeout-calls"), "utf8");
    assert.match(calls, /--kill-after=10s 60s gh/);
    assert.equal((calls.match(/--kill-after=30s 5m git/g) || []).length, 2);
    assert.equal(readFileSync(join(f.state, "calls"), "utf8"), "check\n");
  } finally { f.cleanup(); }
});

test("Linux deploy-key publishing works without personal tokens, agents, or gh", { skip: !linux }, () => {
  const f = fixture({ deployKey: true });
  try {
    const preflight = f.run({}, [wrapper, "--check-auth"]);
    assert.equal(preflight.status, 0, preflight.stdout + preflight.stderr);
    assert.equal(existsSync(join(f.state, "calls")), false);
    assert.equal(existsSync(join(f.state, "dependencies.sha256")), false);
    assert.equal(existsSync(join(f.state, "last-completed-at")), false);
    const result = f.run({ FIXTURE_STATUS: "fresh", GH_TOKEN: "neutral-token", GITHUB_TOKEN: "neutral-token", SSH_AUTH_SOCK: "/neutral/agent" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(existsSync(join(f.state, "key-auth-checked")), true);
    assert.equal(existsSync(join(f.state, "published")), true);
    assert.equal(f.git("-C", join(f.state, "checkout"), "config", "--get", "remote.origin.pushurl").trim(), "git@github.com:JSolanoDev/AnimeTV.git");
    const repeat = f.run({}, [wrapper, "--check-auth"]);
    assert.equal(repeat.status, 0, repeat.stdout + repeat.stderr);
    assert.match(repeat.stdout, /Configured authentication check passed/);
    assert.equal(readFileSync(join(f.state, "calls"), "utf8"), "check\n");
    const legacy = f.run({ ZENKAITV_ADULT_DEPLOY_KEY: "", ZENKAITV_ADULT_FORCE_REFRESH: "1", FIXTURE_FORBID_GH: "0" });
    assert.equal(legacy.status, 0, legacy.stdout + legacy.stderr);
    assert.equal(f.git("-C", join(f.state, "checkout"), "config", "--get", "remote.origin.pushurl").trim(), "https://github.com/JSolanoDev/AnimeTV.git");
  } finally { f.cleanup(); }
});

test("Linux rejects unsupported options without refreshing", { skip: !linux }, () => {
  const f = fixture();
  try {
    assert.equal(f.run({}, [wrapper, "--unknown"]).status, 2);
    assert.equal(existsSync(join(f.state, "calls")), false);
  } finally { f.cleanup(); }
});

for (const failure of ["missing-key", "insecure-key", "unexpected-repository", "rejected-key"]) {
  test(`Linux ${failure} fails closed before crawling without a keyring fallback`, { skip: !linux }, () => {
    const f = fixture({ deployKey: true });
    try {
      const extra = {};
      if (failure === "missing-key") extra.ZENKAITV_ADULT_DEPLOY_KEY = join(f.state, "missing");
      if (failure === "insecure-key") chmodSync(join(f.state, "neutral_key"), 0o644);
      if (failure === "unexpected-repository") extra.ZENKAITV_ADULT_REPOSITORY_URL = "https://example.test/neutral.git";
      if (failure === "rejected-key") extra.FIXTURE_SSH_EXIT = "128";
      const result = f.run(extra);
      assert.notEqual(result.status, 0);
      assert.notEqual(result.status, 97, "Personal gh login must not be consulted.");
      if (failure === "rejected-key") {
        assert.equal(result.status, 128);
        assert.equal(existsSync(join(f.state, "key-auth-checked")), true);
        assert.match(result.stderr, /Check unattended repository write access/);
      }
      assert.equal(existsSync(join(f.state, "calls")), false);
      assert.equal(existsSync(join(f.state, "published")), false);
      assert.equal(existsSync(join(f.state, "last-completed-at")), false);
    } finally { f.cleanup(); }
  });
}

test("Linux reuses locked dependencies, tolerates empty cooldown markers, and honors overlap locks", { skip: !linux }, () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    // The dependency-free neutral fixture does not create node_modules itself.
    mkdirSync(join(f.state, "checkout", "node_modules"), { recursive: true });
    writeFileSync(join(f.state, "last-completed-at"), "");
    const repeat = f.run();
    assert.equal(repeat.status, 0, repeat.stdout + repeat.stderr);
    assert.doesNotMatch(repeat.stdout, /Install locked dependencies/);
    assert.equal(readFileSync(join(f.state, "calls"), "utf8"), "check\ncheck\n");
    const locked = f.run({ TEST_WRAPPER: wrapper }, ["-c", 'exec 8>"$ZENKAITV_ADULT_STATE_DIR/refresh.lock"; flock 8; bash "$TEST_WRAPPER"']);
    assert.equal(locked.status, 0);
    assert.match(locked.stdout, /already running/);
    assert.equal(readFileSync(join(f.state, "calls"), "utf8"), "check\ncheck\n");
  } finally { f.cleanup(); }
});
