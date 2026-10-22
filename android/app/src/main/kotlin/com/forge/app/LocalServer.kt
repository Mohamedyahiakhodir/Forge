package com.forge.app

import android.webkit.MimeTypeMap
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.util.concurrent.Executors

/**
 * Tiny read-only HTTP server on 127.0.0.1 so a project can be opened in the phone's real browser
 * (needed e.g. for Google sign-in, which refuses to run inside an embedded WebView).
 * The served folder is the project root, so absolute paths like "/style.css" behave like on a real site.
 */
class LocalServer(private val port: Int = DEFAULT_PORT) {
    private var server: ServerSocket? = null
    private val pool = Executors.newCachedThreadPool()
    @Volatile private var root: File? = null

    val running get() = server?.isClosed == false

    @Synchronized
    fun start(projectRoot: File) {
        root = projectRoot
        if (running) return
        val s = ServerSocket(port, 50, InetAddress.getByName("127.0.0.1"))
        server = s
        Thread({
            while (!s.isClosed) {
                try { val c = s.accept(); pool.execute { handle(c) } } catch (_: Exception) { break }
            }
        }, "forge-http").apply { isDaemon = true }.start()
    }

    @Synchronized
    fun stop() { try { server?.close() } catch (_: Exception) { }; server = null }

    private fun mime(f: File): String {
        val ext = f.extension.lowercase()
        return when (ext) {
            "js", "mjs" -> "text/javascript; charset=utf-8"
            "html", "htm" -> "text/html; charset=utf-8"
            "css" -> "text/css; charset=utf-8"
            "json", "webmanifest" -> "application/json; charset=utf-8"
            "svg" -> "image/svg+xml"
            "wasm" -> "application/wasm"
            "txt", "md" -> "text/plain; charset=utf-8"
            else -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
        }
    }

    private fun safeResolve(base: File, rel: String): File? {
        val f = File(base, rel.trimStart('/')).canonicalFile
        val b = base.canonicalPath
        return if (f.path == b || f.path.startsWith(b + File.separator)) f else null
    }

    private fun handle(sock: Socket) {
        sock.use { s ->
            s.soTimeout = 10_000
            val input = s.getInputStream().bufferedReader(Charsets.ISO_8859_1)
            val first = input.readLine() ?: return
            while (true) { val l = input.readLine() ?: break; if (l.isEmpty()) break }
            val parts = first.split(' ')
            val out = s.getOutputStream()
            fun send(code: Int, text: String, type: String, body: ByteArray, head: Boolean = false) {
                out.write("HTTP/1.1 $code $text\r\nContent-Type: $type\r\nContent-Length: ${body.size}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n".toByteArray())
                if (!head) out.write(body)
                out.flush()
            }
            if (parts.size < 2 || (parts[0] != "GET" && parts[0] != "HEAD")) { send(405, "Method Not Allowed", "text/plain", ByteArray(0)); return }
            val head = parts[0] == "HEAD"
            val base = root ?: run { send(503, "Unavailable", "text/plain", ByteArray(0), head); return }
            try {
                val raw = URLDecoder.decode(parts[1].substringBefore('?').substringBefore('#'), "UTF-8")
                var f = safeResolve(base, raw)
                if (f == null) { send(403, "Forbidden", "text/plain", ByteArray(0), head); return }
                if (f.isDirectory) f = File(f, "index.html")
                if (!f.isFile) { send(404, "Not Found", "text/plain; charset=utf-8", "Not found".toByteArray(), head); return }
                send(200, "OK", mime(f), f.readBytes(), head)
            } catch (e: Exception) {
                send(500, "Error", "text/plain", ByteArray(0), head)
            }
        }
    }

    companion object { const val DEFAULT_PORT = 8080 }
}
