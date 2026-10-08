import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface AuraPhonePlugin {
  /** Speaks with the phone's own voice. Resolves at once; a "speechDone" event with the same id follows when it ends. */
  speak(options: { id: string; text: string; lang?: string; rate?: number }): Promise<void>;
  stopSpeaking(): Promise<void>;
  /** Opens the installed app whose name best matches; otherwise returns the closest names. */
  openApp(options: { name: string }): Promise<{ opened: boolean; label?: string; suggestions?: string[] }>;
  /** Opens the dialer with the number filled in — the user presses call. */
  dial(options: { number: string }): Promise<void>;
  addListener(eventName: 'speechDone', listenerFunc: (data: { id: string }) => void): Promise<PluginListenerHandle>;
}

/** Native counterpart: android/app/src/main/java/com/aura/app/AuraPhonePlugin.java. Rejects on web. */
export const AuraPhone = registerPlugin<AuraPhonePlugin>('AuraPhone');
