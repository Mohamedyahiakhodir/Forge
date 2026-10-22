package app.wrapper

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

    private val pickFile = registerForActivityResult(androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult()) { r ->
        fileCallback?.onReceiveValue(android.webkit.WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data))
        fileCallback = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val startUrl = "https://appassets.androidplatform.net/index.html"
        val localMode = true
        val host = Uri.parse(startUrl).host
        val ownHost = if (localMode) "appassets.androidplatform.net" else host
        val allowCamera = true
        val allowMic = true
        val allowLocation = true

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
            setBackgroundColor(android.graphics.Color.parseColor("#1e88e5"))
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

                override fun onGeolocationPermissionsShowPrompt(origin: String, callback: android.webkit.GeolocationPermissions.Callback) {
                    if (!allowLocation || Uri.parse(origin).host != ownHost) { callback.invoke(origin, false, false); return }
                    ensurePermissions(
                        listOf(android.Manifest.permission.ACCESS_FINE_LOCATION, android.Manifest.permission.ACCESS_COARSE_LOCATION),
                        requireAll = false,
                    ) { ok -> callback.invoke(origin, ok, false) }
                }
            }
        }
        // Native capabilities for the page (window.Forge). Locked to the app's own origin and the main frame.
        ForgeBridge.install(this, web, setOf(if (localMode) "https://appassets.androidplatform.net" else "https://" + host))
        setContentView(web)

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
