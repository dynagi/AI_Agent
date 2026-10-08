package com.aura.app;

import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * JS side of the screen assistant (see ScreenAgent), YouTube ad skipping (AdSkipper) and habit learning
 * (ActivityLearner). The web app gives the phone the AURA server address and the user's session token with
 * configure(); everything else is switches and reading back what was learned. See src/native/screen.ts.
 */
@CapacitorPlugin(name = "AuraScreen")
public class AuraScreenPlugin extends Plugin {

    private static AuraScreenPlugin instance;
    private static JSONObject pendingVisual;

    @Override
    public void load() {
        instance = this;
    }

    /**
     * A product was found on the user's screen: keep it for the web app (which shows it in Shopping) and tell the
     * web app now if it is running. The web app ignores a result it has already shown (same "at").
     */
    static void offerVisual(JSONObject result) {
        try {
            result.put("at", System.currentTimeMillis());
        } catch (JSONException ignored) {
            // the timestamp only lets the app tell results apart
        }
        pendingVisual = result;
        AuraScreenPlugin p = instance;
        if (p == null || p.getBridge() == null) return;
        try {
            p.notifyListeners("visualSearch", new JSObject(result.toString()), true);
        } catch (JSONException ignored) {
            // takeVisual() still has it
        }
    }

    /** The AURA server address and the user's session token, for the assistant's calls. The token stays in memory. */
    @PluginMethod
    public void configure(PluginCall call) {
        ScreenApi.configure(call.getString("apiBase"), call.getString("token"));
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        boolean access = AuraAccessibilityService.instance != null;
        JSObject o = new JSObject();
        o.put("accessibility", access);
        o.put("screenshot", access && Build.VERSION.SDK_INT >= 30);
        o.put("learning", ActivityLearner.enabled(getContext()));
        o.put("autoSkipAds", AdSkipper.enabled(getContext()));
        o.put("androidSdk", Build.VERSION.SDK_INT);
        call.resolve(o);
    }

    @PluginMethod
    public void setAutoSkipAds(PluginCall call) {
        AdSkipper.setEnabled(getContext(), Boolean.TRUE.equals(call.getBoolean("enabled", true)));
        call.resolve();
    }

    @PluginMethod
    public void setLearning(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        ActivityLearner.setEnabled(getContext(), on);
        if (!on) ActivityLearner.flush(getContext());
        call.resolve();
    }

    /** What has been learned: top apps, actions, people and topics, plus the name-free habits sentence. */
    @PluginMethod
    public void learned(PluginCall call) {
        try {
            JSONObject s = ActivityLearner.summary(getContext(), 6);
            s.put("habits", ActivityLearner.habits(getContext()));
            call.resolve(new JSObject(s.toString()));
        } catch (JSONException e) {
            call.reject("Could not read what AURA learned.");
        }
    }

    /** Wipes everything learned. */
    @PluginMethod
    public void forgetLearned(PluginCall call) {
        ActivityLearner.forget(getContext());
        call.resolve();
    }

    /** The product matches from the latest "find this", once; null when there is none waiting. */
    @PluginMethod
    public void takeVisual(PluginCall call) {
        JSONObject v = pendingVisual;
        pendingVisual = null;
        JSObject o = new JSObject();
        try {
            if (v != null) o.put("visual", new JSObject(v.toString()));
        } catch (JSONException ignored) {
            // nothing to hand over
        }
        call.resolve(o);
    }
}
