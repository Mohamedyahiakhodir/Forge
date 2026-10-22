import { bridge } from '../native';
import { joinPath } from '../ui';
import { TARGET_SDK, type PublishConfig } from './config';

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, "\\'");
const ktEsc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$');

export const androidDir = (project: string) => `${project}/.forge/android`;

function manifest(c: PublishConfig): string {
  const orient = c.orientation === 'unspecified' ? '' : `\n            android:screenOrientation="${c.orientation}"`;
  const perms = [c.internet ? '    <uses-permission android:name="android.permission.INTERNET" />' : '', c.vibrate ? '    <uses-permission android:name="android.permission.VIBRATE" />' : '']
    .filter(Boolean).join('\n');
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
            android:exported="true"${orient}
            android:windowSoftInputMode="adjustResize">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
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
            }
        }
${c.googleSignIn ? `        // Native capabilities for the page (window.Forge). Locked to the app's own origin and the main frame.
        ForgeBridge.install(this, web, setOf(if (localMode) "https://appassets.androidplatform.net" else "https://" + host))
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

/**
 * Page-facing API. The shim is injected before any page script runs, only on the allowed origin;
 * messages from other origins or from iframes are never delivered to native code.
 */
function forgeBridgeKt(): string {
  return `package app.wrapper

import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import androidx.credentials.ClearCredentialStateRequest
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import androidx.lifecycle.lifecycleScope
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import kotlinx.coroutines.launch
import org.json.JSONObject

object ForgeBridge {
    private const val SHIM = """
(function () {
  if (window.Forge) return;
  var pending = {};
  var seq = 0;
  __ForgeNative.onmessage = function (e) {
    var m = JSON.parse(e.data);
    var p = pending[m.id];
    if (!p) return;
    delete pending[m.id];
    if (m.ok) p.resolve(m.data);
    else { var err = new Error(m.error || 'Forge error'); err.code = m.code; p.reject(err); }
  };
  function call(op, args) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending[id] = { resolve: resolve, reject: reject };
      __ForgeNative.postMessage(JSON.stringify({ id: id, op: op, args: args || {} }));
    });
  }
  window.Forge = {
    version: 1,
    googleSignIn: function (options) { return call('googleSignIn', options); },
    googleSignOut: function () { return call('googleSignOut'); }
  };
})();
"""

    fun install(activity: AppCompatActivity, web: WebView, origins: Set<String>) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
        WebViewCompat.addWebMessageListener(web, "__ForgeNative", origins) { _, message, _, isMainFrame, reply ->
            if (!isMainFrame) return@addWebMessageListener
            handle(activity, message.data ?: "", reply)
        }
        WebViewCompat.addDocumentStartJavaScript(web, SHIM, origins)
    }

    private fun handle(activity: AppCompatActivity, raw: String, reply: JavaScriptReplyProxy) {
        val msg = try { JSONObject(raw) } catch (e: Exception) { return }
        val id = msg.optInt("id")
        val args = msg.optJSONObject("args") ?: JSONObject()
        fun send(o: JSONObject) { activity.runOnUiThread { reply.postMessage(o.put("id", id).toString()) } }
        fun ok(data: JSONObject) = send(JSONObject().put("ok", true).put("data", data))
        fun fail(code: String, message: String) = send(JSONObject().put("ok", false).put("code", code).put("error", message))
        when (msg.optString("op")) {
            "googleSignIn" -> googleSignIn(activity, args, ::ok, ::fail)
            "googleSignOut" -> googleSignOut(activity, ::ok, ::fail)
            else -> fail("UNSUPPORTED", "Unknown operation")
        }
    }

    private fun googleSignIn(activity: AppCompatActivity, args: JSONObject, ok: (JSONObject) -> Unit, fail: (String, String) -> Unit) {
        val builder = GetSignInWithGoogleOption.Builder(activity.getString(R.string.default_web_client_id))
        val nonce = args.optString("nonce")
        if (nonce.isNotEmpty()) builder.setNonce(nonce)
        val request = GetCredentialRequest.Builder().addCredentialOption(builder.build()).build()
        activity.lifecycleScope.launch {
            try {
                val cred = CredentialManager.create(activity).getCredential(activity, request).credential
                if (cred is CustomCredential && cred.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                    val g = GoogleIdTokenCredential.createFrom(cred.data)
                    ok(JSONObject()
                        .put("idToken", g.idToken)
                        .put("email", g.id)
                        .put("name", g.displayName ?: "")
                        .put("givenName", g.givenName ?: "")
                        .put("familyName", g.familyName ?: "")
                        .put("photo", g.profilePictureUri?.toString() ?: ""))
                } else fail("UNSUPPORTED_CREDENTIAL", "Unexpected credential type")
            } catch (e: GetCredentialCancellationException) {
                fail("CANCELLED", "The user closed the sign-in sheet")
            } catch (e: NoCredentialException) {
                fail("NO_CREDENTIAL", "No Google account is available on this device")
            } catch (e: GetCredentialException) {
                fail("FAILED", e.message ?: e.type)
            } catch (e: Exception) {
                fail("FAILED", e.message ?: "Sign-in failed")
            }
        }
    }

    private fun googleSignOut(activity: AppCompatActivity, ok: (JSONObject) -> Unit, fail: (String, String) -> Unit) {
        activity.lifecycleScope.launch {
            try {
                CredentialManager.create(activity).clearCredentialState(ClearCredentialStateRequest())
                ok(JSONObject())
            } catch (e: Exception) { fail("FAILED", e.message ?: "Sign-out failed") }
        }
    }
}
`;
}

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
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")` : ''}
}
`);
  put('app/src/main/AndroidManifest.xml', manifest(c));
  if (c.googleSignIn && !c.googleClientId.trim()) throw new Error('Google sign-in needs a Web Client ID');
  put('app/src/main/kotlin/app/wrapper/MainActivity.kt', mainActivity(c));
  if (c.googleSignIn) put('app/src/main/kotlin/app/wrapper/ForgeBridge.kt', forgeBridgeKt());
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
