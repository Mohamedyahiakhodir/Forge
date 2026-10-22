# Architecture (Phase 1)

```
android/  Kotlin shell
  MainActivity   WebView on https://appassets.androidplatform.net (WebViewAssetLoader):
                 /assets/web/*  -> bundled editor        /files/*  -> project files (media viewers)
  ForgeBridge    window.ForgeNative: JSON-returning file / search / kv / SAF / zip methods
  FileStore      path-sandboxed file ops under filesDir/projects, atomic writes, native regex search
  Archive        zip/unzip (zip-slip safe), SAF folder import/export
web/      TypeScript editor, bundled by esbuild (esm + code splitting, language packs lazy-loaded)
  native.ts      bridge wrapper + in-memory mock for desktop-browser development
  app.ts         tabs, session restore, autosave, file operations, panels
  editor.ts      CodeMirror 6 setup; compartments re-applied on tab switch
  tree.ts        virtualized lazy file tree
```

Design choices
- Real files in app-private storage (not OPFS) so large projects, media and later Git/packaging work with plain `java.io.File`.
- Settings, session, favorites and recents are small JSON files in `filesDir/kv` (survive WebView storage clears).
- No runtime CDN: fonts, languages, themes are bundled. (Project *templates* such as Bootstrap/React reference CDNs by design.)

Local web development: `cd web && npm ci && node build.mjs && python -m http.server -d dist 8765`, open `http://localhost:8765/index.html` (uses the in-memory mock FS).
