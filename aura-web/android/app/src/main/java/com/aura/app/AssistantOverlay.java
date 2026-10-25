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
 * The assistant's surface when it is called by voice: a glowing orb that appears in the middle of the screen, on top
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
    private FrameLayout orb;
    private OrbView orbView;

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

        // a glowing orb in the middle of the screen, the answer in a card just below it
        FrameLayout frame = new FrameLayout(ctx);
        frame.setPadding(dp(16), dp(16), dp(16), dp(16));

        panel = new LinearLayout(ctx);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER_HORIZONTAL);

        orb = new FrameLayout(ctx);
        orbView = new OrbView(ctx);
        orb.addView(orbView, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));

        TextView close = new TextView(ctx);
        close.setText("✕");
        close.setTextColor(Color.parseColor("#B3FFFFFF"));
        close.setTextSize(15);
        close.setPadding(dp(12), dp(12), dp(12), dp(12));
        close.setOnClickListener(v -> onClose.run());
        orb.addView(close, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.END));
        panel.addView(orb, new LinearLayout.LayoutParams(dp(250), dp(250)));

        // the voice level drives the orb itself; the old bars are kept (unused) so the rest of the code is unchanged
        bars = new LinearLayout(ctx);

        status = new TextView(ctx);
        status.setTextColor(Color.parseColor("#E6FFFFFF"));
        status.setTextSize(14);
        status.setGravity(Gravity.CENTER);
        status.setPadding(dp(14), dp(6), dp(14), dp(6));
        GradientDrawable pill = new GradientDrawable();
        pill.setColor(Color.parseColor("#E60B0F1A"));
        pill.setCornerRadius(dp(16));
        status.setBackground(pill);
        panel.addView(status, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        body = new TextView(ctx);
        body.setTextColor(Color.WHITE);
        body.setTextSize(16);
        body.setGravity(Gravity.CENTER_HORIZONTAL);
        body.setMaxLines(11);
        body.setEllipsize(TextUtils.TruncateAt.END);
        body.setLineSpacing(dp(3), 1f);
        body.setPadding(dp(18), dp(14), dp(18), dp(14));
        GradientDrawable card = new GradientDrawable();
        card.setColor(Color.parseColor("#F20B0F1A"));
        card.setCornerRadius(dp(22));
        card.setStroke(dp(1), Color.parseColor("#3300D1FF"));
        body.setBackground(card);
        body.setVisibility(View.GONE);
        LinearLayout.LayoutParams bodyLp = new LinearLayout.LayoutParams(dp(320), LinearLayout.LayoutParams.WRAP_CONTENT);
        bodyLp.topMargin = dp(10);
        panel.addView(body, bodyLp);

        frame.addView(panel, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER));

        int type = "accessibility".equals(surface) ? WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY
                : Build.VERSION.SDK_INT >= 26 ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;
        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT, type,
                // the app underneath keeps the focus and every touch outside the panel
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.CENTER;
        try {
            wm.addView(frame, lp);
        } catch (RuntimeException e) {
            return false;
        }
        root = frame;
        panel.setScaleX(0.6f);
        panel.setScaleY(0.6f);
        panel.setAlpha(0f);
        panel.animate().scaleX(1f).scaleY(1f).alpha(1f).setDuration(260).setInterpolator(new DecelerateInterpolator()).start();
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
        if (root == null) return;
        if (orbView != null) orbView.setLevel(level);
        if (bars.getVisibility() != View.VISIBLE) return;
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
        panel.animate().scaleX(0.6f).scaleY(0.6f).alpha(0f).setDuration(200).withEndAction(() -> {
            try {
                manager.removeView(gone);
            } catch (RuntimeException ignored) {
                // already detached (the accessibility service was turned off meanwhile)
            }
        }).start();
    }
}
