package com.aura.app;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Turns a spoken sentence into a structured intent for the people-related agents (phone calls, WhatsApp), and reads
 * short replies to AURA's questions ("SIM 2", "yes", "I don't know", a phone number). Runs on the phone; nothing is
 * sent to a server or a language model. Plain Java so it can be unit tested. Media and app commands are parsed by
 * AppActions.
 */
final class Intents {

    enum Type { NONE, CALL, END_CALL, WA_OPEN, WA_MESSAGE, WA_CALL, SCREEN_TASK }

    static final class Parsed {
        Type type = Type.NONE;
        String name;       // lower-case spoken name; null for a pronoun or a dictated number
        String number;
        String message;    // as spoken, capitals kept
        boolean pronoun;
        boolean video;
        int sim = -1;
        /** Only the loose "tell <word> <rest>" form matched: treat as a message only if <word> is a saved contact. */
        boolean loose;
    }

    private static final int I = Pattern.CASE_INSENSITIVE;
    private static final String WA = "(?:whats ?app|what's app|whatsup|what's up)";
    private static final String VIA = "(?:on|in|using|through|via|over)";
    private static final Pattern PRONOUN = Pattern.compile("^(?:him|her|them|his|hers|their|theirs)$");
    private static final Pattern NOT_A_PERSON = Pattern.compile("^(?:me|us|you|it|this|that|a|an|the|my|aura|back|)$");

    private static final Pattern END_CALL = Pattern.compile(
            "^(?:hang up|hang up (?:the |this )?(?:call|phone)|(?:cut|end|stop|disconnect|drop) (?:the |this |my )?call|disconnect|cut it)$", I);

    private static final Pattern WA_CALL_1 = Pattern.compile(
            "^(?:make |start |place )?(?:a |an )?(?:(video|audio|voice) )?(?:" + WA + " )?call (?:to |with )?(.+?) " + VIA + " " + WA + "$", I);
    private static final Pattern WA_CALL_2 = Pattern.compile(
            "^" + WA + " (?:(video|audio|voice) )?call (?:to |with )?(.+)$", I);
    private static final Pattern WA_CALL_3 = Pattern.compile(
            "^(?:make |start |place )?(?:a |an )?(video|audio|voice) call (?:to |with )?(.+?)(?: " + VIA + " " + WA + ")?$", I);

    private static final Pattern WA_OPEN_1 = Pattern.compile(
            "^(?:open|show|go to) (.+?) " + WA + "(?: chat| conversation| messages?)?$", I);
    private static final Pattern WA_OPEN_2 = Pattern.compile(
            "^(?:open|show|go to) (?:the )?(?:" + WA + " )?(?:chat|conversation) (?:of|with|for) (.+?)(?: " + VIA + " " + WA + ")?$", I);
    private static final Pattern WA_OPEN_3 = Pattern.compile(
            "^(?:open|show) " + WA + " (?:chat |conversation )?(?:of|with|for) (.+)$", I);

    private static final Pattern MSG_PRONOUN = Pattern.compile(
            "^(?:send|tell|text|message|ping|" + WA + ") (him|her|them)(?: (?:that |saying |a message (?:that |saying )?)?(.+))?$", I);
    private static final Pattern MSG_TO = Pattern.compile(
            "^send (?:a |an )?(?:" + WA + " )?(?:message|text|msg) to (.+?)(?: " + VIA + " " + WA + ")?(?: (?:that|saying) (.+))?$", I);
    private static final Pattern MSG_SEND_A = Pattern.compile(
            "^send (.+?) (?:a |an )?(?:" + WA + " )?(?:message|text|msg)(?: " + VIA + " " + WA + ")?(?: (?:that|saying) (.+))?$", I);
    private static final Pattern MSG_THAT = Pattern.compile(
            "^(?:message|text|" + WA + ") (.+?)(?: " + VIA + " " + WA + ")? (?:that|saying) (.+)$", I);
    private static final Pattern MSG_NAME_ONLY = Pattern.compile(
            "^(?:message|text|" + WA + ") (\\S+(?: \\S+){0,2}?)(?: " + VIA + " " + WA + ")?$", I);
    private static final Pattern MSG_LOOSE = Pattern.compile("^(tell|send|message|text) (\\S+) (?:that )?(.+)$", I);

    private static final Pattern CALL = Pattern.compile(
            "^(?:call|dial|phone|ring|make a call to|place a call to) (.+?)(?: (?:on|from|using|with|through|via) (.*\\bsim\\b.*))?$", I);

    private Intents() { }

    /** The sentence without the wake phrase, politeness and end punctuation; capitals are kept (a message is quoted as spoken). */
    static String tidy(String raw) {
        String t = raw == null ? "" : raw.replace('’', '\'').replace(",", " ").replaceAll("\\s+", " ").trim();
        t = t.replaceAll("[.!?]+$", "").trim();
        t = t.replaceFirst("(?i)^(?:hey (?:aura|ora|aurora|laura) |aura )?(?:please |can you |could you |will you |would you )?", "");
        return t.replaceFirst("(?i) (?:please|for me)$", "").trim();
    }

    static Parsed parse(String tidy) {
        String t = tidy == null ? "" : tidy.trim();
        Parsed p = new Parsed();
        if (t.isEmpty()) return p;
        if (END_CALL.matcher(t).matches()) { p.type = Type.END_CALL; return p; }

        Matcher m;
        for (Pattern call : new Pattern[]{WA_CALL_1, WA_CALL_2, WA_CALL_3}) {
            m = call.matcher(t);
            if (m.matches() && person(p, m.group(2))) {
                p.type = Type.WA_CALL;
                p.video = m.group(1) != null && m.group(1).equalsIgnoreCase("video");
                return p;
            }
        }
        for (Pattern open : new Pattern[]{WA_OPEN_1, WA_OPEN_2, WA_OPEN_3}) {
            m = open.matcher(t);
            if (m.matches() && person(p, m.group(1))) { p.type = Type.WA_OPEN; return p; }
        }

        m = MSG_PRONOUN.matcher(t);
        if (m.matches()) {
            p.type = Type.WA_MESSAGE;
            p.pronoun = true;
            p.message = m.group(2);
            return p;
        }
        for (Pattern msg : new Pattern[]{MSG_TO, MSG_SEND_A, MSG_THAT}) {
            m = msg.matcher(t);
            if (m.matches() && person(p, m.group(1))) {
                p.type = Type.WA_MESSAGE;
                p.message = m.group(2);
                return p;
            }
        }
        m = MSG_NAME_ONLY.matcher(t);
        if (m.matches() && person(p, m.group(1))) { p.type = Type.WA_MESSAGE; return p; }
        m = MSG_LOOSE.matcher(t);
        if (m.matches() && person(p, m.group(2))) {
            p.type = Type.WA_MESSAGE;
            p.message = m.group(3);
            String verb = m.group(1).toLowerCase(Locale.ROOT);
            p.loose = verb.equals("tell") || verb.equals("send");
            return p;
        }

        m = CALL.matcher(t);
        if (m.matches() && person(p, m.group(1))) {
            p.type = Type.CALL;
            if (m.group(2) != null) p.sim = sim(m.group(2));
            return p;
        }
        return new Parsed();
    }

    /** Fills in who the sentence is about. False when the words don't name a person ("call me", "open my whatsapp"). */
    private static boolean person(Parsed p, String raw) {
        String n = raw == null ? "" : raw.toLowerCase(Locale.ROOT).trim();
        n = n.replaceFirst("^(?:my |mr |mrs |ms )", "").replaceFirst("(?:'s|s')$", "").trim();
        p.name = null;
        p.number = null;
        p.pronoun = false;
        if (NOT_A_PERSON.matcher(n).matches()) return false;
        if (PRONOUN.matcher(n).matches()) { p.pronoun = true; return true; }
        String number = digits(n);
        if (number != null && n.replaceAll("[\\d\\s+\\-()]", "").isEmpty()) { p.number = number; return true; }
        p.name = n;
        return true;
    }

    private static final Pattern SIM = Pattern.compile(
            "\\bsim (?:number |card )?(1|one|won|first|2|two|to|too|second)\\b|\\b(first|second|1st|2nd) sim\\b"
                    + "|^(?:the )?(one|two|1|2|first|second)(?: one)?$");

    /** "SIM 2", "second sim", "two" -> 1 (zero-based); -1 when the words name no SIM. */
    static int sim(String reply) {
        Matcher m = SIM.matcher(reply.toLowerCase(Locale.ROOT).trim());
        if (!m.find()) return -1;
        String w = m.group(1) != null ? m.group(1) : m.group(2) != null ? m.group(2) : m.group(3);
        return w.matches("1|one|won|first|1st") ? 0 : 1;
    }

    /** A phone number said aloud ("it's 98765 43210"); null when the reply isn't one. */
    static String digits(String reply) {
        String d = reply.replaceAll("\\D", "");
        String letters = reply.replaceAll("[^\\p{L}]", "");
        if (d.length() < 7 || d.length() > 15 || letters.length() > 14) return null;
        return (reply.trim().startsWith("+") || reply.contains(" +") ? "+" : "") + d;
    }

    private static final Pattern YES = Pattern.compile(
            "^(?:yes|yeah|yep|yup|ya|ok|okay|sure|haan|ha|correct|right|confirm|confirmed|send|send it|do it|go ahead|please do|call|call now)(?: please| send it| do it| go ahead)?$");
    private static final Pattern NO = Pattern.compile(
            "^(?:no|nope|nah|nahi|don't|do not|don't send(?: it)?|not now|wait)(?: .*)?$");
    private static final Pattern CANCEL = Pattern.compile(
            "^(?:cancel|cancel (?:it|that)|never ?mind|leave it|forget it|stop|ruko|rehne do)$");
    private static final Pattern DONT_KNOW = Pattern.compile(
            "\\b(?:i don't know|i do not know|don't know|no idea|not sure|i don't have (?:it|the number|his number|her number)|don't have it)\\b");

    static boolean yes(String reply) { return YES.matcher(low(reply)).matches(); }

    static boolean no(String reply) { return NO.matcher(low(reply)).matches(); }

    static boolean cancel(String reply) { return CANCEL.matcher(low(reply)).matches(); }

    static boolean dontKnow(String reply) { return DONT_KNOW.matcher(low(reply)).find(); }

    private static String low(String s) {
        return s.toLowerCase(Locale.ROOT).replace('’', '\'').replaceAll("[.!?]+$", "").trim();
    }
}
