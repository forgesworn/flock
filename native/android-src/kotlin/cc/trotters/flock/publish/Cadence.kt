package cc.trotters.flock.publish

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong

/** The last automatic beacon broadcast for a circle (app/src/cadence.ts twin). */
data class BeaconCadence(val lastGeohash: String?, val lastSentAt: Long)

fun shouldEmitBeacon(
    candidateGeohash: String,
    prev: BeaconCadence,
    now: Long,
    minIntervalSeconds: Long,
    heartbeatSeconds: Long,
): Boolean {
    if (prev.lastGeohash == null || prev.lastSentAt == 0L) return true
    if (now - prev.lastSentAt < minIntervalSeconds) return false
    if (candidateGeohash != prev.lastGeohash) return true
    return now - prev.lastSentAt >= heartbeatSeconds
}

fun jitteredSeconds(baseSeconds: Long, jitterFraction: Double, rand: Double): Long {
    val r = min(1.0, max(0.0, rand))
    val fraction = min(1.0, max(0.0, jitterFraction))
    val factor = 1 + (r * 2 - 1) * fraction
    return max(1L, (baseSeconds * factor).roundToLong())
}
