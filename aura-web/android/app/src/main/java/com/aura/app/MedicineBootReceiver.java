package com.aura.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Alarms are cleared on reboot; re-arm the stored reminders. */
public class MedicineBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        MedicineScheduler.rescheduleStored(context);
    }
}
