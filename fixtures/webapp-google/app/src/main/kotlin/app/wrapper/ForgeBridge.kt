package app.wrapper

import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import androidx.credentials.ClearCredentialStateRequest
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import androidx.lifecycle.lifecycleScope
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import kotlinx.coroutines.launch
import org.json.JSONObject

object ForgeBridge {
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
    version: 1,
    googleSignIn: function (options) { return call('googleSignIn', options); },
    googleSignOut: function () { return call('googleSignOut'); }
  };
})();
"""

    fun install(activity: AppCompatActivity, web: WebView, origins: Set<String>) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
        WebViewCompat.addWebMessageListener(web, "__ForgeNative", origins) { _, message, _, isMainFrame, reply ->
            if (!isMainFrame) return@addWebMessageListener
            handle(activity, message.data ?: "", reply)
        }
        WebViewCompat.addDocumentStartJavaScript(web, SHIM, origins)
    }

    private fun handle(activity: AppCompatActivity, raw: String, reply: JavaScriptReplyProxy) {
        val msg = try { JSONObject(raw) } catch (e: Exception) { return }
        val id = msg.optInt("id")
        val args = msg.optJSONObject("args") ?: JSONObject()
        fun send(o: JSONObject) { activity.runOnUiThread { reply.postMessage(o.put("id", id).toString()) } }
        fun ok(data: JSONObject) = send(JSONObject().put("ok", true).put("data", data))
        fun fail(code: String, message: String) = send(JSONObject().put("ok", false).put("code", code).put("error", message))
        when (msg.optString("op")) {
            "googleSignIn" -> googleSignIn(activity, args, ::ok, ::fail)
            "googleSignOut" -> googleSignOut(activity, ::ok, ::fail)
            else -> fail("UNSUPPORTED", "Unknown operation")
        }
    }

    private fun googleSignIn(activity: AppCompatActivity, args: JSONObject, ok: (JSONObject) -> Unit, fail: (String, String) -> Unit) {
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

    private fun googleSignOut(activity: AppCompatActivity, ok: (JSONObject) -> Unit, fail: (String, String) -> Unit) {
        activity.lifecycleScope.launch {
            try {
                CredentialManager.create(activity).clearCredentialState(ClearCredentialStateRequest())
                ok(JSONObject())
            } catch (e: Exception) { fail("FAILED", e.message ?: "Sign-out failed") }
        }
    }
}
