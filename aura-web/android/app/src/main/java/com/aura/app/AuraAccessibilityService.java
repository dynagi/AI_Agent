package com.aura.app;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

/**
 * App mode of the AURA cart agent: drives the store's installed Android app (Blinkit, Zepto, Swiggy...).
 *
 * The user turns this on once under Settings > Accessibility > AURA. It does nothing until a cart job is
 * started (startJob). Then: open the store app -> wait for the screen to settle -> read the views on screen
 * (text, content descriptions, editable/clickable flags, plus the product-card text around each) -> send
 * them to the AURA backend (POST /shopping/agent/step) -> perform the returned action (tap, type into the
 * search box, scroll, back) -> repeat. A small AURA bar on top of the app shows progress, with Continue
 * (after the user handles login/OTP/address) and Stop.
 *
 * It fills the cart and stops; payment is not automated. The server never picks payment steps, this
 * service refuses to tap anything payment-like, never types into password fields, and stops the job if a
 * payment/UPI app comes to the foreground.
 */
public class AuraAccessibilityService extends AccessibilityService implements CartJobBridge.ProgressListener {

    static volatile AuraAccessibilityService instance;

    private static final Pattern FORBIDDEN = Pattern.compile(
            "(?i)\\b(pay|payment|payments|checkout|check out|place\\s*order|confirm\\s*order|complete\\s*order|"
                    + "buy\\s*now|proceed\\s*to\\s*(pay|buy|checkout)|slide\\s*to\\s*pay|swipe\\s*to\\s*pay|upi|"
                    + "cash\\s*on\\s*delivery|cvv|otp)\\b");
    private static final Set<String> PAYMENT_APPS = new HashSet<>(Arrays.asList(
            "com.phonepe.app", "net.one97.paytm", "com.google.android.apps.nbu.paisa.user", "in.org.npci.upiapp",
            "com.mobikwik_new", "com.freecharge.android", "com.dreamplug.androidapp", "in.amazon.mShop.android.shopping.pay"));
    private static final int MAX_ELEMENTS = 180;
    private static final int MAX_OFF_APP_CHECKS = 6;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private final Map<String, AccessibilityNodeInfo> nodes = new HashMap<>();
    private final Runnable stepRunnable = this::step;

    private static final long SETTLE_MS = 1200;
    private static final long MAX_SETTLE_MS = 3000;
    private long stepAt;        // uptime when the pending step runs (0 = none pending)
    private long firstNudgeAt;  // when the current wait started
    private boolean running;
    private boolean paused;
    private boolean inFlight;
    private int offAppChecks;
    private int networkFailures;
    private String screen = "";

    private View overlay;
    private TextView overlayText;
    private Button continueButton;
    private Button stopButton;
    private Button backButton;

    // ------------------------------------------------------------------ lifecycle
    private ActivityLearner learner;
    private AdSkipper adSkipper;
    private Runnable externalStop;   // the Stop button of a screen task (not a cart job)

    @Override
    protected void onServiceConnected() {
        instance = this;
        learner = new ActivityLearner(this);
        adSkipper = new AdSkipper(this);
    }

    @Override
    public boolean onUnbind(Intent intent) {
        stopJob("AURA's accessibility access was turned off.");
        stopScreenWork();
        instance = null;
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        stopScreenWork();
        instance = null;
        network.shutdownNow();
        imaging.shutdownNow();
        super.onDestroy();
    }

    /** Closes what the user-facing helpers had open: the learner's current session, and any screen task's bar. */
    private void stopScreenWork() {
        if (learner != null) {
            learner.endSession(System.currentTimeMillis());
            ActivityLearner.flush(this);
        }
        if (externalStop != null) {
            Runnable stop = externalStop;
            externalStop = null;
            stop.run();
        }
    }

    @Override
    public void onInterrupt() {
        // nothing to interrupt: we don't produce feedback
    }

    /** Whether the user has turned AURA on under Settings > Accessibility. */
    static boolean isEnabled(Context context) {
        if (instance != null) return true;
        String enabled = Settings.Secure.getString(context.getContentResolver(),
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        String me = new ComponentName(context, AuraAccessibilityService.class).flattenToString();
        return enabled != null && enabled.toLowerCase().contains(me.toLowerCase());
    }

    /** Every window of `pkg` on screen, top first (for the assistant's app adapters). */
    List<AccessibilityNodeInfo> roots(String pkg) {
        try {
            return appRoots(pkg);
        } catch (Exception e) {
            return new java.util.ArrayList<>();
        }
    }

    /** Debug builds only: the assistant's adapters log what they find on screen. */
    static boolean debuggable() {
        AuraAccessibilityService s = instance;
        return s != null && (s.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    /** Presses the phone's own Home or Back button (GLOBAL_ACTION_HOME / GLOBAL_ACTION_BACK). */
    boolean pressSystem(int globalAction) {
        return performGlobalAction(globalAction);
    }

    /** What the user is looking at: the top app's package and window title. Changes when the screen changes. */
    String screenSignature() {
        try {
            android.view.accessibility.AccessibilityWindowInfo top = null;
            for (android.view.accessibility.AccessibilityWindowInfo w : getWindows()) {
                if (w.getType() != android.view.accessibility.AccessibilityWindowInfo.TYPE_APPLICATION) continue;
                if (top == null || w.getLayer() > top.getLayer()) top = w;
            }
            if (top == null) return null;
            AccessibilityNodeInfo root = top.getRoot();
            CharSequence title = android.os.Build.VERSION.SDK_INT >= 24 ? top.getTitle() : null;
            return (root == null ? "?" : root.getPackageName()) + "|" + title + "|" + top.getId();
        } catch (Exception e) {
            return null;
        }
    }

    /** The package of the app the user is looking at (topmost app window), or null if it can't be read. */
    String foregroundPackage() {
        try {
            android.view.accessibility.AccessibilityWindowInfo top = null;
            for (android.view.accessibility.AccessibilityWindowInfo w : getWindows()) {
                if (w.getType() != android.view.accessibility.AccessibilityWindowInfo.TYPE_APPLICATION) continue;
                if (top == null || w.getLayer() > top.getLayer()) top = w;
            }
            AccessibilityNodeInfo root = top != null ? top.getRoot() : getRootInActiveWindow();
            return root != null && root.getPackageName() != null ? root.getPackageName().toString() : null;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Selects the first result on `pkg`'s screen whose text has every word of `query` (a song or video in a list of
     * search results). The item is found by its text and activated through its own click action. Returns the
     * item's title, or null when nothing on screen matches. Ads and anything payment-like are never selected, nor
     * is the search box (it shows exactly `searched`).
     */
    String selectFirstMatch(String pkg, String query, String searched) {
        try {
            String q = query.toLowerCase(java.util.Locale.ROOT).trim();
            for (AccessibilityNodeInfo root : appRoots(pkg)) {
                AccessibilityNodeInfo hit = firstMatch(root, searched.toLowerCase(java.util.Locale.ROOT).trim(), q.split(" "), 0);
                if (hit == null) continue;
                List<String> texts = new java.util.ArrayList<>();
                collectText(hit, texts, 0);
                if (!hit.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return null;
                // the row's name: its first text that has a word asked for (a row can start with a "Playing" badge)
                String title = texts.get(0);
                for (String t : texts) {
                    if (t.toLowerCase(java.util.Locale.ROOT).contains(q.split(" ")[0])) { title = t; break; }
                }
                return title.length() > 60 ? title.substring(0, 60).trim() : title;
            }
        } catch (Exception e) {
            // the screen changed while it was being read
        }
        return null;
    }

    private AccessibilityNodeInfo firstMatch(AccessibilityNodeInfo n, String query, String[] words, int depth) {
        if (n == null || depth > 50) return null;
        if (n.isClickable() && n.isVisibleToUser() && !n.isEditable()) {
            List<String> texts = new java.util.ArrayList<>();
            collectText(n, texts, 0);
            String all = String.join(" ", texts).toLowerCase(java.util.Locale.ROOT);
            boolean hasAll = !texts.isEmpty();
            for (String w : words) hasAll = hasAll && all.contains(w);
            // one result row, not a whole list (few texts), not the search box (which shows just the query), not an ad
            if (hasAll && texts.size() <= 12 && !all.trim().equals(query) && !all.trim().equals(String.join(" ", words))
                    && !all.matches(".*\\b(sponsored|ad)\\b.*") && !FORBIDDEN.matcher(all).find()) return n;
        }
        for (int i = 0; i < n.getChildCount(); i++) {
            AccessibilityNodeInfo hit = firstMatch(n.getChild(i), query, words, depth + 1);
            if (hit != null) return hit;
        }
        return null;
    }

    private void collectText(AccessibilityNodeInfo n, List<String> out, int depth) {
        if (n == null || depth > 12 || out.size() > 12) return;
        CharSequence t = n.getText() != null && n.getText().length() > 0 ? n.getText() : n.getContentDescription();
        if (t != null && t.toString().trim().length() > 0) out.add(t.toString().trim());
        for (int i = 0; i < n.getChildCount(); i++) collectText(n.getChild(i), out, depth + 1);
    }

    // ------------------------------------------------------------------ reading other apps for the assistant
    // Used by the assistant's agents (YouTube, WhatsApp). Items are found by their text or label and activated
    // through their own click action; nothing here uses screen coordinates, and nothing read is stored or sent.

    private static final Pattern VIDEO_ROW = Pattern.compile("\\b(?:views?|watching|play video)\\b");
    private static final Pattern NOT_A_VIDEO = Pattern.compile("\\b(?:subscribers?|shorts|playlist|sponsored|ad)\\b");

    /** The titles of the videos listed on `pkg`'s screen, top first (channels, playlists, Shorts and ads left out). */
    List<String> videoResults(String pkg, int max) {
        List<String> titles = new java.util.ArrayList<>();
        try {
            for (AccessibilityNodeInfo root : appRoots(pkg)) videoRows(root, null, titles, 0);
        } catch (Exception e) {
            // the screen changed while it was being read
        }
        return titles.size() > max ? new java.util.ArrayList<>(titles.subList(0, max)) : titles;
    }

    /** Opens the listed video with exactly this title. False when it isn't on screen. */
    boolean selectVideo(String pkg, String title) {
        try {
            for (AccessibilityNodeInfo root : appRoots(pkg)) {
                List<AccessibilityNodeInfo> rows = new java.util.ArrayList<>();
                List<String> titles = new java.util.ArrayList<>();
                videoRows(root, rows, titles, 0);
                int i = titles.indexOf(title);
                if (i >= 0) return rows.get(i).performAction(AccessibilityNodeInfo.ACTION_CLICK);
            }
        } catch (Exception e) {
            // the screen changed while it was being read
        }
        return false;
    }

    private void videoRows(AccessibilityNodeInfo n, List<AccessibilityNodeInfo> rows, List<String> titles, int depth) {
        if (n == null || depth > 50 || titles.size() >= 10) return;
        if (n.isClickable() && n.isVisibleToUser()) {
            List<String> texts = new java.util.ArrayList<>();
            collectText(n, texts, 0);
            String all = String.join(" ", texts).toLowerCase(java.util.Locale.ROOT);
            if (!texts.isEmpty() && texts.size() <= 14 && VIDEO_ROW.matcher(all).find() && !NOT_A_VIDEO.matcher(all).find()) {
                // a row's label reads "Title - 12 minutes - Go to channel - ..."; the title is the part before that
                String title = texts.get(0).split(" - \\d+ (?:hours?|minutes?|seconds?)")[0].split(" - Go to channel")[0].trim();
                if (title.length() > 100) title = title.substring(0, 100).trim();
                if (!title.isEmpty() && !titles.contains(title)) {
                    titles.add(title);
                    if (rows != null) rows.add(n);
                }
                return;
            }
        }
        for (int i = 0; i < n.getChildCount(); i++) videoRows(n.getChild(i), rows, titles, depth + 1);
    }

    /** Whether `pkg`'s screen shows this text anywhere (a chat's header showing the contact's name, say). */
    boolean hasText(String pkg, String text) {
        try {
            String needle = text.toLowerCase(java.util.Locale.ROOT).trim();
            for (AccessibilityNodeInfo root : appRoots(pkg)) if (containsText(root, needle, 0)) return true;
        } catch (Exception e) {
            // the screen changed while it was being read
        }
        return false;
    }

    private boolean containsText(AccessibilityNodeInfo n, String needle, int depth) {
        if (n == null || depth > 50) return false;
        CharSequence t = n.getText() != null && n.getText().length() > 0 ? n.getText() : n.getContentDescription();
        if (t != null && t.toString().toLowerCase(java.util.Locale.ROOT).contains(needle)) return true;
        for (int i = 0; i < n.getChildCount(); i++) if (containsText(n.getChild(i), needle, depth + 1)) return true;
        return false;
    }

    /** What is typed in `pkg`'s text box ("" when it is empty). Null when there is no text box on screen. */
    String inputText(String pkg) {
        try {
            for (AccessibilityNodeInfo root : appRoots(pkg)) {
                AccessibilityNodeInfo box = firstEditable(root, 0);
                if (box == null) continue;
                if (box.isPassword()) return null;
                if (android.os.Build.VERSION.SDK_INT >= 26 && box.isShowingHintText()) return "";
                return box.getText() == null ? "" : box.getText().toString();
            }
        } catch (Exception e) {
            // the screen changed while it was being read
        }
        return null;
    }

    private AccessibilityNodeInfo firstEditable(AccessibilityNodeInfo n, int depth) {
        if (n == null || depth > 50) return null;
        if (n.isEditable() && n.isVisibleToUser()) return n;
        for (int i = 0; i < n.getChildCount(); i++) {
            AccessibilityNodeInfo hit = firstEditable(n.getChild(i), depth + 1);
            if (hit != null) return hit;
        }
        return null;
    }

    /** Presses the button in `pkg` whose own label matches (WhatsApp's "Send", YouTube's "Skip ad"). False if there is none. */
    boolean clickLabelled(String pkg, Pattern label) {
        try {
            for (AccessibilityNodeInfo root : appRoots(pkg)) {
                AccessibilityNodeInfo button = firstLabelled(root, label, 0);
                if (button != null) return button.performAction(AccessibilityNodeInfo.ACTION_CLICK);
            }
        } catch (Exception e) {
            // the screen changed while it was being read
        }
        return false;
    }

    private AccessibilityNodeInfo firstLabelled(AccessibilityNodeInfo n, Pattern label, int depth) {
        if (n == null || depth > 50) return null;
        if (n.isClickable() && n.isVisibleToUser() && n.isEnabled()) {
            CharSequence t = n.getText() != null && n.getText().length() > 0 ? n.getText() : n.getContentDescription();
            if (t != null && label.matcher(t.toString().trim()).find() && !FORBIDDEN.matcher(t).find()) return n;
        }
        for (int i = 0; i < n.getChildCount(); i++) {
            AccessibilityNodeInfo hit = firstLabelled(n.getChild(i), label, depth + 1);
            if (hit != null) return hit;
        }
        return null;
    }

    // ------------------------------------------------------------------ screen assistant
    // Used by ScreenAgent: read what is on the foreground app's screen, act on it by the element's own click action
    // (never by screen position, except as the cart agent's last resort), and take a screenshot when the words on
    // screen are not enough. Nothing here stores or sends anything; ScreenAgent decides what goes to the server.

    /** The interface for the screen agent: {elements, pageText, package}. Null if `pkg` isn't on screen or a cart job runs. */
    JSONObject screenSnapshot(String pkg) {
        if (running || pkg == null) return null;
        try {
            List<AccessibilityNodeInfo> roots = appRoots(pkg);
            if (roots.isEmpty()) return null;
            nodes.clear();
            JSONArray elements = new JSONArray();
            StringBuilder text = new StringBuilder();
            for (int i = 0; i < roots.size(); i++) {
                if (roots.size() > 1) text.append(i == 0 ? "[popup/sheet on top] " : " [screen behind] ");
                collect(roots.get(i), elements, text, 0);
            }
            return new JSONObject().put("elements", elements).put("package", pkg)
                    .put("pageText", text.length() > 3000 ? text.substring(0, 3000) : text.toString());
        } catch (Exception e) {
            return null;   // the screen changed while it was being read
        }
    }

    /** Performs one action from the screen agent on the elements of the latest screenSnapshot. Returns what happened. */
    String performScreen(JSONObject action) {
        return perform(action);
    }

    /** Scrolls the foreground app's main list one page. False if nothing could be scrolled. */
    boolean scrollScreen(boolean down) {
        String pkg = foregroundPackage();
        List<AccessibilityNodeInfo> roots = pkg == null ? new java.util.ArrayList<>() : appRoots(pkg);
        AccessibilityNodeInfo list = roots.isEmpty() ? null : firstScrollable(roots.get(0));
        if (list != null && list.performAction(down ? AccessibilityNodeInfo.ACTION_SCROLL_FORWARD : AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD)) return true;
        return swipe(down);
    }

    interface ScreenshotDone {
        /** base64 JPEG (longest side 1024 px) or null with the reason it could not be taken. */
        void onShot(String base64Jpeg, String error);
    }

    private final ExecutorService imaging = Executors.newSingleThreadExecutor();

    /** Takes a screenshot (Android 11+, needs canTakeScreenshot in the service config) and reports it on the main thread. */
    void captureScreen(ScreenshotDone done) {
        if (Build.VERSION.SDK_INT < 30) {
            done.onShot(null, "needs_android_11");
            return;
        }
        try {
            takeScreenshot(android.view.Display.DEFAULT_DISPLAY, getMainExecutor(), new TakeScreenshotCallback() {
                @Override
                public void onSuccess(ScreenshotResult result) {
                    imaging.execute(() -> encodeShot(result, done));
                }

                @Override
                public void onFailure(int errorCode) {
                    // 2 = no screenshot permission yet (service needs re-enabling), 3 = too soon after the last one, 6 = the app blocks screenshots
                    done.onShot(null, "screenshot_failed_" + errorCode);
                }
            });
        } catch (Exception e) {
            done.onShot(null, "screenshot_unavailable");
        }
    }

    private void encodeShot(ScreenshotResult result, ScreenshotDone done) {
        android.graphics.Bitmap hardware = null, soft = null, scaled = null;
        String b64 = null, error = null;
        try {
            hardware = android.graphics.Bitmap.wrapHardwareBuffer(result.getHardwareBuffer(), result.getColorSpace());
            if (hardware == null) throw new IllegalStateException("no bitmap");
            soft = hardware.copy(android.graphics.Bitmap.Config.ARGB_8888, false);
            float k = Math.min(1f, 1024f / Math.max(soft.getWidth(), soft.getHeight()));
            scaled = k < 1f ? android.graphics.Bitmap.createScaledBitmap(soft, Math.round(soft.getWidth() * k), Math.round(soft.getHeight() * k), true) : soft;
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            scaled.compress(android.graphics.Bitmap.CompressFormat.JPEG, 70, out);
            b64 = android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP);
        } catch (Throwable t) {
            error = "screenshot_unreadable";
        } finally {
            try { result.getHardwareBuffer().close(); } catch (Throwable ignored) { /* already closed */ }
            if (scaled != null && scaled != soft) scaled.recycle();
            if (soft != null) soft.recycle();
            if (hardware != null) hardware.recycle();
        }
        final String shot = b64, why = error;
        ui.post(() -> done.onShot(shot, why));
    }

    /** The AURA bar over the app while a screen task runs; Stop calls onStop. */
    void showScreenBar(String message, Runnable onStop) {
        ui.post(() -> {
            externalStop = onStop;
            showOverlay(message);
        });
    }

    void setScreenBar(String message) {
        ui.post(() -> setStatus(message));
    }

    void hideScreenBar() {
        ui.post(() -> {
            externalStop = null;
            hideOverlay();
        });
    }

    // ------------------------------------------------------------------ job control
    /** Starts the active CartJobBridge job (mode "app") in the store's app. Called from the plugin. */
    void startJob() {
        ui.post(() -> {
            CartJobBridge job = CartJobBridge.getInstance();
            job.setListener(this);
            running = true;
            paused = false;
            inFlight = false;
            offAppChecks = 0;
            networkFailures = 0;
            nodes.clear();
            showOverlay(("history".equals(job.phase) ? "Opening your " + job.store + " orders…" : "Opening " + job.store + "…"));
            Intent launch = getPackageManager().getLaunchIntentForPackage(job.appPackage);
            if (launch == null) {
                job.finish(job.store + " app isn't installed.");
                return;
            }
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
            startActivity(launch);
            scheduleStep(3000);
        });
    }

    private void stopJob(String message) {
        if (!running) return;
        CartJobBridge.getInstance().finish(message);
    }

    private void scheduleStep(long delayMs) {
        ui.removeCallbacks(stepRunnable);
        stepAt = 0;
        if (running && !paused) {
            long now = android.os.SystemClock.uptimeMillis();
            stepAt = now + delayMs;
            firstNudgeAt = now;
            ui.postAtTime(stepRunnable, stepAt);
        }
    }

    /**
     * The screen changed: take the next step once it has settled for SETTLE_MS, but never wait more than
     * MAX_SETTLE_MS in total. Screens that animate non-stop (banners, carousels, a blinking cursor) fire
     * change events many times a second; an unbounded "wait until quiet" never ends on them.
     */
    private void nudgeStep() {
        if (!running || paused) return;
        long now = android.os.SystemClock.uptimeMillis();
        if (stepAt == 0) {
            scheduleStep(SETTLE_MS);
            return;
        }
        long target = Math.min(now + SETTLE_MS, firstNudgeAt + MAX_SETTLE_MS);
        if (target > stepAt) {
            ui.removeCallbacks(stepRunnable);
            stepAt = target;
            ui.postAtTime(stepRunnable, stepAt);
        }
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null || event.getPackageName() == null) return;
        // always-on helpers; each does nothing unless the user turned it on / it is YouTube changing
        if (adSkipper != null) adSkipper.onEvent(event);
        if (learner != null) learner.onEvent(event);
        if (!running) return;
        String pkg = event.getPackageName().toString();
        String target = CartJobBridge.getInstance().appPackage;
        if (event.getEventType() == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            if (PAYMENT_APPS.contains(pkg)) {
                stopJob("A payment app opened, so AURA stopped. Payment is up to you.");
                return;
            }
            if (pkg.equals(target) && event.getClassName() != null) screen = event.getClassName().toString();
        }
        // screen changing in the store app: take the next step once it has settled for a moment
        if (pkg.equals(target) && !inFlight) nudgeStep();
    }

    // ------------------------------------------------------------------ one step: snapshot -> server -> act
    private void step() {
        stepAt = 0;
        if (!running || paused || inFlight) return;
        CartJobBridge job = CartJobBridge.getInstance();
        List<AccessibilityNodeInfo> roots = appRoots(job.appPackage);
        if (roots.isEmpty()) {
            if (++offAppChecks > MAX_OFF_APP_CHECKS) {
                job.needUser("Bring the " + job.store + " app back to the front, then tap Continue.");
            } else {
                scheduleStep(1500);
            }
            return;
        }
        offAppChecks = 0;
        JSONObject snapshot;
        try {
            snapshot = snapshot(roots, job);
        } catch (JSONException e) {
            scheduleStep(1500);
            return;
        }
        inFlight = true;
        network.execute(() -> {
            try {
                JSONObject action = AgentHttp.nextStep(job, job.stepRequest(snapshot));
                networkFailures = 0;
                ui.post(() -> handle(action));
            } catch (Exception e) {
                ui.post(() -> {
                    inFlight = false;
                    if (++networkFailures > 2) {
                        job.needUser("Can't reach AURA (" + e.getMessage() + "). Check the connection, then tap Continue.");
                    } else {
                        scheduleStep(2000);
                    }
                });
            }
        });
    }

    private void handle(JSONObject action) {
        inFlight = false;
        if (!running) return;
        CartJobBridge job = CartJobBridge.getInstance();
        String type = action.optString("action");
        String reason = action.optString("reason", type);
        try {
            job.addOrdersRead(action.optInt("ordersSaved", 0));
            job.addOrdersKnown(action.optInt("ordersKnown", 0));
            switch (type) {
                case "history_done":
                    job.historyDone();
                    setStatus(action.optString("reason", "Read your past orders") + (job.itemCount() > 0 ? " — now adding items…" : ""));
                    scheduleStep(400);
                    return;
                case "set_items": {
                    JSONArray resolvedItems = action.optJSONArray("items");
                    job.setItems(resolvedItems != null ? resolvedItems : new JSONArray());
                    setStatus(action.optString("reason", "Adding items"));
                    scheduleStep(400);
                    return;
                }
                case "item_done":
                    job.markItem(action.optInt("itemIndex", -1), action.optBoolean("itemOk", true), reason);
                    scheduleStep(300);
                    return;
                case "need_user":
                    job.needUser(action.optString("message", "AURA needs you to do something in the app."));
                    return;
                case "done":
                    job.finish(action.optString("message", "Finished."));
                    return;
                default:
                    setStatus(reason);
                    String result = perform(action);
                    JSONObject rec = new JSONObject();
                    rec.put("action", type);
                    // the server verifies additions from this ("add@<product>"), so prefer its targetText
                    rec.put("target", action.optString("targetText", action.optString("elementId", null)));
                    rec.put("result", result);
                    rec.put("url", screen);
                    rec.put("completesItem", action.optBoolean("completesItem"));
                    rec.put("itemIndex", action.optInt("itemIndex", -1));
                    job.record(rec);
                    scheduleStep("wait".equals(type) ? 2000 : 1600);
            }
        } catch (JSONException e) {
            job.finish("Stopped: " + e.getMessage());
        }
    }

    // ------------------------------------------------------------------ reading the screen
    /**
     * Every window of the store app, top layer first. Size pickers, bottom sheets and dialogs are often separate
     * windows on top of the main screen; reading only the active window misses them (and the agent then keeps
     * tapping an ADD that only re-opens the picker).
     */
    private List<AccessibilityNodeInfo> appRoots(String pkg) {
        List<AccessibilityNodeInfo> roots = new java.util.ArrayList<>();
        List<android.view.accessibility.AccessibilityWindowInfo> windows = new java.util.ArrayList<>(getWindows());
        windows.sort((a, b) -> Integer.compare(b.getLayer(), a.getLayer()));
        for (android.view.accessibility.AccessibilityWindowInfo w : windows) {
            AccessibilityNodeInfo r = w.getRoot();
            if (r != null && r.getPackageName() != null && pkg.equals(r.getPackageName().toString())) roots.add(r);
        }
        if (roots.isEmpty()) {
            AccessibilityNodeInfo active = getRootInActiveWindow();
            if (active != null && active.getPackageName() != null && pkg.equals(active.getPackageName().toString())) {
                roots.add(active);
            }
        }
        return roots;
    }

    private JSONObject snapshot(List<AccessibilityNodeInfo> roots, CartJobBridge job) throws JSONException {
        nodes.clear();
        JSONArray elements = new JSONArray();
        StringBuilder text = new StringBuilder();
        for (int i = 0; i < roots.size(); i++) {
            if (roots.size() > 1) text.append(i == 0 ? "[popup/sheet on top] " : " [screen behind] ");
            collect(roots.get(i), elements, text, 0);
        }
        JSONObject snap = new JSONObject();
        snap.put("url", screen);
        snap.put("title", job.store + " app");
        snap.put("elements", elements);
        snap.put("pageText", text.length() > 3000 ? text.substring(0, 3000) : text.toString());
        return snap;
    }

    private void collect(AccessibilityNodeInfo n, JSONArray out, StringBuilder pageText, int depth) throws JSONException {
        if (n == null || depth > 45 || !n.isVisibleToUser()) return;
        String own = label(n);
        if (!own.isEmpty() && pageText.length() < 3000) pageText.append(own).append(" · ");
        boolean actionable = n.isClickable() || n.isEditable() || n.isCheckable() || n.isScrollable()
                || n.isLongClickable();
        if (actionable && out.length() < MAX_ELEMENTS) {
            String shown = own.isEmpty() ? clip(descendantText(n, 0), 100) : clip(own, 100);
            // icon-only buttons (profile, cart, search, back) often have no text or description: describe them
            // by view id and where they sit, so the agent can still find "the person icon at the top right"
            String iconHint = null;
            if (shown.isEmpty() && !n.isEditable() && !n.isScrollable()) {
                Rect r = new Rect();
                n.getBoundsInScreen(r);
                int w = getResources().getDisplayMetrics().widthPixels;
                int h = getResources().getDisplayMetrics().heightPixels;
                boolean small = r.width() < w * 0.35 && r.height() < h * 0.12;
                if (small && !r.isEmpty()) {
                    String v = r.centerY() < h * 0.2 ? "top" : r.centerY() > h * 0.8 ? "bottom" : "middle";
                    String hz = r.centerX() < w * 0.33 ? "left" : r.centerX() > w * 0.67 ? "right" : "centre";
                    String vid = n.getViewIdResourceName() != null ? n.getViewIdResourceName().replaceAll(".*:id/", "") : "";
                    iconHint = "unlabeled icon at " + v + "-" + hz + (vid.isEmpty() ? "" : " (id " + vid + ")");
                }
            }
            if (!shown.isEmpty() || n.isEditable() || n.isScrollable() || iconHint != null) {
                String id = "n" + out.length();
                nodes.put(id, n);
                JSONObject el = new JSONObject();
                el.put("id", id);
                el.put("tag", simpleClass(n));
                el.put("text", shown);
                CharSequence hint = Build.VERSION.SDK_INT >= 26 ? n.getHintText() : null;
                if (iconHint != null) {
                    el.put("label", iconHint);
                } else if (n.getContentDescription() != null && !TextUtils.equals(n.getContentDescription(), n.getText())) {
                    el.put("label", clip(n.getContentDescription().toString(), 80));
                } else if (hint != null) {
                    el.put("label", clip(hint.toString(), 80));
                }
                if (n.getViewIdResourceName() != null) el.put("role", n.getViewIdResourceName().replaceAll(".*:id/", ""));
                el.put("editable", n.isEditable());
                el.put("scrollable", n.isScrollable());
                el.put("disabled", !n.isEnabled());
                if (n.isPassword()) el.put("type", "password");
                if (!n.isEditable()) {
                    String ctx = context(n, shown);
                    if (ctx != null) el.put("context", ctx);
                }
                out.put(el);
            }
        }
        for (int i = 0; i < n.getChildCount(); i++) collect(n.getChild(i), out, pageText, depth + 1);
    }

    private static String label(AccessibilityNodeInfo n) {
        CharSequence t = n.getText();
        if (t != null && t.toString().trim().length() > 0) return t.toString().trim();
        CharSequence d = n.getContentDescription();
        return d != null ? d.toString().trim() : "";
    }

    private static String descendantText(AccessibilityNodeInfo n, int depth) {
        if (n == null || depth > 8) return "";
        StringBuilder sb = new StringBuilder(label(n));
        for (int i = 0; i < n.getChildCount() && sb.length() < 300; i++) {
            String c = descendantText(n.getChild(i), depth + 1);
            if (!c.isEmpty()) sb.append(sb.length() > 0 ? " " : "").append(c);
        }
        return sb.toString().replaceAll("\\s+", " ").trim();
    }

    /** Text of the nearest ancestor that says more than the control itself: the product card around "ADD". */
    private static String context(AccessibilityNodeInfo n, String shown) {
        AccessibilityNodeInfo p = n.getParent();
        for (int d = 0; d < 6 && p != null; d++, p = p.getParent()) {
            String t = descendantText(p, 0);
            if (t.length() > shown.length() + 15) return clip(t, 240);
        }
        return null;
    }

    private static String simpleClass(AccessibilityNodeInfo n) {
        CharSequence c = n.getClassName();
        if (c == null) return "View";
        String s = c.toString();
        return s.substring(s.lastIndexOf('.') + 1);
    }

    private static String clip(String s, int n) {
        s = s.replaceAll("\\s+", " ").trim();
        return s.length() > n ? s.substring(0, n) : s;
    }

    // ------------------------------------------------------------------ acting on the screen
    private String perform(JSONObject a) {
        String type = a.optString("action");
        AccessibilityNodeInfo node = nodes.get(a.optString("elementId", ""));
        switch (type) {
            case "click": {
                if (node == null) return "element gone";
                if (looksForbidden(node)) return "refused (payment/checkout-like)";
                int times = Math.max(1, Math.min(a.optInt("repeat", 1), 20));
                if (!click(node)) return "click failed";
                for (int i = 1; i < times; i++) {
                    final int n = i;
                    ui.postDelayed(() -> click(node), 450L * n);
                }
                return times > 1 ? "clicked " + times + "x" : "clicked";
            }
            case "type": {
                if (node == null) return "element gone";
                if (node.isPassword()) return "refused (password field)";
                node.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
                if (!node.isFocused()) node.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                Bundle args = new Bundle();
                args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, a.optString("text", ""));
                boolean ok = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
                if (ok && a.optBoolean("submit") && Build.VERSION.SDK_INT >= 30) {
                    node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId());
                    return "typed + enter";
                }
                return ok ? "typed" : "type failed";
            }
            case "scroll": {
                String pkg = running ? CartJobBridge.getInstance().appPackage : foregroundPackage();
                List<AccessibilityNodeInfo> roots = pkg == null ? new java.util.ArrayList<>() : appRoots(pkg);
                AccessibilityNodeInfo target = node != null && node.isScrollable() ? node : firstScrollable(roots.isEmpty() ? null : roots.get(0));
                if (target != null && target.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)) return "scrolled";
                swipeUp();
                return "swiped";
            }
            case "back":
                performGlobalAction(GLOBAL_ACTION_BACK);
                return "back";
            case "home":
                performGlobalAction(GLOBAL_ACTION_HOME);
                return "home";
            default:
                return "waited";
        }
    }

    private static boolean looksForbidden(AccessibilityNodeInfo n) {
        String own = label(n) + " " + (n.getViewIdResourceName() != null ? n.getViewIdResourceName() : "");
        String inside = n.getChildCount() > 0 ? descendantText(n, 0) : "";
        return FORBIDDEN.matcher(own).find() || (inside.length() < 60 && FORBIDDEN.matcher(inside).find());
    }

    /** performAction on the node or its nearest clickable ancestor; falls back to a tap at its centre. */
    private boolean click(AccessibilityNodeInfo node) {
        AccessibilityNodeInfo n = node;
        for (int d = 0; d < 5 && n != null; d++, n = n.getParent()) {
            if (n.isClickable()) {
                if (looksForbidden(n)) return false;
                if (n.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true;
            }
        }
        Rect r = new Rect();
        node.getBoundsInScreen(r);
        if (r.isEmpty() || Build.VERSION.SDK_INT < 24) return false;
        Path p = new Path();
        p.moveTo(r.exactCenterX(), r.exactCenterY());
        return dispatchGesture(new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(p, 0, 60)).build(), null, null);
    }

    private static AccessibilityNodeInfo firstScrollable(AccessibilityNodeInfo n) {
        if (n == null) return null;
        if (n.isScrollable() && n.isVisibleToUser()) return n;
        for (int i = 0; i < n.getChildCount(); i++) {
            AccessibilityNodeInfo f = firstScrollable(n.getChild(i));
            if (f != null) return f;
        }
        return null;
    }

    private void swipeUp() {
        swipe(true);
    }

    /** A swipe through the middle of the screen: finger up scrolls the content down (towards what is below). */
    private boolean swipe(boolean fingerUp) {
        if (Build.VERSION.SDK_INT < 24) return false;
        int h = getResources().getDisplayMetrics().heightPixels;
        int w = getResources().getDisplayMetrics().widthPixels;
        Path p = new Path();
        p.moveTo(w / 2f, h * (fingerUp ? 0.75f : 0.3f));
        p.lineTo(w / 2f, h * (fingerUp ? 0.3f : 0.75f));
        return dispatchGesture(new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(p, 0, 350)).build(), null, null);
    }

    // ------------------------------------------------------------------ progress (CartJobBridge listener)
    @Override
    public void onProgress(int index, int total, boolean ok, String note) {
        ui.post(() -> setStatus((ok ? "Added " : "Couldn't add ") + note));
    }

    @Override
    public void onNeedUser(String message) {
        ui.post(() -> {
            paused = true;
            ui.removeCallbacks(stepRunnable);
            setStatus(message);
            if (continueButton != null) continueButton.setVisibility(View.VISIBLE);
        });
    }

    @Override
    public void onDone(int added, int total, String message) {
        ui.post(() -> {
            running = false;
            paused = false;
            ui.removeCallbacks(stepRunnable);
            nodes.clear();
            setStatus("Cart ready: " + added + "/" + total + " added. " + message + " Payment is up to you.");
            if (continueButton != null) continueButton.setVisibility(View.GONE);
            if (stopButton != null) stopButton.setText("Close");
            if (backButton != null) backButton.setVisibility(View.VISIBLE);
        });
    }

    // ------------------------------------------------------------------ the AURA bar on top of the store app
    private void showOverlay(String message) {
        if (overlay == null) {
            LinearLayout bar = new LinearLayout(this);
            bar.setOrientation(LinearLayout.HORIZONTAL);
            bar.setGravity(Gravity.CENTER_VERTICAL);
            bar.setBackgroundColor(Color.parseColor("#E60B0F1A"));
            bar.setPadding(24, 12, 12, 12);
            overlayText = new TextView(this);
            overlayText.setTextColor(Color.WHITE);
            overlayText.setTextSize(12);
            overlayText.setMaxLines(3);
            bar.addView(overlayText, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
            continueButton = smallButton("Continue", v -> {
                continueButton.setVisibility(View.GONE);
                paused = false;
                offAppChecks = 0;
                networkFailures = 0;
                setStatus("Continuing…");
                scheduleStep(500);
            });
            continueButton.setVisibility(View.GONE);
            backButton = smallButton("AURA", v -> {
                Intent i = new Intent(this, MainActivity.class);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
                startActivity(i);
                hideOverlay();
            });
            backButton.setVisibility(View.GONE);
            stopButton = smallButton("Stop", v -> {
                if (externalStop != null) {
                    Runnable stop = externalStop;
                    externalStop = null;
                    stop.run();
                }
                if (running) stopJob("Stopped by you.");
                hideOverlay();
            });
            bar.addView(continueButton);
            bar.addView(backButton);
            bar.addView(stopButton);
            WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT,
                    WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                    PixelFormat.TRANSLUCENT);
            lp.gravity = Gravity.BOTTOM;
            lp.y = 220; // above the store's own bottom bar / "View cart" strip
            ((WindowManager) getSystemService(WINDOW_SERVICE)).addView(bar, lp);
            overlay = bar;
        }
        if (stopButton != null) stopButton.setText("Stop");
        if (backButton != null) backButton.setVisibility(View.GONE);
        setStatus(message);
    }

    private Button smallButton(String text, View.OnClickListener onClick) {
        Button b = new Button(this);
        b.setText(text);
        b.setTextSize(12);
        b.setAllCaps(false);
        b.setOnClickListener(onClick);
        return b;
    }

    private void setStatus(String message) {
        if (overlayText != null) overlayText.setText("AURA · " + message);
    }

    private void hideOverlay() {
        if (overlay != null) {
            ((WindowManager) getSystemService(WINDOW_SERVICE)).removeView(overlay);
            overlay = null;
            overlayText = null;
            continueButton = stopButton = backButton = null;
        }
    }

    /** Installed app for a store: the known package if installed, else a launcher app whose name matches. */
    static String findStoreApp(Context context, String knownPackage, String appLabel, String store) {
        android.content.pm.PackageManager pm = context.getPackageManager();
        if (knownPackage != null && !knownPackage.isEmpty() && pm.getLaunchIntentForPackage(knownPackage) != null) {
            return knownPackage;
        }
        Intent main = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        List<android.content.pm.ResolveInfo> apps = pm.queryIntentActivities(main, 0);
        String[] wanted = {appLabel, store};
        for (String w : wanted) {
            if (w == null || w.trim().isEmpty()) continue;
            String want = w.trim().toLowerCase();
            for (android.content.pm.ResolveInfo ri : apps) {
                String label = String.valueOf(ri.loadLabel(pm)).trim().toLowerCase();
                if (!ri.activityInfo.packageName.equals(context.getPackageName())
                        && (label.equals(want) || label.startsWith(want + " ") || want.startsWith(label + " "))) {
                    return ri.activityInfo.packageName;
                }
            }
        }
        return null;
    }
}
