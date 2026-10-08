package com.aura.app;

import android.app.Activity;
import android.app.SearchManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.media.AudioManager;
import android.net.Uri;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.PlaybackState;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Log;
import android.view.KeyEvent;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * On-device action router for commands about other apps: "open Spotify", "play Kesariya on YouTube", "pause",
 * "next song", "volume up". Everything here runs on the phone, with no server and no web view, so it works from the
 * "Hey Aura" overlay while AURA is in the background.
 *
 * How an action is carried out, in order of preference: the app's own public intent (play-from-search), a launch
 * intent, the system media keys. Nothing here taps the screen. Every action reports a Result, and SUCCESS is only
 * reported when the outcome was checked (the app is in front, audio is playing, the volume moved); otherwise the
 * reply says what was asked for and that it could not be confirmed.
 */
final class AppActions {

    private static final String TAG = "AuraActions";

    /** Apps AURA can ask to play something. The spoken names are how speech recognition tends to write them. */
    private enum MediaApp {
        SPOTIFY("Spotify", AppResolver.SPOTIFY),
        YOUTUBE("YouTube", AppResolver.YOUTUBE);

        final String label;
        final String pkg;

        MediaApp(String label, String pkg) {
            this.label = label;
            this.pkg = pkg;
        }

        static MediaApp named(String spoken) {
            String s = spoken.replace(" ", "");
            if (s.equals("spotify")) return SPOTIFY;
            if (s.equals("youtube") || s.equals("yt")) return YOUTUBE;
            return null;
        }
    }

    private static final String APP = "(spotify|you ?tube|yt)";
    private static final Pattern OPEN_AND_PLAY = Pattern.compile(
            "^(?:open|launch|start|go to) " + APP + "(?: app)?(?: and| then)? (?:play|put on|search(?: for)?|find) (.+)$");
    private static final Pattern PLAY_ON = Pattern.compile(
            "^(?:play|put on|search(?: for)?|find) (.+?) (?:on|in|from|using|with) " + APP + "(?: app)?$");
    private static final Pattern ON_APP_PLAY = Pattern.compile(
            "^(?:on|in) " + APP + "(?: app)?,? (?:play|put on|search(?: for)?|find) (.+)$");
    private static final Pattern PLAY = Pattern.compile("^(?:play|put on) (.+)$");
    private static final Pattern ANYTHING = Pattern.compile(
            "^(?:some |any |my |a |the )?(?:music|songs?|something|anything|tracks?|playlist)$");
    // Speech recognition rarely gives the exact words ("pause song", "pause the songs please", "paws the music"),
    // so playback controls match on the verb plus, when the verb is ambiguous, something that is playing.
    private static final String PLAYING = "(?:music|songs?|tracks?|videos?|playback|playing|player|it|this|that|spotify|you ?tube)";
    private static final Pattern PAUSE = Pattern.compile(
            "^(?:pause|paws|pose)$|\\b(?:pause|paws|pose|stop|halt)\\b.*\\b" + PLAYING + "\\b");
    private static final Pattern RESUME = Pattern.compile(
            "^(?:resume|continue|unpause|play|play again)$|\\b(?:resume|continue|unpause)\\b.*\\b" + PLAYING + "\\b");
    private static final Pattern NEXT = Pattern.compile(
            "^(?:next|skip)$|\\b(?:next|skip|change)\\b.*\\b(?:songs?|tracks?|videos?|one|it|this)\\b");
    private static final Pattern PREVIOUS = Pattern.compile(
            "^(?:previous|go back)$|\\bprevious\\b.*\\b(?:songs?|tracks?|videos?|one)\\b"
                    + "|^(?:play |go (?:back )?to )?(?:the )?last (?:song|track|video|one)$");
    // "stop asking", "pause check-ins", "next task": not about playback
    private static final Pattern NOT_PLAYBACK = Pattern.compile(
            "\\b(?:check ?ins?|reminders?|asking|talking|tasks?|meetings?|events?|orders?|week|month|year|time|night)\\b");
    private static final Pattern VOLUME_UP = Pattern.compile(
            "^(?:volume up|louder|turn it up|(?:increase|raise|turn up) (?:the )?volume|make it louder)$");
    private static final Pattern VOLUME_DOWN = Pattern.compile(
            "^(?:volume down|quieter|softer|turn it down|(?:decrease|reduce|lower|turn down) (?:the )?volume|make it quieter)$");
    private static final Pattern OPEN = Pattern.compile("^(?:open|launch|start) (?:the )?(.+?)(?: app)?$");
    // screens inside AURA itself: the web app answers those
    private static final Pattern AURA_SCREEN = Pattern.compile(
            "^(?:my |the )?(?:tasks?|calendar|wellness|shopping|chat|dashboard|aura|medicines?|travel|voice|settings)\\b.*");

    // "CarryMinati's latest video", "the newest video of ..."
    private static final Pattern LATEST = Pattern.compile("\\b(?:latest|newest|most recent|recent|new)\\b");
    // app lifecycle: "close YouTube", "quit Spotify", "close this app", "stop this app"; not "stop the video" (that is pause)
    private static final Pattern CLOSE_THIS = Pattern.compile(
            "^(?:close|exit|quit|kill|shut|shut down|stop|leave) (?:this|the|current|the current)? ?(?:app|application)$|^(?:close|exit|quit) (?:it|this|that)$");
    private static final Pattern CLOSE_APP = Pattern.compile("^(?:close|exit|quit|kill|shut down|shut) (?:the )?(.+?)(?: app| application)?$");
    private static final Pattern GO_BACK = Pattern.compile("^(?:go back|back|press back|go to the previous screen)$");
    private static final Pattern GO_HOME = Pattern.compile("^(?:go home|go to (?:the )?home(?: screen)?|home screen|show (?:the )?home screen)$");
    private static final Pattern SKIP_AD_CMD = Pattern.compile("^skip (?:the |this |that )?(?:ad|ads|advert|adverts|advertisement|advertisements|commercial)$");

    private static final long PLAY_WAIT_MS = 9000;
    private static final long POLL_MS = 500;

    private static final Handler ui = new Handler(Looper.getMainLooper());
    /** The app AURA last asked to play something: media keys go to it first. */
    private static volatile String lastMediaPkg;

    private AppActions() { }

    /**
     * Carries out `text` if it is a command about another app or media playback, and reports the outcome to `done`
     * (on the main thread). Returns false, without calling `done`, when the command is not one of those.
     */
    static boolean handle(Context ctx, String text, ConversationContext cx, ActionResult.Done done) {
        String t = clean(text);
        if (t.isEmpty()) return false;
        Matcher m0;

        if (SKIP_AD_CMD.matcher(t).matches()) { skipAd(ctx, done); return true; }
        if (CLOSE_THIS.matcher(t).matches()) { closeApp(ctx, null, cx, done); return true; }
        if (GO_BACK.matcher(t).matches()) { system(ctx, false, done); return true; }
        if (GO_HOME.matcher(t).matches()) { system(ctx, true, done); return true; }
        m0 = CLOSE_APP.matcher(t);
        if (m0.matches()) { closeApp(ctx, m0.group(1), cx, done); return true; }
        if (VOLUME_UP.matcher(t).matches()) { volume(ctx, true, done); return true; }
        if (VOLUME_DOWN.matcher(t).matches()) { volume(ctx, false, done); return true; }

        Matcher m = OPEN_AND_PLAY.matcher(t);
        if (m.matches()) { play(ctx, MediaApp.named(m.group(1)), m.group(2), cx, done); return true; }
        m = PLAY_ON.matcher(t);
        if (m.matches()) { play(ctx, MediaApp.named(m.group(2)), m.group(1), cx, done); return true; }
        m = ON_APP_PLAY.matcher(t);
        if (m.matches()) { play(ctx, MediaApp.named(m.group(1)), m.group(2), cx, done); return true; }
        if (!NOT_PLAYBACK.matcher(t).find() && t.split(" ").length <= 7) {
            if (PAUSE.matcher(t).find()) { mediaKey(ctx, KeyEvent.KEYCODE_MEDIA_PAUSE, "pause", done); return true; }
            if (NEXT.matcher(t).find()) { mediaKey(ctx, KeyEvent.KEYCODE_MEDIA_NEXT, "next", done); return true; }
            if (PREVIOUS.matcher(t).find()) { mediaKey(ctx, KeyEvent.KEYCODE_MEDIA_PREVIOUS, "previous", done); return true; }
            if (RESUME.matcher(t).find()) { mediaKey(ctx, KeyEvent.KEYCODE_MEDIA_PLAY, "resume", done); return true; }
        }
        m = PLAY.matcher(t);
        if (m.matches()) {
            // no app named: videos go to YouTube, everything else to Spotify
            String what = m.group(1);
            play(ctx, what.matches(".*\\bvideos?\\b.*") ? MediaApp.YOUTUBE : MediaApp.SPOTIFY, what, cx, done);
            return true;
        }
        m = OPEN.matcher(t);
        if (m.matches() && !AURA_SCREEN.matcher(m.group(1)).matches()) { open(ctx, m.group(1), done); return true; }
        return false;
    }

    /** Whether the sentence is a media or app command (used to tell a new command from the answer to a question). */
    static boolean isCommand(String text) {
        String t = clean(text);
        if (t.isEmpty()) return false;
        if (SKIP_AD_CMD.matcher(t).matches() || CLOSE_THIS.matcher(t).matches() || CLOSE_APP.matcher(t).matches()
                || GO_BACK.matcher(t).matches() || GO_HOME.matcher(t).matches()) return true;
        if (VOLUME_UP.matcher(t).matches() || VOLUME_DOWN.matcher(t).matches() || PLAY.matcher(t).matches()
                || OPEN_AND_PLAY.matcher(t).matches() || PLAY_ON.matcher(t).matches() || ON_APP_PLAY.matcher(t).matches()
                || OPEN.matcher(t).matches()) return true;
        return !NOT_PLAYBACK.matcher(t).find() && t.split(" ").length <= 7
                && (PAUSE.matcher(t).find() || NEXT.matcher(t).find() || PREVIOUS.matcher(t).find() || RESUME.matcher(t).find());
    }

    private static String clean(String text) {
        String t = text == null ? "" : text.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9\\u0900-\\u097F' ]", " ")
                .replaceAll("\\s+", " ").trim();
        return t.replaceFirst("^(?:hey aura |aura )?(?:please |can you |could you |will you )?", "")
                .replaceFirst(" (?:please|for me)$", "").trim();
    }

    // ------------------------------------------------------------------ play something in Spotify / YouTube

    private static void play(Context ctx, MediaApp app, String what, ConversationContext cx, ActionResult.Done done) {
        if (app == null) { finish(done, ActionResult.Status.UNSUPPORTED, "play", "I can play things on Spotify and YouTube for now."); return; }
        if (ctx.getPackageManager().getLaunchIntentForPackage(app.pkg) == null) {
            finish(done, ActionResult.Status.FAILED, "play", app.label + " isn't installed on this phone.");
            return;
        }
        Context from = launcher(ctx);
        if (from == null) { finish(done, ActionResult.Status.USER_ACTION_REQUIRED, "play", needAccess()); return; }

        String query = what.replaceFirst("^(?:the |a )?(?:song|video|track)(?: of| called| named)? ", "").trim();
        final boolean anything = ANYTHING.matcher(query).matches();
        final String title = anything ? "" : query;
        // what a result's title must contain: the name itself, without "song", "video", "the"... ("kalyani song" -> "kalyani")
        String core = title.replaceAll("\\b(?:songs?|videos?|tracks?|music|full|official|the|a|an|of|by|from)\\b", " ")
                .replaceAll("\\s+", " ").trim();
        final String wanted = core.isEmpty() ? title : core;
        if (cx != null) cx.currentApp = app.label;
        if (app == MediaApp.YOUTUBE && !anything && AuraAccessibilityService.instance != null && cx != null) {
            youtube(ctx, from, title, wanted, cx, done);
            return;
        }

        // The app's own "play from search" entry point: it finds the best match and starts it. No screen taps.
        Intent search = new Intent(MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH)
                .setPackage(app.pkg)
                .putExtra(MediaStore.EXTRA_MEDIA_FOCUS, "vnd.android.cursor.item/*")
                .putExtra(SearchManager.QUERY, title)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (search.resolveActivity(ctx.getPackageManager()) == null || (anything && app == MediaApp.YOUTUBE)) {
            // nothing specific to play in YouTube, or the app has no play-from-search: just open it
            open(ctx, app.label, done);
            return;
        }
        // "play music": an empty search only shows the search page, so open the app and press its play button instead
        final Intent intent = anything ? ctx.getPackageManager().getLaunchIntentForPackage(app.pkg).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) : search;
        watch(ctx, from, app, title, wanted, anything, intent, done);
    }

    /**
     * Starts `intent` (null: the app is already showing its search results) and follows what happens until it can
     * say, truthfully, that something is playing or that it isn't.
     */
    private static void watch(Context ctx, Context from, MediaApp app, String title, String wanted, boolean anything,
                              Intent intent, ActionResult.Done done) {
        final AudioManager audio = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        final boolean wasPlaying = audio.isMusicActive();
        try {
            if (intent != null) from.startActivity(intent);
            lastMediaPkg = app.pkg;
        } catch (Exception e) {
            Log.w(TAG, "play failed: " + e.getMessage());
            finish(done, ActionResult.Status.FAILED, "play", "I couldn't open " + app.label + ".");
            return;
        }
        Log.i(TAG, "play \"" + title + "\" in " + app.pkg + " (audio already playing: " + wasPlaying + ")");
        final String named = anything ? "music" : "\"" + title + "\"";
        final long start = SystemClock.uptimeMillis();
        ui.postDelayed(new Runnable() {
            int nudges;
            int selects;
            long selectedAt;
            String selected;

            @Override
            public void run() {
                long waited = SystemClock.uptimeMillis() - start;
                String front = foreground();
                boolean inFront = front == null || front.equals(app.pkg);   // null: no way to check
                // A named song or video: the app shows its search results, and some (free Spotify) don't start the
                // top one by themselves. Select the first result that matches, through the accessibility service.
                // With media-session access the app's own playback state is read (and whether what it plays has the
                // name asked for); nothing from it is kept or logged. Without it, "some audio is playing" is all
                // there is, and YouTube's silent previews of search results count as audio, so they aren't trusted.
                List<MediaController> sessions = AuraMediaListener.sessions(ctx);
                final boolean canSee = sessions != null;
                boolean playingNow = canSee ? appPlaying(sessions, app.pkg, null) : audio.isMusicActive();
                boolean startedItself = canSee ? appPlaying(sessions, app.pkg, wanted)
                        : !wasPlaying && audio.isMusicActive() && app != MediaApp.YOUTUBE;
                if (!anything && selected == null && !startedItself && front != null && inFront && selects < 4
                        && waited >= 2500 + selects * 1500L) {
                    selects++;
                    selected = AuraAccessibilityService.instance.selectFirstMatch(app.pkg, wanted, title);
                    if (selected != null) {
                        selectedAt = SystemClock.uptimeMillis();
                        Log.i(TAG, "selected result: " + selected);
                        selected = selected.split("\\s*[|(\\[]")[0].trim();   // the short title, for speaking
                    }
                    ui.postDelayed(this, POLL_MS);
                    return;
                }
                if (selected != null) {
                    if (SystemClock.uptimeMillis() - selectedAt >= 1500 && playingNow) {
                        finish(done, ActionResult.Status.SUCCESS, "play", "Playing " + selected + " on " + app.label + ".");
                    } else if (SystemClock.uptimeMillis() - selectedAt < 7000) {
                        ui.postDelayed(this, POLL_MS);
                    } else {
                        finish(done, ActionResult.Status.FAILED, "play", "I chose " + selected + " on " + app.label + ", but it hasn't started playing.");
                    }
                    return;
                }
                if (waited >= 1500 && playingNow && inFront && (anything || startedItself || (!canSee && waited >= PLAY_WAIT_MS))) {
                    if (!canSee && (wasPlaying || front == null)) {
                        // something was already playing, or the screen can't be read: can't tell whose audio this is
                        finish(done, ActionResult.Status.UNVERIFIED, "play", "I've asked " + app.label + " to play " + named + ".");
                    } else {
                        finish(done, ActionResult.Status.SUCCESS, "play", "Playing " + named + " on " + app.label + ".");
                    }
                    return;
                }
                if (anything && inFront && nudges < 2 && waited >= (nudges == 0 ? 2000 : 5500)) {
                    // the app is open but silent: press its play button (resumes what was last playing)
                    nudges++;
                    boolean sent = keyTo(ctx, app.pkg, KeyEvent.KEYCODE_MEDIA_PLAY);
                    if (!sent) key(audio, KeyEvent.KEYCODE_MEDIA_PLAY);
                    Log.i(TAG, "pressed play for " + app.pkg + (sent ? " (its media button receiver)" : " (system media key)"));
                }
                if (waited < PLAY_WAIT_MS) { ui.postDelayed(this, POLL_MS); return; }
                if (front != null && !front.equals(app.pkg)) {
                    finish(done, locked(ctx) ? ActionResult.Status.USER_ACTION_REQUIRED : ActionResult.Status.FAILED, "play", locked(ctx)
                            ? "Your phone is locked. Unlock it and ask me again." : "I couldn't open " + app.label + ".");
                } else {
                    finish(done, ActionResult.Status.FAILED, "play", "I opened " + app.label + (anything ? "" : " and searched for " + named)
                            + ", but nothing has started playing yet. You may need to tap play.");
                }
            }
        }, POLL_MS);
    }

    // ------------------------------------------------------------------ YouTube: the exact video

    /**
     * "Play X on YouTube": search inside the YouTube app, read the video results (not channels, playlists, Shorts or
     * ads), and open the right video. When the first video's title has the name asked for, or the newest was asked
     * for, it is played straight away. When the name is only a creator or a topic, the choices are read out and
     * AURA asks which one; "the second one" / "the latest one" then picks from those results.
     */
    private static void youtube(Context ctx, Context from, String asked, String wantedIn, ConversationContext cx, ActionResult.Done done) {
        final MediaApp app = MediaApp.YOUTUBE;
        final boolean latest = LATEST.matcher(asked).find();
        final String query = !latest ? asked : LATEST.matcher(asked).replaceAll(" ").replaceAll("'s\\b", " ")
                .replaceAll("\\b(?:videos?|uploads?|of|from|by|the)\\b", " ").replaceAll("\\s+", " ").trim();
        final String wanted = latest ? query : wantedIn;
        if (query.isEmpty()) { open(ctx, app.label, done); return; }
        try {
            from.startActivity(searchIntent(app, query, latest));
            lastMediaPkg = app.pkg;
        } catch (Exception e) {
            finish(done, ActionResult.Status.FAILED, "play", "I couldn't open " + app.label + ".");
            return;
        }
        Log.i(TAG, "youtube search" + (latest ? " (newest first)" : ""));
        final long start = SystemClock.uptimeMillis();
        ui.postDelayed(new Runnable() {
            @Override
            public void run() {
                long waited = SystemClock.uptimeMillis() - start;
                AuraAccessibilityService screen = AuraAccessibilityService.instance;
                List<String> videos = screen == null ? new ArrayList<>() : screen.videoResults(app.pkg, 5);
                if (videos.isEmpty() || waited < 3000) {
                    if (waited < 9000) { ui.postDelayed(this, POLL_MS); return; }
                    // the results couldn't be read as videos: fall back to choosing the first matching item
                    watch(ctx, from, app, asked, wanted, false, null, done);
                    return;
                }
                cx.setResults(app.label, query, videos);
                if (latest || videos.size() == 1 || hasAll(videos.get(0), wanted)) {
                    playResult(ctx, cx, 0, latest, done);
                    return;
                }
                StringBuilder say = new StringBuilder("I found these on YouTube. ");
                int shown = Math.min(3, videos.size());
                for (int i = 0; i < shown; i++) say.append(i + 1).append(": ").append(shortTitle(videos.get(i))).append(". ");
                say.append("Which one do you want?");
                cx.pending = new ConversationContext.Pending(ConversationContext.Ask.CHOOSE_RESULT, null, "Which one do you want?",
                        new ArrayList<>(videos), null, SystemClock.elapsedRealtime());
                Log.i(TAG, "play -> NEEDS_ANSWER (" + videos.size() + " videos)");
                deliver(done, new ActionResult(ActionResult.Status.NEEDS_ANSWER, "play", say.toString(), true, false));
            }
        }, 1500);
    }

    private static Intent searchIntent(MediaApp app, String query, boolean newestFirst) {
        Intent intent = newestFirst
                // the app's results page, videos only, sorted by upload date
                ? new Intent(Intent.ACTION_VIEW, Uri.parse("https://www.youtube.com/results?search_query=" + Uri.encode(query) + "&sp=CAISAhAB"))
                : new Intent(Intent.ACTION_SEARCH).putExtra(SearchManager.QUERY, query);
        return intent.setPackage(app.pkg).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    }

    /** "The latest one", said after AURA listed results: search again, newest first, and play the first video. */
    static void playLatest(Context ctx, ConversationContext cx, ActionResult.Done done) {
        Context from = launcher(ctx);
        if (from == null || cx.searchQuery == null) { finish(done, ActionResult.Status.USER_ACTION_REQUIRED, "play", needAccess()); return; }
        youtube(ctx, from, "latest " + cx.searchQuery, cx.searchQuery, cx, done);
    }

    /** Opens result number `index` of the last search and checks that it is what ends up playing. */
    static void playResult(Context ctx, ConversationContext cx, int index, boolean newest, ActionResult.Done done) {
        final MediaApp app = MediaApp.YOUTUBE;   // lists of results only come from YouTube so far
        final Context from = launcher(ctx);
        if (cx.searchResults == null || index < 0 || index >= cx.searchResults.size()) {
            finish(done, ActionResult.Status.FAILED, "play", "I don't have that many results.");
            return;
        }
        if (from == null || AuraAccessibilityService.instance == null) {
            finish(done, ActionResult.Status.USER_ACTION_REQUIRED, "play", needAccess());
            return;
        }
        final String title = cx.searchResults.get(index);
        final String name = shortTitle(title);
        final String query = cx.searchQuery;
        final AudioManager audio = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        final long start = SystemClock.uptimeMillis();
        ui.post(new Runnable() {
            boolean reopened;
            long openedAt;

            @Override
            public void run() {
                long now = SystemClock.uptimeMillis();
                AuraAccessibilityService screen = AuraAccessibilityService.instance;
                if (screen == null) { finish(done, ActionResult.Status.USER_ACTION_REQUIRED, "play", needAccess()); return; }
                if (openedAt == 0) {
                    if (screen.selectVideo(app.pkg, title)) {
                        openedAt = now;
                        lastMediaPkg = app.pkg;
                    } else if (!reopened && now - start >= 1500 && query != null) {
                        // the results are no longer on screen ("play the second one instead"): show them again
                        reopened = true;
                        try { from.startActivity(searchIntent(app, query, newest)); } catch (Exception e) { /* reported below */ }
                    }
                    if (openedAt == 0 && now - start > 10000) {
                        finish(done, ActionResult.Status.FAILED, "play", "I couldn't find that video on the screen.");
                        return;
                    }
                    ui.postDelayed(this, POLL_MS);
                    return;
                }
                List<MediaController> sessions = AuraMediaListener.sessions(ctx);
                boolean playing = sessions != null ? appPlaying(sessions, app.pkg, null) : audio.isMusicActive();
                boolean exact = sessions != null && appPlaying(sessions, app.pkg, title.toLowerCase(Locale.ROOT));
                if (now - openedAt >= 1500 && (exact || (sessions == null && playing))) {
                    cx.currentVideo = title;
                    cx.currentMedia = title;
                    cx.pending = null;
                    skipAds(app.pkg);
                    if (sessions == null) {
                        finish(done, ActionResult.Status.UNVERIFIED, "play", "I opened " + name + " on " + app.label
                                + " and something is playing, but I can't confirm it's that video.");
                    } else {
                        finish(done, ActionResult.Status.SUCCESS, "play", "Playing " + name + " on " + app.label + "."
                                + (newest ? " It's the newest one I could find." : ""));
                    }
                    return;
                }
                if (now - openedAt < 9000) { ui.postDelayed(this, POLL_MS); return; }
                cx.currentVideo = title;
                if (playing) {
                    skipAds(app.pkg);
                    finish(done, ActionResult.Status.UNVERIFIED, "play", "I opened " + name + " on " + app.label
                            + ". Something is playing, but I couldn't verify it's that video yet. An ad may be playing first.");
                } else {
                    finish(done, ActionResult.Status.FAILED, "play", "I opened " + name + " on " + app.label + ", but it hasn't started playing.");
                }
            }
        });
    }

    /**
     * For a short while after a video opens, presses YouTube's own "Skip ad" button if YouTube shows one. Found by
     * its label and pressed through its click action; nothing is said about it, since a skip can't be confirmed.
     */
    /**
     * For a while after a video opens, presses YouTube's "Skip ad" whenever it appears (through YouTubeAdapter,
     * which checks each press). Silent: the user is told only when they asked ("skip the ad").
     */
    private static void skipAds(String pkg) {
        final long start = SystemClock.uptimeMillis();
        ui.postDelayed(new Runnable() {
            boolean busy;
            int skipped;

            @Override
            public void run() {
                if (SystemClock.uptimeMillis() - start > 45000 || skipped >= 2 || !YouTubeAdapter.onScreen()) return;
                if (!busy && YouTubeAdapter.adShowing()) {
                    busy = true;
                    YouTubeAdapter.skip((ok, why) -> {
                        busy = false;
                        if (ok) skipped++;
                        Log.i(TAG, "automatic skip: " + why);
                    });
                }
                ui.postDelayed(this, 1500);
            }
        }, 1500);
    }

    /** "Skip the ad": press YouTube's Skip button now, and say only what actually happened. */
    private static void skipAd(Context ctx, ActionResult.Done done) {
        if (AuraAccessibilityService.instance == null) {
            finish(done, ActionResult.Status.PERMISSION_REQUIRED, "skip_ad",
                    "I need Accessibility access to press YouTube's Skip ad button. You can turn it on in Settings, under Accessibility, AURA.");
            return;
        }
        if (!YouTubeAdapter.onScreen()) {
            finish(done, ActionResult.Status.FAILED, "skip_ad", "YouTube isn't on screen, so there's no ad for me to skip.");
            return;
        }
        YouTubeAdapter.skip((ok, why) -> {
            switch (why) {
                case "skipped": finish(done, ActionResult.Status.SUCCESS, "skip_ad", "Skipped the ad."); break;
                case "skipped_next_ad_playing": finish(done, ActionResult.Status.SUCCESS, "skip_ad", "Skipped that ad, but another one is playing."); break;
                case "not_skippable_yet": finish(done, ActionResult.Status.FAILED, "skip_ad", "The ad can't be skipped right now."); break;
                case "no_ad": finish(done, ActionResult.Status.FAILED, "skip_ad", "There's no ad playing right now."); break;
                case "not_pressable": finish(done, ActionResult.Status.FAILED, "skip_ad", "I can see the Skip button, but YouTube doesn't let me press it."); break;
                default: finish(done, ActionResult.Status.FAILED, "skip_ad", "I pressed Skip, but the ad is still playing.");
            }
        });
    }

    // ------------------------------------------------------------------ closing apps, back, home

    /**
     * "Close YouTube" / "close this app". Android doesn't let an ordinary app stop another one, so this does what
     * the platform allows: stops the app's playback (through its media session, when it is playing) and takes it
     * off the screen with the system Home button. The reply says exactly which of those happened, after checking.
     */
    private static void closeApp(Context ctx, String spoken, ConversationContext cx, ActionResult.Done done) {
        AuraAccessibilityService screen = AuraAccessibilityService.instance;
        String front = screen == null ? null : screen.foregroundPackage();
        String pkg;
        String label;
        if (spoken == null) {
            // "close this app": whatever is on screen (never assumed to be AURA)
            if (screen == null) {
                finish(done, ActionResult.Status.PERMISSION_REQUIRED, "close_app",
                        "I need Accessibility access to see which app is open and close it.");
                return;
            }
            if (front == null || AppResolver.isHomeScreen(ctx, front)) {
                finish(done, ActionResult.Status.FAILED, "close_app", "No app is open on the screen.");
                return;
            }
            pkg = front;
            label = AppResolver.label(ctx, pkg);
        } else {
            AppResolver.Resolution found = AppResolver.resolve(ctx, spoken);
            if (found.app == null) {
                finish(done, ActionResult.Status.FAILED, "close_app", found.suggestions.isEmpty()
                        ? "I couldn't find an app called " + spoken + " on this phone."
                        : "I couldn't find " + spoken + ". Did you mean " + String.join(" or ", found.suggestions) + "?");
                return;
            }
            pkg = found.app.pkg;
            label = found.app.label;
        }
        final String target = pkg;
        final String name = label;
        Log.i("AppControl", "Target app = " + name + ", package = " + target + ", current foreground package = " + front);

        // its playback, if any, is stopped first (closing Spotify should stop the music)
        List<MediaController> sessions = AuraMediaListener.sessions(ctx);
        MediaController player = null;
        if (sessions != null) for (MediaController c : sessions) if (c.getPackageName().equals(target) && isPlaying(c)) player = c;
        if (player != null) player.getTransportControls().pause();
        final MediaController stopped = player;

        final boolean onScreen = target.equals(front);
        if (onScreen) {
            boolean pressed = screen.pressSystem(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_HOME);
            Log.i("AppControl", "Close action = system Home (" + pressed + ")" + (stopped != null ? " + media pause" : ""));
        } else {
            Log.i("AppControl", "Close action = " + (stopped != null ? "media pause only (not on screen)" : "none (not on screen)"));
        }
        if (cx != null && name.equalsIgnoreCase(cx.currentApp == null ? "" : cx.currentApp)) cx.currentApp = null;

        ui.postDelayed(() -> {
            AuraAccessibilityService s2 = AuraAccessibilityService.instance;
            String after = s2 == null ? null : s2.foregroundPackage();
            boolean silent = stopped == null || !isPlaying(stopped);
            Log.i("AppControl", "Verification foreground package = " + after + ", playback stopped = " + (stopped == null ? "n/a" : silent));
            if (onScreen) {
                if (after != null && after.equals(target)) {
                    finish(done, ActionResult.Status.FAILED, "close_app", "I pressed Home, but " + name + " is still on the screen.");
                } else if (stopped != null && !silent) {
                    finish(done, ActionResult.Status.FAILED, "close_app", name + " is off the screen, but it's still playing.");
                } else {
                    finish(done, ActionResult.Status.SUCCESS, "close_app", name + " is closed" + (stopped != null ? " and its playback is stopped." : ".")
                            + " It's off the screen; Android doesn't let me shut other apps down completely.");
                }
            } else if (stopped != null) {
                if (silent) {
                    finish(done, ActionResult.Status.SUCCESS, "close_app", "I stopped " + name + "'s playback. It wasn't on the screen, so there was nothing else to close.");
                } else {
                    finish(done, ActionResult.Status.FAILED, "close_app", "I asked " + name + " to stop, but it's still playing.");
                }
            } else {
                finish(done, ActionResult.Status.UNSUPPORTED, "close_app", name + " isn't on the screen. Android doesn't let me close apps running in the background.");
            }
        }, 1200);
    }

    /** "Go back" / "go home": the phone's own Back and Home buttons, checked by whether the screen changed. */
    private static void system(Context ctx, boolean home, ActionResult.Done done) {
        AuraAccessibilityService screen = AuraAccessibilityService.instance;
        String action = home ? "go_home" : "go_back";
        if (screen == null) {
            finish(done, ActionResult.Status.PERMISSION_REQUIRED, action, "I need Accessibility access to press " + (home ? "Home" : "Back") + " for you.");
            return;
        }
        final String before = screen.screenSignature();
        boolean pressed = screen.pressSystem(home ? android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_HOME
                : android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK);
        if (!pressed) { finish(done, ActionResult.Status.FAILED, action, "The phone didn't let me press " + (home ? "Home." : "Back.")); return; }
        ui.postDelayed(() -> {
            AuraAccessibilityService s2 = AuraAccessibilityService.instance;
            String after = s2 == null ? null : s2.screenSignature();
            String front = s2 == null ? null : s2.foregroundPackage();
            if (home) {
                if (front != null && AppResolver.isHomeScreen(ctx, front)) finish(done, ActionResult.Status.SUCCESS, action, "You're on the home screen.");
                else finish(done, ActionResult.Status.UNVERIFIED, action, "I pressed Home.");
            } else if (after != null && !after.equals(before)) {
                finish(done, ActionResult.Status.SUCCESS, action, "Went back.");
            } else {
                finish(done, ActionResult.Status.UNVERIFIED, action, "I pressed Back, but the screen didn't seem to change.");
            }
        }, 900);
    }

    private static boolean hasAll(String title, String words) {
        String t = " " + title.toLowerCase(Locale.ROOT).replaceAll("[^\\p{L}\\p{N} ]", " ") + " ";
        for (String w : words.toLowerCase(Locale.ROOT).split(" ")) {
            if (!w.isEmpty() && !t.contains(w)) return false;
        }
        return true;
    }

    /** A title cut down to what is worth saying aloud. */
    private static String shortTitle(String title) {
        String t = title.split("\\s*[|(\\[]")[0].trim();
        if (t.isEmpty()) t = title.trim();
        return t.length() > 60 ? t.substring(0, 60).trim() : t;
    }

    // ------------------------------------------------------------------ media keys and volume

    private static void mediaKey(Context ctx, int code, String action, ActionResult.Done done) {
        List<MediaController> sessions = AuraMediaListener.sessions(ctx);
        if (sessions != null) { viaSession(sessions, action, done); return; }
        // no media-session access: fall back to media keys, which only reach the app that holds them
        final AudioManager audio = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        final boolean wasPlaying = audio.isMusicActive();
        if (!wasPlaying && code != KeyEvent.KEYCODE_MEDIA_PLAY) {
            finish(done, ActionResult.Status.FAILED, action, "Nothing is playing right now.");
            return;
        }
        // straight to the app AURA last started, when there is one; otherwise to whatever holds the media keys
        final boolean direct = lastMediaPkg != null && keyTo(ctx, lastMediaPkg, code);
        if (!direct) key(audio, code);
        Log.i(TAG, "media key " + action + (direct ? " -> " + lastMediaPkg : " (system)"));
        ui.postDelayed(() -> {
            boolean playing = audio.isMusicActive();
            switch (action) {
                case "pause":
                    if (!playing) { finish(done, ActionResult.Status.SUCCESS, action, "Paused."); break; }
                    // still playing: it is some other app's audio. Ask each player in turn, then look again.
                    key(audio, code);
                    for (MediaApp a : MediaApp.values()) keyTo(ctx, a.pkg, code);
                    ui.postDelayed(() -> {
                        if (!audio.isMusicActive()) finish(done, ActionResult.Status.SUCCESS, action, "Paused.");
                        else finish(done, ActionResult.Status.FAILED, action, "I pressed pause, but it's still playing.");
                    }, 1500);
                    break;
                case "resume":
                    if (playing) finish(done, ActionResult.Status.SUCCESS, action, "Playing.");
                    else finish(done, ActionResult.Status.FAILED, action, "I pressed play, but nothing started. Tell me what to play.");
                    break;
                default:
                    // the phone doesn't tell other apps which track is on, so a skip can't be confirmed from here
                    finish(done, ActionResult.Status.UNVERIFIED, action, "next".equals(action) ? "I've pressed next." : "I've pressed previous.");
            }
        }, 1500);
    }

    /**
     * Playback control through Android's media sessions (needs the user's "notification access" grant): the command
     * goes to the app that is actually playing, and the result is read back from that app's own playback state.
     */
    private static void viaSession(List<MediaController> sessions, String action, ActionResult.Done done) {
        MediaController playing = null;
        for (MediaController c : sessions) if (isPlaying(c)) { playing = c; break; }
        MediaController target = playing;
        if ("resume".equals(action)) {
            if (playing != null) { finishPrivate(done, ActionResult.Status.SUCCESS, action, "It's already playing."); return; }
            for (MediaController c : sessions) if (c.getPackageName().equals(lastMediaPkg) && isPaused(c)) { target = c; break; }
            if (target == null) for (MediaController c : sessions) if (isPaused(c)) { target = c; break; }
            if (target == null) { finishPrivate(done, ActionResult.Status.FAILED, action, "There's nothing to resume. Tell me what to play."); return; }
        } else if (target == null) {
            finishPrivate(done, ActionResult.Status.FAILED, action, "Nothing is playing right now.");
            return;
        }
        final MediaController c = target;
        final String before = title(c);
        MediaController.TransportControls controls = c.getTransportControls();
        switch (action) {
            case "pause": controls.pause(); break;
            case "resume": controls.play(); break;
            case "next": controls.skipToNext(); break;
            default: controls.skipToPrevious();
        }
        Log.i(TAG, "media session " + action);   // not which app, nor what is playing
        ui.postDelayed(() -> {
            String now = title(c);
            switch (action) {
                case "pause":
                    if (!isPlaying(c)) { finishPrivate(done, ActionResult.Status.SUCCESS, action, "Paused."); break; }
                    // A player that was only hushed while the microphone listened starts again by itself once the
                    // microphone is released, undoing a pause sent in between. Ask once more now that it has settled.
                    c.getTransportControls().pause();
                    ui.postDelayed(() -> {
                        if (!isPlaying(c)) finishPrivate(done, ActionResult.Status.SUCCESS, action, "Paused.");
                        else finishPrivate(done, ActionResult.Status.FAILED, action, "I asked it to pause, but it's still playing.");
                    }, 1500);
                    break;
                case "resume":
                    if (isPlaying(c)) finishPrivate(done, ActionResult.Status.SUCCESS, action, now.isEmpty() ? "Playing." : "Playing " + now + ".");
                    else finishPrivate(done, ActionResult.Status.FAILED, action, "I asked it to play, but it hasn't started.");
                    break;
                default:
                    // Spotify sometimes lands on the next track paused: start it
                    if (!isPlaying(c)) c.getTransportControls().play();
                    if (!now.isEmpty() && !now.equals(before)) finishPrivate(done, ActionResult.Status.SUCCESS, action, "Now playing " + now + ".");
                    else finishPrivate(done, ActionResult.Status.FAILED, action, "I asked for the " + action + " one, but it didn't change.");
            }
        }, 1800);
    }

    /** Whether `pkg` is playing right now and, when `named` is given, whether the title of what it plays has that name. */
    private static boolean appPlaying(List<MediaController> sessions, String pkg, String named) {
        for (MediaController c : sessions) {
            if (!c.getPackageName().equals(pkg) || !isPlaying(c)) continue;
            if (named == null) return true;
            MediaMetadata m = c.getMetadata();
            String t = m == null ? null : m.getString(MediaMetadata.METADATA_KEY_TITLE);
            if (t != null && t.toLowerCase(Locale.ROOT).contains(named.split(" ")[0])) return true;
        }
        return false;
    }

    private static boolean isPlaying(MediaController c) {
        PlaybackState st = c.getPlaybackState();
        return st != null && (st.getState() == PlaybackState.STATE_PLAYING || st.getState() == PlaybackState.STATE_BUFFERING);
    }

    private static boolean isPaused(MediaController c) {
        PlaybackState st = c.getPlaybackState();
        return st != null && st.getState() == PlaybackState.STATE_PAUSED;
    }

    /** What the session says is on, shortened for speaking. Empty when it doesn't say. */
    private static String title(MediaController c) {
        MediaMetadata m = c.getMetadata();
        String t = m == null ? null : m.getString(MediaMetadata.METADATA_KEY_TITLE);
        return t == null ? "" : t.split("\\s*[|(\\[]")[0].trim();
    }

    private static void key(AudioManager audio, int code) {
        long now = SystemClock.uptimeMillis();
        audio.dispatchMediaKeyEvent(new KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0));
        audio.dispatchMediaKeyEvent(new KeyEvent(now, now, KeyEvent.ACTION_UP, code, 0));
    }

    /** Sends a media key straight to one app's media-button receiver. False when the app doesn't have one. */
    private static boolean keyTo(Context ctx, String pkg, int code) {
        Intent probe = new Intent(Intent.ACTION_MEDIA_BUTTON).setPackage(pkg);
        List<ResolveInfo> receivers = ctx.getPackageManager().queryBroadcastReceivers(probe, 0);
        if (receivers.isEmpty()) return false;
        android.content.ComponentName to = new android.content.ComponentName(pkg, receivers.get(0).activityInfo.name);
        for (int action : new int[]{KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP}) {
            ctx.sendBroadcast(new Intent(Intent.ACTION_MEDIA_BUTTON).setComponent(to)
                    .putExtra(Intent.EXTRA_KEY_EVENT, new KeyEvent(SystemClock.uptimeMillis(), SystemClock.uptimeMillis(), action, code, 0)));
        }
        return true;
    }

    private static void volume(Context ctx, boolean up, ActionResult.Done done) {
        AudioManager audio = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        int before = audio.getStreamVolume(AudioManager.STREAM_MUSIC);
        int max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
        int step = Math.max(1, max / 8);
        int target = Math.max(0, Math.min(max, before + (up ? step : -step)));
        try {
            audio.setStreamVolume(AudioManager.STREAM_MUSIC, target, AudioManager.FLAG_SHOW_UI);
        } catch (SecurityException e) {   // Do Not Disturb can forbid it
            finish(done, ActionResult.Status.FAILED, "volume", "The phone didn't let me change the volume.");
            return;
        }
        int after = audio.getStreamVolume(AudioManager.STREAM_MUSIC);
        if (after == before) {
            finish(done, ActionResult.Status.FAILED, "volume", "The volume is already at its " + (up ? "highest." : "lowest."));
        } else {
            finish(done, ActionResult.Status.SUCCESS, "volume", "Volume " + (up ? "up." : "down."));
        }
    }

    // ------------------------------------------------------------------ open an app

    private static void open(Context ctx, String spoken, ActionResult.Done done) {
        AppResolver.Resolution found = AppResolver.resolve(ctx, spoken);
        Intent launch = found.app == null ? null : ctx.getPackageManager().getLaunchIntentForPackage(found.app.pkg);
        if (launch == null) {
            finish(done, ActionResult.Status.FAILED, "open", found.suggestions.isEmpty()
                    ? "I couldn't find an app called " + spoken + " on this phone."
                    : "I couldn't find " + spoken + ". Did you mean " + String.join(" or ", found.suggestions) + "?");
            return;
        }
        Context from = launcher(ctx);
        if (from == null) { finish(done, ActionResult.Status.USER_ACTION_REQUIRED, "open", needAccess()); return; }
        final String label = found.app.label;
        final String pkg = found.app.pkg;
        try {
            from.startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception e) {
            finish(done, ActionResult.Status.FAILED, "open", "I couldn't open " + label + ".");
            return;
        }
        Log.i(TAG, "open " + pkg);
        ui.postDelayed(() -> {
            String front = foreground();
            if (front == null) finish(done, ActionResult.Status.UNVERIFIED, "open", "Opening " + label + ".");
            else if (front.equals(pkg)) finish(done, ActionResult.Status.SUCCESS, "open", label + " is open.");
            else if (locked(ctx)) finish(done, ActionResult.Status.USER_ACTION_REQUIRED, "open", "Your phone is locked. Unlock it and ask me again to open " + label + ".");
            else finish(done, ActionResult.Status.FAILED, "open", "I tried to open " + label + ", but it didn't come up.");
        }, 1800);
    }

    // ------------------------------------------------------------------ what this phone lets AURA do

    /**
     * A context allowed to start another app right now. Android blocks background launches unless the app is on
     * screen, has an accessibility service running, or may draw over other apps. Null when none of those hold.
     */
    static Context launcher(Context ctx) {
        if (ctx instanceof Activity) return ctx;
        if (AuraAccessibilityService.instance != null) return AuraAccessibilityService.instance;
        return Settings.canDrawOverlays(ctx) ? ctx : null;
    }

    /** The lock screen is up: apps can't come to the front until the phone is unlocked. */
    static boolean locked(Context ctx) {
        android.app.KeyguardManager keyguard = (android.app.KeyguardManager) ctx.getSystemService(Context.KEYGUARD_SERVICE);
        return keyguard != null && keyguard.isKeyguardLocked();
    }

    static String needAccess() {
        return "To open other apps from the background I need AURA's accessibility access turned on. You can do that in AURA, on the Voice screen.";
    }

    /** The package of the app on screen, or null when it can't be read (accessibility is off). */
    private static String foreground() {
        AuraAccessibilityService s = AuraAccessibilityService.instance;
        return s == null ? null : s.foregroundPackage();
    }

    private static void finish(ActionResult.Done done, ActionResult.Status status, String action, String say) {
        Log.i(TAG, action + " -> " + status + ": " + say);
        deliver(done, new ActionResult(status, action, say, false, false));
    }

    /** As finish(), for replies built from another app's media session: only the outcome is logged, never the text. */
    private static void finishPrivate(ActionResult.Done done, ActionResult.Status status, String action, String say) {
        Log.i(TAG, action + " -> " + status);
        deliver(done, new ActionResult(status, action, say, false, true));
    }

    private static void deliver(ActionResult.Done done, ActionResult r) {
        if (Looper.myLooper() == Looper.getMainLooper()) done.onResult(r);
        else ui.post(() -> done.onResult(r));
    }
}
