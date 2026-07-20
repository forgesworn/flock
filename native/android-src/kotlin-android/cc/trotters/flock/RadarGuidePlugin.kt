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
    /** Start guiding. Called from an unlocked, foregrounded radar open — a
     *  legal FGS start. Optional initial target seeds the observation. */
    @PluginMethod
    fun start(call: PluginCall) {
        RadarGuideService.muted = call.getBoolean("muted") ?: false
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
}
