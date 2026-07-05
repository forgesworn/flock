// Capacitor bridge for the native publish config + journal
// (native/publishMirror.ts is the JS side).
package cc.trotters.flock

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "FlockPublish")
class FlockPublishPlugin : Plugin() {
    private val store by lazy { FlockFixReceiver.store(context) }

    @PluginMethod
    fun setConfig(call: PluginCall) {
        val json = call.getString("json")
        if (json == null) { call.reject("missing json"); return }
        store.setConfigJson(json)
        // Called only while sharing + unlocked + foregrounded — a legal FGS start.
        // The native GPS source is alive exactly as long as the config mirror is.
        FlockLocationService.start(context)
        call.resolve()
    }

    @PluginMethod
    fun clearConfig(call: PluginCall) {
        store.clearConfig()
        FlockLocationService.stop(context)
        call.resolve()
    }

    /** Full wipe (decoy hide / reset) — config, cadence and journal together. */
    @PluginMethod
    fun wipeAll(call: PluginCall) {
        store.clearAll()
        FlockLocationService.stop(context)
        call.resolve()
    }

    @PluginMethod
    fun getJournal(call: PluginCall) {
        val out = JSObject()
        out.put("entries", JSArray(store.getJournal()))
        call.resolve(out)
    }

    @PluginMethod
    fun ackJournal(call: PluginCall) {
        store.ackJournal(call.getInt("count") ?: 0)
        call.resolve()
    }
}
