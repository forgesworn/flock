package cc.trotters.flock.publish

import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONArray
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals

class RelayPublisherTest {
    private fun relayThatAccepts(): MockWebServer {
        val server = MockWebServer()
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = JSONArray(text)
                if (msg.getString(0) == "EVENT") {
                    val id = msg.getJSONObject(1).getString("id")
                    webSocket.send("""["OK","$id",true,""]""")
                }
            }
        }))
        return server
    }

    @Test
    fun `counts relays that OK the event`() {
        val server = relayThatAccepts()
        server.start()
        val url = "ws://${server.hostName}:${server.port}/"
        val n = OkHttpRelayPublisher(timeoutMs = 5_000)
            .publish(listOf(url), """{"id":"abc123","kind":1059,"content":"x","tags":[],"pubkey":"p","sig":"s","created_at":1}""")
        assertEquals(1, n)
        server.shutdown()
    }

    @Test
    fun `unreachable relay counts zero without throwing`() {
        val n = OkHttpRelayPublisher(timeoutMs = 1_000)
            .publish(listOf("ws://127.0.0.1:1/"), """{"id":"abc123"}""")
        assertEquals(0, n)
    }

    @Test
    fun `unparseable event json returns zero`() {
        val n = OkHttpRelayPublisher(timeoutMs = 1_000)
            .publish(listOf("ws://127.0.0.1:1/"), "{not json")
        assertEquals(0, n)
    }

    @Test
    fun `malformed relay url counts zero without throwing`() {
        val validEventJson = """{"id":"abc123","kind":1059,"content":"x","tags":[],"pubkey":"p","sig":"s","created_at":1}"""
        val n = OkHttpRelayPublisher(timeoutMs = 1_000)
            .publish(listOf("not a url"), validEventJson)
        assertEquals(0, n)
    }
}
