# Android Mobile and TV

The Android project builds two variants from the same responsive ZenkaiTV application:

| Variant | Intended devices | Output |
| --- | --- | --- |
| `mobile` | Phones and tablets | `android/app/build/outputs/apk/mobile/debug/app-mobile-debug.apk` |
| `tv` | Android TV and Google TV | `android/app/build/outputs/apk/tv/debug/app-tv-debug.apk` |

Both variants currently load `https://zenkaitv.com`, configured by `SITE_URL` in `android/app/src/main/java/com/animetv/app/MainActivity.java`.

## Build both APKs

Requirements: Android SDK, ADB, and a compatible JDK.

```powershell
npm run android:build
```

To build a single target:

```powershell
cd android
.\gradlew.bat assembleMobileDebug
.\gradlew.bat assembleTvDebug
```

## Install on a phone or tablet

Enable USB debugging, connect the device, then run:

```powershell
npm run android:install:mobile
```

## Install on Android TV or Google TV

Enable developer options and network debugging on the TV, then run:

```powershell
adb connect YOUR_TV_IP:5555
npm run android:install:tv
```

The generic `npm run android:install` command also installs the TV variant.

## Device verification

After installation, check:

- D-pad focus and back navigation on TV
- touch scrolling and portrait layout on phones and tablets
- title details, seasons, and episode lists
- fullscreen entry and exit
- playback source fallback behavior
- Google Cast discovery, playback, and stop-casting controls
- favorites, continue watching, and resume positions after relaunch

Physical Cast receivers still require device testing; emulator and browser tests cannot confirm receiver codec support or network reachability.
