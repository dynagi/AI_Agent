/**
 * Microphone control: the "Hey Aura" setting decides whether the background listener runs, the phone's saved
 * setting wins at start, and nothing AURA does on its own (check-ins) opens the microphone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// the code under test uses `window` timers and localStorage
const g = globalThis as unknown as { window: typeof globalThis; localStorage: Storage };
g.window = globalThis;
const mem = new Map<string, string>();
g.localStorage = {
  getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k), clear: () => mem.clear(), key: () => null, length: 0,
} as Storage;

const native = {
  status: vi.fn(), start: vi.fn(), stop: vi.fn(), pause: vi.fn(), resume: vi.fn(), configure: vi.fn(),
  reply: vi.fn(), addListener: vi.fn(), requestOverlayPermission: vi.fn(),
};
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true }, registerPlugin: () => ({}) }));
vi.mock('../native/wake', () => ({ AuraWake: native }));
vi.mock('./api', () => ({ API_URL: 'https://example.test', isOffline: () => false, wakeServer: vi.fn() }));

const running = (enabled: boolean | undefined, isRunning: boolean) =>
  native.status.mockResolvedValue({ running: isRunning, enabled, state: isRunning ? 'listening' : 'stopped', error: '', surface: 'accessibility' });

async function freshWake() {
  vi.resetModules();
  return import('./wake');
}

beforeEach(() => {
  mem.clear();
  for (const f of Object.values(native)) f.mockReset();
  native.start.mockResolvedValue({ running: true, state: 'loading', error: '', surface: 'accessibility' });
  native.stop.mockResolvedValue(undefined);
  native.pause.mockResolvedValue(undefined);
  native.resume.mockResolvedValue(undefined);
  native.configure.mockResolvedValue(undefined);
  native.addListener.mockResolvedValue({ remove: vi.fn() });
});

describe('"Hey Aura" setting controls the background listener', () => {
  it('is not started when the setting is off at startup', async () => {
    running(false, false);
    const w = await freshWake();
    await w.syncWithPhone();
    expect(native.start).not.toHaveBeenCalled();
    expect(w.wakeStore.get().enabled).toBe(false);
  });

  it('stays off after a restart even if the app copy of the setting says on', async () => {
    mem.set('aura.wake.enabled', '1');   // stale copy in the web view
    running(false, false);                // the phone's saved setting: off
    const w = await freshWake();
    await w.syncWithPhone();
    expect(native.start).not.toHaveBeenCalled();
    expect(w.wakeStore.get().enabled).toBe(false);
  });

  it('stops a listener left running while the setting is off', async () => {
    running(false, true);
    const w = await freshWake();
    await w.syncWithPhone();
    expect(native.stop).toHaveBeenCalledTimes(1);
    expect(native.start).not.toHaveBeenCalled();
  });

  it('starts when the setting is on and nothing is running', async () => {
    running(true, false);
    const w = await freshWake();
    await w.syncWithPhone();
    expect(native.start).toHaveBeenCalledTimes(1);
    expect(w.wakeStore.get().enabled).toBe(true);
  });

  it('does not start a second listener when one is already running', async () => {
    running(true, true);
    const w = await freshWake();
    await w.syncWithPhone();
    await w.syncWithPhone();   // duplicate startup call
    expect(native.start).not.toHaveBeenCalled();
  });

  it('switching off stops the listener and later mic releases do not restart it', async () => {
    vi.useFakeTimers();
    running(true, true);
    const w = await freshWake();
    await w.syncWithPhone();
    w.holdWake();                       // the app's mic button starts
    await w.setWakeEnabled(false);      // user turns "Hey Aura" off meanwhile
    w.releaseWake();                    // the mic button finishes
    await vi.advanceTimersByTimeAsync(2000);
    expect(native.stop).toHaveBeenCalled();
    expect(native.resume).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('after the app used the microphone, resumes only while the setting is on', async () => {
    vi.useFakeTimers();
    running(true, true);
    const w = await freshWake();
    await w.syncWithPhone();
    w.holdWake();
    w.releaseWake();
    await vi.advanceTimersByTimeAsync(1000);
    expect(native.pause).toHaveBeenCalledTimes(1);
    expect(native.resume).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('an older build with no saved phone setting falls back to the app copy', async () => {
    mem.set('aura.wake.enabled', '0');
    running(undefined, false);
    const w = await freshWake();
    await w.syncWithPhone();
    expect(native.start).not.toHaveBeenCalled();
  });
});

describe('commands from the background service', () => {
  it('a command that reaches the app long after it was spoken is not acted on', async () => {
    running(false, false);
    let deliver: ((c: { id: number; text: string; at?: number }) => void) | undefined;
    native.addListener.mockImplementation(async (_e: string, cb: typeof deliver) => { deliver = cb; return { remove: vi.fn() }; });
    const w = await freshWake();
    const answer = vi.fn().mockResolvedValue({ say: 'ok' });
    w.initWake(answer);
    await vi.waitFor(() => expect(deliver).toBeDefined());
    deliver!({ id: 1, text: 'order milk', at: Date.now() - 5 * 60_000 });   // heard five minutes ago
    deliver!({ id: 2, text: 'what time is it', at: Date.now() });
    await vi.waitFor(() => expect(answer).toHaveBeenCalledTimes(1));
    expect(answer).toHaveBeenCalledWith('what time is it');
  });
});

describe('AURA never opens the microphone on its own', () => {
  it('a check-in question is spoken but not listened for', async () => {
    vi.resetModules();
    const listen = vi.fn(() => () => {});
    vi.doMock('./voice', () => ({ browserVoice: { supported: true, listen } }));
    vi.doMock('./speech', () => ({ speakNow: vi.fn().mockResolvedValue(undefined), stopSpeakingNow: vi.fn() }));
    const store = () => ({ get: () => [], set: vi.fn(), use: () => [], useMeta: () => ({ status: 'ready' }) });
    vi.doMock('../state/stores', () => ({
      budgetsStore: store(), commitmentsStore: store(), companionPrefsStore: store(), dayLogsStore: store(), doseLogsStore: store(),
      eventsStore: store(), goalsStore: store(), mealsStore: store(), medicinesStore: store(), moneyPrefsStore: store(),
      tasksStore: store(), transactionsStore: store(),
    }));
    for (const m of ['./aura', './medicine', './orderFlow', './shopping', './extension', '../native/phone', '../native/screen', './moneyVoice']) {
      vi.doMock(m, () => ({ aura: {}, recordDose: vi.fn(), parseDoseId: vi.fn(), orderDestination: vi.fn(), shopAssist: vi.fn(),
        startQuickCart: vi.fn(), AuraPhone: {}, AuraScreen: {}, moneyByVoice: vi.fn() }));
    }
    vi.useFakeTimers();
    const companion = await import('./companion');
    const done = companion.runCheckIn({ kind: 'water', question: 'Shall we have a glass of water now?' }, vi.fn());
    await vi.advanceTimersByTimeAsync(2000);   // the short pause after speaking
    await done;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listen).not.toHaveBeenCalled();
    expect(companion.companionStore.get().prompt).toBe('Shall we have a glass of water now?');
    expect(companion.companionStore.get().phase).toBe('idle');
    vi.useRealTimers();
  });
});
