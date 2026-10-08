package com.aura.app;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What AURA has learned about how the user uses their phone: which apps, when, which kinds of actions (like, share,
 * send...), which people they talk to most, and which topics they engage with. Only counters, never a log of events
 * and never the text of anything: no messages, no typed text, no passwords. Everything stays on the phone.
 * Plain Java (plus org.json) so it can be unit tested.
 */
final class ActivityProfile {

    static final int MAX_APPS = 200, MAX_ACTIONS = 400, MAX_CONTACTS = 200, MAX_INTERESTS = 400;
    /** A session longer than this is the phone left on, not use. */
    static final long MAX_SESSION_MS = 30 * 60_000L;
    /** Interest scores fade by this much per day, so what the user likes now outweighs what they liked months ago. */
    static final double DAILY_DECAY = 0.97;

    enum ContactEvent { OPEN, MESSAGE, CALL }

    static final class AppStat {
        int opens;
        long ms;
        long last;
        final int[] hours = new int[24];
    }

    static final class ContactStat {
        int opens, messages, calls;
        long last;
        final int[] hours = new int[24];
    }

    final Map<String, AppStat> apps = new HashMap<>();
    final Map<String, Integer> actions = new HashMap<>();      // "pkg|verb" -> count
    final Map<String, ContactStat> contacts = new HashMap<>(); // a name the user opened a chat with -> counts
    final Map<String, Double> interests = new HashMap<>();     // topic word -> score
    long since;
    long decayedAt;

    ActivityProfile(long now) {
        since = now;
        decayedAt = now;
    }

    // ------------------------------------------------------------------ recording

    void appSession(String pkg, long startMs, long durationMs) {
        if (pkg == null || pkg.isEmpty()) return;
        AppStat a = apps.get(pkg);
        if (a == null) {
            if (apps.size() >= MAX_APPS) dropSmallestApp();
            a = new AppStat();
            apps.put(pkg, a);
        }
        a.opens++;
        a.ms += Math.max(0, Math.min(durationMs, MAX_SESSION_MS));
        a.last = startMs;
        a.hours[hourOf(startMs)]++;
    }

    void action(String pkg, String verb) {
        if (pkg == null || verb == null) return;
        String key = pkg + "|" + verb;
        if (!actions.containsKey(key) && actions.size() >= MAX_ACTIONS) dropSmallest(actions);
        Integer had = actions.get(key);
        actions.put(key, had == null ? 1 : had + 1);
    }

    void contact(String name, ContactEvent what, long now) {
        if (name == null) return;
        String n = name.trim();
        if (n.isEmpty() || n.length() > 40) return;
        ContactStat c = contacts.get(n);
        if (c == null) {
            if (contacts.size() >= MAX_CONTACTS) dropSmallestContact();
            c = new ContactStat();
            contacts.put(n, c);
        }
        switch (what) {
            case OPEN: c.opens++; c.hours[hourOf(now)]++; break;
            case MESSAGE: c.messages++; break;
            default: c.calls++;
        }
        c.last = now;
    }

    void interests(Collection<String> topics, double weight) {
        for (String t : topics) {
            Double had = interests.get(t);
            if (had == null && interests.size() >= MAX_INTERESTS) dropWeakestInterest();
            interests.put(t, (had == null ? 0 : had) + weight);
        }
    }

    /** Fades the interest scores for the days that have passed since the last time; call at load and now and then. */
    void decay(long now) {
        long days = (now - decayedAt) / 86_400_000L;
        if (days <= 0) return;
        double f = Math.pow(DAILY_DECAY, days);
        Iterator<Map.Entry<String, Double>> it = interests.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<String, Double> e = it.next();
            double v = e.getValue() * f;
            if (v < 0.2) it.remove(); else e.setValue(v);
        }
        decayedAt += days * 86_400_000L;
    }

    // ------------------------------------------------------------------ what a tap means

    /**
     * The kind of action a tapped control stands for, from its own label ("Like", "Add comment", "Send"...), or null
     * for anything else. Only these fixed verbs are ever stored, so a tap on a chat row or a message never is.
     */
    static String verbOf(String label) {
        if (label == null) return null;
        String l = label.toLowerCase(Locale.ROOT).trim();
        if (l.isEmpty() || l.length() > 40) return null;
        // "Liked by 4 others", "Unlike", "Following" and "Saved" describe a state, not the tap on Like / Follow / Save
        if (l.matches("^(?:like|love|react)(?: (?:this|post|reel|photo|video|comment))?$")) return "like";
        if (l.matches("^(?:add (?:a )?comment|comment)\\b.*")) return "comment";
        if (l.matches("^(?:share|send (?:to|post)|forward)\\b.*")) return "share";
        if (l.matches("^(?:save|bookmark|add to (?:collection|saved|favou?rites))\\b.*")) return "save";
        if (l.matches("^(?:follow|follow back)$")) return "follow";
        if (l.matches("^(?:subscribe|subscribed)\\b.*")) return "subscribe";
        if (l.matches("^(?:reply|reply to .*)$")) return "reply";
        if (l.matches("^(?:send|send message)$")) return "send";
        if (l.matches("^(?:voice call|call|audio call)\\b.*")) return "call";
        if (l.matches("^video call\\b.*")) return "video_call";
        if (l.matches("^(?:search|search .*)$")) return "search";
        if (l.matches("^(?:add to cart|add to bag|add)$")) return "add_to_cart";
        if (l.matches("^(?:watch later|save to watch later)\\b.*")) return "watch_later";
        return null;
    }

    /** Verbs that say "I like this": the topic words around them are worth learning. */
    static boolean showsInterest(String verb) {
        return "like".equals(verb) || "save".equals(verb) || "share".equals(verb) || "follow".equals(verb)
                || "subscribe".equals(verb) || "comment".equals(verb) || "watch_later".equals(verb);
    }

    static double interestWeight(String verb) {
        switch (verb) {
            case "follow": case "subscribe": return 3;
            case "save": case "share": case "watch_later": return 2;
            default: return 1;
        }
    }

    // ------------------------------------------------------------------ topic words

    private static final Set<String> STOP = new HashSet<>(java.util.Arrays.asList(
            "this", "that", "with", "from", "have", "your", "about", "their", "there", "they", "them", "what", "when", "where",
            "which", "will", "would", "could", "should", "just", "like", "likes", "liked", "more", "most", "very", "much", "some",
            "than", "then", "into", "over", "also", "been", "were", "here", "only", "after", "before", "photo", "photos", "video",
            "videos", "reel", "reels", "story", "stories", "post", "posts", "posted", "comment", "comments", "share", "shares", "send",
            "follow", "following", "followers", "reply", "view", "views", "button", "double", "tap", "ago", "hours", "hour", "minutes",
            "minute", "days", "weeks", "seconds", "audio", "original", "sponsored", "suggested", "profile", "picture", "image",
            "added", "online", "today", "yesterday", "watch", "watching", "play", "pause", "mute", "unmute", "save", "saved", "more",
            "https", "http", "www", "com", "instagram", "youtube", "whatsapp", "page", "feed", "home", "search", "menu", "options"));
    private static final Pattern WORD = Pattern.compile("#?[\\p{L}][\\p{L}0-9]{3,24}");

    /** Up to `max` topic words from a card's text: hashtags first, then plain words that are not interface chatter. */
    static List<String> topics(String text, int max) {
        List<String> out = new ArrayList<>();
        if (text == null) return out;
        Set<String> seen = new HashSet<>();
        Matcher m = WORD.matcher(text.toLowerCase(Locale.ROOT));
        List<String> plain = new ArrayList<>();
        while (m.find()) {
            String w = m.group();
            boolean tag = w.startsWith("#");
            String bare = tag ? w.substring(1) : w;
            if (bare.length() < 4 || STOP.contains(bare) || !seen.add(bare)) continue;
            if (tag) out.add(bare); else plain.add(bare);
        }
        for (String w : plain) if (out.size() < max) out.add(w);
        return out.size() > max ? new ArrayList<>(out.subList(0, max)) : out;
    }

    // ------------------------------------------------------------------ reading it back

    /** A compact picture for the UI, and a short plain-text version that is safe to hand to the assistant. */
    JSONObject summary(int n) throws JSONException {
        JSONObject out = new JSONObject();
        out.put("since", since);

        JSONArray appList = new JSONArray();
        for (Map.Entry<String, AppStat> e : top(apps, n, (a, b) -> Long.compare(b.ms, a.ms))) {
            AppStat a = e.getValue();
            appList.put(new JSONObject().put("pkg", e.getKey()).put("opens", a.opens).put("minutes", a.ms / 60_000)
                    .put("peakHour", peak(a.hours)));
        }
        out.put("apps", appList);

        JSONArray actList = new JSONArray();
        for (Map.Entry<String, Integer> e : top(actions, n, (a, b) -> Integer.compare(b, a))) {
            String[] k = e.getKey().split("\\|", 2);
            actList.put(new JSONObject().put("pkg", k[0]).put("verb", k.length > 1 ? k[1] : "").put("count", e.getValue()));
        }
        out.put("actions", actList);

        JSONArray people = new JSONArray();
        for (Map.Entry<String, ContactStat> e : top(contacts, n, (a, b) -> Integer.compare(b.opens + b.messages + b.calls, a.opens + a.messages + a.calls))) {
            ContactStat c = e.getValue();
            people.put(new JSONObject().put("name", e.getKey()).put("opens", c.opens).put("messages", c.messages)
                    .put("calls", c.calls).put("peakHour", peak(c.hours)));
        }
        out.put("contacts", people);

        JSONArray topics = new JSONArray();
        for (Map.Entry<String, Double> e : top(interests, n * 2, (a, b) -> Double.compare(b, a))) topics.put(e.getKey());
        out.put("interests", topics);
        return out;
    }

    /**
     * One or two sentences about habits for the assistant's context. Contains no names of people and no message
     * text: app labels come from `labels` (package -> name), topics are the user's own interest words.
     */
    String habits(Map<String, String> labels, int n) {
        StringBuilder sb = new StringBuilder();
        List<String> used = new ArrayList<>();
        for (Map.Entry<String, AppStat> e : top(apps, n, (a, b) -> Long.compare(b.ms, a.ms))) {
            if (e.getValue().ms < 60_000) continue;
            String label = labels.get(e.getKey());
            if (label != null) used.add(label + " (" + Math.max(1, e.getValue().ms / 60_000) + " min, mostly around " + peak(e.getValue().hours) + ":00)");
        }
        if (!used.isEmpty()) sb.append("Most used apps: ").append(join(used)).append(". ");
        List<String> likes = new ArrayList<>();
        for (Map.Entry<String, Double> e : top(interests, 8, (a, b) -> Double.compare(b, a))) likes.add(e.getKey());
        if (!likes.isEmpty()) sb.append("Topics they engage with: ").append(join(likes)).append(".");
        return sb.toString().trim();
    }

    // ------------------------------------------------------------------ saving

    JSONObject toJson() throws JSONException {
        JSONObject o = new JSONObject();
        o.put("since", since).put("decayedAt", decayedAt);
        JSONObject a = new JSONObject();
        for (Map.Entry<String, AppStat> e : apps.entrySet()) {
            AppStat s = e.getValue();
            a.put(e.getKey(), new JSONObject().put("opens", s.opens).put("ms", s.ms).put("last", s.last).put("hours", ints(s.hours)));
        }
        o.put("apps", a);
        JSONObject ac = new JSONObject();
        for (Map.Entry<String, Integer> e : actions.entrySet()) ac.put(e.getKey(), e.getValue());
        o.put("actions", ac);
        JSONObject c = new JSONObject();
        for (Map.Entry<String, ContactStat> e : contacts.entrySet()) {
            ContactStat s = e.getValue();
            c.put(e.getKey(), new JSONObject().put("opens", s.opens).put("messages", s.messages).put("calls", s.calls)
                    .put("last", s.last).put("hours", ints(s.hours)));
        }
        o.put("contacts", c);
        JSONObject i = new JSONObject();
        for (Map.Entry<String, Double> e : interests.entrySet()) i.put(e.getKey(), Math.round(e.getValue() * 100) / 100.0);
        o.put("interests", i);
        return o;
    }

    static ActivityProfile fromJson(JSONObject o, long now) {
        ActivityProfile p = new ActivityProfile(o.optLong("since", now));
        p.decayedAt = o.optLong("decayedAt", now);
        JSONObject a = o.optJSONObject("apps");
        if (a != null) for (Iterator<String> it = a.keys(); it.hasNext(); ) {
            String k = it.next();
            JSONObject s = a.optJSONObject(k);
            if (s == null) continue;
            AppStat st = new AppStat();
            st.opens = s.optInt("opens");
            st.ms = s.optLong("ms");
            st.last = s.optLong("last");
            fill(st.hours, s.optJSONArray("hours"));
            p.apps.put(k, st);
        }
        JSONObject ac = o.optJSONObject("actions");
        if (ac != null) for (Iterator<String> it = ac.keys(); it.hasNext(); ) {
            String k = it.next();
            p.actions.put(k, ac.optInt(k));
        }
        JSONObject c = o.optJSONObject("contacts");
        if (c != null) for (Iterator<String> it = c.keys(); it.hasNext(); ) {
            String k = it.next();
            JSONObject s = c.optJSONObject(k);
            if (s == null) continue;
            ContactStat st = new ContactStat();
            st.opens = s.optInt("opens");
            st.messages = s.optInt("messages");
            st.calls = s.optInt("calls");
            st.last = s.optLong("last");
            fill(st.hours, s.optJSONArray("hours"));
            p.contacts.put(k, st);
        }
        JSONObject i = o.optJSONObject("interests");
        if (i != null) for (Iterator<String> it = i.keys(); it.hasNext(); ) {
            String k = it.next();
            p.interests.put(k, i.optDouble(k));
        }
        p.decay(now);
        return p;
    }

    // ------------------------------------------------------------------ helpers

    static int hourOf(long ms) {
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(ms);
        return c.get(Calendar.HOUR_OF_DAY);
    }

    /** String.join needs Android 8; the app supports Android 5.1. */
    private static String join(List<String> parts) {
        StringBuilder sb = new StringBuilder();
        for (String p : parts) sb.append(sb.length() == 0 ? "" : ", ").append(p);
        return sb.toString();
    }

    private static int peak(int[] hours) {
        int best = 0;
        for (int h = 1; h < 24; h++) if (hours[h] > hours[best]) best = h;
        return best;
    }

    private static JSONArray ints(int[] a) throws JSONException {
        JSONArray j = new JSONArray();
        for (int v : a) j.put(v);
        return j;
    }

    private static void fill(int[] into, JSONArray from) {
        if (from == null) return;
        for (int h = 0; h < 24 && h < from.length(); h++) into[h] = from.optInt(h);
    }

    private static <V> List<Map.Entry<String, V>> top(Map<String, V> m, int n, java.util.Comparator<V> order) {
        List<Map.Entry<String, V>> all = new ArrayList<>(m.entrySet());
        java.util.Collections.sort(all, (x, y) -> order.compare(x.getValue(), y.getValue()));
        return all.size() > n ? new ArrayList<>(all.subList(0, n)) : all;
    }

    private void dropSmallestApp() {
        String worst = null;
        for (Map.Entry<String, AppStat> e : apps.entrySet()) if (worst == null || e.getValue().ms < apps.get(worst).ms) worst = e.getKey();
        if (worst != null) apps.remove(worst);
    }

    private void dropSmallestContact() {
        String worst = null;
        int low = Integer.MAX_VALUE;
        for (Map.Entry<String, ContactStat> e : contacts.entrySet()) {
            ContactStat c = e.getValue();
            int total = c.opens + c.messages + c.calls;
            if (total < low) { low = total; worst = e.getKey(); }
        }
        if (worst != null) contacts.remove(worst);
    }

    private void dropWeakestInterest() {
        String worst = null;
        for (Map.Entry<String, Double> e : interests.entrySet()) if (worst == null || e.getValue() < interests.get(worst)) worst = e.getKey();
        if (worst != null) interests.remove(worst);
    }

    private static void dropSmallest(Map<String, Integer> m) {
        String worst = null;
        for (Map.Entry<String, Integer> e : m.entrySet()) if (worst == null || e.getValue() < m.get(worst)) worst = e.getKey();
        if (worst != null) m.remove(worst);
    }
}
