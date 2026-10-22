package com.forge.app

import android.webkit.MimeTypeMap
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream

object Mime {
    fun of(f: File): String {
        val ext = f.extension.lowercase()
        return when (ext) {
            "js", "mjs" -> "text/javascript"
            "html", "htm" -> "text/html"
            "css" -> "text/css"
            "json", "webmanifest" -> "application/json"
            "svg" -> "image/svg+xml"
            "wasm" -> "application/wasm"
            "txt", "md" -> "text/plain"
            else -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
        }
    }

    private fun status(code: Int, text: String) =
        WebResourceResponse("text/plain", "utf-8", code, text, mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(ByteArray(0)))

    /** Serves [rel] from inside [base] (site-root style: "" or a trailing "/" means index.html). Never leaves [base]. */
    fun serve(base: File, rel: String): WebResourceResponse {
        return try {
            var f = File(base, rel.trimStart('/')).canonicalFile
            val b = base.canonicalPath
            if (f.path != b && !f.path.startsWith(b + File.separator)) return status(403, "Forbidden")
            if (f.isDirectory) f = File(f, "index.html")
            if (!f.isFile) return status(404, "Not Found")
            val mime = of(f)
            val textual = mime.startsWith("text/") || mime.endsWith("json") || mime.endsWith("javascript")
            WebResourceResponse(mime, if (textual) "utf-8" else null, 200, "OK", mapOf("Cache-Control" to "no-store"), FileInputStream(f))
        } catch (e: Exception) { status(500, "Error") }
    }
}
