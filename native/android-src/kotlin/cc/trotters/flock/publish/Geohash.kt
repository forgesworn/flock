package cc.trotters.flock.publish

// Port of geohash-kit's encode (src/core.ts) — interleaved lon/lat bisection,
// base32 alphabet 0-9 b-z minus a,i,l,o. Must stay byte-identical to JS.
private const val BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz"

fun encodeGeohash(lat: Double, lon: Double, precision: Int): String {
    require(lat in -90.0..90.0) { "invalid latitude: $lat" }
    require(lon in -180.0..180.0) { "invalid longitude: $lon" }
    val p = precision.coerceIn(1, 12)
    var latMin = -90.0; var latMax = 90.0
    var lonMin = -180.0; var lonMax = 180.0
    val hash = StringBuilder()
    var bit = 0; var ch = 0; var isLon = true
    while (hash.length < p) {
        if (isLon) {
            val mid = (lonMin + lonMax) / 2
            if (lon >= mid) { ch = ch or (1 shl (4 - bit)); lonMin = mid } else lonMax = mid
        } else {
            val mid = (latMin + latMax) / 2
            if (lat >= mid) { ch = ch or (1 shl (4 - bit)); latMin = mid } else latMax = mid
        }
        isLon = !isLon
        bit++
        if (bit == 5) { hash.append(BASE32[ch]); bit = 0; ch = 0 }
    }
    return hash.toString()
}
