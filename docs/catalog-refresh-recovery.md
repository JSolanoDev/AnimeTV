# Daily Catalog Refresh Recovery

## Failure Identified

[Run 37166108817](https://github.com/JSolanoDev/AnimeTV/actions/runs/37166108817)
stopped in `Refresh Adult Mode catalog`: UnderHentai returned HTTP 403 to the
catalog builder. The regular scraping and enrichment steps had completed, but
validation and publishing were skipped. The live catalog was not replaced.

Auditing the failure artifact also exposed a later validation problem: 19 exact
season identities discovered through AniList relations were newer than the
offline identity database. Seeding skipped them, leaving missing season artwork
and metadata. All 4,440 regular titles and their saved episode routes were retained.

## Targeted Fixes

- `adult:catalog` validates and snapshots the four adult assets and their Android
  mirrors before running the existing builders. All eight files are restored
  together if a stage fails. Only a recognized provider outage and a valid saved
  snapshot can return success with an explicit **stale** warning.
- Adult 403/408/429/5xx or transport timeouts stop the refresh and queued requests.
  There are no immediate retries or security workarounds. Retry-After is recorded
  on the upstream error; the next daily run can attempt a new refresh.
- Empty/invalid responses, broken parsers, invalid candidates, invalid baselines,
  and mismatched Android assets still fail. Existing validation gates remain.
- The existing batched AniList relation request includes exact covers and banners.
  The offline seeder can use those exact identities and their basic canonical
  metadata even before the offline DB includes them. Existing artwork and
  descriptions are not overwritten. Unknown episode totals stay unknown.
  New identity artwork is stored once in a build-only map, not repeated in
  runtime season chains or added to `/api/catalog` responses.
- `artifacts/adult-refresh-report.json`, a workflow warning, and the GitHub step
  summary distinguish a fresh adult refresh from retained stale data.

## Validation

- Ten deterministic adult regression cases cover blocked/rate-limited upstreams,
  queued workers, deadlines, missing baselines, invalid candidates, rollback,
  healthy updates, and the real catalog builder's exit code.
- Six new-release tests cover batching, exact relation artwork, offline-DB lag,
  static latest-feed enrichment, client reuse, and metadata preservation.
- A controlled HTTP 403 test ran the actual wrapper and validators against the
  committed adult snapshot: 989 titles, 2,251 episodes, 5,388 release routes.
  It retained every asset and returned an explicit stale warning.
- Replaying the failed regular artifact with exact provider covers and the
  corrected seeder passes the unchanged integrity gate: 4,440 titles, 60,244
  episode routes, and all 2,169 season identities with artwork and basic metadata.
  This is an artifact replay, not evidence that a new GitHub run has completed.

No player, Chromecast, client UI, runtime API, cache contract, Vercel compute,
function duration, security protection, or deployed catalog was changed by these
updater fixes. The daily schedule remains 06:00 UTC. A provider outage cannot
produce new adult releases until the provider is reachable again.

An unrelated existing npm advisory affects pinned `sharp@0.35.2`
(`GHSA-rgj7-g3m4-5g8c`). No forced dependency upgrades are included in this fix;
an image-regression-tested patch upgrade should be handled separately.
