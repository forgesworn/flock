package cc.trotters.flock.publish

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private class FakeStore(var config: String?) : ConfigStore {
    val cadences = HashMap<String, BeaconCadence>()
    val journal = ArrayList<String>()
    override fun getConfigJson() = config
    override fun getCadence(circleId: String) = cadences[circleId] ?: BeaconCadence(null, 0)
    override fun setCadence(circleId: String, cadence: BeaconCadence) { cadences[circleId] = cadence }
    override fun appendJournal(entryJson: String) { journal.add(entryJson) }
}

private class FakeRelays(var accept: Int) : RelayPublisher {
    val published = ArrayList<String>()
    override fun publish(relayUrls: List<String>, eventJson: String): Int {
        published.add(eventJson); return accept
    }
}

class PublisherTest {
    private val v = loadVectors()
    private fun config(zones: String = "[]", offGridUntil: Long = 0) = """
      {"v":1,"skHex":"${v.getString("identitySkHex")}","circleId":"${v.getString("circleId")}",
       "seedHex":"${v.getString("seedHex")}","precision":6,"festivalUntil":0,
       "relayUrls":["wss://r"],"offGridUntil":$offGridUntil,"noReportZones":$zones}
    """.trimIndent()

    private fun publisher(store: FakeStore, relays: FakeRelays, foreground: Boolean = false, now: Long = 1_751_700_000) =
        FlockPublisher(store, relays, { foreground }, { now }, { 0.5 })

    @Test
    fun `publishes a beacon and records cadence + journal`() {
        val store = FakeStore(config()); val relays = FakeRelays(1)
        publisher(store, relays).onFix(51.5007, -0.1246, 10.0, 1_751_699_000_000)
        assertEquals(1, relays.published.size)
        val cad = store.getCadence(v.getString("circleId"))
        assertEquals("gcpuvp", cad.lastGeohash)
        assertTrue(store.journal.any { it.contains("\"t\":\"pub\"") && it.contains("gcpuvp") })
        assertTrue(store.journal.any { it.contains("\"t\":\"fix\"") })
    }

    @Test
    fun `foreground drops silently (JS owns it)`() {
        val store = FakeStore(config()); val relays = FakeRelays(1)
        publisher(store, relays, foreground = true).onFix(51.5, -0.12, 10.0, 0)
        assertEquals(0, relays.published.size)
        assertTrue(store.journal.isEmpty())
    }

    @Test
    fun `absent or malformed config idles`() {
        for (cfg in listOf(null, "{broken")) {
            val store = FakeStore(cfg); val relays = FakeRelays(1)
            publisher(store, relays).onFix(51.5, -0.12, 10.0, 0)
            assertEquals(0, relays.published.size)
        }
    }

    @Test
    fun `off-grid suppresses`() {
        val store = FakeStore(config(offGridUntil = 9_999_999_999)); val relays = FakeRelays(1)
        publisher(store, relays).onFix(51.5, -0.12, 10.0, 0)
        assertEquals(0, relays.published.size)
    }

    @Test
    fun `a withhold no-report zone suppresses (fail-safe with accuracy)`() {
        val zones = """[{"policy":"withhold","area":{"kind":"circle","centre":{"lat":51.5007,"lon":-0.1246},"radiusMetres":200}}]"""
        val store = FakeStore(config(zones)); val relays = FakeRelays(1)
        publisher(store, relays).onFix(51.5007, -0.1246, 50.0, 0)
        assertEquals(0, relays.published.size)
        assertEquals(null, store.getCadence(v.getString("circleId")).lastGeohash)
    }

    @Test
    fun `cadence suppresses an identical cell inside the heartbeat`() {
        val store = FakeStore(config()); val relays = FakeRelays(1)
        val p1 = publisher(store, relays, now = 1_751_700_000)
        p1.onFix(51.5007, -0.1246, 10.0, 0)
        val p2 = publisher(store, relays, now = 1_751_700_100) // 100 s later, same cell, < 300 s heartbeat
        p2.onFix(51.5007, -0.1246, 10.0, 0)
        assertEquals(1, relays.published.size)
    }

    @Test
    fun `failed publish leaves cadence untouched so the next fix retries`() {
        val store = FakeStore(config()); val relays = FakeRelays(0)
        publisher(store, relays).onFix(51.5007, -0.1246, 10.0, 0)
        assertEquals(null, store.getCadence(v.getString("circleId")).lastGeohash)
        assertTrue(store.journal.none { it.contains("\"t\":\"pub\"") })
    }
}
