package com.aura.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AuraCartAssistantPlugin.class);
        registerPlugin(AuraMedicinePlugin.class);
        registerPlugin(AuraPhonePlugin.class);
        registerPlugin(AuraScreenPlugin.class);
        registerPlugin(AuraSpeechPlugin.class);
        registerPlugin(AuraWakePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
