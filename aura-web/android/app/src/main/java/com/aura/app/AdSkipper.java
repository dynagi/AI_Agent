package com.aura.app;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.accessibility.AccessibilityEvent;

/**
 * Skips YouTube ads on its own: whenever an ad is showing in the YouTube app and its "Skip ad" button appears, the
 * button is pressed (through YouTubeAdapter, which finds it by meaning and checks that the press worked). Nothing
 * else is touched: it only looks at YouTube, only for an ad's own markers, and it never presses "Skip" on a
 * non-ad screen. Ads that can't be skipped yet are re-checked every second until the button appears.
 *
 * On by default because the user asked for it; AURA's settings can switch it off (setEnabled).
 */
final class AdSkipper {

    private static final String TAG = "AuraAdSkipper";
    private static final String PREFS = "aura_assistant";
    private static final String KEY = "auto_skip_ads";
    private static final long MIN_GAP_MS = 450;     // YouTube fires content events constantly during playback
    private static final long RECHECK_MS = 1000;
    private static final int MAX_RECHECKS = 15;     // longest unskippable ad is ~15 s; give up after that

    private static volatile Boolean enabledCache;
    private static final Handler ui = new Handler(Looper.getMainLooper());

    private final Context ctx;
    private long lastCheck;
    private boolean busy;
    private boolean recheckQueued;
    private int rechecks;

    AdSkipper(Context ctx) {
        this.ctx = ctx.getApplicationContext();
    }

    static boolean enabled(Context ctx) {
        Boolean e = enabledCache;
        if (e == null) {
            e = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY, true);
            enabledCache = e;
        }
        return e;
    }

    static void setEnabled(Context ctx, boolean on) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY, on).apply();
        enabledCache = on;
    }

    /** Called for every accessibility event (main thread); does nothing unless it is YouTube changing. */
    void onEvent(AccessibilityEvent e) {
        if (e == null || e.getPackageName() == null || !YouTubeAdapter.PKG.contentEquals(e.getPackageName())) return;
        int type = e.getEventType();
        if (type != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED && type != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return;
        if (!enabled(ctx) || busy) return;
        long now = SystemClock.uptimeMillis();
        if (now - lastCheck < MIN_GAP_MS) return;
        lastCheck = now;
        check();
    }

    private void check() {
        if (busy || !YouTubeAdapter.onScreen()) return;
        boolean ad = YouTubeAdapter.adShowing();
        if (!ad) {
            rechecks = 0;
            return;
        }
        if (YouTubeAdapter.skipCandidates().isEmpty()) {
            recheckSoon();   // an ad without a Skip button yet: it appears after a few seconds
            return;
        }
        busy = true;
        YouTubeAdapter.skip((skipped, why) -> {
            busy = false;
            Log.i(TAG, "skip: " + why);
            if (skipped) rechecks = 0;
            else if ("not_skippable_yet".equals(why) || "button_stayed".equals(why)) recheckSoon();
        });
    }

    private void recheckSoon() {
        if (recheckQueued || rechecks >= MAX_RECHECKS) return;
        recheckQueued = true;
        rechecks++;
        ui.postDelayed(() -> {
            recheckQueued = false;
            if (enabled(ctx)) check();
        }, RECHECK_MS);
    }
}
