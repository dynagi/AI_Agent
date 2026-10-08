package com.aura.app;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Finds which saved contacts a spoken name means. Plain Java (no Android classes) so it can be unit tested.
 * It never guesses between people: every contact that matches equally well is returned, and the caller asks.
 */
final class ContactMatcher {

    static final class Entry {
        final long id;
        final String name;
        final String number;
        final boolean primary;   // the user marked this number as the contact's default
        final boolean mobile;

        Entry(long id, String name, String number, boolean primary, boolean mobile) {
            this.id = id;
            this.name = name;
            this.number = number;
            this.primary = primary;
            this.mobile = mobile;
        }
    }

    private ContactMatcher() { }

    static String norm(String s) {
        return s == null ? "" : s.toLowerCase(Locale.ROOT).replaceAll("[^\\p{L}\\p{N} ]", " ").replaceAll("\\s+", " ").trim();
    }

    /** The last ten digits: the same number written with or without a country code compares equal. */
    static String tail(String number) {
        String d = number == null ? "" : number.replaceAll("\\D", "");
        return d.length() > 10 ? d.substring(d.length() - 10) : d;
    }

    /** 4 = the whole name, 3 = every spoken word is a word of the name, 2 = a word of the name starts with it, 0 = no. */
    static int score(String name, String spoken) {
        String n = norm(name);
        String q = norm(spoken);
        if (n.isEmpty() || q.isEmpty()) return 0;
        if (n.equals(q)) return 4;
        List<String> words = java.util.Arrays.asList(n.split(" "));
        boolean all = true;
        for (String w : q.split(" ")) all = all && words.contains(w);
        if (all) return 3;
        if (!q.contains(" ") && q.length() >= 3) {
            for (String w : words) if (w.startsWith(q)) return 2;
        }
        return 0;
    }

    /**
     * The contacts that best match `spoken`, one entry per person (their default number, else a mobile, else the
     * first). Empty when nobody matches. A contact saved as exactly the spoken name wins over longer names.
     */
    static List<Entry> match(List<Entry> all, String spoken) {
        int best = 0;
        for (Entry e : all) best = Math.max(best, score(e.name, spoken));
        Map<String, Entry> people = new LinkedHashMap<>();
        if (best == 0) return new ArrayList<>();
        for (Entry e : all) {
            if (score(e.name, spoken) != best || tail(e.number).isEmpty()) continue;
            Entry same = null;
            String sameKey = null;
            for (Map.Entry<String, Entry> kept : people.entrySet()) {
                Entry k = kept.getValue();
                boolean sameContact = k.id == e.id;
                boolean copy = norm(k.name).equals(norm(e.name)) && tail(k.number).equals(tail(e.number));
                if (sameContact || copy) { same = k; sameKey = kept.getKey(); break; }
            }
            if (same == null) people.put(e.id + "|" + tail(e.number), e);
            else if (rank(e) > rank(same)) people.put(sameKey, e);
        }
        return new ArrayList<>(people.values());
    }

    private static int rank(Entry e) {
        return (e.primary ? 2 : 0) + (e.mobile ? 1 : 0);
    }
}
