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

            val cue = cueFor(g)
            val ec = c.getJSONObject("cue")
            assertEquals(ec.getString("pattern"), cue.pattern, "cue pattern case $i")
            assertEquals(ec.getLong("periodMs"), cue.periodMs, "cue period case $i")
            assertEquals(ec.getInt("toneHz"), cue.toneHz, "cue tone case $i")
            assertVibrate(ec.getJSONArray("vibrateMs"), cue.vibrateMs)
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
}
