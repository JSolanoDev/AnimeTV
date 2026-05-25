$ErrorActionPreference = "Stop"

$aliasDomain = "animetv-umber.vercel.app"

Write-Host "Building AnimeTV static bundle..." -ForegroundColor Cyan
npm run vercel-build

Write-Host "Deploying static bundle to Vercel..." -ForegroundColor Cyan
$deployOutput = vercel deploy --prod --yes dist 2>&1
$deployOutput | ForEach-Object { Write-Host $_ }

$deploymentUrl = ($deployOutput | Select-String -Pattern "https://dist-[^\s]+" | Select-Object -First 1).Matches.Value
if (-not $deploymentUrl) {
  $deploymentUrl = ($deployOutput | Select-String -Pattern "https://[a-z0-9-]+-juankisantiago-5844s-projects\.vercel\.app" | Select-Object -First 1).Matches.Value
}

if (-not $deploymentUrl) {
  throw "Could not find the Vercel deployment URL in the deploy output."
}

Write-Host "Pointing $aliasDomain to $deploymentUrl..." -ForegroundColor Cyan
vercel alias set $deploymentUrl $aliasDomain

Write-Host "AnimeTV is live at https://$aliasDomain" -ForegroundColor Green
