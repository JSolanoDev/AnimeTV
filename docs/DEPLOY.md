# Deploying ZenkaiTV online

ZenkaiTV is **two services**:

| Service | Folder | Runtime | Purpose |
|---|---|---|---|
| **Web app** | this repo (`AnimeTV/`) | Node 20 | UI + metadata (AniList/Jikan) + AniPub + proxy to the scraper |
| **Scraper** | the Python project (`app.py`, `scraper.py`, …) | Python 3.12 | TioAnime + AnimeAV1 episode sources |

The browser only ever talks to the **Web app** (relative `/api/...` calls), so it works on any
domain with zero code changes. The Web app talks to the Scraper server‑to‑server via `TIOANIME_API`.

---

## Recommended: Render (persistent Node + Python)

### 1. Deploy the scraper first
1. Push the Python project to its own Git repo (it already has `requirements.txt`, `Procfile`, `render.yaml`).
2. On <https://render.com> → **New → Blueprint** → pick that repo.
3. It deploys as `zenkaitv-scraper`. Wait for **Live**, then copy its URL, e.g.
   `https://zenkaitv-scraper.onrender.com`.
4. Sanity check: open `…/api/health` → `{"ok":true,"service":"tioanime-finder"}`.

### 2. Deploy the web app
1. Push this `AnimeTV/` repo to Git.
2. Render → **New → Blueprint** → pick this repo (uses `render.yaml`).
3. Before/after first deploy, set the env var **`TIOANIME_API`** to the scraper URL from step 1.
4. Wait for **Live**. Open the service URL → the app loads, `…/api/health` returns ok.

That's it — the site is fully online. AniList/Jikan/AniPub work immediately; TioAnime/AnimeAV1
sources work because `TIOANIME_API` points at the live scraper.

> **Free tier note:** Render free web services sleep after ~15 min idle and cold‑start on the next
> request (a few seconds). Fine for personal use; upgrade to a paid instance to keep it always warm.

---

## Alternatives (same two‑service shape)

**Railway** — create two services from the repos. Railway injects `PORT` automatically.
Start commands: `node animetv-local.js` (web) and `gunicorn app:app --bind 0.0.0.0:$PORT` (scraper).
Set `TIOANIME_API` on the web service to the scraper's public URL.

**Fly.io** — `fly launch` in each folder. The Node `Dockerfile` already exists; for the scraper,
Fly can use the buildpack (`requirements.txt` + `Procfile`). Set `TIOANIME_API` as a Fly secret.

**Self‑host (VPS / Docker)** — run the Node `Dockerfile` (port 4173) and run the scraper with
`gunicorn app:app --bind 0.0.0.0:5000`, then start the web container with
`TIOANIME_API=http://<vps-ip>:5000`.

---

## Environment variables (web app)

| Var | Required | Notes |
|---|---|---|
| `PORT` | host sets it | Server binds `0.0.0.0:$PORT`. |
| `TIOANIME_API` | for TioAnime/AnimeAV1 | URL of the deployed scraper. |
| `ANIME1V_AUTO_START` | recommended `false` | Never spawn the local Anime1v addon on a host. |
| `CONSUMET_API`, `RAPIDAPI_*` | optional | See `.env.example`. Skipped gracefully if unset. |

---

## Custom domain
Add your domain in the host dashboard and point DNS as instructed. HTTPS/HSTS is enabled
automatically when a hosted‑runtime env var is present (Render/Railway/Fly/Vercel detected).

---

## Android TV
The Android app bundles its own on‑device Node server (`android/app/src/main/assets/`), so the
TV app does **not** depend on the website being up — except for the scraper sources, which are
Python‑only and not bundled. Set `TIOANIME_API` in the app's env (or hardcode your hosted scraper
URL in the bundled `animetv-server.js`) so TioAnime/AnimeAV1 work on the TV too. Build the APK with
`npm run android:build` (outputs `android/app/build/outputs/apk/debug/app-debug.apk`).
