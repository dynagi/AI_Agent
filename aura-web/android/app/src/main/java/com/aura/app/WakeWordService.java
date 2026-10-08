package com.aura.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Log;

import org.json.JSONObject;
import org.vosk.Model;
import org.vosk.Recognizer;
import org.vosk.android.RecognitionListener;
import org.vosk.android.SpeechService;
import org.vosk.android.StorageService;

import java.util.Locale;
import java.util.regex.Pattern;

/**
 * "Hey Aura": listens for the wake phrase in the background and wakes the assistant.
 *
 * Detection is on-device (Vosk, offline): the microphone audio never leaves the phone while waiting, and the
 * recogniser is restricted to the wake phrase, so nothing else that is said is transcribed. Android requires this
 * to be a foreground service with a visible notification, and it must be started while the app is open.
 *
 * On the wake phrase it does NOT open the app. It runs a short assistant session by itself: a small overlay panel
 * slides up over whatever is on screen (AssistantOverlay), the command is captured with Android's speech recogniser
 * (SpeechCapture), its text is handed to AURA's logic in the app's invisible web view ("wakeCommand" event), and the
 * reply is shown in the panel and spoken with the phone's own voice. Then the panel closes and it waits again.
 * The web app calls pause()/resume() around its own in-app listening so the two never fight over the microphone.
 */
public class WakeWordService extends Service implements RecognitionListener, SpeechCapture.Callback {

    private static final String TAG = "AuraWake";
    private static final String CHANNEL = "aura_wake";
    private static final int NOTIFICATION_ID = 7301;
    private static final float SAMPLE_RATE = 16000f;
    // The recogniser only knows these phrases; everything else becomes [unk]. The extra spellings are how the
    // model tends to hear "aura".
    private static final String GRAMMAR = "[\"hey aura\", \"hey ora\", \"hey aurora\", \"hey laura\", \"[unk]\"]";
    private static final Pattern WAKE = Pattern.compile("\\bhey (aura|ora|aurora|laura)\\b");
    private static final long REARM_MS = 2500;

    static volatile WakeWordService instance;
    static volatile String state = "stopped";   // stopped | loading | listening | paused | error
    static volatile String error = "";

    private final Handler ui = new Handler(Looper.getMainLooper());
    private Model model;
    private SpeechService speech;
    private boolean paused;
    private long lastWake;

    private static final long REPLY_TIMEOUT_MS = 30000;
    private static final int MAX_TURNS = 6;     // question/answer rounds in one session
    private AssistantOverlay overlay;
    private SpeechCapture capture;
    private TextToSpeech tts;
    private boolean ttsReady;
    private Runnable afterSpeech;
    private boolean inSession;
    private boolean answered;
    private boolean webAsked;   // the web app asked the last question, so the next reply is its to read
    private int requestId;
    private int turns;
    private int utterance;
    private android.content.BroadcastReceiver debugTrigger;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        state = "loading";
        error = "";
        startInForeground();
        overlay = new AssistantOverlay(this, () -> endSession(0));
        capture = new SpeechCapture(this, this);
        capture.setChooser(ActionRouter::pickHypothesis);
        final java.util.ArrayList<String> vocabulary = ActionRouter.vocabulary(this);
        capture.setVocabulary(() -> vocabulary);
        tts = new TextToSpeech(this, status -> ttsReady = status == TextToSpeech.SUCCESS);
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String id) { }
            @Override public void onDone(String id) { finished(); }
            @Override public void onError(String id) { finished(); }

            private void finished() {
                ui.post(() -> {
                    Runnable next = afterSpeech;
                    afterSpeech = null;
                    if (next != null) next.run();
                });
            }
        });
        StorageService.unpack(this, "model-en-in", "vosk-model", loaded -> {
            model = loaded;
            listen();
        }, e -> fail("Could not load the wake-word model: " + e.getMessage()));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        registerDebugTrigger();
        return START_STICKY;
    }

    /**
     * Debug builds only: lets the wake flow be tested over adb without speaking.
     *   adb shell am broadcast -a com.aura.app.DEBUG_WAKE                      (as if "Hey Aura" was heard)
     *   adb shell am broadcast -a com.aura.app.DEBUG_WAKE --es text "order milk"   (and this was the command)
     * Never registered in release builds.
     */
    private void registerDebugTrigger() {
        boolean debuggable = (getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (!debuggable || debugTrigger != null) return;
        debugTrigger = new android.content.BroadcastReceiver() {
            @Override
            public void onReceive(android.content.Context context, Intent intent) {
                String text = intent.getStringExtra("text");
                ui.post(() -> {
                    Log.i(TAG, "debug wake" + (text != null ? " with a command" : ""));
                    onWake();
                    if (text != null) {
                        capture.cancel();
                        onDone(text, null);
                    }
                });
            }
        };
        android.content.IntentFilter filter = new android.content.IntentFilter("com.aura.app.DEBUG_WAKE");
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(debugTrigger, filter, RECEIVER_EXPORTED);
        else registerReceiver(debugTrigger, filter);
    }

    private void startInForeground() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Hey Aura", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shown while AURA is listening for \"Hey Aura\"");
            nm.createNotificationChannel(ch);
        }
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        Notification n = b.setContentTitle("AURA is listening for \"Hey Aura\"")
                .setContentText("Only the wake phrase is detected, on this phone. Turn it off in AURA > Voice.")
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setOngoing(true)
                .setContentIntent(open)
                .build();
        if (Build.VERSION.SDK_INT >= 30) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
    }

    /** Starts (or restarts) wake-phrase detection, unless the app is using the microphone itself. */
    private void listen() {
        if (model == null || paused || speech != null) return;
        try {
            Recognizer recognizer = new Recognizer(model, SAMPLE_RATE, GRAMMAR);
            speech = new SpeechService(recognizer, SAMPLE_RATE);
            speech.startListening(this);
            state = "listening";
        } catch (Exception e) {
            fail("Could not open the microphone: " + e.getMessage());
        }
    }

    private void releaseMic() {
        if (speech != null) {
            speech.stop();
            speech.shutdown();
            speech = null;
        }
    }

    /** The app is about to listen or speak itself: let go of the microphone. */
    void pause() {
        ui.post(() -> {
            if (inSession) return;   // the overlay session owns the microphone
            paused = true;
            releaseMic();
            if (!"error".equals(state)) state = "paused";
        });
    }

    /** The app is done: go back to waiting for the wake phrase. */
    void resume() {
        ui.postDelayed(() -> {
            if (inSession) return;
            paused = false;
            listen();
        }, 400);
    }

    private void fail(String message) {
        Log.w(TAG, message);
        state = "error";
        error = message;
    }

    private void check(String hypothesis, String key) {
        try {
            String text = new JSONObject(hypothesis).optString(key, "");
            if (text.isEmpty() || !WAKE.matcher(text).find()) return;
            long now = System.currentTimeMillis();
            if (now - lastWake < REARM_MS) return;
            lastWake = now;
            Log.i(TAG, "wake phrase heard: " + text);
            onWake();
        } catch (Exception ignored) {
            // not JSON we understand: nothing was recognised
        }
    }

    // ------------------------------------------------------------------ the assistant session
    // Wake phrase -> small overlay over the current app -> listen -> think -> answer (shown + spoken) -> close.
    // Nothing is launched: the app the user is in stays on screen and keeps the focus.

    private void onWake() {
        if (inSession) return;
        inSession = true;
        paused = true;          // free the microphone for the command recogniser
        releaseMic();
        state = "paused";
        turns = 0;
        wakeServer();
        boolean shown = overlay.show("Listening…");   // false = no overlay permission: the session still works by voice
        Log.i(TAG, "session started, overlay " + (shown ? "shown (" + AssistantOverlay.surface(this) + ")" : "unavailable: voice only"));
        listenForCommand();
    }

    /**
     * Calls the server's /health in the background as soon as the wake phrase is heard. A free host that has gone
     * to sleep starts waking up while the user is still speaking. The answer is not used.
     */
    private void wakeServer() {
        final String base = AuraWakePlugin.apiUrl;
        if (base == null) return;
        new Thread(() -> {
            java.net.HttpURLConnection c = null;
            try {
                c = (java.net.HttpURLConnection) new java.net.URL(base + "/health").openConnection();
                c.setConnectTimeout(10000);
                c.setReadTimeout(90000);
                c.getResponseCode();
            } catch (Exception ignored) {
                // offline: the command itself will say so
            } finally {
                if (c != null) c.disconnect();
            }
        }, "aura-wake-server").start();
    }

    private void listenForCommand() {
        if (!SpeechCapture.available(this)) {
            answer("Speech recognition isn't available on this phone.", false, false);
            return;
        }
        overlay.setStatus("Listening…", true);
        overlay.setBody("", false);
        capture.start("en-IN");
    }

    /** SpeechCapture.Callback */
    @Override
    public void onPartial(String textSoFar) {
        overlay.setBody(textSoFar, true);
    }

    @Override
    public void onLevel(float level) {
        overlay.setLevel(level);
    }

    @Override
    public void onDone(String text, String error) {
        if (!inSession) return;
        if (text.isEmpty()) {
            if (error != null) answer(error, false, false);
            else endSession(0);   // nothing was said: just go away
            return;
        }
        // what was said is logged only for media / app commands; anything about a person, a reply to a question,
        // or a request for the web app (shopping, health, notes) stays out of the log
        Log.i(TAG, "command: " + (!webAsked && ActionRouter.loggable(text) ? text : "(" + text.split("\\s+").length + " words, not logged)"));
        overlay.setBody(text, true);
        overlay.setStatus("Thinking…", false);
        final int id = ++requestId;
        answered = false;
        // calls, WhatsApp, other apps and media are handled on the phone itself: no server, no web view
        final boolean forWeb = webAsked;
        webAsked = false;
        if (!forWeb && ActionRouter.handle(this, text, new ActionResult.Done() {
            @Override
            public void onResult(ActionResult result) {
                if (!inSession || requestId != id) return;
                if (!overlay.isShowing()) overlay.show("");
                answer(result.say, result.expectAnswer, false, !result.privateText);
            }

            @Override
            public void onPermissionPrompt(String why) {
                // say why, then get out of the way: Android's permission dialog appears where the panel is
                if (!inSession || requestId != id) return;
                overlay.setStatus("", false);
                overlay.setBody(why, false);
                speak(why, () -> { if (inSession && requestId == id && !answered) overlay.hide(); });
            }
        })) return;
        if (!AuraWakePlugin.fireCommand(id, text)) {
            // AURA's logic runs in the app's (invisible) web view; if the app was closed there is nobody to ask
            answer("Open AURA once so I can help. Then call me again.", false, true);
            return;
        }
        ui.postDelayed(() -> {
            if (inSession && requestId == id && !answered) {
                answer("I didn't get an answer in time. AURA's server may be offline.", false, false);
            }
        }, REPLY_TIMEOUT_MS);
    }

    /** The app's reply to the command (AuraWakePlugin.reply). */
    void onReply(int id, String say, boolean expectAnswer, boolean openApp) {
        ui.post(() -> {
            if (!inSession || id != requestId) return;
            webAsked = expectAnswer;
            answer(say, expectAnswer, openApp, false);   // the web app's replies can be personal: not logged
        });
    }

    private void answer(String say, boolean expectAnswer, boolean openApp) {
        answer(say, expectAnswer, openApp, true);
    }

    /** logText false: the reply names what another app is playing, so its words are kept out of the log. */
    private void answer(String say, boolean expectAnswer, boolean openApp, boolean logText) {
        answered = true;
        Log.i(TAG, "answer (expectAnswer=" + expectAnswer + ", openApp=" + openApp + ")" + (logText ? ": " + say : ""));
        if (say == null || say.trim().isEmpty()) {
            endSession(0);
            return;
        }
        overlay.setStatus("", false);
        overlay.setBody(say, false);
        final boolean again = expectAnswer && ++turns < MAX_TURNS;
        speak(say, () -> {
            if (!inSession) return;
            if (again) {
                listenForCommand();
            } else {
                if (openApp) openMainApp();
                endSession(openApp ? 300 : 1800);   // leave the answer up for a moment
            }
        });
    }

    private void speak(String text, Runnable done) {
        if (tts == null || !ttsReady) {
            if (done != null) ui.postDelayed(done, Math.min(6000, 1200 + text.length() * 45L));
            return;
        }
        String clean = text.replaceAll("[*_#`]", "").trim();
        boolean hindi = clean.matches(".*[\\u0900-\\u097F].*");
        tts.setLanguage(hindi ? new Locale("hi", "IN") : new Locale("en", "IN"));
        afterSpeech = done;
        Bundle params = new Bundle();
        tts.speak(clean, TextToSpeech.QUEUE_FLUSH, params, "aura-" + (++utterance));
    }

    /** Closes the overlay and goes back to waiting for the wake phrase. Also the ✕ button. */
    private void endSession(long delayMs) {
        ui.postDelayed(() -> {
            inSession = false;
            answered = true;
            afterSpeech = null;
            capture.cancel();
            if (tts != null) tts.stop();
            overlay.hide();
            paused = false;
            ui.postDelayed(this::listen, 500);
        }, delayMs);
    }

    private void openMainApp() {
        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        try {
            if (AuraAccessibilityService.instance != null) AuraAccessibilityService.instance.startActivity(open);
            else startActivity(open);
        } catch (Exception e) {
            Log.w(TAG, "could not open AURA: " + e.getMessage());
        }
    }

    @Override public void onPartialResult(String hypothesis) { check(hypothesis, "partial"); }
    @Override public void onResult(String hypothesis) { check(hypothesis, "text"); }
    @Override public void onFinalResult(String hypothesis) { check(hypothesis, "text"); }
    @Override public void onError(Exception e) { fail("Wake-word listening stopped: " + e.getMessage()); releaseMic(); }
    @Override public void onTimeout() { }

    @Override
    public void onDestroy() {
        if (debugTrigger != null) unregisterReceiver(debugTrigger);
        if (capture != null) capture.cancel();
        if (overlay != null) overlay.hide();
        if (tts != null) tts.shutdown();
        releaseMic();
        if (model != null) model.close();
        instance = null;
        state = "stopped";
        super.onDestroy();
    }
}
