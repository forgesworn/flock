package cc.trotters.flock.publish

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class DeriveTest {
    private val v = loadVectors()

    @Test
    fun `deriveInbox matches nsec-tree`() {
        val inbox = deriveInbox(v.getString("seedHex"))
        val expected = v.getJSONObject("inbox")
        assertEquals(expected.getString("skHex"), inbox.skHex)
        assertEquals(expected.getString("pkHex"), inbox.pkHex)
    }

    @Test
    fun `child derivation matches every vector`() {
        val root = treeRootFromSeed(hexToBytes(v.getString("seedHex")))
        val cases = v.getJSONArray("derive")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val sk = deriveChildSk(root, c.getString("purpose"), c.getInt("index"))
            assertEquals(c.getString("skHex"), bytesToHex(sk))
            assertEquals(c.getString("pkHex"), rust.nostr.sdk.Keys(rust.nostr.sdk.SecretKey.parse(bytesToHex(sk))).publicKey().toHex())
        }
    }

    @Test
    fun `negative index throws IllegalArgumentException`() {
        val root = ByteArray(32)
        assertFailsWith<IllegalArgumentException> { deriveChildSk(root, "flock:inbox", -1) }
    }
}
