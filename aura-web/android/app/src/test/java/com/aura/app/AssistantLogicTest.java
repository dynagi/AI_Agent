package com.aura.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.List;

/** The assistant's phone-independent logic: understanding sentences, replies, contacts and conversation context. */
public class AssistantLogicTest {

    private static Intents.Parsed parse(String said) {
        return Intents.parse(Intents.tidy(said));
    }

    // ------------------------------------------------------------------ calls

    @Test
    public void callByName() {
        Intents.Parsed p = parse("Hey Aura, call Rahul.");
        assertEquals(Intents.Type.CALL, p.type);
        assertEquals("rahul", p.name);
        assertEquals(-1, p.sim);
    }

    @Test
    public void callNamesTheSim() {
        Intents.Parsed p = parse("call Rahul Sharma using SIM 2");
        assertEquals(Intents.Type.CALL, p.type);
        assertEquals("rahul sharma", p.name);
        assertEquals(1, p.sim);
    }

    @Test
    public void callADictatedNumber() {
        Intents.Parsed p = parse("call 98765 43210");
        assertEquals(Intents.Type.CALL, p.type);
        assertNull(p.name);
        assertEquals("9876543210", p.number);
    }

    @Test
    public void callHimUsesThePronoun() {
        Intents.Parsed p = parse("call him");
        assertEquals(Intents.Type.CALL, p.type);
        assertTrue(p.pronoun);
    }

    @Test
    public void callMeIsNotACall() {
        assertEquals(Intents.Type.NONE, parse("call me").type);
    }

    @Test
    public void hangUpPhrases() {
        for (String s : new String[]{"hang up", "cut the call", "end the call", "disconnect", "stop the call"}) {
            assertEquals(s, Intents.Type.END_CALL, parse(s).type);
        }
    }

    // ------------------------------------------------------------------ WhatsApp

    @Test
    public void openSomeonesWhatsApp() {
        for (String s : new String[]{"Open Rahul's WhatsApp", "open Rahul's WhatsApp chat", "open the chat with Rahul"}) {
            Intents.Parsed p = parse(s);
            assertEquals(s, Intents.Type.WA_OPEN, p.type);
            assertEquals(s, "rahul", p.name);
        }
    }

    @Test
    public void openHisWhatsApp() {
        Intents.Parsed p = parse("open his WhatsApp");
        assertEquals(Intents.Type.WA_OPEN, p.type);
        assertTrue(p.pronoun);
    }

    @Test
    public void openWhatsAppAloneIsJustAnApp() {
        assertEquals(Intents.Type.NONE, parse("open WhatsApp").type);
        assertEquals(Intents.Type.NONE, parse("open my WhatsApp").type);
    }

    @Test
    public void sendHimKeepsTheMessageAsSpoken() {
        Intents.Parsed p = parse("Send him I'll reach in 10 minutes.");
        assertEquals(Intents.Type.WA_MESSAGE, p.type);
        assertTrue(p.pronoun);
        assertEquals("I'll reach in 10 minutes", p.message);
    }

    @Test
    public void tellHimThat() {
        Intents.Parsed p = parse("tell him that I am running late");
        assertEquals(Intents.Type.WA_MESSAGE, p.type);
        assertEquals("I am running late", p.message);
    }

    @Test
    public void messageWithoutTextAsksLater() {
        Intents.Parsed p = parse("Message Rahul");
        assertEquals(Intents.Type.WA_MESSAGE, p.type);
        assertEquals("rahul", p.name);
        assertNull(p.message);
        p = parse("send Rahul a WhatsApp message");
        assertEquals(Intents.Type.WA_MESSAGE, p.type);
        assertEquals("rahul", p.name);
    }

    @Test
    public void tellNameIsLooseUntilAContactMatches() {
        Intents.Parsed p = parse("tell Rahul I'll be late");
        assertEquals(Intents.Type.WA_MESSAGE, p.type);
        assertTrue(p.loose);
        assertEquals("rahul", p.name);
        assertEquals("I'll be late", p.message);
        assertEquals(Intents.Type.NONE, parse("tell me a joke").type);
    }

    @Test
    public void whatsAppCalls() {
        Intents.Parsed p = parse("Call Rahul on WhatsApp");
        assertEquals(Intents.Type.WA_CALL, p.type);
        assertEquals("rahul", p.name);
        assertFalse(p.video);
        p = parse("Video call Rahul on WhatsApp");
        assertEquals(Intents.Type.WA_CALL, p.type);
        assertTrue(p.video);
        p = parse("WhatsApp call Rahul");
        assertEquals(Intents.Type.WA_CALL, p.type);
        p = parse("audio call Rahul");
        assertEquals(Intents.Type.WA_CALL, p.type);
        assertFalse(p.video);
    }

    @Test
    public void mediaCommandsAreNotPeopleIntents() {
        for (String s : new String[]{"play Kesariya on Spotify", "pause", "next song", "open Spotify", "order milk", "volume up"}) {
            assertEquals(s, Intents.Type.NONE, parse(s).type);
        }
    }

    // ------------------------------------------------------------------ replies to AURA's questions

    @Test
    public void simReplies() {
        assertEquals(1, Intents.sim("SIM 2"));
        assertEquals(1, Intents.sim("sim two"));
        assertEquals(1, Intents.sim("the second sim"));
        assertEquals(0, Intents.sim("sim one"));
        assertEquals(0, Intents.sim("first"));
        assertEquals(-1, Intents.sim("I don't know"));
    }

    @Test
    public void yesNoCancelAndDontKnow() {
        assertTrue(Intents.yes("Yes"));
        assertTrue(Intents.yes("send it"));
        assertTrue(Intents.yes("yes please"));
        assertFalse(Intents.yes("yesterday I called him"));
        assertTrue(Intents.no("No"));
        assertTrue(Intents.no("don't send it"));
        assertFalse(Intents.no("now"));
        assertTrue(Intents.cancel("never mind"));
        assertTrue(Intents.dontKnow("I don't know"));
        assertTrue(Intents.dontKnow("no idea"));
        assertFalse(Intents.dontKnow("it's 9876543210"));
    }

    @Test
    public void dictatedNumber() {
        assertEquals("9876543210", Intents.digits("it's 98765 43210"));
        assertEquals("+919876543210", Intents.digits("+91 98765 43210"));
        assertNull(Intents.digits("SIM 2"));
        assertNull(Intents.digits("I don't know"));
    }

    // ------------------------------------------------------------------ contacts

    private static ContactMatcher.Entry c(long id, String name, String number) {
        return new ContactMatcher.Entry(id, name, number, false, true);
    }

    @Test
    public void oneRahulIsUsedWithoutAsking() {
        List<ContactMatcher.Entry> all = Arrays.asList(c(1, "Rahul Sharma", "9876500001"), c(2, "Priya", "9876500002"));
        List<ContactMatcher.Entry> found = ContactMatcher.match(all, "rahul");
        assertEquals(1, found.size());
        assertEquals("Rahul Sharma", found.get(0).name);
    }

    @Test
    public void severalRahulsAreAllReturnedSoAuraAsks() {
        List<ContactMatcher.Entry> all = Arrays.asList(c(1, "Rahul Sharma", "9876500001"), c(2, "Rahul Verma", "9876500002"),
                c(3, "Rahul Kumar", "9876500003"), c(4, "Priya", "9876500004"));
        assertEquals(3, ContactMatcher.match(all, "rahul").size());
        assertEquals(1, ContactMatcher.match(all, "rahul verma").size());
    }

    @Test
    public void exactNameBeatsLongerNames() {
        List<ContactMatcher.Entry> all = Arrays.asList(c(1, "Rahul", "9876500001"), c(2, "Rahul Verma", "9876500002"));
        List<ContactMatcher.Entry> found = ContactMatcher.match(all, "Rahul");
        assertEquals(1, found.size());
        assertEquals(1, found.get(0).id);
    }

    @Test
    public void nobodyMatchesMeansEmpty() {
        assertTrue(ContactMatcher.match(Arrays.asList(c(1, "Priya", "9876500001")), "rahul").isEmpty());
    }

    @Test
    public void oneContactWithTwoNumbersIsOnePerson() {
        List<ContactMatcher.Entry> all = Arrays.asList(
                new ContactMatcher.Entry(1, "Rahul", "0221234567", false, false),
                new ContactMatcher.Entry(1, "Rahul", "+91 98765 00001", false, true),
                new ContactMatcher.Entry(7, "Rahul", "9876500001", false, true));   // the same person synced twice
        List<ContactMatcher.Entry> found = ContactMatcher.match(all, "rahul");
        assertEquals(1, found.size());
        assertEquals("9876500001", ContactMatcher.tail(found.get(0).number));
    }

    // ------------------------------------------------------------------ conversation context

    @Test
    public void ordinalsPickFromAList() {
        assertEquals(1, ConversationContext.ordinal("the second one", 3));
        assertEquals(1, ConversationContext.ordinal("play the second one instead", 3));
        assertEquals(0, ConversationContext.ordinal("first", 3));
        assertEquals(2, ConversationContext.ordinal("number three", 3));
        assertEquals(2, ConversationContext.ordinal("the last one", 3));
        assertEquals(-1, ConversationContext.ordinal("the fifth one", 3));
        assertEquals(-1, ConversationContext.ordinal("pause", 3));
    }

    @Test
    public void optionsCanBePickedByName() {
        List<String> names = Arrays.asList("Rahul Sharma", "Rahul Verma", "Rahul Kumar");
        assertEquals(1, ConversationContext.byName("Verma", names));
        assertEquals(2, ConversationContext.byName("I mean Rahul Kumar", names));
        assertEquals(-1, ConversationContext.byName("Rahul", names));   // still ambiguous
        assertEquals(-1, ConversationContext.byName("Suresh", names));
    }

    @Test
    public void pendingQuestionIsTakenOnceAndExpires() {
        ConversationContext cx = new ConversationContext();
        cx.touch(1000);
        cx.pending = new ConversationContext.Pending(ConversationContext.Ask.CHOOSE_SIM, new ConversationContext.Task(), "Which SIM?", null, null, 1000);
        assertNotNull(cx.takePending(2000));
        assertNull(cx.takePending(2000));
        cx.pending = new ConversationContext.Pending(ConversationContext.Ask.CHOOSE_SIM, new ConversationContext.Task(), "Which SIM?", null, null, 1000);
        assertNull(cx.takePending(1000 + ConversationContext.PENDING_MS + 1));
    }

    @Test
    public void contextIsForgottenAfterSilence() {
        ConversationContext cx = new ConversationContext();
        cx.touch(1000);
        cx.currentContact = c(1, "Rahul", "9876500001");
        cx.selectedSim = 1;
        cx.touch(1000 + 60_000);
        assertNotNull(cx.currentContact);
        cx.touch(1000 + 60_000 + ConversationContext.IDLE_RESET_MS + 1);
        assertNull(cx.currentContact);
        assertEquals(-1, cx.selectedSim);
    }

    @Test
    public void taskSpeaksAndDialsTheResolvedContact() {
        ConversationContext.Task task = new ConversationContext.Task();
        task.name = "rahul";
        task.contact = c(1, "Rahul Sharma", "+919876500001");
        assertEquals("Rahul Sharma", task.who());
        assertEquals("+919876500001", task.dial());
    }

    // ------------------------------------------------------------------ names that sound alike

    @Test
    public void misheardAppNamesSoundAlike() {
        assertTrue(SoundsLike.alike("zapado", "Zepto"));
        assertTrue(SoundsLike.alike("zepto", "Zepto"));
        assertTrue(SoundsLike.alike("blink it", "Blinkit"));
        assertTrue(SoundsLike.alike("swigy", "Swiggy"));
        assertTrue(SoundsLike.alike("you tube", "YouTube"));
    }

    @Test
    public void differentAppsDoNotSoundAlike() {
        assertFalse(SoundsLike.alike("zapado", "Spotify"));
        assertFalse(SoundsLike.alike("zepto", "Zomato"));
        assertFalse(SoundsLike.alike("swiggy", "Spotify"));
        assertFalse(SoundsLike.alike("maps", "Messages"));
    }
}
