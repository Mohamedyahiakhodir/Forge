package com.forge.app.sign

import java.io.ByteArrayInputStream
import java.io.File
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.Base64

data class KeyInfo(val alias: String, val subject: String, val sha256: String, val sha1: String, val notAfter: Long, val created: Long)

object KeyTools {
    const val OID_SHA256_RSA = "1.2.840.113549.1.1.11"
    const val OID_RSA = "1.2.840.113549.1.1.1"
    const val OID_SHA256 = "2.16.840.1.101.3.4.2.1"

    private fun name(cn: String, org: String, country: String): ByteArray {
        fun rdn(oid: String, v: ByteArray) = Der.set(Der.seq(Der.oid(oid), v))
        val parts = ArrayList<ByteArray>()
        if (country.isNotBlank()) parts.add(rdn("2.5.4.6", Der.printable(country.uppercase())))
        if (org.isNotBlank()) parts.add(rdn("2.5.4.10", Der.utf8(org)))
        parts.add(rdn("2.5.4.3", Der.utf8(cn)))
        return Der.seq(*parts.toTypedArray())
    }

    /** Builds and signs a self-signed X.509 v3 certificate with SHA256withRSA. */
    fun selfSigned(pair: java.security.KeyPair, cn: String, org: String, country: String, years: Int): X509Certificate {
        val now = System.currentTimeMillis() - 60_000
        val end = now + years * 365L * 24 * 3600 * 1000
        val serial = BigInteger(63, SecureRandom()).add(BigInteger.ONE)
        val algId = Der.seq(Der.oid(OID_SHA256_RSA), Der.nul())
        val subject = name(cn, org, country)
        val tbs = Der.seq(
            Der.context(0, Der.int(2)),
            Der.int(serial),
            algId,
            subject,
            Der.seq(Der.time(now), Der.time(end)),
            subject,
            pair.public.encoded,
        )
        val sig = Signature.getInstance("SHA256withRSA").run { initSign(pair.private); update(tbs); sign() }
        val der = Der.seq(tbs, algId, Der.bits(sig))
        return CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(der)) as X509Certificate
    }

    private fun hex(b: ByteArray) = b.joinToString(":") { "%02X".format(it) }

    fun info(alias: String, cert: X509Certificate, created: Long = System.currentTimeMillis()) = KeyInfo(
        alias, cert.subjectX500Principal.name,
        hex(MessageDigest.getInstance("SHA-256").digest(cert.encoded)),
        hex(MessageDigest.getInstance("SHA-1").digest(cert.encoded)),
        cert.notAfter.time, created,
    )

    fun createKeystore(file: File, alias: String, password: CharArray, cn: String, org: String, country: String, years: Int = 30): Pair<KeyInfo, X509Certificate> {
        val kpg = KeyPairGenerator.getInstance("RSA")
        kpg.initialize(2048)
        val pair = kpg.generateKeyPair()
        val cert = selfSigned(pair, cn, org, country, years)
        val ks = KeyStore.getInstance("PKCS12")
        ks.load(null, null)
        ks.setKeyEntry(alias, pair.private, password, arrayOf(cert))
        file.parentFile?.mkdirs()
        file.outputStream().use { ks.store(it, password) }
        return info(alias, cert) to cert
    }

    class Loaded(val alias: String, val key: PrivateKey, val cert: X509Certificate)

    fun load(file: File, password: CharArray): Loaded {
        val ks = KeyStore.getInstance("PKCS12")
        file.inputStream().use { ks.load(it, password) }
        for (a in ks.aliases()) {
            if (ks.isKeyEntry(a)) {
                val key = ks.getKey(a, password) as PrivateKey
                val cert = ks.getCertificate(a) as X509Certificate
                return Loaded(a, key, cert)
            }
        }
        error("No private key found in this file")
    }

    fun pem(cert: X509Certificate): String =
        "-----BEGIN CERTIFICATE-----\n" + Base64.getMimeEncoder(64, "\n".toByteArray()).encodeToString(cert.encoded) + "\n-----END CERTIFICATE-----\n"
}
