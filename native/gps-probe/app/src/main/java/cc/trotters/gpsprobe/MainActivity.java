// Minimal launcher: request permissions, start/stop the probe, and show a live
// on-screen readout (total fixes, longest gap, bg-location + battery state, log
// tail) so the result is readable without adb — important for the field
// GrapheneOS device.
package cc.trotters.gpsprobe;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {
  private TextView stats;
  private TextView logView;
  private final Handler ui = new Handler(Looper.getMainLooper());
  private final Runnable refresh = new Runnable() {
    @Override public void run() { render(); ui.postDelayed(this, 3000); }
  };

  @Override
  protected void onCreate(Bundle b) {
    super.onCreate(b);
    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    int pad = (int) (16 * getResources().getDisplayMetrics().density);
    root.setPadding(pad, pad, pad, pad);

    Button start = new Button(this);
    start.setText("Start probe");
    start.setOnClickListener(v -> { ensurePermissions(); startProbe(); });

    Button stop = new Button(this);
    stop.setText("Stop probe");
    stop.setOnClickListener(v -> stopProbe());

    Button batt = new Button(this);
    batt.setText("Disable battery optimisation");
    batt.setOnClickListener(v -> requestBattery());

    stats = new TextView(this);
    stats.setTextSize(15);
    stats.setPadding(0, pad, 0, pad);

    TextView path = new TextView(this);
    path.setTextSize(10);
    path.setText("Log: " + new File(getExternalFilesDir(null), ProbeService.LOG_NAME).getAbsolutePath());

    logView = new TextView(this);
    logView.setTextSize(11);
    logView.setTypeface(Typeface.MONOSPACE);
    ScrollView sc = new ScrollView(this);
    sc.addView(logView);

    root.addView(start);
    root.addView(stop);
    root.addView(batt);
    root.addView(stats);
    root.addView(path);
    root.addView(sc);
    setContentView(root);
  }

  @Override protected void onResume() { super.onResume(); ui.post(refresh); }
  @Override protected void onPause() { super.onPause(); ui.removeCallbacks(refresh); }

  private void startProbe() {
    Intent i = new Intent(this, ProbeService.class);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i);
    else startService(i);
  }

  private void stopProbe() {
    stopService(new Intent(this, ProbeService.class));
  }

  private void ensurePermissions() {
    List<String> req = new ArrayList<>();
    if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED)
      req.add(Manifest.permission.ACCESS_FINE_LOCATION);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
        && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
      req.add(Manifest.permission.POST_NOTIFICATIONS);
    if (!req.isEmpty()) requestPermissions(req.toArray(new String[0]), 1);
  }

  @Override
  public void onRequestPermissionsResult(int rc, String[] p, int[] g) {
    super.onRequestPermissionsResult(rc, p, g);
    // Background location must be granted separately (API 29+), after fine location.
    if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        && checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[]{ Manifest.permission.ACCESS_BACKGROUND_LOCATION }, 2);
    }
  }

  private void requestBattery() {
    PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
    if (pm != null && !pm.isIgnoringBatteryOptimizations(getPackageName())) {
      try {
        startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
            Uri.parse("package:" + getPackageName())));
      } catch (Exception e) {
        startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
      }
    }
  }

  private void render() {
    File f = new File(getExternalFilesDir(null), ProbeService.LOG_NAME);
    int fixes = 0;
    long maxGap = 0;
    ArrayDeque<String> tail = new ArrayDeque<>();
    try (BufferedReader r = new BufferedReader(new FileReader(f))) {
      String line;
      while ((line = r.readLine()) != null) {
        tail.addLast(line);
        if (tail.size() > 150) tail.removeFirst();
        if (line.contains("FIX  #")) {
          fixes++;
          int gi = line.indexOf("gap=");
          if (gi >= 0) {
            String gv = line.substring(gi + 4).replace("s", "").trim();
            try { long g = Long.parseLong(gv); if (g > maxGap) maxGap = g; } catch (Exception ignored) {}
          }
        }
      }
    } catch (Exception e) {
      logView.setText("(no log yet — tap Start probe, grant 'Allow all the time' + notifications)");
      stats.setText("");
      return;
    }

    PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
    boolean exempt = pm != null && pm.isIgnoringBatteryOptimizations(getPackageName());
    boolean bg = checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED;

    stats.setText("Total fixes: " + fixes + "     longest gap: " + maxGap + "s\n"
        + "bg-location (Allow all the time): " + (bg ? "YES" : "NO")
        + "     battery-unrestricted: " + (exempt ? "YES" : "NO"));

    StringBuilder sb = new StringBuilder();
    for (String l : tail) sb.append(l).append("\n");
    logView.setText(sb.toString());
  }
}
