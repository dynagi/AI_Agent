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

/** A spoken command older than this is not acted on (see initWake). Long enough for the service to bring the app
 *  forward for a command that needs it (it asks the server first, which can take a few seconds). */
const STALE_MS = 40_000;

/** Ids of commands already answered in this run of the app. */
const handled = new Set<number>();

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
  const handle = AuraWake.addListener('wakeCommand', ({ id, text, at }) => {
    // Android can hold this web view asleep in the background; a command arriving long after it was spoken has
    // already been answered by the service (or timed out), so it must not be acted on now
    if (typeof at === 'number' && Date.now() - at > STALE_MS) return;
    if (handled.has(id)) return;   // the same command handed over again after the app was brought forward
    handled.add(id);
    void answer(text)
      .catch((e): WakeAnswer => ({
        say: isOffline(e)
          ? "AURA's server isn't answering. It may be waking up, so ask me again in a minute. Calls, music and opening apps still work."
          : 'Sorry, I had trouble with that. Please try again.',
      }))
      .then((a) => AuraWake.reply({ id, ...a }))
      .catch(() => undefined);
  });
  void syncWithPhone();
  // the native service starts waking the server the moment it hears "Hey Aura", before the command is spoken
  void AuraWake.configure({ apiUrl: API_URL }).catch(() => undefined);
  wakeServer();
  return () => { void handle.then((h) => h.remove()); };
}

/**
 * At start, make the listener match the setting. The phone's saved setting wins (it is what the background service
 * itself obeys); the copy in this web view is only a fallback for older builds. A service left running while the
 * setting is off is stopped; one that should run but isn't is started. Safe to call more than once.
 */
export async function syncWithPhone(): Promise<void> {
  if (!isNative) return;
  let s: WakeStatusLike | null = null;
  try { s = await AuraWake.status(); } catch { s = null; }
  const on = typeof s?.enabled === 'boolean' ? s.enabled : stored();
  if (!on) {
    if (s?.running || wakeStore.get().enabled) await setWakeEnabled(false);
    else wakeStore.set((w) => ({ ...w, enabled: false, state: 'stopped' }));
    return;
  }
  if (!s?.running) { await setWakeEnabled(true); return; }
  try { localStorage.setItem(KEY, '1'); } catch { /* private mode */ }
  wakeStore.set({ enabled: true, state: s.state, error: s.error, surface: s.surface });
}
type WakeStatusLike = Awaited<ReturnType<typeof AuraWake.status>>;

/** "Display over other apps", for the assistant panel when the accessibility service is off. */
export const requestOverlayPermission = () => { if (isNative) void AuraWake.requestOverlayPermission().catch(() => undefined); };

export async function refreshWakeStatus(): Promise<void> {
  if (!isNative) return;
  try {
    const s = await AuraWake.status();
    wakeStore.set((w) => ({ ...w, enabled: typeof s.enabled === 'boolean' ? s.enabled : w.enabled, state: s.state, error: s.error, surface: s.surface }));
  } catch { /* plugin unavailable */ }
}
