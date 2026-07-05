package cc.trotters.flock.publish

// The native outbound pipeline — the app/src/app.ts autoEmit twin for the
// backgrounded case. It must never decide policy differently from JS: same
// no-report fail-safe, same cadence gate, same retry-on-next-fix semantics.

const val COARSE_MIN_INTERVAL = 45L
const val COARSE_HEARTBEAT = 300L
const val CADENCE_JITTER_FRACTION = 0.2

interface ConfigStore {
    fun getConfigJson(): String?
    fun getCadence(circleId: String): BeaconCadence
    fun setCadence(circleId: String, cadence: BeaconCadence)
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
        // zone → nothing; a coarse cap can't lower an already-coarse beacon.
        val cap = noReportPolicyAt(LatLng(lat, lon), cfg.zones, accuracyMetres)
        if (cap == "withhold") return
        val precision = effectivePrecision(cfg, now)
        val geohash = encodeGeohash(lat, lon, precision)
        val prev = store.getCadence(cfg.circleId)
        val send = shouldEmitBeacon(
            geohash, prev, now,
            jitteredSeconds(COARSE_MIN_INTERVAL, CADENCE_JITTER_FRACTION, rand()),
            jitteredSeconds(COARSE_HEARTBEAT, CADENCE_JITTER_FRACTION, rand()),
        )
        if (!send) return
        // Build + publish under one guard — autoEmit's semantics: any failure leaves
        // cadence untouched so the next fix retries; onFix must never throw.
        val accepted = try {
            val wrapJson = buildBeaconWrapJson(cfg.skHex, cfg.seedHex, cfg.circleId, geohash, precision, now, rand)
            relays.publish(cfg.relayUrls, wrapJson)
        } catch (_: Exception) { 0 }
        if (accepted > 0) {
            // Same semantics as autoEmit: only record once a relay accepted, so a
            // transient failure retries on the next fix.
            store.setCadence(cfg.circleId, BeaconCadence(geohash, now))
            store.appendJournal("""{"t":"pub","c":"${cfg.circleId}","g":"$geohash","p":$precision,"at":$now,"rl":$accepted}""")
        }
    }
}
