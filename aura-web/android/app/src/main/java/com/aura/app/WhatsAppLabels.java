package com.aura.app;

import java.util.regex.Pattern;

/**
 * Labels on WhatsApp's call screen that AURA presses through the accessibility service. The red button is described
 * "End call" ("Leave call" in group calls); while a call runs, WhatsApp's other screens show a "return to call" banner
 * that brings the call screen back. Plain Java so it can be unit tested.
 */
final class WhatsAppLabels {

    static final Pattern END_CALL_BUTTON = Pattern.compile("(?i)^(?:end call|end video call|leave call|hang up)$");
    static final Pattern RETURN_TO_CALL = Pattern.compile(
            "(?i)(?:tap to return to (?:the )?call|return to call|ongoing (?:voice |video )?call)");

    private WhatsAppLabels() { }

    static boolean isEndCallButton(String label) { return END_CALL_BUTTON.matcher(label).matches(); }

    static boolean isReturnToCall(String label) { return RETURN_TO_CALL.matcher(label).find(); }
}
