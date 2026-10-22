package com.forge.app

import com.forge.app.sign.KeyInfo
import com.forge.app.sign.KeyTools
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Upload keys live in app-private storage (never inside a project, so they can't leak into ZIP exports). */
class KeyVault(private val dir: File) {
    init { dir.mkdirs() }

    private fun checkAlias(a: String) = require(a.matches(Regex("[A-Za-z0-9_-]{1,32}"))) { "Invalid key name" }
    fun p12(alias: String): File { checkAlias(alias); return File(dir, "$alias.p12") }
    private fun meta(alias: String) = File(dir, "$alias.json")
    fun pem(alias: String): File { checkAlias(alias); return File(dir, "$alias.pem") }

    private fun toJson(i: KeyInfo) = JSONObject()
        .put("alias", i.alias).put("subject", i.subject).put("sha256", i.sha256).put("sha1", i.sha1)
        .put("notAfter", i.notAfter).put("created", i.created)

    fun list(): JSONArray {
        val arr = JSONArray()
        dir.listFiles { f -> f.name.endsWith(".json") }?.sortedBy { it.name }?.forEach {
            try { arr.put(JSONObject(it.readText())) } catch (_: Exception) { /* skip corrupt metadata */ }
        }
        return arr
    }

    fun create(alias: String, password: String, cn: String, org: String, country: String): JSONObject {
        require(!p12(alias).exists()) { "A key with this name already exists" }
        require(password.length >= 8) { "Password must be at least 8 characters" }
        require(cn.isNotBlank()) { "Name is required" }
        require(country.isBlank() || country.matches(Regex("[A-Za-z]{2}"))) { "Country must be 2 letters" }
        val (info, cert) = KeyTools.createKeystore(p12(alias), alias, password.toCharArray(), cn.trim(), org.trim(), country.trim())
        save(alias, info, KeyTools.pem(cert))
        return toJson(info)
    }

    fun importKey(alias: String, password: String, bytes: ByteArray): JSONObject {
        require(!p12(alias).exists()) { "A key with this name already exists" }
        val tmp = File(dir, "$alias.import-tmp")
        try {
            tmp.writeBytes(bytes)
            val loaded = try { KeyTools.load(tmp, password.toCharArray()) } catch (e: Exception) {
                throw IllegalArgumentException("Could not open the key file. Check that it is a .p12/.pfx file and the password is correct.")
            }
            val info = KeyTools.info(alias, loaded.cert)
            check(tmp.renameTo(p12(alias))) { "Could not store the key" }
            save(alias, info, KeyTools.pem(loaded.cert))
            return toJson(info)
        } finally { tmp.delete() }
    }

    private fun save(alias: String, info: KeyInfo, pem: String) {
        meta(alias).writeText(toJson(info).toString())
        pem(alias).writeText(pem)
    }

    fun delete(alias: String) {
        p12(alias).delete(); meta(alias).delete(); pem(alias).delete()
    }
}
