# gps-probe — Layer-B GPS-delivery spike

A **standalone** minimal Android app (appId `cc.trotters.gpsprobe`, installs
alongside flock) that answers one question the flock PWA/Capacitor build cannot
answer cleanly:

> On Android / GrapheneOS, does a **locked, backgrounded** foreground service on
> the raw `LocationManager` keep receiving GPS fixes?

It is deliberately *not* flock: no Capacitor, no WebView, no crypto, no relay, no
JS. Just a `location`-typed foreground service that samples `LocationManager`
(GPS + network, no Google Play Services — GrapheneOS-safe) and appends every fix
to a log file, plus a 30-second **heartbeat** line. See
`../../docs/plans/2026-06-30-phase0-graphene-spike.md` and
`../../docs/plans/2026-07-05-native-background-publish.md`.

## Reading the result (tri-state)

Lock the phone, walk around for 20–30+ min (long enough for Doze), then read the
on-screen stats or the log:

| What the log shows after locking | Meaning | Verdict for `canary-native` |
|---|---|---|
| `FIX` lines keep coming | GPS delivered to a locked FGS works | **Green** — the WebView-JS seam was the whole problem; moving the pipeline native fixes it |
| `BEAT` heartbeats continue, `FIX` lines stop | Process alive, OS stopped feeding GPS | **Red (delivery)** — a native pipeline alone won't help; fix location delivery first |
| `BEAT` heartbeats also stop | Doze/battery killed the service | **Red (process)** — keep-alive / battery-exemption problem |

## Build

```sh
# from repo root
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
  native/gps-probe/gradlew -p native/gps-probe assembleDebug
# APK: native/gps-probe/app/build/outputs/apk/debug/app-debug.apk
```

## Install & run

```sh
adb install -r native/gps-probe/app/build/outputs/apk/debug/app-debug.apk
```

Then on the phone: open **GPS Probe** → tap **Start probe** → grant location
**"Allow all the time"** + notifications → tap **Disable battery optimisation** →
lock the screen and walk. The on-screen readout (total fixes, longest gap,
bg-location/battery state) updates live when you reopen it — read that number off
the screen (no adb needed on the field GrapheneOS device).

Pull the full log via adb (Tier-1 devices):

```sh
adb pull /sdcard/Android/data/cc.trotters.gpsprobe/files/gps-probe.log
```
