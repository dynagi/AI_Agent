package com.aura.app;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Holds the one active cart-agent job: which store, whether it runs in the store's app (accessibility
 * service) or website (WebView), the items and their status (pending / added / failed), the recent action
 * history the server needs to avoid repeating itself, and how to reach the AURA backend (API base URL +
 * the user's session token, passed in from the web app). Progress goes to the host running the job and
 * to the Capacitor plugin (which forwards it to the web app).
 */
final class CartJobBridge {

    interface ProgressListener {
        void onProgress(int index, int total, boolean ok, String note);
        void onNeedUser(String message);
        void onDone(int added, int total, String message);
    }

    private static final CartJobBridge INSTANCE = new CartJobBridge();
    private static final int MAX_HISTORY = 30;

    static CartJobBridge getInstance() {
        return INSTANCE;
    }

    String store;
    String startUrl;
    String apiBase;
    String token;
    /** "app" (AuraAccessibilityService drives the installed app) or "web" (CartAssistantActivity). */
    String mode = "web";
    String appPackage;
    /** "history": first read the user's past orders in the store app; then "cart": add the items. */
    String phase = "cart";
    /** false until the server matched the items to the user's usual products (first cart step). */
    boolean resolved = true;
    int ordersRead;
    int ordersKnown;
    /** Past orders to read in the history phase: a quick look before ordering, more for a full sync. */
    int historyLimit = 8;
    private JSONArray items = new JSONArray();
    private JSONArray history = new JSONArray();
    private int step;
    private boolean finished;
    private ProgressListener listener;

    private CartJobBridge() {}

    synchronized void startJob(String store, String startUrl, JSONArray rawItems, String apiBase, String token)
            throws JSONException {
        this.store = store;
        this.startUrl = startUrl;
        this.apiBase = apiBase.replaceAll("/+$", "");
        this.token = token;
        this.items = new JSONArray();
        for (int i = 0; i < rawItems.length(); i++) {
            JSONObject src = rawItems.getJSONObject(i);
            JSONObject it = new JSONObject();
            it.put("name", src.getString("name"));
            it.put("qty", Math.max(1, src.optInt("qty", 1)));
            // extra targeting from the user's history, e.g. "from restaurant Biryani Zest"
            if (!src.isNull("hint")) it.put("hint", src.optString("hint"));
            it.put("status", "pending");
            items.put(it);
        }
        this.history = new JSONArray();
        this.step = 0;
        this.finished = false;
        this.mode = "web";
        this.appPackage = null;
        this.phase = "cart";
        this.resolved = true;
        this.ordersRead = 0;
        this.ordersKnown = 0;
        this.historyLimit = 8;
    }

    /** The server matched the items to the user's usual products (set_items): replace names/qty, keep order. */
    synchronized void setItems(JSONArray resolvedItems) throws JSONException {
        JSONArray next = new JSONArray();
        for (int i = 0; i < resolvedItems.length(); i++) {
            JSONObject src = resolvedItems.getJSONObject(i);
            JSONObject it = new JSONObject();
            it.put("name", src.getString("name"));
            it.put("qty", Math.max(1, src.optInt("qty", 1)));
            // extra targeting from the user's history, e.g. "from restaurant Biryani Zest"
            if (!src.isNull("hint")) it.put("hint", src.optString("hint"));
            it.put("status", "pending");
            next.put(it);
        }
        if (next.length() > 0) items = next;
        resolved = true;
    }

    synchronized void historyDone() {
        phase = "cart";
    }

    synchronized void addOrdersRead(int n) {
        ordersRead += Math.max(0, n);
    }

    synchronized void addOrdersKnown(int n) {
        ordersKnown += Math.max(0, n);
    }

    synchronized int itemCount() {
        return items.length();
    }

    synchronized void setListener(ProgressListener listener) {
        this.listener = listener;
    }

    synchronized boolean isFinished() {
        return finished;
    }

    /** Request body for POST /shopping/agent/step, from a page snapshot taken by agent.js. */
    synchronized JSONObject stepRequest(JSONObject snapshot) throws JSONException {
        step++;
        JSONObject body = new JSONObject();
        body.put("mode", mode);
        body.put("phase", phase);
        body.put("resolved", resolved);
        body.put("ordersRead", ordersRead);
        body.put("ordersKnown", ordersKnown);
        body.put("historyLimit", historyLimit);
        if (appPackage != null) body.put("appPackage", appPackage);
        body.put("store", store);
        body.put("items", new JSONArray(items.toString()));
        body.put("url", snapshot.optString("url"));
        body.put("title", snapshot.optString("title"));
        body.put("elements", snapshot.optJSONArray("elements") != null ? snapshot.getJSONArray("elements") : new JSONArray());
        body.put("pageText", snapshot.optString("pageText"));
        JSONArray recent = new JSONArray();
        for (int i = Math.max(0, history.length() - 12); i < history.length(); i++) recent.put(history.get(i));
        body.put("history", recent);
        body.put("step", step);
        return body;
    }

    synchronized void record(JSONObject rec) throws JSONException {
        JSONObject h = new JSONObject();
        h.put("action", rec.optString("action"));
        h.put("target", rec.optString("target", null));
        h.put("result", rec.optString("result", null));
        h.put("url", rec.optString("url", null));
        history.put(h);
        if (history.length() > MAX_HISTORY) history.remove(0);
    }

    synchronized int currentIndex() {
        for (int i = 0; i < items.length(); i++) {
            if ("pending".equals(items.optJSONObject(i).optString("status"))) return i;
        }
        return -1;
    }

    synchronized void markItem(int index, boolean ok, String note) throws JSONException {
        if (index < 0 || index >= items.length()) index = currentIndex();
        if (index < 0) return;
        JSONObject it = items.getJSONObject(index);
        if (!"pending".equals(it.optString("status"))) return;
        it.put("status", ok ? "added" : "failed");
        it.put("note", note);
        String text = it.optString("name") + (note != null && !note.isEmpty() ? ": " + note : "");
        for (ProgressListener l : listeners()) l.onProgress(index, items.length(), ok, text);
    }

    synchronized void needUser(String message) {
        for (ProgressListener l : listeners()) l.onNeedUser(message);
    }

    synchronized void finish(String message) {
        if (finished) return;
        finished = true;
        int added = 0;
        for (int i = 0; i < items.length(); i++) {
            JSONObject it = items.optJSONObject(i);
            if ("pending".equals(it.optString("status"))) {
                try {
                    it.put("status", "failed");
                    it.put("note", "not reached");
                } catch (JSONException ignored) {
                    // unreachable: plain string values
                }
            }
            if ("added".equals(it.optString("status"))) added++;
        }
        for (ProgressListener l : listeners()) l.onDone(added, items.length(), message);
    }

    private java.util.List<ProgressListener> listeners() {
        java.util.List<ProgressListener> all = new java.util.ArrayList<>();
        if (listener != null) all.add(listener);
        if (AuraCartAssistantPlugin.listener != null && AuraCartAssistantPlugin.listener != listener) {
            all.add(AuraCartAssistantPlugin.listener);
        }
        return all;
    }

    synchronized JSONArray itemsSnapshot() {
        try {
            return new JSONArray(items.toString());
        } catch (JSONException e) {
            return new JSONArray();
        }
    }
}
