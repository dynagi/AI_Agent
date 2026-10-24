package com.aura.app;

import org.json.JSONObject;
import org.vosk.Model;
import org.vosk.Recognizer;

import java.io.IOException;

/**
 * The wake-phrase recogniser, which can also lend its microphone audio to a second, free-form recogniser.
 *
 * During a Meet or WhatsApp call Android gives any newly opened recording only silence (seen on the phone: the
 * phone's speech recognition reported NO_SPEECH_DETECTED during a Meet call), but the wake listener's stream, opened
 * before the call, keeps hearing. So after "Hey Aura" on a call the command is recognised from that same stream:
 * every chunk the wake recogniser receives is also fed to a free-form recogniser until the sentence ends.
 */
final class TeeRecognizer extends Recognizer {

    /** Receives the recognised command (empty when nothing was understood). Called on the audio thread. */
    interface Heard { void on(String text); }

    private final Model model;
    private final float rate;
    private final Object lock = new Object();
    private Recognizer command;   // non-null while a command is being heard
    private Heard heard;
    private long until;

    TeeRecognizer(Model model, float rate, String grammar) throws IOException {
        super(model, rate, grammar);
        this.model = model;
        this.rate = rate;
    }

    /** Starts hearing one free-form command from the shared stream, for at most `maxMs`. */
    void listenForCommand(long maxMs, Heard heard) throws IOException {
        synchronized (lock) {
            stopCommand();
            command = new Recognizer(model, rate);
            this.heard = heard;
            until = System.currentTimeMillis() + maxMs;
        }
    }

    /** Stops hearing a command without a result. */
    void cancelCommand() {
        synchronized (lock) { stopCommand(); }
    }

    private void stopCommand() {
        if (command != null) command.close();
        command = null;
        heard = null;
    }

    @Override
    public boolean acceptWaveForm(short[] data, int len) {
        Heard done = null;
        String text = null;
        synchronized (lock) {
            if (command != null) {
                boolean end = command.acceptWaveForm(data, len);
                boolean late = System.currentTimeMillis() > until;
                if (end || late) {
                    text = textOf(end ? command.getResult() : command.getFinalResult());
                    // a pause before saying anything is not the end of the command
                    if (!text.isEmpty() || late) {
                        done = heard;
                        stopCommand();
                    }
                }
            }
        }
        if (done != null) done.on(text);
        return super.acceptWaveForm(data, len);
    }

    static String textOf(String json) {
        try {
            return new JSONObject(json).optString("text", "").trim();
        } catch (Exception e) {
            return "";
        }
    }
}
