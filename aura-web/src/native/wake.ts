import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface WakeStatus {
  running: boolean;
  /** The "Hey Aura" setting as saved on the phone (survives restarts; the service refuses to listen when it is off). */
  enabled?: boolean;
  /** stopped | loading | listening | paused | error */
  state: string;
  error: string;
  /** How the assistant panel can be drawn over other apps: null = it can't (the assistant is voice-only). */
  surface: 'accessibility' | 'overlay' | null;
}

/** What the user said after the wake phrase; answer it with reply({id, ...}). */
export interface WakeCommand { id: number; text: string; /** when it was heard (ms since epoch) */ at?: number }

export interface AuraWakePlugin {
  /** Asks for the microphone (and notification) permission, then starts the background "Hey Aura" listener. */
  start(): Promise<WakeStatus>;
  stop(): Promise<void>;
  /** The app is about to use the microphone itself: the wake listener lets go of it. */
  pause(): Promise<void>;
  resume(): Promise<void>;
  status(): Promise<WakeStatus>;
  /** The answer to a wakeCommand: shown in the overlay and spoken. expectAnswer keeps listening for the user's reply. */
  reply(options: { id: number; say: string; expectAnswer?: boolean; openApp?: boolean }): Promise<void>;
  /** What the assistant can do on this phone right now, keyed by capability (PHONE_CALL, WHATSAPP_MESSAGING, ...). */
  capabilities(): Promise<Record<string, { state: string; reason: string }>>;
  /** Where AURA's server is: the service calls its /health when the wake phrase is heard, to wake a sleeping host. */
  configure(options: { apiUrl: string }): Promise<void>;
  /** Opens Android's "Display over other apps" setting for AURA. */
  requestOverlayPermission(): Promise<void>;
  addListener(eventName: 'wakeCommand', listenerFunc: (command: WakeCommand) => void): Promise<PluginListenerHandle>;
}

/**
 * Native (Android) wake word and voice assistant — see android/app/src/main/java/com/aura/app/WakeWordService.java.
 * Detection is offline and on the phone (Vosk); only the phrase "Hey Aura" is recognised. On the phrase the service
 * shows a small overlay over the current app, captures the command and sends its text here as `wakeCommand`; the
 * app is never brought to the front. Not available on the web or iOS.
 */
export const AuraWake = registerPlugin<AuraWakePlugin>('AuraWake');
