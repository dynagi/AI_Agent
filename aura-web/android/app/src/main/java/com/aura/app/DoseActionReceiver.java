package com.aura.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Handles the Taken / Snooze buttons on a reminder notification. */
public class DoseActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String id = intent.getStringExtra("id");
        if (id == null) return;
        String action = MedicineScheduler.ACTION_SNOOZE.equals(intent.getAction()) ? "snooze" : "taken";
        MedicineScheduler.handleAction(context, id, action);
    }
}
