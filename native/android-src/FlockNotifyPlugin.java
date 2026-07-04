// flock — message notifications with controllable lock-screen visibility.
//
// Why not just @capacitor/local-notifications? Its LocalNotificationManager
// hardcodes setVisibility(VISIBILITY_PRIVATE) on every notification, so on a
// securely-locked device set to "hide sensitive content" the message body is
// redacted. Darren chose Signal-style "show content on the lock screen", which
// needs notification-level VISIBILITY_PUBLIC (an app CAN set that per
// notification — unlike channel-level PUBLIC, which Android normalises away).
//
// So message/buzz/alert notifications are posted here, natively, with PUBLIC
// visibility; the plugin is still used for the permission prompt + channel
// creation, and for the non-sensitive General channel. Injected by
// native/patch-android.mjs; registered in MainActivity.
package cc.trotters.flock;

import android.app.PendingIntent;
import android.content.Intent;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.atomic.AtomicInteger;

@CapacitorPlugin(name = "FlockNotify")
public class FlockNotifyPlugin extends Plugin {
  private final AtomicInteger seq = new AtomicInteger(5000);

  @PluginMethod
  public void notify(PluginCall call) {
    String channelId = call.getString("channelId");
    String title = call.getString("title", "flock");
    String body = call.getString("body", "");
    String group = call.getString("group", null);
    if (channelId == null) { call.reject("channelId required"); return; }

    int id = call.getInt("id", seq.getAndIncrement());

    NotificationCompat.Builder b = new NotificationCompat.Builder(getContext(), channelId)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
      .setSmallIcon(getContext().getApplicationInfo().icon)
      .setAutoCancel(true)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      // The whole point: full content on the lock screen, above the device's
      // global "hide sensitive content" setting (Signal's default behaviour).
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC);

    if (group != null) b.setGroup(group);

    // Tapping opens flock (the launcher activity), like every other notification.
    Intent launch = getContext().getPackageManager().getLaunchIntentForPackage(getContext().getPackageName());
    if (launch != null) {
      launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
      b.setContentIntent(PendingIntent.getActivity(
        getContext(), id, launch,
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
    }

    try {
      NotificationManagerCompat.from(getContext()).notify(id, b.build());
    } catch (SecurityException e) {
      // POST_NOTIFICATIONS not granted — nothing to show.
    }
    call.resolve();
  }
}
