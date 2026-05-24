$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$androidDir = Join-Path $root "android"
$assetsDir = Join-Path $androidDir "app\src\main\assets"

New-Item -ItemType Directory -Force -Path $assetsDir | Out-Null
Copy-Item -Force `
  (Join-Path $root "index.html"), `
  (Join-Path $root "styles.css"), `
  (Join-Path $root "app.js"), `
  (Join-Path $root "manifest.webmanifest"), `
  (Join-Path $root "sources.json"), `
  (Join-Path $root "icon.svg") `
  -Destination $assetsDir

Push-Location $androidDir
try {
  if (Test-Path ".\gradlew.bat") {
    .\gradlew.bat assembleDebug
  } elseif (Get-Command gradle -ErrorAction SilentlyContinue) {
    gradle assembleDebug
  } else {
    throw "Gradle was not found. Install Android Studio, open the android folder once, then run this script again."
  }
} finally {
  Pop-Location
}

Write-Host "APK: $androidDir\app\build\outputs\apk\debug\app-debug.apk"
