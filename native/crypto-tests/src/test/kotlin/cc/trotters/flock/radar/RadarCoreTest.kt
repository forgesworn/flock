// Parity for the radar guidance core: the Kotlin port must reproduce the JS
// module's outputs exactly (states, cues, numbers) so locked-phone guidance is
// never more confident than the tested foreground tracker. Vectors come from
// compatibility/v1/radar-vectors.json (`npm run gen:vectors`).
package cc.trotters.flock.radar

import cc.trotters.flock.publish.LatLng
import org.json.JSONArray
import org.json.JSONObject
import org.junit.jupiter.api.Test
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

private fun vectors(): JSONObject = JSONObject(File("../../compatibility/v1/radar-vectors.json").readText())

private fun JSONObject.latLng(key: String): LatLng? {
    val o = optJSONObject(key) ?: return null
    return LatLng(o.getDouble("lat"), o.getDouble("lon"))
}

private fun JSONObject.position(): LatLng {
    val o = getJSONObject("position")
    return LatLng(o.getDouble("lat"), o.getDouble("lon"))
}

private fun parseInput(o: JSONObject): RadarInput {
    val t = o.optJSONObject("target")
    return RadarInput(
        me = o.latLng("me"),
        headingDeg = if (o.isNull("headingDeg")) null else o.getDouble("headingDeg"),
        target = t?.let { TargetObservation(it.position(), it.getDouble("uncertaintyMetres"), it.getDouble("ageSeconds")) },
        myAccuracyMetres = if (o.isNull("myAccuracyMetres")) null else o.getDouble("myAccuracyMetres"),
    )
}

private fun assertDoubleField(expected: JSONObject, key: String, actual: Double?) {
    if (expected.isNull(key)) assertNull(actual, key)
    else assertEquals(expected.getDouble(key), actual!!, 1e-6, key)
}

private fun assertStringField(expected: JSONObject, key: String, actual: String?) {
    if (expected.isNull(key)) assertNull(actual, key)
    else assertEquals(expected.getString(key), actual, key)
}

private fun assertVibrate(expected: JSONArray, actual: LongArray) {
    assertEquals(expected.length(), actual.size, "vibrate length")
    for (i in 0 until expected.length()) assertEquals(expected.getLong(i), actual[i], "vibrate[$i]")
}

/** Assert a whole cue (pattern/period/tone/vibrate + the v2 pan/sign/trend). */
private fun assertCue(expected: JSONObject, cue: RadarCue, label: String) {
    assertEquals(expected.getString("pattern"), cue.pattern, "cue pattern $label")
    assertEquals(expected.getLong("periodMs"), cue.periodMs, "cue period $label")
    assertEquals(expected.getInt("toneHz"), cue.toneHz, "cue tone $label")
    assertVibrate(expected.getJSONArray("vibrateMs"), cue.vibrateMs)
    assertEquals(expected.getDouble("pan"), cue.pan, 1e-9, "cue pan $label")
    assertStringField(expected, "sign", cue.sign)
    assertStringField(expected, "trend", cue.trend)
}

class RadarCoreTest {
    @Test
    fun `bearing matches the JS module`() {
        val cases = vectors().getJSONArray("bearing")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val a = c.latLng("a")!!
            val b = c.latLng("b")!!
            assertEquals(c.getDouble("expected"), initialBearingDeg(a, b), 1e-9, "bearing case $i")
        }
    }

    @Test
    fun `angular error matches`() {
        val cases = vectors().getJSONArray("angularError")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            assertEquals(
                c.getDouble("expected"),
                angularErrorDeg(c.getDouble("bearing"), c.getDouble("heading")),
                1e-9, "angular case $i",
            )
        }
    }

    @Test
    fun `freshness tiers match`() {
        val cases = vectors().getJSONArray("freshness")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            assertEquals(c.getString("expected"), classifyFreshness(c.getDouble("age")), "age ${c.getDouble("age")}")
        }
    }

    @Test
    fun `guidance and cue match on every state`() {
        val cases = vectors().getJSONArray("guidance")
        assertTrue(cases.length() >= 16, "expected the full case set")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val g = radarGuidance(parseInput(c.getJSONObject("input")))
            val eg = c.getJSONObject("guidance")
            assertEquals(eg.getString("state"), g.state, "state case $i")
            assertDoubleField(eg, "distanceMetres", g.distanceMetres)
            assertDoubleField(eg, "bearingDeg", g.bearingDeg)
            assertDoubleField(eg, "relativeBearingDeg", g.relativeBearingDeg)
            assertStringField(eg, "freshness", g.freshness)
            assertStringField(eg, "alignment", g.alignment)
            assertEquals(eg.getBoolean("bearingUsable"), g.bearingUsable, "bearingUsable case $i")
            assertDoubleField(eg, "uncertaintyMetres", g.uncertaintyMetres)
            assertDoubleField(eg, "myAccuracyMetres", g.myAccuracyMetres)

            assertCue(c.getJSONObject("cue"), cueFor(g), "case $i")
        }
    }

    @Test
    fun `movement classification matches`() {
        val cases = vectors().getJSONArray("moved")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val prev = c.optJSONObject("prev")?.let { PositionObservation(it.position(), it.getDouble("uncertaintyMetres")) }
            val nx = c.getJSONObject("next")
            val next = PositionObservation(nx.position(), nx.getDouble("uncertaintyMetres"))
            assertEquals(c.getBoolean("expected"), targetMoved(prev, next), "moved case $i")
        }
    }

    @Test
    fun `course fallback matches`() {
        val cases = vectors().getJSONArray("course")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val p = c.getJSONObject("prev")
            val n = c.getJSONObject("next")
            val course = courseFromFixes(
                TimedPosition(p.position(), p.getDouble("atSec")),
                TimedPosition(n.position(), n.getDouble("atSec")),
            )
            if (c.isNull("expected")) assertNull(course, "course case $i")
            else assertEquals(c.getDouble("expected"), course!!, 1e-9, "course case $i")
        }
    }

    // ── v2 parity ────────────────────────────────────────────────────────────

    private fun nullableDouble(o: JSONObject, key: String): Double? =
        if (o.isNull(key)) null else o.getDouble(key)

    @Test
    fun `heading engine matches`() {
        val cases = vectors().getJSONArray("heading")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val inp = c.getJSONObject("input")
            val got = resolveHeading(
                HeadingInput(
                    compassDeg = nullableDouble(inp, "compassDeg"),
                    compassUsable = inp.getBoolean("compassUsable"),
                    courseDeg = nullableDouble(inp, "courseDeg"),
                    speedMps = nullableDouble(inp, "speedMps"),
                ),
            )
            val ex = c.getJSONObject("expected")
            assertDoubleField(ex, "headingDeg", got.headingDeg)
            assertStringField(ex, "source", got.source)
            assertEquals(ex.getString("status"), got.status, "heading status case $i")
        }
    }

    @Test
    fun `mode machine matches`() {
        val cases = vectors().getJSONArray("mode")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val inp = c.getJSONObject("input")
            val got = selectMode(
                ModeInput(
                    prevMode = inp.getString("prevMode"),
                    distanceMetres = nullableDouble(inp, "distanceMetres"),
                    speedMps = nullableDouble(inp, "speedMps"),
                    fastForSec = inp.getDouble("fastForSec"),
                    slowForSec = inp.getDouble("slowForSec"),
                    uncertaintyMetres = nullableDouble(inp, "uncertaintyMetres"),
                ),
            )
            assertEquals(c.getString("expected"), got, "mode case $i")
        }
    }

    @Test
    fun `pan matches`() {
        val cases = vectors().getJSONArray("pan")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            assertEquals(c.getDouble("expected"), panFor(nullableDouble(c, "rel")), 1e-9, "pan case $i")
        }
    }

    @Test
    fun `sign matches`() {
        val cases = vectors().getJSONArray("sign")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val got = turnSign(nullableDouble(c, "rel"))
            if (c.isNull("expected")) assertNull(got, "sign case $i")
            else assertEquals(c.getString("expected"), got, "sign case $i")
        }
    }

    @Test
    fun `trend matches`() {
        val cases = vectors().getJSONArray("trend")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val got = classifyTrend(nullableDouble(c, "rate"))
            if (c.isNull("expected")) assertNull(got, "trend case $i")
            else assertEquals(c.getString("expected"), got, "trend case $i")
        }
    }

    @Test
    fun `direction phrase matches`() {
        val cases = vectors().getJSONArray("directionPhrase")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            assertEquals(c.getString("expected"), vectorDirectionPhrase(nullableDouble(c, "rel")), "phrase case $i")
        }
    }

    @Test
    fun `milestone crossing matches`() {
        val cases = vectors().getJSONArray("milestone")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val got = crossedMilestone(nullableDouble(c, "prev"), c.getDouble("next"))
            if (c.isNull("expected")) assertNull(got, "milestone case $i")
            else assertEquals(c.getDouble("expected"), got!!, 1e-9, "milestone case $i")
        }
    }

    @Test
    fun `mode-specific cues match`() {
        val cases = vectors().getJSONArray("cueModes")
        assertTrue(cases.length() >= 5, "expected the mode cue set")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val g = radarGuidance(parseInput(c.getJSONObject("input")))
            val ctxJson = c.getJSONObject("ctx")
            val ctx = CueContext(
                mode = ctxJson.optString("mode", "seek"),
                closingRateMps = nullableDouble(ctxJson, "closingRateMps"),
            )
            assertCue(c.getJSONObject("cue"), cueFor(g, ctx), "cueModes case $i")
        }
    }

    // ── v2.1 parity (clock-face + periodic voice) ────────────────────────────

    @Test
    fun `clock face matches`() {
        val cases = vectors().getJSONArray("clockFace")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val rel = nullableDouble(c, "rel")
            val hour = clockHour(rel)
            if (c.isNull("hour")) assertNull(hour, "clock hour case $i")
            else assertEquals(c.getInt("hour"), hour, "clock hour case $i")
            assertEquals(c.getString("phrase"), clockFacePhrase(rel), "clock phrase case $i")
        }
    }

    @Test
    fun `speakable distances match`() {
        val cases = vectors().getJSONArray("speakable")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            assertEquals(c.getDouble("expected"), speakableDistanceMetres(c.getDouble("m")), 1e-9, "speakable case $i")
        }
    }

    @Test
    fun `voice lines match`() {
        val cases = vectors().getJSONArray("voiceLines")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val g = radarGuidance(parseInput(c.getJSONObject("input")))
            val got = voiceLine(c.getString("kind"), g, distanceMetres = c.getDouble("distanceMetres"))
            assertEquals(c.getString("expected"), got, "voice line case $i")
        }
    }

    // ── Phase 3: BLE RSSI proximity assist ───────────────────────────────────

    private fun JSONArray.doubles(): List<Double> = (0 until length()).map { getDouble(it) }

    @Test
    fun `median RSSI and proximity banding match`() {
        val cases = vectors().getJSONArray("bleProximity")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val samples = c.getJSONArray("samples").doubles()
            val median = medianRssi(samples)
            if (c.isNull("median")) assertNull(median, "median case $i") else assertEquals(c.getDouble("median"), median!!, 1e-9, "median case $i")
            val band = bleProximityFromRssi(samples)
            if (c.isNull("expected")) assertNull(band, "ble band case $i") else assertEquals(c.getString("expected"), band, "ble band case $i")
        }
    }

    @Test
    fun `ble band hysteresis matches`() {
        val cases = vectors().getJSONArray("bleHysteresis")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val samples = c.getJSONArray("samples").doubles()
            val prev = if (c.isNull("prev")) null else c.optString("prev")
            val band = bleProximityFromRssi(samples, prev)
            if (c.isNull("expected")) assertNull(band, "ble hysteresis case $i") else assertEquals(c.getString("expected"), band, "ble hysteresis case $i")
        }
    }

    @Test
    fun `ble assist usability and cadence floor match`() {
        val cases = vectors().getJSONArray("bleAssist")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val g = radarGuidance(parseInput(c.getJSONObject("input")))
            val ble = if (c.isNull("ble")) null else c.getString("ble")
            assertEquals(c.getBoolean("usable"), bleAssistUsable(g, ble), "ble usable case $i")
            val floor = bleCadenceFloorMetres(ble)
            if (c.isNull("floorMetres")) assertNull(floor, "ble floor case $i") else assertEquals(c.getDouble("floorMetres"), floor!!, 1e-9, "ble floor case $i")
        }
    }

    @Test
    fun `ble-blended cues match`() {
        val cases = vectors().getJSONArray("cueBle")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val g = radarGuidance(parseInput(c.getJSONObject("input")))
            val ctxJson = c.getJSONObject("ctx")
            val ctx = CueContext(
                mode = ctxJson.optString("mode", "seek"),
                closingRateMps = nullableDouble(ctxJson, "closingRateMps"),
                bleProximity = if (ctxJson.isNull("bleProximity")) null else ctxJson.optString("bleProximity"),
            )
            assertCue(c.getJSONObject("cue"), cueFor(g, ctx), "cueBle case $i")
        }
    }

    @Test
    fun `ble-held mode transitions match`() {
        val cases = vectors().getJSONArray("modeBle")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val inp = c.getJSONObject("input")
            val got = selectMode(
                ModeInput(
                    prevMode = inp.getString("prevMode"),
                    distanceMetres = nullableDouble(inp, "distanceMetres"),
                    speedMps = nullableDouble(inp, "speedMps"),
                    fastForSec = inp.getDouble("fastForSec"),
                    slowForSec = inp.getDouble("slowForSec"),
                    uncertaintyMetres = nullableDouble(inp, "uncertaintyMetres"),
                    bleProximity = if (inp.isNull("bleProximity")) null else inp.optString("bleProximity"),
                ),
            )
            assertEquals(c.getString("expected"), got, "modeBle case $i")
        }
    }

    @Test
    fun `boundary-sticky clock hours match`() {
        val cases = vectors().getJSONArray("clockStable")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val prev = if (c.isNull("prevHour")) null else c.getInt("prevHour")
            val rel = nullableDouble(c, "rel")
            val got = stableClockHour(prev, rel)
            if (c.isNull("expected")) assertNull(got, "clockStable case $i")
            else assertEquals(c.getInt("expected"), got, "clockStable case $i")
        }
    }
}
