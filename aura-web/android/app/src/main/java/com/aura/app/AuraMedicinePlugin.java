package com.aura.app;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * JS side of medicine reminders and pharmacy hand-off (see
 * aura-web/src/native/medicine.ts). The plugin never pays for or places an
 * order — openPharmacy only launches the pharmacy's own app or website.
 */
@CapacitorPlugin(name = "AuraMedicine")
public class AuraMedicinePlugin extends Plugin {

    @Override
    public void load() {
        MedicineScheduler.liveListener = (id, action, at) -> {
            JSObject data = new JSObject();
            data.put("id", id);
            data.put("action", action);
            data.put("at", at);
            notifyListeners("doseAction", data);
        };
    }

    @Override
    protected void handleOnDestroy() {
        MedicineScheduler.liveListener = null;
    }

    @PluginMethod
    public void scheduleReminders(PluginCall call) {
        JSArray doses = call.getArray("doses");
        MedicineScheduler.schedule(getContext(), doses != null ? doses : new JSArray());
        call.resolve();
    }

    @PluginMethod
    public void drainActions(PluginCall call) {
        JSObject res = new JSObject();
        res.put("actions", MedicineScheduler.drainActions(getContext()));
        call.resolve(res);
    }

    @PluginMethod
    public void notificationsEnabled(PluginCall call) {
        call.resolve(enabledResult());
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33
                && getContext().checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            // The result arrives asynchronously; the web side re-checks notificationsEnabled when the app regains focus.
            ActivityCompat.requestPermissions(getActivity(), new String[]{Manifest.permission.POST_NOTIFICATIONS}, 4711);
        }
        call.resolve(enabledResult());
    }

    private JSObject enabledResult() {
        JSObject res = new JSObject();
        res.put("enabled", NotificationManagerCompat.from(getContext()).areNotificationsEnabled());
        return res;
    }

    @PluginMethod
    public void openPharmacy(PluginCall call) {
        String pkg = call.getString("pkg", "");
        String url = call.getString("url", "");
        String copy = call.getString("copy");
        Context c = getContext();
        if (copy != null) {
            ClipboardManager cm = (ClipboardManager) c.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("Medicines", copy));
        }
        JSObject res = new JSObject();
        Intent launch = pkg.isEmpty() ? null : c.getPackageManager().getLaunchIntentForPackage(pkg);
        try {
            if (launch != null) {
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                c.startActivity(launch);
                res.put("opened", "app");
            } else if (!url.isEmpty()) {
                // Android routes verified app links to the installed pharmacy app, else the browser.
                c.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                res.put("opened", "web");
            } else {
                call.reject("No pharmacy app or url given");
                return;
            }
            call.resolve(res);
        } catch (ActivityNotFoundException e) {
            call.reject("Could not open the pharmacy");
        }
    }

    /** Same hand-off as openPharmacy, for any app. */
    @PluginMethod
    public void openApp(PluginCall call) {
        openPharmacy(call);
    }

    @PluginMethod
    public void shareText(PluginCall call) {
        String text = call.getString("text", "");
        Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text);
        Intent chooser = Intent.createChooser(send, "Send medicine list to…");
        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(chooser);
        call.resolve();
    }
}
