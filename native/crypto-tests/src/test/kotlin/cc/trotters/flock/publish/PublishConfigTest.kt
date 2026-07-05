package cc.trotters.flock.publish

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PublishConfigTest {
    private val json = """
      {"v":1,"skHex":"aa","circleId":"c1","seedHex":"bb","precision":6,
       "festivalUntil":0,"relayUrls":["wss://r1","wss://r2"],"offGridUntil":0,
       "noReportZones":[
         {"policy":"withhold","area":{"kind":"circle","centre":{"lat":51.5,"lon":-0.12},"radiusMetres":200}},
         {"area":{"kind":"polygon","vertices":[{"lat":1,"lon":1},{"lat":1,"lon":2},{"lat":2,"lon":2}]}}
       ]}
    """.trimIndent()

    @Test
    fun `parses the mirror shape`() {
        val c = parsePublishConfig(json)!!
        assertEquals("c1", c.circleId)
        assertEquals(listOf("wss://r1", "wss://r2"), c.relayUrls)
        assertEquals(2, c.zones.size)
        assertEquals("withhold", c.zones[0].policy)
        assertEquals("withhold", c.zones[1].policy) // unset policy defaults to withhold (noreport.ts)
        assertTrue(c.zones[1].area is Geofence.Polygon)
    }

    @Test fun `garbage returns null`() = assertNull(parsePublishConfig("{not json"))
    @Test fun `wrong version returns null`() = assertNull(parsePublishConfig("""{"v":2}"""))

    @Test
    fun `effective precision boosts to 9 during festival and clamps`() {
        val c = parsePublishConfig(json)!!
        assertEquals(6, effectivePrecision(c, 1000))
        assertEquals(9, effectivePrecision(c.copy(festivalUntil = 2000), 1000))
        assertEquals(6, effectivePrecision(c.copy(festivalUntil = 500), 1000)) // expired
        assertEquals(3, effectivePrecision(c.copy(precision = 1), 1000))       // clamp floor
        assertEquals(9, effectivePrecision(c.copy(precision = 99), 1000))      // clamp ceiling
    }
}
