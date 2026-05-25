param(
  [string]$Message = "Update AnimeTV files"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

git status --short
if (-not (git status --short)) {
  Write-Host "No local changes to push." -ForegroundColor Green
  exit 0
}

git add .
git commit -m $Message
git push origin main
Write-Host "AnimeTV files pushed to GitHub." -ForegroundColor Green
