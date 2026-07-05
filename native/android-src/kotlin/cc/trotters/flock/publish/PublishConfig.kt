package cc.trotters.flock.publish

import org.json.JSONObject

// The minimal mirrored config the JS side writes (native/publishMirror.ts).
// Anything malformed parses to null — the publisher then stays idle, which is
// the fail-safe direction (never publish on a half-understood config).

data class PublishConfig(
    val skHex: String,
    val circleId: String,
    val seedHex: String,
    val precision: Int,
    val festivalUntil: Long,
    val relayUrls: List<String>,
    val zones: List<NoReportZone>,
    val offGridUntil: Long,
)

private const val PRECISION_MIN = 3
private const val PRECISION_MAX = 9
private const val FESTIVAL_PRECISION = PRECISION_MAX

fun parsePublishConfig(json: String): PublishConfig? = try {
    val o = JSONObject(json)
    if (o.getInt("v") != 1) null else PublishConfig(
        skHex = o.getString("skHex"),
        circleId = o.getString("circleId"),
        seedHex = o.getString("seedHex"),
        precision = o.getInt("precision"),
        festivalUntil = o.optLong("festivalUntil", 0),
        relayUrls = o.getJSONArray("relayUrls").let { a -> (0 until a.length()).map { a.getString(it) } },
        zones = o.optJSONArray("noReportZones")?.let { a ->
            (0 until a.length()).map { i ->
                val z = a.getJSONObject(i)
                val area = z.getJSONObject("area")
                val fence = when (area.getString("kind")) {
                    "circle" -> Geofence.Circle(
                        LatLng(area.getJSONObject("centre").getDouble("lat"), area.getJSONObject("centre").getDouble("lon")),
                        area.getDouble("radiusMetres"),
                    )
                    "polygon" -> Geofence.Polygon(area.getJSONArray("vertices").let { vs ->
                        (0 until vs.length()).map { j ->
                            LatLng(vs.getJSONObject(j).getDouble("lat"), vs.getJSONObject(j).getDouble("lon"))
                        }
                    })
                    else -> throw IllegalArgumentException("unknown fence kind")
                }
                NoReportZone(fence, z.optString("policy", "withhold").ifEmpty { "withhold" })
            }
        } ?: emptyList(),
        offGridUntil = o.optLong("offGridUntil", 0),
    )
} catch (_: Exception) { null }

/** sharePrecisionOf twin: slider base clamped 3..9, festival boost (never lower). */
fun effectivePrecision(cfg: PublishConfig, nowSec: Long): Int {
    val base = cfg.precision.coerceIn(PRECISION_MIN, PRECISION_MAX)
    return if (cfg.festivalUntil > nowSec) maxOf(base, FESTIVAL_PRECISION) else base
}
