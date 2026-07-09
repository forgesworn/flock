// Radar guidance core — a pure Kotlin port of src/radar.ts, so locked-phone
// guidance obeys the SAME tested honesty rules as the foreground tracker:
// a coarse share never yields a precise pointer, a stale target never sounds
// confident, arrival silences. Parity with the TS module is held by golden
// vectors (native/vectors/radar-vectors.json, `npm run gen:vectors:radar`)
// and JVM tests (native/crypto-tests). Never imports android.*.
package cc.trotters.flock.radar

import cc.trotters.flock.publish.LatLng
import cc.trotters.flock.publish.haversineMetres
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin

// Tuning constants — mirror src/radar.ts RADAR exactly.
object Radar {
    const val FRESH_SECONDS = 60.0
    const val STALE_SECONDS = 600.0
    const val ARRIVE_METRES = 2.0
    const val COARSE_UNCERTAINTY_METRES = 50.0
    const val ALIGNED_DEGREES = 20.0
    const val NEAR_DEGREES = 60.0
    const val CLOSE_METRES = 75.0
    const val NEAR_METRES = 300.0
    const val MIN_MOVE_METRES = 25.0
    const val MIN_COURSE_METRES = 8.0
    const val BEARING_SLACK_FACTOR = 1.25
}

data class TargetObservation(
    val position: LatLng,
    val uncertaintyMetres: Double,
    val ageSeconds: Double,
)

data class RadarInput(
    val me: LatLng?,
    val headingDeg: Double?,
    val target: TargetObservation?,
)

/** States/tiers use the TS string names verbatim so vectors compare directly. */
data class RadarGuidance(
    val state: String, // unavailable | no-fix | stale | coarse | arrived | no-heading | point
    val distanceMetres: Double?,
    val bearingDeg: Double?,
    val relativeBearingDeg: Double?,
    val freshness: String?, // fresh | aging | stale
    val alignment: String?, // aligned | near | off
    val bearingUsable: Boolean,
    val uncertaintyMetres: Double?,
)

data class RadarCue(
    val pattern: String, // silent | sparse | single | double | triple
    val periodMs: Long,
    val toneHz: Int,
    val vibrateMs: LongArray,
)

private fun norm360(deg: Double): Double {
    val d = deg % 360.0
    return if (d < 0) d + 360.0 else d
}

/** Initial great-circle bearing a → b, degrees clockwise from north, [0, 360). */
fun initialBearingDeg(a: LatLng, b: LatLng): Double {
    val phi1 = a.lat * PI / 180
    val phi2 = b.lat * PI / 180
    val dLambda = (b.lon - a.lon) * PI / 180
    val y = sin(dLambda) * cos(phi2)
    val x = cos(phi1) * sin(phi2) - sin(phi1) * cos(phi2) * cos(dLambda)
    return norm360(atan2(y, x) * 180 / PI)
}

/** Signed angular error bearing − heading in (-180, 180]; positive = turn right. */
fun angularErrorDeg(bearingDeg: Double, headingDeg: Double): Double {
    val d = norm360(bearingDeg - headingDeg)
    return if (d > 180) d - 360 else d
}

fun classifyFreshness(ageSeconds: Double): String = when {
    ageSeconds <= Radar.FRESH_SECONDS -> "fresh"
    ageSeconds <= Radar.STALE_SECONDS -> "aging"
    else -> "stale"
}

/** The guidance decision — the src/radar.ts honesty order, verbatim. */
fun radarGuidance(input: RadarInput): RadarGuidance {
    val none = RadarGuidance("unavailable", null, null, null, null, null, false, null)
    val t = input.target ?: return none
    val freshness = classifyFreshness(t.ageSeconds)
    val me = input.me
        ?: return none.copy(state = "no-fix", freshness = freshness, uncertaintyMetres = t.uncertaintyMetres)

    val distance = haversineMetres(me, t.position)
    val bearing = initialBearingDeg(me, t.position)
    val relative = input.headingDeg?.let { angularErrorDeg(bearing, it) }
    val coarse = t.uncertaintyMetres > Radar.COARSE_UNCERTAINTY_METRES

    val bearingUsable = !coarse && freshness != "stale" &&
        distance > t.uncertaintyMetres * Radar.BEARING_SLACK_FACTOR

    val alignment = if (bearingUsable && relative != null) when {
        abs(relative) <= Radar.ALIGNED_DEGREES -> "aligned"
        abs(relative) <= Radar.NEAR_DEGREES -> "near"
        else -> "off"
    } else null

    val state = when {
        freshness == "stale" -> "stale"
        !coarse && distance <= maxOf(Radar.ARRIVE_METRES, t.uncertaintyMetres) -> "arrived"
        coarse -> "coarse"
        input.headingDeg == null -> "no-heading"
        else -> "point"
    }

    return RadarGuidance(state, distance, bearing, relative, freshness, alignment, bearingUsable, t.uncertaintyMetres)
}

private const val SPARSE_TONE_HZ = 330

/** Guidance → one cadence step of the beep grammar (src/radar.ts cueFor). */
fun cueFor(g: RadarGuidance): RadarCue = when (g.state) {
    "unavailable", "no-fix" -> RadarCue("sparse", 4000, SPARSE_TONE_HZ, longArrayOf(30))
    "stale" -> RadarCue("sparse", 3500, SPARSE_TONE_HZ, longArrayOf(30))
    "coarse" -> {
        val d = g.distanceMetres ?: Double.POSITIVE_INFINITY
        val u = g.uncertaintyMetres ?: Radar.COARSE_UNCERTAINTY_METRES
        val period = if (d <= u) 2000L else if (d <= u * 3) 2400L else 3000L
        RadarCue("sparse", period, 440, longArrayOf(40))
    }
    "arrived" -> RadarCue("silent", 0, 0, longArrayOf(80, 60, 80))
    "no-heading" -> {
        val d = g.distanceMetres ?: Double.POSITIVE_INFINITY
        val period = if (d < Radar.CLOSE_METRES) 1000L else if (d < Radar.NEAR_METRES) 1600L else 2400L
        RadarCue("single", period, 660, longArrayOf(40))
    }
    else -> { // point
        val d = g.distanceMetres ?: Double.POSITIVE_INFINITY
        when (g.alignment) {
            "aligned" ->
                if (d < Radar.CLOSE_METRES) RadarCue("triple", 700, 1175, longArrayOf(40, 60, 40, 60, 40))
                else RadarCue("double", 1100, 990, longArrayOf(40, 60, 40))
            "near" -> RadarCue("single", 1600, 740, longArrayOf(40))
            "off" -> RadarCue("single", 2400, 494, longArrayOf(30))
            else -> RadarCue("single", 1600, 660, longArrayOf(40))
        }
    }
}

data class PositionObservation(val position: LatLng, val uncertaintyMetres: Double)

/** Did the target genuinely move? (src/radar.ts targetMoved.) */
fun targetMoved(prev: PositionObservation?, next: PositionObservation): Boolean {
    if (prev == null) return false
    val d = haversineMetres(prev.position, next.position)
    return d > maxOf(Radar.MIN_MOVE_METRES, prev.uncertaintyMetres, next.uncertaintyMetres)
}

data class TimedPosition(val position: LatLng, val atSec: Double)

/** Course over ground from two own fixes, or null when untrustworthy. */
fun courseFromFixes(prev: TimedPosition, next: TimedPosition): Double? {
    if (next.atSec <= prev.atSec) return null
    if (haversineMetres(prev.position, next.position) < Radar.MIN_COURSE_METRES) return null
    return initialBearingDeg(prev.position, next.position)
}
