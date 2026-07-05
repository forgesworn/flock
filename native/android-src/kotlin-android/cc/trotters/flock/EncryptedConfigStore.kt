// Keystore-backed mirror of the minimal publish config + the publish journal.
// The design doc's data-access decision: written by JS while unlocked, cleared
// on lock/hide/reset/stop-sharing; a native task can read it without the
// WebView. Journal capped so it can never grow unbounded.
package cc.trotters.flock

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import cc.trotters.flock.publish.BeaconCadence
import cc.trotters.flock.publish.ConfigStore
import org.json.JSONArray

class EncryptedConfigStore(context: Context) : ConfigStore {
    private val prefs: SharedPreferences = EncryptedSharedPreferences.create(
        context,
        "flock-publish",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    override fun getConfigJson(): String? = prefs.getString("config", null)

    fun setConfigJson(json: String?) {
        prefs.edit().apply { if (json == null) remove("config") else putString("config", json) }.apply()
    }

    /** Full teardown: config, cadence state and journal all go together. */
    fun clearAll() { prefs.edit().clear().apply() }

    override fun getCadence(circleId: String): BeaconCadence {
        val g = prefs.getString("cadence.$circleId.g", null)
        val at = prefs.getLong("cadence.$circleId.at", 0)
        return BeaconCadence(g, at)
    }

    override fun setCadence(circleId: String, cadence: BeaconCadence) {
        prefs.edit()
            .putString("cadence.$circleId.g", cadence.lastGeohash)
            .putLong("cadence.$circleId.at", cadence.lastSentAt)
            .apply()
    }

    override fun appendJournal(entryJson: String) {
        val arr = JSONArray(prefs.getString("journal", "[]"))
        arr.put(entryJson)
        // Cap: keep the newest 300 entries.
        val start = maxOf(0, arr.length() - 300)
        val trimmed = JSONArray()
        for (i in start until arr.length()) trimmed.put(arr.get(i))
        prefs.edit().putString("journal", trimmed.toString()).apply()
    }

    fun getJournal(): List<String> {
        val arr = JSONArray(prefs.getString("journal", "[]"))
        return (0 until arr.length()).map { arr.getString(it) }
    }

    fun ackJournal(count: Int) {
        val arr = JSONArray(prefs.getString("journal", "[]"))
        val remaining = JSONArray()
        for (i in count until arr.length()) remaining.put(arr.get(i))
        prefs.edit().putString("journal", remaining.toString()).apply()
    }
}
