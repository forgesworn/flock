package cc.trotters.flock.publish

fun hexToBytes(hex: String): ByteArray {
    require(hex.length % 2 == 0) { "odd-length hex" }
    return ByteArray(hex.length / 2) { i ->
        ((Character.digit(hex[i * 2], 16) shl 4) + Character.digit(hex[i * 2 + 1], 16)).toByte()
    }
}

fun bytesToHex(bytes: ByteArray): String =
    bytes.joinToString("") { "%02x".format(it) }
