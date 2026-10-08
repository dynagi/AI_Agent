package com.aura.app;

import android.content.Context;

/**
 * The one rule for "should AURA ask before doing this?". Low-risk actions (pause, open an app) never ask.
 * Medium-risk ones (a phone or WhatsApp call) ask only if the user turned that on. High-risk ones (sending a
 * message, buying something) always ask.
 */
final class Confirmations {

    enum Risk { LOW, MEDIUM, HIGH }

    private static final String PREFS = "aura_assistant";
    private static final String CONFIRM_CALLS = "confirm_calls";

    private Confirmations() { }

    static boolean required(Context ctx, Risk risk) {
        if (risk == Risk.HIGH) return true;
        if (risk == Risk.LOW) return false;
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(CONFIRM_CALLS, false);
    }

    static void setConfirmCalls(Context ctx, boolean on) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(CONFIRM_CALLS, on).apply();
    }
}
