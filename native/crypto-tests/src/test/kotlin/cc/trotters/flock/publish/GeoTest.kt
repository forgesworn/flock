package cc.trotters.flock.publish

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class GeoTest {
    private val home = NoReportZone(Geofence.Circle(LatLng(51.5, -0.12), 200.0), "withhold")
    private val nans = NoReportZone(Geofence.Circle(LatLng(51.6, -0.10), 200.0), "coarse")
    private val square = NoReportZone(
        Geofence.Polygon(listOf(LatLng(51.49, -0.13), LatLng(51.49, -0.11), LatLng(51.51, -0.11), LatLng(51.51, -0.13))),
        "withhold",
    )

    @Test fun `confidently outside every zone is null`() =
        assertNull(noReportPolicyAt(LatLng(52.0, 0.5), listOf(home, nans, square), 25.0))

    @Test fun `crisply inside a withhold circle withholds`() =
        assertEquals("withhold", noReportPolicyAt(LatLng(51.5, -0.12), listOf(home), 0.0))

    @Test fun `possibly inside counts as inside (fail-safe)`() {
        // ~250 m east of the 200 m circle's centre, accuracy 100 m — the disc may cover it.
        assertEquals("withhold", noReportPolicyAt(LatLng(51.5, -0.1164), listOf(home), 100.0))
    }

    @Test fun `confidently outside with a tight fix is null`() =
        assertNull(noReportPolicyAt(LatLng(51.5, -0.1164), listOf(home), 10.0))

    @Test fun `withhold beats coarse across zones`() {
        val at = LatLng(51.5, -0.12) // inside home (withhold) and the polygon
        assertEquals("withhold", noReportPolicyAt(at, listOf(nans, home), 0.0))
    }

    @Test fun `coarse-only zone reports coarse`() =
        assertEquals("coarse", noReportPolicyAt(LatLng(51.6, -0.10), listOf(nans), 0.0))

    @Test fun `inside the polygon withholds`() =
        assertEquals("withhold", noReportPolicyAt(LatLng(51.50, -0.12), listOf(square), 0.0))
}
