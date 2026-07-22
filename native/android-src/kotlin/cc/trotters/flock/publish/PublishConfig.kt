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
    // Radar session (live navigation) lift — all 0 when none is live. Applied
    // strictly while now < sessionUntilSec, so a session expires on THIS clock
    // even if the WebView never wakes to withdraw it. Lifts cadence AND precision
    // (to Exact) exactly like the JS autoEmit twin; every geography cap (off-grid,
    // no-report withhold/coarse) still applies above.
    val sessionMinIntervalSec: Long = 0,
    val sessionHeartbeatSec: Long = 0,
    val sessionUntilSec: Long = 0,
)

private const val PRECISION_MIN = 3
private const val PRECISION_MAX = 9
private const val FESTIVAL_PRECISION = PRECISION_MAX
private const val SESSION_PRECISION = PRECISION_MAX // live navigation lifts to Exact

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
        sessionMinIntervalSec = o.optLong("sessionMinIntervalSec", 0),
        sessionHeartbeatSec = o.optLong("sessionHeartbeatSec", 0),
        sessionUntilSec = o.optLong("sessionUntilSec", 0),
    )
} catch (_: Exception) { null }

/** sharePrecisionOf twin: slider base clamped 3..9, festival boost (never lower).
 *  This is the ambient share ceiling AND the coarse no-report cap ceiling (the JS
 *  `p.coarse` a session lift is capped back to inside a coarse zone). */
fun shareCeiling(cfg: PublishConfig, nowSec: Long): Int {
    val base = cfg.precision.coerceIn(PRECISION_MIN, PRECISION_MAX)
    return if (cfg.festivalUntil > nowSec) maxOf(base, FESTIVAL_PRECISION) else base
}

/** The precision a beacon emits at, before the no-report coarse cap: the ambient
 *  share ceiling, lifted to Exact while a radar session is live (never lowers a
 *  finer share). Mirrors the JS autoEmit lift (a 'pickup' trigger at full precision
 *  while a session is live, the slider otherwise). */
fun effectivePrecision(cfg: PublishConfig, nowSec: Long): Int {
    val ceiling = shareCeiling(cfg, nowSec)
    val sessionLive = cfg.sessionUntilSec > nowSec && cfg.sessionMinIntervalSec > 0
    return if (sessionLive) maxOf(ceiling, SESSION_PRECISION) else ceiling
}
