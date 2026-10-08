package com.aura.app;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

/**
 * Learns how the user uses their phone, from the accessibility service's view of what they do: which apps and when,
 * which kinds of action (like, share, send...), who they chat and call most in WhatsApp, and which topics they like
 * on Instagram, YouTube and the like. It is off until the user turns it on in AURA, and then:
 *
 *  - records counters only (see ActivityProfile): never message text, typed text, passwords or notifications. It
 *    does not even listen for typing; a tap is stored only when its label is one of a fixed list of verbs;
 *  - skips banking, payment, password-manager and system-security apps entirely (ScreenPolicy);
 *  - keeps everything in a file on the phone. Nothing is uploaded; only a short, name-free summary of habits goes
 *    to the assistant as context when the user talks to it;
 *  - can be switched off, or wiped, at any time.
 */
final class ActivityLearner {

    private static final String TAG = "AuraLearner";
    private static final String PREFS = "aura_learning";
    private static final String KEY_ENABLED = "enabled";
    private static final String FILE = "aura_learning.json";
    private static final long SAVE_AFTER_MS = 20_000;

    private static final Pattern WHATSAPP = Pattern.compile("^com\\.whatsapp(\\.w4b)?$");
    private static final Pattern SOCIAL = Pattern.compile(
            "^(com\\.instagram\\.android|com\\.google\\.android\\.youtube|com\\.facebook\\.katana|com\\.twitter\\.android|"
                    + "com\\.reddit\\.frontpage|com\\.pinterest|com\\.linkedin\\.android|com\\.zhiliaoapp\\.musically|in\\.mohalla\\.sharechat)$");
    // a chat-list row shows the name, a preview and a time: the time is how a row is told from other taps
    private static final Pattern TIME_ON_ROW = Pattern.compile("(?i)\\b(?:\\d{1,2}:\\d{2}|yesterday|today|mon|tue|wed|thu|fri|sat|sun)\\b");

    private static volatile Boolean enabledCache;
    private static final Object lock = new Object();
    private static ActivityProfile profile;
    private static final ExecutorService io = Executors.newSingleThreadExecutor();
    private static final Handler ui = new Handler(Looper.getMainLooper());

    private final Context ctx;
    private String sessionPkg;
    private long sessionStart;
    private long lastEventAt;
    private String chatWith;   // whose WhatsApp chat is open, for counting what is sent
    private final Runnable save;

    ActivityLearner(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        this.save = () -> flush(this.ctx);
    }

    // ------------------------------------------------------------------ the switch

    static boolean enabled(Context ctx) {
        Boolean e = enabledCache;
        if (e == null) {
            e = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_ENABLED, false);
            enabledCache = e;
        }
        return e;
    }

    static void setEnabled(Context ctx, boolean on) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_ENABLED, on).apply();
        enabledCache = on;
    }

    /** Wipes everything learned, in memory and on disk. */
    static void forget(Context ctx) {
        synchronized (lock) {
            profile = null;
        }
        io.execute(() -> new File(ctx.getFilesDir(), FILE).delete());
    }

    // ------------------------------------------------------------------ events (main thread)

    void onEvent(AccessibilityEvent e) {
        if (!enabled(ctx) || e == null || e.getPackageName() == null) return;
        String pkg = e.getPackageName().toString();
        long now = System.currentTimeMillis();
        if (ScreenPolicy.blocked(pkg)) {
            // a banking / settings screen: stop counting and say nothing about it
            endSession(now);
            return;
        }
        if (ScreenPolicy.noise(pkg) || pkg.equals(ctx.getPackageName())) return;

        switch (e.getEventType()) {
            case AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED:
                if (!pkg.equals(sessionPkg)) {
                    endSession(now);
                    sessionPkg = pkg;
                    sessionStart = now;
                    chatWith = null;
                }
                lastEventAt = now;
                break;
            case AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED:
                if (pkg.equals(sessionPkg)) lastEventAt = now;
                break;
            case AccessibilityEvent.TYPE_VIEW_CLICKED:
                if (pkg.equals(sessionPkg)) lastEventAt = now;
                onClick(pkg, e, now);
                break;
            default:
                break;
        }
    }

    /** The app moved to the background / changed: the time on it ends at the last thing the user did there. */
    void endSession(long now) {
        if (sessionPkg == null) return;
        long used = Math.max(0, lastEventAt - sessionStart);
        String pkg = sessionPkg;
        long start = sessionStart;
        sessionPkg = null;
        chatWith = null;
        update(p -> p.appSession(pkg, start, used));
    }

    private void onClick(String pkg, AccessibilityEvent e, long now) {
        AccessibilityNodeInfo src = e.getSource();
        if (src == null) return;
        try {
            if (src.isPassword()) return;
            String label = labelOf(src, e);
            String verb = ActivityProfile.verbOf(label);

            if (verb != null) {
                final String v = verb;
                update(p -> p.action(pkg, v));
                if (WHATSAPP.matcher(pkg).matches() && chatWith != null) {
                    final String who = chatWith;
                    if ("send".equals(verb)) update(p -> p.contact(who, ActivityProfile.ContactEvent.MESSAGE, now));
                    else if ("call".equals(verb) || "video_call".equals(verb)) update(p -> p.contact(who, ActivityProfile.ContactEvent.CALL, now));
                }
                if (ActivityProfile.showsInterest(verb) && SOCIAL.matcher(pkg).matches()) {
                    List<String> topics = ActivityProfile.topics(cardText(src), 8);
                    if (!topics.isEmpty()) update(p -> p.interests(topics, ActivityProfile.interestWeight(v)));
                }
                return;
            }
            if (WHATSAPP.matcher(pkg).matches()) {
                String name = chatRowName(src);
                if (name != null) {
                    chatWith = name;
                    update(p -> p.contact(name, ActivityProfile.ContactEvent.OPEN, now));
                }
            }
        } finally {
            src.recycle();
        }
    }

    private static String labelOf(AccessibilityNodeInfo n, AccessibilityEvent e) {
        if (n.getText() != null && n.getText().length() > 0) return n.getText().toString();
        if (n.getContentDescription() != null && n.getContentDescription().length() > 0) return n.getContentDescription().toString();
        return e.getContentDescription() != null ? e.getContentDescription().toString() : "";
    }

    /**
     * The contact name when the tapped node is a row of WhatsApp's chat list (name, last message, time). Only the
     * name is taken; the preview is never read into anything stored. Best effort: WhatsApp changes its layout.
     */
    private static String chatRowName(AccessibilityNodeInfo row) {
        List<String> texts = new ArrayList<>();
        collect(row, texts, 0);
        if (texts.size() < 2) return null;
        boolean hasTime = false;
        for (String t : texts) hasTime = hasTime || TIME_ON_ROW.matcher(t).find();
        if (!hasTime) return null;
        String name = texts.get(0).trim();
        return name.isEmpty() || name.length() > 40 || TIME_ON_ROW.matcher(name).matches() ? null : name;
    }

    /** Text of the post / video card around a tapped Like or Save: the caption, hashtags, account. */
    private static String cardText(AccessibilityNodeInfo n) {
        AccessibilityNodeInfo p = n.getParent();
        for (int up = 0; p != null && up < 7; up++, p = p.getParent()) {
            List<String> texts = new ArrayList<>();
            collect(p, texts, 0);
            StringBuilder all = new StringBuilder();
            for (String t : texts) all.append(all.length() == 0 ? "" : " ").append(t);
            if (all.length() > 60) return all.length() > 400 ? all.substring(0, 400) : all.toString();
        }
        return "";
    }

    private static void collect(AccessibilityNodeInfo n, List<String> out, int depth) {
        if (n == null || depth > 8 || out.size() > 25) return;
        if (n.isPassword()) return;
        CharSequence t = n.getText() != null && n.getText().length() > 0 ? n.getText() : n.getContentDescription();
        if (t != null && t.toString().trim().length() > 0) out.add(t.toString().trim());
        for (int i = 0; i < n.getChildCount(); i++) collect(n.getChild(i), out, depth + 1);
    }

    // ------------------------------------------------------------------ the stored profile

    private interface Change { void apply(ActivityProfile p); }

    private void update(Change c) {
        synchronized (lock) {
            ActivityProfile p = load(ctx);
            c.apply(p);
        }
        ui.removeCallbacks(save);
        ui.postDelayed(save, SAVE_AFTER_MS);
    }

    private static ActivityProfile load(Context ctx) {
        // called with `lock` held
        if (profile != null) return profile;
        long now = System.currentTimeMillis();
        File f = new File(ctx.getFilesDir(), FILE);
        if (f.exists()) {
            try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
                byte[] bytes = new byte[(int) f.length()];
                int off = 0;
                while (off < bytes.length) {
                    int r = in.read(bytes, off, bytes.length - off);
                    if (r < 0) break;
                    off += r;
                }
                profile = ActivityProfile.fromJson(new JSONObject(new String(bytes, 0, off, StandardCharsets.UTF_8)), now);
                return profile;
            } catch (IOException | JSONException ex) {
                Log.w(TAG, "could not read the saved profile, starting again");
            }
        }
        profile = new ActivityProfile(now);
        return profile;
    }

    /** Writes the profile to the phone's private storage (off the main thread). */
    static void flush(Context ctx) {
        final String json;
        synchronized (lock) {
            if (profile == null) return;
            profile.decay(System.currentTimeMillis());
            try {
                json = profile.toJson().toString();
            } catch (JSONException e) {
                return;
            }
        }
        io.execute(() -> {
            File tmp = new File(ctx.getFilesDir(), FILE + ".tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(json.getBytes(StandardCharsets.UTF_8));
                out.getFD().sync();
                if (!tmp.renameTo(new File(ctx.getFilesDir(), FILE))) Log.w(TAG, "could not save the profile");
            } catch (IOException e) {
                Log.w(TAG, "could not save the profile: " + e.getMessage());
            }
        });
    }

    // ------------------------------------------------------------------ what the app shows and the assistant is told

    static JSONObject summary(Context ctx, int n) {
        synchronized (lock) {
            try {
                JSONObject s = load(ctx).summary(n);
                // app names for the UI, so it need not know package names
                PackageManager pm = ctx.getPackageManager();
                org.json.JSONArray apps = s.getJSONArray("apps");
                for (int i = 0; i < apps.length(); i++) {
                    JSONObject a = apps.getJSONObject(i);
                    a.put("label", appLabel(pm, a.getString("pkg")));
                }
                org.json.JSONArray acts = s.getJSONArray("actions");
                for (int i = 0; i < acts.length(); i++) {
                    JSONObject a = acts.getJSONObject(i);
                    a.put("label", appLabel(pm, a.getString("pkg")));
                }
                return s;
            } catch (JSONException e) {
                return new JSONObject();
            }
        }
    }

    /** A short, name-free sentence about the user's habits for the assistant's context ("" when learning is off). */
    static String habits(Context ctx) {
        if (!enabled(ctx)) return "";
        synchronized (lock) {
            ActivityProfile p = load(ctx);
            PackageManager pm = ctx.getPackageManager();
            Map<String, String> labels = new HashMap<>();
            for (String pkg : p.apps.keySet()) labels.put(pkg, appLabel(pm, pkg));
            return p.habits(labels, 5);
        }
    }

    private static String appLabel(PackageManager pm, String pkg) {
        try {
            ApplicationInfo info = pm.getApplicationInfo(pkg, 0);
            return String.valueOf(pm.getApplicationLabel(info));
        } catch (PackageManager.NameNotFoundException e) {
            return pkg;
        }
    }
}
