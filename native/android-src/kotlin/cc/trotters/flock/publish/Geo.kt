package cc.trotters.flock.publish

import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

// Ports of src/geofence.ts containment (accuracy-aware, fail-safe toward
// "possibly inside") and geohash-kit's planar polygon predicates, restricted to
// what the no-report cap needs. Must behave identically to the JS.

data class LatLng(val lat: Double, val lon: Double)

sealed class Geofence {
    data class Circle(val centre: LatLng, val radiusMetres: Double) : Geofence()
    data class Polygon(val vertices: List<LatLng>) : Geofence()
}

data class NoReportZone(val area: Geofence, val policy: String) // "withhold" | "coarse"

private const val EARTH_RADIUS_M = 6_371_000.0

fun haversineMetres(a: LatLng, b: LatLng): Double {
    val toRad = PI / 180
    val dLat = (b.lat - a.lat) * toRad
    val dLon = (b.lon - a.lon) * toRad
    val h = sin(dLat / 2) * sin(dLat / 2) +
        cos(a.lat * toRad) * cos(b.lat * toRad) * sin(dLon / 2) * sin(dLon / 2)
    return EARTH_RADIUS_M * 2 * atan2(sqrt(h), sqrt(1 - h))
}

// [lon, lat] pairs, even-odd ray casting — geohash-kit pointInPolygon.
private fun pointInPolygon(px: Double, py: Double, ring: List<DoubleArray>): Boolean {
    var inside = false
    var j = ring.size - 1
    for (i in ring.indices) {
        val (xi, yi) = ring[i][0] to ring[i][1]
        val (xj, yj) = ring[j][0] to ring[j][1]
        if ((yi > py) != (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside
        j = i
    }
    return inside
}

private fun cross(o: DoubleArray, a: DoubleArray, b: DoubleArray): Double =
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

private fun segmentsIntersect(a1: DoubleArray, a2: DoubleArray, b1: DoubleArray, b2: DoubleArray): Boolean {
    val d1 = cross(b1, b2, a1); val d2 = cross(b1, b2, a2)
    val d3 = cross(a1, a2, b1); val d4 = cross(a1, a2, b2)
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true
    fun onSeg(p: DoubleArray, q: DoubleArray, r: DoubleArray): Boolean =
        cross(p, q, r) == 0.0 && r[0] in minOf(p[0], q[0])..maxOf(p[0], q[0]) && r[1] in minOf(p[1], q[1])..maxOf(p[1], q[1])
    return onSeg(b1, b2, a1) || onSeg(b1, b2, a2) || onSeg(a1, a2, b1) || onSeg(a1, a2, b2)
}

private class Bounds(val minLat: Double, val maxLat: Double, val minLon: Double, val maxLon: Double) {
    fun corners(): List<DoubleArray> = listOf(
        doubleArrayOf(minLon, minLat), doubleArrayOf(maxLon, minLat),
        doubleArrayOf(maxLon, maxLat), doubleArrayOf(minLon, maxLat),
    )
}

private fun boundsOverlapsPolygon(b: Bounds, ring: List<DoubleArray>): Boolean {
    val corners = b.corners()
    if (corners.any { pointInPolygon(it[0], it[1], ring) }) return true
    if (ring.any { it[0] in b.minLon..b.maxLon && it[1] in b.minLat..b.maxLat }) return true
    val edges = corners.indices.map { corners[it] to corners[(it + 1) % 4] }
    var j = ring.size - 1
    for (i in ring.indices) {
        for ((e1, e2) in edges) if (segmentsIntersect(e1, e2, ring[j], ring[i])) return true
        j = i
    }
    return false
}

private fun uncertaintyBounds(p: LatLng, accuracyMetres: Double): Bounds {
    val dLat = accuracyMetres / 111_320.0
    val dLon = accuracyMetres / (111_320.0 * cos(p.lat * PI / 180))
    return Bounds(p.lat - dLat, p.lat + dLat, p.lon - dLon, p.lon + dLon)
}

/** Is the uncertainty disc confidently outside this fence? (src/geofence.ts fenceContainment) */
private fun fullyOutside(point: LatLng, accuracyMetres: Double, fence: Geofence): Boolean = when (fence) {
    is Geofence.Circle -> haversineMetres(point, fence.centre) - accuracyMetres >= fence.radiusMetres
    is Geofence.Polygon -> {
        val ring = fence.vertices.map { doubleArrayOf(it.lon, it.lat) }
        if (accuracyMetres <= 0) !pointInPolygon(point.lon, point.lat, ring)
        else !boundsOverlapsPolygon(uncertaintyBounds(point, accuracyMetres), ring)
    }
}

/**
 * Strictest suppression among the zones the fix is POSSIBLY inside, or null
 * when confidently outside them all (src/noreport.ts noReportPolicyAt).
 */
fun noReportPolicyAt(point: LatLng, zones: List<NoReportZone>, accuracyMetres: Double): String? {
    var strictest: String? = null
    for (z in zones) {
        if (fullyOutside(point, accuracyMetres, z.area)) continue
        if (z.policy != "coarse") return "withhold"
        strictest = "coarse"
    }
    return strictest
}
