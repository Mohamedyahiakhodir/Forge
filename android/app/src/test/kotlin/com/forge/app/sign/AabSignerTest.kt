package com.forge.app.sign

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.jar.JarFile
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class AabSignerTest {
    private fun tmp(name: String) = File.createTempFile("forge-", name).also { it.deleteOnExit() }

    private fun sampleAab(): File {
        val f = tmp(".aab")
        ZipOutputStream(f.outputStream()).use { z ->
            fun put(n: String, d: ByteArray) { z.putNextEntry(ZipEntry(n)); z.write(d); z.closeEntry() }
            put("META-INF/MANIFEST.MF", "Manifest-Version: 1.0\r\n\r\n".toByteArray()) // pre-existing, must be replaced
            put("BundleConfig.pb", ByteArray(100) { it.toByte() })
            z.putNextEntry(ZipEntry("base/dex/")); z.closeEntry()
            put("base/manifest/AndroidManifest.xml", "<manifest/>".toByteArray())
            put("BUNDLE-METADATA/com.android.tools.build.libraries/dependencies-with-a-very-long-name-to-force-wrapping.pb", ByteArray(5000) { 7 })
            put("base/assets/www/arabic-ملف.html", "hi".toByteArray())
        }
        return f
    }

    @Test
    fun keystoreRoundTripAndCertificateFields() {
        val p12 = tmp(".p12")
        val (info, cert) = KeyTools.createKeystore(p12, "upload", "secret-123".toCharArray(), "Ahmed Shop", "Ahmed", "EG")
        assertEquals("upload", info.alias)
        assertTrue(cert.subjectX500Principal.name.contains("Ahmed Shop"))
        // Google Play requires the upload key to stay valid until after 22 Oct 2033.
        assertTrue(cert.notAfter.time > 2_000_000_000_000L + 100_000_000_000L)
        cert.verify(cert.publicKey)
        val loaded = KeyTools.load(p12, "secret-123".toCharArray())
        assertEquals(cert, loaded.cert)
        assertTrue(KeyTools.pem(cert).startsWith("-----BEGIN CERTIFICATE-----"))
    }

    @Test
    fun signedBundleVerifiesWithJarFileAndJarsigner() {
        val p12 = tmp(".p12")
        KeyTools.createKeystore(p12, "upload", "secret-123".toCharArray(), "Ahmed Shop", "Ahmed", "EG")
        val key = KeyTools.load(p12, "secret-123".toCharArray())
        val input = sampleAab()
        val output = tmp("-signed.aab")
        AabSigner.sign(input, output, key.key, key.cert)

        JarFile(output, true).use { jar ->
            var checked = 0
            for (e in jar.entries()) {
                jar.getInputStream(e).use { it.readBytes() } // reading triggers digest verification
                if (!e.isDirectory && !e.name.startsWith("META-INF/")) {
                    assertNotNull("entry not signed: ${e.name}", e.codeSigners)
                    assertEquals(1, e.codeSigners.size)
                    checked++
                }
            }
            assertEquals(4, checked)
        }

        val jarsigner = File(System.getProperty("java.home"), "bin/jarsigner" + if (System.getProperty("os.name").lowercase().contains("win")) ".exe" else "")
        if (jarsigner.exists()) {
            val proc = ProcessBuilder(jarsigner.path, "-verify", "-strict", output.path).redirectErrorStream(true).start()
            val text = proc.inputStream.bufferedReader().readText()
            proc.waitFor()
            assertTrue("jarsigner said: $text", text.contains("jar verified"))
        }
    }

    @Test
    fun tamperedBundleFailsVerification() {
        val p12 = tmp(".p12")
        KeyTools.createKeystore(p12, "upload", "secret-123".toCharArray(), "X", "", "")
        val key = KeyTools.load(p12, "secret-123".toCharArray())
        val output = tmp("-signed.aab")
        AabSigner.sign(sampleAab(), output, key.key, key.cert)
        // Rewrite the bundle with one changed entry but the old signature files.
        val tampered = tmp("-tampered.aab")
        java.util.zip.ZipFile(output).use { zip ->
            ZipOutputStream(tampered.outputStream()).use { z ->
                for (e in zip.entries()) {
                    z.putNextEntry(ZipEntry(e.name))
                    if (!e.isDirectory) {
                        val data = zip.getInputStream(e).readBytes()
                        z.write(if (e.name == "BundleConfig.pb") ByteArray(100) { 1 } else data)
                    }
                    z.closeEntry()
                }
            }
        }
        var failed = false
        try {
            JarFile(tampered, true).use { jar -> for (e in jar.entries()) jar.getInputStream(e).use { it.readBytes() } }
        } catch (e: SecurityException) { failed = true }
        assertTrue("tampering must be detected", failed)
    }
}
