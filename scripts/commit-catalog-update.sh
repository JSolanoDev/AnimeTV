#!/usr/bin/env bash

set -euo pipefail

remote="${CATALOG_PUSH_REMOTE:-origin}"
branch="${CATALOG_PUSH_BRANCH:-main}"
max_attempts="${CATALOG_PUSH_MAX_ATTEMPTS:-3}"
retry_delay="${CATALOG_PUSH_RETRY_DELAY_SECONDS:-2}"
fetch_depth="${CATALOG_PUSH_FETCH_DEPTH:-50}"
remote_ref="refs/remotes/${remote}/${branch}"

catalog_files=(
  "scraper/anime_metadata.json"
  "scraper/anime_metadata.previous.json"
  "scraper/anime_metadata.csv"
  "scraper/anilist-id-overrides.json"
  "scraper/artwork-map.json"
  "scraper/airing-map.json"
  "scraper/aniskip-map.json"
  "scraper/relations-cache.json"
  "scraper/regular-source-fallbacks.json"
  "scraper/adult_portrait_map.json"
  "scraper/underhentai_catalog.json"
  "scraper/underhentai_details.json"
  "scraper/underhentai_releases.json"
  "android/app/src/main/assets/scraper/underhentai_catalog.json"
  "android/app/src/main/assets/scraper/underhentai_details.json"
  "android/app/src/main/assets/scraper/underhentai_releases.json"
  "android/app/src/main/assets/scraper/artwork-map.json"
  "android/app/src/main/assets/scraper/aniskip-map.json"
  "android/app/src/main/assets/scraper/regular-source-fallbacks.json"
  "android/app/src/main/assets/scraper/adult_portrait_map.json"
)

set_output() {
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s\n' "$1" >> "$GITHUB_OUTPUT"
  fi
}

git add -- "${catalog_files[@]}"

if git diff --cached --quiet; then
  echo "No catalog changes to commit."
  set_output "changes_detected=false"
  exit 0
fi

git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"
git commit -m "chore: update anime catalog"

for ((attempt = 1; attempt <= max_attempts; attempt++)); do
  echo "Publishing catalog update (attempt ${attempt}/${max_attempts})..."
  git fetch --no-tags --depth="$fetch_depth" "$remote" "+refs/heads/${branch}:${remote_ref}"
  git rebase "$remote_ref"

  if git push "$remote" "HEAD:${branch}"; then
    set_output "changes_detected=true"
    exit 0
  fi

  if ((attempt == max_attempts)); then
    echo "::error::Catalog update could not be pushed after ${max_attempts} attempts."
    exit 1
  fi

  sleep "$((retry_delay * attempt))"
done
