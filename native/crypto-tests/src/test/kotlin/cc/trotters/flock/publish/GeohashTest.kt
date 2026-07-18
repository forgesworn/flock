package cc.trotters.flock.publish

import org.json.JSONObject
import org.junit.jupiter.api.Test
import java.io.File
import kotlin.test.assertEquals

fun loadVectors(): JSONObject = JSONObject(File("../../compatibility/v1/vectors.json").readText())

class GeohashTest {
    @Test
    fun `matches geohash-kit vectors`() {
        val cases = loadVectors().getJSONArray("geohash")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            assertEquals(
                c.getString("expected"),
                encodeGeohash(c.getDouble("lat"), c.getDouble("lon"), c.getInt("precision")),
            )
        }
    }
}
