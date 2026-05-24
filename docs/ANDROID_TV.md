# Android TV

Build the debug APK:

```powershell
cd android
.\gradlew.bat assembleDebug
```

Install with ADB:

```powershell
adb connect YOUR_TV_IP:5555
adb install -r app\build\outputs\apk\debug\app-debug.apk
```

For hosted mode, keep AnimeTV running on your PC and open `http://YOUR-PC-IP:4173` on the TV.
