# Daily Linux Catalog Refresh

Run the existing protected adult updater from an always-on Linux machine that can
access the provider normally. This is not an HTTP 403 bypass. Verify a complete
refresh before activating it; keep all existing eligibility and content checks.
No public GitHub self-hosted runner, root service, or client/player changes are needed.

## Requirements

- Node.js >=20.9, npm, Git, GitHub CLI, Bash, flock, timeout, and user systemd.
- `gh auth status` succeeds with permission to push to `JSolanoDev/AnimeTV`.
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
Vercel's existing Git integration deploys a successful catalog push; no additional
deploy hook or Vercel polling function is required.

Logs and `latest-report.json` remain private in the state directory. Logs can
include provider URLs: do not display media or title descriptions while debugging.
The normal journal output is limited to operational status.

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
