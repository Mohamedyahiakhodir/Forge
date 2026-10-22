package com.forge.app

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.webkit.WebViewAssetLoader

/**
 * Live preview in its own WebView. It deliberately has NO JavaScript bridge: the previewed page is
 * untrusted user code and must not reach the editor's native file/key/token APIs. It also gets its own
 * origin so its storage is separate from the editor's.
 */
@SuppressLint("SetJavaScriptEnabled")
class Preview(
    private val ctx: Context,
    private val store: FileStore,
    private val onConsole: (level: String, message: String, source: String) -> Unit,
    private val onClosed: () -> Unit,
    private val onOpenExternal: (url: String) -> Unit,
    private val onFullscreen: (Boolean) -> Unit,
) {
    val view = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE; setBackgroundColor(Color.parseColor("#1E1F29")) }
    private val web: WebView
    private val frame = FrameLayout(ctx)
    private val sizeLabel: TextView
    private val erudaLabel: TextView
    private var project = ""
    private var entry = ""
    private var erudaOn = false
    private var fullscreen = false
    private var sizeIndex = 0
    private val sizes = listOf(0 to "100%", 360 to "360", 412 to "412", 768 to "768")

    val isOpen get() = view.visibility == View.VISIBLE

    /** Rebuilt on every open(): the site root is the project folder, so "/style.css" works like on a real site. */
    private var loader: WebViewAssetLoader? = null

    init {
        web = WebView(ctx).apply {
            setBackgroundColor(Color.WHITE)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.mediaPlaybackRequiresUserGesture = false
            // Same rules as the packaged app: https pages may not pull http sub-resources.
            settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(v: WebView, r: WebResourceRequest): WebResourceResponse? = loader?.shouldInterceptRequest(r.url)
                override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean {
                    if (r.url.host == HOST) return false
                    try { ctx.startActivity(Intent(Intent.ACTION_VIEW, r.url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) { }
                    return true
                }
                override fun onPageFinished(v: WebView, url: String) { if (erudaOn) injectEruda() }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                    val level = when (m.messageLevel()) { ConsoleMessage.MessageLevel.ERROR -> "error"; ConsoleMessage.MessageLevel.WARNING -> "warn"; else -> "info" }
                    onConsole(level, m.message(), "${m.sourceId().substringAfterLast('/')}:${m.lineNumber()}")
                    return true
                }
            }
        }
        frame.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER_HORIZONTAL))

        fun btn(label: String, action: () -> Unit) = TextView(ctx).apply {
            text = label; setTextColor(Color.WHITE); textSize = 14f; gravity = Gravity.CENTER
            setPadding(dp(14), dp(10), dp(14), dp(10)); setOnClickListener { action() }
        }
        sizeLabel = btn("📱 100%") { cycleSize() }
        erudaLabel = btn("🐞") { toggleEruda() }
        val bar = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL; setBackgroundColor(Color.parseColor("#282A36")); gravity = Gravity.CENTER_VERTICAL
            addView(btn("⟳") { reload() })
            addView(erudaLabel)
            addView(sizeLabel)
            addView(btn("🌐") { onOpenExternal(currentPath()) })
            addView(View(ctx), LinearLayout.LayoutParams(0, 1, 1f))
            addView(btn("⛶") { setFullscreen(!fullscreen) })
            addView(btn("✕") { close() })
        }
        view.addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        view.addView(frame, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    }

    private fun dp(v: Int) = (v * ctx.resources.displayMetrics.density).toInt()

    /** Entry page relative to the project root, e.g. "pages/about.html". */
    private fun currentPath() = entry

    fun currentProject() = project

    fun open(project: String, entryRel: String) {
        this.project = project
        this.entry = entryRel.trimStart('/')
        loader = WebViewAssetLoader.Builder()
            .setDomain(HOST)
            .addPathHandler("/__forge/", WebViewAssetLoader.AssetsPathHandler(ctx))
            .addPathHandler("/", WebViewAssetLoader.InternalStoragePathHandler(ctx, store.resolve(project)))
            .build()
        view.visibility = View.VISIBLE
        load()
    }

    private fun load() {
        val encoded = currentPath().split('/').joinToString("/") { Uri.encode(it) }
        web.loadUrl("https://$HOST/$encoded")
    }

    fun reload() { if (isOpen) web.reload() }

    fun close() {
        if (fullscreen) setFullscreen(false)
        view.visibility = View.GONE
        web.loadUrl("about:blank")
        onClosed()
    }

    private fun setFullscreen(on: Boolean) { fullscreen = on; onFullscreen(on) }
    fun exitFullscreen() { if (fullscreen) setFullscreen(false) }
    val isFullscreen get() = fullscreen

    private fun cycleSize() {
        sizeIndex = (sizeIndex + 1) % sizes.size
        val (w, label) = sizes[sizeIndex]
        sizeLabel.text = "📱 $label"
        val lp = web.layoutParams as FrameLayout.LayoutParams
        lp.width = if (w == 0) ViewGroup.LayoutParams.MATCH_PARENT else dp(w)
        web.layoutParams = lp
    }

    private fun toggleEruda() {
        erudaOn = !erudaOn
        erudaLabel.alpha = if (erudaOn) 1f else 0.6f
        if (erudaOn) injectEruda() else web.evaluateJavascript("(function(){ if (window.eruda) { eruda.destroy(); } })()", null)
    }

    private fun injectEruda() {
        web.evaluateJavascript(
            "(function(){ if (window.eruda && eruda._isInit) return; var s=document.createElement('script'); s.src='/__forge/web/eruda.js'; " +
                "s.onload=function(){ eruda.init(); }; document.head.appendChild(s); })()", null)
    }

    fun destroy() { web.destroy() }

    companion object { const val HOST = "forge-preview.local" }
}
