package cc.trotters.flock.publish

import org.json.JSONObject
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals

class BeaconTest {
    private val v = loadVectors()

    @Test
    fun `beacon key matches canary-kit`() {
        assertEquals(v.getString("beaconKeyHex"), bytesToHex(beaconKey(v.getString("seedHex"))))
    }

    @Test
    fun `group id hash matches`() {
        assertEquals(v.getString("groupIdHash"), groupIdHash(v.getString("circleId")))
    }

    @Test
    fun `decrypts the JS beacon ciphertext`() {
        val c = v.getJSONArray("beaconCiphertexts").getJSONObject(0)
        val plain = JSONObject(String(aesGcmDecrypt(beaconKey(v.getString("seedHex")), c.getString("ciphertextB64"))))
        assertEquals(c.getString("geohash"), plain.getString("geohash"))
        assertEquals(c.getInt("precision"), plain.getInt("precision"))
        assertEquals(c.getLong("timestamp"), plain.getLong("timestamp"))
    }

    @Test
    fun `own encryption round-trips with the payload shape JS expects`() {
        val key = beaconKey(v.getString("seedHex"))
        val ct = encryptBeaconPayload(key, "gcpuvp", 6, 1751700000L)
        val plain = JSONObject(String(aesGcmDecrypt(key, ct)))
        assertEquals("gcpuvp", plain.getString("geohash"))
        assertEquals(6, plain.getInt("precision"))
        assertEquals(1751700000L, plain.getLong("timestamp"))
    }
}
