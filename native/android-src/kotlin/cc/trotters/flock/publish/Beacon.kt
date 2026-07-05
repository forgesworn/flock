package cc.trotters.flock.publish

// canary-kit beacon twin (canary-kit/src/beacon.ts, nostr.ts).
private val BEACON_KEY_INFO = "canary:beacon:key".toByteArray(Charsets.UTF_8)

fun beaconKey(seedHex: String): ByteArray = hmacSha256(hexToBytes(seedHex), BEACON_KEY_INFO)

fun groupIdHash(groupId: String): String = bytesToHex(sha256(groupId.toByteArray(Charsets.UTF_8)))

/** {"geohash":…,"precision":…,"timestamp":…} — key order matches JS JSON.stringify. */
fun encryptBeaconPayload(key: ByteArray, geohash: String, precision: Int, timestamp: Long): String {
    val json = """{"geohash":"$geohash","precision":$precision,"timestamp":$timestamp}"""
    return aesGcmEncrypt(key, json.toByteArray(Charsets.UTF_8))
}
