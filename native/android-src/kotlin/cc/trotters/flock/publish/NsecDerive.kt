package cc.trotters.flock.publish

import rust.nostr.sdk.Keys
import rust.nostr.sdk.SecretKey

// Port of nsec-tree's fromNsec + derive (nsec-tree/src/root-nsec.ts, derive.ts).
// tree_root = HMAC-SHA256(key = seed, msg = "nsec-tree-root");
// child     = HMAC-SHA256(key = root, msg = "nsec-tree\0" + purpose + "\0" + uint32BE(index)),
// retrying at index+1 on an invalid scalar (probability ≈ 2^-128).

private val NSEC_ROOT_LABEL = "nsec-tree-root".toByteArray(Charsets.UTF_8)
// "nsec-tree" + a NUL byte - nsec-tree/src/derive.ts DOMAIN_PREFIX.
private val DOMAIN_PREFIX = "nsec-tree".toByteArray(Charsets.UTF_8) + byteArrayOf(0)
private const val MAX_INDEX = 0x7FFFFFFF

fun treeRootFromSeed(seed: ByteArray): ByteArray = hmacSha256(seed, NSEC_ROOT_LABEL)

fun deriveChildSk(root: ByteArray, purpose: String, index: Int): ByteArray {
    require(index in 0..MAX_INDEX) { "index must be in 0..$MAX_INDEX, got $index" }
    val purposeBytes = purpose.toByteArray(Charsets.UTF_8)
    var i = index.toLong()
    while (i <= MAX_INDEX) {
        val ii = i.toInt()
        val msg = DOMAIN_PREFIX + purposeBytes + byteArrayOf(0) +
            byteArrayOf((ii ushr 24).toByte(), (ii ushr 16).toByte(), (ii ushr 8).toByte(), ii.toByte())
        val candidate = hmacSha256(root, msg)
        try {
            SecretKey.parse(bytesToHex(candidate)) // validity check — throws on invalid scalar
            return candidate
        } catch (_: Exception) {
            candidate.fill(0)
            i++
        }
    }
    throw IllegalStateException("index overflow deriving $purpose")
}

data class Inbox(val skHex: String, val pkHex: String)

/** JS twin: deriveInbox(seedHex) = derive(fromNsec(seed), "flock:inbox", 0). */
fun deriveInbox(seedHex: String): Inbox {
    val sk = deriveChildSk(treeRootFromSeed(hexToBytes(seedHex)), "flock:inbox", 0)
    val skHex = bytesToHex(sk)
    return Inbox(skHex, Keys(SecretKey.parse(skHex)).publicKey().toHex())
}
