package com.forge.app

import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.documentfile.provider.DocumentFile
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.io.File
import kotlin.concurrent.thread

class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private lateinit var store: FileStore
    private var pendingExportProject: String? = null

    private val importFolderLauncher = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        if (uri != null) runAsync("importError") {
            val name = DocumentFile.fromTreeUri(this, uri)?.name ?: "project"
            val project = Archive.uniqueProjectName(store.root, name)
            try {
                Archive.copyTreeFromSaf(this, uri, File(store.root, project))
            } catch (e: Throwable) {
                File(store.root, project).deleteRecursively()
                throw e
            }
            emit("importDone", JSONObject().put("project", project))
        }
    }

    private val exportFolderLauncher = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        val project = pendingExportProject
        pendingExportProject = null
        if (uri != null && project != null) runAsync("importError") {
            val parent = DocumentFile.fromTreeUri(this, uri) ?: error("Cannot open folder")
            Archive.copyTreeToSaf(this, store.resolve(project), parent)
            emit("exportDone", JSONObject())
        }
    }

    private val importZipLauncher = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) runAsync("importError") {
            val display = DocumentFile.fromSingleUri(this, uri)?.name?.removeSuffix(".zip")?.removeSuffix(".ZIP") ?: "project"
            val project = Archive.uniqueProjectName(store.root, display)
            try {
                contentResolver.openInputStream(uri)?.use { Archive.unzip(it, File(store.root, project)) } ?: error("Cannot open file")
            } catch (e: Throwable) {
                File(store.root, project).deleteRecursively()
                throw e
            }
            emit("importDone", JSONObject().put("project", project))
        }
    }

    private val exportZipLauncher = registerForActivityResult(ActivityResultContracts.CreateDocument("application/zip")) { uri ->
        val project = pendingExportProject
        pendingExportProject = null
        if (uri != null && project != null) runAsync("importError") {
            contentResolver.openOutputStream(uri)?.use { Archive.zipProject(store.resolve(project), it) } ?: error("Cannot write file")
            emit("exportDone", JSONObject())
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = FileStore(File(filesDir, "projects"))

        val loader = WebViewAssetLoader.Builder()
            .setDomain(ORIGIN_HOST)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/files/", WebViewAssetLoader.InternalStoragePathHandler(this, store.root))
            .build()

        web = WebView(this).apply {
            setBackgroundColor(0xFF1E1F29.toInt())
            overScrollMode = View.OVER_SCROLL_NEVER
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                allowFileAccess = false
                allowContentAccess = false
                mediaPlaybackRequiresUserGesture = false
                cacheMode = WebSettings.LOAD_DEFAULT
                textZoom = 100
            }
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    loader.shouldInterceptRequest(request.url)

                // Only our own origin may load inside the WebView that holds the native bridge.
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (request.url.host == ORIGIN_HOST) return false
                    try { startActivity(Intent(Intent.ACTION_VIEW, request.url)) } catch (_: Exception) { /* no browser */ }
                    return true
                }
            }
            addJavascriptInterface(ForgeBridge(this@MainActivity, store), "ForgeNative")
        }
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) WebView.setWebContentsDebuggingEnabled(true)
        setContentView(web)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("(window.__forgeBack && window.__forgeBack()) === true") { handled ->
                    if (handled != "true") { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
                }
            }
        })

        if (savedInstanceState == null) web.loadUrl("https://$ORIGIN_HOST/assets/web/index.html") else web.restoreState(savedInstanceState)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onPause() {
        super.onPause()
        // Let the web layer flush autosave + session before the process can be killed.
        web.evaluateJavascript("document.dispatchEvent(new Event('visibilitychange'))", null)
    }

    override fun onDestroy() {
        web.removeJavascriptInterface("ForgeNative")
        web.destroy()
        super.onDestroy()
    }

    // ----- launched from ForgeBridge on the UI thread -----
    fun launchImportFolder() = importFolderLauncher.launch(null)
    fun launchExportFolder(project: String) { pendingExportProject = project; exportFolderLauncher.launch(null) }
    fun launchImportZip() = importZipLauncher.launch(arrayOf("application/zip", "application/x-zip-compressed", "application/octet-stream"))
    fun launchExportZip(project: String) { pendingExportProject = project; exportZipLauncher.launch("$project.zip") }

    private fun runAsync(errorEvent: String, block: () -> Unit) {
        thread(name = "forge-io") {
            try { block() } catch (e: Throwable) { emit(errorEvent, JSONObject().put("message", e.message ?: e.javaClass.simpleName)) }
        }
    }

    private fun emit(name: String, payload: JSONObject) {
        val js = "window.__forgeEvent && window.__forgeEvent(${JSONObject.quote(name)}, ${JSONObject.quote(payload.toString())})"
        runOnUiThread { if (::web.isInitialized) web.evaluateJavascript(js, null) }
    }

    companion object { const val ORIGIN_HOST = "appassets.androidplatform.net" }
}
