// flock — message notifications with controllable lock-screen visibility, plus
// the "make it ring" alarm.
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
// creation, and for the non-sensitive General channel.
//
// ring() is the "make it ring" feature: a lost phone plays an incoming targeted
// buzz as a loud ALARM — it uses the alarm audio stream (so it sounds through
// ring-silent), best-effort DND bypass, and a full-screen intent to wake the
// screen. LocalNotifications can express none of that, so it lives here.
//
// Injected by native/patch-android.mjs; registered in MainActivity.
package cc.trotters.flock;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
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

  private static final String RING_CHANNEL_ID = "flock-ring-v1";
  // Long, insistent — mirrors app/src/ring.ts RING_VIBRATION. Leading 0 = no delay.
  private static final long[] RING_PATTERN = { 0, 600, 200, 600, 200, 600, 200, 600 };

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
    b.setContentIntent(launchIntent(id));

    try {
      NotificationManagerCompat.from(getContext()).notify(id, b.build());
    } catch (SecurityException e) {
      // POST_NOTIFICATIONS not granted — nothing to show.
    }
    call.resolve();
  }

  // "Make it ring": an alarm-class notification that sounds even on silent/DND
  // (alarm audio stream), wakes the screen (full-screen intent) and vibrates
  // hard — so a phone flagged lost is findable by ear.
  @PluginMethod
  public void ring(PluginCall call) {
    String title = call.getString("title", "flock");
    String body = call.getString("body", "");
    String group = call.getString("group", null);
    int id = call.getInt("id", seq.getAndIncrement());

    ensureRingChannel();

    NotificationCompat.Builder b = new NotificationCompat.Builder(getContext(), RING_CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
      .setSmallIcon(getContext().getApplicationInfo().icon)
      .setAutoCancel(true)
      .setOngoing(true) // insistent — stays until dismissed/opened, like an alarm
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setCategory(NotificationCompat.CATEGORY_ALARM)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC);

    // Pre-Android-8 there are no channels, so the alarm sound + vibration must be
    // set on the notification itself.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      b.setSound(alarmUri(), AudioManagerStreamAlarm());
      b.setVibrate(RING_PATTERN);
    }

    if (group != null) b.setGroup(group);
    PendingIntent pi = launchIntent(id);
    if (pi != null) {
      b.setContentIntent(pi);
      // Wake the screen for an alarm-class notification. On Android 14+ this needs
      // USE_FULL_SCREEN_INTENT to be granted; if it isn't, it degrades to a
      // heads-up notification (still loud on the alarm stream).
      b.setFullScreenIntent(pi, true);
    }

    try {
      NotificationManagerCompat.from(getContext()).notify(id, b.build());
    } catch (SecurityException e) {
      // POST_NOTIFICATIONS not granted — nothing to show.
    }
    call.resolve();
  }

  // Created lazily and natively (immutable once made) so it keeps the alarm audio
  // attributes — never via LocalNotifications, which would fix it to a plain
  // notification stream first.
  private void ensureRingChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
    if (nm == null || nm.getNotificationChannel(RING_CHANNEL_ID) != null) return;

    NotificationChannel ch = new NotificationChannel(
      RING_CHANNEL_ID, "Ring a lost phone", NotificationManager.IMPORTANCE_HIGH);
    ch.setDescription("A loud alarm when your circle rings this phone to find it — plays even on silent.");
    ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
    ch.enableVibration(true);
    ch.setVibrationPattern(RING_PATTERN);
    ch.enableLights(true);
    ch.setLightColor(0xFFFF6B6B);
    AudioAttributes attrs = new AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_ALARM)
      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
      .build();
    ch.setSound(alarmUri(), attrs);
    // Best-effort: only takes effect if flock has been granted notification-policy
    // access; harmless otherwise (the alarm stream already sounds through silent).
    ch.setBypassDnd(true);
    nm.createNotificationChannel(ch);
  }

  private Uri alarmUri() {
    Uri u = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
    if (u == null) u = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
    return u;
  }

  private int AudioManagerStreamAlarm() {
    return android.media.AudioManager.STREAM_ALARM;
  }

  // Tapping opens flock (the launcher activity), like every other notification.
  private PendingIntent launchIntent(int id) {
    Intent launch = getContext().getPackageManager().getLaunchIntentForPackage(getContext().getPackageName());
    if (launch == null) return null;
    launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
    return PendingIntent.getActivity(
      getContext(), id, launch,
      PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }
}
