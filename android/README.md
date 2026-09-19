# ZenkaiTV Android APKs

This folder wraps ZenkaiTV in a native Android WebView shell. The mobile and TV
variants share the same player and hosted backend, but have separate launcher
entries and screen orientations. The TV variant retains the existing package ID;
the mobile variant can be installed alongside it.

## Build

Install Android Studio, then open this `android` folder and run:

```powershell
.\gradlew assembleMobileDebug assembleTvDebug
```

The APK will be created at:

```text
android\app\build\outputs\apk\mobile\debug\app-mobile-debug.apk
android\app\build\outputs\apk\tv\debug\app-tv-debug.apk
```

## Install

Enable developer mode and USB/network debugging on the device, then run:

```powershell
adb install -r android\app\build\outputs\apk\mobile\debug\app-mobile-debug.apk
adb install -r android\app\build\outputs\apk\tv\debug\app-tv-debug.apk
```

Both variants load `https://zenkaitv.com` for catalog and playback. Bundled
assets alone cannot provide the server-backed sources; deploy site changes to
production before expecting them to appear in the APKs. If a source runs on a
computer, use its LAN IP in `sources.json`, not `127.0.0.1`.
