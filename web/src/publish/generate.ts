import { bridge } from '../native';
import { joinPath } from '../ui';
import { TARGET_SDK, type PublishConfig } from './config';
import { forgeBridgeKt, messagingServiceKt, needsBridge, notifOn } from './bridge-kt';

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, "\\'");
const ktEsc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$');

export const androidDir = (project: string) => `${project}/.forge/android`;

function manifest(c: PublishConfig): string {
  const orient = c.orientation === 'unspecified' ? '' : `\n            android:screenOrientation="${c.orientation}"`;
  const use = (n: string) => `    <uses-permission android:name="android.permission.${n}" />`;
  const feature = (n: string) => `    <uses-feature android:name="${n}" android:required="false" />`;
  // uses-feature required=false keeps the app installable on devices without that hardware (Play would otherwise filter them out).
  const perms = [
    c.internet ? use('INTERNET') : '',
    c.vibrate ? use('VIBRATE') : '',
    c.camera ? [use('CAMERA'), feature('android.hardware.camera'), feature('android.hardware.camera.autofocus')].join('\n') : '',
    c.microphone ? [use('RECORD_AUDIO'), use('MODIFY_AUDIO_SETTINGS'), feature('android.hardware.microphone')].join('\n') : '',
    c.location ? [use('ACCESS_FINE_LOCATION'), use('ACCESS_COARSE_LOCATION'), feature('android.hardware.location'), feature('android.hardware.location.gps')].join('\n') : '',
    notifOn(c) ? use('POST_NOTIFICATIONS') : '',
  ].filter(Boolean).join('\n');
  const launchMode = c.oauth ? '\n            android:launchMode="singleTask"' : '';
  const oauthFilter = c.oauth ? `
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="${c.oauthScheme.trim()}" />
            </intent-filter>` : '';
  const pushService = c.push ? `
        <service
            android:name="app.wrapper.ForgeMessagingService"
            android:exported="false">
            <intent-filter>
                <action android:name="com.google.firebase.MESSAGING_EVENT" />
            </intent-filter>
        </service>
        <meta-data android:name="com.google.firebase.messaging.default_notification_channel_id" android:value="default" />
        <meta-data android:name="com.google.firebase.messaging.default_notification_icon" android:resource="@drawable/ic_stat_notify" />
` : '';
  return `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

${perms}

    <application
        android:allowBackup="false"
        android:icon="@mipmap/ic_launcher"
        android:roundIcon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:supportsRtl="true"
        android:theme="@style/AppTheme"
        android:usesCleartextTraffic="false">

        <activity
            android:name="app.wrapper.MainActivity"
            android:configChanges="orientation|screenSize|keyboardHidden|keyboard|smallestScreenSize|screenLayout|uiMode|density|layoutDirection"
            android:exported="true"${orient}${launchMode}
            android:windowSoftInputMode="adjustResize">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>${oauthFilter}
        </activity>
${pushService}
    </application>
</manifest>
`;
}

function mainActivity(c: PublishConfig): string {
  const isLocal = c.source === 'local';
  const start = isLocal ? `https://appassets.androidplatform.net/${c.entryFile.split('/').map(encodeURIComponent).join('/')}` : c.url.trim();
  return `package app.wrapper

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader

class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null
${needsBridge(c) ? `
    private var pendingPermissions: ((Map<String, Boolean>) -> Unit)? = null
    private val permissionLauncher = registerForActivityResult(androidx.activity.result.contract.ActivityResultContracts.RequestMultiplePermissions()) { result ->
        val cb = pendingPermissions
        pendingPermissions = null
        cb?.invoke(result)
    }

    /** Asks for runtime permissions (one request at a time) and reports whether the needed ones are granted. */
    fun ensurePermissions(perms: List<String>, requireAll: Boolean = true, done: (Boolean) -> Unit) {
        fun has(p: String) = androidx.core.content.ContextCompat.checkSelfPermission(this, p) == android.content.pm.PackageManager.PERMISSION_GRANTED
        fun granted() = if (requireAll) perms.all { has(it) } else perms.any { has(it) }
        if (perms.isEmpty() || granted()) { done(true); return }
        pendingPermissions?.invoke(emptyMap())
        pendingPermissions = { done(granted()) }
        permissionLauncher.launch(perms.filter { !has(it) }.toTypedArray())
    }
` : ''}
    private val pickFile = registerForActivityResult(androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult()) { r ->
        fileCallback?.onReceiveValue(android.webkit.WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data))
        fileCallback = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val startUrl = "${ktEsc(start)}"
        val localMode = ${isLocal}
        val host = Uri.parse(startUrl).host
        val ownHost = if (localMode) "appassets.androidplatform.net" else host
${c.camera || c.microphone ? `        val allowCamera = ${c.camera}
        val allowMic = ${c.microphone}
` : ''}${c.location ? `        val allowLocation = true
` : ''}
        // The site root is the packaged www folder, so "/style.css" resolves exactly like in Forge's preview.
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/") { path ->
                try {
                    var p = path.trimStart('/')
                    if (p.isEmpty() || p.endsWith("/")) p += "index.html"
                    val asset = if (p == "offline.html") "offline.html" else "www/" + p
                    val ext = p.substringAfterLast('.', "").lowercase()
                    val mime = when (ext) {
                        "js", "mjs" -> "text/javascript"
                        "html", "htm" -> "text/html"
                        "css" -> "text/css"
                        "json", "webmanifest" -> "application/json"
                        "svg" -> "image/svg+xml"
                        "wasm" -> "application/wasm"
                        else -> android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
                    }
                    val text = mime.startsWith("text/") || mime.endsWith("json")
                    WebResourceResponse(mime, if (text) "utf-8" else null, assets.open(asset))
                } catch (e: java.io.IOException) {
                    WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, java.io.ByteArrayInputStream(ByteArray(0)))
                }
            }
            .build()

        web = WebView(this).apply {
            setBackgroundColor(android.graphics.Color.parseColor("${c.themeColor}"))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.mediaPlaybackRequiresUserGesture = false
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    if (localMode) loader.shouldInterceptRequest(request.url) else null

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val u = request.url
                    val own = u.host == "appassets.androidplatform.net" || (host != null && u.host == host)
                    if (own) return false
                    try { startActivity(Intent(Intent.ACTION_VIEW, u)) } catch (_: Exception) { }
                    return true
                }

                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                    if (request.isForMainFrame) view.loadUrl("https://appassets.androidplatform.net/offline.html")
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(view: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                    fileCallback?.onReceiveValue(null)
                    fileCallback = cb
                    return try { pickFile.launch(params.createIntent()); true } catch (_: Exception) { fileCallback = null; false }
                }
${c.camera || c.microphone ? `
                // getUserMedia: only the app's own origin, only the capabilities enabled in Forge, after the Android runtime prompt.
                override fun onPermissionRequest(request: android.webkit.PermissionRequest) {
                    runOnUiThread {
                        if (request.origin.host != ownHost) { request.deny(); return@runOnUiThread }
                        val needed = ArrayList<String>()
                        val grant = ArrayList<String>()
                        for (r in request.resources) {
                            if (r == android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE && allowCamera) { needed.add(android.Manifest.permission.CAMERA); grant.add(r) }
                            if (r == android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE && allowMic) { needed.add(android.Manifest.permission.RECORD_AUDIO); grant.add(r) }
                        }
                        if (grant.isEmpty()) { request.deny(); return@runOnUiThread }
                        ensurePermissions(needed) { ok -> if (ok) request.grant(grant.toTypedArray()) else request.deny() }
                    }
                }
` : ''}${c.location ? `
                override fun onGeolocationPermissionsShowPrompt(origin: String, callback: android.webkit.GeolocationPermissions.Callback) {
                    if (!allowLocation || Uri.parse(origin).host != ownHost) { callback.invoke(origin, false, false); return }
                    ensurePermissions(
                        listOf(android.Manifest.permission.ACCESS_FINE_LOCATION, android.Manifest.permission.ACCESS_COARSE_LOCATION),
                        requireAll = false,
                    ) { ok -> callback.invoke(origin, ok, false) }
                }
` : ''}            }
        }
${needsBridge(c) ? `        // Native capabilities for the page (window.Forge). Locked to the app's own origin and the main frame.
        ForgeBridge.install(this, web, setOf(if (localMode) "https://appassets.androidplatform.net" else "https://" + host))
` : ''}${notifOn(c) ? `        ForgeBridge.ensureChannel(this)
` : ''}        setContentView(web)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
            }
        })

        if (savedInstanceState == null) web.loadUrl(startUrl) else web.restoreState(savedInstanceState)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

${needsBridge(c) ? `    override fun onStart() { super.onStart(); ForgeBridge.foreground = true }
    override fun onStop() { ForgeBridge.foreground = false; super.onStop() }
` : ''}${c.oauth ? `
    // The OAuth redirect (custom scheme) arrives here because the activity is singleTask.
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); ForgeBridge.onNewIntent(intent) }
    override fun onPause() { ForgeBridge.onPause(); super.onPause() }
    override fun onResume() { super.onResume(); ForgeBridge.onResume(this) }
` : ''}
    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }
}
`;
}

const offlinePage = (name: string, color: string) => `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${xmlEsc(name)}</title>
<style>body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:sans-serif;background:${color};color:#fff;text-align:center;padding:24px}
button{margin-top:20px;padding:12px 28px;border:0;border-radius:10px;font-size:16px}</style></head>
<body><h2>No connection / لا يوجد اتصال</h2><p>Check your internet and try again.<br>تأكد من الإنترنت وحاول مرة أخرى.</p>
<button onclick="history.length>1?history.back():location.reload()">Retry / إعادة المحاولة</button></body></html>
`;

function iconSizes(): { dir: string; legacy: number; fg: number }[] {
  return [
    { dir: 'mdpi', legacy: 48, fg: 108 }, { dir: 'hdpi', legacy: 72, fg: 162 }, { dir: 'xhdpi', legacy: 96, fg: 216 },
    { dir: 'xxhdpi', legacy: 144, fg: 324 }, { dir: 'xxxhdpi', legacy: 192, fg: 432 },
  ];
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('icon load failed')); i.src = url; });
}

function drawPng(img: HTMLImageElement, size: number, scale: number, bg?: string): string {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!;
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, size, size); }
  const d = size * scale;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (size - d) / 2, (size - d) / 2, d, d);
  return cv.toDataURL('image/png').split(',')[1];
}

async function writeIcons(base: string, project: string, c: PublishConfig): Promise<void> {
  const img = await loadImage(bridge.assetUrl(c.iconPath));
  for (const s of iconSizes()) {
    const dir = `${base}/app/src/main/res/mipmap-${s.dir}`;
    bridge.writeB64(`${dir}/ic_launcher.png`, drawPng(img, s.legacy, 1));
    bridge.writeB64(`${dir}/ic_launcher_foreground.png`, drawPng(img, s.fg, 72 / 108));
  }
  bridge.writeText(`${base}/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml`,
    `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/icon_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`);
  bridge.writeB64(`${base}/store/icon-512.png`, drawPng(img, 512, 1));
  void project;
}

export interface GenerateResult { dir: string; files: number }

export async function generateProject(project: string, c: PublishConfig): Promise<GenerateResult> {
  const base = androidDir(project);
  if (bridge.stat(base).exists) bridge.remove(base);
  let n = 0;
  const put = (rel: string, text: string) => { bridge.writeText(`${base}/${rel}`, text); n++; };

  put('settings.gradle.kts', `pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "WebApp"
include(":app")
`);
  const gsPath = `${project}/.forge/google-services.json`;
  const hasGs = bridge.stat(gsPath).exists;
  put('build.gradle.kts', `plugins {
    id("com.android.application") version "8.9.1" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false${hasGs ? '\n    id("com.google.gms.google-services") version "4.4.2" apply false' : ''}
}
`);
  put('gradle.properties', 'org.gradle.jvmargs=-Xmx2g -Dfile.encoding=UTF-8\nandroid.useAndroidX=true\nandroid.nonTransitiveRClass=true\n');
  put('app/build.gradle.kts', `plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")${hasGs ? '\n    id("com.google.gms.google-services")' : ''}
}

android {
    namespace = "app.wrapper"
    compileSdk = ${TARGET_SDK}

    defaultConfig {
        applicationId = "${c.packageId.trim()}"
        minSdk = 24
        targetSdk = ${TARGET_SDK}
        versionCode = ${c.versionCode}
        versionName = "${ktEsc(c.versionName.trim())}"
    }

    // Release is built unsigned in CI; Forge signs the bundle with your upload key on your phone.
    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")${c.googleSignIn ? `
    implementation("androidx.credentials:credentials:1.3.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.3.0")
    implementation("com.google.android.libraries.identity.googleid:googleid:1.1.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")` : ''}${c.oauth ? `
    implementation("androidx.browser:browser:1.8.0")` : ''}${c.push ? `
    implementation("com.google.firebase:firebase-messaging:24.1.0")` : ''}
}
`);
  put('app/src/main/AndroidManifest.xml', manifest(c));
  if (c.googleSignIn && !c.googleClientId.trim()) throw new Error('Google sign-in needs a Web Client ID');
  put('app/src/main/kotlin/app/wrapper/MainActivity.kt', mainActivity(c));
  if (needsBridge(c)) put('app/src/main/kotlin/app/wrapper/ForgeBridge.kt', forgeBridgeKt(c));
  if (c.push) {
    if (!hasGs) throw new Error('Push notifications need google-services.json');
    put('app/src/main/kotlin/app/wrapper/ForgeMessagingService.kt', messagingServiceKt());
  }
  if (notifOn(c)) {
    put('app/src/main/res/drawable/ic_stat_notify.xml', `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:fillColor="#FFFFFFFF"
        android:pathData="M12,22c1.1,0 2,-0.9 2,-2h-4c0,1.1 0.9,2 2,2zM18,16v-5c0,-3.07 -1.63,-5.64 -4.5,-6.32V4c0,-0.83 -0.67,-1.5 -1.5,-1.5s-1.5,0.67 -1.5,1.5v0.68C7.63,5.36 6,7.92 6,11v5l-2,2v1h16v-1l-2,-2z" />
</vector>
`);
  }
  put('app/src/main/res/values/strings.xml', `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <string name="app_name">${xmlEsc(c.appName.trim())}</string>\n</resources>\n`);
  put('app/src/main/res/values/colors.xml', `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="theme_color">${c.themeColor}</color>\n    <color name="icon_background">${c.themeColor}</color>\n</resources>\n`);
  put('app/src/main/res/values/themes.xml', `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="AppTheme" parent="Theme.AppCompat.DayNight.NoActionBar">
        <item name="android:windowBackground">@color/theme_color</item>
        <item name="android:statusBarColor">@color/theme_color</item>
        <item name="android:navigationBarColor">@color/theme_color</item>
    </style>
</resources>
`);
  put('app/src/main/assets/offline.html', offlinePage(c.appName, c.themeColor));
  if (c.googleClientId.trim()) {
    put('app/src/main/res/values/forge_config.xml', `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <string name="default_web_client_id" translatable="false">${xmlEsc(c.googleClientId.trim())}</string>\n</resources>\n`);
  }
  if (hasGs) {
    bridge.copy(gsPath, `${base}/app/google-services.json`);
    n++;
  }

  put('.github/workflows/build-aab.yml', `name: Build AAB

on:
  push:
    branches: ['**']
  workflow_dispatch:

jobs:
  bundle:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: 17
      - uses: gradle/actions/setup-gradle@v4
        with:
          gradle-version: 8.11.1
      - name: Build unsigned release bundle
        run: gradle bundleRelease --stacktrace --no-daemon
      - uses: actions/upload-artifact@v4
        with:
          name: unsigned-aab
          path: app/build/outputs/bundle/release/app-release.aab
`);
  put('.gitignore', '.gradle/\nbuild/\napp/build/\nlocal.properties\n*.jks\n*.keystore\n');

  await writeIcons(base, project, c);
  n += iconSizes().length * 2 + 2;

  if (c.source === 'local') {
    const www = `${base}/app/src/main/assets/www`;
    bridge.mkdir(www);
    for (const e of bridge.list(project)) {
      // Credentials must never end up inside the publicly readable site files.
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'google-services.json') continue;
      bridge.copy(joinPath(project, e.name), joinPath(www, e.name));
      n++;
    }
  }
  return { dir: base, files: n };
}
