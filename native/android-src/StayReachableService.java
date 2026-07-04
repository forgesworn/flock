// flock — "stay reachable" foreground service.
//
// A location-FREE foreground service. Its only job is to keep flock's process
// alive while the app is closed/backgrounded so the WebView's already-running
// Nostr relay subscription keeps receiving — every incoming DM / buzz / alert
// then flows through the app's normal decrypt → LocalNotifications pipeline,
// exactly as it does in the foreground. This is what gives Signal-parity
// notifications on a locked screen without Google APIs (GrapheneOS-safe).
//
// Deliberately NOT a location service (unlike the background-geolocation
// watcher): no GPS, no OS location indicator, no battery drain from fixes. The
// type is specialUse — a persistent message connection fits no other category,
// and dataSync is force-capped at ~6h/day on Android 15+ (which the GrapheneOS
// target runs), which would silently break overnight parity.
//
// Injected into the generated Capacitor project by native/patch-android.mjs.
package cc.trotters.flock;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;

public class StayReachableService extends Service {
  private static final String CHANNEL_ID = "flock-stay-reachable-v1";
  private static final int NOTIF_ID = 4210;

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    createChannel();
    Notification n = new NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("flock")
      .setContentText("Staying reachable for messages")
      .setSmallIcon(getApplicationInfo().icon)
      .setOngoing(true)
      .setShowWhen(false)
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .build();
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
    } else {
      startForeground(NOTIF_ID, n);
    }
    // START_STICKY: if the OS reclaims us under memory pressure, restart the
    // service (and thus the process) so we resume watching for messages.
    return START_STICKY;
  }

  private void createChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      NotificationChannel ch = new NotificationChannel(
        CHANNEL_ID, "Staying reachable", NotificationManager.IMPORTANCE_MIN);
      ch.setDescription("Keeps flock able to receive messages while it's closed.");
      ch.setShowBadge(false);
      NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
      if (nm != null) nm.createNotificationChannel(ch);
    }
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}
