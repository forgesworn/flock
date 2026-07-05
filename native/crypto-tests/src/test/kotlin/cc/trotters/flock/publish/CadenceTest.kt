package cc.trotters.flock.publish

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class CadenceTest {
    private val none = BeaconCadence(null, 0)

    @Test fun `first beacon always sends`() = assertTrue(shouldEmitBeacon("gcpuvp", none, 1000, 45, 300))

    @Test fun `rate floor suppresses even a new cell`() =
        assertFalse(shouldEmitBeacon("gcpuvq", BeaconCadence("gcpuvp", 1000), 1030, 45, 300))

    @Test fun `new cell after the floor sends`() =
        assertTrue(shouldEmitBeacon("gcpuvq", BeaconCadence("gcpuvp", 1000), 1050, 45, 300))

    @Test fun `same cell inside heartbeat suppresses`() =
        assertFalse(shouldEmitBeacon("gcpuvp", BeaconCadence("gcpuvp", 1000), 1200, 45, 300))

    @Test fun `same cell past heartbeat sends`() =
        assertTrue(shouldEmitBeacon("gcpuvp", BeaconCadence("gcpuvp", 1000), 1300, 45, 300))

    @Test fun `clock skew reads as too soon`() =
        assertFalse(shouldEmitBeacon("gcpuvq", BeaconCadence("gcpuvp", 2000), 1000, 45, 300))

    @Test fun `jitter midpoint reproduces the base`() = assertEquals(45, jitteredSeconds(45, 0.2, 0.5))

    @Test fun `jitter bounds hold and clamp`() {
        assertEquals(36, jitteredSeconds(45, 0.2, 0.0))
        assertEquals(54, jitteredSeconds(45, 0.2, 1.0))
        assertEquals(54, jitteredSeconds(45, 0.2, 7.0)) // out-of-range rand clamps
        assertEquals(1, jitteredSeconds(1, 0.9, 0.0))   // floor at 1s
    }
}
