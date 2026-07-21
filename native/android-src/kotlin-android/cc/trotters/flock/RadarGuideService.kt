// flock — locked-phone radar guide (Android/GrapheneOS), v2.
//
// A user-started, location-typed foreground service that keeps radar's BY-EAR
// guidance alive while the screen is locked and the WebView is suspended: it
// samples GPS directly (the mechanism the Phase-0 probe measured green on a
// locked GrapheneOS Pixel), reads the rotation-vector compass, and drives the
// beep grammar + vibration + voice natively. Every DECISION comes from the pure
// RadarCore port (cc.trotters.flock.radar), which golden vectors pin to the
// tested JS module — the locked beeper can never be more confident than the
// foreground tracker.
//
// v2 (radar-navigation-v2) brings the FULL locked-phone parity: the heading
// engine (compass distrusted in a vehicle — getBearing/getSpeed/getAccuracy +
// onAccuracyChanged), the VECTOR/SEEK/HOMING mode machine, stereo turn-direction
// panning, the signed haptic vocabulary, and the pre-baked voice channel (the
// same OpenAI-TTS clips the web plays, from assets, with Android TextToSpeech as
// the fallback) — all offline, all with the screen locked.
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
import android.media.MediaPlayer
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.speech.tts.TextToSpeech
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import cc.trotters.flock.publish.LatLng
import cc.trotters.flock.publish.haversineMetres
import cc.trotters.flock.radar.CueContext
import cc.trotters.flock.radar.HeadingInput
import cc.trotters.flock.radar.ModeInput
import cc.trotters.flock.radar.Radar
import cc.trotters.flock.radar.RadarGuidance
import cc.trotters.flock.radar.RadarInput
import cc.trotters.flock.radar.TargetObservation
import cc.trotters.flock.radar.PositionObservation
import cc.trotters.flock.radar.TimedPosition
import cc.trotters.flock.radar.bleAssistUsable
import cc.trotters.flock.radar.bleProximityFromRssi
import cc.trotters.flock.radar.courseFromFixes
import cc.trotters.flock.radar.crossedMilestone
import cc.trotters.flock.radar.cueFor
import cc.trotters.flock.radar.radarGuidance
import cc.trotters.flock.radar.resolveHeading
import cc.trotters.flock.radar.selectMode
import cc.trotters.flock.radar.clockHour
import cc.trotters.flock.radar.smoothClosingRate
import cc.trotters.flock.radar.smoothHeadingDeg
import cc.trotters.flock.radar.speakableDistanceMetres
import cc.trotters.flock.radar.stableClockHour
import cc.trotters.flock.radar.targetMoved
import cc.trotters.flock.radar.voiceLine
import dev.forgesworn.meshble.MeshBleRssiBus
import java.util.Locale

class RadarGuideService : Service() {
    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var lm: LocationManager? = null
    private var sm: SensorManager? = null
    private var wakeLock: PowerManager.WakeLock? = null
    /** elapsedRealtime of the wakelock's last acquire() — the renewal clock. */
    private var wakeLockAcquiredAtMs: Long = 0
    @Volatile private var running = false

    // My side of the bearing — direct GPS fixes (previous + current for the
    // course-over-ground fallback), the Doppler course/speed/accuracy the chip
    // gives for free (v2 Fault 1/4), and the rotation-vector compass.
    @Volatile private var prevFix: TimedPosition? = null
    @Volatile private var curFix: TimedPosition? = null
    @Volatile private var myCourseDeg: Double? = null
    @Volatile private var mySpeedMps: Double? = null
    @Volatile private var myAccuracyMetres: Double? = null
    @Volatile private var headingDeg: Double? = null
    @Volatile private var headingAtMs: Long = 0
    @Volatile private var compassUsable: Boolean = true

    // v2 engine state (guide-loop thread only).
    private var smoothedHeading: Double? = null
    private var currentMode: String = "seek"
    private var closingRate: Double? = null
    private var lastDistance: Double? = null
    private var lastDistanceAtMs: Long = 0
    private var fastSinceMs: Long = 0
    private var slowSinceMs: Long = 0
    private var lastState: String? = null
    private var lastAnnouncedMode: String? = null
    private var lastHeadingStatus: String = "none"
    private var lastVoiceAtMs: Long = 0
    /** The boundary-sticky clock hour every spoken direction uses (null = no
     *  honest bearing) — one tracker for callout/milestone/periodic/moved, so
     *  the voice never names two hours in one breath. Mirrors the JS side. */
    private var spokenClockHour: Int? = null
    private var lastSpokenClockHour: Int? = null
    private var lastPeriodicAtMs: Long = 0
    @Volatile private var movedAnnouncePending = false
    private var lastBleClose = false

    // Phase 3 — BLE RSSI proximity assist. MeshBleRssiBus calls on arbitrary BLE
    // callback threads; samples are hopped onto THIS service's own handler
    // thread (onRssiSample) so the window is only ever touched from the guide
    // loop, like every other tick-loop field here. (rssi, atEpochMs) pairs,
    // oldest first.
    private val bleWindow = ArrayDeque<Pair<Double, Long>>()

    // Voice: pre-baked clips (from assets) + Android TTS fallback.
    private var tts: TextToSpeech? = null
    @Volatile private var ttsReady = false
    private var availableClips: Set<String> = emptySet()
    private val clipQueue = ArrayDeque<String>()
    private var clipPlayer: MediaPlayer? = null

    private val locationListener = object : LocationListener {
        override fun onLocationChanged(loc: Location) {
            val at = SystemClock.elapsedRealtime() / 1000.0
            val fix = TimedPosition(LatLng(loc.latitude, loc.longitude), at)
            val cur = curFix
            if (cur == null || fix.atSec > cur.atSec) { prevFix = cur; curFix = fix }
            // The chip's Doppler course/speed and its accuracy — surfaced (v2).
            myCourseDeg = if (loc.hasBearing()) loc.bearing.toDouble() else null
            mySpeedMps = if (loc.hasSpeed()) loc.speed.toDouble() else null
            myAccuracyMetres = if (loc.hasAccuracy()) loc.accuracy.toDouble() else null
        }
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
    }

    private val sensorListener = object : SensorEventListener {
        private val rot = FloatArray(9)
        private val ori = FloatArray(3)
        private var lastSinkAtMs = 0L
        override fun onSensorChanged(e: SensorEvent) {
            SensorManager.getRotationMatrixFromVector(rot, e.values)
            SensorManager.getOrientation(rot, ori)
            val az = Math.toDegrees(ori[0].toDouble())
            val h = ((az % 360.0) + 360.0) % 360.0
            headingDeg = h
            headingAtMs = SystemClock.elapsedRealtime()
            // Mirror the compass to the WebView (throttled): the DOM's
            // deviceorientation gives the Capacitor WebView nothing absolute, so
            // without this the on-screen scope can't act like a compass (field
            // test 2026-07-21 — the pointer froze when the phone was set down).
            val now = SystemClock.elapsedRealtime()
            if (now - lastSinkAtMs >= HEADING_SINK_MIN_MS) {
                lastSinkAtMs = now
                headingSink?.invoke(h, compassUsable)
            }
        }
        override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {
            // Android's own "this magnetometer is unreliable" signal (v2 Fault 1):
            // an unreliable/low compass is removed from the heading arbitration.
            compassUsable = accuracy != SensorManager.SENSOR_STATUS_UNRELIABLE &&
                accuracy != SensorManager.SENSOR_STATUS_ACCURACY_LOW
        }
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
        // honest with the screen off. Never untimed — renewed (not re-created)
        // before it expires, from the guide loop, so a long walk doesn't lose
        // the radios mid-route (see renewWakeLockIfNeeded). Not reference-
        // counted: a renewal is a plain re-acquire that resets the SAME cap,
        // not a stacked hold needing a matching extra release().
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "flock:radar").also {
                it.setReferenceCounted(false)
                it.acquire(WAKELOCK_MAX_MS)
            }
            wakeLockAcquiredAtMs = SystemClock.elapsedRealtime()
        } catch (_: Exception) {}

        // Pre-baked voice clips ship in the web assets (Capacitor copies them to
        // assets/public/voice); list what's present so playback can fall back to
        // TTS for anything missing. TTS is the offline fallback voice.
        try { availableClips = assets.list("public/voice")?.filter { it.endsWith(".mp3") }?.map { it.removeSuffix(".mp3") }?.toSet() ?: emptySet() } catch (_: Exception) {}
        try { tts = TextToSpeech(this) { status -> ttsReady = status == TextToSpeech.SUCCESS; if (ttsReady) try { tts?.language = Locale.UK } catch (_: Exception) {} } } catch (_: Exception) {}

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

        // Same-process bridge for attributed RSSI (Phase 3): the JS side turns
        // radio sampling on/off (capacitor-mesh-ble's startRssiSampling) — this
        // only CONSUMES whatever the plugin already attributed to an
        // identified peer. Filtered to the current target's peer id in
        // onRssiSample; a pin (no meshPeerId) or a coarse share simply never
        // matches / never blends (bleAssistUsable, same as the JS core).
        MeshBleRssiBus.setListener { peer, _, rssi, _, at -> handler?.post { onRssiSample(peer, rssi, at) } }

        h.post { tickAndSchedule() }
        // NOT sticky: a session the OS reclaims must fall silent, not resurrect
        // itself later with a stale target and start beeping in a pocket.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        running = false
        instance = null
        try { MeshBleRssiBus.clearListener() } catch (_: Exception) {}
        try { lm?.removeUpdates(locationListener) } catch (_: Exception) {}
        try { sm?.unregisterListener(sensorListener) } catch (_: Exception) {}
        try { vibrator()?.cancel() } catch (_: Exception) {}
        try { clipPlayer?.release() } catch (_: Exception) {}
        clipPlayer = null
        try { tts?.stop(); tts?.shutdown() } catch (_: Exception) {}
        tts = null
        try { wakeLock?.let { if (it.isHeld) it.release() } } catch (_: Exception) {}
        thread?.quitSafely()
        thread = null
        handler = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ── The guide loop: pure core → sound + haptics + voice ─────────────────

    /** GPS course over ground: the Doppler bearing when GENUINELY moving, else a
     *  two-fix fallback ("walk a few steps"). The v2.1 trust floor: below
     *  COURSE_MIN_SPEED_MPS the chip's bearing is a stationary artefact — it
     *  froze the pointer at the last walking direction when the phone was set
     *  down (field test 2026-07-21). */
    private fun effectiveCourse(): Double? {
        val c = curFix ?: return null
        val fresh = SystemClock.elapsedRealtime() / 1000.0 - c.atSec <= COURSE_MAX_AGE_SEC
        myCourseDeg?.let { if (fresh && (mySpeedMps ?: 0.0) >= Radar.COURSE_MIN_SPEED_MPS) return it }
        val p = prevFix ?: return null
        if (!fresh) return null
        return courseFromFixes(p, c)
    }

    /** Ground speed: the chip's value, else derived from my two recent fixes. */
    private fun effectiveSpeed(): Double? {
        mySpeedMps?.let { return it }
        val p = prevFix; val c = curFix ?: return null
        if (p == null || c.atSec <= p.atSec) return null
        return haversineMetres(p.position, c.position) / (c.atSec - p.atSec)
    }

    private fun targetObservation(): TargetObservation? {
        val lat = targetLat ?: return null
        val lon = targetLon ?: return null
        // A stationary waypoint (a dropped pin) is always perfectly known — it
        // never moves and there is no JS beacon path to re-stamp it while locked,
        // so hold its age at zero rather than let it decay to the "stale" cue.
        val ageSec = if (evergreen) 0.0 else (System.currentTimeMillis() - targetAtMs).coerceAtLeast(0) / 1000.0
        return TargetObservation(LatLng(lat, lon), targetUncertaintyMetres, ageSec)
    }

    private fun alphaFor(mode: String): Double = when (mode) { "vector" -> 0.5; "homing" -> 0.15; else -> 0.3 }

    // ── Phase 3: BLE RSSI proximity assist ───────────────────────────────────

    /** MeshBleRssiBus callback, already hopped onto the guide-loop thread.
     *  Filters to the CURRENT target's mesh peer id — never null (a pin has no
     *  meshPeerId, so this simply never matches for one). */
    private fun onRssiSample(peer: String, rssi: Int, at: Long) {
        val want = targetPeerId ?: return
        if (peer != want) return
        bleWindow.addLast(rssi.toDouble() to at)
        while (bleWindow.size > BLE_WINDOW_MAX_SAMPLES) bleWindow.removeFirst()
    }

    /** Age out stale samples and re-derive the band — every tick, so a window
     *  that goes quiet (mesh drops, target walks out of range) decays to null
     *  within one window's width, same as the JS controller. */
    private fun currentBleProximity(nowMs: Long): String? {
        val cutoff = nowMs - BLE_WINDOW_MAX_AGE_MS
        while (bleWindow.isNotEmpty() && bleWindow.first().second < cutoff) bleWindow.removeFirst()
        return bleProximityFromRssi(bleWindow.map { it.first })
    }

    /** Re-acquire the capped partial wakelock before its timeout expires, so a
     *  long walk doesn't lose the radios mid-route. Always timeout-bound
     *  (never an untimed lock) — this only pushes the SAME cap forward,
     *  repeatedly, from the guide loop that already runs every tick. */
    private fun renewWakeLockIfNeeded(elapsedNow: Long) {
        val wl = wakeLock ?: return
        if (elapsedNow - wakeLockAcquiredAtMs < WAKELOCK_MAX_MS - WAKELOCK_RENEW_MARGIN_MS) return
        try {
            wl.acquire(WAKELOCK_MAX_MS)
            wakeLockAcquiredAtMs = elapsedNow
        } catch (_: Exception) {}
    }

    private fun tickAndSchedule() {
        if (!running) return
        val nowMs = System.currentTimeMillis()
        val elapsed = SystemClock.elapsedRealtime()
        renewWakeLockIfNeeded(elapsed)

        // Heading engine (v2): arbitrate compass vs course by speed.
        val course = effectiveCourse()
        val speed = effectiveSpeed()
        val compass = headingDeg?.takeIf { elapsed - headingAtMs < HEADING_MAX_AGE_MS }
        val solution = resolveHeading(HeadingInput(compass, compassUsable, course, speed))

        val target = targetObservation()
        val me = curFix?.position
        val prelimDist = if (me != null && target != null) haversineMetres(me, target.position) else null
        // Phase 3: age the RSSI window and re-derive the band every tick, same
        // cadence as everything else here.
        val bleProximity = currentBleProximity(nowMs)

        // Sustained-speed durations for the mode machine's hysteresis.
        val sp = speed ?: 0.0
        if (sp >= Radar.VECTOR_ENTER_SPEED_MPS) { if (fastSinceMs == 0L) fastSinceMs = elapsed } else fastSinceMs = 0L
        if (sp < Radar.VECTOR_EXIT_SPEED_MPS) { if (slowSinceMs == 0L) slowSinceMs = elapsed } else slowSinceMs = 0L
        val fastFor = if (fastSinceMs == 0L) 0.0 else (elapsed - fastSinceMs) / 1000.0
        val slowFor = if (slowSinceMs == 0L) 0.0 else (elapsed - slowSinceMs) / 1000.0

        currentMode = selectMode(ModeInput(currentMode, prelimDist, speed, fastFor, slowFor, target?.uncertaintyMetres, bleProximity))
        modeShared = currentMode

        smoothedHeading = solution.headingDeg?.let { smoothHeadingDeg(smoothedHeading, it, alphaFor(currentMode)) }

        val g = radarGuidance(RadarInput(me, smoothedHeading, target, myAccuracyMetres))

        // Warmer/colder: smooth d(distance)/dt for the HOMING trend note.
        val dist = g.distanceMetres
        if (dist != null && lastDistance != null && lastDistanceAtMs != 0L) {
            val dt = (nowMs - lastDistanceAtMs) / 1000.0
            closingRate = smoothClosingRate(closingRate, lastDistance!!, dist, dt, RATE_ALPHA)
        }

        val cue = cueFor(g, CueContext(currentMode, closingRate, bleProximity))

        // Arrival: silence with ONE confirming haptic on the transition.
        if (g.state == "arrived" && lastState != "arrived") vibrate(cue.vibrateMs)

        // The combined "very close, by radio" claim — HOMING + an honestly-
        // usable (non-coarse, GPS-near) immediate band. bleAssistUsable is the
        // SAME gate cueFor/selectMode already applied; this only decides the
        // status/voice claim, never blends anything itself.
        val bleClose = currentMode == "homing" && bleProximity == "immediate" && bleAssistUsable(g, bleProximity)

        // The ONE clock every spoken direction uses: boundary-sticky, reset the
        // moment the bearing stops being honest, re-adopted fresh on return.
        spokenClockHour = if (g.bearingUsable) stableClockHour(spokenClockHour, g.relativeBearingDeg) else null

        announceVoice(g, currentMode, solution.status, bleClose, nowMs)
        lastBleClose = bleClose
        lastSpokenClockHour = spokenClockHour

        if (cue.pattern != "silent") {
            if (!muted) {
                playBurst(cue.toneHz, when (cue.pattern) { "triple" -> 3; "double" -> 2; else -> 1 }, cue.pan)
                // Warmer/colder second note (HOMING): rising when closing, falling when receding.
                cue.trend?.let { tr ->
                    val second = if (tr == "closing") (cue.toneHz * 1.5).toInt() else (cue.toneHz * 0.7).toInt()
                    handler?.postDelayed({ playTone(second, BEEP_MS, cue.pan) }, 90)
                }
            }
            vibrate(cue.vibrateMs)
            // Signed turn haptic, between bursts, when off-beam (eyes/ears-free).
            cue.sign?.let { sign ->
                val pattern = if (sign == "right") longArrayOf(30, 60, 30) else longArrayOf(180)
                handler?.postDelayed({ if (running) vibrate(pattern) }, maxOf(120L, cue.periodMs / 2))
            }
        }

        lastState = g.state
        lastAnnouncedMode = currentMode
        lastHeadingStatus = solution.status
        if (dist != null) { lastDistance = dist; lastDistanceAtMs = nowMs }
        handler?.postDelayed({ tickAndSchedule() }, if (cue.pattern == "silent") 300 else cue.periodMs)
    }

    /** The distinct "target moved" interrupt (rising two-note + short triple).
     *  Also owes the spoken twin — beacons are sparse (cell-gated, ≥45 s), so a
     *  landing disclosure must be unmissable by ear (v2.1). */
    private fun movedPulse() {
        movedAnnouncePending = true
        handler?.post {
            if (!running) return@post
            if (!muted) { playTone(660, 90, 0.0); handler?.postDelayed({ playTone(1320, 90, 0.0) }, 110) }
            vibrate(longArrayOf(40, 40, 40))
        }
    }

    // ── Voice: pre-baked clips (assets) + Android TextToSpeech fallback ──────

    /** The voice policy, mirroring the JS controller: mode/degradation/compass/
     *  arrival everywhere; distance milestones + bearing swings only in VECTOR. */
    private fun announceVoice(g: RadarGuidance, mode: String, status: String, bleClose: Boolean, nowMs: Long) {
        if (!voice) return
        if (g.state == "arrived" && lastState != "arrived") {
            playVoice(listOf("state-arrived"), voiceLine("arrived", g), nowMs, urgent = true); return
        }
        if (mode != lastAnnouncedMode && lastAnnouncedMode != null) {
            playVoice(listOf("mode-$mode"), voiceLine("mode", g, mode = mode), nowMs); return
        }
        if (status == "compass-unreliable" && lastHeadingStatus != "compass-unreliable") {
            playVoice(listOf("state-compass-unreliable"), voiceLine("compass-unreliable", g), nowMs); return
        }
        val degraded = g.state in DEGRADED_STATES
        val wasDegraded = lastState in DEGRADED_STATES
        if (degraded && !wasDegraded) {
            playVoice(listOf("state-${g.state}"), voiceLine("degraded", g, degradedState = g.state), nowMs); return
        }
        // Phase 3: the band just became honestly "very close" while homing —
        // radio confirming a story GPS alone can't finish indoors. Rate-
        // limited like every other line; never a distance, never a direction.
        if (bleClose && !lastBleClose) {
            playVoice(listOf("state-ble-close"), voiceLine("ble-close", g), nowMs); return
        }
        // Every spoken clock reference below rides the ONE boundary-sticky hour
        // the tick tracked — never the raw bearing — matching the JS controller.
        val stableRel = spokenClockHour?.let { (it % 12) * 30.0 }
        val gSpoken = if (stableRel == null) g else g.copy(relativeBearingDeg = stableRel)

        // A genuine target move (v2.1): the spoken twin of the moved pulse.
        if (movedAnnouncePending) {
            movedAnnouncePending = false
            val md = g.distanceMetres
            if (md != null) {
                val rounded = speakableDistanceMetres(md)
                if (playVoice(listOf("state-moved") + rangeClips(rounded, gSpoken), voiceLine("moved", gSpoken, distanceMetres = rounded, fmtDistance = { m -> fmtMetric(m) }), nowMs)) {
                    lastPeriodicAtMs = nowMs
                }
                return
            }
        }
        // VECTOR: milestone crossings lead (the line carries the clock).
        if (mode == "vector" && g.bearingUsable && g.distanceMetres != null) {
            val ms = crossedMilestone(lastDistance, g.distanceMetres!!)
            if (ms != null) {
                if (playVoice(rangeClips(ms, gSpoken), voiceLine("milestone", gSpoken, distanceMetres = ms, fmtDistance = { m -> fmtMetric(m) }), nowMs)) {
                    lastPeriodicAtMs = nowMs // a milestone line counts as this minute's range callout
                }
                return
            }
        }
        // A meaningful direction change — the spoken hour flipped — is ALWAYS
        // called out, in EVERY mode while the bearing is honest (field feedback
        // 2026-07-21). Boundary chatter cannot happen (stableClockHour holds a
        // sticky band past each sector edge); its own faster floor applies.
        val sc = spokenClockHour
        if (sc != null && lastSpokenClockHour != null && sc != lastSpokenClockHour) {
            val dir = clockClip(stableRel, g.bearingUsable)
            playVoice(if (dir != null) listOf(dir) else emptyList(), voiceLine("bearing-change", gSpoken), nowMs,
                minIntervalMs = (Radar.VOICE_DIRECTION_MIN_INTERVAL_SEC * 1000).toLong())
            return
        }

        // The minute-cadence status line (v2.1, every mode): rounded range +
        // clock-face direction, range-only when the bearing isn't honest. The
        // by-ear glance the 2026-07-21 field test asked for.
        val d = g.distanceMetres
        if (d != null && g.state in PERIODIC_STATES &&
            nowMs - lastPeriodicAtMs >= (Radar.PERIODIC_VOICE_SEC * 1000).toLong()
        ) {
            val rounded = speakableDistanceMetres(d)
            if (playVoice(rangeClips(rounded, gSpoken), voiceLine("periodic", gSpoken, distanceMetres = rounded, fmtDistance = { m -> fmtMetric(m) }), nowMs)) {
                lastPeriodicAtMs = nowMs
            }
        }
    }

    /** "<range clip>, <clock clip>" — the clock rides only an honest bearing. */
    private fun rangeClips(metres: Double, g: RadarGuidance): List<String> {
        val dist = DIST_CLIP[metres] ?: return emptyList()
        val dir = clockClip(g.relativeBearingDeg, g.bearingUsable)
        return if (dir != null) listOf(dist, dir) else listOf(dist)
    }

    private fun clockClip(rel: Double?, usable: Boolean): String? {
        if (!usable) return null
        val h = clockHour(rel) ?: return null
        return "clock-$h"
    }

    private fun fmtMetric(m: Double): String =
        if (m < 1000) "${Math.round(m)} metres" else String.format(Locale.UK, "%.1f km", m / 1000.0)

    /** Play the pre-baked clip sequence when every clip is present, else speak
     *  the fallback line with TTS. Gated on the Voice toggle + rate limit.
     *  Returns whether a line was actually spoken (the periodic cadence stamps
     *  its clock only on a real utterance). */
    private fun playVoice(clipIds: List<String>, fallback: String, nowMs: Long, urgent: Boolean = false,
                          minIntervalMs: Long = (Radar.VOICE_MIN_INTERVAL_SEC * 1000).toLong()): Boolean {
        if (!voice) return false
        if (!urgent && nowMs - lastVoiceAtMs < minIntervalMs) return false
        if (clipIds.isEmpty() && fallback.isEmpty()) return false
        lastVoiceAtMs = nowMs
        if (clipIds.isNotEmpty() && clipIds.all { availableClips.contains(it) }) playClips(clipIds)
        else ttsSpeak(fallback)
        return true
    }

    private fun ttsSpeak(text: String) {
        if (!ttsReady || text.isEmpty()) return
        try { tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "radar") } catch (_: Exception) {}
    }

    private fun playClips(ids: List<String>) {
        handler?.post {
            clipQueue.clear()
            clipQueue.addAll(ids)
            try { clipPlayer?.release() } catch (_: Exception) {}
            clipPlayer = null
            playNextClip()
        }
    }

    private fun playNextClip() {
        val id = clipQueue.removeFirstOrNull() ?: return
        try {
            val afd = assets.openFd("public/voice/$id.mp3")
            val mp = MediaPlayer()
            mp.setDataSource(afd.fileDescriptor, afd.startOffset, afd.length)
            afd.close()
            mp.setOnCompletionListener { p -> try { p.release() } catch (_: Exception) {}; if (clipPlayer === p) clipPlayer = null; playNextClip() }
            mp.setOnErrorListener { p, _, _ -> try { p.release() } catch (_: Exception) {}; if (clipPlayer === p) clipPlayer = null; true }
            mp.prepare()
            mp.start()
            clipPlayer = mp
        } catch (_: Exception) { clipQueue.clear() }
    }

    // ── Audio: short synthesised triangle beeps, panned in stereo ───────────

    private fun playBurst(hz: Int, count: Int, pan: Double) {
        for (i in 0 until count) handler?.postDelayed({ playTone(hz, BEEP_MS, pan) }, (i * 150).toLong())
    }

    /** One triangle blip, panned by turn direction (pan −1 left … +1 right) via
     *  an equal-power stereo gain law — the native twin of Web Audio's StereoPanner. */
    private fun playTone(hz: Int, durMs: Int, pan: Double) {
        if (hz <= 0) return
        try {
            val n = SAMPLE_RATE * durMs / 1000
            val pcm = ShortArray(n * 2) // interleaved stereo L,R,L,R…
            val theta = (pan.coerceIn(-1.0, 1.0) + 1.0) * (Math.PI / 4.0)
            val lGain = Math.cos(theta)
            val rGain = Math.sin(theta)
            // The same two-layer sonar ping as the web controller (radarMode
            // beep()): a sine fundamental with a 30 ms bloom-and-settle pitch
            // envelope, an octave triangle partial decaying by 60% of the
            // burst, and a one-pole low-pass at 4×hz rounding the edges — the
            // locked-phone ping must sound like the in-hand one.
            val twoPi = 2.0 * Math.PI
            val attackF = (SAMPLE_RATE * 12 / 1000).coerceAtMost(n / 3).coerceAtLeast(1)
            val attackP = (SAMPLE_RATE * 8 / 1000).coerceAtMost(n / 3).coerceAtLeast(1)
            val partEnd = ((n * 6) / 10).coerceAtLeast(attackP + 1)
            val bloomN = (SAMPLE_RATE * 30 / 1000).coerceAtLeast(1)
            val alphaLp = 1.0 - Math.exp(-twoPi * (hz * 4.0) / SAMPLE_RATE)
            var phaseF = 0.0
            var phaseP = 0.0
            var lp = 0.0
            for (i in 0 until n) {
                val f = if (i < bloomN) hz * (1.02 - 0.02 * i.toDouble() / bloomN) else hz.toDouble()
                phaseF += twoPi * f / SAMPLE_RATE
                phaseP += twoPi * (hz * 2.0) / SAMPLE_RATE
                val envF = if (i < attackF) i.toDouble() / attackF else 1.0 - (i - attackF).toDouble() / (n - attackF).coerceAtLeast(1)
                val envP = if (i >= partEnd) 0.0 else if (i < attackP) i.toDouble() / attackP else 1.0 - (i - attackP).toDouble() / (partEnd - attackP)
                val p = (phaseP / twoPi) % 1.0
                val tri = if (p < 0.5) 4 * p - 1 else 3 - 4 * p
                val raw = Math.sin(phaseF) * envF * 0.3 + tri * envP * 0.09
                lp += alphaLp * (raw - lp)
                val s = lp * Short.MAX_VALUE
                pcm[2 * i] = (s * lGain).toInt().toShort()
                pcm[2 * i + 1] = (s * rGain).toInt().toShort()
            }
            val track = AudioTrack(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
                AudioFormat.Builder()
                    .setSampleRate(SAMPLE_RATE)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO)
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
        private const val RATE_ALPHA = 0.3
        private val DEGRADED_STATES = setOf("stale", "coarse", "no-fix", "unavailable")
        // Hard cap on the wakelock — a forgotten session must not hold it all
        // night. The service keeps running (FGS); only the wakelock lapses.
        // Renewed (not raised) well before expiry by renewWakeLockIfNeeded, so
        // an active session never silently loses it mid-route.
        private const val WAKELOCK_MAX_MS = 45 * 60_000L
        private const val WAKELOCK_RENEW_MARGIN_MS = 5 * 60_000L
        // Phase 3 — BLE RSSI proximity assist: rolling window bounds, mirroring
        // app/src/radarMode.ts exactly.
        private const val BLE_WINDOW_MAX_AGE_MS = 12_000L
        private const val BLE_WINDOW_MAX_SAMPLES = 10

        @Volatile private var instance: RadarGuideService? = null
        /** The guide's currently-resolved mode, for the JS getMode bridge. */
        @Volatile private var modeShared: String = "seek"
        /** Where the rotation-vector compass is mirrored for the WebView's
         *  on-screen scope (RadarGuidePlugin sets it; throttled at source). */
        @Volatile var headingSink: ((Double, Boolean) -> Unit)? = null
        private const val HEADING_SINK_MIN_MS = 150L

        // The selected target's latest permitted disclosure — set from JS via
        // RadarGuidePlugin before/while the service runs. @Volatile: written on
        // the bridge thread, read on the guide loop.
        @Volatile private var targetLat: Double? = null
        @Volatile private var targetLon: Double? = null
        @Volatile private var targetUncertaintyMetres: Double = 0.0
        @Volatile private var targetAtMs: Long = 0
        /** The target member's mesh peer id (their pubkey — see app/src/app.ts),
         *  for BLE RSSI attribution. Null for a pin: pins carry no radio, so
         *  onRssiSample's peer filter simply never matches one. */
        @Volatile private var targetPeerId: String? = null
        @Volatile var muted: Boolean = false
        /** The voice (TTS) channel, mirroring the in-app toggle. */
        @Volatile var voice: Boolean = true
        /** A stationary waypoint (a dropped pin): never age it to "stale". */
        @Volatile var evergreen: Boolean = false

        val active: Boolean get() = instance != null
        val mode: String get() = modeShared

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, RadarGuideService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, RadarGuideService::class.java))
        }

        /** A fresh permitted disclosure for the selected person. Fires the
         *  "target moved" interrupt when it is a genuine move (pure rule).
         *  `meshPeerId` (null for a pin) is the mesh peer id BLE RSSI samples
         *  are attributed under — re-sent on every call, same as lat/lon. */
        fun updateTarget(lat: Double, lon: Double, uncertaintyMetres: Double, timestampMs: Long, meshPeerId: String? = null) {
            val prev = targetLat?.let { la ->
                targetLon?.let { lo -> PositionObservation(LatLng(la, lo), targetUncertaintyMetres) }
            }
            val changed = timestampMs != targetAtMs
            targetLat = lat
            targetLon = lon
            targetUncertaintyMetres = uncertaintyMetres
            targetAtMs = timestampMs
            targetPeerId = meshPeerId
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
            targetPeerId = null
            muted = false
            voice = true
            evergreen = false
            modeShared = "seek"
        }

        // Speakable range → clip id (mirrors app/src/voiceClips.ts). Every step
        // of Radar.SPEAKABLE_DISTANCES_METRES has a clip, so the minute line is
        // always clip-composable (GrapheneOS may ship no TTS engine at all).
        private val DIST_CLIP = mapOf(
            10.0 to "dist-10m", 15.0 to "dist-15m", 20.0 to "dist-20m", 25.0 to "dist-25m",
            30.0 to "dist-30m", 40.0 to "dist-40m", 50.0 to "dist-50m", 75.0 to "dist-75m",
            100.0 to "dist-100m", 150.0 to "dist-150m", 200.0 to "dist-200m", 250.0 to "dist-250m",
            300.0 to "dist-300m", 400.0 to "dist-400m", 500.0 to "dist-500m", 750.0 to "dist-750m",
            1000.0 to "dist-1km", 1500.0 to "dist-1-5km", 2000.0 to "dist-2km", 3000.0 to "dist-3km",
            4000.0 to "dist-4km", 5000.0 to "dist-5km", 10_000.0 to "dist-10km",
        )
        /** States that get the minute-cadence range callout: live pointing, a
         *  compassless fallback, and a coarse share (range is still honest). */
        private val PERIODIC_STATES = setOf("point", "no-heading", "coarse")
    }
}
