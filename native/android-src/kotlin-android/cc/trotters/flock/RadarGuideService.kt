// flock — locked-phone radar guide (Android/GrapheneOS).
//
// A user-started, location-typed foreground service that keeps radar's BY-EAR
// guidance alive while the screen is locked and the WebView is suspended: it
// samples GPS directly (the mechanism the Phase-0 probe measured green on a
// locked GrapheneOS Pixel), reads the rotation-vector compass, and drives the
// beep grammar + vibration natively. Every DECISION comes from the pure
// RadarCore port (cc.trotters.flock.radar), which golden vectors pin to the
// tested JS module — the locked beeper can never be more confident than the
// foreground tracker.
//
// The selected target's updates arrive from JS (RadarGuidePlugin.updateTarget
// on each incoming beacon — the relay socket keeps running while flock is
// battery-exempt). If updates stop reaching us, the observation AGES on the
// native clock and guidance degrades to the sparse stale pulse — honest by
// construction, never a confident cue to an old spot (goal doc §7).
//
// Privacy: this consumes only the already-permitted beacon JS hands it; it
// never touches the relay, never publishes, and the lock-screen notification
// says only "Radar active" — no names. Stop is available from the
// notification and silences everything immediately.
//
// Injected by native/patch-android.mjs with foregroundServiceType="location" —
// the declaration and startForeground type MUST match (the FGS-type gotcha;
// see FlockLocationService).
package cc.trotters.flock

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import cc.trotters.flock.publish.LatLng
import cc.trotters.flock.radar.RadarInput
import cc.trotters.flock.radar.TargetObservation
import cc.trotters.flock.radar.PositionObservation
import cc.trotters.flock.radar.TimedPosition
import cc.trotters.flock.radar.courseFromFixes
import cc.trotters.flock.radar.cueFor
import cc.trotters.flock.radar.radarGuidance
import cc.trotters.flock.radar.targetMoved

class RadarGuideService : Service() {
    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var lm: LocationManager? = null
    private var sm: SensorManager? = null
    private var wakeLock: PowerManager.WakeLock? = null
    @Volatile private var running = false

    // My side of the bearing — direct GPS fixes (previous + current for the
    // course-over-ground fallback) and the rotation-vector compass.
    @Volatile private var prevFix: TimedPosition? = null
    @Volatile private var curFix: TimedPosition? = null
    @Volatile private var headingDeg: Double? = null
    @Volatile private var headingAtMs: Long = 0
    private var lastState: String? = null

    private val locationListener = object : LocationListener {
        override fun onLocationChanged(loc: Location) {
            val at = SystemClock.elapsedRealtime() / 1000.0
            val fix = TimedPosition(LatLng(loc.latitude, loc.longitude), at)
            val cur = curFix
            if (cur == null || fix.atSec > cur.atSec) { prevFix = cur; curFix = fix }
        }
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
    }

    private val sensorListener = object : SensorEventListener {
        private val rot = FloatArray(9)
        private val ori = FloatArray(3)
        override fun onSensorChanged(e: SensorEvent) {
            SensorManager.getRotationMatrixFromVector(rot, e.values)
            SensorManager.getOrientation(rot, ori)
            val az = Math.toDegrees(ori[0].toDouble())
            headingDeg = ((az % 360.0) + 360.0) % 360.0
            headingAtMs = SystemClock.elapsedRealtime()
        }
        override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) { stopSelf(); return START_NOT_STICKY }
        if (running) return START_NOT_STICKY
        running = true
        instance = this

        createChannel()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIF_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
            } else {
                startForeground(NOTIF_ID, buildNotification())
            }
        } catch (e: Exception) {
            // Type mismatch / missing permission must never crash the process.
            running = false
            instance = null
            stopSelf()
            return START_NOT_STICKY
        }

        val t = HandlerThread("flock-radar").also { it.start() }
        thread = t
        val h = Handler(t.looper)
        handler = h

        // Short partial wakelock (capped): keeps the beep scheduler + sensors
        // honest with the screen off. A radar walk is minutes, not hours.
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "flock:radar").also {
                it.acquire(WAKELOCK_MAX_MS)
            }
        } catch (_: Exception) {}

        lm = getSystemService(Context.LOCATION_SERVICE) as? LocationManager
        try {
            lm?.requestLocationUpdates(LocationManager.GPS_PROVIDER, GPS_INTERVAL_MS, 0f, locationListener, t.looper)
            if (lm?.isProviderEnabled(LocationManager.NETWORK_PROVIDER) == true) {
                lm?.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, GPS_INTERVAL_MS, 0f, locationListener, t.looper)
            }
        } catch (_: Exception) {}

        sm = getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        sm?.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)?.let { sensor ->
            sm?.registerListener(sensorListener, sensor, SensorManager.SENSOR_DELAY_UI, h)
        }

        h.post { tickAndSchedule() }
        // NOT sticky: a session the OS reclaims must fall silent, not resurrect
        // itself later with a stale target and start beeping in a pocket.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        running = false
        instance = null
        try { lm?.removeUpdates(locationListener) } catch (_: Exception) {}
        try { sm?.unregisterListener(sensorListener) } catch (_: Exception) {}
        try { vibrator()?.cancel() } catch (_: Exception) {}
        try { wakeLock?.let { if (it.isHeld) it.release() } } catch (_: Exception) {}
        thread?.quitSafely()
        thread = null
        handler = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ── The guide loop: pure core → sound + haptics ─────────────────────────

    /** Compass heading if fresh, else GPS course over ground (walk-a-few-steps). */
    private fun effectiveHeading(): Double? {
        val h = headingDeg
        if (h != null && SystemClock.elapsedRealtime() - headingAtMs < HEADING_MAX_AGE_MS) return h
        val p = prevFix
        val c = curFix ?: return null
        if (p == null) return null
        if (SystemClock.elapsedRealtime() / 1000.0 - c.atSec > COURSE_MAX_AGE_SEC) return null
        return courseFromFixes(p, c)
    }

    private fun targetObservation(): TargetObservation? {
        val lat = targetLat ?: return null
        val lon = targetLon ?: return null
        val ageSec = (System.currentTimeMillis() - targetAtMs).coerceAtLeast(0) / 1000.0
        return TargetObservation(LatLng(lat, lon), targetUncertaintyMetres, ageSec)
    }

    private fun tickAndSchedule() {
        if (!running) return
        val g = radarGuidance(RadarInput(curFix?.position, effectiveHeading(), targetObservation()))
        val cue = cueFor(g)
        // Arrival: silence with ONE confirming haptic on the transition.
        if (g.state == "arrived" && lastState != "arrived") vibrate(cue.vibrateMs)
        lastState = g.state
        if (cue.pattern != "silent") {
            if (!muted) playBurst(cue.toneHz, when (cue.pattern) { "triple" -> 3; "double" -> 2; else -> 1 })
            vibrate(cue.vibrateMs)
        }
        handler?.postDelayed({ tickAndSchedule() }, if (cue.pattern == "silent") 300 else cue.periodMs)
    }

    /** The distinct "target moved" interrupt (rising two-note + short triple). */
    private fun movedPulse() {
        handler?.post {
            if (!running) return@post
            if (!muted) { playTone(660, 90); handler?.postDelayed({ playTone(1320, 90) }, 110) }
            vibrate(longArrayOf(40, 40, 40))
        }
    }

    // ── Audio: short synthesised triangle beeps (no assets, media stream) ───

    private fun playBurst(hz: Int, count: Int) {
        for (i in 0 until count) handler?.postDelayed({ playTone(hz, BEEP_MS) }, (i * 150).toLong())
    }

    private fun playTone(hz: Int, durMs: Int) {
        if (hz <= 0) return
        try {
            val n = SAMPLE_RATE * durMs / 1000
            val pcm = ShortArray(n)
            val attack = (n / 8).coerceAtLeast(1)
            for (i in 0 until n) {
                val phase = (i.toDouble() * hz / SAMPLE_RATE) % 1.0
                val tri = if (phase < 0.5) 4 * phase - 1 else 3 - 4 * phase
                val env = if (i < attack) i.toDouble() / attack else 1.0 - (i - attack).toDouble() / (n - attack)
                pcm[i] = (tri * env * 0.32 * Short.MAX_VALUE).toInt().toShort()
            }
            val track = AudioTrack(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
                AudioFormat.Builder()
                    .setSampleRate(SAMPLE_RATE)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build(),
                pcm.size * 2, AudioTrack.MODE_STATIC, 0,
            )
            track.write(pcm, 0, pcm.size)
            track.play()
            handler?.postDelayed({ try { track.release() } catch (_: Exception) {} }, (durMs + 60).toLong())
        } catch (_: Exception) { /* audio unavailable — haptics still run */ }
    }

    // ── Haptics ──────────────────────────────────────────────────────────────

    private fun vibrator(): Vibrator? = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    } catch (_: Exception) { null }

    private fun vibrate(pattern: LongArray) {
        if (pattern.isEmpty()) return
        try {
            // navigator.vibrate semantics: [on, off, on, …] — createWaveform
            // alternates starting with an OFF slot, so prepend 0.
            val timings = LongArray(pattern.size + 1)
            pattern.copyInto(timings, 1)
            vibrator()?.vibrate(VibrationEffect.createWaveform(timings, -1))
        } catch (_: Exception) { /* no haptics */ }
    }

    // ── Notification ─────────────────────────────────────────────────────────

    private fun buildNotification(): Notification {
        val stop = PendingIntent.getService(
            this, 0,
            Intent(this, RadarGuideService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        // Deliberately low-detail: no target name on the lock screen (goal §7).
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("flock")
            .setContentText("Radar active")
            .setSmallIcon(applicationInfo.icon)
            .setOngoing(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .addAction(0, "Stop", stop)
            .build()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL_ID, "Radar", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Keeps radar navigation guiding by ear while the screen is off."
                setShowBadge(false)
            }
            (getSystemService(NOTIFICATION_SERVICE) as? NotificationManager)?.createNotificationChannel(ch)
        }
    }

    companion object {
        private const val CHANNEL_ID = "flock-radar-v1"
        private const val NOTIF_ID = 4212
        private const val ACTION_STOP = "cc.trotters.flock.RADAR_STOP"
        private const val GPS_INTERVAL_MS = 2_000L
        private const val SAMPLE_RATE = 22_050
        private const val BEEP_MS = 70
        private const val HEADING_MAX_AGE_MS = 3_000L
        private const val COURSE_MAX_AGE_SEC = 30.0
        // Hard cap on the wakelock — a forgotten session must not hold it all
        // night. The service keeps running (FGS); only the wakelock lapses.
        private const val WAKELOCK_MAX_MS = 45 * 60_000L

        @Volatile private var instance: RadarGuideService? = null

        // The selected target's latest permitted disclosure — set from JS via
        // RadarGuidePlugin before/while the service runs. @Volatile: written on
        // the bridge thread, read on the guide loop.
        @Volatile private var targetLat: Double? = null
        @Volatile private var targetLon: Double? = null
        @Volatile private var targetUncertaintyMetres: Double = 0.0
        @Volatile private var targetAtMs: Long = 0
        @Volatile var muted: Boolean = false

        val active: Boolean get() = instance != null

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, RadarGuideService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, RadarGuideService::class.java))
        }

        /** A fresh permitted disclosure for the selected person. Fires the
         *  "target moved" interrupt when it is a genuine move (pure rule). */
        fun updateTarget(lat: Double, lon: Double, uncertaintyMetres: Double, timestampMs: Long) {
            val prev = targetLat?.let { la ->
                targetLon?.let { lo -> PositionObservation(LatLng(la, lo), targetUncertaintyMetres) }
            }
            val changed = timestampMs != targetAtMs
            targetLat = lat
            targetLon = lon
            targetUncertaintyMetres = uncertaintyMetres
            targetAtMs = timestampMs
            if (changed && targetMoved(prev, PositionObservation(LatLng(lat, lon), uncertaintyMetres))) {
                instance?.movedPulse()
            }
        }

        /** Wipe the target (radar closed) so a later session can't inherit it. */
        fun clearTarget() {
            targetLat = null
            targetLon = null
            targetUncertaintyMetres = 0.0
            targetAtMs = 0
            muted = false
        }
    }
}
