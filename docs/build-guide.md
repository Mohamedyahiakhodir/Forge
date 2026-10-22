# Build guide (phone only)

1. Create an empty repository on GitHub (private is fine) and push this project to its `main` branch.
2. Open the repository's **Actions** tab. The *Build APK* workflow starts on every push; wait for the green check (first run ~5–8 min).
3. Download the APK:
   - **Releases** tab → newest `Forge build N` → tap `forge-debug-N.apk`, or
   - the run page → *Artifacts* → `forge-debug-apk` (a ZIP containing the APK).
4. Open the APK on the phone. If Android asks, allow "Install unknown apps" for the app you opened it from (Chrome / Files).
5. If Play Protect warns about an unrecognised developer, choose *Install anyway* (it is a debug build signed with a debug key).

Each push produces a new APK. All builds use the same committed debug key (`android/app/forge-debug.jks`), so a newer APK installs over the older one and keeps your projects.
This key is public on purpose: it is for debug builds only, never for a Play Store release.
