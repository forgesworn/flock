package cc.trotters.flock.publish

// The native outbound pipeline — the app/src/app.ts autoEmit twin for the
// backgrounded case. It must never decide policy differently from JS: same
// no-report fail-safe, same cadence gate, same retry-on-next-fix semantics.

const val COARSE_MIN_INTERVAL = 45L
const val COARSE_HEARTBEAT = 300L
const val COVER_INTERVAL = 90L // between the move floor and the still heartbeat (app.ts COVER_INTERVAL_SECONDS)
const val CADENCE_JITTER_FRACTION = 0.2

interface ConfigStore {
    fun getConfigJson(): String?
    fun getCadence(circleId: String): BeaconCadence
    fun setCadence(circleId: String, cadence: BeaconCadence)
    /** Unix seconds of this circle's last cover decoy (0 = none yet). Persistent,
     *  like the beacon cadence, so a killed process doesn't restart the drip. */
    fun getCoverAt(circleId: String): Long
    fun setCoverAt(circleId: String, at: Long)
    fun appendJournal(entryJson: String)
}

class FlockPublisher(
    private val store: ConfigStore,
    private val relays: RelayPublisher,
    private val isAppForegrounded: () -> Boolean,
    private val nowSec: () -> Long = { System.currentTimeMillis() / 1000 },
    private val rand: () -> Double = { java.security.SecureRandom().nextDouble() },
) {
    fun onFix(lat: Double, lon: Double, accuracyMetres: Double, fixTimeMs: Long) {
        if (isAppForegrounded()) return // JS owns the foreground — never double-publish
        val cfg = store.getConfigJson()?.let(::parsePublishConfig) ?: return
        val now = nowSec()
        store.appendJournal("""{"t":"fix","at":${fixTimeMs / 1000},"rx":$now}""")
        if (cfg.offGridUntil > now) return
        // No-report cap (decideEmission's last word): possibly inside a withhold
        // zone → nothing; a coarse zone re-coarsens to the base share ceiling
        // (JS applyNoReportCap: min(precision, coarse)). Without a session lift
        // effectivePrecision == shareCeiling, so this stays a no-op — but a session
        // lift to Exact MUST be capped back over a sensitive address.
        val cap = noReportPolicyAt(LatLng(lat, lon), cfg.zones, accuracyMetres)
        if (cap == "withhold") return
        val precision = effectivePrecision(cfg, now).let {
            if (cap == "coarse") minOf(it, shareCeiling(cfg, now)) else it
        }
        val geohash = encodeGeohash(lat, lon, precision)
        val prev = store.getCadence(cfg.circleId)
        // A live radar session lifts the CADENCE floors (precision lifted above) —
        // strictly while now < sessionUntilSec, so the lift expires on THIS clock
        // even if the WebView never wakes to withdraw it. Every cap above
        // (off-grid, no-report, posture) ran exactly as without a session.
        val sessionLive = cfg.sessionUntilSec > now && cfg.sessionMinIntervalSec > 0
        val minInterval = if (sessionLive) cfg.sessionMinIntervalSec else COARSE_MIN_INTERVAL
        val heartbeat = if (sessionLive) cfg.sessionHeartbeatSec else COARSE_HEARTBEAT
        val send = shouldEmitBeacon(
            geohash, prev, now,
            jitteredSeconds(minInterval, CADENCE_JITTER_FRACTION, rand()),
            jitteredSeconds(heartbeat, CADENCE_JITTER_FRACTION, rand()),
        )
        if (!send) {
            maybeCover(cfg, precision, now)
            return
        }
        // Build + publish under one guard — autoEmit's semantics: any failure leaves
        // cadence untouched so the next fix retries; onFix must never throw.
        val accepted = try {
            val wrapJson = buildBeaconWrapJson(cfg.skHex, cfg.seedHex, cfg.circleId, geohash, precision, now, "beacon", rand)
            relays.publish(cfg.relayUrls, wrapJson)
        } catch (_: Exception) { 0 }
        if (accepted > 0) {
            // Same semantics as autoEmit: only record once a relay accepted, so a
            // transient failure retries on the next fix.
            store.setCadence(cfg.circleId, BeaconCadence(geohash, now))
            store.setCoverAt(cfg.circleId, now) // a real send counts as this cycle's cover — no doubling up
            store.appendJournal("""{"t":"pub","c":"${cfg.circleId}","g":"$geohash","p":$precision,"at":$now,"rl":$accepted}""")
        }
    }

    /** The real gate said no (stationary / inside the heartbeat window). Emit a
     *  low-rate COVER decoy — a wrap observationally identical to a beacon carrying
     *  only encrypted filler (autoEmit's cover twin) — so the wire cadence of a
     *  still phone doesn't read as "stopped". Best-effort: a missed decoy is not a
     *  missed alert, and it never records beacon cadence or a journal pub entry. */
    private fun maybeCover(cfg: PublishConfig, precision: Int, now: Long) {
        if (!shouldEmitCover(store.getCoverAt(cfg.circleId), now, COVER_INTERVAL, CADENCE_JITTER_FRACTION, rand())) return
        store.setCoverAt(cfg.circleId, now)
        try {
            val filler = randomFillerGeohash(rand)
            val wrapJson = buildBeaconWrapJson(cfg.skHex, cfg.seedHex, cfg.circleId, filler, precision, now, "cover", rand)
            relays.publish(cfg.relayUrls, wrapJson)
        } catch (_: Exception) { /* best-effort decoy */ }
    }
}

/** 8 hex chars of caller-supplied randomness — the cover payload's filler
 *  "geohash" (encryptBeacon encrypts it, so the wire never reveals it isn't a real
 *  cell). Mirrors autoEmit's `crypto.getRandomValues(new Uint8Array(4))` → hex. */
private fun randomFillerGeohash(rand: () -> Double): String {
    val hex = "0123456789abcdef"
    val sb = StringBuilder(8)
    repeat(8) { sb.append(hex[(rand() * 16).toInt().coerceIn(0, 15)]) }
    return sb.toString()
}
