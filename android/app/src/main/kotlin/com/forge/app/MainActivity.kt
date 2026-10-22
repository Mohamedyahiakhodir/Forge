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

/** CreateDocument variant whose MIME type is chosen per call, so Android does not append a wrong extension (.bin/.txt). */
class CreateDocWithType : androidx.activity.result.contract.ActivityResultContract<Pair<String, String>, Uri?>() {
    override fun createIntent(context: android.content.Context, input: Pair<String, String>) =
        Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(input.second).putExtra(Intent.EXTRA_TITLE, input.first)
    override fun parseResult(resultCode: Int, intent: Intent?): Uri? = if (resultCode == android.app.Activity.RESULT_OK) intent?.data else null
}

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

    // ----- signing keys + generic "save a file to the phone" / "import a file into a project" -----
    lateinit var vault: KeyVault
    lateinit var github: GitHub
    private var pendingSave: File? = null
    private var pendingImportProject: String? = null
    private var pendingKeyAlias: String? = null
    private var pendingKeyPassword: String? = null

    private val saveLauncher = registerForActivityResult(CreateDocWithType()) { uri ->
        val src = pendingSave
        pendingSave = null
        if (uri != null && src != null) runAsync("importError") {
            contentResolver.openOutputStream(uri)?.use { os -> src.inputStream().use { it.copyTo(os) } } ?: error("Cannot write file")
            emit("exportDone", JSONObject())
        }
    }

    private val importFileLauncher = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val project = pendingImportProject
        pendingImportProject = null
        if (uri != null && project != null) runAsync("importError") {
            val name = DocumentFile.fromSingleUri(this, uri)?.name ?: "file"
            val safe = name.replace(Regex("[\\\\/:*?\"<>|]"), "_")
            var target = File(store.resolve(project), safe)
            var n = 2
            while (target.exists()) target = File(store.resolve(project), "$n-$safe").also { n++ }
            contentResolver.openInputStream(uri)?.use { ins -> target.outputStream().use { ins.copyTo(it) } } ?: error("Cannot open file")
            emit("fileImported", JSONObject().put("path", "$project/${target.name}"))
        }
    }

    private val keyImportLauncher = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val alias = pendingKeyAlias
        val pw = pendingKeyPassword
        pendingKeyAlias = null; pendingKeyPassword = null
        if (uri != null && alias != null && pw != null) runAsync("keyError") {
            val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: error("Cannot open file")
            emit("keyImported", vault.importKey(alias, pw, bytes))
        }
    }

    fun launchSave(file: File, displayName: String, mime: String) { pendingSave = file; saveLauncher.launch(displayName to mime) }
    fun launchImportFile(project: String) { pendingImportProject = project; importFileLauncher.launch(arrayOf("*/*")) }
    fun launchKeyImport(alias: String, password: String) { pendingKeyAlias = alias; pendingKeyPassword = password; keyImportLauncher.launch(arrayOf("*/*")) }

    /** Signs on a background thread (large bundles take seconds) and reports through the 'signDone' / 'signError' events. */
    fun startSign(input: File, output: File, alias: String, password: String, outRel: String) {
        thread(name = "forge-sign") {
            try {
                val loaded = com.forge.app.sign.KeyTools.load(vault.p12(alias), password.toCharArray())
                com.forge.app.sign.AabSigner.sign(input, output, loaded.key, loaded.cert)
                emit("signDone", JSONObject().put("path", outRel).put("size", output.length()))
            } catch (e: Throwable) {
                output.delete()
                val wrongPw = e is java.io.IOException && (e.message ?: "").contains("password", ignoreCase = true)
                emit("signError", JSONObject().put("message", if (wrongPw) "WRONG_PASSWORD" else (e.message ?: e.javaClass.simpleName)))
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = FileStore(File(filesDir, "projects"))
        vault = KeyVault(File(filesDir, "keys"))
        github = GitHub(File(filesDir, "gh"), store) { name, payload -> emit(name, payload) }

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
        preview = Preview(
            this, store,
            onConsole = { level, msg, src -> emit("previewConsole", JSONObject().put("level", level).put("msg", msg).put("src", src)) },
            onClosed = { emit("previewClosed", JSONObject()); applySplit() },
            onOpenExternal = { entry -> openInBrowser(entry) },
            onFullscreen = { web.visibility = if (it) View.GONE else View.VISIBLE },
        )
        root = android.widget.LinearLayout(this)
        root.addView(web)
        root.addView(preview.view)
        applySplit()
        setContentView(root)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (preview.isOpen) { if (preview.isFullscreen) preview.exitFullscreen() else preview.close(); return }
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
        server.stop()
        preview.destroy()
        web.removeJavascriptInterface("ForgeNative")
        web.destroy()
        super.onDestroy()
    }

    // ----- live preview (separate WebView without the native bridge) -----
    lateinit var preview: Preview
    private lateinit var root: android.widget.LinearLayout
    private val server = LocalServer()

    /** Editor and preview share the screen: side by side on wide screens, stacked on phones. */
    private fun applySplit() {
        val wide = resources.configuration.screenWidthDp >= 760
        root.orientation = if (wide) android.widget.LinearLayout.HORIZONTAL else android.widget.LinearLayout.VERTICAL
        fun lp() = if (wide) android.widget.LinearLayout.LayoutParams(0, android.widget.LinearLayout.LayoutParams.MATCH_PARENT, 1f)
        else android.widget.LinearLayout.LayoutParams(android.widget.LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
        web.layoutParams = lp()
        preview.view.layoutParams = lp()
    }

    fun previewOpen(project: String, entry: String) { preview.open(project, entry); applySplit() }

    /** Opens the project in the phone's real browser through the loopback server (e.g. for Google sign-in). */
    private fun openInBrowser(entry: String) {
        try {
            server.start(store.resolve(preview.currentProject()))
            val url = "http://localhost:${LocalServer.DEFAULT_PORT}/" + entry.split('/').joinToString("/") { Uri.encode(it) }
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (e: java.net.BindException) {
            emit("previewConsole", JSONObject().put("level", "error").put("msg", "PORT_BUSY").put("src", ""))
        } catch (e: Exception) {
            emit("previewConsole", JSONObject().put("level", "error").put("msg", e.message ?: "Could not open the browser").put("src", ""))
        }
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
