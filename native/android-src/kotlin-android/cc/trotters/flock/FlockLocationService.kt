// flock — native GPS fix source for background publish.
//
// A location-typed foreground service that samples the raw platform
// LocationManager GPS_PROVIDER directly (no Google Play Services — GrapheneOS
// safe) and feeds every fix to the verified FlockPublisher pipeline via
// FlockFixReceiver.submitFix. This is the background fix source the
// @capacitor-community/background-geolocation plugin's fused provider cannot be
// on GrapheneOS: the fused/network path stops feeding a locked/backgrounded FGS
// there, whereas a direct GPS_PROVIDER request keeps delivering (the Phase-0
// gps-probe measured 46 locked fixes @10s while walking). The publish half is
// unchanged — we only swap the source. See
// docs/plans/2026-07-05-native-gps-source-goal.md.
//
// Lifecycle: started by FlockPublishPlugin.setConfig (only called while sharing
// + unlocked), stopped by clearConfig / wipeAll — so it is alive exactly when
// the publish mirror is (share → on; stop-sharing / lock-boot / decoy / reset →
// off).
//
// Injected into the generated Capacitor project by native/patch-android.mjs,
// which declares android:foregroundServiceType="location". That declaration and
// the startForeground type below MUST match, or startForeground crashes the
// whole process on API 34+ (the FGS-type gotcha — see the same discipline in
// StayReachableService).
package cc.trotters.flock

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.HandlerThread
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

class FlockLocationService : Service() {
    private var lm: LocationManager? = null
    private var thread: HandlerThread? = null
    @Volatile private var running = false

    // Fires on the HandlerThread looper (off the main thread). Crypto + relay
    // I/O must NOT run here — they would stall the next fix — so we hand off to
    // FlockFixReceiver's single publish thread. onFix's own foreground guard
    // drops fixes while JS's navigator.geolocation owns the foreground, so the
    // two sources never double-publish.
    private val listener = object : LocationListener {
        override fun onLocationChanged(loc: Location) {
            FlockFixReceiver.submitFix(
                applicationContext, loc.latitude, loc.longitude,
                loc.accuracy.toDouble(), loc.time,
            )
        }
        // Kept for pre-30 LocationListener (deprecated / defaulted since API 30).
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (running) return START_STICKY
        running = true

        createChannel()
        val n = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("flock")
            .setContentText("Sharing your location with your circle")
            .setSmallIcon(applicationInfo.icon)
            .setOngoing(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
            } else {
                startForeground(NOTIF_ID, n)
            }
        } catch (e: Exception) {
            // Missing FGS-location permission or a type mismatch must never crash
            // the process — give up this fix source; JS foreground still works.
            running = false
            stopSelf()
            return START_NOT_STICKY
        }

        val t = HandlerThread("flock-gps").also { it.start() }
        thread = t
        val manager = getSystemService(Context.LOCATION_SERVICE) as? LocationManager
        lm = manager
        try {
            // Direct GPS is the proven path; NETWORK helps the first fix (cheap,
            // harmless when absent). A revoked FINE_LOCATION throws SecurityException
            // here — swallow it and stay foregrounded (a later start() retries).
            manager?.requestLocationUpdates(
                LocationManager.GPS_PROVIDER, GPS_INTERVAL_MS, 0f, listener, t.looper,
            )
            if (manager?.isProviderEnabled(LocationManager.NETWORK_PROVIDER) == true) {
                manager.requestLocationUpdates(
                    LocationManager.NETWORK_PROVIDER, GPS_INTERVAL_MS, 0f, listener, t.looper,
                )
            }
        } catch (_: Exception) {
        }
        // START_STICKY: if the OS reclaims us under memory pressure, restart so
        // background fixes resume (the config mirror is already persisted).
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        try { lm?.removeUpdates(listener) } catch (_: Exception) {}
        thread?.quitSafely()
        thread = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(
                CHANNEL_ID, "Location sharing", NotificationManager.IMPORTANCE_MIN,
            ).apply {
                description = "Keeps flock sharing your location while the app is closed."
                setShowBadge(false)
            }
            (getSystemService(NOTIFICATION_SERVICE) as? NotificationManager)
                ?.createNotificationChannel(ch)
        }
    }

    companion object {
        private const val CHANNEL_ID = "flock-location-v1"
        private const val NOTIF_ID = 4211
        private const val GPS_INTERVAL_MS = 5_000L

        /** Start the native GPS fix source (from FlockPublishPlugin.setConfig,
         *  i.e. while sharing + unlocked + foregrounded — a legal FGS start). */
        fun start(context: Context) {
            ContextCompat.startForegroundService(
                context, Intent(context, FlockLocationService::class.java),
            )
        }

        /** Stop it (stop-sharing / lock-boot / decoy hide / reset). */
        fun stop(context: Context) {
            context.stopService(Intent(context, FlockLocationService::class.java))
        }
    }
}
