// Layer-B probe: a location-typed foreground service that samples the raw
// platform LocationManager (no Google Play Services, GrapheneOS-safe) and writes
// every fix to a log file. Deliberately NO wake lock — we measure the OS's honest
// behaviour for a backgrounded/locked FGS, not a battery-burning override.
//
// A 30s heartbeat line is logged regardless of fixes, so the log is tri-state:
//   FIX lines keep coming while locked   -> GPS delivery to a locked FGS works.
//   heartbeats continue, FIX lines stop  -> process alive, OS stopped feeding GPS.
//   heartbeats also stop                 -> Doze/battery killed the service.
package cc.trotters.gpsprobe;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.SystemClock;

import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public class ProbeService extends Service {
  private static final String CHANNEL_ID = "gps-probe-v1";
  private static final int NOTIF_ID = 7788;
  public static final String LOG_NAME = "gps-probe.log";

  private LocationManager lm;
  private HandlerThread thread;
  private Handler handler;
  private long lastFixElapsed = 0;   // elapsedRealtime of last fix; 0 = none yet
  private int totalFixes = 0;
  private long startedElapsed = 0;
  private volatile boolean running = false;

  private final LocationListener listener = new LocationListener() {
    @Override public void onLocationChanged(Location loc) {
      long now = SystemClock.elapsedRealtime();
      long gapMs = (lastFixElapsed == 0) ? -1 : now - lastFixElapsed;
      lastFixElapsed = now;
      totalFixes++;
      String gap = (gapMs < 0) ? "first" : (gapMs / 1000) + "s";
      log(String.format(Locale.UK, "FIX  #%d %s lat=%.5f lon=%.5f acc=%.0fm gap=%s",
          totalFixes, loc.getProvider(), loc.getLatitude(), loc.getLongitude(),
          loc.getAccuracy(), gap));
    }
    @Override public void onProviderEnabled(String p) { log("PROVIDER enabled: " + p); }
    @Override public void onProviderDisabled(String p) { log("PROVIDER disabled: " + p); }
  };

  private final Runnable heartbeat = new Runnable() {
    @Override public void run() {
      if (!running) return;
      long now = SystemClock.elapsedRealtime();
      String since = (lastFixElapsed == 0) ? "none-yet" : ((now - lastFixElapsed) / 1000) + "s-ago";
      long upS = (now - startedElapsed) / 1000;
      log(String.format(Locale.UK, "BEAT alive up=%ds fixes=%d lastFix=%s", upS, totalFixes, since));
      handler.postDelayed(this, 30000);
    }
  };

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (running) return START_STICKY;
    running = true;
    startedElapsed = SystemClock.elapsedRealtime();

    createChannel();
    Notification n = new Notification.Builder(this, CHANNEL_ID)
        .setContentTitle("GPS probe running")
        .setContentText("Logging location fixes")
        .setSmallIcon(android.R.drawable.ic_menu_mylocation)
        .setOngoing(true)
        .build();
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
    } else {
      startForeground(NOTIF_ID, n);
    }

    thread = new HandlerThread("gps-probe");
    thread.start();
    handler = new Handler(thread.getLooper());

    lm = (LocationManager) getSystemService(LOCATION_SERVICE);
    log("=== PROBE START device=" + Build.MANUFACTURER + " " + Build.MODEL
        + " api=" + Build.VERSION.SDK_INT + " ===");
    try {
      lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 10000, 0, listener, thread.getLooper());
      log("requested GPS_PROVIDER @10s");
    } catch (Exception e) {
      log("GPS request FAILED: " + e);
    }
    try {
      if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
        lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 10000, 0, listener, thread.getLooper());
        log("requested NETWORK_PROVIDER @10s");
      } else {
        log("NETWORK_PROVIDER disabled/absent");
      }
    } catch (Exception e) {
      log("NETWORK request FAILED: " + e);
    }

    handler.postDelayed(heartbeat, 30000);
    return START_STICKY;
  }

  @Override
  public void onDestroy() {
    running = false;
    log("=== PROBE STOP totalFixes=" + totalFixes + " ===");
    try { if (lm != null) lm.removeUpdates(listener); } catch (Exception ignored) {}
    if (handler != null) handler.removeCallbacks(heartbeat);
    if (thread != null) thread.quitSafely();
    super.onDestroy();
  }

  @Override public IBinder onBind(Intent intent) { return null; }

  private File logFile() {
    File dir = getExternalFilesDir(null);
    if (dir == null) dir = getFilesDir();
    return new File(dir, LOG_NAME);
  }

  private synchronized void log(String line) {
    String ts = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.UK).format(new Date());
    try (FileWriter w = new FileWriter(logFile(), true)) {
      w.append(ts).append("  ").append(line).append("\n");
    } catch (IOException ignored) {}
  }

  private void createChannel() {
    NotificationChannel ch = new NotificationChannel(
        CHANNEL_ID, "GPS probe", NotificationManager.IMPORTANCE_LOW);
    ch.setDescription("Foreground service logging location fixes");
    NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
    if (nm != null) nm.createNotificationChannel(ch);
  }
}
