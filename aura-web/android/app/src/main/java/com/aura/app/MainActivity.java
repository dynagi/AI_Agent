package com.aura.app;

import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AuraCartAssistantPlugin.class);
        registerPlugin(AuraMedicinePlugin.class);
        registerPlugin(AuraPhonePlugin.class);
        registerPlugin(AuraScreenPlugin.class);
        registerPlugin(AuraSpeechPlugin.class);
        registerPlugin(AuraWakePlugin.class);
        super.onCreate(savedInstanceState);
        keepWebViewAwake();
    }

    /**
     * AURA's logic (answering "Hey Aura" commands that need the server) runs in this web view, also while the app is
     * in the background. By default Android drops the web view's process to the lowest priority once the app is not
     * on screen, and then freezes or kills it, so a command sent to it gets no answer. This keeps the web view at the
     * app's own priority: high while the "Hey Aura" service runs, normal otherwise.
     */
    private void keepWebViewAwake() {
        if (Build.VERSION.SDK_INT < 26 || getBridge() == null) return;
        WebView webView = getBridge().getWebView();
        if (webView != null) webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
    }
}
