package com.aura.app;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Where the screen assistant sends what it sees (screen elements, a screenshot) and what it gets back. The web app
 * tells the phone the AURA server address and the user's session token (AuraScreenPlugin.configure) whenever they
 * change; the token is kept in memory only. Without it the assistant says to open AURA once.
 */
final class ScreenApi {

    private static volatile String apiBase;
    private static volatile String token;
    private static final ExecutorService network = Executors.newSingleThreadExecutor();

    private ScreenApi() { }

    static void configure(String base, String sessionToken) {
        apiBase = base == null ? null : base.replaceAll("/+$", "");
        token = sessionToken;
    }

    static boolean ready() {
        return apiBase != null && !apiBase.isEmpty() && token != null && !token.isEmpty();
    }

    interface Callback {
        /** On the main thread. `error` is null on success. */
        void onResult(JSONObject json, String error);
    }

    /** One question to AURA's chat brain (the same one the app uses); the reply is {"say": ..., "do": [...]}. */
    static void converse(String message, Callback cb) {
        try {
            post("/chat/converse", new JSONObject().put("message", message), cb);
        } catch (JSONException e) {
            cb.onResult(null, "bad_request");
        }
    }

    static void step(JSONObject body, Callback cb) {
        post("/screen/step", body, cb);
    }

    static void visualSearch(String imageBase64, String hint, Callback cb) {
        try {
            post("/screen/visual-search", new JSONObject().put("image", imageBase64).put("hint", hint == null ? "" : hint), cb);
        } catch (JSONException e) {
            cb.onResult(null, "bad_request");
        }
    }

    private static void post(String path, JSONObject body, Callback cb) {
        final String base = apiBase, tok = token;
        final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());
        if (base == null || tok == null) {
            main.post(() -> cb.onResult(null, "not_signed_in"));
            return;
        }
        network.execute(() -> {
            JSONObject out = null;
            String error = null;
            try {
                out = AgentHttp.post(base + path, tok, body);
            } catch (IOException e) {
                String m = String.valueOf(e.getMessage());
                error = m.contains("401") || m.contains("403") ? "not_signed_in" : m.contains("HTTP 503") ? "unavailable" : "network";
            } catch (JSONException e) {
                error = "bad_response";
            }
            final JSONObject result = out;
            final String err = error;
            main.post(() -> cb.onResult(result, err));
        });
    }
}
