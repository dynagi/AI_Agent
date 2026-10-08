package com.aura.app;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What the current conversation is about: who "him" is, which results "the second one" refers to, which question
 * AURA is waiting on. Structured fields, not a chat transcript. It lives in memory only (never written to disk,
 * never sent anywhere) and is wiped after a few minutes of silence. Plain Java so it can be unit tested.
 */
final class ConversationContext {

    static final long IDLE_RESET_MS = 5 * 60_000;
    static final long PENDING_MS = 2 * 60_000;

    /** What AURA is waiting for the user to say. */
    enum Ask { CHOOSE_CONTACT, ASK_CONTACT, ASK_NUMBER, CHOOSE_SIM, CONFIRM, ASK_MESSAGE, CHOOSE_RESULT }

    /** An action being put together over several turns ("call Rahul" -> which Rahul -> which SIM -> call). */
    static final class Task {
        Intents.Type type;
        String name;                  // the name as spoken
        boolean pronoun;              // "him", "her": the current contact
        ContactMatcher.Entry contact; // resolved person
        String number;                // a number the user dictated
        int sim = -1;                 // 0 = SIM 1
        String message;
        boolean video;
        boolean confirmed;
        Object screen;                // a ScreenAgent.Session waiting for a yes (SCREEN_TASK)

        String who() {
            return contact != null ? contact.name : number != null ? number : name;
        }

        String dial() {
            return contact != null ? contact.number : number;
        }
    }

    static final class Pending {
        final Ask ask;
        final Task task;
        final String question;
        final List<String> options;
        final List<ContactMatcher.Entry> contacts;
        final long until;
        int retries;

        Pending(Ask ask, Task task, String question, List<String> options, List<ContactMatcher.Entry> contacts, long now) {
            this.ask = ask;
            this.task = task;
            this.question = question;
            this.options = options;
            this.contacts = contacts;
            this.until = now + PENDING_MS;
        }
    }

    ContactMatcher.Entry currentContact;
    String currentApp;
    String currentChat;
    String currentVideo;
    String currentMedia;
    List<String> searchResults;
    String searchApp;
    String searchQuery;
    int selectedSim = -1;
    Pending pending;
    String lastIntent;
    String lastAction;
    ActionResult.Status lastActionResult;
    private long touchedAt;

    /** Call at the start of every turn: a conversation left alone for IDLE_RESET_MS starts fresh. */
    void touch(long now) {
        if (touchedAt != 0 && now - touchedAt > IDLE_RESET_MS) clear();
        touchedAt = now;
    }

    void clear() {
        currentContact = null;
        currentApp = currentChat = currentVideo = currentMedia = null;
        searchResults = null;
        searchApp = searchQuery = null;
        selectedSim = -1;
        pending = null;
        lastIntent = lastAction = null;
        lastActionResult = null;
    }

    /** The question AURA is waiting on, if it is still fresh. Taking it clears it: the reply either settles it or re-asks. */
    Pending takePending(long now) {
        Pending p = pending;
        pending = null;
        return p != null && now <= p.until ? p : null;
    }

    void setResults(String app, String query, List<String> titles) {
        searchApp = app;
        searchQuery = query;
        searchResults = new ArrayList<>(titles);
    }

    private static final Pattern ORDINAL = Pattern.compile(
            "\\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last)\\b"
                    + "|\\b(?:number|option|no|sim) (one|two|to|too|three|four|five|[1-5])\\b"
                    + "|^(?:the )?(one|two|three|four|five|[1-5])(?: one)?$");

    /** Which item "the second one" / "number 2" / "last" points at in a list of `size`; -1 when the words name none. */
    static int ordinal(String reply, int size) {
        Matcher m = ORDINAL.matcher(reply.toLowerCase(Locale.ROOT).trim());
        if (!m.find()) return -1;
        String w = m.group(1) != null ? m.group(1) : m.group(2) != null ? m.group(2) : m.group(3);
        int i;
        switch (w) {
            case "first": case "1st": case "one": case "1": i = 0; break;
            case "second": case "2nd": case "two": case "to": case "too": case "2": i = 1; break;
            case "third": case "3rd": case "three": case "3": i = 2; break;
            case "fourth": case "4th": case "four": case "4": i = 3; break;
            case "fifth": case "5th": case "five": case "5": i = 4; break;
            default: i = size - 1;
        }
        return i >= 0 && i < size ? i : -1;
    }

    private static final Pattern FILLER = Pattern.compile("\\b(?:the|one|i|mean|meant|it's|its|is|call|play|please|that|this)\\b");

    /** The single option that has every word of the reply ("Sharma" -> "Rahul Sharma"); -1 when none or several do. */
    static int byName(String reply, List<String> options) {
        String q = ContactMatcher.norm(FILLER.matcher(reply.toLowerCase(Locale.ROOT)).replaceAll(" "));
        if (q.isEmpty()) return -1;
        int found = -1;
        for (int i = 0; i < options.size(); i++) {
            String o = " " + ContactMatcher.norm(options.get(i)) + " ";
            boolean all = true;
            for (String w : q.split(" ")) all = all && o.contains(" " + w + " ");
            if (!all) continue;
            if (found >= 0) return -1;
            found = i;
        }
        return found;
    }
}
