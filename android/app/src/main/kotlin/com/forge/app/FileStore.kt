package com.forge.app

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.regex.Pattern

/** All project files live under [root]. Every path coming from the web layer is project-relative. */
class FileStore(val root: File) {
    init { root.mkdirs() }

    private val rootCanonical = root.canonicalPath

    fun resolve(rel: String): File {
        val parts = rel.split('/').filter { it.isNotEmpty() }
        require(parts.none { it == ".." || it == "." }) { "Invalid path" }
        val f = File(root, parts.joinToString("/"))
        val c = f.canonicalPath
        require(c == rootCanonical || c.startsWith(rootCanonical + File.separator)) { "Path escapes project root" }
        return f
    }

    fun list(rel: String): JSONArray {
        val dir = resolve(rel)
        val arr = JSONArray()
        dir.listFiles()?.forEach {
            arr.put(JSONObject().put("name", it.name).put("isDir", it.isDirectory).put("size", if (it.isFile) it.length() else 0L).put("mtime", it.lastModified()))
        }
        return arr
    }

    fun stat(rel: String): JSONObject {
        val f = resolve(rel)
        return JSONObject().put("exists", f.exists()).put("isDir", f.isDirectory).put("size", if (f.isFile) f.length() else 0L).put("mtime", f.lastModified())
    }

    fun readText(rel: String): String = resolve(rel).also { require(it.isFile) { "Not a file" } }.readText(Charsets.UTF_8)

    fun readTextRange(rel: String, maxBytes: Int): String {
        val f = resolve(rel)
        require(f.isFile) { "Not a file" }
        f.inputStream().use { ins ->
            val buf = ByteArray(maxBytes)
            var n = 0
            while (n < maxBytes) {
                val r = ins.read(buf, n, maxBytes - n)
                if (r < 0) break
                n += r
            }
            // A multi-byte character cut at the boundary decodes to U+FFFD, which is fine for a read-only preview.
            return String(buf, 0, n, Charsets.UTF_8)
        }
    }

    fun readB64(rel: String): String = Base64.encodeToString(resolve(rel).also { require(it.isFile) { "Not a file" } }.readBytes(), Base64.NO_WRAP)

    /** Writes through a temp file so an app kill mid-write never leaves a truncated file. */
    private fun atomicWrite(f: File, bytes: ByteArray) {
        f.parentFile?.mkdirs()
        val tmp = File(f.parentFile, ".${f.name}.forge-tmp")
        FileOutputStream(tmp).use { it.write(bytes); it.fd.sync() }
        if (!tmp.renameTo(f)) { f.delete(); check(tmp.renameTo(f)) { "Could not write ${f.name}" } }
    }

    fun writeText(rel: String, text: String) = atomicWrite(resolve(rel), text.toByteArray(Charsets.UTF_8))
    fun writeB64(rel: String, b64: String) = atomicWrite(resolve(rel), Base64.decode(b64, Base64.DEFAULT))

    fun mkdir(rel: String) { check(resolve(rel).mkdirs() || resolve(rel).isDirectory) { "Could not create folder" } }
    fun remove(rel: String) {
        val f = resolve(rel)
        require(f != root) { "Cannot delete root" }
        check(f.deleteRecursively()) { "Could not delete" }
    }

    fun rename(from: String, to: String) {
        val a = resolve(from); val b = resolve(to)
        require(!b.exists()) { "Target exists" }
        b.parentFile?.mkdirs()
        if (!a.renameTo(b)) { a.copyRecursively(b, overwrite = false); a.deleteRecursively() }
    }

    fun copy(from: String, to: String) {
        val a = resolve(from); val b = resolve(to)
        require(!b.exists()) { "Target exists" }
        b.parentFile?.mkdirs()
        check(a.copyRecursively(b, overwrite = false)) { "Copy failed" }
    }

    fun isBinary(rel: String): Boolean {
        val f = resolve(rel)
        if (!f.isFile) return false
        f.inputStream().use { ins ->
            val buf = ByteArray(8000)
            val n = ins.read(buf)
            for (i in 0 until maxOf(n, 0)) if (buf[i].toInt() == 0) return true
        }
        return false
    }

    // ----- project-wide search -----
    private fun glob(g: String): Pattern {
        val sb = StringBuilder("^(?:.*/)?")
        var i = 0
        val s = g.trim().trimStart('/')
        while (i < s.length) {
            val c = s[i]
            when {
                c == '*' && i + 1 < s.length && s[i + 1] == '*' -> { sb.append(".*"); i++ ; if (i + 1 < s.length && s[i + 1] == '/') i++ }
                c == '*' -> sb.append("[^/]*")
                c == '?' -> sb.append("[^/]")
                else -> sb.append(Pattern.quote(c.toString()))
            }
            i++
        }
        sb.append("$")
        return Pattern.compile(sb.toString())
    }

    private fun globs(csv: String): List<Pattern> = csv.split(',').map { it.trim() }.filter { it.isNotEmpty() }.map { glob(it) }

    fun search(dirRel: String, pattern: String, flags: String, include: String, exclude: String, max: Int): JSONArray {
        val base = resolve(dirRel)
        val re = Pattern.compile(pattern, if (flags.contains('i')) Pattern.CASE_INSENSITIVE or Pattern.UNICODE_CASE else 0)
        val inc = globs(include)
        val exc = globs(exclude)
        val out = JSONArray()
        val prefix = dirRel.trim('/')

        fun visit(dir: File, relDir: String) {
            val children = dir.listFiles() ?: return
            for (f in children.sortedBy { it.name }) {
                if (out.length() >= max) return
                val rel = if (relDir.isEmpty()) f.name else "$relDir/${f.name}"
                if (f.isDirectory) {
                    if (f.name == ".git") continue
                    if (exc.any { it.matcher(rel).matches() || it.matcher("$rel/x").matches() }) continue
                    visit(f, rel)
                } else {
                    if (f.length() > 2_000_000) continue
                    if (exc.any { it.matcher(rel).matches() }) continue
                    if (inc.isNotEmpty() && inc.none { it.matcher(rel).matches() }) continue
                    searchFile(f, if (prefix.isEmpty()) rel else "$prefix/$rel", re, out, max)
                }
            }
        }
        visit(base, "")
        return out
    }

    private fun searchFile(f: File, relPath: String, re: Pattern, out: JSONArray, max: Int) {
        val head = ByteArray(4000)
        val n = f.inputStream().use { it.read(head) }
        for (i in 0 until maxOf(n, 0)) if (head[i].toInt() == 0) return
        var lineNo = 0
        f.bufferedReader(Charsets.UTF_8).useLines { lines ->
            for (line in lines) {
                lineNo++
                val m = re.matcher(line)
                while (m.find()) {
                    if (out.length() >= max) return@useLines
                    val start = maxOf(0, m.start() - 120)
                    out.put(JSONObject()
                        .put("path", relPath).put("line", lineNo)
                        .put("col", m.start() - start).put("len", m.end() - m.start())
                        .put("text", line.substring(start, minOf(line.length, start + 300))))
                    if (m.end() == m.start()) break // zero-length match: avoid an endless loop
                }
            }
        }
    }
}
