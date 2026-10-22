package com.forge.app

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.security.KeyStore
import java.util.concurrent.TimeUnit
import java.util.zip.ZipInputStream
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.concurrent.thread

/** The GitHub token is encrypted with a key that never leaves the Android Keystore. */
private object TokenCrypto {
    private const val ALIAS = "forge_github_token"
    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).build(),
        )
        return gen.generateKey()
    }
    fun encrypt(plain: String): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        return c.iv + c.doFinal(plain.toByteArray(Charsets.UTF_8))
    }
    fun decrypt(data: ByteArray): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, data, 0, 12)) }
        return String(c.doFinal(data, 12, data.size - 12), Charsets.UTF_8)
    }
}

/**
 * Pushes the generated Android project to the user's GitHub repo, waits for the "Build AAB" workflow,
 * and downloads the unsigned bundle. Everything runs on background threads and reports through [emit].
 */
class GitHub(private val dir: File, private val store: FileStore, private val emit: (String, JSONObject) -> Unit) {
    init { dir.mkdirs() }

    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS).readTimeout(120, TimeUnit.SECONDS).writeTimeout(120, TimeUnit.SECONDS).build()
    private val json = "application/json".toMediaType()
    private val tokenFile get() = File(dir, "token.bin")
    private val loginFile get() = File(dir, "login.txt")

    private class Resp(val code: Int, val text: String, val scopes: String?)
    private class Fail(val code: String, message: String = code) : Exception(message)

    private fun call(method: String, url: String, token: String, body: JSONObject? = null): Resp {
        val rb = when {
            body != null -> body.toString().toRequestBody(json)
            method == "GET" || method == "HEAD" -> null
            else -> "".toRequestBody(null)
        }
        val req = Request.Builder().url(url)
            .header("Authorization", "Bearer $token").header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28").method(method, rb).build()
        try {
            client.newCall(req).execute().use { return Resp(it.code, it.body?.string() ?: "", it.header("X-OAuth-Scopes")) }
        } catch (e: IOException) { throw Fail("NETWORK", e.message ?: "network") }
    }

    private fun ok(r: Resp, what: String): JSONObject {
        if (r.code == 401) throw Fail("BAD_TOKEN")
        if (r.code == 403 && r.text.contains("rate limit", true)) throw Fail("RATE_LIMIT")
        if (r.code !in 200..299) throw Fail("API_$what", "${r.code}: ${r.text.take(300)}")
        return if (r.text.isBlank()) JSONObject() else JSONObject(r.text)
    }

    private fun token(): String {
        if (!tokenFile.isFile) throw Fail("NO_TOKEN")
        return try { TokenCrypto.decrypt(tokenFile.readBytes()) } catch (e: Exception) { throw Fail("NO_TOKEN") }
    }

    fun status(): JSONObject = JSONObject().put("connected", tokenFile.isFile).put("login", if (loginFile.isFile) loginFile.readText() else "")

    fun disconnect() { tokenFile.delete(); loginFile.delete() }

    private fun bg(errorEvent: String, block: () -> Unit) = thread(name = "forge-gh") {
        try { block() } catch (f: Fail) { emit(errorEvent, JSONObject().put("message", f.code).put("detail", f.message ?: "")) }
        catch (e: Throwable) { emit(errorEvent, JSONObject().put("message", "UNKNOWN").put("detail", e.message ?: e.javaClass.simpleName)) }
    }

    fun connect(token: String) = bg("ghError") {
        val r = call("GET", "https://api.github.com/user", token.trim())
        if (r.code == 401) throw Fail("BAD_TOKEN")
        val user = ok(r, "user")
        val scopes = r.scopes
        // Classic tokens report their scopes; fine-grained tokens send no header and are checked when used.
        if (scopes != null) {
            val have = scopes.split(',').map { it.trim() }
            if ("repo" !in have || "workflow" !in have) throw Fail("MISSING_SCOPES", scopes)
        }
        tokenFile.writeBytes(TokenCrypto.encrypt(token.trim()))
        loginFile.writeText(user.getString("login"))
        emit("ghConnected", JSONObject().put("login", user.getString("login")))
    }

    private fun progress(stage: String, msg: String = "", done: Int = 0, total: Int = 0) =
        emit("buildProgress", JSONObject().put("stage", stage).put("msg", msg).put("done", done).put("total", total))

    fun build(project: String, repoName: String) = bg("buildFailed") {
        val tok = token()
        val login = loginFile.takeIf { it.isFile }?.readText() ?: ok(call("GET", "https://api.github.com/user", tok), "user").getString("login")
        val api = "https://api.github.com/repos/$login/$repoName"

        progress("repo")
        val repoResp = call("GET", api, tok)
        val branch = if (repoResp.code == 404) {
            val created = ok(call("POST", "https://api.github.com/user/repos", tok, JSONObject()
                .put("name", repoName).put("private", true).put("auto_init", true).put("description", "Built by Forge")), "createRepo")
            created.optString("default_branch", "main")
        } else ok(repoResp, "repo").optString("default_branch", "main")

        val root = store.resolve("$project/.forge/android")
        require(root.isDirectory) { "Generate the Android project first" }
        val files = root.walkTopDown().filter { it.isFile && !it.name.endsWith(".forge-tmp") }.toList()
        val total = files.size

        val headRef = ok(call("GET", "$api/git/ref/heads/$branch", tok), "ref")
        val parent = headRef.getJSONObject("object").getString("sha")

        val tree = JSONArray()
        files.forEachIndexed { i, f ->
            progress("upload", f.name, i + 1, total)
            if (f.length() > 40L * 1024 * 1024) throw Fail("FILE_TOO_LARGE", f.name)
            val blob = ok(call("POST", "$api/git/blobs", tok, JSONObject()
                .put("content", Base64.encodeToString(f.readBytes(), Base64.NO_WRAP)).put("encoding", "base64")), "blob")
            tree.put(JSONObject().put("path", f.relativeTo(root).path.replace(File.separatorChar, '/'))
                .put("mode", "100644").put("type", "blob").put("sha", blob.getString("sha")))
        }
        val treeSha = ok(call("POST", "$api/git/trees", tok, JSONObject().put("tree", tree)), "tree").getString("sha")
        val commit = ok(call("POST", "$api/git/commits", tok, JSONObject()
            .put("message", "Forge build").put("tree", treeSha).put("parents", JSONArray().put(parent))), "commit").getString("sha")
        ok(call("PATCH", "$api/git/refs/heads/$branch", tok, JSONObject().put("sha", commit).put("force", true)), "updateRef")

        // The push triggers the workflow; give GitHub up to two minutes to create the run.
        progress("wait")
        var run: JSONObject? = null
        for (i in 0 until 24) {
            val runs = ok(call("GET", "$api/actions/runs?head_sha=$commit&per_page=10", tok), "runs").getJSONArray("workflow_runs")
            for (k in 0 until runs.length()) {
                val r = runs.getJSONObject(k)
                if (r.optString("path").endsWith("build-aab.yml")) { run = r; break }
            }
            if (run != null) break
            Thread.sleep(5000)
        }
        val runId = (run ?: throw Fail("WORKFLOW_NOT_STARTED")).getLong("id")

        var lastStep = ""
        val deadline = System.currentTimeMillis() + 30 * 60 * 1000
        var finished: JSONObject
        while (true) {
            finished = ok(call("GET", "$api/actions/runs/$runId", tok), "run")
            if (finished.getString("status") == "completed") break
            if (System.currentTimeMillis() > deadline) throw Fail("BUILD_TIMEOUT")
            val jobs = ok(call("GET", "$api/actions/runs/$runId/jobs", tok), "jobs").getJSONArray("jobs")
            for (j in 0 until jobs.length()) {
                val steps = jobs.getJSONObject(j).optJSONArray("steps") ?: continue
                for (s in 0 until steps.length()) if (steps.getJSONObject(s).getString("status") == "in_progress") lastStep = steps.getJSONObject(s).getString("name")
            }
            progress("building", lastStep)
            Thread.sleep(8000)
        }

        if (finished.optString("conclusion") != "success") {
            val info = failureInfo(api, runId, tok)
            emit("buildFailed", JSONObject().put("message", "BUILD_FAILED").put("step", info.first).put("excerpt", info.second).put("url", finished.optString("html_url")))
            return@bg
        }

        progress("download")
        val arts = ok(call("GET", "$api/actions/runs/$runId/artifacts", tok), "artifacts").getJSONArray("artifacts")
        var artId = -1L
        for (i in 0 until arts.length()) if (arts.getJSONObject(i).getString("name") == "unsigned-aab") artId = arts.getJSONObject(i).getLong("id")
        if (artId < 0) throw Fail("NO_ARTIFACT")

        val outRel = "$project/.forge/out/unsigned.aab"
        val out = store.resolve(outRel)
        out.parentFile?.mkdirs()
        // OkHttp drops the Authorization header when GitHub redirects the download to its blob storage host.
        val req = Request.Builder().url("$api/actions/artifacts/$artId/zip").header("Authorization", "Bearer $tok")
            .header("Accept", "application/vnd.github+json").build()
        var found = false
        try {
            client.newCall(req).execute().use { r ->
                if (r.code !in 200..299) throw Fail("API_download", "${r.code}")
                ZipInputStream(r.body!!.byteStream()).use { zin ->
                    var e = zin.nextEntry
                    while (e != null) {
                        if (e.name.endsWith(".aab")) { out.outputStream().use { zin.copyTo(it) }; found = true; break }
                        e = zin.nextEntry
                    }
                }
            }
        } catch (e: IOException) { throw Fail("NETWORK", e.message ?: "") }
        if (!found) throw Fail("NO_ARTIFACT")
        emit("buildDone", JSONObject().put("path", outRel).put("size", out.length()).put("url", finished.optString("html_url")))
    }

    /** Failed step name + the "What went wrong" block (or the last error lines) from the run logs. */
    private fun failureInfo(api: String, runId: Long, tok: String): Pair<String, String> {
        var step = ""
        try {
            val jobs = ok(call("GET", "$api/actions/runs/$runId/jobs", tok), "jobs").getJSONArray("jobs")
            for (j in 0 until jobs.length()) {
                val steps = jobs.getJSONObject(j).optJSONArray("steps") ?: continue
                for (s in 0 until steps.length()) if (steps.getJSONObject(s).optString("conclusion") == "failure") step = steps.getJSONObject(s).getString("name")
            }
        } catch (_: Exception) { /* keep empty step */ }

        val text = StringBuilder()
        try {
            val req = Request.Builder().url("$api/actions/runs/$runId/logs").header("Authorization", "Bearer $tok").build()
            client.newCall(req).execute().use { r ->
                if (r.code in 200..299) ZipInputStream(r.body!!.byteStream()).use { zin ->
                    var e = zin.nextEntry
                    while (e != null && text.length < 3_000_000) {
                        if (!e.isDirectory) text.append(zin.readBytes().toString(Charsets.UTF_8)).append('\n')
                        e = zin.nextEntry
                    }
                }
            }
        } catch (_: Exception) { /* logs are optional */ }

        val lines = text.lines().map { it.replace(Regex("^\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z "), "") }
        val i = lines.indexOfFirst { it.contains("What went wrong:") }
        val excerpt = if (i >= 0) lines.subList(i, minOf(lines.size, i + 12)).joinToString("\n")
        else lines.filter { it.contains("error", true) || it.contains("FAILED") }.takeLast(15).joinToString("\n")
        return step to excerpt.take(2500)
    }
}
