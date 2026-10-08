package com.aura.app;

import android.content.ComponentName;
import android.content.Context;
import android.media.session.MediaController;
import android.media.session.MediaSessionManager;
import android.service.notification.NotificationListenerService;

import java.util.List;

/**
 * Exists so AURA may use Android's media-session API: the system only lists other apps' media sessions (what is
 * playing, in which app, with pause / next controls) for an app whose notification listener the user has turned on
 * under Settings > Notifications > Notification access. AURA does not read or keep any notification; this class has
 * no code that looks at them.
 */
public class AuraMediaListener extends NotificationListenerService {

    /** The phone's media sessions, most recently active first, or null when the user hasn't granted the access. */
    static List<MediaController> sessions(Context ctx) {
        try {
            MediaSessionManager manager = (MediaSessionManager) ctx.getSystemService(Context.MEDIA_SESSION_SERVICE);
            return manager.getActiveSessions(new ComponentName(ctx, AuraMediaListener.class));
        } catch (SecurityException e) {
            return null;
        }
    }
}
