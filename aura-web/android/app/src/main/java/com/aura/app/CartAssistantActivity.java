package com.aura.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Pattern;

/**
 * Runs the AURA cart agent: a WebView on the real store website (the user's own login; AURA never
 * reads or stores those credentials) driven step by step. agent.js snapshots the page, this activity
 * sends the snapshot to the AURA backend (POST /shopping/agent/step), and the returned action is
 * executed in the page. Works for any store: the server decides each step from what is on screen.
 *
 * It fills the cart and stops. Payment is not automated: safety.js refuses payment/checkout clicks,
 * the server refuses to choose them, and shouldOverrideUrlLoading() below blocks payment-looking URLs.
 * If the site needs the user (login, OTP, delivery address, captcha) the agent pauses and shows
 * "Continue", which resumes it once the user has dealt with it.
 */
public class CartAssistantActivity extends Activity implements CartJobBridge.ProgressListener {

    private static final Pattern FORBIDDEN_URL =
            Pattern.compile("(?i)(pay|checkout|place.?order|confirm.?order|payment|upi|/buy/)");
    private static final int MAX_NETWORK_RETRIES = 2;

    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final AtomicInteger latestRequest = new AtomicInteger();
    private WebView webView;
    private TextView status;
    private Button continueButton;
    private Button finishButton;
    private int networkFailures;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        CartJobBridge job = CartJobBridge.getInstance();

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        LinearLayout topBar = new LinearLayout(this);
        topBar.setOrientation(LinearLayout.HORIZONTAL);
        topBar.setGravity(Gravity.CENTER_VERTICAL);
        topBar.setBackgroundColor(Color.parseColor("#0b0f1a"));
        topBar.setPadding(24, 20, 24, 20);

        status = new TextView(this);
        status.setText("AURA is filling your " + job.store + " cart…");
        status.setTextColor(Color.WHITE);
        status.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        continueButton = new Button(this);
        continueButton.setText("Continue");
        continueButton.setVisibility(View.GONE);
        continueButton.setOnClickListener(v -> resume());

        Button closeButton = new Button(this);
        closeButton.setText("Stop");
        closeButton.setOnClickListener(v -> {
            job.finish("Stopped by you.");
            finish();
        });

        topBar.addView(status);
        topBar.addView(continueButton);
        topBar.addView(closeButton);

        finishButton = new Button(this);
        finishButton.setText("Done — back to AURA");
        finishButton.setVisibility(View.GONE);
        finishButton.setOnClickListener(v -> finish());

        webView = new WebView(this);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.addJavascriptInterface(new JsBridge(), "AuraNative");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme() == null ? "" : uri.getScheme();
                if (!scheme.startsWith("http")) {
                    return true; // intent://, upi://, tel: ... never leave the WebView on the agent's behalf
                }
                if (FORBIDDEN_URL.matcher(uri.getPath() + "?" + uri.getQuery()).find()) {
                    Toast.makeText(CartAssistantActivity.this,
                            "AURA stops at the cart — payment isn't automated.", Toast.LENGTH_LONG).show();
                    job.finish("Reached checkout; stopped before payment.");
                    return true;
                }
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (!job.isFinished()) injectAgent(view);
            }
        });

        root.addView(topBar);
        root.addView(webView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        root.addView(finishButton);
        setContentView(root);

        job.setListener(this);
        webView.loadUrl(job.startUrl);
    }

    private void injectAgent(WebView view) {
        view.evaluateJavascript(readAsset("aura-cart/safety.js"), null);
        view.evaluateJavascript(readAsset("aura-cart/agent.js"), null);
    }

    private void resume() {
        continueButton.setVisibility(View.GONE);
        status.setText("Continuing…");
        networkFailures = 0;
        webView.evaluateJavascript("window.__auraStep && window.__auraStep('continuing')", null);
    }

    /** POSTs the snapshot to the backend off the UI thread and applies the answer on the page. */
    private void requestStep(String snapshotJson) {
        final int requestId = latestRequest.incrementAndGet();
        network.execute(() -> {
            CartJobBridge job = CartJobBridge.getInstance();
            try {
                JSONObject snapshot = new JSONObject(snapshotJson);
                String nonce = snapshot.optString("nonce");
                JSONObject action = AgentHttp.nextStep(job, job.stepRequest(snapshot));
                networkFailures = 0;
                if (requestId != latestRequest.get() || job.isFinished()) return; // a newer page took over
                ui.post(() -> handleAction(action, nonce));
            } catch (Exception e) {
                ui.post(() -> {
                    networkFailures++;
                    if (networkFailures > MAX_NETWORK_RETRIES) {
                        onNeedUser("Can't reach AURA (" + e.getMessage() + "). Check your connection, then tap Continue.");
                    } else {
                        webView.evaluateJavascript("window.__auraStep && window.__auraStep('retrying')", null);
                    }
                });
            }
        });
    }

    private void handleAction(JSONObject action, String nonce) {
        CartJobBridge job = CartJobBridge.getInstance();
        String type = action.optString("action");
        String reason = action.optString("reason", "");
        try {
            job.addOrdersRead(action.optInt("ordersSaved", 0));
            job.addOrdersKnown(action.optInt("ordersKnown", 0));
            switch (type) {
                case "history_done":  // order history is only read in the store's app, not on websites
                    job.historyDone();
                    webView.evaluateJavascript("window.__auraStep && window.__auraStep('adding items')", null);
                    return;
                case "set_items": {
                    org.json.JSONArray resolvedItems = action.optJSONArray("items");
                    job.setItems(resolvedItems != null ? resolvedItems : new org.json.JSONArray());
                    webView.evaluateJavascript("window.__auraStep && window.__auraStep(" + JSONObject.quote(reason) + ")", null);
                    return;
                }
                case "item_done":
                    job.markItem(action.optInt("itemIndex", -1), action.optBoolean("itemOk", true), reason);
                    webView.evaluateJavascript("window.__auraStep && window.__auraStep(" + JSONObject.quote(reason) + ")", null);
                    return;
                case "need_user":
                    job.needUser(action.optString("message", "AURA needs you to do something on this page."));
                    return;
                case "done":
                    job.finish(action.optString("message", "Finished."));
                    return;
                default:
                    status.setText(reason.isEmpty() ? type : reason);
                    webView.evaluateJavascript("window.__auraApply && window.__auraApply("
                            + JSONObject.quote(action.toString()) + "," + JSONObject.quote(nonce) + ")", null);
            }
        } catch (JSONException e) {
            job.finish("Stopped: " + e.getMessage());
        }
    }

    private String readAsset(String path) {
        StringBuilder sb = new StringBuilder();
        try (InputStream is = getAssets().open(path);
             BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) sb.append(line).append('\n');
        } catch (IOException e) {
            return "";
        }
        return sb.toString();
    }

    // ---- progress, forwarded to the web app through the plugin ----
    @Override
    public void onProgress(int index, int total, boolean ok, String note) {
        ui.post(() -> status.setText((ok ? "Added " : "Couldn't add ") + note));
    }

    @Override
    public void onNeedUser(String message) {
        ui.post(() -> {
            status.setText(message);
            continueButton.setVisibility(View.VISIBLE);
        });
    }

    @Override
    public void onDone(int added, int total, String message) {
        ui.post(() -> {
            status.setText("Cart ready: " + added + "/" + total + " items added. " + message);
            continueButton.setVisibility(View.GONE);
            finishButton.setVisibility(View.VISIBLE);
            webView.evaluateJavascript("window.__auraStatus && window.__auraStatus('cart ready — payment is up to you')", null);
        });
    }

    @Override
    protected void onDestroy() {
        CartJobBridge.getInstance().finish("Closed.");
        network.shutdownNow();
        super.onDestroy();
    }

    /** Exposed to agent.js as window.AuraNative. Called on a WebView binder thread. */
    private class JsBridge {
        @JavascriptInterface
        public void requestStep(String snapshotJson) {
            if (!CartJobBridge.getInstance().isFinished()) CartAssistantActivity.this.requestStep(snapshotJson);
        }

        @JavascriptInterface
        public void record(String json) {
            try {
                CartJobBridge.getInstance().record(new JSONObject(json));
            } catch (JSONException ignored) {
                // malformed record from the page: skip it, the server just sees a shorter history
            }
        }
    }
}
