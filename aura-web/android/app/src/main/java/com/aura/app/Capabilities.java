package com.aura.app;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.provider.Settings;

/**
 * The one answer to "can AURA do this on this phone, right now?". Every agent asks here before acting instead of
 * keeping its own feasibility rules. This is the Android adapter; another platform would supply its own check().
 */
final class Capabilities {

    enum Capability {
        WAKE_WORD, BACKGROUND_MICROPHONE, ASSISTANT_OVERLAY, APP_LAUNCH, SPOTIFY_CONTROL, YOUTUBE_CONTROL,
        GLOBAL_MEDIA_CONTROL, PHONE_CALL, CALL_TERMINATION, DUAL_SIM_SELECTION, WHATSAPP_CHAT, WHATSAPP_MESSAGING,
        WHATSAPP_CALL, WHATSAPP_VIDEO_CALL, ACCESSIBILITY_AUTOMATION, DEEP_LINKS, SYSTEM_ASSISTANT, BACKGROUND_EXECUTION
    }

    enum State { SUPPORTED, SUPPORTED_WITH_PERMISSION, SUPPORTED_WITH_LIMITATIONS, REQUIRES_USER_ACTION, UNSUPPORTED, REQUIRES_RESEARCH }

    static final class Info {
        final State state;
        /** Why, in words that can be said to the user. Empty for plain SUPPORTED. */
        final String reason;

        Info(State state, String reason) {
            this.state = state;
            this.reason = reason;
        }

        boolean usable() {
            return state != State.UNSUPPORTED && state != State.REQUIRES_RESEARCH;
        }
    }

    static final String WHATSAPP = AppResolver.WHATSAPP;
    static final String SPOTIFY = AppResolver.SPOTIFY;
    static final String YOUTUBE = AppResolver.YOUTUBE;

    private Capabilities() { }

    static Info check(Context ctx, Capability c) {
        boolean access = AuraAccessibilityService.instance != null;
        boolean overlay = Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(ctx);
        boolean telephony = ctx.getPackageManager().hasSystemFeature(PackageManager.FEATURE_TELEPHONY);
        switch (c) {
            case WAKE_WORD:
                return Permissions.has(ctx, Manifest.permission.RECORD_AUDIO) ? ok()
                        : new Info(State.SUPPORTED_WITH_PERMISSION, "The microphone permission is needed.");
            case BACKGROUND_MICROPHONE:
                return new Info(State.SUPPORTED_WITH_LIMITATIONS,
                        "Android requires a visible notification while I listen, and silences my microphone during phone calls.");
            case ASSISTANT_OVERLAY:
                return access || overlay ? ok() : new Info(State.REQUIRES_USER_ACTION,
                        "Turn on AURA's accessibility access, or allow it to display over other apps.");
            case APP_LAUNCH:
            case DEEP_LINKS:
                return access || overlay ? ok() : new Info(State.REQUIRES_USER_ACTION,
                        "To open other apps from the background I need AURA's accessibility access turned on.");
            case SPOTIFY_CONTROL:
                return media(ctx, SPOTIFY, "Spotify", access);
            case YOUTUBE_CONTROL:
                return media(ctx, YOUTUBE, "YouTube", access);
            case GLOBAL_MEDIA_CONTROL:
                return AuraMediaListener.sessions(ctx) != null ? ok() : new Info(State.SUPPORTED_WITH_LIMITATIONS,
                        "Without notification access I can only press the media keys, and can't see what is playing.");
            case PHONE_CALL:
                if (!telephony || Build.VERSION.SDK_INT < 23) return new Info(State.UNSUPPORTED, "This device can't place phone calls for me.");
                return Permissions.has(ctx, Manifest.permission.CALL_PHONE, Manifest.permission.READ_PHONE_STATE) ? ok()
                        : new Info(State.SUPPORTED_WITH_PERMISSION, "The phone permission is needed.");
            case CALL_TERMINATION:
                if (!telephony || Build.VERSION.SDK_INT < 28) return new Info(State.UNSUPPORTED, "This Android version doesn't let me end calls.");
                return new Info(State.SUPPORTED_WITH_LIMITATIONS, "I can end regular phone calls, not internet calls such as WhatsApp.");
            case DUAL_SIM_SELECTION:
                return telephony && Build.VERSION.SDK_INT >= 23 ? ok() : new Info(State.UNSUPPORTED, "This device can't choose a SIM for a call.");
            case WHATSAPP_CHAT:
                return installed(ctx, WHATSAPP) ? ok() : new Info(State.UNSUPPORTED, "WhatsApp isn't installed on this phone.");
            case WHATSAPP_MESSAGING:
                if (!installed(ctx, WHATSAPP)) return new Info(State.UNSUPPORTED, "WhatsApp isn't installed on this phone.");
                return access ? new Info(State.SUPPORTED_WITH_LIMITATIONS, "WhatsApp has no send API: I type the message in the chat and press its send button, after you confirm.")
                        : new Info(State.REQUIRES_USER_ACTION, "Without accessibility access I can put the message in the chat, but you have to press send.");
            case WHATSAPP_CALL:
            case WHATSAPP_VIDEO_CALL:
                if (!installed(ctx, WHATSAPP)) return new Info(State.UNSUPPORTED, "WhatsApp isn't installed on this phone.");
                return new Info(State.SUPPORTED_WITH_LIMITATIONS, "Only for people saved in your contacts who are on WhatsApp.");
            case ACCESSIBILITY_AUTOMATION:
                return access ? ok() : new Info(State.REQUIRES_USER_ACTION, "Turn on AURA under Settings, Accessibility.");
            case SYSTEM_ASSISTANT:
                return new Info(State.REQUIRES_RESEARCH, "AURA isn't registered as the phone's default assistant app.");
            case BACKGROUND_EXECUTION:
                return new Info(State.SUPPORTED_WITH_LIMITATIONS, "Android can stop AURA if the app is swiped away or the battery saver is strict.");
            default:
                return new Info(State.REQUIRES_RESEARCH, "");
        }
    }

    static boolean installed(Context ctx, String pkg) {
        return ctx.getPackageManager().getLaunchIntentForPackage(pkg) != null;
    }

    private static Info media(Context ctx, String pkg, String label, boolean access) {
        if (!installed(ctx, pkg)) return new Info(State.UNSUPPORTED, label + " isn't installed on this phone.");
        return access ? ok() : new Info(State.SUPPORTED_WITH_LIMITATIONS,
                "Without accessibility access I can open " + label + "'s search, but can't choose a result.");
    }

    private static Info ok() {
        return new Info(State.SUPPORTED, "");
    }
}
