package com.aura.app;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * The screen assistant: AURA sees what is on the phone's screen and acts on what the user says.
 *
 *  - "what's on my screen" / "tap the second video" / "like this post": reads the foreground app's screen (its
 *    accessibility tree, plus a screenshot when the words on screen are not enough), asks the AURA server for the
 *    single next action, performs it through the element's own click action, checks the new screen, and repeats
 *    until the goal is reached (at most MAX_STEPS steps, MAX_MS, with a Stop button on screen the whole time).
 *  - "find this": screenshots the screen and has the server recognise the product and look up live prices.
 *  - "scroll down": no server needed.
 *
 * Limits that are not negotiable: banking / payment / password / system-security apps are never read, screenshotted
 * or acted in (ScreenPolicy); payment and password controls are never pressed; anything that sends, posts, deletes
 * or buys is confirmed with the user first, by voice. It only ever starts from a spoken command.
 */
final class ScreenAgent {

    private static final String TAG = "AuraScreenAgent";
    private static final int MAX_STEPS = 12;
    private static final long MAX_MS = 80_000;
    private static final Handler ui = new Handler(Looper.getMainLooper());

    /** One screen task: a goal, what has been tried, and where it is in the conversation. */
    static final class Session {
        final String goal;
        final boolean describe;
        final long startedAt = SystemClock.uptimeMillis();
        final List<JSONObject> history = new ArrayList<>();
        String pkg;
        ActionResult.Done done;
        int step;
        int noScreen;
        int failures;
        boolean finished;
        boolean awaitingConfirm;
        JSONObject pending;          // a risky press waiting for the user's yes
        String pendingTarget = "";

        Session(String goal, String pkg, boolean describe, ActionResult.Done done) {
            this.goal = goal;
            this.pkg = pkg;
            this.describe = describe;
            this.done = done;
        }
    }

    private static Session active;

    private ScreenAgent() { }

    /**
     * Whether the screen assistant takes this command. Looking, finding and scrolling always do; "tap / like / open the
     * second one" only when another app is on screen and AURA can act in it, so it never swallows a request meant for
     * AURA's own screens.
     */
    static boolean claims(Context ctx, ScreenIntents.Parsed in) {
        if (in.kind != ScreenIntents.Kind.ACT) return true;
        AuraAccessibilityService s = AuraAccessibilityService.instance;
        if (s == null) return false;
        String pkg = s.foregroundPackage();
        return pkg != null && !pkg.equals(ctx.getPackageName());
    }

    static void handle(Context ctx, ScreenIntents.Parsed in, ActionResult.Done done) {
        AuraAccessibilityService s = AuraAccessibilityService.instance;
        if (s == null) {
            ActionRouter.reply(done, ActionResult.Status.USER_ACTION_REQUIRED, "screen",
                    "I need AURA's accessibility access to see your screen. You can turn it on in Settings, under Accessibility, AURA.");
            return;
        }
        String pkg = s.foregroundPackage();
        if (ScreenPolicy.blocked(pkg)) {
            ActionRouter.reply(done, ActionResult.Status.FAILED, "screen",
                    "I don't look at or act in banking, payment, password or system screens, so I'll leave this one to you.");
            return;
        }
        if (in.kind == ScreenIntents.Kind.SCROLL) {
            boolean ok = s.scrollScreen(in.down);
            ActionRouter.reply(done, ok ? ActionResult.Status.UNVERIFIED : ActionResult.Status.FAILED, "scroll",
                    ok ? (in.down ? "Scrolled down." : "Scrolled up.") : "I couldn't scroll this screen.");
            return;
        }
        if (!ScreenApi.ready()) {
            ActionRouter.reply(done, ActionResult.Status.AUTHENTICATION_REQUIRED, "screen",
                    "Open AURA once so I can sign in, then ask me again.");
            return;
        }
        if (in.kind == ScreenIntents.Kind.VISUAL_SEARCH) {
            visualSearch(s, in.hint, done);
            return;
        }
        if (active != null) finish(active, ActionResult.Status.CANCELLED, "", false);   // a new task replaces the old one
        Session ses = new Session(in.goal, pkg, in.kind == ScreenIntents.Kind.DESCRIBE, done);
        active = ses;
        s.showScreenBar("Working on it: " + clip(in.goal, 60), () -> finish(ses, ActionResult.Status.CANCELLED,
                "Okay, I've stopped.", !ses.awaitingConfirm));
        ui.postDelayed(() -> next(ctx, ses), 500);   // let the voice panel settle before reading the screen
    }

    // ------------------------------------------------------------------ the loop

    private static void next(Context ctx, Session ses) {
        if (ses.finished) return;
        AuraAccessibilityService s = AuraAccessibilityService.instance;
        if (s == null) {
            finish(ses, ActionResult.Status.FAILED, "AURA's accessibility access was turned off, so I've stopped.", true);
            return;
        }
        if (SystemClock.uptimeMillis() - ses.startedAt > MAX_MS) {
            finish(ses, ActionResult.Status.TIMEOUT, "That's taking too long, so I've stopped.", true);
            return;
        }
        String fg = s.foregroundPackage();
        if (fg != null && !fg.equals(ses.pkg)) {
            if (ScreenPolicy.blocked(fg)) {
                finish(ses, ActionResult.Status.FAILED,
                        "That opened a banking, payment or system screen, so I've stopped. The rest is up to you.", true);
                return;
            }
            ses.pkg = fg;
        }
        JSONObject snap = s.screenSnapshot(ses.pkg);
        if (snap == null) {
            if (++ses.noScreen > 3) finish(ses, ActionResult.Status.FAILED, "I can't read this screen.", true);
            else ui.postDelayed(() -> next(ctx, ses), 900);
            return;
        }
        ses.noScreen = 0;
        int elements = snap.optJSONArray("elements") == null ? 0 : snap.optJSONArray("elements").length();
        // a screenshot helps when asked to describe, and when the screen has hardly any readable controls
        boolean shot = (ses.describe || elements < 3) && Build.VERSION.SDK_INT >= 30;
        if (shot) s.captureScreen((b64, err) -> ask(ctx, ses, snap, b64));
        else ask(ctx, ses, snap, null);
    }

    private static void ask(Context ctx, Session ses, JSONObject snap, String screenshot) {
        if (ses.finished) return;
        try {
            JSONArray recent = new JSONArray();
            for (int i = Math.max(0, ses.history.size() - 8); i < ses.history.size(); i++) recent.put(ses.history.get(i));
            JSONObject body = new JSONObject()
                    .put("goal", ses.goal)
                    .put("app", appLabel(ctx, ses.pkg))
                    .put("elements", snap.getJSONArray("elements"))
                    .put("pageText", snap.optString("pageText"))
                    .put("history", recent)
                    .put("step", ses.step);
            if (screenshot != null) body.put("screenshot", screenshot);
            ScreenApi.step(body, (json, err) -> {
                if (ses.finished) return;
                if (err != null) {
                    finish(ses, statusFor(err), messageFor(err), true);
                    return;
                }
                act(ctx, ses, json);
            });
        } catch (JSONException e) {
            finish(ses, ActionResult.Status.FAILED, "I couldn't read this screen.", true);
        }
    }

    private static void act(Context ctx, Session ses, JSONObject a) {
        String type = a.optString("action");
        String message = a.optString("message", "");
        if ("done".equals(type)) {
            finish(ses, ActionResult.Status.UNVERIFIED, message.isEmpty() ? "Done." : message, true);
            return;
        }
        if ("need_user".equals(type)) {
            finish(ses, ActionResult.Status.USER_ACTION_REQUIRED, message.isEmpty() ? "I need your help to continue." : message, true);
            return;
        }
        if (ses.describe) {
            finish(ses, ActionResult.Status.FAILED, "I couldn't work out what is on this screen.", true);
            return;
        }
        String target = a.optString("target", "");
        if ("click".equals(type) && (a.optBoolean("risky") || ScreenPolicy.mustConfirm(target, ses.goal))) {
            confirm(ctx, ses, a, target);
            return;
        }
        perform(ctx, ses, a);
    }

    private static void perform(Context ctx, Session ses, JSONObject a) {
        AuraAccessibilityService s = AuraAccessibilityService.instance;
        if (s == null) {
            finish(ses, ActionResult.Status.FAILED, "AURA's accessibility access was turned off, so I've stopped.", true);
            return;
        }
        String type = a.optString("action");
        String result = s.performScreen(a);
        record(ses, type, a.optString("target", ""), result);
        Log.i(TAG, "step " + ses.step + ": " + type + " -> " + result);
        if (result.startsWith("refused")) {
            finish(ses, ActionResult.Status.FAILED, "That looks like a payment or password control, so I didn't touch it.", true);
            return;
        }
        boolean failed = result.equals("element gone") || result.equals("click failed") || result.equals("type failed");
        if (failed && ++ses.failures >= 2) {
            finish(ses, ActionResult.Status.FAILED, "I couldn't press that. The app doesn't let me.", true);
            return;
        }
        if (!failed) ses.failures = 0;
        if (++ses.step >= MAX_STEPS) {
            finish(ses, ActionResult.Status.FAILED, "That's taking too many steps, so I've stopped.", true);
            return;
        }
        s.setScreenBar(clip(a.optString("reason", type), 70));
        long wait = "wait".equals(type) ? 2000 : "click".equals(type) ? 1500 : 1200;
        ui.postDelayed(() -> next(ctx, ses), wait);
    }

    // ------------------------------------------------------------------ confirming risky presses

    private static void confirm(Context ctx, Session ses, JSONObject a, String target) {
        ses.pending = a;
        ses.pendingTarget = target;
        ses.awaitingConfirm = true;
        ConversationContext.Task task = new ConversationContext.Task();
        task.type = Intents.Type.SCREEN_TASK;
        task.screen = ses;
        AuraAccessibilityService s = AuraAccessibilityService.instance;
        if (s != null) s.setScreenBar("Waiting for your OK to press “" + clip(target, 30) + "”");
        String q = "I'm about to press " + (target.isEmpty() ? "a button" : "\"" + clip(target, 40) + "\"") + " in " + appLabel(ctx, ses.pkg)
                + ". Should I go ahead?";
        ActionRouter.ask(ses.done, task, ConversationContext.Ask.CONFIRM, q, null, null);
        // nobody answered: give the task up instead of leaving the bar on screen
        ui.postDelayed(() -> {
            if (!ses.finished && ses.awaitingConfirm && ses.pending == a) finish(ses, ActionResult.Status.CANCELLED, "", false);
        }, ConversationContext.PENDING_MS + 2000);
    }

    /** The user said yes to the press AURA asked about. */
    static void resume(Context ctx, ConversationContext.Task task, ActionResult.Done done) {
        Session ses = task.screen instanceof Session ? (Session) task.screen : null;
        AuraAccessibilityService s = AuraAccessibilityService.instance;
        if (ses == null || ses.finished || ses.pending == null || s == null) {
            ActionRouter.reply(done, ActionResult.Status.FAILED, "screen", "That's no longer on the screen, so I didn't press it.");
            return;
        }
        ses.done = done;
        ses.awaitingConfirm = false;
        JSONObject a = ses.pending;
        ses.pending = null;
        String result = s.performScreen(a);
        // the screen may have been re-read since: fall back to finding the control by its label
        if (!result.startsWith("clicked") && !ses.pendingTarget.isEmpty()
                && s.clickLabelled(ses.pkg, Pattern.compile("^\\s*" + Pattern.quote(ses.pendingTarget) + "\\s*$", Pattern.CASE_INSENSITIVE))) {
            result = "clicked (by label)";
        }
        record(ses, "click", ses.pendingTarget, result);
        if (!result.startsWith("clicked")) {
            finish(ses, ActionResult.Status.FAILED, "I couldn't press it.", true);
            return;
        }
        s.setScreenBar("Continuing…");
        ses.step++;
        ui.postDelayed(() -> next(ctx, ses), 1500);
    }

    /** The user said no (or something else): drop the task. */
    static void cancel(ConversationContext.Task task) {
        if (task.screen instanceof Session) finish((Session) task.screen, ActionResult.Status.CANCELLED, "", false);
    }

    // ------------------------------------------------------------------ "find this"

    private static void visualSearch(AuraAccessibilityService s, String hint, ActionResult.Done done) {
        if (Build.VERSION.SDK_INT < 30) {
            ActionRouter.reply(done, ActionResult.Status.UNSUPPORTED, "visual_search",
                    "Looking at the screen to find a product needs Android 11 or newer.");
            return;
        }
        s.captureScreen((b64, err) -> {
            if (b64 == null) {
                ActionRouter.reply(done, ActionResult.Status.FAILED, "visual_search", screenshotProblem(err));
                return;
            }
            ScreenApi.visualSearch(b64, hint, (json, e) -> {
                if (e != null) {
                    ActionRouter.reply(done, statusFor(e), "visual_search", messageFor(e));
                    return;
                }
                ActionRouter.reply(done, ActionResult.Status.UNVERIFIED, "visual_search", describeMatch(json));
            });
        });
    }

    /** What AURA says about the product it found; also hands the matches to the web app's shopping page. */
    static String describeMatch(JSONObject json) {
        JSONArray products = json.optJSONArray("products");
        if (products == null || products.length() == 0) {
            String summary = json.optString("summary", "");
            return summary.isEmpty() ? "I couldn't spot a product on this screen." : "I couldn't spot a product to search for. " + summary;
        }
        JSONObject top = products.optJSONObject(0);
        String name = top == null ? "" : top.optString("name", "");
        StringBuilder say = new StringBuilder("That looks like ").append(name.isEmpty() ? "a product" : name).append(".");
        JSONArray results = json.optJSONArray("results");
        JSONObject best = results == null ? null : results.optJSONObject(0);
        if (best != null && !best.isNull("price")) {
            say.append(" The lowest price I found is ").append(spokenPrice(best.optDouble("price"), best.optString("currency", "INR")));
            String store = best.optString("source", "");
            if (!store.isEmpty()) say.append(" on ").append(store);
            say.append(".");
        } else {
            say.append(" I couldn't get prices right now.");
        }
        say.append(" I've put the matches in AURA's shopping.");
        AuraScreenPlugin.offerVisual(json);
        return say.toString();
    }

    static String spokenPrice(double price, String currency) {
        String amount = price == Math.floor(price) ? String.format(Locale.US, "%.0f", price) : String.format(Locale.US, "%.2f", price);
        return "INR".equals(currency) ? amount + " rupees" : amount + " " + currency;
    }

    private static String screenshotProblem(String err) {
        if (err == null) return "I couldn't look at the screen.";
        switch (err) {
            case "needs_android_11": return "Looking at the screen to find a product needs Android 11 or newer.";
            case "screenshot_failed_2":
                return "To take screenshots, AURA's accessibility access has to be turned off and on again once in Settings, under Accessibility.";
            case "screenshot_failed_3": return "I took a screenshot a moment ago. Try again in a second.";
            case "screenshot_failed_6": return "This app doesn't allow screenshots, so I can't see it.";
            default: return "I couldn't take a screenshot of this screen.";
        }
    }

    // ------------------------------------------------------------------ helpers

    private static void finish(Session ses, ActionResult.Status status, String say, boolean speak) {
        if (ses.finished) return;
        ses.finished = true;
        ses.pending = null;
        if (active == ses) active = null;
        AuraAccessibilityService s = AuraAccessibilityService.instance;
        if (s != null) s.hideScreenBar();
        if (speak && !say.isEmpty()) ActionRouter.reply(ses.done, status, "screen", say);
    }

    private static void record(Session ses, String action, String target, String result) {
        try {
            ses.history.add(new JSONObject().put("action", action).put("target", target).put("result", result));
        } catch (JSONException ignored) {
            // a history line is only a hint for the next step
        }
    }

    private static ActionResult.Status statusFor(String err) {
        switch (err) {
            case "not_signed_in": return ActionResult.Status.AUTHENTICATION_REQUIRED;
            default: return ActionResult.Status.NETWORK_ERROR;
        }
    }

    private static String messageFor(String err) {
        switch (err) {
            case "not_signed_in": return "Open AURA once so I can sign in, then ask me again.";
            case "unavailable": return "AURA's server isn't answering right now. Try again in a moment.";
            default: return "I can't reach AURA's server. Check your connection.";
        }
    }

    private static String appLabel(Context ctx, String pkg) {
        try {
            PackageManager pm = ctx.getPackageManager();
            ApplicationInfo info = pm.getApplicationInfo(pkg, 0);
            return String.valueOf(pm.getApplicationLabel(info));
        } catch (Exception e) {
            return "the app";
        }
    }

    private static String clip(String s, int n) {
        String t = s == null ? "" : s.replaceAll("\\s+", " ").trim();
        return t.length() > n ? t.substring(0, n) : t;
    }
}
