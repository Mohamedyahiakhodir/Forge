package com.forge.app

import android.content.Intent
import android.webkit.JavascriptInterface
import android.widget.Toast
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File

/**
 * Exposed to the web layer as `window.ForgeNative`. Every method returns a JSON string:
 * {"ok":true,"data":...} or {"ok":false,"error":"..."}.
 */
class ForgeBridge(private val activity: MainActivity, private val store: FileStore) {
    private val kvDir = File(activity.filesDir, "kv").apply { mkdirs() }

    private inline fun reply(block: () -> Any?): String = try {
        val r = block()
        JSONObject().put("ok", true).put("data", if (r == null || r is Unit) JSONObject.NULL else r).toString()
    } catch (e: Throwable) {
        JSONObject().put("ok", false).put("error", e.message ?: e.javaClass.simpleName).toString()
    }

    @JavascriptInterface fun list(path: String) = reply { store.list(path) }
    @JavascriptInterface fun stat(path: String) = reply { store.stat(path) }
    @JavascriptInterface fun readText(path: String) = reply { store.readText(path) }
    @JavascriptInterface fun readTextRange(path: String, maxBytes: Int) = reply { store.readTextRange(path, maxBytes) }
    @JavascriptInterface fun readB64(path: String) = reply { store.readB64(path) }
    @JavascriptInterface fun writeText(path: String, text: String) = reply { store.writeText(path, text) }
    @JavascriptInterface fun writeB64(path: String, b64: String) = reply { store.writeB64(path, b64) }
    @JavascriptInterface fun mkdir(path: String) = reply { store.mkdir(path) }
    @JavascriptInterface fun remove(path: String) = reply { store.remove(path) }
    @JavascriptInterface fun rename(from: String, to: String) = reply { store.rename(from, to) }
    @JavascriptInterface fun copy(from: String, to: String) = reply { store.copy(from, to) }
    @JavascriptInterface fun isBinary(path: String) = reply { store.isBinary(path) }

    @JavascriptInterface
    fun search(dir: String, pattern: String, flags: String, include: String, exclude: String, max: Int) =
        reply { store.search(dir, pattern, flags, include, exclude, max) }

    @JavascriptInterface
    fun kvGet(key: String) = reply {
        val f = kvFile(key)
        if (f.isFile) f.readText(Charsets.UTF_8) else null
    }

    @JavascriptInterface
    fun kvSet(key: String, value: String) = reply {
        val f = kvFile(key)
        val tmp = File(kvDir, "${f.name}.tmp")
        tmp.writeText(value, Charsets.UTF_8)
        if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
    }

    private fun kvFile(key: String): File {
        require(key.matches(Regex("[A-Za-z0-9_-]{1,64}"))) { "Invalid key" }
        return File(kvDir, "$key.json")
    }

    @JavascriptInterface fun importFolder() = reply { activity.runOnUiThread { activity.launchImportFolder() } }
    @JavascriptInterface fun exportFolder(project: String) = reply { activity.runOnUiThread { activity.launchExportFolder(project) } }
    @JavascriptInterface fun importZip() = reply { activity.runOnUiThread { activity.launchImportZip() } }
    @JavascriptInterface fun exportZip(project: String) = reply { activity.runOnUiThread { activity.launchExportZip(project) } }

    @JavascriptInterface
    fun openExternal(path: String) = reply {
        val f = store.resolve(path)
        require(f.isFile) { "Not a file" }
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.files", f)
        val mime = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(f.extension.lowercase()) ?: "*/*"
        val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        activity.runOnUiThread {
            try { activity.startActivity(Intent.createChooser(intent, f.name)) }
            catch (e: Exception) { Toast.makeText(activity, e.message ?: "No app can open this file", Toast.LENGTH_LONG).show() }
        }
    }

    @JavascriptInterface
    fun toast(msg: String) = reply { activity.runOnUiThread { Toast.makeText(activity, msg, Toast.LENGTH_SHORT).show() } }

    @JavascriptInterface fun exit() = reply { activity.runOnUiThread { activity.finish() } }
}
