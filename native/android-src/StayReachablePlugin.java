// flock — bridge for the "stay reachable" foreground service (StayReachableService).
//
// Three methods, called from app.ts via native/stayReachable.ts:
//   start()  — start the location-free foreground service (keeps the process,
//              and thus the relay subscription, alive while flock is closed).
//   stop()   — stop it (toggle off / reset / decoy-hide: the ongoing
//              notification must never outlive an explicit teardown).
//   isIgnoringBatteryOptimizations() / requestIgnoreBatteryOptimizations() —
//              Doze will still freeze the service on aggressive OEMs (Samsung)
//              unless flock is exempt; we surface + request the exemption so
//              parity actually holds overnight.
//
// Injected into the generated Capacitor project by native/patch-android.mjs.
package cc.trotters.flock;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "StayReachable")
public class StayReachablePlugin extends Plugin {

  @PluginMethod
  public void start(PluginCall call) {
    Intent i = new Intent(getContext(), StayReachableService.class);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      getContext().startForegroundService(i);
    } else {
      getContext().startService(i);
    }
    call.resolve();
  }

  @PluginMethod
  public void stop(PluginCall call) {
    getContext().stopService(new Intent(getContext(), StayReachableService.class));
    call.resolve();
  }

  @PluginMethod
  public void isIgnoringBatteryOptimizations(PluginCall call) {
    JSObject ret = new JSObject();
    ret.put("value", isExempt());
    call.resolve(ret);
  }

  @PluginMethod
  public void requestIgnoreBatteryOptimizations(PluginCall call) {
    if (isExempt()) {
      call.resolve();
      return;
    }
    try {
      Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
      i.setData(Uri.parse("package:" + getContext().getPackageName()));
      i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      getContext().startActivity(i);
    } catch (Exception e) {
      // Some ROMs block the direct request — fall back to the app's settings
      // page so the user can turn optimisation off manually.
      try {
        Intent s = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
        s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(s);
      } catch (Exception ignored) { /* nothing else to try */ }
    }
    call.resolve();
  }

  private boolean isExempt() {
    PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
    return pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
  }
}
