package com.aura.app;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.BlurMaskFilter;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RadialGradient;
import android.graphics.Shader;
import android.graphics.SweepGradient;
import android.graphics.Typeface;
import android.view.View;
import android.view.animation.LinearInterpolator;

/**
 * AURA's voice orb: a dark glass sphere with swirling blue, cyan and violet light, a soft glow that brightens with
 * the voice, and the name "AURA" in the middle. Drawn in code, no image assets.
 */
final class OrbView extends View {

    private final Paint glow = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint body = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint swirl = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint rim = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint name = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final ValueAnimator spin = ValueAnimator.ofFloat(0f, 360f);
    private float angle;
    private float level;          // 0..1, the microphone level (smoothed)
    private float target;

    private static final int[] SWIRL = {
            Color.TRANSPARENT, Color.parseColor("#3D8BFF"), Color.parseColor("#00E5FF"),
            Color.parseColor("#B26BFF"), Color.TRANSPARENT, Color.TRANSPARENT};

    OrbView(Context ctx) {
        super(ctx);
        setLayerType(LAYER_TYPE_SOFTWARE, null);   // blur needs a software layer
        swirl.setStyle(Paint.Style.STROKE);
        swirl.setStrokeCap(Paint.Cap.ROUND);
        rim.setStyle(Paint.Style.STROKE);
        name.setColor(Color.WHITE);
        name.setTextAlign(Paint.Align.CENTER);
        name.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
        name.setLetterSpacing(0.25f);
        spin.setDuration(9000);
        spin.setRepeatCount(ValueAnimator.INFINITE);
        spin.setInterpolator(new LinearInterpolator());
        spin.addUpdateListener(a -> {
            angle = (float) a.getAnimatedValue();
            level += (target - level) * 0.25f;
            invalidate();
        });
    }

    /** Microphone level 0..1: the glow and swirl react to the voice. */
    void setLevel(float l) {
        target = Math.max(0f, Math.min(1f, l));
    }

    @Override
    protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        spin.start();
    }

    @Override
    protected void onDetachedFromWindow() {
        spin.cancel();
        super.onDetachedFromWindow();
    }

    @Override
    protected void onDraw(Canvas c) {
        float w = getWidth(), h = getHeight();
        float cx = w / 2f, cy = h / 2f;
        float r = Math.min(w, h) * 0.34f;

        // soft outer glow, brighter while speaking
        float gr = r * (1.45f + level * 0.15f);
        glow.setShader(new RadialGradient(cx, cy, gr,
                new int[]{Color.argb((int) (120 + 90 * level), 0, 150, 255), Color.argb(40, 90, 60, 255), Color.TRANSPARENT},
                new float[]{0.55f, 0.8f, 1f}, Shader.TileMode.CLAMP));
        c.drawCircle(cx, cy, gr, glow);

        // the dark glass sphere
        body.setShader(new RadialGradient(cx - r * 0.25f, cy - r * 0.3f, r * 1.3f,
                new int[]{Color.parseColor("#16234A"), Color.parseColor("#070B1C"), Color.parseColor("#0B1E4D")},
                new float[]{0f, 0.65f, 1f}, Shader.TileMode.CLAMP));
        c.drawCircle(cx, cy, r, body);

        // swirling light: tilted rings turning at different speeds, blurred so they glow
        swirl.setShader(new SweepGradient(cx, cy, SWIRL, null));
        float[][] rings = {{0.92f, 0.55f, 1f, 0f}, {0.78f, 0.85f, -1.6f, 60f}, {0.62f, 0.4f, 2.3f, 140f}};
        for (float[] ring : rings) {
            swirl.setStrokeWidth(r * (0.09f + level * 0.05f));
            swirl.setMaskFilter(new BlurMaskFilter(r * 0.06f, BlurMaskFilter.Blur.NORMAL));
            c.save();
            c.rotate(angle * ring[2] + ring[3], cx, cy);
            c.scale(1f, ring[1], cx, cy);
            c.drawCircle(cx, cy, r * ring[0], swirl);
            c.restore();
        }

        // bright rim
        rim.setStrokeWidth(r * 0.05f);
        rim.setShader(new SweepGradient(cx, cy, new int[]{Color.parseColor("#00E5FF"), Color.parseColor("#3D5BFF"),
                Color.parseColor("#B26BFF"), Color.parseColor("#00E5FF")}, null));
        rim.setMaskFilter(new BlurMaskFilter(r * 0.04f, BlurMaskFilter.Blur.SOLID));
        c.save();
        c.rotate(-angle, cx, cy);
        c.drawCircle(cx, cy, r, rim);
        c.restore();

        // the name, always readable on the dark core
        name.setTextSize(r * 0.36f);
        name.setShadowLayer(r * 0.12f, 0, 0, Color.parseColor("#00D1FF"));
        Paint.FontMetrics fm = name.getFontMetrics();
        c.drawText("AURA", cx, cy - (fm.ascent + fm.descent) / 2f, name);
    }
}
