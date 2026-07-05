package cc.trotters.flock.publish

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** One-shot relay publish — services.ts fanOut twin: success = ≥1 relay OK. */
interface RelayPublisher {
    /** @return how many relays answered `["OK", id, true]` before the timeout. */
    fun publish(relayUrls: List<String>, eventJson: String): Int
}

class OkHttpRelayPublisher(private val timeoutMs: Long = 10_000) : RelayPublisher {
    private val client = OkHttpClient.Builder()
        .connectTimeout(timeoutMs, TimeUnit.MILLISECONDS)
        .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
        .build()

    override fun publish(relayUrls: List<String>, eventJson: String): Int {
        val eventId = try { JSONObject(eventJson).getString("id") } catch (_: Exception) { return 0 }
        val accepted = AtomicInteger(0)
        val done = CountDownLatch(relayUrls.size)
        val sockets = relayUrls.map { url ->
            client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    webSocket.send("""["EVENT",$eventJson]""")
                }
                override fun onMessage(webSocket: WebSocket, text: String) {
                    try {
                        val msg = JSONArray(text)
                        if (msg.getString(0) == "OK" && msg.getString(1) == eventId) {
                            if (msg.getBoolean(2)) accepted.incrementAndGet()
                            webSocket.close(1000, null)
                            done.countDown()
                        }
                    } catch (_: Exception) { /* ignore non-protocol chatter */ }
                }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    done.countDown()
                }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { /* counted on OK */ }
            })
        }
        done.await(timeoutMs, TimeUnit.MILLISECONDS)
        sockets.forEach { it.cancel() }
        return accepted.get()
    }
}
