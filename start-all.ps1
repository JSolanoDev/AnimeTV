param(
  [string]$AnimeTVPath = $PSScriptRoot,
  [string]$Anime1vPath = $(if ($env:ANIME1V_PATH) { $env:ANIME1V_PATH } else { "C:\anime1v-api" }),
  [int]$CheckEverySeconds = 10,
  [switch]$NoConsumet,
  [switch]$NoBrowser
)

$ErrorActionPreference = "Continue"
$animeTvHealth = "http://127.0.0.1:4173/api/health"
$anime1vHealth = "http://127.0.0.1:3001/health"
$consumetHealth = "http://127.0.0.1:3000/anime/kickassanime/naruto?page=1"
$logDir = Join-Path $AnimeTVPath "logs"
$animeTvProcess = $null
$anime1vProcess = $null
$openedBrowser = $false

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Test-Health {
  param([string]$Url)
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 4
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Find-Anime1vPath {
  $candidates = @(
    $Anime1vPath,
    (Join-Path $AnimeTVPath "anime1v-api"),
    (Join-Path (Split-Path -Parent $AnimeTVPath) "anime1v-api"),
    "C:\anime1v-api"
  ) | Where-Object { $_ -and $_.Trim() }

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath (Join-Path $candidate "package.json")) {
      return $candidate
    }
  }
  return ""
}

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

  $scriptFullPath = Join-Path $WorkingDirectory $ScriptPath
  if (-not (Test-Path -LiteralPath $scriptFullPath)) {
    Write-Host "$Name script not found: $scriptFullPath" -ForegroundColor DarkYellow
    return $null
  }

  Write-Host "Starting $Name..." -ForegroundColor Yellow
  return Start-Process -FilePath "node" `
    -ArgumentList $ScriptPath `
    -WorkingDirectory $WorkingDirectory `
    -WindowStyle Hidden `
    -PassThru `
    -RedirectStandardOutput (Join-Path $logDir "$LogPrefix.out.log") `
    -RedirectStandardError (Join-Path $logDir "$LogPrefix.err.log")
}

function Ensure-Anime1v {
  if (Test-Health $anime1vHealth) {
    return
  }

  if ($script:anime1vProcess -and -not $script:anime1vProcess.HasExited) {
    Write-Host "Anime1v is not healthy; restarting it..." -ForegroundColor DarkYellow
    Stop-Process -Id $script:anime1vProcess.Id -Force -ErrorAction SilentlyContinue
  }

  $path = Find-Anime1vPath
  if (-not $path) {
    Write-Host "Anime1v API not found. Set ANIME1V_PATH or install it at C:\anime1v-api." -ForegroundColor DarkYellow
    return
  }

  $script:anime1vProcess = Start-ManagedNode -Name "Anime1v API" -WorkingDirectory $path -ScriptPath "src/server.js" -LogPrefix "anime1v"
}

function Ensure-AnimeTV {
  if (Test-Health $animeTvHealth) {
    return
  }

  if ($script:animeTvProcess -and -not $script:animeTvProcess.HasExited) {
    Write-Host "AnimeTV is not healthy; restarting it..." -ForegroundColor DarkYellow
    Stop-Process -Id $script:animeTvProcess.Id -Force -ErrorAction SilentlyContinue
  }

  $script:animeTvProcess = Start-ManagedNode -Name "AnimeTV" -WorkingDirectory $AnimeTVPath -ScriptPath "animetv-local.js" -LogPrefix "animetv"
}

function Test-Docker {
  return [bool](Get-Command docker -ErrorAction SilentlyContinue)
}

function Ensure-Consumet {
  if ($NoConsumet) {
    return
  }
  if (Test-Health $consumetHealth) {
    return
  }
  if (-not (Test-Docker)) {
    Write-Host "Consumet is offline and Docker is not available. Install Docker or run: docker run -p 3000:3000 riimuru/consumet-api" -ForegroundColor DarkYellow
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
    Write-Host "Consumet could not start. Port 3000 may be busy or Docker may need to be opened." -ForegroundColor DarkYellow
  }
}

function Invoke-DailyRefresh {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:4173/api/refresh-daily?background=1" -TimeoutSec 5 | Out-Null
  } catch {
    Write-Host "Daily refresh could not start yet." -ForegroundColor DarkGray
  }
}

Write-Host "AnimeTV supervised launcher" -ForegroundColor Cyan
Write-Host "AnimeTV:  http://127.0.0.1:4173" -ForegroundColor Green
Write-Host "Anime1v:  http://127.0.0.1:3001" -ForegroundColor Green
Write-Host "Consumet: http://127.0.0.1:3000" -ForegroundColor Green
Write-Host "Logs:     $logDir" -ForegroundColor Gray
Write-Host "Checking every $CheckEverySeconds seconds. Keep this window open." -ForegroundColor Gray
Write-Host ""

while ($true) {
  Ensure-Consumet
  Start-Sleep -Seconds 1
  Ensure-Anime1v
  Start-Sleep -Seconds 2
  Ensure-AnimeTV

  $animeTvStatus = if (Test-Health $animeTvHealth) { "online" } else { "offline" }
  $anime1vStatus = if (Test-Health $anime1vHealth) { "online" } else { "offline" }
  $consumetStatus = if (Test-Health $consumetHealth) { "online" } else { "offline" }

  if ($animeTvStatus -eq "online" -and -not $openedBrowser) {
    Invoke-DailyRefresh
    if (-not $NoBrowser) {
      Start-Process "http://127.0.0.1:4173/?v=145"
    }
    $openedBrowser = $true
  }

  Write-Host ("{0}  AnimeTV: {1}  Anime1v: {2}  Consumet: {3}" -f (Get-Date -Format "HH:mm:ss"), $animeTvStatus, $anime1vStatus, $consumetStatus)
  Start-Sleep -Seconds $CheckEverySeconds
}
