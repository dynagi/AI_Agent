package com.aura.app;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;

import java.util.ArrayList;
import java.util.List;

/**
 * The one place that turns an app's spoken name into the installed app (package + label). Well-known apps have
 * fixed packages here; anything else is found among the installed apps by name, then by sound ("Zapado" -> Zepto).
 * Other classes take package names from here instead of writing them out.
 */
final class AppResolver {

    static final String YOUTUBE = "com.google.android.youtube";
    static final String SPOTIFY = "com.spotify.music";
    static final String WHATSAPP = "com.whatsapp";

    static final class App {
        final String pkg;
        final String label;

        App(String pkg, String label) {
            this.pkg = pkg;
            this.label = label;
        }
    }

    /** Either the app, or (when nothing matched well enough) up to three names it might have been. */
    static final class Resolution {
        final App app;
        final List<String> suggestions;

        Resolution(App app, List<String> suggestions) {
            this.app = app;
            this.suggestions = suggestions;
        }
    }

    private AppResolver() { }

    static Resolution resolve(Context ctx, String spoken) {
        String name = AuraPhonePlugin.alias(AuraPhonePlugin.norm(spoken));
        PackageManager pm = ctx.getPackageManager();
        String known = known(name);
        if (known != null && pm.getLaunchIntentForPackage(known) != null) return new Resolution(new App(known, label(ctx, known)), new ArrayList<>());

        List<ResolveInfo> apps = pm.queryIntentActivities(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0);
        ResolveInfo best = null;
        int bestScore = 0;
        List<String> close = new ArrayList<>();
        for (ResolveInfo ri : apps) {
            if (ri.activityInfo.packageName.equals(ctx.getPackageName())) continue;
            String label = String.valueOf(ri.loadLabel(pm));
            int s = AuraPhonePlugin.score(AuraPhonePlugin.norm(label), name);
            if (s > 0 && close.size() < 3 && !close.contains(label)) close.add(label);
            if (s > bestScore) { bestScore = s; best = ri; }
        }
        if (bestScore < 2) {
            // nothing spelled like it: speech recognition may have misheard the name ("open Zapado" for Zepto).
            // Use an app whose name sounds the same, but only when exactly one does.
            ResolveInfo sounds = null;
            int alike = 0;
            for (ResolveInfo ri : apps) {
                if (ri.activityInfo.packageName.equals(ctx.getPackageName())) continue;
                String label = String.valueOf(ri.loadLabel(pm));
                if (!SoundsLike.alike(name, label)) continue;
                if (sounds == null || !sounds.activityInfo.packageName.equals(ri.activityInfo.packageName)) alike++;
                sounds = ri;
                if (!close.contains(label)) close.add(0, label);
            }
            if (alike == 1) { best = sounds; bestScore = 2; }
        }
        if (best == null || bestScore < 2) return new Resolution(null, close);
        return new Resolution(new App(best.activityInfo.packageName, String.valueOf(best.loadLabel(pm))), close);
    }

    private static String known(String name) {
        String n = name.replace(" ", "");
        switch (n) {
            case "youtube": case "yt": return YOUTUBE;
            case "spotify": return SPOTIFY;
            case "whatsapp": case "whatsup": return WHATSAPP;
            default: return null;
        }
    }

    /** The app's name as the phone shows it; the package name if it can't be read. */
    static String label(Context ctx, String pkg) {
        try {
            PackageManager pm = ctx.getPackageManager();
            return String.valueOf(pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)));
        } catch (Exception e) {
            return pkg;
        }
    }

    /** Whether `pkg` is a home screen (launcher): "close this app" on the home screen has nothing to close. */
    static boolean isHomeScreen(Context ctx, String pkg) {
        Intent home = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME);
        for (ResolveInfo ri : ctx.getPackageManager().queryIntentActivities(home, 0)) {
            if (ri.activityInfo != null && ri.activityInfo.packageName.equals(pkg)) return true;
        }
        return false;
    }
}
