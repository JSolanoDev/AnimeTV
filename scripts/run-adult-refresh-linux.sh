#!/usr/bin/env bash

set -euo pipefail
umask 077
export GIT_TERMINAL_PROMPT=0

state="${ZENKAITV_ADULT_STATE_DIR:-${HOME}/.local/state/zenkaitv-adult-refresh}"
repository="${ZENKAITV_ADULT_REPOSITORY_URL:-https://github.com/JSolanoDev/AnimeTV.git}"
checkout="${state}/checkout"

for executable in node npm git gh flock timeout; do
  command -v "$executable" >/dev/null || { echo "Required command unavailable: ${executable}"; exit 1; }
done
mkdir -p "$state"
exec 9>"${state}/refresh.lock"
if ! flock -n 9; then
  echo "A catalog refresh is already running; no duplicate requests were made."
  exit 0
fi

# Avoid re-crawling when a persistent timer catches up just after a manual run.
if [[ "${ZENKAITV_ADULT_FORCE_REFRESH:-0}" != "1" && -f "${state}/last-completed-at" ]]; then
  read -r previous <"${state}/last-completed-at" || previous=""
  now="$(date +%s)"
  if [[ "$previous" =~ ^[0-9]{1,12}$ ]]; then
    previous=$((10#$previous))
    if ((now >= previous && now - previous < 3600)); then
      echo "A protected check completed within the last hour; no duplicate requests were made."
      exit 0
    fi
  fi
fi

mkdir -p "${state}/logs"
log="${state}/logs/$(date -u +%Y%m%dT%H%M%SZ)-$$.log"
stage="initialization"
trap 'code=$?; if ((code != 0)); then printf "Catalog refresh failed during %s (exit %s). Private log: %s\n" "$stage" "$code" "$log" >&2; fi' EXIT

run() {
  stage="$1"
  shift
  printf '%s\n' "$stage"
  "$@" >>"$log" 2>&1
}

run "Check GitHub authentication" gh auth status
if [[ ! -e "$checkout" ]]; then
  run "Create isolated catalog checkout" git clone --no-tags --depth 50 "$repository" "$checkout"
fi
[[ -d "${checkout}/.git" ]] || { echo "Refusing to overwrite a non-repository checkout."; exit 1; }
cd "$checkout"
[[ "$(git remote get-url origin)" == "$repository" ]] || { echo "Unexpected checkout remote; refusing to publish."; exit 1; }
[[ "$(git branch --show-current)" == "main" ]] || { echo "Unexpected checkout branch; refusing to publish."; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo "Checkout has pending changes; preserving them and refusing to publish."; exit 1; }
git config --local --replace-all credential.helper ''
git config --local --add credential.helper '!gh auth git-credential'
run "Fetch trusted main branch" git fetch --no-tags --depth 50 origin '+refs/heads/main:refs/remotes/origin/main'
run "Update without discarding local work" git merge --ff-only refs/remotes/origin/main

export npm_config_cache="${state}/npm-cache"
fingerprint="$( { sha256sum package.json package-lock.json; node --version; npm --version; } | sha256sum | cut -d ' ' -f 1)"
installed=""
if [[ -f "${state}/dependencies.sha256" ]]; then read -r installed <"${state}/dependencies.sha256" || installed=""; fi
if [[ "$fingerprint" != "$installed" || ! -d node_modules ]]; then
  run "Install locked dependencies without lifecycle scripts" timeout --kill-after=30s 10m npm ci --ignore-scripts --no-audit --no-fund
  printf '%s\n' "$fingerprint" >"${state}/dependencies.sha256"
fi

run "Test refresh and publication protections" node --test scripts/test-adult-refresh.mjs scripts/test-linux-adult-refresh.mjs scripts/test-catalog-commit-race.mjs scripts/test-adult-releases.mjs
export UNDERHENTAI_CRAWL_CONCURRENCY=2 UNDERHENTAI_DETAIL_CONCURRENCY=2 UNDERHENTAI_WATCH_CONCURRENCY=2 UNDERHENTAI_REQUEST_INTERVAL_MS=550
run "Refresh with bounded requests and transactional rollback" timeout --signal=TERM --kill-after=30s 45m node scripts/refresh-adult-catalog.mjs
run "Validate publication eligibility" node scripts/check-adult-refresh-status.mjs --allow-preserved-outage
run "Validate catalog and release calendar" npm run adult:verify
run "Validate release dates" npm run test:releases

report="artifacts/adult-refresh-report.json"
status="$(node -e 'const fs = require("node:fs"); const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(r.status);' "$report")"
case "$status" in
  fresh)
    export CATALOG_UPDATE_SCOPE=adult
    run "Publish only validated adult assets" timeout --kill-after=30s 5m bash scripts/commit-catalog-update.sh
    git rev-parse HEAD >"${state}/last-published-commit"
    echo "Validated adult catalog published. Vercel Git integration handles deployment."
    ;;
  unchanged) echo "Provider check passed; no changes to publish or deploy." ;;
  stale) echo "Provider unavailable; validated existing catalog preserved. Nothing published or deployed." ;;
  *) echo "Unknown refresh status; refusing to publish."; exit 1 ;;
esac
cp "$report" "${state}/latest-report.json.tmp"
mv "${state}/latest-report.json.tmp" "${state}/latest-report.json"
date +%s >"${state}/last-completed-at"
