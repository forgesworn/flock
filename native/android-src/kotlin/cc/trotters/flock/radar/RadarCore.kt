// Radar guidance core — a pure Kotlin port of @forgesworn/flock/radar, so locked-phone
// guidance obeys the SAME tested honesty rules as the foreground tracker:
// a coarse share never yields a precise pointer, a stale target never sounds
// confident, arrival silences. Parity with the TS module is held by golden
// vectors (compatibility/v1/radar-vectors.json, `npm run gen:vectors`)
// and JVM tests (native/crypto-tests). Never imports android.*.
package cc.trotters.flock.radar

import cc.trotters.flock.publish.LatLng
import cc.trotters.flock.publish.haversineMetres
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin

// Tuning constants — mirror @forgesworn/flock/radar RADAR exactly.
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

    // v2 — heading engine.
    const val HEADING_COURSE_SPEED_MPS = 3.0
    const val HEADING_COMPASS_SPEED_MPS = 1.0
    const val HEADING_DISAGREE_DEGREES = 60.0
    const val SIGN_DEADBAND_DEGREES = 8.0

    // v2 — mode machine.
    const val VECTOR_ENTER_SPEED_MPS = 5.0
    const val VECTOR_ENTER_SUSTAIN_SEC = 5.0
    const val VECTOR_ENTER_DISTANCE_METRES = 2000.0
    const val VECTOR_EXIT_SPEED_MPS = 2.0
    const val VECTOR_EXIT_SUSTAIN_SEC = 10.0
    const val VECTOR_EXIT_DISTANCE_METRES = 1500.0
    const val HOMING_ENTER_METRES = 25.0
    const val HOMING_EXIT_METRES = 40.0
    const val HOMING_MAX_UNCERTAINTY_METRES = 10.0

    // v2 — my-accuracy honesty gate + arrival rework.
    const val ARRIVE_ACCURACY_FACTOR = 0.8
    const val HOMING_BEARING_FACTOR = 3.0

    // v2 — HOMING continuous geiger cadence.
    const val HOMING_FAR_METRES = 30.0
    const val HOMING_NEAR_METRES = 3.0
    const val HOMING_PERIOD_FAR_MS = 1200.0
    const val HOMING_PERIOD_NEAR_MS = 250.0
    const val HOMING_TONE_FAR_HZ = 700.0
    const val HOMING_TONE_NEAR_HZ = 1400.0

    // v2 — warmer/colder trend.
    const val TREND_CLOSING_MPS = 0.4

    // v2 — voice milestones (metres, descending).
    val VOICE_MILESTONES_METRES = doubleArrayOf(2000.0, 1000.0, 500.0, 250.0, 100.0)

    // v2.1 (field test 2026-07-21): periodic voice + course trust floor.
    const val PERIODIC_VOICE_SEC = 60.0
    const val COURSE_MIN_SPEED_MPS = 1.0
    val SPEAKABLE_DISTANCES_METRES = doubleArrayOf(
        10.0, 15.0, 20.0, 25.0, 30.0, 40.0, 50.0, 75.0, 100.0, 150.0, 200.0, 250.0,
        300.0, 400.0, 500.0, 750.0, 1000.0, 1500.0, 2000.0, 3000.0, 4000.0, 5000.0, 10_000.0,
    )
    const val VOICE_MIN_INTERVAL_SEC = 10.0

    // Direction callouts (field feedback 2026-07-21): a changed clock hour is
    // ALWAYS spoken, every mode, on its own faster floor.
    /** A spoken/displayed hour only flips once the bearing clears its sector
     *  edge by this — a boundary-sat target must never chatter. */
    const val CLOCK_HOUR_HYSTERESIS_DEG = 6.0
    const val VOICE_DIRECTION_MIN_INTERVAL_SEC = 5.0

    // Phase 3 — BLE RSSI proximity assist.
    /** Median RSSI (dBm) at/above this reads as immediate — same-room close. */
    const val BLE_IMMEDIATE_RSSI = -60.0
    /** …at/above this as near; anything weaker is far (in radio range, no more). */
    const val BLE_NEAR_RSSI = -80.0
    /** Fewer window samples than this claims no band at all (null). */
    const val BLE_MIN_SAMPLES = 3
    /** BLE may only blend while GPS itself already places the target within this. */
    const val BLE_ASSIST_MAX_METRES = 50.0
    /** Cadence floors: an immediate/near band paces the geiger AS IF this close. */
    const val BLE_IMMEDIATE_FLOOR_METRES = 3.0
    const val BLE_NEAR_FLOOR_METRES = 10.0
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
    /** My own fix accuracy radius, metres (coords.accuracy / getAccuracy), or
     *  null. Extends the honesty gate (Fault 4); null = v1 behaviour. */
    val myAccuracyMetres: Double? = null,
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
    val myAccuracyMetres: Double?,
)

data class RadarCue(
    val pattern: String, // silent | sparse | single | double | triple
    val periodMs: Long,
    val toneHz: Int,
    val vibrateMs: LongArray,
    val pan: Double = 0.0,       // −1 left … 0 centred … +1 right
    val sign: String? = null,    // left | right | null (turn-direction haptic)
    val trend: String? = null,   // closing | receding | null (warmer/colder)
)

/** Which mode's cue to shape. Defaults to SEEK (v1 behaviour). */
data class CueContext(
    val mode: String = "seek",       // vector | seek | homing
    val closingRateMps: Double? = null,
    /** Radio proximity to the target member (Phase 3): "immediate" | "near" |
     *  "far" | null — a pin, a mesh-less target and pre-Phase-3 callers all
     *  read as null (no blend). */
    val bleProximity: String? = null,
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

/** The guidance decision — the @forgesworn/flock/radar honesty order, verbatim. */
fun radarGuidance(input: RadarInput): RadarGuidance {
    val myAccuracyMetres = input.myAccuracyMetres
    val none = RadarGuidance("unavailable", null, null, null, null, null, false, null, myAccuracyMetres)
    val t = input.target ?: return none
    val freshness = classifyFreshness(t.ageSeconds)
    val me = input.me
        ?: return none.copy(state = "no-fix", freshness = freshness, uncertaintyMetres = t.uncertaintyMetres)

    val distance = haversineMetres(me, t.position)
    val bearing = initialBearingDeg(me, t.position)
    val relative = input.headingDeg?.let { angularErrorDeg(bearing, it) }
    val coarse = t.uncertaintyMetres > Radar.COARSE_UNCERTAINTY_METRES

    // My own fix accuracy is the second honesty limit (Fault 4); null → no gate.
    val myAccSlack = if (myAccuracyMetres == null) 0.0 else myAccuracyMetres * Radar.BEARING_SLACK_FACTOR
    val bearingUsable = !coarse && freshness != "stale" &&
        distance > t.uncertaintyMetres * Radar.BEARING_SLACK_FACTOR &&
        distance > myAccSlack

    val alignment = if (bearingUsable && relative != null) when {
        abs(relative) <= Radar.ALIGNED_DEGREES -> "aligned"
        abs(relative) <= Radar.NEAR_DEGREES -> "near"
        else -> "off"
    } else null

    // Arrival also clears my fix accuracy: "within GPS reach", not orbiting noise.
    val arriveRadius = maxOf(
        Radar.ARRIVE_METRES,
        t.uncertaintyMetres,
        if (myAccuracyMetres == null) 0.0 else myAccuracyMetres * Radar.ARRIVE_ACCURACY_FACTOR,
    )

    val state = when {
        freshness == "stale" -> "stale"
        !coarse && distance <= arriveRadius -> "arrived"
        coarse -> "coarse"
        input.headingDeg == null -> "no-heading"
        else -> "point"
    }

    return RadarGuidance(state, distance, bearing, relative, freshness, alignment, bearingUsable, t.uncertaintyMetres, myAccuracyMetres)
}

private const val SPARSE_TONE_HZ = 330

private fun clamp(x: Double, lo: Double, hi: Double): Double = minOf(hi, maxOf(lo, x))

/** Stereo pan for a relative bearing: clamp(rel / 90, −1, 1). Null → centred. */
fun panFor(relativeBearingDeg: Double?): Double {
    if (relativeBearingDeg == null) return 0.0
    return clamp(relativeBearingDeg / 90.0, -1.0, 1.0)
}

/** Turn-direction sign with an on-beam dead band; null within ±deadband. */
fun turnSign(relativeBearingDeg: Double?, deadbandDeg: Double = Radar.SIGN_DEADBAND_DEGREES): String? {
    if (relativeBearingDeg == null || abs(relativeBearingDeg) <= deadbandDeg) return null
    return if (relativeBearingDeg > 0) "right" else "left"
}

/** Smoothed range rate → warmer/colder trend (negative rate = closing). */
fun classifyTrend(closingRateMps: Double?): String? {
    if (closingRateMps == null || closingRateMps.isNaN()) return null
    return when {
        closingRateMps < -Radar.TREND_CLOSING_MPS -> "closing"
        closingRateMps > Radar.TREND_CLOSING_MPS -> "receding"
        else -> null
    }
}

/** Is the me→target bearing honest to POINT at from close range? (Fault 4.) */
private fun bearingHonestForHoming(g: RadarGuidance): Boolean {
    if (!g.bearingUsable) return false
    val acc = g.myAccuracyMetres ?: return true
    return (g.distanceMetres ?: 0.0) > acc * Radar.HOMING_BEARING_FACTOR
}

// ── Phase 3: BLE RSSI proximity assist (@forgesworn/flock/radar) ─────────────

/** Median of an RSSI sample window (dBm), or null on an empty window. The
 *  median — not the mean — because BLE fading throws wild outliers. */
fun medianRssi(samples: List<Double>): Double? {
    if (samples.isEmpty()) return null
    val sorted = samples.sorted()
    val mid = sorted.size / 2
    return if (sorted.size % 2 == 1) sorted[mid] else (sorted[mid - 1] + sorted[mid]) / 2.0
}

/** RSSI sample window → proximity band ("immediate" | "near" | "far" | null).
 *  Bands only — RSSI-to-metres is pseudo-science and no number is ever derived
 *  from radio. Fewer than Radar.BLE_MIN_SAMPLES claims nothing: one lucky
 *  packet is not proximity. */
fun bleProximityFromRssi(samples: List<Double>): String? {
    if (samples.size < Radar.BLE_MIN_SAMPLES) return null
    val median = medianRssi(samples) ?: return null
    return when {
        median >= Radar.BLE_IMMEDIATE_RSSI -> "immediate"
        median >= Radar.BLE_NEAR_RSSI -> "near"
        else -> "far"
    }
}

/** May BLE proximity blend into guidance AT ALL? A band must exist; the target
 *  must not be a deliberately coarse share (radio never sharpens a disclosure
 *  below its chosen precision); GPS itself must already place the target
 *  within Radar.BLE_ASSIST_MAX_METRES (radio corroborates a near story, it
 *  never replaces an absent one). */
fun bleAssistUsable(g: RadarGuidance, bleProximity: String?): Boolean {
    if (bleProximity == null) return false
    val u = g.uncertaintyMetres ?: return false
    if (u > Radar.COARSE_UNCERTAINTY_METRES) return false
    val d = g.distanceMetres ?: return false
    return d <= Radar.BLE_ASSIST_MAX_METRES
}

/** The cadence floor a band buys (metres the geiger paces AS IF), or null for
 *  far/none — a far band proves radio range, not closeness, and paces nothing. */
fun bleCadenceFloorMetres(bleProximity: String?): Double? = when (bleProximity) {
    "immediate" -> Radar.BLE_IMMEDIATE_FLOOR_METRES
    "near" -> Radar.BLE_NEAR_FLOOR_METRES
    else -> null
}

/** HOMING geiger cadence: period + pitch interpolate continuously with range;
 *  direction cues survive only while the arrow is honest. A usable BLE band
 *  FLOORS the pacing distance (immediate paced as <= 3 m) so the endgame
 *  quickens indoors where GPS range is fiction — cadence only; arrow, pan and
 *  sign never come from radio. */
private fun homingCue(g: RadarGuidance, ctx: CueContext): RadarCue {
    val bleFloor = if (bleAssistUsable(g, ctx.bleProximity)) bleCadenceFloorMetres(ctx.bleProximity) else null
    val dRaw = g.distanceMetres ?: Radar.HOMING_FAR_METRES
    val d = clamp(if (bleFloor == null) dRaw else minOf(dRaw, bleFloor), Radar.HOMING_NEAR_METRES, Radar.HOMING_FAR_METRES)
    val span = Radar.HOMING_FAR_METRES - Radar.HOMING_NEAR_METRES
    val f = if (span > 0) (d - Radar.HOMING_NEAR_METRES) / span else 0.0
    val periodMs = Math.round(Radar.HOMING_PERIOD_NEAR_MS + f * (Radar.HOMING_PERIOD_FAR_MS - Radar.HOMING_PERIOD_NEAR_MS))
    val toneHz = Math.round(Radar.HOMING_TONE_NEAR_HZ + f * (Radar.HOMING_TONE_FAR_HZ - Radar.HOMING_TONE_NEAR_HZ)).toInt()
    val honest = bearingHonestForHoming(g)
    val rel = g.relativeBearingDeg
    return RadarCue(
        "single", periodMs, toneHz, longArrayOf(40),
        pan = if (honest) panFor(rel) else 0.0,
        sign = if (honest) turnSign(rel) else null,
        trend = classifyTrend(ctx.closingRateMps),
    )
}

/** VECTOR cue: voice leads, so the earcon stays a sparse slow prompt; pan/sign
 *  still ride along (course-relative) for the stereo/haptic mirror. */
private fun vectorCue(g: RadarGuidance): RadarCue {
    val honest = g.bearingUsable
    val rel = g.relativeBearingDeg
    return RadarCue(
        "single", 3000, 660, longArrayOf(40),
        pan = if (honest) panFor(rel) else 0.0,
        sign = if (honest) turnSign(rel) else null,
        trend = null,
    )
}

/** Guidance → one cadence step of the beep grammar (@forgesworn/flock/radar cueFor). */
fun cueFor(g: RadarGuidance, ctx: CueContext = CueContext()): RadarCue = when (g.state) {
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
        if (ctx.mode == "homing") homingCue(g, ctx)
        else {
            val d = g.distanceMetres ?: Double.POSITIVE_INFINITY
            val period = if (d < Radar.CLOSE_METRES) 1000L else if (d < Radar.NEAR_METRES) 1600L else 2400L
            RadarCue("single", period, 660, longArrayOf(40))
        }
    }
    else -> { // point
        when (ctx.mode) {
            "homing" -> homingCue(g, ctx)
            "vector" -> vectorCue(g)
            else -> {
                val d = g.distanceMetres ?: Double.POSITIVE_INFINITY
                val pan = if (g.bearingUsable) panFor(g.relativeBearingDeg) else 0.0
                val sign = if (g.bearingUsable) turnSign(g.relativeBearingDeg) else null
                when (g.alignment) {
                    "aligned" ->
                        if (d < Radar.CLOSE_METRES) RadarCue("triple", 700, 1175, longArrayOf(40, 60, 40, 60, 40), pan, sign, null)
                        else RadarCue("double", 1100, 990, longArrayOf(40, 60, 40), pan, sign, null)
                    "near" -> RadarCue("single", 1600, 740, longArrayOf(40), pan, sign, null)
                    "off" -> RadarCue("single", 2400, 494, longArrayOf(30), pan, sign, null)
                    else -> RadarCue("single", 1600, 660, longArrayOf(40))
                }
            }
        }
    }
}

data class PositionObservation(val position: LatLng, val uncertaintyMetres: Double)

/** Did the target genuinely move? (@forgesworn/flock/radar targetMoved.) */
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

// ── v2: heading engine (@forgesworn/flock/radar resolveHeading) ───────────────

data class HeadingInput(
    val compassDeg: Double?,
    val compassUsable: Boolean,
    val courseDeg: Double?,
    val speedMps: Double?,
)

/** headingDeg + source (compass | course | null) + status (ok |
 *  compass-unreliable | none). String fields so vectors compare directly. */
data class HeadingSolution(
    val headingDeg: Double?,
    val source: String?,
    val status: String,
)

/** Arbitrate compass vs GPS course by speed — the v2 heading engine. */
fun resolveHeading(h: HeadingInput): HeadingSolution {
    val speed = h.speedMps ?: 0.0
    val haveCourse = h.courseDeg != null
    val haveCompass = h.compassDeg != null && h.compassUsable
    val course = { HeadingSolution(norm360(h.courseDeg!!), "course", "ok") }
    val compass = { HeadingSolution(norm360(h.compassDeg!!), "compass", "ok") }
    val none = HeadingSolution(null, null, "none")

    // 1. Vehicle band — course only, compass never consulted.
    if (speed >= Radar.HEADING_COURSE_SPEED_MPS) return if (haveCourse) course() else none

    // 2. Near-stationary — trust a usable compass, else course, else none.
    if (speed < Radar.HEADING_COMPASS_SPEED_MPS) {
        return when {
            haveCompass -> compass()
            haveCourse -> course()
            else -> none
        }
    }

    // 3. In between — prefer compass, but course overrides a disagreeing compass.
    if (haveCompass) {
        if (haveCourse && abs(angularErrorDeg(h.compassDeg!!, h.courseDeg!!)) > Radar.HEADING_DISAGREE_DEGREES) {
            return HeadingSolution(norm360(h.courseDeg!!), "course", "compass-unreliable")
        }
        return compass()
    }
    return if (haveCourse) course() else none
}

/** Circular EMA of a heading, blending along the shortest arc. */
fun smoothHeadingDeg(prevDeg: Double?, nextDeg: Double, alpha: Double): Double {
    if (prevDeg == null) return norm360(nextDeg)
    val delta = angularErrorDeg(nextDeg, prevDeg)
    return norm360(prevDeg + alpha * delta)
}

/** EMA of d(distance)/dt for the warmer/colder trend (negative = closing). */
fun smoothClosingRate(
    prevRateMps: Double?,
    prevDistanceMetres: Double,
    nextDistanceMetres: Double,
    dtSec: Double,
    alpha: Double,
): Double {
    if (dtSec <= 0) return prevRateMps ?: 0.0
    val inst = (nextDistanceMetres - prevDistanceMetres) / dtSec
    if (prevRateMps == null) return inst
    return prevRateMps + alpha * (inst - prevRateMps)
}

// ── v2: mode machine (@forgesworn/flock/radar selectMode) ─────────────────────

data class ModeInput(
    val prevMode: String, // vector | seek | homing
    val distanceMetres: Double?,
    val speedMps: Double?,
    val fastForSec: Double,
    val slowForSec: Double,
    val uncertaintyMetres: Double?,
    /** Radio proximity to the target member (Phase 3), or null. May HOLD an
     *  active HOMING against indoor GPS wobble; never enters one. */
    val bleProximity: String? = null,
)

/** VECTOR / SEEK / HOMING with hysteresis — the precise endgame wins, then the
 *  vehicle band, else SEEK. Manual override is the controller's job. */
fun selectMode(m: ModeInput): String {
    val dist = m.distanceMetres ?: Double.POSITIVE_INFINITY
    val coarseForHoming = (m.uncertaintyMetres ?: 0.0) > Radar.HOMING_MAX_UNCERTAINTY_METRES

    // A near/immediate BLE band HOLDS an active HOMING against indoor GPS
    // wobble (accuracy collapse walks the GPS range past the exit line while
    // the member's radio is demonstrably in the room) — hold only, within the
    // blend ceiling, never for a deliberately coarse share, never a way IN.
    val ble = m.bleProximity
    val bleHold = (ble == "immediate" || ble == "near") &&
        dist <= Radar.BLE_ASSIST_MAX_METRES &&
        (m.uncertaintyMetres ?: 0.0) <= Radar.COARSE_UNCERTAINTY_METRES

    if (m.prevMode == "homing") {
        if ((dist <= Radar.HOMING_EXIT_METRES && !coarseForHoming) || bleHold) return "homing"
    } else if (dist < Radar.HOMING_ENTER_METRES && !coarseForHoming) {
        return "homing"
    }

    if (m.prevMode == "vector") {
        val exit = m.slowForSec >= Radar.VECTOR_EXIT_SUSTAIN_SEC && dist <= Radar.VECTOR_EXIT_DISTANCE_METRES
        if (!exit) return "vector"
    } else {
        val enter = m.fastForSec >= Radar.VECTOR_ENTER_SUSTAIN_SEC || dist > Radar.VECTOR_ENTER_DISTANCE_METRES
        if (enter) return "vector"
    }

    return "seek"
}

// ── v2: voice-line copy (the TTS channel) ────────────────────────────────────

/** The deepest milestone (metres) just crossed on the way in, or null. */
fun crossedMilestone(prevMetres: Double?, nextMetres: Double): Double? {
    if (prevMetres == null) return null
    var crossed: Double? = null
    for (mm in Radar.VOICE_MILESTONES_METRES) {
        if (prevMetres > mm && nextMetres <= mm) crossed = mm
    }
    return crossed
}

/** Relative bearing → a spoken clock-free direction phrase (left/right).
 *  Superseded for the voice channel by clockFacePhrase (v2.1). */
fun vectorDirectionPhrase(relativeBearingDeg: Double?): String {
    if (relativeBearingDeg == null) return "ahead"
    val mag = abs(relativeBearingDeg)
    if (mag <= 15) return "straight ahead"
    if (mag >= 165) return "behind you"
    val side = if (relativeBearingDeg > 0) "right" else "left"
    if (mag <= 75) return "ahead on your $side"
    if (mag <= 105) return "to your $side"
    return "behind you on your $side"
}

/** The clock hour a relative bearing falls on (30° sectors; ahead = 12,
 *  right = 3, behind = 6, left = 9), or null with no bearing (v2.1). */
fun clockHour(relativeBearingDeg: Double?): Int? {
    if (relativeBearingDeg == null || relativeBearingDeg.isNaN()) return null
    val sector = (Math.round(norm360(relativeBearingDeg) / 30.0).toInt()) % 12
    return if (sector == 0) 12 else sector
}

/** Relative bearing → "at your 3 o'clock", or "" with no bearing (v2.1). */
fun clockFacePhrase(relativeBearingDeg: Double?): String {
    val h = clockHour(relativeBearingDeg) ?: return ""
    return "at your $h o'clock"
}

/** The clock hour with sector-boundary hysteresis — holds the previous hour
 *  until the bearing clears its sector edge by CLOCK_HOUR_HYSTERESIS_DEG, so
 *  a boundary-sat target never chatters; a genuinely big swing still flips
 *  immediately. Byte-matches the JS stableClockHour (clockStable vectors). */
fun stableClockHour(prevHour: Int?, relativeBearingDeg: Double?): Int? {
    val raw = clockHour(relativeBearingDeg) ?: return null
    if (prevHour == null) return raw
    if (raw == prevHour) return prevHour
    val prevCentreDeg = (prevHour % 12) * 30.0
    val offCentre = abs(angularErrorDeg(norm360(relativeBearingDeg!!), prevCentreDeg))
    if (offCentre <= 15.0 + Radar.CLOCK_HOUR_HYSTERESIS_DEG) return prevHour
    return raw
}

/** Round a range to the nearest speakable-ladder step (v2.1). */
fun speakableDistanceMetres(metres: Double): Double {
    var best = Radar.SPEAKABLE_DISTANCES_METRES[0]
    for (step in Radar.SPEAKABLE_DISTANCES_METRES) {
        if (abs(step - metres) < abs(best - metres)) best = step
    }
    return best
}

/** Assemble one spoken line. `fmtDistance` renders metres in the user's units. */
fun voiceLine(
    kind: String, // milestone | periodic | moved | bearing-change | mode | compass-unreliable | arrived | degraded
    g: RadarGuidance,
    distanceMetres: Double = 0.0,
    mode: String = "seek",
    degradedState: String = "",
    fmtDistance: (Double) -> String = { m -> "${Math.round(m)} m" },
): String {
    // A clock claim only while the bearing is honestly usable (mirrors JS).
    val clock = if (g.bearingUsable) clockFacePhrase(g.relativeBearingDeg) else ""
    val withClock = { dist: String -> if (clock.isEmpty()) dist else "$dist, $clock" }
    return when (kind) {
        "milestone" -> withClock(fmtDistance(distanceMetres).replace("~", ""))
        "periodic" -> withClock(fmtDistance(distanceMetres).replace("~", ""))
        "moved" -> "They've moved — ${withClock(fmtDistance(distanceMetres).replace("~", ""))}"
        "bearing-change" -> {
            val c = clockFacePhrase(g.relativeBearingDeg)
            if (c.isEmpty()) "" else "Now $c"
        }
        "mode" -> when (mode) {
            "vector" -> "Vehicle mode"
            "homing" -> "Closing in"
            else -> "On-foot tracking"
        }
        "compass-unreliable" -> "Compass unreliable — using your direction of travel"
        "arrived" -> "Within GPS reach — look around"
        "ble-close" -> "Very close — by Bluetooth"
        "degraded" -> when (degradedState) {
            "stale" -> "Their location is stale — follow with care"
            "coarse" -> "Rough area only"
            "no-fix" -> "Waiting for your own position"
            "unavailable" -> "No location to navigate to"
            else -> ""
        }
        else -> ""
    }
}
