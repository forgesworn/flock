package cc.trotters.flock.publish

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private class FakeStore(var config: String?) : ConfigStore {
    val cadences = HashMap<String, BeaconCadence>()
    val covers = HashMap<String, Long>()
    val journal = ArrayList<String>()
    override fun getConfigJson() = config
    override fun getCadence(circleId: String) = cadences[circleId] ?: BeaconCadence(null, 0)
    override fun setCadence(circleId: String, cadence: BeaconCadence) { cadences[circleId] = cadence }
    override fun getCoverAt(circleId: String) = covers[circleId] ?: 0L
    override fun setCoverAt(circleId: String, at: Long) { covers[circleId] = at }
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
        // The real beacon is suppressed, but a low-rate cover decoy fills the gap
        // (100 s ≥ the 90 s cover interval): one real send + one cover on the wire.
        assertEquals(2, relays.published.size)
        // The cover records neither beacon cadence (stays the first cell) nor a pub
        // journal entry — it is pure timing hygiene, not a disclosure.
        assertEquals("gcpuvp", store.getCadence(v.getString("circleId")).lastGeohash)
        assertEquals(1, store.journal.count { it.contains("\"t\":\"pub\"") })
    }

    @Test
    fun `cover holds off inside its own interval`() {
        val store = FakeStore(config()); val relays = FakeRelays(1)
        publisher(store, relays, now = 1_751_700_000).onFix(51.5007, -0.1246, 10.0, 0) // real send, coverAt := T
        publisher(store, relays, now = 1_751_700_100).onFix(51.5007, -0.1246, 10.0, 0) // +100 s → cover fires
        publisher(store, relays, now = 1_751_700_140).onFix(51.5007, -0.1246, 10.0, 0) // +40 s < 90 s → no cover
        assertEquals(2, relays.published.size)
    }

    @Test
    fun `off-grid suppresses cover too`() {
        val store = FakeStore(config(offGridUntil = 9_999_999_999)); val relays = FakeRelays(1)
        publisher(store, relays).onFix(51.5, -0.12, 10.0, 0)
        assertEquals(0, relays.published.size) // neither a beacon nor a cover leaves an off-grid phone
    }

    @Test
    fun `failed publish leaves cadence untouched so the next fix retries`() {
        val store = FakeStore(config()); val relays = FakeRelays(0)
        publisher(store, relays).onFix(51.5007, -0.1246, 10.0, 0)
        assertEquals(null, store.getCadence(v.getString("circleId")).lastGeohash)
        assertTrue(store.journal.none { it.contains("\"t\":\"pub\"") })
    }

    private fun sessionConfig(zones: String = "[]") = """
      {"v":1,"skHex":"${v.getString("identitySkHex")}","circleId":"${v.getString("circleId")}",
       "seedHex":"${v.getString("seedHex")}","precision":6,"festivalUntil":0,
       "relayUrls":["wss://r"],"offGridUntil":0,"noReportZones":$zones,
       "sessionMinIntervalSec":5,"sessionHeartbeatSec":30,"sessionUntilSec":9999999999}
    """.trimIndent()

    @Test
    fun `a live radar session lifts the published beacon to Exact precision`() {
        val store = FakeStore(sessionConfig()); val relays = FakeRelays(1)
        publisher(store, relays).onFix(51.5007, -0.1246, 10.0, 1_751_699_000_000)
        assertEquals(1, relays.published.size)
        // Emitted at Exact (9), not the base slider precision (6): the JS autoEmit twin.
        assertTrue(store.journal.any { it.contains("\"t\":\"pub\"") && it.contains("\"p\":9") })
    }

    @Test
    fun `a session lift is re-coarsened to the base share inside a coarse no-report zone`() {
        val zones = """[{"policy":"coarse","area":{"kind":"circle","centre":{"lat":51.5007,"lon":-0.1246},"radiusMetres":200}}]"""
        val store = FakeStore(sessionConfig(zones)); val relays = FakeRelays(1)
        publisher(store, relays).onFix(51.5007, -0.1246, 10.0, 1_751_699_000_000)
        assertEquals(1, relays.published.size)
        // A session never overrides geography policy: over a sensitive address the
        // Exact lift caps back to the base share (6), never leaking the building.
        assertTrue(store.journal.any { it.contains("\"t\":\"pub\"") && it.contains("\"p\":6") })
    }

    @Test
    fun `malformed skHex does not throw — build failure retries like publish failure`() {
        // Config with odd-length (invalid) skHex — buildBeaconWrapJson will throw
        val badConfig = """
          {"v":1,"skHex":"abc","circleId":"${v.getString("circleId")}",
           "seedHex":"${v.getString("seedHex")}","precision":6,"festivalUntil":0,
           "relayUrls":["wss://r"],"offGridUntil":0,"noReportZones":[]}
        """.trimIndent()
        val store = FakeStore(badConfig); val relays = FakeRelays(1)
        // onFix must not throw; exception from buildBeaconWrapJson is caught
        publisher(store, relays).onFix(51.5007, -0.1246, 10.0, 1_751_699_000_000)
        // Nothing published
        assertEquals(0, relays.published.size)
        // Cadence untouched (no retry gating)
        assertEquals(null, store.getCadence(v.getString("circleId")).lastGeohash)
        // No "pub" entry; "fix" is still recorded
        assertTrue(store.journal.any { it.contains("\"t\":\"fix\"") })
        assertTrue(store.journal.none { it.contains("\"t\":\"pub\"") })
    }
}
