package com.aura.app;

/**
 * What every assistant action reports back: one of a fixed set of outcomes plus the sentence AURA says. SUCCESS is
 * only used when the outcome was checked on the phone (the call is up, the app is playing, the chat is on screen);
 * an action that was requested but could not be checked is UNVERIFIED and says so.
 */
final class ActionResult {

    enum Status {
        SUCCESS, UNVERIFIED, FAILED, UNSUPPORTED, PERMISSION_REQUIRED, AUTHENTICATION_REQUIRED, APP_NOT_INSTALLED,
        USER_ACTION_REQUIRED, NETWORK_ERROR, TIMEOUT, AMBIGUOUS,
        /** AURA asked the user something and is waiting for the answer. */
        NEEDS_ANSWER,
        CANCELLED
    }

    final Status status;
    final String action;
    final String say;
    /** AURA asked a question: keep listening for the reply instead of closing. */
    final boolean expectAnswer;
    /** The sentence has personal content (a contact, a number, a message, what another app is playing): never log it. */
    final boolean privateText;

    ActionResult(Status status, String action, String say, boolean expectAnswer, boolean privateText) {
        this.status = status;
        this.action = action;
        this.say = say;
        this.expectAnswer = expectAnswer;
        this.privateText = privateText;
    }

    interface Done {
        void onResult(ActionResult result);

        /** A system permission dialog is about to appear; `say` is why AURA needs it. */
        default void onPermissionPrompt(String say) { }
    }
}
