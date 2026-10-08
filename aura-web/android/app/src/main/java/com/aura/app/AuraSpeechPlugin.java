package com.aura.app;

import android.Manifest;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;

/**
 * Speech-to-text for the app. The Web Speech API the browser build uses doesn't exist in an Android WebView, so
 * on the phone voice input goes through Android's own SpeechRecognizer (the engine behind voice typing).
 *
 * One command can contain pauses ("order soya chaap biryani ... from Zomato"). Android's recognizer ends at the
 * first short pause, so this keeps listening in segments and joins them: after each segment it listens again, and
 * the command is complete only when nothing more is said for QUIET_MS (or the user taps the mic to stop).
 *
 * JS: start({lang}) asks for the microphone permission the first time, then emits "speechPartial" {text} (the
 * whole command so far) while the user talks, "speechFinal" {text} with the full command, and "speechEnd"
 * {error?} when listening stops. See aura-web/src/native/speech.ts and services/voice.ts.
 */
@CapacitorPlugin(name = "AuraSpeech", permissions = {
        @Permission(alias = "microphone", strings = {Manifest.permission.RECORD_AUDIO})
})
public class AuraSpeechPlugin extends Plugin {

    /** After a segment, how long to wait for the user to continue before the command counts as finished. */
    private static final long QUIET_MS = 2200;
    private static final long MAX_COMMAND_MS = 45000;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Runnable quietTimeout = () -> finish(null);
    private final Runnable maxTimeout = () -> finish(null);
    private SpeechRecognizer recognizer;
    private String lang = "en-IN";
    private StringBuilder heard = new StringBuilder();
    private String partial = "";
    private boolean active;       // a command is being captured
    private boolean stopping;     // the user tapped stop: finish with what was heard
    private int session;          // callbacks from an older recognizer are ignored

    @PluginMethod
    public void available(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", SpeechRecognizer.isRecognitionAvailable(getContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
            call.reject("Speech recognition isn't available on this phone (install/enable Google voice typing).");
            return;
        }
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "microphoneResult");
            return;
        }
        begin(call);
    }

    @PermissionCallback
    private void microphoneResult(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            begin(call);
        } else {
            call.reject("Microphone permission was denied. Allow it in Settings > Apps > AURA > Permissions.");
        }
    }

    private void begin(PluginCall call) {
        lang = call.getString("lang", "en-IN");
        ui.post(() -> {
            release();
            heard = new StringBuilder();
            partial = "";
            active = true;
            stopping = false;
            ui.postDelayed(maxTimeout, MAX_COMMAND_MS);
            listenSegment();
            call.resolve();
        });
    }

    private void listenSegment() {
        releaseRecognizer();
        final int mine = ++session;
        recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
        recognizer.setRecognitionListener(new Listener(mine));
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getContext().getPackageName());
        // ask the engine itself to tolerate pauses too (not every engine honours these)
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, QUIET_MS);
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, QUIET_MS);
        recognizer.startListening(intent);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        ui.post(() -> {
            if (active) {
                stopping = true;
                ui.removeCallbacks(quietTimeout);
                if (recognizer != null) {
                    recognizer.stopListening();          // delivers the current segment, then we finish
                    ui.postDelayed(quietTimeout, 1500);  // ...or finish anyway if the engine stays silent
                } else {
                    finish(null);
                }
            }
            call.resolve();
        });
    }

    private String commandSoFar() {
        String all = (heard + " " + partial).trim().replaceAll("\\s+", " ");
        return all;
    }

    /** Ends the command: sends everything heard as the final text (or the error if nothing was heard). */
    private void finish(String error) {
        if (!active) return;
        active = false;
        ui.removeCallbacks(quietTimeout);
        ui.removeCallbacks(maxTimeout);
        session++;  // drop late callbacks
        releaseRecognizer();
        String text = commandSoFar();
        if (!text.isEmpty()) {
            emit("speechFinal", "text", text);
            emit("speechEnd", null, null);
        } else {
            emit("speechEnd", "error", error != null ? error : "Didn't catch that. Tap the mic and try again.");
        }
    }

    private void releaseRecognizer() {
        if (recognizer != null) {
            recognizer.destroy();
            recognizer = null;
        }
    }

    private void release() {
        active = false;
        ui.removeCallbacks(quietTimeout);
        ui.removeCallbacks(maxTimeout);
        session++;
        releaseRecognizer();
    }

    @Override
    protected void handleOnDestroy() {
        ui.post(this::release);
    }

    private static String best(Bundle results) {
        ArrayList<String> texts = results == null ? null : results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return texts == null || texts.isEmpty() ? "" : texts.get(0);
    }

    private void emit(String event, String key, String value) {
        JSObject data = new JSObject();
        if (key != null) data.put(key, value);
        notifyListeners(event, data);
    }

    private class Listener implements RecognitionListener {
        private final int mine;

        Listener(int mine) {
            this.mine = mine;
        }

        private boolean stale() {
            return mine != session || !active;
        }

        @Override
        public void onBeginningOfSpeech() {
            if (!stale()) ui.removeCallbacks(quietTimeout);  // the user is continuing the command
        }

        @Override
        public void onPartialResults(Bundle partialResults) {
            if (stale()) return;
            String text = best(partialResults);
            if (text.isEmpty()) return;
            ui.removeCallbacks(quietTimeout);
            partial = text;
            emit("speechPartial", "text", commandSoFar());
        }

        @Override
        public void onResults(Bundle results) {
            if (stale()) return;
            String text = best(results);
            partial = "";
            if (!text.isEmpty()) heard.append(heard.length() > 0 ? " " : "").append(text);
            if (heard.length() > 0) emit("speechPartial", "text", commandSoFar());
            if (stopping) {
                finish(null);
                return;
            }
            // keep listening: if nothing more is said for QUIET_MS, the command is complete
            listenSegment();
            ui.removeCallbacks(quietTimeout);
            ui.postDelayed(quietTimeout, QUIET_MS);
        }

        @Override
        public void onError(int error) {
            if (stale()) return;
            partial = "";
            switch (error) {
                case SpeechRecognizer.ERROR_NO_MATCH:
                case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                    finish("Didn't catch that. Tap the mic and try again.");  // silence: done (with what was heard)
                    break;
                case SpeechRecognizer.ERROR_NETWORK:
                case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                    finish("Voice recognition needs an internet connection.");
                    break;
                case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                    finish("Microphone permission is off for AURA.");
                    break;
                default:
                    finish("Voice recognition stopped (code " + error + ").");
            }
        }

        @Override public void onReadyForSpeech(Bundle params) { }
        @Override public void onRmsChanged(float rmsdB) { }
        @Override public void onBufferReceived(byte[] buffer) { }
        @Override public void onEndOfSpeech() { }
        @Override public void onEvent(int eventType, Bundle params) { }
    }
}
