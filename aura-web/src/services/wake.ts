import { Capacitor } from '@capacitor/core';
import { AuraWake } from '../native/wake';
import { createStore } from '../state/store';
import { API_URL, isOffline, wakeServer } from './api';

/**
 * "Hey Aura". On the phone a background service (on-device, offline) waits for the phrase, then runs the whole
 * exchange in a small overlay over whatever app is open: it listens, sends the command's text here, and shows and
 * speaks the answer. The app is not brought forward. In-app listening (the mic buttons) calls holdWake() first and
 * releaseWake() after, so the two never use the microphone at once.
 *
 * Off by default: the user turns it on (it shows a permanent notification and uses some battery). The choice is
 * remembered on this device.
 */
const isNative = Capacitor.isNativePlatform();
const KEY = 'aura.wake.enabled';
const stored = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };

export const wakeSupported = isNative;
export const wakeStore = createStore<{ enabled: boolean; state: string; error: string; surface: string | null }>(
  { enabled: isNative && stored(), state: 'stopped', error: '', surface: null });

/** The answer to a spoken command. expectAnswer: AURA asked something, keep listening. openApp: the answer is in the app. */
export interface WakeAnswer { say: string; expectAnswer?: boolean; openApp?: boolean }

let holds = 0;
let releaseTimer: number | undefined;

/** The app is taking the microphone (listening for a command, or in a conversation). */
export function holdWake(): void {
  if (!isNative) return;
  holds++;
  window.clearTimeout(releaseTimer);
  if (holds === 1) void AuraWake.pause().catch(() => undefined);
}

/** The app is done with the microphone: go back to waiting for "Hey Aura" (after a short settle). */
export function releaseWake(): void {
  if (!isNative) return;
  holds = Math.max(0, holds - 1);
  if (holds > 0) return;
  window.clearTimeout(releaseTimer);
  releaseTimer = window.setTimeout(() => {
    if (holds === 0 && wakeStore.get().enabled) void AuraWake.resume().catch(() => undefined);
  }, 700);
}

export async function setWakeEnabled(on: boolean): Promise<void> {
  if (!isNative) return;
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* private mode */ }
  if (!on) {
    await AuraWake.stop().catch(() => undefined);
    wakeStore.set((w) => ({ ...w, enabled: false, state: 'stopped', error: '' }));
    return;
  }
  try {
    const s = await AuraWake.start();
    wakeStore.set({ enabled: true, state: s.state, error: s.error, surface: s.surface });
  } catch (e) {
    try { localStorage.setItem(KEY, '0'); } catch { /* private mode */ }
    wakeStore.set((w) => ({ ...w, enabled: false, state: 'error', error: e instanceof Error ? e.message : 'Could not start "Hey Aura".' }));
  }
}

/**
 * Call once when the app shell mounts. Starts listening if the user had it on. Each command spoken after "Hey Aura"
 * arrives as text (the background service did the listening, in its overlay over whatever app is open); `answer`
 * works out the reply, which the service shows and speaks. The app itself stays in the background.
 */
export function initWake(answer: (text: string) => Promise<WakeAnswer>): () => void {
  if (!isNative) return () => {};
  const handle = AuraWake.addListener('wakeCommand', ({ id, text }) => {
    void answer(text)
      .catch((e): WakeAnswer => ({
        say: isOffline(e)
          ? "AURA's server isn't answering. It may be waking up, so ask me again in a minute. Calls, music and opening apps still work."
          : 'Sorry, I had trouble with that. Please try again.',
      }))
      .then((a) => AuraWake.reply({ id, ...a }))
      .catch(() => undefined);
  });
  if (wakeStore.get().enabled) void setWakeEnabled(true);
  // the native service starts waking the server the moment it hears "Hey Aura", before the command is spoken
  void AuraWake.configure({ apiUrl: API_URL }).catch(() => undefined);
  wakeServer();
  return () => { void handle.then((h) => h.remove()); };
}

/** "Display over other apps", for the assistant panel when the accessibility service is off. */
export const requestOverlayPermission = () => { if (isNative) void AuraWake.requestOverlayPermission().catch(() => undefined); };

export async function refreshWakeStatus(): Promise<void> {
  if (!isNative) return;
  try {
    const s = await AuraWake.status();
    wakeStore.set((w) => ({ ...w, state: s.state, error: s.error, surface: s.surface }));
  } catch { /* plugin unavailable */ }
}
