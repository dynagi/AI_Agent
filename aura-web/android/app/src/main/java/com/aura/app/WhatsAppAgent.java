package com.aura.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import java.util.regex.Pattern;

/**
 * WhatsApp for a specific person: open their chat, send them a message, start a voice or video call.
 *
 * How, in order of preference: the person's own WhatsApp entries in the phone's contacts (WhatsApp publishes a
 * "message", "voice call" and "video call" entry per contact; opening one goes to exactly that person), then a
 * wa.me link for the number. WhatsApp offers no way for another app to send a message, so sending means: open the
 * chat with the text filled in, check that it is the right chat and the right text, and press WhatsApp's own Send
 * button through the accessibility service. That only happens after the user has confirmed the message.
 */
final class WhatsAppAgent {

    private static final String PKG = Capabilities.WHATSAPP;
    private static final String CHAT = "vnd.android.cursor.item/vnd.com.whatsapp.profile";
    private static final String VOICE = "vnd.android.cursor.item/vnd.com.whatsapp.voip.call";
    private static final String VIDEO = "vnd.android.cursor.item/vnd.com.whatsapp.video.call";
    private static final Pattern SEND_BUTTON = Pattern.compile("(?i)^send$");
    private static final Handler ui = new Handler(Looper.getMainLooper());
    private static final long POLL_MS = 400;

    private WhatsAppAgent() { }

    static void openChat(Context ctx, ConversationContext.Task task, ActionResult.Done done) {
        Context from = ready(ctx, Capabilities.Capability.WHATSAPP_CHAT, "whatsapp_open", done);
        if (from == null) return;
        Intent intent = chatIntent(ctx, task, null);
        if (intent == null) {
            ActionRouter.reply(done, ActionResult.Status.FAILED, "whatsapp_open", "I couldn't work out " + task.who() + "'s WhatsApp number.");
            return;
        }
        try {
            from.startActivity(intent);
        } catch (Exception e) {
            ActionRouter.reply(done, ActionResult.Status.FAILED, "whatsapp_open", "I couldn't open WhatsApp.");
            return;
        }
        final long start = SystemClock.uptimeMillis();
        ui.postDelayed(new Runnable() {
            @Override
            public void run() {
                AuraAccessibilityService screen = AuraAccessibilityService.instance;
                long waited = SystemClock.uptimeMillis() - start;
                if (screen == null) {
                    ActionRouter.remember(task, "WhatsApp");
                    ActionRouter.reply(done, ActionResult.Status.UNVERIFIED, "whatsapp_open",
                            "I've asked WhatsApp to open " + task.who() + "'s chat, but I can't see the screen to confirm it.");
                    return;
                }
                boolean inWhatsApp = PKG.equals(screen.foregroundPackage());
                if (inWhatsApp && onChatOf(screen, task)) {
                    ActionRouter.remember(task, "WhatsApp");
                    ActionRouter.cx.currentChat = task.who();
                    ActionRouter.reply(done, ActionResult.Status.SUCCESS, "whatsapp_open", "Opened " + task.who() + "'s WhatsApp chat.");
                } else if (waited < 6000) {
                    ui.postDelayed(this, POLL_MS);
                } else if (inWhatsApp) {
                    ActionRouter.remember(task, "WhatsApp");
                    ActionRouter.reply(done, ActionResult.Status.UNVERIFIED, "whatsapp_open",
                            "WhatsApp is open, but I couldn't confirm it's " + task.who() + "'s chat.");
                } else {
                    ActionRouter.reply(done, ActionResult.Status.FAILED, "whatsapp_open", "I tried to open " + task.who() + "'s WhatsApp chat, but it didn't come up.");
                }
            }
        }, 1200);
    }

    static void call(Context ctx, ConversationContext.Task task, ActionResult.Done done) {
        final String action = task.video ? "whatsapp_video_call" : "whatsapp_call";
        Context from = ready(ctx, task.video ? Capabilities.Capability.WHATSAPP_VIDEO_CALL : Capabilities.Capability.WHATSAPP_CALL, action, done);
        if (from == null) return;
        if (task.contact == null || task.contact.id < 0) {
            ActionRouter.reply(done, ActionResult.Status.UNSUPPORTED, action,
                    "I can only start WhatsApp calls with people saved in your contacts.");
            return;
        }
        Permissions.ensure(ctx, new String[]{Manifest.permission.READ_CONTACTS}, "I need access to your contacts to find "
                + task.who() + " on WhatsApp.", done, granted -> {
            Uri row = granted ? ContactsLookup.whatsAppRow(ctx, task.contact, task.video ? VIDEO : VOICE) : null;
            if (row == null) {
                ActionRouter.reply(done, ActionResult.Status.FAILED, action, "I couldn't find a WhatsApp "
                        + (task.video ? "video " : "") + "calling entry for " + task.who() + " in your contacts, so I haven't called. I can open the chat instead.");
                return;
            }
            final AudioManager audio = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
            try {
                from.startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(row, task.video ? VIDEO : VOICE)
                        .setPackage(PKG).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Exception e) {
                ActionRouter.reply(done, ActionResult.Status.FAILED, action, "WhatsApp didn't accept the call request.");
                return;
            }
            final long start = SystemClock.uptimeMillis();
            ui.postDelayed(new Runnable() {
                @Override
                public void run() {
                    // an internet call puts the phone's audio in "communication" mode
                    boolean calling = audio != null && audio.getMode() == AudioManager.MODE_IN_COMMUNICATION;
                    if (calling) {
                        ActionRouter.remember(task, "WhatsApp");
                        ActionRouter.reply(done, ActionResult.Status.SUCCESS, action,
                                (task.video ? "Video calling " : "Calling ") + task.who() + " on WhatsApp.");
                    } else if (SystemClock.uptimeMillis() - start < 8000) {
                        ui.postDelayed(this, POLL_MS);
                    } else {
                        ActionRouter.remember(task, "WhatsApp");
                        ActionRouter.reply(done, ActionResult.Status.UNVERIFIED, action,
                                "I asked WhatsApp to call " + task.who() + ", but I couldn't verify whether it started.");
                    }
                }
            }, 1000);
        });
    }

    /** Sends task.message to the person. Only called after the user said yes to the exact text. */
    static void send(Context ctx, ConversationContext.Task task, ActionResult.Done done) {
        Context from = ready(ctx, Capabilities.Capability.WHATSAPP_MESSAGING, "whatsapp_send", done);
        if (from == null) return;
        final String message = task.message.trim();
        Intent intent = chatIntent(ctx, task, message);
        if (intent == null) {
            ActionRouter.reply(done, ActionResult.Status.FAILED, "whatsapp_send", "I couldn't work out " + task.who() + "'s WhatsApp number, so nothing was sent.");
            return;
        }
        try {
            from.startActivity(intent);
        } catch (Exception e) {
            ActionRouter.reply(done, ActionResult.Status.FAILED, "whatsapp_send", "I couldn't open WhatsApp, so nothing was sent.");
            return;
        }
        final long start = SystemClock.uptimeMillis();
        ui.postDelayed(new Runnable() {
            boolean pressed;
            long pressedAt;

            @Override
            public void run() {
                AuraAccessibilityService screen = AuraAccessibilityService.instance;
                long now = SystemClock.uptimeMillis();
                if (screen == null) {
                    ActionRouter.remember(task, "WhatsApp");
                    ActionRouter.reply(done, ActionResult.Status.USER_ACTION_REQUIRED, "whatsapp_send",
                            "I've put the message in " + task.who() + "'s chat. Tap send to deliver it.");
                    return;
                }
                boolean inWhatsApp = PKG.equals(screen.foregroundPackage());
                String typed = inWhatsApp ? screen.inputText(PKG) : null;
                if (pressed) {
                    // sent = WhatsApp cleared its text box
                    if (typed != null && !same(typed, message)) {
                        ActionRouter.remember(task, "WhatsApp");
                        ActionRouter.cx.currentChat = task.who();
                        ActionRouter.reply(done, ActionResult.Status.SUCCESS, "whatsapp_send", "Sent.");
                    } else if (now - pressedAt < 4000) {
                        ui.postDelayed(this, POLL_MS);
                    } else {
                        ActionRouter.reply(done, ActionResult.Status.UNVERIFIED, "whatsapp_send",
                                "I pressed send, but I couldn't verify that the message went. Please check the chat.");
                    }
                    return;
                }
                boolean textReady = typed != null && same(typed, message);
                if (textReady && onChatOf(screen, task)) {
                    if (screen.clickLabelled(PKG, SEND_BUTTON)) {
                        pressed = true;
                        pressedAt = now;
                        ui.postDelayed(this, POLL_MS);
                        return;
                    }
                }
                if (now - start < 8000) { ui.postDelayed(this, POLL_MS); return; }
                ActionRouter.remember(task, "WhatsApp");
                if (textReady) {
                    ActionRouter.reply(done, ActionResult.Status.USER_ACTION_REQUIRED, "whatsapp_send",
                            "The message is typed in WhatsApp, but I couldn't confirm it's " + task.who() + "'s chat, so I haven't sent it. Tap send if it's right.");
                } else if (inWhatsApp) {
                    ActionRouter.reply(done, ActionResult.Status.FAILED, "whatsapp_send",
                            "WhatsApp opened, but the message didn't appear in the chat, so nothing was sent.");
                } else {
                    ActionRouter.reply(done, ActionResult.Status.FAILED, "whatsapp_send", "WhatsApp didn't open, so nothing was sent.");
                }
            }
        }, 1500);
    }

    // ------------------------------------------------------------------ shared

    /** The common checks before any WhatsApp action. Returns the context to launch from, or null after replying why not. */
    private static Context ready(Context ctx, Capabilities.Capability capability, String action, ActionResult.Done done) {
        Capabilities.Info can = Capabilities.check(ctx, capability);
        if (!Capabilities.installed(ctx, PKG)) {
            ActionRouter.reply(done, ActionResult.Status.APP_NOT_INSTALLED, action, can.reason);
            return null;
        }
        Context from = AppActions.launcher(ctx);
        if (from == null) {
            ActionRouter.reply(done, ActionResult.Status.USER_ACTION_REQUIRED, action, AppActions.needAccess());
        }
        return from;
    }

    /** Opens the person's chat: their WhatsApp contact entry when there is one and no text to fill in, else a wa.me link. */
    private static Intent chatIntent(Context ctx, ConversationContext.Task task, String text) {
        if (text == null && task.contact != null && task.contact.id >= 0 && Permissions.has(ctx, Manifest.permission.READ_CONTACTS)) {
            Uri row = ContactsLookup.whatsAppRow(ctx, task.contact, CHAT);
            if (row != null) {
                return new Intent(Intent.ACTION_VIEW).setDataAndType(row, CHAT).setPackage(PKG).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            }
        }
        String number = ContactsLookup.international(ctx, task.dial());
        if (number == null || number.isEmpty()) return null;
        String link = "https://wa.me/" + number + (text == null ? "" : "?text=" + Uri.encode(text));
        return new Intent(Intent.ACTION_VIEW, Uri.parse(link)).setPackage(PKG).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    }

    /** Whether the chat on screen shows this person's name (a dictated number can't be checked that way: assume yes). */
    private static boolean onChatOf(AuraAccessibilityService screen, ConversationContext.Task task) {
        if (task.contact == null || task.contact.id < 0) return true;
        return screen.hasText(PKG, task.contact.name);
    }

    private static boolean same(String a, String b) {
        return a.replaceAll("\\s+", " ").trim().equals(b.replaceAll("\\s+", " ").trim());
    }
}
