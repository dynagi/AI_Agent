package com.aura.app;

import android.Manifest;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * The assistant's central router and conversation manager. Every spoken command comes here first:
 *
 *   sentence -> (is it the answer to a question AURA asked?) -> intent -> context ("him", "the second one")
 *            -> missing details asked one at a time -> confirmation if the action is risky -> the right agent
 *            -> the agent acts, checks the outcome, and reports an ActionResult.
 *
 * Agents: CallAgent (phone calls), WhatsAppAgent (chats, messages, calls), AppActions (media and opening apps).
 * Anything that isn't theirs returns false and goes on to AURA's web app (shopping, reminders, general questions).
 * All of this runs on the phone. Names, numbers and messages handled here are not logged and not sent to a server.
 */
final class ActionRouter {

    private static final String TAG = "AuraRouter";
    private static final Handler ui = new Handler(Looper.getMainLooper());
    static final ConversationContext cx = new ConversationContext();

    // "play the second one", "the first video", "second one instead": a pick from the results AURA last showed
    private static final Pattern RESULT_REF = Pattern.compile(
            "^(?:play |open |put on |no |not that |i meant )?(?:the )?(?:number |option )?\\S+(?: one| video| result)?(?: instead| please)?$");
    private static final Pattern LATEST = Pattern.compile("\\b(?:latest|newest|most recent|recent)\\b");

    private ActionRouter() { }

    /**
     * Handles `raw` if it is something the phone-side agents do, reporting to `out` on the main thread (possibly
     * with a question: ActionResult.expectAnswer). Returns false, without calling `out`, when it isn't.
     */
    static boolean handle(Context ctx, String raw, ActionResult.Done out) {
        long now = SystemClock.elapsedRealtime();
        cx.touch(now);
        String t = Intents.tidy(raw);
        if (t.isEmpty()) return false;
        ActionResult.Done done = recording(out);
        ConversationContext.Pending waiting = cx.takePending(now);
        if (waiting != null && answer(ctx, waiting, t, done)) return true;
        return route(ctx, t, done);
    }

    /** Whether the sentence may be written to the phone's log: only plain media / app commands, never people or replies. */
    static boolean loggable(String raw) {
        String t = Intents.tidy(raw);
        return cx.pending == null && Intents.parse(t).type == Intents.Type.NONE && AppActions.isCommand(t);
    }

    /**
     * Of the speech recogniser's guesses (best first by its own rating), the one that makes sense here: a reply that
     * answers the question AURA asked, else a sentence AURA understands as a command, else the recogniser's top guess.
     * ("Paws the song" / "pause the song": the second is a command, so it is picked.)
     */
    static String pickHypothesis(List<String> guesses) {
        String best = guesses.get(0);
        int bestScore = -1;
        for (String g : guesses) {
            int score = sense(g);
            if (score > bestScore) { bestScore = score; best = g; }
        }
        return best;
    }

    private static int sense(String guess) {
        String t = Intents.tidy(guess);
        String low = t.toLowerCase(Locale.ROOT);
        if (cx.pending != null) {
            switch (cx.pending.ask) {
                case CHOOSE_SIM: if (Intents.sim(low) >= 0) return 3; break;
                case CONFIRM: if (Intents.yes(low) || Intents.no(low)) return 3; break;
                case ASK_NUMBER: if (Intents.digits(low) != null || Intents.dontKnow(low)) return 3; break;
                case CHOOSE_CONTACT:
                case CHOOSE_RESULT:
                    if (cx.pending.options != null && (ConversationContext.ordinal(low, cx.pending.options.size()) >= 0
                            || ConversationContext.byName(low, cx.pending.options) >= 0)) return 3;
                    break;
                default:
                    break;
            }
        }
        if (Intents.parse(t).type != Intents.Type.NONE) return 2;
        if (AppActions.isCommand(t) || ScreenIntents.isCommand(t)) return 2;
        return 0;
    }

    private static final String[] VOCABULARY = {
            "AURA", "Hey AURA", "Spotify", "YouTube", "WhatsApp", "Zepto", "Blinkit", "Swiggy", "Zomato", "Instamart",
            "BigBasket", "Amazon", "Flipkart", "SIM 1", "SIM 2", "hang up", "pause", "resume", "next song",
            "previous song", "volume up", "volume down", "video call", "WhatsApp call", "the latest one", "the second one",
    };

    /** What the recogniser should expect to hear: AURA's command words and the names of the apps on this phone. */
    static ArrayList<String> vocabulary(Context ctx) {
        ArrayList<String> words = new ArrayList<>(java.util.Arrays.asList(VOCABULARY));
        try {
            android.content.pm.PackageManager pm = ctx.getPackageManager();
            android.content.Intent launcher = new android.content.Intent(android.content.Intent.ACTION_MAIN)
                    .addCategory(android.content.Intent.CATEGORY_LAUNCHER);
            for (android.content.pm.ResolveInfo ri : pm.queryIntentActivities(launcher, 0)) {
                String label = String.valueOf(ri.loadLabel(pm)).trim();
                if (!label.isEmpty() && label.length() <= 30 && !words.contains(label)) words.add(label);
                if (words.size() >= 120) break;
            }
        } catch (Exception e) {
            // the fixed words are enough
        }
        return words;
    }

    /** Whether AURA is waiting for the user's reply to a question it asked. */
    static boolean awaitingReply() {
        return cx.pending != null;
    }

    private static boolean route(Context ctx, String t, ActionResult.Done done) {
        Intents.Parsed in = Intents.parse(t);
        cx.lastIntent = in.type.name();
        switch (in.type) {
            case END_CALL:
                CallAgent.end(ctx, done);
                return true;
            case CALL:
            case WA_OPEN:
            case WA_CALL:
            case WA_MESSAGE: {
                if (in.loose) {
                    // "tell Rahul I'm late" is a message only if Rahul is someone saved; otherwise it isn't ours
                    if (!Permissions.has(ctx, Manifest.permission.READ_CONTACTS)) break;
                    if (ContactsLookup.find(ctx, in.name).isEmpty()) break;
                }
                ConversationContext.Task task = new ConversationContext.Task();
                task.type = in.type;
                task.name = in.name;
                task.number = in.number;
                task.pronoun = in.pronoun;
                task.sim = in.sim;
                task.message = in.message;
                task.video = in.video;
                advance(ctx, task, done);
                return true;
            }
            default:
                break;
        }
        String low = t.toLowerCase(Locale.ROOT);
        // ("last" is left to the media controls: "the last one" usually means the previous track)
        if (cx.searchResults != null && !low.contains("last") && RESULT_REF.matcher(low).matches()) {
            int i = ConversationContext.ordinal(low, cx.searchResults.size());
            if (i >= 0) { AppActions.playResult(ctx, cx, i, false, done); return true; }
        }
        ScreenIntents.Parsed screen = ScreenIntents.parse(t);
        if (screen.kind != ScreenIntents.Kind.NONE && ScreenAgent.claims(ctx, screen)) {
            ScreenAgent.handle(ctx, screen, done);
            return true;
        }
        return AppActions.handle(ctx, t, cx, done);
    }

    // ------------------------------------------------------------------ answers to AURA's questions

    /** True when the reply was used (or re-asked). False: it was a new command, so the question is dropped. */
    private static boolean answer(Context ctx, ConversationContext.Pending p, String t, ActionResult.Done done) {
        String low = t.toLowerCase(Locale.ROOT);
        ConversationContext.Task task = p.task;
        if (Intents.cancel(low)) {
            if (task != null && task.type == Intents.Type.SCREEN_TASK) ScreenAgent.cancel(task);
            reply(done, ActionResult.Status.CANCELLED, "cancel", "Okay, cancelled.");
            return true;
        }
        switch (p.ask) {
            case CHOOSE_CONTACT: {
                int i = ConversationContext.ordinal(low, p.options.size());
                if (i < 0) i = ConversationContext.byName(low, p.options);
                if (i < 0) return retry(ctx, p, t, done);
                task.contact = p.contacts.get(i);
                execute(ctx, task, done);
                return true;
            }
            case ASK_CONTACT: {
                if (isCommand(ctx, t)) return false;
                Intents.Parsed who = Intents.parse("call " + t);   // reuse the name / number reading
                if (who.type != Intents.Type.CALL || who.pronoun) return retry(ctx, p, t, done);
                task.pronoun = false;
                task.name = who.name;
                task.number = who.number;
                advance(ctx, task, done);
                return true;
            }
            case ASK_NUMBER: {
                String number = Intents.digits(low);
                if (number != null) {
                    task.number = number;
                    execute(ctx, task, done);
                    return true;
                }
                if (Intents.no(low) || Intents.dontKnow(low)) {
                    reply(done, ActionResult.Status.CANCELLED, "call", "Okay, I won't call anyone.");
                    return true;
                }
                return retry(ctx, p, t, done);
            }
            case CHOOSE_SIM: {
                int sim = Intents.sim(low);
                if (sim < 0) return retry(ctx, p, t, done);
                task.sim = sim;
                cx.selectedSim = sim;
                execute(ctx, task, done);
                return true;
            }
            case CONFIRM: {
                if (Intents.yes(low)) {
                    task.confirmed = true;
                    execute(ctx, task, done);
                    return true;
                }
                if (Intents.no(low)) {
                    if (task.type == Intents.Type.SCREEN_TASK) ScreenAgent.cancel(task);
                    reply(done, ActionResult.Status.CANCELLED, task.type.name(),
                            task.type == Intents.Type.WA_MESSAGE ? "Okay, I won't send it." : "Okay, I won't.");
                    return true;
                }
                return retry(ctx, p, t, done);
            }
            case ASK_MESSAGE: {
                if (isCommand(ctx, t)) return false;
                task.message = t;
                execute(ctx, task, done);
                return true;
            }
            case CHOOSE_RESULT: {
                if (cx.searchResults == null) return false;
                if (LATEST.matcher(low).find()) { AppActions.playLatest(ctx, cx, done); return true; }
                int i = ConversationContext.ordinal(low, cx.searchResults.size());
                if (i < 0) i = ConversationContext.byName(low, cx.searchResults);
                if (i < 0) return retry(ctx, p, t, done);
                AppActions.playResult(ctx, cx, i, false, done);
                return true;
            }
            default:
                return false;
        }
    }

    /** The reply didn't answer the question: a new command is let through; otherwise ask once more, then give up. */
    private static boolean retry(Context ctx, ConversationContext.Pending p, String t, ActionResult.Done done) {
        if (isCommand(ctx, t)) return false;
        if (p.retries >= 1) {
            reply(done, ActionResult.Status.CANCELLED, "ask", "Sorry, I didn't get that, so I've left it.");
            return true;
        }
        ConversationContext.Pending again = new ConversationContext.Pending(p.ask, p.task, p.question, p.options, p.contacts,
                SystemClock.elapsedRealtime());
        again.retries = p.retries + 1;
        cx.pending = again;
        say(done, new ActionResult(ActionResult.Status.NEEDS_ANSWER, "ask", "Sorry, I didn't catch that. " + p.question, true, true));
        return true;
    }

    private static boolean isCommand(Context ctx, String t) {
        return Intents.parse(t).type != Intents.Type.NONE || AppActions.isCommand(t) || ScreenIntents.isCommand(t);
    }

    // ------------------------------------------------------------------ putting an action together

    /** Works out who the action is about (asking for contacts access, or which person, when needed), then runs it. */
    static void advance(Context ctx, ConversationContext.Task task, ActionResult.Done done) {
        if (task.contact != null || task.number != null) { execute(ctx, task, done); return; }
        if (task.pronoun) {
            if (cx.currentContact == null) {
                ask(done, task, ConversationContext.Ask.ASK_CONTACT, "Who do you mean?", null, null);
                return;
            }
            task.contact = cx.currentContact;
            execute(ctx, task, done);
            return;
        }
        final String who = capitalise(task.name);
        Permissions.ensure(ctx, new String[]{Manifest.permission.READ_CONTACTS},
                "I need access to your contacts to find " + who + ".", done, granted -> {
                    if (!granted) {
                        reply(done, ActionResult.Status.PERMISSION_REQUIRED, task.type.name(), "I can't find " + who
                                + " without access to your contacts. You can allow it in Settings, under Apps, AURA, Permissions.");
                        return;
                    }
                    resolve(ctx, task, who, done);
                });
    }

    private static void resolve(Context ctx, ConversationContext.Task task, String who, ActionResult.Done done) {
        List<ContactMatcher.Entry> found = ContactsLookup.find(ctx, task.name);
        // speech writes "Rahul's" as "Rahuls"
        if (found.isEmpty() && task.name.endsWith("s")) found = ContactsLookup.find(ctx, task.name.substring(0, task.name.length() - 1));
        if (found.isEmpty()) {
            if (task.type == Intents.Type.CALL) {
                ask(done, task, ConversationContext.Ask.ASK_NUMBER,
                        "I don't have " + who + "'s number saved. If you know the number, tell me the number.", null, null);
            } else {
                reply(done, ActionResult.Status.FAILED, task.type.name(), "I couldn't find " + who + " in your contacts.");
            }
            return;
        }
        if (found.size() == 1) {
            task.contact = found.get(0);
            execute(ctx, task, done);
            return;
        }
        // several people match: never guess
        List<ContactMatcher.Entry> shown = found.subList(0, Math.min(5, found.size()));
        List<String> names = new ArrayList<>();
        for (ContactMatcher.Entry e : shown) {
            boolean sameName = false;
            for (ContactMatcher.Entry o : shown) sameName = sameName || (o != e && o.name.equalsIgnoreCase(e.name));
            String tail = ContactMatcher.tail(e.number);
            names.add(sameName && tail.length() >= 4 ? e.name + ", number ending " + tail.substring(tail.length() - 4) : e.name);
        }
        String list = String.join(", ", names.subList(0, names.size() - 1)) + " and " + names.get(names.size() - 1);
        ask(done, task, ConversationContext.Ask.CHOOSE_CONTACT,
                "I found " + found.size() + " contacts named " + who + ": " + list + ". Which one do you mean?", names, new ArrayList<>(shown));
    }

    /** The person is known: collect what is still missing for this kind of action, confirm if needed, and do it. */
    static void execute(Context ctx, ConversationContext.Task task, ActionResult.Done done) {
        switch (task.type) {
            case CALL:
                CallAgent.call(ctx, task, done);
                break;
            case WA_OPEN:
                WhatsAppAgent.openChat(ctx, task, done);
                break;
            case WA_CALL:
                WhatsAppAgent.call(ctx, task, done);
                break;
            case WA_MESSAGE:
                if (task.message == null || task.message.trim().isEmpty()) {
                    ask(done, task, ConversationContext.Ask.ASK_MESSAGE, "What should I say to " + task.who() + "?", null, null);
                } else if (!task.confirmed && Confirmations.required(ctx, Confirmations.Risk.HIGH)) {
                    ask(done, task, ConversationContext.Ask.CONFIRM,
                            "I'll send " + task.who() + ": \"" + task.message.trim() + "\". Should I send it?", null, null);
                } else {
                    WhatsAppAgent.send(ctx, task, done);
                }
                break;
            case SCREEN_TASK:
                ScreenAgent.resume(ctx, task, done);
                break;
            default:
                reply(done, ActionResult.Status.UNSUPPORTED, task.type.name(), "I can't do that yet.");
        }
    }

    /** An action about a person worked: they become who "him" / "her" means. */
    static void remember(ConversationContext.Task task, String app) {
        if (task.contact != null) cx.currentContact = task.contact;
        else if (task.number != null) cx.currentContact = new ContactMatcher.Entry(-1, task.number, task.number, false, false);
        if (app != null) cx.currentApp = app;
    }

    // ------------------------------------------------------------------ replying

    /** Asks the user something and remembers what the answer is for. */
    static void ask(ActionResult.Done done, ConversationContext.Task task, ConversationContext.Ask what, String question,
                    List<String> options, List<ContactMatcher.Entry> contacts) {
        cx.pending = new ConversationContext.Pending(what, task, question, options, contacts, SystemClock.elapsedRealtime());
        Log.i(TAG, "ask " + what);
        say(done, new ActionResult(ActionResult.Status.NEEDS_ANSWER, task == null ? "ask" : task.type.name(), question, true, true));
    }

    /** An agent's final answer. The words are never logged: they name people, numbers or messages. */
    static void reply(ActionResult.Done done, ActionResult.Status status, String action, String say) {
        Log.i(TAG, action + " -> " + status);
        say(done, new ActionResult(status, action, say, false, true));
    }

    private static void say(ActionResult.Done done, ActionResult r) {
        if (Looper.myLooper() == Looper.getMainLooper()) done.onResult(r);
        else ui.post(() -> done.onResult(r));
    }

    private static ActionResult.Done recording(ActionResult.Done out) {
        return new ActionResult.Done() {
            @Override
            public void onResult(ActionResult r) {
                cx.lastAction = r.action;
                cx.lastActionResult = r.status;
                out.onResult(r);
            }

            @Override
            public void onPermissionPrompt(String say) {
                out.onPermissionPrompt(say);
            }
        };
    }

    static String capitalise(String name) {
        if (name == null || name.isEmpty()) return "them";
        StringBuilder b = new StringBuilder();
        for (String w : name.split(" ")) {
            if (w.isEmpty()) continue;
            if (b.length() > 0) b.append(' ');
            b.append(Character.toUpperCase(w.charAt(0))).append(w.substring(1));
        }
        return b.toString();
    }
}
