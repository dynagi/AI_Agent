package com.aura.app;

import android.app.Activity;
import android.os.Build;
import android.os.Bundle;

/**
 * An invisible screen whose only job is to show Android's permission dialog over whatever app is open, for an
 * assistant action that needs it (see Permissions). It has no content and closes as soon as the user answers.
 */
public class PermissionActivity extends Activity {

    static final String EXTRA_PERMISSIONS = "permissions";
    static final String EXTRA_ID = "id";

    private String[] permissions;
    private int id;
    private boolean delivered;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        permissions = getIntent().getStringArrayExtra(EXTRA_PERMISSIONS);
        id = getIntent().getIntExtra(EXTRA_ID, -1);
        if (permissions == null || permissions.length == 0 || Build.VERSION.SDK_INT < 23) {
            done();
            return;
        }
        if (savedInstanceState == null) requestPermissions(permissions, 1);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] asked, int[] results) {
        super.onRequestPermissionsResult(requestCode, asked, results);
        done();
    }

    private void done() {
        if (!delivered && permissions != null) {
            delivered = true;
            Permissions.deliver(getApplicationContext(), id, permissions);
        }
        finish();
        overridePendingTransition(0, 0);
    }

    @Override
    protected void onDestroy() {
        if (isFinishing() && !delivered && permissions != null) {
            delivered = true;
            Permissions.deliver(getApplicationContext(), id, permissions);
        }
        super.onDestroy();
    }
}
