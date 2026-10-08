package com.aura.app;

import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Set;

/**
 * Programs OS alarms for medicine doses and shows the reminder notification
 * with Taken / Snooze buttons. Everything here runs without the WebView, so
 * reminders and button taps keep working when the app is closed. Taps are
 * either delivered live to AuraMedicinePlugin (app open) or queued in
 * SharedPreferences until the app next drains them.
 */
final class MedicineScheduler {

    static final String CHANNEL_ID = "aura_medicine_doses";
    static final String ACTION_ALARM = "com.aura.app.DOSE_ALARM";
    static final String ACTION_TAKEN = "com.aura.app.DOSE_TAKEN";
    static final String ACTION_SNOOZE = "com.aura.app.DOSE_SNOOZE";
    private static final String PREFS = "aura_medicine";
    private static final long SNOOZE_MS = 10 * 60 * 1000L;

    /** Set by the plugin while the app is in the foreground. */
    interface LiveListener { void onAction(String id, String action, long at); }
    static volatile LiveListener liveListener;

    private MedicineScheduler() {}

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Replaces all scheduled reminders; reminders no longer in the set are cancelled, including any notification still showing. */
    static synchronized void schedule(Context c, JSONArray doses) {
        JSONArray old = readArray(prefs(c).getString("doses", "[]"));
        Set<String> keep = new HashSet<>();
        for (int i = 0; i < doses.length(); i++) keep.add(doses.optJSONObject(i).optString("id"));
        for (int i = 0; i < old.length(); i++) {
            String id = old.optJSONObject(i).optString("id");
            cancelAlarm(c, id);
            if (!keep.contains(id)) NotificationManagerCompat.from(c).cancel(id.hashCode());
        }
        prefs(c).edit().putString("doses", doses.toString()).apply();
        long now = System.currentTimeMillis();
        for (int i = 0; i < doses.length(); i++) {
            JSONObject d = doses.optJSONObject(i);
            if (d.optLong("at") > now) setAlarm(c, d, d.optLong("at"));
        }
    }

    static void rescheduleStored(Context c) {
        schedule(c, readArray(prefs(c).getString("doses", "[]")));
    }

    private static PendingIntent alarmIntent(Context c, String id, JSONObject dose) {
        Intent i = new Intent(c, DoseAlarmReceiver.class).setAction(ACTION_ALARM).setData(Uri.parse("aura-dose://" + Uri.encode(id)));
        if (dose != null) {
            i.putExtra("id", id).putExtra("title", dose.optString("title")).putExtra("body", dose.optString("body"));
        }
        int flags = PendingIntent.FLAG_IMMUTABLE | (dose != null ? PendingIntent.FLAG_UPDATE_CURRENT : PendingIntent.FLAG_NO_CREATE);
        return PendingIntent.getBroadcast(c, id.hashCode(), i, flags);
    }

    private static void setAlarm(Context c, JSONObject dose, long at) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        PendingIntent pi = alarmIntent(c, dose.optString("id"), dose);
        boolean exact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms();
        if (exact) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi); // inexact: may drift a few minutes
    }

    private static void cancelAlarm(Context c, String id) {
        PendingIntent pi = alarmIntent(c, id, null);
        if (pi != null) {
            ((AlarmManager) c.getSystemService(Context.ALARM_SERVICE)).cancel(pi);
            pi.cancel();
        }
    }

    static void showNotification(Context c, String id, String title, String body) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "Medicine reminders", NotificationManager.IMPORTANCE_HIGH));
        }
        Intent open = new Intent(c, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPi = PendingIntent.getActivity(c, id.hashCode(), open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_popup_reminder)
                .setContentTitle(title)
                .setContentText(body)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setAutoCancel(true)
                .setContentIntent(openPi)
                .addAction(0, "Taken", actionIntent(c, id, ACTION_TAKEN))
                .addAction(0, "Snooze 10 min", actionIntent(c, id, ACTION_SNOOZE));
        if (NotificationManagerCompat.from(c).areNotificationsEnabled()) nm.notify(id.hashCode(), b.build());
    }

    private static PendingIntent actionIntent(Context c, String id, String action) {
        Intent i = new Intent(c, DoseActionReceiver.class).setAction(action)
                .setData(Uri.parse("aura-dose-action://" + action + "/" + Uri.encode(id)))
                .putExtra("id", id);
        return PendingIntent.getBroadcast(c, (action + id).hashCode(), i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    static void handleAction(Context c, String id, String action) {
        NotificationManagerCompat.from(c).cancel(id.hashCode());
        long now = System.currentTimeMillis();
        if ("snooze".equals(action)) {
            // Reuse the stored title/body so the re-fired notification reads the same.
            JSONObject found = new JSONObject();
            try { found.put("id", id).put("title", "Medicine reminder").put("body", ""); } catch (JSONException ignored) { }
            JSONArray doses = readArray(prefs(c).getString("doses", "[]"));
            for (int i = 0; i < doses.length(); i++) if (id.equals(doses.optJSONObject(i).optString("id"))) found = doses.optJSONObject(i);
            setAlarm(c, found, now + SNOOZE_MS);
            return;
        }
        LiveListener l = liveListener;
        if (l != null) { l.onAction(id, action, now); return; }
        synchronized (MedicineScheduler.class) {
            JSONArray q = readArray(prefs(c).getString("actions", "[]"));
            try { q.put(new JSONObject().put("id", id).put("action", action).put("at", now)); } catch (JSONException ignored) { }
            prefs(c).edit().putString("actions", q.toString()).apply();
        }
    }

    static synchronized JSONArray drainActions(Context c) {
        JSONArray q = readArray(prefs(c).getString("actions", "[]"));
        prefs(c).edit().putString("actions", "[]").apply();
        return q;
    }

    private static JSONArray readArray(String s) {
        try { return new JSONArray(s); } catch (JSONException e) { return new JSONArray(); }
    }
}
