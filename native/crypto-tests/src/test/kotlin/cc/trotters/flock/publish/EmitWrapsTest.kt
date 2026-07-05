package cc.trotters.flock.publish

import org.json.JSONArray
import org.json.JSONObject
import org.junit.jupiter.api.Test
import java.io.File
import java.security.SecureRandom

/** Emits Kotlin-built wraps for the JS reverse-verification stage
 *  (native/vectors/verify-kotlin.test.ts). Gitignored output. */
class EmitWrapsTest {
    @Test
    fun `emit wraps for JS verification`() {
        val v = loadVectors()
        val rng = SecureRandom()
        val out = JSONArray()
        for (precision in listOf(4, 6)) {
            val geohash = "gcpuvp".take(precision)
            val json = buildBeaconWrapJson(
                v.getString("identitySkHex"), v.getString("seedHex"), v.getString("circleId"),
                geohash, precision,
                System.currentTimeMillis() / 1000,
            ) { rng.nextDouble() }
            out.put(JSONObject()
                .put("wrapJson", JSONObject(json))
                .put("expect", JSONObject().put("geohash", geohash).put("precision", precision)))
        }
        File("../vectors/kotlin-wraps.json").writeText(out.toString(2) + "\n")
    }
}
