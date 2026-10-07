# Daily Linux Catalog Refresh

Run the existing protected adult updater from an always-on Linux machine that can
access the provider normally. This is not an HTTP 403 bypass. Verify a complete
refresh before activating it; keep all existing eligibility and content checks.
No public GitHub self-hosted runner, root service, or client/player changes are needed.

## Requirements

- Node.js >=20.9, npm, Git, GitHub CLI, Bash, flock, timeout, and user systemd.
- A repository-only SSH deploy key with write permission, or a working `gh` login
  with permission to push to `JSolanoDev/AnimeTV` (legacy mode).
- User lingering is enabled so the service survives logout and starts at boot.
- The laptop stays awake, powered, and connected. This setup does not change lid,
  suspend, router, firewall, or public SSH settings.

Install `scripts/run-adult-refresh-linux.sh` as
`~/.local/libexec/zenkaitv-adult-refresh.sh` (mode 700), and the two
`ops/systemd/zenkaitv-adult-refresh.*` units under `~/.config/systemd/user/`.
Then run:

```bash
systemd-analyze --user verify ~/.config/systemd/user/zenkaitv-adult-refresh.service ~/.config/systemd/user/zenkaitv-adult-refresh.timer
systemctl --user daemon-reload
systemctl --user start zenkaitv-adult-refresh.service
systemctl --user enable --now zenkaitv-adult-refresh.timer
systemctl --user list-timers zenkaitv-adult-refresh.timer
```

The schedule is 06:17 UTC daily (currently 00:17 America/Denver during daylight
saving time), with up to two minutes of jitter. Persistent scheduling catches up
after downtime; it does not wake a sleeping or powered-off laptop. A one-hour
cooldown prevents an immediate repeat after manual checks. The regular catalog
continues using its existing GitHub workflows.

## Publication Safety

The service uses a separate checkout under
`~/.local/state/zenkaitv-adult-refresh/checkout`. It reads only trusted `main`,
refuses dirty or unexpected checkouts, reuses locked dependencies, serializes
local runs, retains the existing two-worker/550ms pacing and 45-minute timeout,
and runs refresh, publication, mirror, and release-date validation. Only a `fresh`
validated report can invoke the existing race-safe adult-only publisher.
Unchanged data does not trigger a commit or Vercel deployment. Expected provider
outages preserve the previous snapshot; code or validation failures still fail.
GitHub authentication has a 60-second limit; cloning and fetching each have a
five-minute limit. A network timeout fails safely without crawling, publishing,
or recording a successful check. These limits do not add retries or change the
provider request pacing.
Vercel's existing Git integration deploys a successful catalog push; no additional
deploy hook or Vercel polling function is required.

Logs and `latest-report.json` remain private in the state directory. Logs can
include provider URLs: do not display media or title descriptions while debugging.
The normal journal output is limited to operational status.

## Unattended Authentication

For publishing without a desktop login or unlocked keyring, create a dedicated
Ed25519 deploy key on the Linux host and register only its public key in the
repository's deploy keys with write access. Keep the unencrypted private key
under the private state directory, mode 600 (or 400), owned by the service user.
It grants repository write access, not just catalog-file access: protect the
laptop, and revoke the deploy key in GitHub if it is compromised or retired.
Never copy the private key to the repository, Windows, logs, or chat.

Pin GitHub's Ed25519 host key in a separate `github_known_hosts` file, after
checking it against GitHub's official SSH fingerprints. The service reads an
optional private `auth.env` in its state directory, containing absolute paths:

```ini
ZENKAITV_ADULT_DEPLOY_KEY=/home/YOUR_USER/.local/state/zenkaitv-adult-refresh/github_ed25519
ZENKAITV_ADULT_KNOWN_HOSTS=/home/YOUR_USER/.local/state/zenkaitv-adult-refresh/github_known_hosts
```

Install `ops/systemd/zenkaitv-adult-refresh-deploy-key.conf` as
`~/.config/systemd/user/zenkaitv-adult-refresh.service.d/10-deploy-key.conf`.
This makes `auth.env` mandatory in deploy-key mode: a missing configuration
cannot silently return the installed service to a personal keyring login.

With this configuration the updater does not call `gh` or use a desktop SSH
agent. It fetches the public repository over HTTPS without a credential helper,
and publishes over SSH using only the dedicated key and strict host checking.
A bounded dry-run push checks write authentication before provider requests;
it does not publish data or trigger deployment. Missing, insecure, or rejected
credentials fail closed without falling back to a personal login.

Validate this configuration in the same systemd sandbox with desktop bus,
SSH-agent, and GitHub-token variables removed. No reboot is necessary for that
check; after updating `auth.env`, reload the user units. To return to legacy
authentication, remove the deploy-key override and these two variables from
`auth.env`, then reload the units.
The installed wrapper accepts `--check-auth` for a lock-protected authentication
check without dependency installation, provider crawling, or publication. Run it
with the same environment as the service. It bypasses the refresh cooldown only
for this check, and never writes a successful refresh marker.

Once the Linux service and timer are verified, set the repository variable:

```bash
gh variable set ADULT_REFRESH_EXTERNAL --body true --repo JSolanoDev/AnimeTV
```

This suppresses only duplicate scheduled adult jobs on GitHub. Manual and
push-triggered validation remain available. To return scheduling to GitHub:

```bash
systemctl --user disable --now zenkaitv-adult-refresh.timer
gh variable delete ADULT_REFRESH_EXTERNAL --repo JSolanoDev/AnimeTV
```

Check operations with `systemctl --user status zenkaitv-adult-refresh.timer` and
`journalctl --user -u zenkaitv-adult-refresh.service`. For a real failed run,
inspect the private log and preserve any pending checkout changes before recovery.
Do not use hard resets or force pushes. Update the installed wrapper/units when
their repository copies change; this checkout automatically updates the builders
and validation scripts from trusted `main` before each uncached daily run.
