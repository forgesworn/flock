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
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val lat = intent.getDoubleExtra("lat", Double.NaN)
        val lon = intent.getDoubleExtra("lon", Double.NaN)
        if (lat.isNaN() || lon.isNaN()) return
        val accuracy = intent.getDoubleExtra("accuracy", 0.0)
        val time = intent.getLongExtra("time", System.currentTimeMillis())
        // Foreground check must happen on the main thread (we're on it here);
        // the pipeline itself (crypto + network) runs off it.
        val fg = ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
        if (fg) return
        val pending = goAsync()
        executor.execute {
            // Keystore init (EncryptedSharedPreferences.create) happens in publisher(context),
            // so it must not run on the main thread; and a broken store (GeneralSecurityException,
            // IOException) must never crash the app from inside onReceive — swallow it.
            try {
                val p = publisher(context)
                p.onFix(lat, lon, accuracy, time)
            } catch (_: Exception) {
                // Best-effort background publish; nothing to do if the store/keystore is broken.
            } finally {
                pending.finish()
            }
        }
    }
}
