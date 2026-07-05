// Receives the per-fix broadcast injected into the background-geolocation
// plugin by native/patch-android.mjs, and runs the native publish pipeline.
// Explicit-component intents only (the patch uses setClassName), so nothing
// outside this app can spoof a fix.
package cc.trotters.flock

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import cc.trotters.flock.publish.FlockPublisher
import cc.trotters.flock.publish.OkHttpRelayPublisher
import java.util.concurrent.Executors

class FlockFixReceiver : BroadcastReceiver() {
    companion object {
        const val ACTION = "cc.trotters.flock.FIX"
        private val executor = Executors.newSingleThreadExecutor()
        @Volatile private var publisher: FlockPublisher? = null
        @Volatile private var store: EncryptedConfigStore? = null

        fun store(context: Context): EncryptedConfigStore =
            store ?: synchronized(this) {
                store ?: EncryptedConfigStore(context.applicationContext).also { store = it }
            }

        private fun publisher(context: Context): FlockPublisher =
            publisher ?: synchronized(this) {
                publisher ?: FlockPublisher(
                    store(context),
                    OkHttpRelayPublisher(),
                    { ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) },
                ).also { publisher = it }
            }

        /** Shared fix intake for every native source (this receiver's bg-geo FIX
         *  broadcast AND FlockLocationService's direct-GPS fixes). Offloads the
         *  whole pipeline — keystore init, crypto, relay I/O — to the single
         *  publish thread, so all publishes serialise (no cadence read/write race
         *  between two sources) and never run on a caller's callback thread.
         *  onFix's own ProcessLifecycleOwner guard drops foreground fixes, so JS's
         *  navigator.geolocation and this can't double-publish. Never throws.
         *  @param onComplete runs after the attempt — the BroadcastReceiver passes
         *  its goAsync finish(); the FGS passes the default no-op. */
        fun submitFix(
            context: Context,
            lat: Double,
            lon: Double,
            accuracy: Double,
            time: Long,
            onComplete: () -> Unit = {},
        ) {
            executor.execute {
                try {
                    // Keystore init (EncryptedSharedPreferences.create) runs in
                    // publisher(context) — off the main thread here — and a broken
                    // store (GeneralSecurityException, IOException) must never crash
                    // the app; swallow it. Best-effort background publish.
                    publisher(context).onFix(lat, lon, accuracy, time)
                } catch (_: Exception) {
                } finally {
                    onComplete()
                }
            }
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val lat = intent.getDoubleExtra("lat", Double.NaN)
        val lon = intent.getDoubleExtra("lon", Double.NaN)
        if (lat.isNaN() || lon.isNaN()) return
        val accuracy = intent.getDoubleExtra("accuracy", 0.0)
        val time = intent.getLongExtra("time", System.currentTimeMillis())
        // Cheap main-thread early-out so a foreground fix never spins up the
        // executor / keystore; onFix re-checks the same guard authoritatively.
        if (ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) return
        val pending = goAsync()
        submitFix(context, lat, lon, accuracy, time) { pending.finish() }
    }
}
