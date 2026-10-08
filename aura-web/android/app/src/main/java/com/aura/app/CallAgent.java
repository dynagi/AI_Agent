package com.aura.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.telecom.PhoneAccount;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;

/**
 * Phone calls: places a call to a resolved contact or dictated number on the right SIM, and ends the current call.
 * Uses Android's telecom service (the same one the dialer uses); nothing is tapped on screen. "Calling X" is only
 * said once the phone reports a call in progress, and "Call ended" only once it reports none.
 */
final class CallAgent {

    private static final String TAG = "AuraCall";
    private static final Handler ui = new Handler(Looper.getMainLooper());
    private static final long POLL_MS = 400;

    private CallAgent() { }

    static void call(Context ctx, ConversationContext.Task task, ActionResult.Done done) {
        Capabilities.Info can = Capabilities.check(ctx, Capabilities.Capability.PHONE_CALL);
        if (!can.usable()) {
            ActionRouter.reply(done, ActionResult.Status.UNSUPPORTED, "call", can.reason);
            return;
        }
        Permissions.ensure(ctx, new String[]{Manifest.permission.CALL_PHONE, Manifest.permission.READ_PHONE_STATE},
                "I need permission to make phone calls.", done, granted -> {
                    if (!granted) {
                        ActionRouter.reply(done, ActionResult.Status.PERMISSION_REQUIRED, "call",
                                "I can't place calls without the phone permission. You can allow it in Settings, under Apps, AURA, Permissions.");
                        return;
                    }
                    place(ctx, task, done);
                });
    }

    @SuppressLint("MissingPermission")
    private static void place(Context ctx, ConversationContext.Task task, ActionResult.Done done) {
        if (Build.VERSION.SDK_INT < 23) return;   // ruled out by the capability check
        final TelecomManager telecom = (TelecomManager) ctx.getSystemService(Context.TELECOM_SERVICE);
        final String number = task.dial();
        String stage = "start";   // which phone call failed, for the log (no names or numbers in it)
        try {
            if (telecom == null || number == null || number.replaceAll("\\D", "").isEmpty()) {
                ActionRouter.reply(done, ActionResult.Status.FAILED, "call", "I don't have a number to call.");
                return;
            }
            stage = "isInCall";
            if (telecom.isInCall()) {
                ActionRouter.reply(done, ActionResult.Status.FAILED, "call", "You're already on a call.");
                return;
            }
            stage = "sims";
            List<PhoneAccountHandle> sims = sims(ctx, telecom);
            if (sims.isEmpty()) {
                ActionRouter.reply(done, ActionResult.Status.FAILED, "call", "There's no SIM that can make calls right now.");
                return;
            }
            int index = 0;
            if (sims.size() > 1) {
                // a SIM named in the command, else one chosen earlier in this conversation, else the phone's default
                index = task.sim >= 0 ? task.sim : ActionRouter.cx.selectedSim;
                if (index >= sims.size()) index = -1;
                if (index < 0) {
                    index = sims.indexOf(defaultSim(telecom));
                }
                if (index < 0) {
                    ActionRouter.ask(done, task, ConversationContext.Ask.CHOOSE_SIM, "Which SIM should I use, SIM 1 or SIM 2?", null, null);
                    return;
                }
            }
            if (!task.confirmed && Confirmations.required(ctx, Confirmations.Risk.MEDIUM)) {
                ActionRouter.ask(done, task, ConversationContext.Ask.CONFIRM, "Call " + task.who() + "?", null, null);
                return;
            }
            Bundle extras = new Bundle();
            extras.putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, sims.get(index));
            stage = "placeCall";
            telecom.placeCall(Uri.fromParts("tel", number, null), extras);

            final String said = "Calling " + task.who() + (sims.size() > 1 ? " using SIM " + (index + 1) : "") + ".";
            final long start = SystemClock.uptimeMillis();
            ui.postDelayed(new Runnable() {
                @Override
                public void run() {
                    boolean up;
                    try { up = telecom.isInCall(); } catch (SecurityException e) { up = false; }
                    if (up) {
                        ActionRouter.remember(task, "Phone");
                        ActionRouter.reply(done, ActionResult.Status.SUCCESS, "call", said);
                    } else if (SystemClock.uptimeMillis() - start < 6000) {
                        ui.postDelayed(this, POLL_MS);
                    } else {
                        ActionRouter.reply(done, ActionResult.Status.FAILED, "call", "I tried to call " + task.who() + ", but the call didn't start.");
                    }
                }
            }, POLL_MS);
        } catch (SecurityException e) {
            Log.w(TAG, "call refused at " + stage + ": " + e.getMessage());
            ActionRouter.reply(done, ActionResult.Status.PERMISSION_REQUIRED, "call", "The phone didn't let me place the call.");
        }
    }

    /** The SIM the user set for calls in the phone's settings; null when it is "ask every time" or can't be read. */
    @SuppressLint("MissingPermission")
    private static PhoneAccountHandle defaultSim(TelecomManager telecom) {
        if (Build.VERSION.SDK_INT < 23) return null;
        try {
            PhoneAccountHandle h = telecom.getDefaultOutgoingPhoneAccount(PhoneAccount.SCHEME_TEL);
            if (h != null) return h;
        } catch (SecurityException e) {
            Log.w(TAG, "default SIM not readable: " + e.getMessage());
        }
        try {
            return telecom.getUserSelectedOutgoingPhoneAccount();
        } catch (SecurityException e) {
            Log.w(TAG, "user-selected SIM not readable: " + e.getMessage());
            return null;
        }
    }

    /** The SIMs that can place calls, SIM 1 first. */
    @SuppressLint("MissingPermission")
    private static List<PhoneAccountHandle> sims(Context ctx, TelecomManager telecom) {
        List<PhoneAccountHandle> found = new ArrayList<>();
        if (Build.VERSION.SDK_INT < 23) return found;
        for (PhoneAccountHandle h : telecom.getCallCapablePhoneAccounts()) {
            PhoneAccount account = null;
            try {
                account = telecom.getPhoneAccount(h);
            } catch (SecurityException e) {
                Log.w(TAG, "SIM details not readable: " + e.getMessage());
            }
            // unreadable details: count it as a SIM rather than lose it
            if (account == null || account.hasCapabilities(PhoneAccount.CAPABILITY_SIM_SUBSCRIPTION)) found.add(h);
        }
        if (found.size() < 2) return found;
        // order them by SIM slot, so "SIM 1" is the phone's SIM 1
        List<PhoneAccountHandle> bySlot = new ArrayList<>();
        try {
            SubscriptionManager subs = (SubscriptionManager) ctx.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE);
            List<SubscriptionInfo> active = subs == null ? null : subs.getActiveSubscriptionInfoList();
            if (active != null) {
                List<SubscriptionInfo> sorted = new ArrayList<>(active);
                sorted.sort((a, b) -> Integer.compare(a.getSimSlotIndex(), b.getSimSlotIndex()));
                for (SubscriptionInfo info : sorted) {
                    for (PhoneAccountHandle h : found) {
                        String id = h.getId();
                        boolean same = id != null && (id.equals(String.valueOf(info.getSubscriptionId()))
                                || (info.getIccId() != null && !info.getIccId().isEmpty() && id.startsWith(info.getIccId())));
                        if (same && !bySlot.contains(h)) bySlot.add(h);
                    }
                }
            }
        } catch (SecurityException e) {
            // keep the telecom order
        }
        if (bySlot.size() != found.size()) return found;
        return bySlot;
    }

    // ------------------------------------------------------------------ hang up

    static void end(Context ctx, ActionResult.Done done) {
        Capabilities.Info can = Capabilities.check(ctx, Capabilities.Capability.CALL_TERMINATION);
        if (!can.usable() || Build.VERSION.SDK_INT < 28) {
            ActionRouter.reply(done, ActionResult.Status.UNSUPPORTED, "end_call", can.reason);
            return;
        }
        Permissions.ensure(ctx, new String[]{Manifest.permission.ANSWER_PHONE_CALLS, Manifest.permission.READ_PHONE_STATE},
                "I need permission to manage phone calls.", done, granted -> {
                    if (!granted) {
                        ActionRouter.reply(done, ActionResult.Status.PERMISSION_REQUIRED, "end_call",
                                "I can't end calls without the phone permission.");
                        return;
                    }
                    hangUp(ctx, done);
                });
    }

    @SuppressLint("MissingPermission")
    @SuppressWarnings("deprecation")
    private static void hangUp(Context ctx, ActionResult.Done done) {
        if (Build.VERSION.SDK_INT < 28) return;
        final TelecomManager telecom = (TelecomManager) ctx.getSystemService(Context.TELECOM_SERVICE);
        try {
            if (telecom == null || !telecom.isInCall()) {
                AudioManager audio = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
                boolean internetCall = audio != null && audio.getMode() == AudioManager.MODE_IN_COMMUNICATION;
                if (internetCall) {
                    ActionRouter.reply(done, ActionResult.Status.UNSUPPORTED, "end_call",
                            "That looks like an internet call, like WhatsApp. I can only end regular phone calls.");
                } else {
                    ActionRouter.reply(done, ActionResult.Status.FAILED, "end_call", "There's no call to end.");
                }
                return;
            }
            telecom.endCall();
            final long start = SystemClock.uptimeMillis();
            ui.postDelayed(new Runnable() {
                @Override
                public void run() {
                    boolean up;
                    try { up = telecom.isInCall(); } catch (SecurityException e) { up = true; }
                    if (!up) {
                        ActionRouter.reply(done, ActionResult.Status.SUCCESS, "end_call", "Call ended.");
                    } else if (SystemClock.uptimeMillis() - start < 4000) {
                        ui.postDelayed(this, POLL_MS);
                    } else {
                        ActionRouter.reply(done, ActionResult.Status.FAILED, "end_call", "I tried to end the call, but it's still going.");
                    }
                }
            }, POLL_MS);
        } catch (SecurityException e) {
            ActionRouter.reply(done, ActionResult.Status.PERMISSION_REQUIRED, "end_call", "The phone didn't let me end the call.");
        }
    }
}
