/**
 * VoiceService abstraction. Vapi / ElevenLabs providers are implemented server-side
 * (keys never ship to the browser); the browser provider below uses the Web Speech API
 * as a local fallback when available.
 */
import { Capacitor } from '@capacitor/core';
import { apiBlob } from './api';
import { speakNow, stopSpeakingNow } from './speech';
import { AuraSpeech } from '../native/speech';
import { holdWake, releaseWake } from './wake';
import { toast } from '../components/ui/primitives';

export interface VoiceService {
  readonly supported: boolean;
  listen(onText: (text: string, final: boolean) => void, onEnd: () => void): () => void;
  speak(text: string): void;
}

type SR = {
  lang: string; interimResults: boolean; continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null; onerror: (() => void) | null;
  start(): void; stop(): void;
};

const Ctor: (new () => SR) | undefined =
  typeof window !== 'undefined'
    ? ((window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: new () => SR }).webkitSpeechRecognition)
    : undefined;

const isNative = Capacitor.isNativePlatform();

/** On the phone: Android's speech recognizer (the WebView has no Web Speech API). */
function listenNative(onText: (text: string, final: boolean) => void, onEnd: () => void): () => void {
  let ended = false;
  const handles: { remove: () => Promise<void> }[] = [];
  holdWake(); // "Hey Aura" detection releases the microphone while the command is captured
  const finish = (error?: string) => {
    if (ended) return;
    ended = true;
    releaseWake();
    handles.forEach((h) => void h.remove());
    if (error && !/didn.t catch/i.test(error)) toast(error); // silence isn't worth a popup
    onEnd();
  };
  void (async () => {
    handles.push(await AuraSpeech.addListener('speechPartial', ({ text }) => onText(text, false)));
    handles.push(await AuraSpeech.addListener('speechFinal', ({ text }) => onText(text, true)));
    handles.push(await AuraSpeech.addListener('speechEnd', ({ error }) => finish(error)));
    try {
      await AuraSpeech.start({ lang: 'en-IN' });
    } catch (e) {
      finish(e instanceof Error ? e.message : 'Voice input could not start.');
    }
  })();
  return () => { void AuraSpeech.stop().catch(() => finish()); };
}

export const browserVoice: VoiceService = {
  supported: isNative || !!Ctor,
  listen(onText, onEnd) {
    serverVoice.stop(); // never listen while AURA is talking: the mic would hear AURA's own voice
    if (isNative) return listenNative(onText, onEnd);
    if (!Ctor) { onEnd(); return () => {}; }
    const rec = new Ctor();
    rec.lang = 'en-IN';
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e) => {
      const res = e.results[e.results.length - 1];
      onText(res[0].transcript, res.isFinal);
    };
    rec.onend = onEnd;
    rec.onerror = onEnd;
    rec.start();
    return () => rec.stop();
  },
  speak(text) {
    if (typeof speechSynthesis === 'undefined') return;
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  },
};

/**
 * Server-side text-to-speech (Gemini via the backend /voice/speak route; keys never reach the browser).
 * Falls back to the browser voice if the backend is unavailable. Resolves when playback ends.
 */
let currentAudio: HTMLAudioElement | null = null;
// Only the newest speak() may make sound. The audio is fetched first, which takes a moment: without this, a
// second reply (or the user tapping the mic) during that wait ends with two voices talking over each other.
let speakTurn = 0;
export const serverVoice = {
  stop() {
    stopSpeakingNow();
    speakTurn++;
    currentAudio?.pause();
    currentAudio = null;
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  },
  async speak(text: string): Promise<void> {
    this.stop();
    const turn = speakTurn;
    const trimmed = text.slice(0, 1800);
    // On the phone, speak with its own voice: it starts instantly instead of waiting for the server to generate audio.
    if (Capacitor.isNativePlatform()) { await speakNow(trimmed); return; }
    try {
      const blob = await apiBlob('/voice/speak', { text: trimmed });
      if (turn !== speakTurn) return; // superseded while the audio was being prepared
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      currentAudio = audio;
      await new Promise<void>((resolve, reject) => {
        audio.onended = () => resolve();
        audio.onerror = () => reject(new Error('Audio playback failed'));
        void audio.play().catch(reject);
      });
      URL.revokeObjectURL(url);
    } catch {
      if (turn === speakTurn) browserVoice.speak(trimmed);
    }
  },
};
