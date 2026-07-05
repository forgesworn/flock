package cc.trotters.flock.publish

import org.json.JSONObject
import org.junit.jupiter.api.Test
import rust.nostr.sdk.Event
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class GiftWrapTest {
    private val v = loadVectors()

    @Test
    fun `wrap is a valid, backdated, expiring kind 1059 to the circle inbox`() {
        val now = 1_751_700_000L
        val json = buildBeaconWrapJson(
            v.getString("identitySkHex"), v.getString("seedHex"), v.getString("circleId"),
            "gcpuvp", 6, now,
        ) { 0.5 }
        val ev = Event.fromJson(json)
        assertTrue(ev.verify())
        assertEquals(1059uL, ev.kind().asU16().toULong())
        val o = JSONObject(json)
        val tags = o.getJSONArray("tags")
        val p = tags.getJSONArray(0); val exp = tags.getJSONArray(1)
        assertEquals("p", p.getString(0))
        assertEquals(v.getJSONObject("inbox").getString("pkHex"), p.getString(1))
        assertEquals("expiration", exp.getString(0))
        val createdAt = o.getLong("created_at")
        assertTrue(createdAt <= now) // backdated, never future
        assertTrue(createdAt >= now - 172_800)
        assertEquals(createdAt + 16 * 86_400L, exp.getString(1).toLong())
        // The wrap signer must be ephemeral — never the identity key.
        assertTrue(o.getString("pubkey") != v.getString("identityPkHex"))
    }
}
