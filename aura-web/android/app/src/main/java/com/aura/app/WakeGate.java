package com.aura.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * The two rules that keep "Hey Aura" from listening when it shouldn't, kept apart from the service so they can be
 * unit tested:
 *
 * 1. mayListen(): the wake-phrase detector may only hold the microphone when the user's setting is on, the service is
 *    alive, nobody else (the app, an assistant session) is using the microphone, and the model is loaded.
 *
 * 2. isWakePhrase(): a recogniser result counts as "Hey Aura" only when it is a final result (partial guesses change
 *    as more audio arrives), the whole utterance is the phrase on its own (ordinary speech that merely contains
 *    something like it is not), "hey" is clear and the name is at least plausibly there (see MIN_*). The recogniser only knows a
 *    handful of phrases, so it tends to force ordinary speech onto the nearest one: these checks are what stop that
 *    from opening an assistant session.
 */
final class WakeGate {

    // Measured on the user's phone: a real "Hey Aura" comes out as "hey ora" with "hey" at 1.0 and the name at
    // about 0.43-0.50 (the Indian-English model is unsure how to spell the name, not whether it was said).
    /** "hey" must be clear. */
    static final double MIN_HEY = 0.85;
    /** The name word may be uncertain, but not absent. */
    static final double MIN_NAME = 0.30;
    /** Both words together. */
    static final double MIN_MEAN = 0.65;

    private static final Set<String> PHRASES = new HashSet<>(Arrays.asList(
            "hey aura", "hey ora", "hey aurora", "hey laura"));

    private WakeGate() { }

    static boolean mayListen(boolean settingOn, boolean destroyed, boolean modelLoaded, boolean paused,
                             boolean inSession, boolean appHoldsMic) {
        return settingOn && !destroyed && modelLoaded && !paused && !inSession && !appHoldsMic;
    }

    /**
     * Why "Hey Aura" can't be heard right now, in words for the user; null when nothing is in the way. Android gives
     * the microphone to phone calls and internet calls (Google Meet, WhatsApp), and may silence a background listener
     * while another app records. AURA doesn't work around that: it waits, and says so.
     */
    static String micBlockedReason(boolean phoneCall, boolean internetCall, boolean silencedByAnotherApp) {
        if (phoneCall) return "You're on a phone call, so I can't hear \"Hey Aura\" until it ends.";
        if (internetCall) return "Another app is in a call (like Meet or WhatsApp), so I can't hear \"Hey Aura\" until it ends.";
        if (silencedByAnotherApp) return "Another app is using the microphone, so I can't hear \"Hey Aura\" right now.";
        return null;
    }

    /**
     * Whether a recogniser result is the wake phrase. `json` is the recogniser's result ({"text": ..., "result":
     * [{"word", "conf"}...]}); `isFinal` is false for partial results, which never count.
     */
    static boolean isWakePhrase(String json, boolean isFinal) {
        if (!isFinal || json == null) return false;
        try {
            JSONObject o = new JSONObject(json);
            String text = o.optString("text", "").toLowerCase(Locale.ROOT).trim().replaceAll("\\s+", " ");
            if (!PHRASES.contains(text)) return false;   // anything else around it ("[unk] hey ora ...") is not a wake
            JSONArray words = o.optJSONArray("result");
            if (words == null || words.length() == 0) return false;   // no confidences: can't tell, so no
            if (words.length() != 2) return false;
            double hey = words.getJSONObject(0).optDouble("conf", 0);
            double name = words.getJSONObject(1).optDouble("conf", 0);
            if (hey < MIN_HEY || name < MIN_NAME || (hey + name) / 2 < MIN_MEAN) return false;
            return true;
        } catch (Exception e) {
            return false;
        }
    }
}
