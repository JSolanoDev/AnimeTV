# AnimeTV Android TV APK

This folder wraps AnimeTV in a native Android WebView shell so it can be installed on Android TV.

## Build

Install Android Studio, then open this `android` folder and run:

```powershell
.\gradlew assembleDebug
```

The APK will be created at:

```text
android\app\build\outputs\apk\debug\app-debug.apk
```

## Install on Android TV

Enable developer mode and USB/network debugging on the TV, then run:

```powershell
adb install -r android\app\build\outputs\apk\debug\app-debug.apk
```

If your video/catalog source runs on your computer, use the computer LAN IP in `sources.json`, not `127.0.0.1`.
