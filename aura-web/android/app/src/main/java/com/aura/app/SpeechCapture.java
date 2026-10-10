package com.aura.app;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognitionSupport;
import android.speech.RecognitionSupportCallback;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import android.util.Log;

import java.util.ArrayList;
import java.util.List;

/**
 * Captures one spoken command with Android's speech recogniser, from any context (a service as well as an
 * activity). Like AuraSpeechPlugin, it tolerates pauses: the recogniser ends at the first short pause, so this
 * listens in segments and joins them, finishing after QUIET_MS of silence or when stop() is called.
 * All methods and callbacks run on the main thread.
 */
final class SpeechCapture {

    /** Picks the most sensible of the recogniser's guesses for what was said (they come best-first by its own rating). */
    interface Chooser { String pick(List<String> guesses); }

    /** Words the recogniser should expect (app names, command words). Used by recognisers that support biasing. */
    interface Vocabulary { ArrayList<String> words(); }

    interface Callback {
        void onPartial(String textSoFar);
        /** Listening ended. text is what was heard ("" if nothing); error explains an empty result, when known. */
        void onDone(String text, String error);
        /** Microphone level 0..1, for a listening animation. */
        void onLevel(float level);
    }

    private static final String TAG = "AuraSpeech";
    private static final long QUIET_MS = 2000;
    private static final int GUESSES = 5;
    private static boolean languageChecked;
    private static final long MAX_COMMAND_MS = 30000;

    private final Context context;
    private final Callback callback;
    private Chooser chooser;
    private Vocabulary vocabulary;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Runnable quietTimeout = () -> finish(null);
    private final Runnable maxTimeout = () -> finish(null);
    private SpeechRecognizer recognizer;
    private String lang = "en-IN";
    private StringBuilder heard = new StringBuilder();
    private String partial = "";
    private boolean active;
    private boolean stopping;
    private int session;

    SpeechCapture(Context context, Callback callback) {
        this.context = context;
        this.callback = callback;
    }

    void setChooser(Chooser chooser) {
        this.chooser = chooser;
    }

    void setVocabulary(Vocabulary vocabulary) {
        this.vocabulary = vocabulary;
    }

    static boolean available(Context context) {
        return SpeechRecognizer.isRecognitionAvailable(context);
    }

    void start(String language) {
        cancel();
        lang = language;
        heard = new StringBuilder();
        partial = "";
        active = true;
        stopping = false;
        ui.postDelayed(maxTimeout, MAX_COMMAND_MS);
        listenSegment();
    }

    /** Finish now with whatever was heard. */
    void stop() {
        if (!active) return;
        stopping = true;
        ui.removeCallbacks(quietTimeout);
        if (recognizer != null) {
            recognizer.stopListening();
            ui.postDelayed(quietTimeout, 1500);
        } else {
            finish(null);
        }
    }

    /** Drop the capture without a result. */
    void cancel() {
        active = false;
        ui.removeCallbacks(quietTimeout);
        ui.removeCallbacks(maxTimeout);
        session++;
        release();
    }

    private void listenSegment() {
        release();
        final int mine = ++session;
        recognizer = SpeechRecognizer.createSpeechRecognizer(context);
        recognizer.setRecognitionListener(new Listener(mine));
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, GUESSES);
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.getPackageName());
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, QUIET_MS);
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, QUIET_MS);
        if (Build.VERSION.SDK_INT >= 33 && vocabulary != null) {
            ArrayList<String> words = vocabulary.words();
            if (!words.isEmpty()) intent.putExtra(RecognizerIntent.EXTRA_BIASING_STRINGS, words);
        }
        checkLanguage(intent);
        recognizer.startListening(intent);
    }

    private boolean heardAnything() {
        return heard.length() > 0 || !partial.isEmpty();
    }

    private String soFar() {
        return (heard + " " + partial).trim().replaceAll("\\s+", " ");
    }

    private void finish(String error) {
        if (!active) return;
        active = false;
        ui.removeCallbacks(quietTimeout);
        ui.removeCallbacks(maxTimeout);
        session++;
        release();
        String text = soFar();
        callback.onDone(text, text.isEmpty() ? error : null);
    }

    private void release() {
        if (recognizer != null) {
            recognizer.destroy();
            recognizer = null;
        }
    }

    /** The recogniser's top guess (for the live text on screen). */
    private static String best(Bundle results) {
        ArrayList<String> texts = results == null ? null : results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return texts == null || texts.isEmpty() ? "" : texts.get(0);
    }

    /** The final text of a stretch of speech: of the recogniser's guesses, the one that makes most sense as a command. */
    private String chosen(Bundle results) {
        ArrayList<String> texts = results == null ? null : results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (texts == null || texts.isEmpty()) return "";
        if (chooser == null || texts.size() == 1) return texts.get(0);
        String pick = chooser.pick(texts);
        return pick == null || pick.isEmpty() ? texts.get(0) : pick;
    }

    /**
     * Once per run: asks the speech service whether English (India) is installed on the phone, logs the answer, and
     * if the language can be downloaded but isn't there, asks the phone to download it. A recogniser without its
     * Indian English pack falls back to another English model, which gets Indian names and Hinglish wrong.
     */
    private void checkLanguage(Intent intent) {
        if (languageChecked || Build.VERSION.SDK_INT < 33 || recognizer == null) return;
        languageChecked = true;
        final SpeechRecognizer probe = recognizer;
        try {
            probe.checkRecognitionSupport(intent, context.getMainExecutor(), new RecognitionSupportCallback() {
                @Override
                public void onSupportResult(RecognitionSupport support) {
                    List<String> installed = support.getInstalledOnDeviceLanguages();
                    List<String> pending = support.getPendingOnDeviceLanguages();
                    List<String> offered = support.getSupportedOnDeviceLanguages();
                    List<String> online = support.getOnlineLanguages();
                    Log.i(TAG, "speech languages: " + lang + " installed=" + has(installed) + " downloading=" + has(pending)
                            + " downloadable=" + has(offered) + " online=" + has(online)
                            + " | installed " + installed + " | downloading " + pending + " | online " + (online == null ? 0 : online.size()) + " languages");
                    if (!has(installed) && !has(pending) && has(offered)) {
                        try {
                            Intent download = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
                            SpeechRecognizer.createSpeechRecognizer(context).triggerModelDownload(download);
                            Log.i(TAG, "asked the phone to download the " + lang + " speech pack");
                        } catch (Exception e) {
                            Log.w(TAG, "speech pack download not possible: " + e.getMessage());
                        }
                    }
                }

                @Override
                public void onError(int error) {
                    Log.i(TAG, "speech language check not supported by this recogniser (" + error + ")");
                }

                private boolean has(List<String> languages) {
                    if (languages == null) return false;
                    for (String l : languages) if (l.equalsIgnoreCase(lang) || l.replace('_', '-').equalsIgnoreCase(lang)) return true;
                    return false;
                }
            });
        } catch (Exception e) {
            Log.w(TAG, "speech language check failed: " + e.getMessage());
        }
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
            if (!stale()) ui.removeCallbacks(quietTimeout);
        }

        @Override
        public void onRmsChanged(float rmsdB) {
            if (!stale()) callback.onLevel(Math.max(0f, Math.min(1f, (rmsdB + 2f) / 12f)));
        }

        @Override
        public void onPartialResults(Bundle partialResults) {
            if (stale()) return;
            String text = best(partialResults);
            if (text.isEmpty()) return;
            ui.removeCallbacks(quietTimeout);
            partial = text;
            callback.onPartial(soFar());
        }

        @Override
        public void onResults(Bundle results) {
            if (stale()) return;
            String text = chosen(results);
            partial = "";
            if (!text.isEmpty()) heard.append(heard.length() > 0 ? " " : "").append(text);
            if (heard.length() > 0) callback.onPartial(soFar());
            if (stopping) {
                finish(null);
                return;
            }
            listenSegment();   // keep listening: the command is complete after QUIET_MS without more speech
            ui.removeCallbacks(quietTimeout);
            ui.postDelayed(quietTimeout, QUIET_MS);
        }

        @Override
        public void onError(int error) {
            if (stale()) return;
            partial = "";
            switch (error) {
                case SpeechRecognizer.ERROR_NETWORK:
                case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                    finish("I need an internet connection to hear you.");
                    break;
                case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                    finish("Microphone permission is off for AURA.");
                    break;
                case SpeechRecognizer.ERROR_AUDIO:
                case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                    // another app (a call, a recorder) has the microphone: say so instead of closing silently
                    finish(heardAnything() ? null : "I can't use the microphone right now. Another app may be using it.");
                    break;
                default:
                    finish(null);   // silence / no match: nothing was said
            }
        }

        @Override public void onReadyForSpeech(Bundle params) { }
        @Override public void onBufferReceived(byte[] buffer) { }
        @Override public void onEndOfSpeech() { }
        @Override public void onEvent(int eventType, Bundle params) { }
    }
}
