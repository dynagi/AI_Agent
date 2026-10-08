package com.aura.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Fires at a dose's scheduled time and posts the reminder notification. */
public class DoseAlarmReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String id = intent.getStringExtra("id");
        if (id == null) return;
        MedicineScheduler.showNotification(context, id, intent.getStringExtra("title"), intent.getStringExtra("body"));
    }
}
