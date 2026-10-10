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
    private static final long REARM_MS = 2500;

    static volatile WakeWordService instance;

    // The user's "Hey Aura" setting, saved on the phone. The service obeys it on its own: it won't run or listen while
    // it is off, whatever starts it (a leftover restart by Android, a late callback, a stale request from the app).
    private static final String PREFS = "aura_wake";
    private static final String ENABLED = "enabled";

    static boolean settingOn(android.content.Context ctx) {
        return ctx.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(ENABLED, false);
    }

    /** null when the setting was never saved on the phone (an older build saved it only in the app). */
    static Boolean savedSetting(android.content.Context ctx) {
        android.content.SharedPreferences p = ctx.getSharedPreferences(PREFS, MODE_PRIVATE);
        return p.contains(ENABLED) ? p.getBoolean(ENABLED, false) : null;
    }

    static void saveSetting(android.content.Context ctx, boolean on) {
        ctx.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(ENABLED, on).commit();
    }

    /** Set in onDestroy: every delayed callback (model load, re-arm after a session) checks it and does nothing. */
    private volatile boolean destroyed;
    static volatile String state = "stopped";   // stopped | loading | listening | paused | error
    static volatile String error = "";

    private final Handler ui = new Handler(Looper.getMainLooper());
    private Model model;
    private SpeechService speech;
    private boolean paused;
    private long lastWake;

    private static final long REPLY_TIMEOUT_MS = 30000;
    /** How long the app's own logic gets to answer before the service asks the server itself (see askServer). */
    private static final long WEB_GRACE_MS = 4000;
    /** After handing a command to the app (brought forward to wake it), how long its answer may take. */
    private static final long HANDOFF_MS = 25000;
    private long replyDeadline;
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
            if (destroyed) { loaded.close(); return; }   // turned off while the model was loading
            model = loaded;
            listen();
        }, e -> fail("Could not load the wake-word model: " + e.getMessage()));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!settingOn(this)) {
            Log.i(TAG, "start refused: \"Hey Aura\" is off");
            stopSelf();
            return START_NOT_STICKY;
        }
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
        if (speech != null) return;   // already listening: never a second microphone stream
        if (!WakeGate.mayListen(settingOn(this), destroyed, model != null, paused, inSession, AuraWakePlugin.appHolding)) {
            if (!settingOn(this) && !destroyed) state = "stopped";
            return;
        }
        try {
            Recognizer recognizer = new Recognizer(model, SAMPLE_RATE, GRAMMAR);
            recognizer.setWords(true);   // per-word confidence, so ordinary speech forced onto the phrase can be told apart
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
            if (inSession || destroyed) return;
            paused = false;
            listen();   // only if the setting is still on (see WakeGate.mayListen)
        }, 400);
    }

    private void fail(String message) {
        Log.w(TAG, message);
        state = "error";
        error = message;
    }

    /** A final recogniser result: a session starts only for the wake phrase said clearly on its own (WakeGate). */
    private void check(String hypothesis) {
        // debug builds: what the wake recogniser heard (it only knows the wake phrases, so this is never a transcript)
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
                && hypothesis != null && !hypothesis.contains("\"text\" : \"\"")) {
            Log.d(TAG, "wake candidate: " + hypothesis.replaceAll("\\s+", " "));
        }
        if (destroyed || speech == null || !WakeGate.isWakePhrase(hypothesis, true)) return;
        long now = System.currentTimeMillis();
        if (now - lastWake < REARM_MS) return;
        lastWake = now;
        Log.i(TAG, "wake phrase heard");
        onWake();
    }

    // ------------------------------------------------------------------ the assistant session
    // Wake phrase -> small overlay over the current app -> listen -> think -> answer (shown + spoken) -> close.
    // Nothing is launched: the app the user is in stays on screen and keeps the focus.

    private void onWake() {
        if (inSession || destroyed || !settingOn(this)) return;
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
        // Android puts the app's web view to sleep in the background (more so with the screen off), so its answer can
        // be minutes late. If it hasn't answered shortly, the service asks the server itself.
        final String asked = text;
        ui.postDelayed(() -> { if (inSession && requestId == id && !answered) askServer(id, asked); }, WEB_GRACE_MS);
        replyDeadline = android.os.SystemClock.uptimeMillis() + REPLY_TIMEOUT_MS;
        ui.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (!inSession || requestId != id || answered) return;
                long left = replyDeadline - android.os.SystemClock.uptimeMillis();
                if (left > 0) { ui.postDelayed(this, left); return; }   // extended by a hand-over to the app
                answer("I didn't get an answer in time. AURA's server may be offline.", false, false);
            }
        }, REPLY_TIMEOUT_MS);
    }

    /**
     * Sends the command straight to AURA's server chat and speaks its reply. Used when the app's web view is asleep.
     * It answers questions and conversation; things that live in the app (opening a screen, a shopping cart) are left
     * out, and the reply says nothing it didn't do. Needs the session the app last handed over (ScreenApi).
     */
    private void askServer(int id, String text) {
        if (!ScreenApi.ready()) return;   // no session yet: the app's answer (or the time-out) will come
        Log.i(TAG, "web view asleep: asking the server directly");
        ScreenApi.converse(text, (json, error) -> {
            if (!inSession || requestId != id || answered || destroyed) return;
            org.json.JSONArray actions = json == null ? null : json.optJSONArray("do");
            if (error == null && actions != null && actions.length() > 0) {
                // The answer needs the app (an order, a screen, logging water / a meal / a medicine). Saying it here
                // would claim something that isn't done, so the app is brought forward instead: that wakes its web
                // view, which then receives this same command and handles it the usual way (questions included).
                Log.i(TAG, "command needs the app: opening AURA");
                overlay.setStatus("Opening AURA…", false);
                replyDeadline = android.os.SystemClock.uptimeMillis() + HANDOFF_MS;
                openMainApp();
                AuraWakePlugin.handOver(id, text);
                return;
            }
            if (error == null && json != null && !json.optString("say", "").trim().isEmpty()) {
                String say = json.optString("say").trim();
                answer(say, say.endsWith("?"), false, false);
            } else if ("not_signed_in".equals(error)) {
                answer("Please open AURA once so I can sign you in again, then ask me.", false, false);
            } else if ("unavailable".equals(error)) {
                // the server answered but its AI couldn't (e.g. the AI account is out of credit)
                answer("AURA's AI isn't available right now, so I can't answer that. Calls, music and opening apps still work.", false, false);
            } else {
                answer("AURA's server isn't answering. It may be waking up, so ask me again in a minute.", false, false);
            }
        });
    }

    /** The app's reply to the command (AuraWakePlugin.reply). */
    void onReply(int id, String say, boolean expectAnswer, boolean openApp) {
        ui.post(() -> {
            if (!inSession || id != requestId || answered) return;   // already answered (e.g. by the server directly)
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
        AuraWakePlugin.handOverDone();
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

    // partial results are guesses that change as more audio arrives: they never start a session
    @Override public void onPartialResult(String hypothesis) { }
    @Override public void onResult(String hypothesis) { check(hypothesis); }
    @Override public void onFinalResult(String hypothesis) { check(hypothesis); }
    @Override public void onError(Exception e) { fail("Wake-word listening stopped: " + e.getMessage()); releaseMic(); }
    @Override public void onTimeout() { }

    @Override
    public void onDestroy() {
        destroyed = true;
        inSession = false;
        afterSpeech = null;
        ui.removeCallbacksAndMessages(null);   // no delayed re-arm, session end or reply may run after this
        if (debugTrigger != null) unregisterReceiver(debugTrigger);
        if (capture != null) capture.cancel();
        if (overlay != null) overlay.hide();
        if (tts != null) tts.shutdown();
        releaseMic();
        if (model != null) model.close();
        model = null;
        if (instance == this) instance = null;
        state = "stopped";
        super.onDestroy();
    }
}
