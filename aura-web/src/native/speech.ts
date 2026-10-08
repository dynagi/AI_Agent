import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface AuraSpeechPlugin {
  available(): Promise<{ available: boolean }>;
  /** Asks for the microphone permission the first time, then starts listening. */
  start(options?: { lang?: string }): Promise<void>;
  stop(): Promise<void>;
  addListener(eventName: 'speechPartial' | 'speechFinal', listenerFunc: (data: { text: string }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'speechEnd', listenerFunc: (data: { error?: string }) => void): Promise<PluginListenerHandle>;
}

/**
 * Native (Android) speech-to-text — see android/app/src/main/java/com/aura/app/AuraSpeechPlugin.java.
 * The Web Speech API isn't available inside an Android WebView, so on the phone voice input uses Android's
 * SpeechRecognizer through this plugin.
 */
export const AuraSpeech = registerPlugin<AuraSpeechPlugin>('AuraSpeech');
