import { Capacitor } from '@capacitor/core';
import { AuraPhone } from '../native/phone';

const isNative = Capacitor.isNativePlatform();

let seq = 0;
const waiting = new Map<string, () => void>();
let listening = false;

function ensureListener() {
  if (listening || !isNative) return;
  listening = true;
  void AuraPhone.addListener('speechDone', ({ id }) => { waiting.get(id)?.(); waiting.delete(id); });
}

/** Devanagari text is spoken with the Hindi voice, everything else with Indian English. */
export const langFor = (text: string) => (/[ऀ-ॿ]/.test(text) ? 'hi-IN' : 'en-IN');

/**
 * Speaks `text` and resolves when it has finished. On Android this uses the phone's own text-to-speech, which starts
 * instantly (no network, no waiting for audio to be generated); in a browser it uses the Web Speech API.
 */
export function speakNow(text: string): Promise<void> {
  const clean = text.replace(/[*_#`]/g, '').trim();
  if (!clean) return Promise.resolve();
  if (isNative) {
    ensureListener();
    const id = `u${++seq}`;
    return new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => { waiting.delete(id); resolve(); }, 30_000 + clean.length * 80);
      waiting.set(id, () => { window.clearTimeout(timer); resolve(); });
      void AuraPhone.speak({ id, text: clean, lang: langFor(clean) }).catch(() => { window.clearTimeout(timer); waiting.delete(id); resolve(); });
    });
  }
  if (typeof speechSynthesis === 'undefined') return Promise.resolve();
  return new Promise<void>((resolve) => {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = langFor(clean);
    u.onend = () => resolve();
    u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}

export function stopSpeakingNow() {
  if (isNative) {
    void AuraPhone.stopSpeaking().catch(() => undefined);
    waiting.forEach((done) => done());
    waiting.clear();
  } else if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
}
