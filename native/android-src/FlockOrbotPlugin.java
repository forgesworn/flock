// flock — Orbot (Tor) reachability probe for the `.onion` relay toggle
// (docs/plans/2026-07-04-mesh-bridge-goal.md Task B).
//
// A WebView's `WebSocket`/`fetch` cannot be configured with a SOCKS proxy from
// JS, and a `.onion` address cannot resolve at all without something Tor-aware
// in the path. flock does not implement its own SOCKS client here — instead it
// relies on Orbot's own system-wide/per-app VPN (transparent-proxy) mode, which
// the user enables in the separate Orbot app. This plugin's only job is a
// best-effort SIGNAL that Orbot is actually running: Orbot listens on a local
// SOCKS port (127.0.0.1:9050 by default) whenever it is on, so a successful TCP
// connect there is strong (not certain — the toggle is still opt-in and
// fail-loud, never a silent guarantee) evidence Tor is available.
//
// Injected by native/patch-android.mjs; registered in MainActivity. No new
// manifest permission needed — connecting to localhost only ever needs the
// plain INTERNET permission every networked app already declares.
package cc.trotters.flock;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.InetSocketAddress;
import java.net.Socket;

@CapacitorPlugin(name = "FlockOrbot")
public class FlockOrbotPlugin extends Plugin {
  // Orbot's default SOCKS5 port. Not configurable in the UI (yet) — matches
  // Orbot's own out-of-the-box default, which almost nobody changes.
  private static final int ORBOT_SOCKS_PORT = 9050;
  // Short: this runs on the plugin's own worker thread (Capacitor invokes
  // @PluginMethod off the main thread), but the toggle flow is still
  // interactive — a hung probe must not make "turn Tor on" feel broken.
  private static final int CONNECT_TIMEOUT_MS = 800;

  @PluginMethod
  public void checkSocksProxy(PluginCall call) {
    boolean reachable;
    try (Socket socket = new Socket()) {
      socket.connect(new InetSocketAddress("127.0.0.1", ORBOT_SOCKS_PORT), CONNECT_TIMEOUT_MS);
      reachable = true;
    } catch (Exception e) {
      // Refused/unreachable/timed out — Orbot isn't running (or isn't on the
      // default port). Never throw back to JS: absence just means "not ready".
      reachable = false;
    }
    JSObject ret = new JSObject();
    ret.put("reachable", reachable);
    call.resolve(ret);
  }
}
