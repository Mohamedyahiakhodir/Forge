package app.wrapper

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject

class ForgeMessagingService : FirebaseMessagingService() {
    // Called for every message while the app is open, and for data-only messages when it is closed.
    // Notification messages received in the background are shown by the system and do not reach this method.
    override fun onMessageReceived(message: RemoteMessage) {
        val data = JSONObject()
        for ((k, v) in message.data) data.put(k, v)
        val title = message.notification?.title ?: message.data["title"] ?: ""
        val body = message.notification?.body ?: message.data["body"] ?: ""
        ForgeBridge.emit("push", JSONObject().put("title", title).put("body", body).put("data", data))
        if (!ForgeBridge.foreground && message.notification == null && (title.isNotEmpty() || body.isNotEmpty())) {
            ForgeBridge.showNotification(this, title, body, (System.currentTimeMillis() % 1_000_000).toInt())
        }
    }

    override fun onNewToken(token: String) {
        ForgeBridge.emit("pushToken", JSONObject().put("token", token))
    }
}
