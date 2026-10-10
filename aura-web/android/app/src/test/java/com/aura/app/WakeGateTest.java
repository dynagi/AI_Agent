package com.aura.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** "Hey Aura" must only listen when allowed, and only a clear wake phrase may open an assistant session. */
public class WakeGateTest {

    private static String result(String text, double... conf) {
        StringBuilder words = new StringBuilder();
        String[] w = text.split(" ");
        for (int i = 0; i < conf.length; i++) {
            if (i > 0) words.append(',');
            words.append("{\"word\":\"").append(i < w.length ? w[i] : "x").append("\",\"conf\":").append(conf[i]).append('}');
        }
        return "{\"result\":[" + words + "],\"text\":\"" + text + "\"}";
    }

    // ------------------------------------------------------------------ when the microphone may be used

    @Test
    public void settingOffNeverListens() {
        assertFalse(WakeGate.mayListen(false, false, true, false, false, false));
    }

    @Test
    public void settingOnAndIdleListens() {
        assertTrue(WakeGate.mayListen(true, false, true, false, false, false));
    }

    @Test
    public void staleCallbackAfterTheServiceStoppedDoesNotListen() {
        // e.g. the model finished loading, or a re-arm fired, after "Hey Aura" was switched off
        assertFalse(WakeGate.mayListen(true, true, true, false, false, false));
    }

    @Test
    public void noSecondListenerWhileTheMicIsBusy() {
        assertFalse(WakeGate.mayListen(true, false, true, false, true, false));   // an assistant session
        assertFalse(WakeGate.mayListen(true, false, true, false, false, true));   // the app's own mic button
        assertFalse(WakeGate.mayListen(true, false, true, true, false, false));   // paused
        assertFalse(WakeGate.mayListen(true, false, false, false, false, false)); // model not loaded yet
    }

    // ------------------------------------------------------------------ other apps using the microphone

    @Test
    public void callsAndOtherRecordersAreReportedNotFought() {
        assertTrue(WakeGate.micBlockedReason(true, false, false).contains("phone call"));
        assertTrue(WakeGate.micBlockedReason(false, true, false).contains("in a call"));     // Meet, WhatsApp
        assertTrue(WakeGate.micBlockedReason(false, false, true).contains("using the microphone"));
        assertEquals(null, WakeGate.micBlockedReason(false, false, false));                 // nothing in the way
    }

    // ------------------------------------------------------------------ what counts as "Hey Aura"

    @Test
    public void clearWakePhraseCounts() {
        assertTrue(WakeGate.isWakePhrase(result("hey aura", 0.97, 0.95), true));
        assertTrue(WakeGate.isWakePhrase(result("hey ora", 0.9, 0.88), true));
    }

    @Test
    public void theUsersRealVoiceCounts() {
        // measured on the user's phone: "hey" certain, the name about 0.43-0.50
        assertTrue(WakeGate.isWakePhrase(result("hey ora", 1.0, 0.5), true));
        assertTrue(WakeGate.isWakePhrase(result("hey ora", 1.0, 0.43278), true));
        assertTrue(WakeGate.isWakePhrase(result("hey ora", 1.0, 0.44537), true));
    }

    @Test
    public void partialResultsNeverCount() {
        assertFalse(WakeGate.isWakePhrase(result("hey aura", 0.99, 0.99), false));
    }

    @Test
    public void randomSpeechForcedOntoThePhraseDoesNotCount() {
        // the recogniser only knows a few phrases, so ordinary talk comes out as "hey ora" with low confidence
        assertFalse(WakeGate.isWakePhrase(result("hey ora", 0.42, 0.61), true));   // "hey" not clear
        assertFalse(WakeGate.isWakePhrase(result("hey aura", 0.7, 0.9), true));    // "hey" not clear
        assertFalse(WakeGate.isWakePhrase(result("hey ora", 1.0, 0.2), true));     // name barely there
        assertFalse(WakeGate.isWakePhrase(result("hey ora", 0.86, 0.35), true));   // both weak together
    }

    @Test
    public void phraseInsideOtherSpeechDoesNotCount() {
        assertFalse(WakeGate.isWakePhrase(result("[unk] hey ora", 0.9, 0.95, 0.95), true));
        assertFalse(WakeGate.isWakePhrase(result("hey ora [unk]", 0.95, 0.95, 0.9), true));
        assertFalse(WakeGate.isWakePhrase(result("[unk]", 0.99), true));
    }

    @Test
    public void emptyOrBrokenResultsDoNotCount() {
        assertFalse(WakeGate.isWakePhrase("{\"text\":\"\"}", true));
        assertFalse(WakeGate.isWakePhrase("{\"text\":\"hey aura\"}", true));   // no word confidences: can't tell
        assertFalse(WakeGate.isWakePhrase("not json", true));
        assertFalse(WakeGate.isWakePhrase(null, true));
    }
}
