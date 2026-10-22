package app.wrapper

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import android.content.ClipData
import android.content.ClipboardManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.browser.customtabs.CustomTabsIntent
import com.google.firebase.messaging.FirebaseMessaging
import androidx.credentials.ClearCredentialStateRequest
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import androidx.lifecycle.lifecycleScope
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import kotlinx.coroutines.launch

object ForgeBridge {
    private const val HAS_CAMERA = true
    private const val HAS_MIC = true
    private const val HAS_LOCATION = true
    private const val HAS_NOTIFICATIONS = true

    /** True while the app is on screen (set from MainActivity). Used to decide how push messages are surfaced. */
    @Volatile var foreground = false
    @Volatile private var proxy: JavaScriptReplyProxy? = null
    @Volatile private var uiActivity: MainActivity? = null

    private const val SHIM = """
(function () {
  if (window.Forge) return;
  var pending = {};
  var seq = 0;
  __ForgeNative.onmessage = function (e) {
    var m = JSON.parse(e.data);
    if (m.event) { window.dispatchEvent(new CustomEvent('forge:' + m.event, { detail: m.data })); return; }
    var p = pending[m.id];
    if (!p) return;
    delete pending[m.id];
    if (m.ok) p.resolve(m.data);
    else { var err = new Error(m.error || 'Forge error'); err.code = m.code; p.reject(err); }
  };
  function call(op, args) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending[id] = { resolve: resolve, reject: reject };
      __ForgeNative.postMessage(JSON.stringify({ id: id, op: op, args: args || {} }));
    });
  }
  window.Forge = {
    version: 3,
    requestPermission: function (name) { return call('requestPermission', { name: name }).then(function (r) { return r.granted; }); },
    permissionStatus: function (name) { return call('permissionStatus', { name: name }).then(function (r) { return r.granted; }); },
    notify: function (options) { return call('notify', options); },
    share: function (options) { return call('share', options); },
    openDialer: function (number) { return call('openDialer', { number: number }); },
    openSms: function (number, body) { return call('openSms', { number: number, body: body || '' }); },
    openUrl: function (url) { return call('openUrl', { url: url }); },
    copyToClipboard: function (text) { return call('copyToClipboard', { text: text }); },
    vibrate: function (ms) { return call('vibrate', { ms: ms || 50 }); },
    oauth: function (url) { return call('oauth', { url: url }); },
    redirectUri: 'com.ahmed.shop://oauth',
    pushToken: function () { return call('pushToken').then(function (r) { return r.token; }); },
    subscribeTopic: function (topic) { return call('subscribeTopic', { topic: topic }); },
    unsubscribeTopic: function (topic) { return call('unsubscribeTopic', { topic: topic }); },
    googleSignIn: function (options) { return call('googleSignIn', options); },
    googleSignOut: function () { return call('googleSignOut'); }
  };
  if (typeof window.Notification === 'undefined') {
    var N = function (title, opts) { window.Forge.notify({ title: String(title), body: (opts && opts.body) || '' }); };
    N.permission = 'default';
    N.requestPermission = function () {
      return window.Forge.requestPermission('notifications').then(function (ok) { N.permission = ok ? 'granted' : 'denied'; return N.permission; });
    };
    window.Notification = N;
  }
  __ForgeNative.postMessage(JSON.stringify({ id: 0, op: 'hello', args: {} }));
})();
"""

    fun install(activity: MainActivity, web: WebView, origins: Set<String>) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
        uiActivity = activity
        WebViewCompat.addWebMessageListener(web, "__ForgeNative", origins) { _, message, _, isMainFrame, reply ->
            if (!isMainFrame) return@addWebMessageListener
            proxy = reply
            handle(activity, message.data ?: "", reply)
        }
        WebViewCompat.addDocumentStartJavaScript(web, SHIM, origins)
    }

    /** Pushes an event to the page (received with window.addEventListener('forge:<event>', e => e.detail)). */
    fun emit(event: String, data: JSONObject) {
        val p = proxy ?: return
        val a = uiActivity ?: return
        a.runOnUiThread { try { p.postMessage(JSONObject().put("event", event).put("data", data).toString()) } catch (_: Exception) { } }
    }

    private fun handle(activity: MainActivity, raw: String, reply: JavaScriptReplyProxy) {
        val msg = try { JSONObject(raw) } catch (e: Exception) { return }
        val id = msg.optInt("id")
        val args = msg.optJSONObject("args") ?: JSONObject()
        fun send(o: JSONObject) { activity.runOnUiThread { reply.postMessage(o.put("id", id).toString()) } }
        fun ok(data: JSONObject) = send(JSONObject().put("ok", true).put("data", data))
        fun fail(code: String, message: String) = send(JSONObject().put("ok", false).put("code", code).put("error", message))
        when (msg.optString("op")) {
            "hello" -> Unit
            "requestPermission" -> requestPermission(activity, args, ::ok, ::fail)
            "permissionStatus" -> permissionStatus(activity, args, ::ok, ::fail)
            "notify" -> notify(activity, args, ::ok, ::fail)
            "share" -> share(activity, args, ::ok, ::fail)
            "openDialer" -> openDialer(activity, args, ::ok, ::fail)
            "openSms" -> openSms(activity, args, ::ok, ::fail)
            "openUrl" -> openUrl(activity, args, ::ok, ::fail)
            "copyToClipboard" -> copyToClipboard(activity, args, ::ok, ::fail)
            "vibrate" -> vibrate(activity, args, ::ok, ::fail)
            "oauth" -> oauth(activity, args, ::ok, ::fail)
            "pushToken" -> pushToken(::ok, ::fail)
            "subscribeTopic" -> topic(true, args, ::ok, ::fail)
            "unsubscribeTopic" -> topic(false, args, ::ok, ::fail)
            "googleSignIn" -> googleSignIn(activity, args, ::ok, ::fail)
            "googleSignOut" -> googleSignOut(activity, ::ok, ::fail)
            else -> fail("UNSUPPORTED", "Unknown operation")
        }
    }

    /** Android permissions behind a capability name, or null if the app was built without that capability. */
    private fun permissionsFor(name: String): List<String>? = when (name) {
        "camera" -> if (HAS_CAMERA) listOf(android.Manifest.permission.CAMERA) else null
        "microphone" -> if (HAS_MIC) listOf(android.Manifest.permission.RECORD_AUDIO) else null
        "location" -> if (HAS_LOCATION) listOf(android.Manifest.permission.ACCESS_FINE_LOCATION, android.Manifest.permission.ACCESS_COARSE_LOCATION) else null
        "notifications" -> if (!HAS_NOTIFICATIONS) null else if (Build.VERSION.SDK_INT >= 33) listOf("android.permission.POST_NOTIFICATIONS") else emptyList()
        else -> null
    }

    private fun isGranted(activity: MainActivity, name: String): Boolean {
        val perms = permissionsFor(name) ?: return false
        if (name == "notifications" && Build.VERSION.SDK_INT < 33) return NotificationManagerCompat.from(activity).areNotificationsEnabled()
        if (perms.isEmpty()) return true
        fun has(p: String) = androidx.core.content.ContextCompat.checkSelfPermission(activity, p) == android.content.pm.PackageManager.PERMISSION_GRANTED
        return if (name == "location") perms.any { has(it) } else perms.all { has(it) }
    }

    private fun requestPermission(activity: MainActivity, args: JSONObject, ok: (JSONObject) -> Unit, fail: (String, String) -> Unit) {
        val name = args.optString("name")
        val perms = permissionsFor(name)
        if (perms == null) { fail("NOT_ENABLED", "This capability is not enabled for the app: " + name); return }
        activity.ensurePermissions(perms, requireAll = name != "location") { granted -> ok(JSONObject().put("granted", granted)) }
    }

    private fun permissionStatus(activity: MainActivity, args: JSONObject, ok: (JSONObject) -> Unit, fail: (String, String) -> Unit) {
        val name = args.optString("name")
        if (permissionsFor(name) == null) { fail("NOT_ENABLED", "This capability is not enabled for the app: " + name); return }
        ok(JSONObject().put("granted", isGranted(activity, name)))
    }

    /** Creates the notification channel up front so system-shown push notifications have a channel to use. */
    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT >= 26) {
            context.getSystemService(NotificationManager::class.java)
                .createNotificationChannel(NotificationChannel("default", "General", NotificationManager.IMPORTANCE_DEFAULT))
        }
    }

    @SuppressLint("MissingPermission")
    fun showNotification(context: Context, title: String, body: String, id: Int): Boolean {
        val nm = NotificationManagerCompat.from(context)
        if (!nm.areNotificationsEnabled()) return false
        ensureChannel(context)
        val open = PendingIntent.getActivity(
            context, 0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = NotificationCompat.Builder(context, "default")
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        return try { nm.notify(id, n); true } catch (e: SecurityException) { false }
    }

    private fun notify(activity: MainActivity, args: JSONObject, ok: (JSONObject) -> Unit, fail: (String, String) -> Unit) {
        val title = args.optString("title")
        val body = args.optString("body")
        if (title.isEmpty()) { fail("BAD_ARGS", "title is required"); return }
        activity.ensurePermissions(permissionsFor("notifications") ?: emptyList()) { granted ->
            val id = args.optInt("id", (System.currentTimeMillis() % 1_000_000).toInt())
            if (granted && showNotification(activity, title, body, id)) ok(JSONObject().put("id", id))
            else fail("PERMISSION_DENIED", "Notifications are not allowed for this app")
        }
    }

    private val PHONE = Regex("[+0-9*#() .-]{3,32}")

    private fun launch(activity: MainActivity, intent: Intent, ok: (JSONObject) -> Unit, fail: (String, String) -> Unit) {
        try { activity.startActivity(intent); ok(JSONObject()) } catch (e: Exception) { fail("FAILED", e.message ?: "No app can handle this action") }
    }

    private fun share(activity: MainActivity, args: JSONObject, ok: (JSONObject) -> Unit, fail: (String, String) -> Unit) {
        val text = listOf(args.optString("text"), args.optString("url")).filter { it.isNotEmpty() }.joinToString("\n")
        if (text.isEmpty()) { fail("BAD_ARGS", "text or url is required"); return }
        val title = args.optString("title")
        val i = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
        if (title.isNotEmpty()) i.putExtra(Intent.EXTRA_SUBJECT, title)
        launch(activity, Intent.createChooser(i, title.ifEmpty { null }), ok, fail)
    }

    // Opens the phone / messages app with the number filled in; the user confirms. No CALL_PHONE or SEND_SMS permission is needed.
    private fun openDialer(activity: MainActivity, args: JSONObject, ok: (JSONObject) -> Unit, fail: (String, String) -> Unit) {
        val n = args.optString("number").trim()
        if (!PHONE.matches(n)) { fail("BAD_ARGS", "Invalid phone number"); return }
        launch(activity, Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(n))), ok, fail)
    }

    private fun openSms(activity: MainActivity, args: JSONObject, ok: (JSONObject) -> Unit, fail: (String, String) -> Unit) {
        val n = args.optString("number").trim()
        if (!PHONE.matches(n)) { fail("BAD_ARGS", "Invalid phone number"); return }
        launch(activity, Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + Uri.encode(n))).putExtra("sms_body", args.optString("body")), ok, fail)
    }

    private fun openUrl(activity: MainActivity, args: JSONObject, ok: (JSONObject) -> Unit, fail: (String, String) -> Unit) {
        val u = Uri.parse(args.optString("url"))
        if (u.scheme != "https" && u.scheme != "mailto") { fail("BAD_ARGS", "Only https: and mailto: links can be opened"); return }
        launch(activity, Intent(Intent.ACTION_VIEW, u), ok, fail)
    }

    private fun copyToClipboard(activity: MainActivity, args: JSONObject, ok: (JSONObject) -> Unit, fail: (String, String) -> Unit) {
        try {
            val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("text", args.optString("text")))
            ok(JSONObject())
        } catch (e: Exception) { fail("FAILED", e.message ?: "Could not copy") }
    }

    @Suppress("DEPRECATION")
    private fun vibrate(activity: MainActivity, args: JSONObject, ok: (JSONObject) -> Unit, fail: (String, String) -> Unit) {
        val ms = args.optLong("ms", 50).coerceIn(1L, 2000L)
        try {
            val v = if (Build.VERSION.SDK_INT >= 31) activity.getSystemService(VibratorManager::class.java).defaultVibrator
            else activity.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
            if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE)) else v.vibrate(ms)
            ok(JSONObject())
        } catch (e: Exception) { fail("FAILED", e.message ?: "Could not vibrate") }
    }

    // Custom Tabs sign-in for any OAuth provider: the page builds the https authorize URL (with redirect_uri = Forge.redirectUri),
    // the system browser handles the login, and the redirect comes back here through the app's custom scheme.
    private const val OAUTH_SCHEME = "com.ahmed.shop"
    private var pendingOk: ((JSONObject) -> Unit)? = null
    private var pendingFail: ((String, String) -> Unit)? = null
    private var oauthPaused = false

    private fun clearOAuth() { pendingOk = null; pendingFail = null; oauthPaused = false }

    private fun oauth(activity: MainActivity, args: JSONObject, ok: (JSONObject) -> Unit, fail: (String, String) -> Unit) {
        val u = Uri.parse(args.optString("url"))
        if (u.scheme != "https") { fail("BAD_ARGS", "The authorize URL must be https"); return }
        pendingFail?.invoke("CANCELLED", "Superseded by a new sign-in")
        pendingOk = ok; pendingFail = fail; oauthPaused = false
        try { CustomTabsIntent.Builder().build().launchUrl(activity, u) }
        catch (e: Exception) { clearOAuth(); fail("FAILED", e.message ?: "No browser is available") }
    }

    fun onNewIntent(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme != OAUTH_SCHEME) return
        val ok = pendingOk
        clearOAuth()
        ok?.invoke(JSONObject().put("url", data.toString()))
    }

    fun onPause() { if (pendingOk != null) oauthPaused = true }

    /** Back from the browser without a redirect means the user closed it. */
    fun onResume(activity: MainActivity) {
        if (pendingOk == null || !oauthPaused) return
        activity.window.decorView.postDelayed({
            val f = pendingFail
            if (pendingOk != null) { clearOAuth(); f?.invoke("CANCELLED", "The user closed the browser") }
        }, 700)
    }

    private fun pushToken(ok: (JSONObject) -> Unit, fail: (String, String) -> Unit) {
        FirebaseMessaging.getInstance().token.addOnCompleteListener { t ->
            if (t.isSuccessful) ok(JSONObject().put("token", t.result)) else fail("FAILED", t.exception?.message ?: "Could not get the push token")
        }
    }

    private fun topic(subscribe: Boolean, args: JSONObject, ok: (JSONObject) -> Unit, fail: (String, String) -> Unit) {
        val name = args.optString("topic")
        if (!Regex("[a-zA-Z0-9-_.~%]{1,200}").matches(name)) { fail("BAD_ARGS", "Invalid topic name"); return }
        val fm = FirebaseMessaging.getInstance()
        val task = if (subscribe) fm.subscribeToTopic(name) else fm.unsubscribeFromTopic(name)
        task.addOnCompleteListener { t -> if (t.isSuccessful) ok(JSONObject()) else fail("FAILED", t.exception?.message ?: "Topic request failed") }
    }

    private fun googleSignIn(activity: MainActivity, args: JSONObject, ok: (JSONObject) -> Unit, fail: (String, String) -> Unit) {
        val builder = GetSignInWithGoogleOption.Builder(activity.getString(R.string.default_web_client_id))
        val nonce = args.optString("nonce")
        if (nonce.isNotEmpty()) builder.setNonce(nonce)
        val request = GetCredentialRequest.Builder().addCredentialOption(builder.build()).build()
        activity.lifecycleScope.launch {
            try {
                val cred = CredentialManager.create(activity).getCredential(activity, request).credential
                if (cred is CustomCredential && cred.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                    val g = GoogleIdTokenCredential.createFrom(cred.data)
                    ok(JSONObject()
                        .put("idToken", g.idToken)
                        .put("email", g.id)
                        .put("name", g.displayName ?: "")
                        .put("givenName", g.givenName ?: "")
                        .put("familyName", g.familyName ?: "")
                        .put("photo", g.profilePictureUri?.toString() ?: ""))
                } else fail("UNSUPPORTED_CREDENTIAL", "Unexpected credential type")
            } catch (e: GetCredentialCancellationException) {
                fail("CANCELLED", "The user closed the sign-in sheet")
            } catch (e: NoCredentialException) {
                fail("NO_CREDENTIAL", "No Google account is available on this device")
            } catch (e: GetCredentialException) {
                fail("FAILED", e.message ?: e.type)
            } catch (e: Exception) {
                fail("FAILED", e.message ?: "Sign-in failed")
            }
        }
    }

    private fun googleSignOut(activity: MainActivity, ok: (JSONObject) -> Unit, fail: (String, String) -> Unit) {
        activity.lifecycleScope.launch {
            try {
                CredentialManager.create(activity).clearCredentialState(ClearCredentialStateRequest())
                ok(JSONObject())
            } catch (e: Exception) { fail("FAILED", e.message ?: "Sign-out failed") }
        }
    }
}
