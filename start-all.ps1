param(
  [string]$AnimeTVPath = $PSScriptRoot,
  [string]$Anime1vPath = $(if ($env:ANIME1V_PATH) { $env:ANIME1V_PATH } else { "C:\anime1v-api" }),
  [int]$CheckEverySeconds = 10,
  [switch]$NoConsumet,
  [switch]$NoBrowser,
  # ── Scraper options ────────────────────────────────────────────────────────
  [switch]$NoScraper,           # skip the Python scraper entirely
  [switch]$ScraperEpisodes,     # pass --episodes (slower, adds direct video URLs)
  [int]$ScraperTop    = 20,     # --top N  — shows to collect episode URLs for
  [int]$ScraperMaxEps = 5,      # --max-eps N — episodes per show
  [int]$ScraperEveryHours = 6   # re-run the scraper every N hours
)

$ErrorActionPreference = "Continue"
$animeTvHealth  = "http://127.0.0.1:4173/api/health"
$anime1vHealth  = "http://127.0.0.1:3001/health"
$consumetHealth = "http://127.0.0.1:3000/anime/kickassanime/naruto?page=1"
$logDir         = Join-Path $AnimeTVPath "logs"
$animeTvProcess = $null
$anime1vProcess = $null
$scraperProcess = $null
$lastScraperRun = [datetime]::MinValue   # tracks when we last kicked off a scrape
$openedBrowser  = $false

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# ── Helper: HTTP health check ────────────────────────────────────────────────
function Test-Health {
  param([string]$Url)
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 4
    return $r.StatusCode -ge 200 -and $r.StatusCode -lt 500
  } catch {
    return $false
  }
}

# ── Helper: find Anime1v installation ────────────────────────────────────────
function Find-Anime1vPath {
  $candidates = @(
    $Anime1vPath,
    (Join-Path $AnimeTVPath "anime1v-api"),
    (Join-Path (Split-Path -Parent $AnimeTVPath) "anime1v-api"),
    "C:\anime1v-api"
  ) | Where-Object { $_ -and $_.Trim() }

  foreach ($c in $candidates) {
    if (Test-Path -LiteralPath (Join-Path $c "package.json")) { return $c }
  }
  return ""
}

# ── Helper: start a supervised Node process ──────────────────────────────────
function Start-ManagedNode {
  param(
    [string]$Name,
    [string]$WorkingDirectory,
    [string]$ScriptPath,
    [string]$LogPrefix
  )

  if (-not (Test-Path -LiteralPath $WorkingDirectory)) {
    Write-Host "$Name folder not found: $WorkingDirectory" -ForegroundColor DarkYellow
    return $null
  }

  $full = Join-Path $WorkingDirectory $ScriptPath
  if (-not (Test-Path -LiteralPath $full)) {
    Write-Host "$Name script not found: $full" -ForegroundColor DarkYellow
    return $null
  }

  Write-Host "Starting $Name..." -ForegroundColor Yellow
  return Start-Process -FilePath "node" `
    -ArgumentList $ScriptPath `
    -WorkingDirectory $WorkingDirectory `
    -WindowStyle Hidden `
    -PassThru `
    -RedirectStandardOutput (Join-Path $logDir "$LogPrefix.out.log") `
    -RedirectStandardError  (Join-Path $logDir "$LogPrefix.err.log")
}

# ── Scraper autostart ────────────────────────────────────────────────────────
function Ensure-Scraper {
  if ($NoScraper) { return }

  # Require Python
  if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Host "Scraper: Python not found — skipping (install Python 3.11+ to enable)" `
      -ForegroundColor DarkYellow
    return
  }

  $scraperScript = Join-Path $AnimeTVPath "scraper\anime_scraper.py"
  if (-not (Test-Path -LiteralPath $scraperScript)) {
    Write-Host "Scraper: script not found at $scraperScript" -ForegroundColor DarkYellow
    return
  }

  # Don't start a second copy while one is already running
  if ($script:scraperProcess -and -not $script:scraperProcess.HasExited) {
    return
  }

  # Decide whether a run is due:
  #  • metadata JSON is missing, OR
  #  • it's older than $ScraperEveryHours hours
  $jsonPath   = Join-Path $AnimeTVPath "scraper\anime_metadata.json"
  $jsonExists = Test-Path -LiteralPath $jsonPath
  $jsonAge    = if ($jsonExists) {
    (Get-Date) - (Get-Item $jsonPath).LastWriteTime
  } else {
    [timespan]::MaxValue
  }

  $dueHours   = [timespan]::FromHours($ScraperEveryHours)
  if ($jsonExists -and $jsonAge -lt $dueHours) {
    return   # catalog is fresh — nothing to do
  }

  # Build argument list
  $pyArgs = @("scraper\anime_scraper.py")
  if ($ScraperEpisodes) {
    $pyArgs += "--episodes"
    $pyArgs += "--top";     $pyArgs += $ScraperTop
    $pyArgs += "--max-eps"; $pyArgs += $ScraperMaxEps
  }

  $label = if ($ScraperEpisodes) { "with episode URLs" } else { "metadata only" }
  Write-Host "Starting anime scraper ($label)..." -ForegroundColor Cyan
  Write-Host "  Logs: $logDir\scraper.out.log" -ForegroundColor Gray

  $script:scraperProcess = Start-Process -FilePath "python" `
    -ArgumentList $pyArgs `
    -WorkingDirectory $AnimeTVPath `
    -WindowStyle Hidden `
    -PassThru `
    -RedirectStandardOutput (Join-Path $logDir "scraper.out.log") `
    -RedirectStandardError  (Join-Path $logDir "scraper.err.log")

  $script:lastScraperRun = Get-Date
}

# ── Notify AnimeTV to reload the catalog after a successful scrape ───────────
function Invoke-ScraperRefresh {
  # Called once after the scraper process exits successfully
  try {
    Invoke-WebRequest -UseBasicParsing `
      -Uri "http://127.0.0.1:4173/api/refresh-daily?background=1" `
      -TimeoutSec 5 | Out-Null
    Write-Host "Scraper finished → catalog refreshed in AnimeTV" -ForegroundColor Green
  } catch {
    # AnimeTV might not be up yet; it'll pick up the file on next start
  }
}

# ── Supervised services ──────────────────────────────────────────────────────
function Ensure-Anime1v {
  if (Test-Health $anime1vHealth) { return }

  if ($script:anime1vProcess -and -not $script:anime1vProcess.HasExited) {
    Write-Host "Anime1v is not healthy; restarting it..." -ForegroundColor DarkYellow
    Stop-Process -Id $script:anime1vProcess.Id -Force -ErrorAction SilentlyContinue
  }

  $path = Find-Anime1vPath
  if (-not $path) {
    Write-Host "Anime1v API not found. Set ANIME1V_PATH or install it at C:\anime1v-api." `
      -ForegroundColor DarkYellow
    return
  }

  $script:anime1vProcess = Start-ManagedNode -Name "Anime1v API" `
    -WorkingDirectory $path -ScriptPath "src/server.js" -LogPrefix "anime1v"
}

function Ensure-AnimeTV {
  if (Test-Health $animeTvHealth) { return }

  if ($script:animeTvProcess -and -not $script:animeTvProcess.HasExited) {
    Write-Host "AnimeTV is not healthy; restarting it..." -ForegroundColor DarkYellow
    Stop-Process -Id $script:animeTvProcess.Id -Force -ErrorAction SilentlyContinue
  }

  $script:animeTvProcess = Start-ManagedNode -Name "AnimeTV" `
    -WorkingDirectory $AnimeTVPath -ScriptPath "animetv-local.js" -LogPrefix "animetv"
}

function Test-Docker {
  return [bool](Get-Command docker -ErrorAction SilentlyContinue)
}

function Ensure-Consumet {
  if ($NoConsumet) { return }
  if (Test-Health $consumetHealth) { return }
  if (-not (Test-Docker)) {
    Write-Host "Consumet is offline and Docker is not available. Install Docker or run: docker run -p 3000:3000 riimuru/consumet-api" `
      -ForegroundColor DarkYellow
    return
  }
  try {
    $existing = docker ps -a --filter "name=animetv-consumet" --format "{{.Names}}"
    if ($existing -contains "animetv-consumet") {
      Write-Host "Starting existing Consumet container..." -ForegroundColor Yellow
      docker start animetv-consumet | Out-Null
      return
    }
    Write-Host "Starting Consumet API container on http://127.0.0.1:3000..." -ForegroundColor Yellow
    docker run -d --name animetv-consumet -p 3000:3000 riimuru/consumet-api | Out-Null
  } catch {
    Write-Host "Consumet could not start. Port 3000 may be busy or Docker may need to be opened." `
      -ForegroundColor DarkYellow
  }
}

function Invoke-DailyRefresh {
  try {
    Invoke-WebRequest -UseBasicParsing `
      -Uri "http://127.0.0.1:4173/api/refresh-daily?background=1" `
      -TimeoutSec 5 | Out-Null
  } catch {
    Write-Host "Daily refresh could not start yet." -ForegroundColor DarkGray
  }
}

# ── Startup banner ───────────────────────────────────────────────────────────
Write-Host "AnimeTV supervised launcher" -ForegroundColor Cyan
Write-Host "AnimeTV:  http://127.0.0.1:4173" -ForegroundColor Green
Write-Host "Anime1v:  http://127.0.0.1:3001" -ForegroundColor Green
Write-Host "Consumet: http://127.0.0.1:3000" -ForegroundColor Green
if (-not $NoScraper) {
  $epNote = if ($ScraperEpisodes) { " (+episode URLs)" } else { " (metadata only)" }
  Write-Host "Scraper:  every ${ScraperEveryHours}h$epNote — logs\scraper.out.log" -ForegroundColor Green
}
Write-Host "Logs:     $logDir" -ForegroundColor Gray
Write-Host "Checking every $CheckEverySeconds seconds. Keep this window open." -ForegroundColor Gray
Write-Host ""

# ── Main supervision loop ─────────────────────────────────────────────────────
while ($true) {
  Ensure-Consumet
  Start-Sleep -Seconds 1
  Ensure-Anime1v
  Start-Sleep -Seconds 1
  Ensure-AnimeTV
  Ensure-Scraper   # starts if JSON is missing or older than $ScraperEveryHours

  # If the scraper just finished, tell AnimeTV to reload the catalog
  if ($script:scraperProcess -and $script:scraperProcess.HasExited) {
    if ($script:scraperProcess.ExitCode -eq 0) {
      Invoke-ScraperRefresh
    } else {
      Write-Host ("Scraper exited with code {0} — check logs\scraper.err.log" -f `
        $script:scraperProcess.ExitCode) -ForegroundColor Red
    }
    $script:scraperProcess = $null   # allow Ensure-Scraper to schedule the next run
  }

  $animeTvStatus  = if (Test-Health $animeTvHealth)  { "online" } else { "offline" }
  $anime1vStatus  = if (Test-Health $anime1vHealth)  { "online" } else { "offline" }
  $consumetStatus = if (Test-Health $consumetHealth) { "online" } else { "offline" }
  $scraperStatus  = if ($NoScraper) { "off" }
                    elseif ($script:scraperProcess -and -not $script:scraperProcess.HasExited) { "running" }
                    else {
                      $json = Join-Path $AnimeTVPath "scraper\anime_metadata.json"
                      if (Test-Path $json) {
                        $age = (Get-Date) - (Get-Item $json).LastWriteTime
                        "ok ({0}h ago)" -f [int]$age.TotalHours
                      } else { "no catalog" }
                    }

  if ($animeTvStatus -eq "online" -and -not $openedBrowser) {
    Invoke-DailyRefresh
    if (-not $NoBrowser) {
      Start-Process "http://127.0.0.1:4173/?v=155"
    }
    $openedBrowser = $true
  }

  Write-Host ("{0}  AnimeTV:{1}  Anime1v:{2}  Consumet:{3}  Scraper:{4}" -f `
    (Get-Date -Format "HH:mm:ss"), $animeTvStatus, $anime1vStatus, $consumetStatus, $scraperStatus)
  Start-Sleep -Seconds $CheckEverySeconds
}
