package com.forge.app.sign

import java.math.BigInteger
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

/** Minimal ASN.1 DER writer: just enough for a self-signed X.509 certificate and a PKCS#7 signature. */
object Der {
    fun concat(vararg parts: ByteArray): ByteArray {
        val out = ByteArray(parts.sumOf { it.size })
        var pos = 0
        for (p in parts) { System.arraycopy(p, 0, out, pos, p.size); pos += p.size }
        return out
    }

    private fun length(n: Int): ByteArray {
        if (n < 128) return byteArrayOf(n.toByte())
        val raw = BigInteger.valueOf(n.toLong()).toByteArray().dropWhile { it == 0.toByte() }.toByteArray()
        return concat(byteArrayOf((0x80 or raw.size).toByte()), raw)
    }

    fun tlv(tag: Int, content: ByteArray): ByteArray = concat(byteArrayOf(tag.toByte()), length(content.size), content)

    fun seq(vararg p: ByteArray) = tlv(0x30, concat(*p))
    fun set(vararg p: ByteArray) = tlv(0x31, concat(*p))
    fun int(v: BigInteger) = tlv(0x02, v.toByteArray())
    fun int(v: Int) = int(BigInteger.valueOf(v.toLong()))
    fun nul() = byteArrayOf(0x05, 0x00)
    fun octets(b: ByteArray) = tlv(0x04, b)
    fun bits(b: ByteArray) = tlv(0x03, concat(byteArrayOf(0), b))
    fun utf8(s: String) = tlv(0x0C, s.toByteArray(Charsets.UTF_8))
    fun printable(s: String) = tlv(0x13, s.toByteArray(Charsets.US_ASCII))
    fun context(n: Int, content: ByteArray) = tlv(0xA0 + n, content)

    fun oid(dotted: String): ByteArray {
        val p = dotted.split('.').map { it.toLong() }
        val body = java.io.ByteArrayOutputStream()
        fun base128(v: Long) {
            val tmp = ArrayList<Int>()
            var x = v
            tmp.add((x and 0x7F).toInt())
            x = x shr 7
            while (x > 0) { tmp.add(((x and 0x7F) or 0x80).toInt()); x = x shr 7 }
            for (i in tmp.indices.reversed()) body.write(tmp[i])
        }
        base128(p[0] * 40 + p[1])
        for (i in 2 until p.size) base128(p[i])
        return tlv(0x06, body.toByteArray())
    }

    /** UTCTime before 2050, GeneralizedTime from 2050 on (RFC 5280). */
    fun time(millis: Long): ByteArray {
        val t = ZonedDateTime.ofInstant(java.time.Instant.ofEpochMilli(millis), ZoneOffset.UTC)
        return if (t.year < 2050) tlv(0x17, t.format(DateTimeFormatter.ofPattern("yyMMddHHmmss'Z'")).toByteArray())
        else tlv(0x18, t.format(DateTimeFormatter.ofPattern("yyyyMMddHHmmss'Z'")).toByteArray())
    }
}
