// Capacitor bridge for the locked-phone radar guide
// (native/radarGuide.ts is the JS side; RadarGuideService does the work).
package cc.trotters.flock

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "RadarGuide")
class RadarGuidePlugin : Plugin() {
    /** Mirror the service's rotation-vector compass into the WebView as
     *  'heading' events, so the on-screen scope rotates like a real compass
     *  (the WebView's own deviceorientation is not earth-referenced). Throttled
     *  at the source (RadarGuideService.HEADING_SINK_MIN_MS). */
    override fun load() {
        RadarGuideService.headingSink = { deg, usable ->
            val out = JSObject()
            out.put("headingDeg", deg)
            out.put("usable", usable)
            notifyListeners("heading", out)
        }
    }

    /** Start guiding. Called from an unlocked, foregrounded radar open — a
     *  legal FGS start. Optional initial target seeds the observation. */
    @PluginMethod
    fun start(call: PluginCall) {
        RadarGuideService.muted = call.getBoolean("muted") ?: false
        RadarGuideService.voice = call.getBoolean("voice") ?: true
        // A dropped-pin waypoint never ages to "stale" while locked (see the JS
        // openRadarForPin). Defaults false so a member target is unchanged.
        RadarGuideService.evergreen = call.getBoolean("evergreen") ?: false
        val lat = call.getDouble("lat")
        val lon = call.getDouble("lon")
        if (lat != null && lon != null) {
            RadarGuideService.updateTarget(
                lat, lon,
                call.getDouble("uncertaintyMetres") ?: 0.0,
                call.getLong("timestampMs") ?: 0L,
            )
        }
        RadarGuideService.start(context)
        call.resolve()
    }

    /** A fresh permitted disclosure for the selected person (from the JS
     *  beacon path). No relay access here — JS remains the only consumer. */
    @PluginMethod
    fun updateTarget(call: PluginCall) {
        val lat = call.getDouble("lat")
        val lon = call.getDouble("lon")
        if (lat == null || lon == null) { call.reject("missing target"); return }
        RadarGuideService.updateTarget(
            lat, lon,
            call.getDouble("uncertaintyMetres") ?: 0.0,
            call.getLong("timestampMs") ?: 0L,
        )
        call.resolve()
    }

    /** Mute audio only — haptics keep the bearing usable (matches the JS toggle). */
    @PluginMethod
    fun setMuted(call: PluginCall) {
        RadarGuideService.muted = call.getBoolean("muted") ?: false
        call.resolve()
    }

    /** Turn the native voice (TTS/clip) channel on/off (matches the JS toggle). */
    @PluginMethod
    fun setVoice(call: PluginCall) {
        RadarGuideService.voice = call.getBoolean("voice") ?: true
        call.resolve()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        RadarGuideService.stop(context)
        RadarGuideService.clearTarget()
        call.resolve()
    }

    /** Is the guide still running? (The notification's Stop can end it while
     *  the app is locked — JS reconciles on resume.) */
    @PluginMethod
    fun isActive(call: PluginCall) {
        val out = JSObject()
        out.put("value", RadarGuideService.active)
        call.resolve(out)
    }

    /** The guide's currently-resolved VECTOR/SEEK/HOMING mode, so the reopened
     *  JS scope can reflect what the locked run selected. */
    @PluginMethod
    fun getMode(call: PluginCall) {
        val out = JSObject()
        out.put("value", RadarGuideService.mode)
        call.resolve(out)
    }
}
