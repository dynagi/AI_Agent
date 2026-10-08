package com.aura.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

/** The screen assistant's phone-independent logic: what it may touch, what the user's words mean, and what it learns. */
public class ScreenLogicTest {

    private static ScreenIntents.Parsed say(String s) {
        return ScreenIntents.parse(s);
    }

    // ------------------------------------------------------------------ what AURA will never look at

    @Test
    public void bankingPaymentAndPasswordAppsAreOffLimits() {
        for (String pkg : new String[]{"com.phonepe.app", "net.one97.paytm", "com.google.android.apps.nbu.paisa.user",
                "com.sbi.SBIFreedomPlus.bank", "com.google.android.apps.walletnfcrel", "com.x8bit.bitwarden",
                "com.google.android.apps.authenticator2", "com.android.settings", "com.android.vending",
                "com.google.android.gms", "com.android.systemui", "in.zerodha.kite.trade"}) {
            assertTrue(pkg, ScreenPolicy.blocked(pkg));
        }
        assertTrue(ScreenPolicy.blocked(null));
        assertTrue(ScreenPolicy.blocked(""));
    }

    @Test
    public void everydayAppsAreAllowed() {
        for (String pkg : new String[]{"com.instagram.android", "com.whatsapp", "com.google.android.youtube", "in.swiggy.android",
                "com.amazon.mShop.android.shopping", "com.flipkart.android", "com.spotify.music", "com.google.android.apps.maps"}) {
            assertFalse(pkg, ScreenPolicy.blocked(pkg));
        }
    }

    @Test
    public void keyboardsAndLaunchersAreNotWorthLearningFrom() {
        assertTrue(ScreenPolicy.noise("com.google.android.inputmethod.latin"));
        assertTrue(ScreenPolicy.noise("com.sec.android.app.launcher"));
        assertFalse(ScreenPolicy.noise("com.instagram.android"));
    }

    @Test
    public void sendingAndBuyingAreAlwaysConfirmed() {
        assertTrue(ScreenPolicy.mustConfirm("Send", "send it"));
        assertTrue(ScreenPolicy.mustConfirm("Delete chat", "clear this"));
        assertTrue(ScreenPolicy.mustConfirm("Buy now", "buy it"));
    }

    @Test
    public void shareAndFollowAreConfirmedUnlessTheUserAskedForThem() {
        assertTrue(ScreenPolicy.mustConfirm("Share", "open the menu"));
        assertFalse(ScreenPolicy.mustConfirm("Share", "share this post"));
        assertTrue(ScreenPolicy.mustConfirm("Follow", "tap the first one"));
        assertFalse(ScreenPolicy.mustConfirm("Follow", "follow him"));
        assertFalse(ScreenPolicy.mustConfirm("Like", "like this post"));
        assertFalse(ScreenPolicy.mustConfirm("", "anything"));
    }

    // ------------------------------------------------------------------ what the user said

    @Test
    public void findThisIsAVisualSearch() {
        for (String s : new String[]{"find this", "Hey Aura, find this product", "search for this", "look this up",
                "find this on amazon", "buy this", "find similar", "find something similar", "find more like this",
                "what is this product", "where can I buy this", "how much is this", "price of this", "visual search",
                "find the red shoes on screen", "search for the lamp I'm looking at"}) {
            assertEquals(s, ScreenIntents.Kind.VISUAL_SEARCH, say(s).kind);
        }
        assertEquals("the red shoes", say("find the red shoes on screen").hint);
    }

    @Test
    public void findThisSongOrPersonIsNotAShopSearch() {
        for (String s : new String[]{"find this song", "search for this video", "find this person", "look up this contact"}) {
            assertEquals(s, ScreenIntents.Kind.NONE, say(s).kind);
        }
    }

    @Test
    public void questionsAboutTheScreenAreReadOut() {
        for (String s : new String[]{"what's on my screen", "what is on the screen", "what am I looking at", "read this screen",
                "describe the screen", "summarize this page"}) {
            assertEquals(s, ScreenIntents.Kind.DESCRIBE, say(s).kind);
        }
    }

    @Test
    public void scrollingIsRecognisedWithItsDirection() {
        assertEquals(ScreenIntents.Kind.SCROLL, say("scroll down").kind);
        assertTrue(say("scroll down").down);
        assertFalse(say("swipe up a bit").down);
        assertEquals(ScreenIntents.Kind.SCROLL, say("Aura scroll down please").kind);
    }

    @Test
    public void thingsToDoOnTheScreen() {
        for (String s : new String[]{"tap the second video", "click on subscribe", "press the search icon", "like this post",
                "follow him", "save this reel", "open the second one on this screen", "open the first video", "play the third result",
                "type red shoes in the search bar", "on this screen, open the menu", "open the menu here"}) {
            assertEquals(s, ScreenIntents.Kind.ACT, say(s).kind);
        }
        assertEquals("like this post", say("Hey Aura, like this post please").goal);
    }

    @Test
    public void ordinaryRequestsAreLeftToTheRestOfAura() {
        for (String s : new String[]{"order milk", "what's the weather here", "remind me to call mom at five", "call Rahul",
                "how was my sleep", "play some music", "open spotify", "turn off check-ins", "what is the capital of France",
                "show the next meeting", "I drank two glasses of water", "find a restaurant here"}) {
            assertEquals(s, ScreenIntents.Kind.NONE, say(s).kind);
        }
    }

    // ------------------------------------------------------------------ what a tap means

    @Test
    public void onlyFixedVerbsAreEverRecordedFromATap() {
        assertEquals("like", ActivityProfile.verbOf("Like"));
        assertNull(ActivityProfile.verbOf("Liked by rahul and others"));   // a count of likes, not the Like button
        assertNull(ActivityProfile.verbOf("Following"));
        assertEquals("comment", ActivityProfile.verbOf("Add comment"));
        assertEquals("share", ActivityProfile.verbOf("Share"));
        assertEquals("save", ActivityProfile.verbOf("Save"));
        assertEquals("send", ActivityProfile.verbOf("Send"));
        assertEquals("video_call", ActivityProfile.verbOf("Video call"));
        // a chat row, a message, a name: not a verb, so never stored
        assertNull(ActivityProfile.verbOf("Rahul Sharma"));
        assertNull(ActivityProfile.verbOf("I'll send you the money tomorrow, ok?"));
        assertNull(ActivityProfile.verbOf(""));
        assertNull(ActivityProfile.verbOf(null));
    }

    @Test
    public void topicsComeFromHashtagsAndRealWordsNotInterfaceChatter() {
        assertEquals(Arrays.asList("running", "marathon", "trailco", "training", "shoes"),
                ActivityProfile.topics("Photo by trailco. #running #marathon training shoes 2 hours ago View all 40 comments", 5));
        assertTrue(ActivityProfile.topics("like comment share view", 5).isEmpty());
        assertTrue(ActivityProfile.topics(null, 5).isEmpty());
        assertEquals(2, ActivityProfile.topics("alpha bravo charlie delta", 2).size());
    }

    // ------------------------------------------------------------------ the profile

    private static final long DAY = 86_400_000L;

    @Test
    public void appSessionsAreCountedAndCappedAtThirtyMinutes() {
        ActivityProfile p = new ActivityProfile(0);
        p.appSession("com.instagram.android", 1000, 10 * 60_000);
        p.appSession("com.instagram.android", 2000, 5 * 60 * 60_000);   // phone left on
        ActivityProfile.AppStat a = p.apps.get("com.instagram.android");
        assertEquals(2, a.opens);
        assertEquals(40 * 60_000L, a.ms);
    }

    @Test
    public void contactsKeepCountsOnly() throws Exception {
        ActivityProfile p = new ActivityProfile(0);
        p.contact("Rahul", ActivityProfile.ContactEvent.OPEN, 0);
        p.contact("Rahul", ActivityProfile.ContactEvent.MESSAGE, 0);
        p.contact("Rahul", ActivityProfile.ContactEvent.MESSAGE, 0);
        p.contact("Rahul", ActivityProfile.ContactEvent.CALL, 0);
        p.contact("   ", ActivityProfile.ContactEvent.OPEN, 0);
        p.contact(new String(new char[60]).replace((char) 0, (char) 120), ActivityProfile.ContactEvent.OPEN, 0);
        ActivityProfile.ContactStat c = p.contacts.get("Rahul");
        assertEquals(1, c.opens);
        assertEquals(2, c.messages);
        assertEquals(1, c.calls);
        assertEquals(1, p.contacts.size());
        // nothing but numbers and the name is written out
        String json = p.toJson().toString();
        assertFalse(json.contains("text"));
        assertFalse(json.contains("message\""));
    }

    @Test
    public void interestsFadeOverDaysAndDisappearWhenForgotten() {
        ActivityProfile p = new ActivityProfile(0);
        p.interests(Arrays.asList("running", "pottery"), 2);
        p.interests(Arrays.asList("running"), 1);
        assertEquals(3.0, p.interests.get("running"), 1e-9);
        p.decay(10 * DAY);
        assertEquals(3.0 * Math.pow(0.97, 10), p.interests.get("running"), 1e-9);
        p.decay(400 * DAY);
        assertTrue(p.interests.isEmpty());
    }

    @Test
    public void decayDoesNothingWithinTheSameDay() {
        ActivityProfile p = new ActivityProfile(0);
        p.interests(Arrays.asList("running"), 2);
        p.decay(DAY - 1);
        assertEquals(2.0, p.interests.get("running"), 1e-9);
    }

    @Test
    public void theProfileHasASizeLimit() {
        ActivityProfile p = new ActivityProfile(0);
        for (int i = 0; i < ActivityProfile.MAX_INTERESTS + 50; i++) p.interests(Arrays.asList("topic" + i), 1 + (i % 5));
        assertEquals(ActivityProfile.MAX_INTERESTS, p.interests.size());
        for (int i = 0; i < ActivityProfile.MAX_CONTACTS + 20; i++) p.contact("Person " + i, ActivityProfile.ContactEvent.OPEN, 0);
        assertEquals(ActivityProfile.MAX_CONTACTS, p.contacts.size());
    }

    @Test
    public void savingAndLoadingKeepsEverything() throws Exception {
        ActivityProfile p = new ActivityProfile(5);
        p.appSession("com.whatsapp", 3 * 3_600_000L, 120_000);
        p.action("com.instagram.android", "like");
        p.action("com.instagram.android", "like");
        p.contact("Priya", ActivityProfile.ContactEvent.OPEN, 3_600_000L);
        p.interests(Arrays.asList("running"), 2);
        ActivityProfile q = ActivityProfile.fromJson(new JSONObject(p.toJson().toString()), 5);
        assertEquals(5, q.since);
        assertEquals(1, q.apps.get("com.whatsapp").opens);
        assertEquals(120_000L, q.apps.get("com.whatsapp").ms);
        assertEquals(Integer.valueOf(2), q.actions.get("com.instagram.android|like"));
        assertEquals(1, q.contacts.get("Priya").opens);
        assertEquals(2.0, q.interests.get("running"), 1e-9);
    }

    @Test
    public void theSummaryRanksByUse() throws Exception {
        ActivityProfile p = new ActivityProfile(0);
        p.appSession("a", 0, 60_000);
        p.appSession("b", 0, 600_000);
        p.interests(Arrays.asList("minor"), 1);
        p.interests(Arrays.asList("major"), 5);
        JSONObject s = p.summary(5);
        assertEquals("b", s.getJSONArray("apps").getJSONObject(0).getString("pkg"));
        assertEquals("major", s.getJSONArray("interests").getString(0));
    }

    @Test
    public void whatIsToldToTheAssistantNamesNoPeople() {
        ActivityProfile p = new ActivityProfile(0);
        p.appSession("com.instagram.android", 21 * 3_600_000L, 20 * 60_000);
        p.contact("Priya Sharma", ActivityProfile.ContactEvent.MESSAGE, 0);
        p.interests(Arrays.asList("running"), 3);
        Map<String, String> labels = new HashMap<>();
        labels.put("com.instagram.android", "Instagram");
        String h = p.habits(labels, 5);
        assertTrue(h, h.contains("Instagram"));
        assertTrue(h, h.contains("running"));
        assertFalse(h, h.contains("Priya"));
    }
}
