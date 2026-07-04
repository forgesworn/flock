// flock — Capacitor host activity.
//
// Registers the app-local plugins: StayReachable (the location-free "stay
// reachable" foreground service) and FlockNotify (message notifications with
// PUBLIC lock-screen visibility). The background-geolocation and
// local-notifications plugins are npm packages and auto-register; a plugin
// defined in this module must be registered by hand, before super.onCreate.
//
// This file REPLACES the stock Capacitor MainActivity via native/patch-android.mjs.
package cc.trotters.flock;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(StayReachablePlugin.class);
    registerPlugin(FlockNotifyPlugin.class);
    super.onCreate(savedInstanceState);
  }
}
