package com.forge.app.sign

import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.Signature
import java.security.cert.X509Certificate
import java.util.Base64
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream

/**
 * JAR-signs an Android App Bundle (what `jarsigner` does). Play accepts v1 JAR signatures for .aab files.
 * Layout: META-INF/MANIFEST.MF (per-entry SHA-256) + META-INF/FORGE.SF + META-INF/FORGE.RSA (PKCS#7, detached).
 */
object AabSigner {
    private const val SIG_NAME = "FORGE"
    private val b64 = Base64.getEncoder()

    private fun isSignatureFile(n: String): Boolean {
        val u = n.uppercase()
        return u == "META-INF/MANIFEST.MF" || (u.startsWith("META-INF/") && (u.endsWith(".SF") || u.endsWith(".RSA") || u.endsWith(".DSA") || u.endsWith(".EC")))
    }

    /** Manifest lines are limited to 72 bytes; longer ones continue on the next line after one space. */
    private fun wrap(line: String): ByteArray {
        val out = ByteArrayOutputStream()
        var count = 0
        var i = 0
        while (i < line.length) {
            val cp = line.codePointAt(i)
            val bytes = String(Character.toChars(cp)).toByteArray(Charsets.UTF_8)
            if (count + bytes.size > 72) { out.write("\r\n ".toByteArray()); count = 1 }
            out.write(bytes); count += bytes.size
            i += Character.charCount(cp)
        }
        out.write("\r\n".toByteArray())
        return out.toByteArray()
    }

    private fun sha256(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b)

    fun sign(input: File, output: File, key: PrivateKey, cert: X509Certificate) {
        val names = ArrayList<String>()
        val sections = ArrayList<ByteArray>()
        ZipFile(input).use { zip ->
            for (e in zip.entries()) {
                if (e.isDirectory || isSignatureFile(e.name)) continue
                val md = MessageDigest.getInstance("SHA-256")
                zip.getInputStream(e).use { ins ->
                    val buf = ByteArray(64 * 1024)
                    while (true) { val n = ins.read(buf); if (n < 0) break; md.update(buf, 0, n) }
                }
                names.add(e.name)
                sections.add(wrap("Name: ${e.name}") + wrap("SHA-256-Digest: ${b64.encodeToString(md.digest())}") + "\r\n".toByteArray())
            }
        }

        val manifestMain = "Manifest-Version: 1.0\r\nCreated-By: 1.0 (Forge)\r\n\r\n".toByteArray()
        val manifest = Der.concat(manifestMain, *sections.toTypedArray())

        val sfMain = ("Signature-Version: 1.0\r\nCreated-By: 1.0 (Forge)\r\nSHA-256-Digest-Manifest: ${b64.encodeToString(sha256(manifest))}\r\n\r\n").toByteArray()
        val sfSections = names.indices.map { i ->
            wrap("Name: ${names[i]}") + wrap("SHA-256-Digest: ${b64.encodeToString(sha256(sections[i]))}") + "\r\n".toByteArray()
        }
        val sf = Der.concat(sfMain, *sfSections.toTypedArray())

        val sig = Signature.getInstance("SHA256withRSA").run { initSign(key); update(sf); sign() }
        val rsa = pkcs7(cert, sig)

        output.parentFile?.mkdirs()
        ZipOutputStream(output.outputStream().buffered()).use { out ->
            fun put(name: String, data: ByteArray) { out.putNextEntry(ZipEntry(name)); out.write(data); out.closeEntry() }
            put("META-INF/MANIFEST.MF", manifest)
            put("META-INF/$SIG_NAME.SF", sf)
            put("META-INF/$SIG_NAME.RSA", rsa)
            ZipFile(input).use { zip ->
                for (e in zip.entries()) {
                    if (isSignatureFile(e.name)) continue
                    out.putNextEntry(ZipEntry(e.name))
                    if (!e.isDirectory) zip.getInputStream(e).use { it.copyTo(out) }
                    out.closeEntry()
                }
            }
        }
    }

    /** PKCS#7 SignedData with the signature over the .SF bytes and no signed attributes (same shape jarsigner writes). */
    private fun pkcs7(cert: X509Certificate, signature: ByteArray): ByteArray {
        val sha256Alg = Der.seq(Der.oid(KeyTools.OID_SHA256), Der.nul())
        val issuerAndSerial = Der.seq(cert.issuerX500Principal.encoded, Der.int(cert.serialNumber))
        val signerInfo = Der.seq(
            Der.int(1), issuerAndSerial, sha256Alg,
            Der.seq(Der.oid(KeyTools.OID_RSA), Der.nul()),
            Der.octets(signature),
        )
        val signedData = Der.seq(
            Der.int(1),
            Der.set(sha256Alg),
            Der.seq(Der.oid("1.2.840.113549.1.7.1")),
            Der.context(0, cert.encoded),
            Der.set(signerInfo),
        )
        return Der.seq(Der.oid("1.2.840.113549.1.7.2"), Der.context(0, signedData))
    }
}
