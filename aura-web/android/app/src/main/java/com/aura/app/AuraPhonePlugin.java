package com.aura.app;

import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Phone abilities for the voice companion: speak with the phone's own text-to-speech (instant, no network), open any
 * installed app by name, and open the dialer. It can only do what a normal app may do — it cannot read messages or
 * contacts, place a call by itself, or tap inside other apps.
 */
@CapacitorPlugin(name = "AuraPhone")
public class AuraPhonePlugin extends Plugin {

    private TextToSpeech tts;
    private boolean ttsReady = false;
    private final List<Runnable> waitingForTts = new ArrayList<>();

    @Override
    public void load() {
        tts = new TextToSpeech(getContext(), status -> {
            ttsReady = status == TextToSpeech.SUCCESS;
            if (ttsReady) {
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) { }
                    @Override public void onDone(String id) { emitDone(id); }
                    @Override public void onError(String id) { emitDone(id); }
                });
            }
            synchronized (waitingForTts) {
                for (Runnable r : waitingForTts) r.run();
                waitingForTts.clear();
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (tts != null) { tts.stop(); tts.shutdown(); }
    }

    private void emitDone(String id) {
        JSObject data = new JSObject();
        data.put("id", id);
        notifyListeners("speechDone", data);
    }

    /** Speaks `text`; resolves at once and emits "speechDone" {id} when the speech ends (or fails). */
    @PluginMethod
    public void speak(PluginCall call) {
        String id = call.getString("id", "");
        String text = call.getString("text", "");
        String lang = call.getString("lang", "en-IN");
        float rate = call.getFloat("rate", 1.0f);
        Runnable go = () -> {
            if (!ttsReady || text.isEmpty()) { emitDone(id); return; }
            int set = tts.setLanguage(Locale.forLanguageTag(lang));
            if (set == TextToSpeech.LANG_MISSING_DATA || set == TextToSpeech.LANG_NOT_SUPPORTED) tts.setLanguage(Locale.getDefault());
            tts.setSpeechRate(rate);
            Bundle params = new Bundle();
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, id);
        };
        synchronized (waitingForTts) {
            if (tts == null || !ttsReady) { waitingForTts.add(go); } else { go.run(); }
        }
        call.resolve();
    }

    @PluginMethod
    public void stopSpeaking(PluginCall call) {
        if (tts != null) tts.stop();
        call.resolve();
    }

    /** Opens the installed app whose name best matches `name`; otherwise returns the closest names so the user can pick. */
    @PluginMethod
    public void openApp(PluginCall call) {
        String name = norm(call.getString("name", ""));
        if (name.isEmpty()) { call.reject("No app name"); return; }
        name = alias(name);

        PackageManager pm = getContext().getPackageManager();
        Intent main = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> apps = pm.queryIntentActivities(main, 0);

        ResolveInfo best = null;
        int bestScore = 0;
        List<String[]> scored = new ArrayList<>();
        for (ResolveInfo ri : apps) {
            if (ri.activityInfo.packageName.equals(getContext().getPackageName())) continue;
            String label = norm(String.valueOf(ri.loadLabel(pm)));
            int s = score(label, name);
            if (s > 0) scored.add(new String[]{String.valueOf(s), String.valueOf(ri.loadLabel(pm))});
            if (s > bestScore) { bestScore = s; best = ri; }
        }

        JSObject res = new JSObject();
        if (best != null && bestScore >= 2) {
            Intent launch = pm.getLaunchIntentForPackage(best.activityInfo.packageName);
            if (launch != null) {
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(launch);
                res.put("opened", true);
                res.put("label", String.valueOf(best.loadLabel(pm)));
                call.resolve(res);
                return;
            }
        }
        scored.sort((a, b) -> Integer.parseInt(b[0]) - Integer.parseInt(a[0]));
        JSArray suggestions = new JSArray();
        for (int i = 0; i < Math.min(3, scored.size()); i++) suggestions.put(scored.get(i)[1]);
        res.put("opened", false);
        res.put("suggestions", suggestions);
        call.resolve(res);
    }

    /** Opens the dialer with the number filled in. The user presses call. */
    @PluginMethod
    public void dial(PluginCall call) {
        String number = call.getString("number", "").replaceAll("[^0-9+]", "");
        if (number.isEmpty()) { call.reject("No number"); return; }
        getContext().startActivity(new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + number)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        call.resolve();
    }

    static String norm(String s) {
        return s == null ? "" : s.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9 ]", " ").replaceAll("\\s+", " ").trim();
    }

    /** Common spoken names that differ from the app's label. */
    static String alias(String n) {
        switch (n) {
            case "gpay": case "g pay": return "google pay";
            case "insta": return "instagram";
            case "yt": return "youtube";
            case "fb": return "facebook";
            case "phone": case "dialer": case "call": return "phone";
            case "message": case "messages": case "sms": return "messages";
            case "play store": case "playstore": return "play store";
            case "map": return "maps";
            default: return n;
        }
    }

    /** 4 = exact label, 3 = label starts with / is contained in the spoken name, 2 = label contains it, 1 = shares a word. */
    static int score(String label, String q) {
        if (label.isEmpty()) return 0;
        if (label.equals(q)) return 4;
        if (label.startsWith(q) || q.startsWith(label)) return 3;
        if (label.contains(q) || q.contains(label)) return 2;
        for (String w : q.split(" ")) if (w.length() > 2 && label.contains(w)) return 1;
        return 0;
    }
}
