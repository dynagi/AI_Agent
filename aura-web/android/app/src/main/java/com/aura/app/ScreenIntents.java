package com.aura.app;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Spoken commands about what is on the phone's screen right now: "find this" (visual product search), "what's on my
 * screen", "scroll down", "like this post", "tap the second video". Only sentences that clearly point at the screen
 * match, so orders, reminders and questions still go to AURA's web app. Plain Java so it can be unit tested.
 */
final class ScreenIntents {

    enum Kind { NONE, VISUAL_SEARCH, DESCRIBE, SCROLL, ACT }

    static final class Parsed {
        Kind kind = Kind.NONE;
        /** For ACT / DESCRIBE: what the user wants done, in their own words. */
        String goal;
        /** For VISUAL_SEARCH: which item they mean ("the red shoes"), or null for "this". */
        String hint;
        /** For SCROLL. */
        boolean down = true;
    }

    private static final String THIS = "(?:this|that|these|those|it)";
    private static final String STORE = "(?:\\s+(?:on|in|from|at)\\s+[a-z0-9 ]{2,30})?";

    // things that are not products: "find this song" is for the music player, "find this person" is not a shop search
    private static final Pattern NOT_A_PRODUCT = Pattern.compile(
            "\\b(?:songs?|music|tracks?|videos?|reels?|numbers?|contacts?|person|people|friend|place|location|restaurant|address|word|meaning)\\b");

    private static final Pattern VISUAL_THIS = Pattern.compile(
            "^(?:find|search(?: for)?|look(?: up| for)?|shop(?: for)?|buy|get me|show me|order)\\s+" + THIS
                    + "(?:\\s+up)?(?:\\s+(?:product|item|one|thing|online))?" + STORE + "$");
    private static final Pattern VISUAL_SIMILAR = Pattern.compile(
            "^(?:find|search(?: for)?|look(?: for)?|show me|get me)\\s+(?:something |one |ones |items |products )?"
                    + "(?:similar|the same|more like " + THIS + "|like " + THIS + ")(?:\\s+to " + THIS + ")?" + STORE + "$");
    private static final Pattern VISUAL_WHAT = Pattern.compile(
            "^(?:what(?:'s| is)|identify|tell me what)\\s+" + THIS + "\\s+(?:product|item|thing i(?:'m| am) looking at)$"
                    + "|^(?:what product is " + THIS + ")$");
    private static final Pattern VISUAL_WHERE = Pattern.compile(
            "^where\\s+(?:can i|do i|to|could i)\\s+(?:buy|get|find|order)\\s+" + THIS + "(?:\\s+from)?(?:\\s+.+)?$"
                    + "|^(?:how much|what(?:'s| is) the (?:price|cost)|price)\\s+(?:is |of |for )?" + THIS + "(?:\\s+.+)?$");
    private static final Pattern VISUAL_MODE = Pattern.compile(
            "^(?:visual search|search by (?:image|screen|picture|photo)|search (?:what(?:'s| is) )?on (?:my |the )?screen"
                    + "|find (?:what(?:'s| is) )?on (?:my |the )?screen)$");
    // "find the red shoes on screen", "search for the lamp I'm looking at"
    private static final Pattern VISUAL_NAMED = Pattern.compile(
            "^(?:find|search for|look up|shop for|get me)\\s+(.+?)\\s+(?:on (?:my |the |this )?screen|i(?:'m| am) looking at|"
                    + "(?:in|from) (?:this|the) (?:photo|picture|image|post|video|reel|story|screenshot))$");

    private static final Pattern DESCRIBE = Pattern.compile(
            "^(?:what(?:'s| is)(?: on| in| showing on| happening on)? (?:my |the |this )?screen|what am i looking at|what do you see"
                    + "|(?:read|describe|summari[sz]e|explain)(?: out)?(?: what(?:'s| is) on)? (?:my |the |this )?screen"
                    + "|(?:read|describe|summari[sz]e|explain) (?:this|this page|this post|this screen))$");

    private static final Pattern SCROLL = Pattern.compile(
            "^(?:scroll|swipe)\\s+(down|up)(?:\\s+(?:a bit|a little|more|please|once))?$|^(?:scroll|swipe) (?:down|up) (?:the )?(?:page|screen|feed|list)$");

    private static final Pattern ACT_TAP = Pattern.compile("^(?:tap|click|press|touch|hit)(?:\\s+on)?\\s+(.+)$");
    private static final Pattern ACT_ENGAGE = Pattern.compile(
            "^(?:like|unlike|follow|unfollow|subscribe(?: to)?|comment on|reply to|bookmark|save|share|mute|unmute|dismiss|accept|allow|deny)\\s+"
                    + "(?:this|that|it|the|him|her|them)\\b.*$");
    private static final Pattern ACT_NTH = Pattern.compile(
            "^(?:open|play|select|choose|watch)(?: on)?\\s+the\\s+(?:first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|last|top|next)\\s+.+$");
    private static final Pattern ACT_TYPE_IN = Pattern.compile(
            "^(?:type|search for|search|enter|write)\\s+(.+?)\\s+(?:in|into) (?:the )?(?:search|search bar|search box|field|box|text box)$");
    // "on this screen, open the menu" says it outright; "open the menu here" only counts when it starts with something to press
    private static final Pattern ACT_HERE_PREFIX = Pattern.compile("^(?:on (?:the |this |my )?screen|on this page|in this app),?\\s+(.+)$");
    private static final Pattern ACT_HERE_SUFFIX = Pattern.compile(
            "^((?:tap|click|press|open|play|select|choose|search(?: for)?|type|like|follow|scroll)\\b.*?)\\s+(?:here|on this screen|on this page|in this app)$");

    private ScreenIntents() { }

    static Parsed parse(String raw) {
        Parsed p = new Parsed();
        String t = tidy(raw);
        if (t.isEmpty()) return p;
        Matcher m;

        // ---- visual search
        boolean shopWord = !NOT_A_PRODUCT.matcher(t).find();
        if (shopWord && (VISUAL_THIS.matcher(t).matches() || VISUAL_SIMILAR.matcher(t).matches() || VISUAL_WHAT.matcher(t).matches()
                || VISUAL_WHERE.matcher(t).matches())) {
            p.kind = Kind.VISUAL_SEARCH;
            p.hint = t;
            return p;
        }
        if (VISUAL_MODE.matcher(t).matches()) {
            p.kind = Kind.VISUAL_SEARCH;
            p.hint = null;
            return p;
        }
        m = VISUAL_NAMED.matcher(t);
        if (m.matches() && shopWord) {
            p.kind = Kind.VISUAL_SEARCH;
            p.hint = m.group(1);
            return p;
        }

        // ---- read the screen out
        if (DESCRIBE.matcher(t).matches()) {
            p.kind = Kind.DESCRIBE;
            p.goal = "Describe what is on the screen in one or two short sentences.";
            return p;
        }

        // ---- scrolling needs no model
        m = SCROLL.matcher(t);
        if (m.matches()) {
            p.kind = Kind.SCROLL;
            p.down = m.group(1) == null ? t.contains("down") : m.group(1).equals("down");
            return p;
        }

        // ---- things to do on the screen
        m = ACT_HERE_PREFIX.matcher(t);
        if (!m.matches()) m = ACT_HERE_SUFFIX.matcher(t);
        if (m.matches()) {
            String rest = m.group(1);
            if (rest != null && !rest.trim().isEmpty() && !ScreenPolicy.forbiddenText(rest)) {
                p.kind = Kind.ACT;
                p.goal = rest.trim();
                return p;
            }
        }
        if (ACT_TAP.matcher(t).matches() || ACT_ENGAGE.matcher(t).matches() || ACT_NTH.matcher(t).matches()
                || ACT_TYPE_IN.matcher(t).matches()) {
            p.kind = Kind.ACT;
            p.goal = t;
        }
        return p;
    }

    static boolean isCommand(String raw) {
        return parse(raw).kind != Kind.NONE;
    }

    static String tidy(String raw) {
        String t = raw == null ? "" : raw.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9' ]", " ").replaceAll("\\s+", " ").trim();
        return t.replaceFirst("^(?:hey aura |aura )?(?:please |can you |could you |will you |would you )?", "")
                .replaceFirst("^(?:just |now )", "")
                .replaceFirst(" (?:please|for me)$", "").trim();
    }
}
