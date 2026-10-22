import type { PublishConfig } from './config';

export const needsBridge = (c: PublishConfig): boolean => c.googleSignIn || c.camera || c.microphone || c.location || c.notifications;

/**
 * Generates ForgeBridge.kt for the packaged app. Only the capabilities the user enabled are emitted, so unused
 * libraries (Credential Manager, notifications) are never required by the build.
 * The shim is injected before page scripts, only on the app's own origin and never into iframes.
 */
export function forgeBridgeKt(c: PublishConfig): string {
  const gsi = c.googleSignIn;
  const notif = c.notifications;

  const methods = [
    `requestPermission: function (name) { return call('requestPermission', { name: name }).then(function (r) { return r.granted; }); }`,
    `permissionStatus: function (name) { return call('permissionStatus', { name: name }).then(function (r) { return r.granted; }); }`,
    ...(notif ? [`notify: function (options) { return call('notify', options); }`] : []),
    ...(gsi ? [`googleSignIn: function (options) { return call('googleSignIn', options); }`, `googleSignOut: function () { return call('googleSignOut'); }`] : []),
  ].join(',\n    ');

  const notifPolyfill = notif ? `
  if (typeof window.Notification === 'undefined') {
    var N = function (title, opts) { window.Forge.notify({ title: String(title), body: (opts && opts.body) || '' }); };
    N.permission = 'default';
    N.requestPermission = function () {
      return window.Forge.requestPermission('notifications').then(function (ok) { N.permission = ok ? 'granted' : 'denied'; return N.permission; });
    };
    window.Notification = N;
  }` : '';

  const imports = [
    'import android.webkit.WebView',
    'import androidx.webkit.JavaScriptReplyProxy',
    'import androidx.webkit.WebViewCompat',
    'import androidx.webkit.WebViewFeature',
    'import org.json.JSONObject',
    ...(notif ? [
      'import android.annotation.SuppressLint',
      'import android.app.NotificationChannel',
      'import android.app.NotificationManager',
      'import android.app.PendingIntent',
      'import android.content.Intent',
      'import android.os.Build',
      'import androidx.core.app.NotificationCompat',
      'import androidx.core.app.NotificationManagerCompat',
    ] : []),
    ...(gsi ? [
      'import androidx.credentials.ClearCredentialStateRequest',
      'import androidx.credentials.CredentialManager',
      'import androidx.credentials.CustomCredential',
      'import androidx.credentials.GetCredentialRequest',
      'import androidx.credentials.exceptions.GetCredentialCancellationException',
      'import androidx.credentials.exceptions.GetCredentialException',
      'import androidx.credentials.exceptions.NoCredentialException',
      'import androidx.lifecycle.lifecycleScope',
      'import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption',
      'import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential',
      'import kotlinx.coroutines.launch',
    ] : []),
  ].join('\n');

  const ops = [
    `            "requestPermission" -> requestPermission(activity, args, ::ok, ::fail)`,
    `            "permissionStatus" -> permissionStatus(activity, args, ::ok, ::fail)`,
    ...(notif ? [`            "notify" -> notify(activity, args, ::ok, ::fail)`] : []),
    ...(gsi ? [`            "googleSignIn" -> googleSignIn(activity, args, ::ok, ::fail)`, `            "googleSignOut" -> googleSignOut(activity, ::ok, ::fail)`] : []),
  ].join('\n');

  const notifStatus = notif ? `
        if (name == "notifications" && Build.VERSION.SDK_INT < 33) return NotificationManagerCompat.from(activity).areNotificationsEnabled()` : '';

  const notifCode = notif ? `
    @SuppressLint("MissingPermission")
    private fun notify(activity: MainActivity, args: JSONObject, ok: (JSONObject) -> Unit, fail: (String, String) -> Unit) {
        val title = args.optString("title")
        val body = args.optString("body")
        if (title.isEmpty()) { fail("BAD_ARGS", "title is required"); return }
        activity.ensurePermissions(permissionsFor("notifications") ?: emptyList()) { granted ->
            if (!granted || !NotificationManagerCompat.from(activity).areNotificationsEnabled()) {
                fail("PERMISSION_DENIED", "Notifications are not allowed for this app")
                return@ensurePermissions
            }
            if (Build.VERSION.SDK_INT >= 26) {
                activity.getSystemService(NotificationManager::class.java)
                    .createNotificationChannel(NotificationChannel("default", "General", NotificationManager.IMPORTANCE_DEFAULT))
            }
            val open = PendingIntent.getActivity(
                activity, 0,
                Intent(activity, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val n = NotificationCompat.Builder(activity, "default")
                .setSmallIcon(R.drawable.ic_stat_notify)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setContentIntent(open)
                .setAutoCancel(true)
                .build()
            val id = args.optInt("id", (System.currentTimeMillis() % 1_000_000).toInt())
            try { NotificationManagerCompat.from(activity).notify(id, n); ok(JSONObject().put("id", id)) }
            catch (e: SecurityException) { fail("PERMISSION_DENIED", "Notifications are not allowed for this app") }
        }
    }
` : '';

  const gsiCode = gsi ? `
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
` : '';

  return `package app.wrapper

${imports}

object ForgeBridge {
    private const val HAS_CAMERA = ${c.camera}
    private const val HAS_MIC = ${c.microphone}
    private const val HAS_LOCATION = ${c.location}
    private const val HAS_NOTIFICATIONS = ${c.notifications}

    private const val SHIM = """
(function () {
  if (window.Forge) return;
  var pending = {};
  var seq = 0;
  __ForgeNative.onmessage = function (e) {
    var m = JSON.parse(e.data);
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
    version: 2,
    ${methods}
  };${notifPolyfill}
})();
"""

    fun install(activity: MainActivity, web: WebView, origins: Set<String>) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
        WebViewCompat.addWebMessageListener(web, "__ForgeNative", origins) { _, message, _, isMainFrame, reply ->
            if (!isMainFrame) return@addWebMessageListener
            handle(activity, message.data ?: "", reply)
        }
        WebViewCompat.addDocumentStartJavaScript(web, SHIM, origins)
    }

    private fun handle(activity: MainActivity, raw: String, reply: JavaScriptReplyProxy) {
        val msg = try { JSONObject(raw) } catch (e: Exception) { return }
        val id = msg.optInt("id")
        val args = msg.optJSONObject("args") ?: JSONObject()
        fun send(o: JSONObject) { activity.runOnUiThread { reply.postMessage(o.put("id", id).toString()) } }
        fun ok(data: JSONObject) = send(JSONObject().put("ok", true).put("data", data))
        fun fail(code: String, message: String) = send(JSONObject().put("ok", false).put("code", code).put("error", message))
        when (msg.optString("op")) {
${ops}
            else -> fail("UNSUPPORTED", "Unknown operation")
        }
    }

    /** Android permissions behind a capability name, or null if the app was built without that capability. */
    private fun permissionsFor(name: String): List<String>? = when (name) {
        "camera" -> if (HAS_CAMERA) listOf(android.Manifest.permission.CAMERA) else null
        "microphone" -> if (HAS_MIC) listOf(android.Manifest.permission.RECORD_AUDIO) else null
        "location" -> if (HAS_LOCATION) listOf(android.Manifest.permission.ACCESS_FINE_LOCATION, android.Manifest.permission.ACCESS_COARSE_LOCATION) else null
        "notifications" -> if (!HAS_NOTIFICATIONS) null else if (android.os.Build.VERSION.SDK_INT >= 33) listOf("android.permission.POST_NOTIFICATIONS") else emptyList()
        else -> null
    }

    private fun isGranted(activity: MainActivity, name: String): Boolean {
        val perms = permissionsFor(name) ?: return false${notifStatus}
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
${notifCode}${gsiCode}}
`;
}
