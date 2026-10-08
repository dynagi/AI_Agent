package com.aura.app;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Reads and operates YouTube's player through the accessibility service: whether an ad is showing, and its
 * "Skip ad" button. Controls are found by meaning (resource id, then description, then visible text) and pressed
 * through their own click action; never by screen position. YouTube changes its layout, so several signals are
 * tried, and every press is checked afterwards.
 *
 * Debug builds log what was found (texts, descriptions, ids of YouTube's own controls; nothing personal).
 */
final class YouTubeAdapter {

    private static final String TAG = "YouTubeAdapter";
    static final String PKG = AppResolver.YOUTUBE;

    // resource ids YouTube has used for the skip control and ad overlays (matched loosely: ids change between versions)
    private static final Pattern SKIP_ID = Pattern.compile("(?i)skip_ad|ad_skip|skip_button");
    // a visible label must be just "Skip" / "Skip ad(s)" (never "Skip ads with Premium"); a description may say a bit more
    private static final Pattern SKIP_TEXT = Pattern.compile("(?i)^\\s*skip(?:\\s+ads?)?\\s*$");
    private static final Pattern SKIP_LABEL = Pattern.compile("(?i)^\\s*skip(?:\\s+ads?)?\\s*$|^\\s*skip ads?\\b(?!.*premium)");
    private static final Pattern AD_ID = Pattern.compile("(?i)skip_ad|ad_progress|ad_badge|ad_countdown|ad_text|ad_cta|ad_attribution|player_ad|ad_info");
    private static final Pattern AD_LABEL = Pattern.compile(
            "(?i)^\\s*ad\\s*$|^\\s*ad\\s*[·•:\\-]|\\bsponsored\\b|\\bvisit advertiser\\b|\\bvideo will play after ad\\b|\\bad \\d+ of \\d+\\b|\\bad will end\\b|\\bskip ads?\\b");

    private static final int MAX_ATTEMPTS = 3;
    private static final long CHECK_AFTER_MS = 900;
    private static final Handler ui = new Handler(Looper.getMainLooper());

    /** A skip control found on screen: the node that matched, and the clickable node that operates it. */
    static final class Candidate {
        final AccessibilityNodeInfo match;
        final AccessibilityNodeInfo clickable;
        final String signal;   // "id", "description" or "text"

        Candidate(AccessibilityNodeInfo match, AccessibilityNodeInfo clickable, String signal) {
            this.match = match;
            this.clickable = clickable;
            this.signal = signal;
        }
    }

    interface SkipDone { void onResult(boolean skipped, String why); }

    private YouTubeAdapter() { }

    static boolean onScreen() {
        AuraAccessibilityService s = AuraAccessibilityService.instance;
        return s != null && PKG.equals(s.foregroundPackage());
    }

    /** Whether YouTube is showing an ad right now (ad badge, countdown, "Visit advertiser", a skip button...). */
    static boolean adShowing() {
        List<AccessibilityNodeInfo> found = new ArrayList<>();
        for (AccessibilityNodeInfo root : roots()) walk(root, found, 0, true);
        boolean ad = !found.isEmpty();
        if (debug()) Log.d(TAG, "Advertisement detected: " + ad);
        return ad;
    }

    /** The skip controls on screen, best signal first (resource id, then description, then text). */
    static List<Candidate> skipCandidates() {
        List<AccessibilityNodeInfo> nodes = new ArrayList<>();
        for (AccessibilityNodeInfo root : roots()) walk(root, nodes, 0, false);
        List<Candidate> byId = new ArrayList<>(), byDesc = new ArrayList<>(), byText = new ArrayList<>();
        for (AccessibilityNodeInfo n : nodes) {
            String id = n.getViewIdResourceName();
            CharSequence desc = n.getContentDescription();
            Candidate c;
            if (id != null && SKIP_ID.matcher(id).find()) byId.add(c = new Candidate(n, clickableSelfOrAncestor(n), "id"));
            else if (desc != null && SKIP_LABEL.matcher(desc).find()) byDesc.add(c = new Candidate(n, clickableSelfOrAncestor(n), "description"));
            else byText.add(c = new Candidate(n, clickableSelfOrAncestor(n), "text"));
        }
        List<Candidate> all = new ArrayList<>(byId);
        all.addAll(byDesc);
        all.addAll(byText);
        if (debug()) {
            Log.d(TAG, "Skip button candidates: " + all.size());
            for (Candidate c : all) {
                AccessibilityNodeInfo n = c.match;
                Log.d(TAG, "Candidate (" + c.signal + "): text=" + n.getText() + " contentDescription=" + n.getContentDescription()
                        + " resourceId=" + n.getViewIdResourceName() + " class=" + n.getClassName() + " clickable=" + n.isClickable()
                        + " enabled=" + n.isEnabled() + " visible=" + n.isVisibleToUser()
                        + " clickableAncestor=" + (c.clickable == null ? "none" : c.clickable == n ? "self" : c.clickable.getClassName()
                        + "/" + c.clickable.getViewIdResourceName()));
            }
        }
        return all;
    }

    /**
     * Presses Skip and checks that it worked: the skip control must be gone afterwards. Tries up to MAX_ATTEMPTS
     * times. Reports skipped=false with the reason when there is no button, it can't be pressed, or it stays.
     */
    static void skip(SkipDone done) {
        attempt(1, done);
    }

    private static void attempt(int n, SkipDone done) {
        List<Candidate> found = skipCandidates();
        Candidate pick = null;
        for (Candidate c : found) {
            if (c.clickable != null && c.clickable.isEnabled() && c.match.isVisibleToUser()) { pick = c; break; }
        }
        if (pick == null) {
            done.onResult(false, found.isEmpty() ? (adShowing() ? "not_skippable_yet" : "no_ad") : "not_pressable");
            return;
        }
        boolean clicked = pick.clickable.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        if (debug()) Log.d(TAG, "ACTION_CLICK (attempt " + n + ", " + pick.signal + ") result = " + clicked);
        ui.postDelayed(() -> {
            boolean still = false;
            for (Candidate c : skipCandidates()) still = still || c.match.isVisibleToUser();
            boolean ad = adShowing();
            if (debug()) Log.d(TAG, "Verification: skipButtonPresent = " + still + " adShowing = " + ad);
            if (!still) { done.onResult(true, ad ? "skipped_next_ad_playing" : "skipped"); return; }
            if (n < MAX_ATTEMPTS) attempt(n + 1, done);
            else done.onResult(false, clicked ? "button_stayed" : "click_refused");
        }, CHECK_AFTER_MS);
    }

    // ------------------------------------------------------------------ reading the tree

    private static List<AccessibilityNodeInfo> roots() {
        AuraAccessibilityService s = AuraAccessibilityService.instance;
        return s == null ? new ArrayList<>() : s.roots(PKG);
    }

    /** Collects nodes that look like an ad marker (ads=true) or a skip control (ads=false). */
    private static void walk(AccessibilityNodeInfo n, List<AccessibilityNodeInfo> out, int depth, boolean ads) {
        if (n == null || depth > 60 || out.size() >= 12) return;
        String id = n.getViewIdResourceName();
        CharSequence text = n.getText();
        CharSequence desc = n.getContentDescription();
        boolean hit;
        if (ads) {
            hit = (id != null && AD_ID.matcher(id).find())
                    || (text != null && AD_LABEL.matcher(text).find()) || (desc != null && AD_LABEL.matcher(desc).find());
        } else {
            hit = (id != null && SKIP_ID.matcher(id).find())
                    || (text != null && SKIP_TEXT.matcher(text).find()) || (desc != null && SKIP_LABEL.matcher(desc).find());
        }
        if (hit && n.isVisibleToUser()) out.add(n);
        for (int i = 0; i < n.getChildCount(); i++) walk(n.getChild(i), out, depth + 1, ads);
    }

    /** The node itself if it can be clicked, else the nearest clickable parent (a "Skip" label inside its button). */
    private static AccessibilityNodeInfo clickableSelfOrAncestor(AccessibilityNodeInfo n) {
        AccessibilityNodeInfo cur = n;
        for (int up = 0; cur != null && up < 6; up++) {
            if (cur.isClickable()) return cur;
            cur = cur.getParent();
        }
        return null;
    }

    private static boolean debug() {
        return AuraAccessibilityService.debuggable();
    }
}
