package com.aura.app;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Hinglish phone commands rewritten as the English commands the phone's rules understand, keeping names, songs and
 * message text exactly as said:
 *
 *   "YouTube par CarryMinati ka latest video chala"            -> "play carryminati latest video on youtube"
 *   "WhatsApp par Sarvesh ko message bhej ki main raste mein hoon" -> "send a whatsapp message to sarvesh saying main raste mein hoon"
 *   "Sarvesh ko call karo"                                       -> "call sarvesh"
 *   "Spotify kholo" / "gaana band karo" / "awaaz badhao"          -> "open spotify" / "pause" / "volume up"
 *
 * Returns the sentence unchanged when no rule applies. The same rules exist on the server (hinglish.py) and in the
 * app (hinglish.ts). Plain Java so it is unit tested.
 */
final class Hinglish {

    private Hinglish() { }

    private static final int I = Pattern.CASE_INSENSITIVE;
    private static final String V = "(?:kar(?:\\s?(?:o|do|de|dijiye))?|kardo|karde)";
    private static final String PLAY = "(?:chala(?:\\s?(?:o|do|de))?|chalao|laga(?:\\s?(?:o|do|de))?|lagao|baja(?:\\s?(?:o|do|de))?|"
            + "play " + V + "|suna(?:\\s?(?:o|do|de))?|dikha(?:\\s?(?:o|do|de))?)";
    private static final Pattern FILLER = Pattern.compile(
            "^(?:hey aura,?\\s+|aura,?\\s+)?(?:please\\s+|zara\\s+)?(?:mere liye\\s+|mujhe\\s+)?", I);

    private static final Pattern ON_APP_PLAY = Pattern.compile(
            "^(youtube|spotify|yt)\\s+(?:par|pe|mein|me)\\s+(.+?)\\s+" + PLAY + "$", I);
    private static final Pattern PLAY_ON_APP = Pattern.compile(
            "^(.+?)\\s+(youtube|spotify)\\s+(?:par|pe|mein|me)\\s+" + PLAY + "$", I);
    private static final Pattern WA_MESSAGE = Pattern.compile(
            "^(?:whatsapp\\s+(?:par|pe)\\s+)?(.+?)\\s+ko\\s+(?:whatsapp\\s+(?:par\\s+|pe\\s+)?)?(?:message|msg|sandesh)\\s+"
                    + "(?:bhej(?:o|do|de)?|bhej\\s(?:do|de)|send\\s" + V + ")\\s*(?:ki|ke|that|:)?\\s*(.*)$", I);
    private static final Pattern WA_CALL = Pattern.compile(
            "^(?:whatsapp\\s+(?:par|pe)\\s+)?(.+?)\\s+ko\\s+whatsapp\\s+(?:par\\s+|pe\\s+)?(video\\s+)?call\\s+" + V + "$", I);
    private static final Pattern WA_CALL2 = Pattern.compile(
            "^whatsapp\\s+(?:par|pe)\\s+(.+?)\\s+ko\\s+(video\\s+)?call\\s+" + V + "$", I);
    private static final Pattern CALL = Pattern.compile("^(.+?)\\s+ko\\s+(?:phone\\s+|call\\s+)" + V + "$", I);
    private static final Pattern OPEN = Pattern.compile("^(.+?)\\s+(?:khol(?:o|do|de)?|khol\\s(?:do|de)|open\\s" + V + ")$", I);
    private static final Pattern CLOSE = Pattern.compile("^(.+?)\\s+band\\s+" + V + "$", I);
    private static final Pattern PAUSE = Pattern.compile("^(?:gaana|gana|music|song|video)\\s+(?:band|ruk|roko|rok)\\s*(?:" + V + "|do|de|o)?$|^ruko$", I);
    private static final Pattern NEXT = Pattern.compile("^(?:agla|next)\\s+(?:gaana|gana|song|video)\\s*(?:chala(?:o)?|laga(?:o)?|" + V + ")?$", I);
    private static final Pattern PREV = Pattern.compile("^(?:pichla|previous)\\s+(?:gaana|gana|song|video)\\s*(?:chala(?:o)?|laga(?:o)?|" + V + ")?$", I);
    private static final Pattern VOL_UP = Pattern.compile("^(?:awaaz|awaz|volume)\\s+(?:badha(?:o|do|de)?|tez\\s" + V + "|zyada\\s" + V + ")$", I);
    private static final Pattern VOL_DOWN = Pattern.compile("^(?:awaaz|awaz|volume)\\s+(?:kam|dheere|dhire)\\s*" + V + "?$", I);
    private static final Pattern HANG_UP = Pattern.compile("^(?:call|phone)\\s+(?:kaat|kat|cut|band)\\s*(?:" + V + "|do|de|o)?$", I);

    static String toEnglish(String raw) {
        if (raw == null) return "";
        String t = FILLER.matcher(raw.trim().replaceAll("[?.!]+$", "")).replaceFirst("");
        Matcher m;
        if ((m = ON_APP_PLAY.matcher(t)).matches()) return "play " + query(m.group(2)) + " on " + app(m.group(1));
        if ((m = PLAY_ON_APP.matcher(t)).matches()) return "play " + query(m.group(1)) + " on " + app(m.group(2));
        if ((m = WA_CALL.matcher(t)).matches() || (m = WA_CALL2.matcher(t)).matches()) {
            return "whatsapp " + (m.group(2) != null ? "video " : "") + "call " + m.group(1).trim();
        }
        if ((m = WA_MESSAGE.matcher(t)).matches()) {
            String msg = m.group(2).trim();
            return "send a whatsapp message to " + m.group(1).trim() + (msg.isEmpty() ? "" : " saying " + msg);
        }
        if (HANG_UP.matcher(t).matches()) return "hang up";
        if ((m = CALL.matcher(t)).matches()) return "call " + m.group(1).trim();
        if (PAUSE.matcher(t).matches()) return "pause";
        if (NEXT.matcher(t).matches()) return "next song";
        if (PREV.matcher(t).matches()) return "previous song";
        if (VOL_UP.matcher(t).matches()) return "volume up";
        if (VOL_DOWN.matcher(t).matches()) return "volume down";
        if ((m = CLOSE.matcher(t)).matches() && !m.group(1).matches("(?i)(gaana|gana|music|song|video|call|phone)")) {
            return "close " + m.group(1).trim();
        }
        if ((m = OPEN.matcher(t)).matches()) return "open " + m.group(1).trim();
        return raw;
    }

    /** "carryminati ka latest video" -> "carryminati latest video" (the possessive isn't part of the search). */
    private static String query(String q) {
        return q.replaceAll("(?i)\\s+(?:ka|ki|ke)\\s+", " ").trim();
    }

    private static String app(String a) {
        String s = a.toLowerCase(Locale.ROOT);
        return s.equals("yt") ? "youtube" : s;
    }
}
