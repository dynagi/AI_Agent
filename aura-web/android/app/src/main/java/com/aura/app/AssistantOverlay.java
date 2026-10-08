package com.aura.app;

import android.content.Context;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.provider.Settings;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.animation.DecelerateInterpolator;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * The assistant's surface when it is called by voice: a small rounded panel that slides up from the bottom, on top
 * of whatever app is on screen. It is not an activity, so nothing is launched and the current app keeps the focus.
 *
 * It is drawn as an accessibility overlay when AURA's accessibility service is on (no extra permission), or as an
 * application overlay when the user granted "Display over other apps". With neither it can't be shown; the
 * assistant then works by voice only.
 */
final class AssistantOverlay {

    private static final int BARS = 5;

    private final Context service;
    private final Runnable onClose;
    private WindowManager wm;
    private View root;
    private LinearLayout panel;
    private TextView status;
    private TextView body;
    private LinearLayout bars;

    AssistantOverlay(Context service, Runnable onClose) {
        this.service = service;
        this.onClose = onClose;
    }

    /** Which kind of overlay window is possible right now: "accessibility", "overlay" or null. */
    static String surface(Context context) {
        if (AuraAccessibilityService.instance != null) return "accessibility";
        if (Build.VERSION.SDK_INT >= 23 && Settings.canDrawOverlays(context)) return "overlay";
        return null;
    }

    boolean isShowing() {
        return root != null;
    }

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, service.getResources().getDisplayMetrics()));
    }

    /** Slides the panel up. Returns false when no overlay surface is available (voice-only). */
    boolean show(String statusText) {
        if (root != null) {
            setStatus(statusText, true);
            return true;
        }
        String surface = surface(service);
        if (surface == null) return false;
        Context ctx = "accessibility".equals(surface) ? AuraAccessibilityService.instance : service;
        wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);

        FrameLayout frame = new FrameLayout(ctx);
        frame.setPadding(dp(14), 0, dp(14), dp(22));

        panel = new LinearLayout(ctx);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER_HORIZONTAL);
        panel.setPadding(dp(20), dp(16), dp(20), dp(18));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor("#F20B0F1A"));
        bg.setCornerRadius(dp(26));
        bg.setStroke(dp(1), Color.parseColor("#3300D1FF"));
        panel.setBackground(bg);
        panel.setElevation(dp(12));

        LinearLayout header = new LinearLayout(ctx);
        header.setGravity(Gravity.CENTER_VERTICAL);
        TextView name = new TextView(ctx);
        name.setText("✨ Aura");
        name.setTextColor(Color.parseColor("#00D1FF"));
        name.setTextSize(15);
        name.setTypeface(Typeface.DEFAULT_BOLD);
        header.addView(name, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        TextView close = new TextView(ctx);
        close.setText("✕");
        close.setTextColor(Color.parseColor("#99FFFFFF"));
        close.setTextSize(16);
        close.setPadding(dp(12), dp(4), dp(4), dp(4));
        close.setOnClickListener(v -> onClose.run());
        header.addView(close);
        panel.addView(header, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        status = new TextView(ctx);
        status.setTextColor(Color.parseColor("#B3FFFFFF"));
        status.setTextSize(13);
        status.setPadding(0, dp(10), 0, 0);
        panel.addView(status);

        bars = new LinearLayout(ctx);
        bars.setGravity(Gravity.CENTER);
        bars.setPadding(0, dp(10), 0, dp(2));
        for (int i = 0; i < BARS; i++) {
            View bar = new View(ctx);
            GradientDrawable dot = new GradientDrawable();
            dot.setColor(Color.parseColor("#00D1FF"));
            dot.setCornerRadius(dp(4));
            bar.setBackground(dot);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(7), dp(8));
            lp.setMargins(dp(4), 0, dp(4), 0);
            bars.addView(bar, lp);
        }
        panel.addView(bars, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(46)));

        body = new TextView(ctx);
        body.setTextColor(Color.WHITE);
        body.setTextSize(16);
        body.setGravity(Gravity.CENTER_HORIZONTAL);
        body.setMaxLines(7);
        body.setEllipsize(TextUtils.TruncateAt.END);
        body.setLineSpacing(dp(3), 1f);
        body.setVisibility(View.GONE);
        panel.addView(body, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        frame.addView(panel, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT));

        int type = "accessibility".equals(surface) ? WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY
                : Build.VERSION.SDK_INT >= 26 ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;
        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT, type,
                // the app underneath keeps the focus and every touch outside the panel
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.BOTTOM;
        try {
            wm.addView(frame, lp);
        } catch (RuntimeException e) {
            return false;
        }
        root = frame;
        panel.setTranslationY(dp(260));
        panel.setAlpha(0f);
        panel.animate().translationY(0).alpha(1f).setDuration(260).setInterpolator(new DecelerateInterpolator()).start();
        setStatus(statusText, true);
        return true;
    }

    /** "Listening…", "Thinking…" and so on; the bars show while listening. */
    void setStatus(String text, boolean listening) {
        if (root == null) return;
        status.setText(text);
        bars.setVisibility(listening ? View.VISIBLE : View.GONE);
    }

    /** What the user is saying, or AURA's answer. */
    void setBody(String text, boolean dim) {
        if (root == null) return;
        body.setText(text);
        body.setAlpha(dim ? 0.7f : 1f);
        body.setVisibility(text == null || text.isEmpty() ? View.GONE : View.VISIBLE);
    }

    /** Microphone level 0..1: the bars rise with the voice. */
    void setLevel(float level) {
        if (root == null || bars.getVisibility() != View.VISIBLE) return;
        float[] shape = {0.55f, 0.85f, 1f, 0.85f, 0.55f};
        for (int i = 0; i < bars.getChildCount(); i++) {
            View bar = bars.getChildAt(i);
            float target = 1f + level * 4.5f * shape[i];
            bar.animate().scaleY(target).setDuration(90).start();
        }
    }

    void hide() {
        if (root == null) return;
        final View gone = root;
        final WindowManager manager = wm;
        root = null;
        panel.animate().translationY(dp(260)).alpha(0f).setDuration(200).withEndAction(() -> {
            try {
                manager.removeView(gone);
            } catch (RuntimeException ignored) {
                // already detached (the accessibility service was turned off meanwhile)
            }
        }).start();
    }
}
