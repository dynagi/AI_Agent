package com.aura.app;

import android.Manifest;
import android.content.Intent;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * JS side of "Hey Aura" (WakeWordService). start() asks for the microphone (and, on Android 13+, notification)
 * permission and starts the background listener; the "wake" event fires when the phrase is heard. The web app
 * calls pause() before it uses the microphone itself and resume() when it is done. See src/services/wake.ts.
 */
@CapacitorPlugin(name = "AuraWake", permissions = {
        @Permission(alias = "microphone", strings = {Manifest.permission.RECORD_AUDIO}),
        @Permission(alias = "notifications", strings = {Manifest.permission.POST_NOTIFICATIONS})
})
public class AuraWakePlugin extends Plugin {

    private static AuraWakePlugin instance;
    /** The web app has taken the microphone (so the service must not re-arm by itself). */
    static volatile boolean appHolding;

    @Override
    public void load() {
        instance = this;
    }

    /**
     * The service heard a command after the wake phrase: hand its text to AURA's logic in the web view. False when
     * the app isn't loaded in this process (it was swiped away), so there is nothing to answer it.
     */
    static boolean fireCommand(int id, String text) {
        AuraWakePlugin p = instance;
        if (p == null || p.getBridge() == null || p.getBridge().getWebView() == null) return false;
        JSObject data = new JSObject();
        data.put("id", id);
        data.put("text", text);
        p.notifyListeners("wakeCommand", data, false);
        return true;
    }

    /** The web app's answer to a wakeCommand: shown in the overlay and spoken by the service. */
    @PluginMethod
    public void reply(PluginCall call) {
        WakeWordService s = WakeWordService.instance;
        if (s != null) {
            s.onReply(call.getInt("id", -1), call.getString("say", ""),
                    Boolean.TRUE.equals(call.getBoolean("expectAnswer", false)),
                    Boolean.TRUE.equals(call.getBoolean("openApp", false)));
        }
        call.resolve();
    }

    /** The server's address, for the wake-up call WakeWordService makes when it hears the wake phrase. */
    static volatile String apiUrl;

    @PluginMethod
    public void configure(PluginCall call) {
        String url = call.getString("apiUrl", "");
        apiUrl = url == null || url.trim().isEmpty() ? null : url.trim().replaceAll("/+$", "");
        call.resolve();
    }

    /** Opens "Display over other apps" for AURA (only needed when the accessibility service is off). */
    @PluginMethod
    public void requestOverlayPermission(PluginCall call) {
        Intent intent = new Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                android.net.Uri.parse("package:" + getContext().getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void start(PluginCall call) {
        boolean needNotif = Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED;
        if (getPermissionState("microphone") != PermissionState.GRANTED || needNotif) {
            requestPermissionForAliases(Build.VERSION.SDK_INT >= 33 ? new String[]{"microphone", "notifications"}
                    : new String[]{"microphone"}, call, "permissionResult");
            return;
        }
        begin(call);
    }

    @PermissionCallback
    private void permissionResult(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            call.reject("Microphone permission is needed for \"Hey Aura\".");
            return;
        }
        begin(call);
    }

    private void begin(PluginCall call) {
        try {
            ContextCompat.startForegroundService(getContext(), new Intent(getContext(), WakeWordService.class));
            call.resolve(status());
        } catch (Exception e) {
            call.reject("Could not start \"Hey Aura\": " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), WakeWordService.class));
        appHolding = false;
        call.resolve();
    }

    @PluginMethod
    public void pause(PluginCall call) {
        appHolding = true;
        WakeWordService s = WakeWordService.instance;
        if (s != null) s.pause();
        call.resolve();
    }

    @PluginMethod
    public void resume(PluginCall call) {
        appHolding = false;
        WakeWordService s = WakeWordService.instance;
        if (s != null) s.resume();
        call.resolve();
    }

    /** What the assistant can do on this phone right now: {capability: {state, reason}} (see Capabilities). */
    @PluginMethod
    public void capabilities(PluginCall call) {
        JSObject all = new JSObject();
        for (Capabilities.Capability c : Capabilities.Capability.values()) {
            Capabilities.Info info = Capabilities.check(getContext(), c);
            JSObject o = new JSObject();
            o.put("state", info.state.name());
            o.put("reason", info.reason);
            all.put(c.name(), o);
        }
        call.resolve(all);
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(status());
    }

    private JSObject status() {
        JSObject o = new JSObject();
        o.put("running", WakeWordService.instance != null);
        o.put("state", WakeWordService.state);
        o.put("error", WakeWordService.error);
        // how the assistant panel can be drawn over other apps: "accessibility", "overlay", or null (voice only)
        o.put("surface", AssistantOverlay.surface(getContext()));
        return o;
    }
}
