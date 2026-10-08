package com.aura.app;

import java.util.Locale;

/**
 * Whether two words sound alike, for names speech recognition gets wrong ("Zapado" for Zepto, "Blink it" for
 * Blinkit). Each word is reduced to its consonant sounds, with sounds that are easily confused merged (d/t, b/p,
 * k/g/c/q, s/z/j, f/v); vowels are ignored, since recognisers swap them freely. Plain Java so it can be unit tested.
 */
final class SoundsLike {

    private SoundsLike() { }

    /** The sound key of a name: "zepto" and "zapado" both give "spt". */
    static String key(String name) {
        String w = name == null ? "" : name.toLowerCase(Locale.ROOT).replaceAll("[^a-z]", "");
        w = w.replace("ph", "f").replace("ck", "k").replace("sh", "s").replace("ch", "c").replace("th", "t")
                .replace("kh", "k").replace("gh", "g").replace("bh", "b").replace("dh", "d");
        StringBuilder b = new StringBuilder();
        char prev = 0;
        for (int i = 0; i < w.length(); i++) {
            char c = sound(w.charAt(i));
            if (c == 0) { prev = 0; continue; }
            if (c != prev) b.append(c);
            prev = c;
        }
        return b.toString();
    }

    private static char sound(char c) {
        switch (c) {
            case 'b': case 'p': return 'p';
            case 'd': case 't': return 't';
            case 'g': case 'k': case 'c': case 'q': return 'k';
            case 's': case 'z': case 'j': case 'x': return 's';
            case 'f': case 'v': return 'f';
            case 'm': return 'm';
            case 'n': return 'n';
            case 'l': return 'l';
            case 'r': return 'r';
            default: return 0;   // vowels, h, w, y
        }
    }

    /**
     * Whether `heard` sounds like `name`. Short names (three sounds or fewer) must match exactly; longer ones may
     * differ by one sound.
     */
    static boolean alike(String heard, String name) {
        String a = key(heard);
        String b = key(name);
        if (a.length() < 2 || b.length() < 2) return false;
        if (a.equals(b)) return true;
        return Math.min(a.length(), b.length()) >= 4 && distance(a, b) <= 1;
    }

    private static int distance(String a, String b) {
        int[] row = new int[b.length() + 1];
        for (int j = 0; j <= b.length(); j++) row[j] = j;
        for (int i = 1; i <= a.length(); i++) {
            int diag = row[0];
            row[0] = i;
            for (int j = 1; j <= b.length(); j++) {
                int up = row[j];
                row[j] = Math.min(Math.min(row[j] + 1, row[j - 1] + 1), diag + (a.charAt(i - 1) == b.charAt(j - 1) ? 0 : 1));
                diag = up;
            }
        }
        return row[b.length()];
    }
}
