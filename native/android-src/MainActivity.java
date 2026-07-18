// flock — Capacitor host activity.
//
// Registers the app-local plugins: StayReachable (the location-free "stay
// reachable" foreground service), FlockNotify (message notifications with
// PUBLIC lock-screen visibility), FlockOrbot (the Tor/.onion relay toggle's Orbot reachability
// probe) and FlockPublish (the native background-publish config + journal
// bridge). The background-geolocation and local-notifications plugins are npm
// packages and auto-register; a plugin defined in this module must be
// registered by hand, before super.onCreate.
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
    registerPlugin(FlockOrbotPlugin.class);
    registerPlugin(FlockPublishPlugin.class);
    registerPlugin(RadarGuidePlugin.class);
    super.onCreate(savedInstanceState);
  }
}
