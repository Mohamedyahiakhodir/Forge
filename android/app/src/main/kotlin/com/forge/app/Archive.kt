package com.forge.app

import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

object Archive {
    /** Makes a project folder name unique under [root] and filesystem-safe. */
    fun uniqueProjectName(root: File, wanted: String): String {
        val base = wanted.replace(Regex("[\\\\/:*?\"<>|]"), "_").trim().trimStart('.').ifEmpty { "project" }
        var name = base
        var n = 2
        while (File(root, name).exists()) name = "$base-${n++}"
        return name
    }

    fun zipProject(dir: File, out: OutputStream) {
        ZipOutputStream(out.buffered()).use { zip ->
            dir.walkTopDown().forEach { f ->
                if (f == dir) return@forEach
                if (f.name.endsWith(".forge-tmp")) return@forEach
                val name = f.relativeTo(dir).path.replace(File.separatorChar, '/') + if (f.isDirectory) "/" else ""
                zip.putNextEntry(ZipEntry(name).apply { time = f.lastModified() })
                if (f.isFile) f.inputStream().use { it.copyTo(zip) }
                zip.closeEntry()
            }
        }
    }

    /** Extracts into [target]. Entries that would escape [target] (zip-slip) abort the import. */
    fun unzip(input: InputStream, target: File) {
        val canonical = target.canonicalPath
        // Buffer entries first so a single top-level folder can be flattened.
        val tmp = File(target.parentFile, ".${target.name}.import-tmp").apply { deleteRecursively(); mkdirs() }
        try {
            ZipInputStream(input.buffered()).use { zin ->
                var e: ZipEntry? = zin.nextEntry
                while (e != null) {
                    val out = File(tmp, e.name)
                    require(out.canonicalPath.startsWith(tmp.canonicalPath + File.separator) || out.canonicalPath == tmp.canonicalPath) { "Unsafe path in archive" }
                    if (e.isDirectory) out.mkdirs() else {
                        out.parentFile?.mkdirs()
                        out.outputStream().use { zin.copyTo(it) }
                    }
                    e = zin.nextEntry
                }
            }
            val top = tmp.listFiles().orEmpty()
            val src = if (top.size == 1 && top[0].isDirectory) top[0] else tmp
            target.mkdirs()
            check(src.copyRecursively(target, overwrite = true)) { "Could not extract archive" }
            require(target.canonicalPath == canonical) { "Unexpected target" }
        } finally {
            tmp.deleteRecursively()
        }
    }

    fun copyTreeFromSaf(ctx: Context, treeUri: Uri, dest: File) {
        val src = DocumentFile.fromTreeUri(ctx, treeUri) ?: error("Cannot open folder")
        copyDoc(ctx, src, dest)
    }

    private fun copyDoc(ctx: Context, doc: DocumentFile, dest: File) {
        dest.mkdirs()
        for (child in doc.listFiles()) {
            val name = child.name ?: continue
            val safe = name.replace('/', '_')
            if (child.isDirectory) {
                copyDoc(ctx, child, File(dest, safe))
            } else if (child.isFile) {
                ctx.contentResolver.openInputStream(child.uri)?.use { ins -> File(dest, safe).outputStream().use { ins.copyTo(it) } }
            }
        }
    }

    fun copyTreeToSaf(ctx: Context, src: File, parent: DocumentFile) {
        val folder = parent.findFile(src.name)?.takeIf { it.isDirectory } ?: parent.createDirectory(src.name) ?: error("Cannot create folder")
        copyInto(ctx, src, folder)
    }

    private fun copyInto(ctx: Context, src: File, dst: DocumentFile) {
        src.listFiles()?.forEach { f ->
            if (f.name.endsWith(".forge-tmp")) return@forEach
            if (f.isDirectory) {
                val sub = dst.findFile(f.name)?.takeIf { it.isDirectory } ?: dst.createDirectory(f.name) ?: error("Cannot create ${f.name}")
                copyInto(ctx, f, sub)
            } else {
                dst.findFile(f.name)?.delete()
                val mime = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(f.extension.lowercase()) ?: "application/octet-stream"
                val out = dst.createFile(mime, f.name) ?: error("Cannot create ${f.name}")
                ctx.contentResolver.openOutputStream(out.uri)?.use { os -> f.inputStream().use { it.copyTo(os) } }
            }
        }
    }
}
