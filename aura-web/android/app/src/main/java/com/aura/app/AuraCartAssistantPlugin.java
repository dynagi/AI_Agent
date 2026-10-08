package com.aura.app;

import android.content.Intent;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;

/**
 * JS-facing side of the cart agent. The web app calls
 * startQuickCart({store, startUrl, items, apiBase, token, androidPackage?, appLabel?, mode?}).
 *
 * mode "auto" (default): if the store's app is installed and AURA's accessibility access is on, the agent
 * drives the real app (AuraAccessibilityService); if the app is installed but access is off, nothing starts
 * and the result says needsAccessibility (the web app then offers openAccessibilitySettings or the website);
 * if the app isn't installed, it uses the store's website in a WebView (CartAssistantActivity).
 * mode "app" / "web" force one of the two.
 *
 * Progress comes back as "quickCartProgress" / "quickCartNeedUser" / "quickCartDone" events
 * (see aura-web/src/native/cartAssistant.ts). The store logins stay in the store's app / WebView; the AURA
 * session token passed in is only used to call the AURA backend.
 */
@CapacitorPlugin(name = "AuraCartAssistant")
public class AuraCartAssistantPlugin extends Plugin implements CartJobBridge.ProgressListener {

    /** Set on load; CartJobBridge forwards every job's progress here. */
    static CartJobBridge.ProgressListener listener;

    @Override
    public void load() {
        listener = this;
    }

    @PluginMethod
    public void startQuickCart(PluginCall call) {
        String store = call.getString("store");
        String startUrl = call.getString("startUrl");
        String apiBase = call.getString("apiBase");
        String token = call.getString("token", "");
        String mode = call.getString("mode", "auto");
        JSArray itemsArray = call.getArray("items");

        boolean syncHistory = Boolean.TRUE.equals(call.getBoolean("syncHistory", false));
        boolean resolvedItems = !Boolean.FALSE.equals(call.getBoolean("resolved", true));
        if (store == null || apiBase == null || itemsArray == null || (itemsArray.length() == 0 && !syncHistory)) {
            call.reject("store, apiBase and items (or syncHistory) are required");
            return;
        }
        String appPackage = "web".equals(mode) ? null : AuraAccessibilityService.findStoreApp(
                getContext(), call.getString("androidPackage"), call.getString("appLabel"), store);
        boolean accessOn = AuraAccessibilityService.isEnabled(getContext());

        JSObject result = new JSObject();
        result.put("appInstalled", appPackage != null);
        result.put("accessibilityEnabled", accessOn);

        if (appPackage != null && !accessOn) {
            result.put("started", false);
            result.put("mode", "app");
            result.put("needsAccessibility", true);
            call.resolve(result);
            return;
        }
        if (appPackage == null && "app".equals(mode)) {
            call.reject(store + " app isn't installed on this phone.");
            return;
        }
        boolean useApp = appPackage != null && AuraAccessibilityService.instance != null;
        if (!useApp && (startUrl == null || !startUrl.startsWith("https://"))) {
            call.reject("startUrl must be https");
            return;
        }
        try {
            CartJobBridge job = CartJobBridge.getInstance();
            job.startJob(store, startUrl, itemsArray, apiBase, token);
            if (useApp) {
                job.mode = "app";
                job.appPackage = appPackage;
                job.phase = syncHistory ? "history" : "cart";  // past orders can only be read in the app
            }
            job.resolved = resolvedItems;
            job.historyLimit = Math.max(1, Math.min(call.getInt("historyLimit", 8), 40));
        } catch (JSONException e) {
            call.reject("items must be [{name, qty}]: " + e.getMessage());
            return;
        }

        if (useApp) {
            AuraAccessibilityService.instance.startJob();
        } else {
            getActivity().startActivity(new Intent(getContext(), CartAssistantActivity.class));
        }
        result.put("started", true);
        result.put("mode", useApp ? "app" : "web");
        if (useApp) result.put("appPackage", appPackage);
        call.resolve(result);
    }

    /** Whether app mode is possible for a store: is its app installed, is AURA's accessibility access on. */
    @PluginMethod
    public void cartAgentStatus(PluginCall call) {
        String appPackage = AuraAccessibilityService.findStoreApp(getContext(), call.getString("androidPackage"),
                call.getString("appLabel"), call.getString("store"));
        JSObject result = new JSObject();
        result.put("appInstalled", appPackage != null);
        result.put("appPackage", appPackage);
        result.put("accessibilityEnabled", AuraAccessibilityService.isEnabled(getContext()));
        call.resolve(result);
    }

    /** Opens Settings > Accessibility so the user can turn AURA on (one time). */
    @PluginMethod
    public void openAccessibilitySettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @Override
    public void onProgress(int index, int total, boolean ok, String note) {
        JSObject data = new JSObject();
        data.put("index", index);
        data.put("total", total);
        data.put("ok", ok);
        data.put("note", note);
        notifyListeners("quickCartProgress", data);
    }

    @Override
    public void onNeedUser(String message) {
        JSObject data = new JSObject();
        data.put("message", message);
        notifyListeners("quickCartNeedUser", data);
    }

    @Override
    public void onDone(int added, int total, String message) {
        JSObject data = new JSObject();
        data.put("added", added);
        data.put("total", total);
        data.put("message", message);
        data.put("items", CartJobBridge.getInstance().itemsSnapshot());
        notifyListeners("quickCartDone", data);
    }
}
