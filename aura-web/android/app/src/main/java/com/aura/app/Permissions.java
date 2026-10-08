package com.aura.app;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import java.util.HashMap;
import java.util.Map;

/**
 * The one place assistant actions ask for Android runtime permissions. A permission is requested only when the
 * action the user just asked for needs it, with the reason said aloud first; nothing is requested up front.
 * The system dialog is shown by PermissionActivity (a service can't show one itself).
 */
final class Permissions {

    interface Callback { void onResult(boolean granted); }

    private static final long WAIT_MS = 60_000;
    private static final Handler ui = new Handler(Looper.getMainLooper());
    private static final Map<Integer, Callback> waiting = new HashMap<>();
    private static int nextId;

    private Permissions() { }

    static boolean has(Context ctx, String... permissions) {
        if (Build.VERSION.SDK_INT < 23) return true;   // granted at install time
        for (String p : permissions) {
            if (ctx.checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) return false;
        }
        return true;
    }

    /**
     * Runs `then` with true once every permission is held. If some are missing, tells the user why (`why`) through
     * `done.onPermissionPrompt` and shows the system dialog; `then` gets false if the user declines, the dialog
     * can't be shown from the background, or nothing happens for a minute.
     */
    static void ensure(Context ctx, String[] permissions, String why, ActionResult.Done done, Callback then) {
        if (has(ctx, permissions)) { then.onResult(true); return; }
        Context from = AppActions.launcher(ctx);
        if (from == null) { then.onResult(false); return; }
        final int id = ++nextId;
        waiting.put(id, then);
        done.onPermissionPrompt(why);
        try {
            from.startActivity(new Intent(ctx, PermissionActivity.class)
                    .putExtra(PermissionActivity.EXTRA_PERMISSIONS, permissions)
                    .putExtra(PermissionActivity.EXTRA_ID, id)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION));
        } catch (Exception e) {
            deliver(ctx, id, permissions);
            return;
        }
        ui.postDelayed(() -> deliver(ctx, id, permissions), WAIT_MS);
    }

    /** The dialog was answered (or timed out): report whether the permissions are held now. Safe to call twice. */
    static void deliver(Context ctx, int id, String[] permissions) {
        Runnable r = () -> {
            Callback cb = waiting.remove(id);
            if (cb != null) cb.onResult(has(ctx, permissions));
        };
        if (Looper.myLooper() == Looper.getMainLooper()) r.run();
        else ui.post(r);
    }
}
