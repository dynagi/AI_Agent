package com.aura.app;

import java.util.Locale;
import java.util.regex.Pattern;

/**
 * What AURA will never look at or press, however it is asked. Shared by the screen agent (it reads and acts on the
 * screen), visual search (it sends a screenshot to the AI service) and activity learning (it records habits).
 * Plain Java so it can be unit tested.
 */
final class ScreenPolicy {

    /**
     * Banking, payment, wallet, password-manager, authenticator, brokerage and system-security apps, and the system
     * screens where permissions, purchases and sign-in happen. Matched against the package name.
     */
    private static final Pattern SENSITIVE_PACKAGE = Pattern.compile(
            "(?i)(bank|banking|upi|paytm|phonepe|paisa|bhim|mobikwik|freecharge|razorpay|dreamplug|\\bcred\\b|wallet|"
                    + "amazon\\.pay|\\.pay\\b|\\.pay\\.|payments?|authenticator|authy|bitwarden|lastpass|1password|dashlane|"
                    + "keepass|keeper|password|zerodha|groww|upstox|trading|brokerage|insurance|"
                    + "com\\.android\\.settings|packageinstaller|permissioncontroller|com\\.android\\.vending|"
                    + "com\\.google\\.android\\.gms|com\\.android\\.systemui|com\\.android\\.keyguard|lockscreen|"
                    + "com\\.samsung\\.android\\.samsungpass|securefolder)");

    /** Packages that say nothing about what the user is doing: keyboards, the launcher, the status bar. */
    private static final Pattern NOISE_PACKAGE = Pattern.compile(
            "(?i)(inputmethod|keyboard|\\.ime\\b|launcher|com\\.android\\.systemui|com\\.google\\.android\\.apps\\.nexuslauncher|"
                    + "com\\.sec\\.android\\.app\\.launcher|com\\.miui\\.home)");

    /** Presses that can't be taken back or speak for the user: always confirmed first. */
    private static final Pattern ALWAYS_CONFIRM = Pattern.compile(
            "(?i)\\b(send|post|publish|delete|remove|transfer|submit|confirm|order|buy|log\\s*out|sign\\s*out|uninstall|block|report)\\b");
    private static final String[] CONFIRM_UNLESS_ASKED = {"share", "follow", "unfollow", "subscribe", "call"};

    /** Payment and credential controls: never pressed. */
    private static final Pattern FORBIDDEN = Pattern.compile(
            "(?i)\\b(pay|payment|payments|checkout|check\\s*out|place\\s*order|confirm\\s*order|complete\\s*order|buy\\s*now|"
                    + "proceed\\s*to\\s*(pay|buy|checkout)|slide\\s*to\\s*pay|swipe\\s*to\\s*pay|upi|cash\\s*on\\s*delivery|cvv|otp|"
                    + "password|passcode)\\b");

    private ScreenPolicy() { }

    /** True when AURA must not read, act in, screenshot or learn from this app. An unknown package counts as blocked. */
    static boolean blocked(String pkg) {
        return pkg == null || pkg.isEmpty() || SENSITIVE_PACKAGE.matcher(pkg).find();
    }

    /** True for packages that are just the phone's furniture (keyboard, launcher, status bar): not worth learning from. */
    static boolean noise(String pkg) {
        return pkg == null || NOISE_PACKAGE.matcher(pkg).find();
    }

    /** True for text that names a payment or credential control. */
    static boolean forbiddenText(String text) {
        return text != null && FORBIDDEN.matcher(text).find();
    }

    /** Whether pressing a control called `label` must be confirmed with the user first, given what they asked for. */
    static boolean mustConfirm(String label, String goal) {
        if (label == null || label.trim().isEmpty()) return false;
        if (ALWAYS_CONFIRM.matcher(label).find()) return true;
        String g = goal == null ? "" : goal.toLowerCase(Locale.ROOT);
        for (String verb : CONFIRM_UNLESS_ASKED) {
            if (Pattern.compile("(?i)\\b" + verb + "\\b").matcher(label).find() && !g.contains(verb)) return true;
        }
        return false;
    }
}
