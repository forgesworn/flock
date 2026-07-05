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
        call.resolve()
    }

    @PluginMethod
    fun clearConfig(call: PluginCall) {
        store.clearAll()
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
