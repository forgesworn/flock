# Native background publish — hardware verification runbook

The build machine needs the Android SDK + JDK 21 (`npm run apk`). Two phones
(A = sharer, B = observer), both on the same circle, real relay configured.

## Build & install

1. The build machine needs `JAVA_HOME` pointing at a JDK 21 and the Android
   SDK (`ANDROID_HOME`). `native/build-apk.sh` prefers the Homebrew JDK 21 on
   macOS if present; otherwise export `JAVA_HOME`/`ANDROID_HOME` yourself
   before running the build.
2. `npm install && npm run apk`
3. Install `android/app/build/outputs/apk/debug/app-debug.apk` on phone A
   (`adb install -r …` or sideload).

## Test 1 — background beacons keep flowing (the headline fix)

1. Phone A: sign in with a LOCAL identity (not Signet), join the circle,
   toggle sharing ON, grant "Allow all the time" location.
2. Lock phone A. Put it in a pocket.
3. Walk ~500 m (several geohash-6 cells) over ≥5 minutes.
4. Phone B (app open): PASS = A's pin moves along the route with multiple
   updates. FAIL = one jump when A's screen comes back on (the old symptom).

## Test 2 — no-report zone holds while locked (security-critical)

1. Phone A: draw a no-report zone (policy: don't report) around a spot ahead.
2. Lock phone A, walk into the zone, wait 2+ min, walk out.
3. Phone B: PASS = pins approach the zone, go silent inside it, resume after.
   Any pin inside the zone = FAIL — file it as a security bug, do not ship.

## Test 3 — foreground/background handover (no double-publish)

1. Phone A: share with the app OPEN for 2 min (JS pipeline), then lock 5 min
   (native), then reopen.
2. Phone B: PASS = continuous, unduplicated updates through both transitions.
3. Phone A after reopening: "last shared" pin history includes the
   background-published cells (journal reconciliation).

## Test 4 — teardowns leave nothing behind

1. Stop sharing while locked-adjacent: toggle sharing OFF → walk → phone B
   sees nothing new.
2. Hide flock (decoy) while sharing → walk → nothing new; unhide → sharing is
   off, no stale notification.
3. With the App lock on, force-stop flock, reopen to the PIN screen, do NOT
   unlock, lock the phone, walk → nothing new (mirror cleared at lock boot).

## Split measurement (if test 1 fails)

The journal (Settings → not exposed in UI; use `adb logcat | grep -i flock` or
a debug read of the FlockPublish plugin's `getJournal`) records `{"t":"fix"}`
entries at native fix arrival and `{"t":"pub"}` at publish. Fixes present but
no pubs → the pipeline is gating or failing (check config mirror, relay
reachability). No fixes at all → the watcher/service died (Phase-0 territory),
not the JS-delivery stall.
