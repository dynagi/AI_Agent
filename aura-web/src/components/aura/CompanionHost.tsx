import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Mic, Volume2, Loader2, X, BellOff } from 'lucide-react';
import { Toggle } from '../ui';
import { budgetsStore, commitmentsStore, companionPrefsStore, dayLogsStore, doseLogsStore, goalsStore, mealsStore, medicinesStore, moneyPrefsStore, transactionsStore } from '../../state/stores';
import { wakeServer } from '../../services/api';
import { useUser } from '../../state/user';
import { answerWake, companionStore, dueCheckIn, isBusy, runCheckIn, savePrefs, setCompanionName, talk, DEFAULT_COMPANION_PREFS } from '../../services/companion';
import { initWake } from '../../services/wake';

const TICK_MS = 30_000;

/**
 * Mounted once in the app shell. It is AURA's presence: an always-visible mic orb (tap to talk) and the scheduler that
 * speaks first — water, meals, medicine, sleep, mood — whenever the app is open. On/off and "mute for an hour" live in
 * its panel. (Voice while the app is closed needs a background service; see the note in the panel.)
 */
export default function CompanionHost() {
  const nav = useNavigate();
  const loc = useLocation();
  const user = useUser();
  const st = companionStore.use();
  const prefsList = companionPrefsStore.use();
  const prefs = { ...DEFAULT_COMPANION_PREFS, ...prefsList[0] };
  // .map (not .every) so every store's hook runs on every render.
  const loaded = [companionPrefsStore, medicinesStore, doseLogsStore, mealsStore, dayLogsStore].map((s) => s.useMeta().status === 'ready').every(Boolean);
  // money questions by voice are answered from these, so load them now rather than when Finance is first opened
  [transactionsStore, commitmentsStore, moneyPrefsStore, goalsStore, budgetsStore].map((s) => s.use());
  const [open, setOpen] = useState(false);
  const navRef = useRef(nav);
  navRef.current = nav;

  useEffect(() => { if (user.signedIn) setCompanionName(user.name); }, [user.signedIn, user.name]);

  // a free server host sleeps when idle: start waking it as soon as AURA is opened or brought back
  useEffect(() => {
    wakeServer();
    const onShow = () => { if (document.visibilityState === 'visible') wakeServer(); };
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
  }, []);

  // "Hey Aura": the background service listens and shows its own small overlay over whatever app is open; this
  // only works out the answer to what was said. The app stays in the background.
  useEffect(() => {
    if (!user.signedIn) return;
    return initWake((text) => answerWake(text, (path, opts) => navRef.current(path, opts)));
  }, [user.signedIn]);

  // Speak first: look for a due check-in every TICK_MS while the app is on screen.
  useEffect(() => {
    if (!loaded || !user.signedIn) return;
    const tick = () => {
      if (document.visibilityState !== 'visible' || isBusy() || companionStore.get().phase !== 'idle') return;
      const c = dueCheckIn();
      if (c) void runCheckIn(c, (path, opts) => navRef.current(path, opts));
    };
    const first = window.setTimeout(tick, 4000); // shortly after opening, so "good morning" greets you
    const t = window.setInterval(tick, TICK_MS);
    return () => { window.clearTimeout(first); window.clearInterval(t); };
  }, [loaded, user.signedIn]);

  if (!user.signedIn || loc.pathname.startsWith('/voice')) return null;

  const busy = st.phase !== 'idle';
  const paused = !!prefs.pausedUntil && new Date(prefs.pausedUntil).getTime() > Date.now();
  const Icon = st.phase === 'speaking' ? Volume2 : st.phase === 'thinking' ? Loader2 : Mic;
  const label = { idle: paused || !prefs.enabled ? 'Tap to talk (check-ins are off)' : 'Tap to talk to AURA', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking — tap to stop' }[st.phase];

  return (
    <>
      <style>{`@keyframes aura-orb{0%{box-shadow:0 0 0 0 rgba(0,209,255,.55)}70%{box-shadow:0 0 0 16px rgba(0,209,255,0)}100%{box-shadow:0 0 0 0 rgba(0,209,255,0)}}@keyframes aura-spin{to{transform:rotate(360deg)}}`}</style>
      {(busy && (st.said || st.heard)) && (
        <div role="status" aria-live="polite" style={{ position: 'fixed', right: 16, bottom: 'calc(env(safe-area-inset-bottom) + 150px)', zIndex: 60, maxWidth: 'min(320px, calc(100vw - 32px))', background: 'rgba(11,15,26,.96)', border: '1px solid var(--aura-border-mid, #1b3350)', borderRadius: 14, padding: '10px 14px', fontSize: 14, lineHeight: 1.4, color: '#fff' }}>
          {st.phase === 'listening' || st.phase === 'thinking' ? <span style={{ opacity: .85 }}>{st.heard || 'Listening…'}</span> : <span>{st.said}</span>}
        </div>
      )}
      {open && (
        <div role="dialog" aria-label="AURA companion" style={{ position: 'fixed', right: 16, bottom: 'calc(env(safe-area-inset-bottom) + 150px)', zIndex: 61, width: 'min(300px, calc(100vw - 32px))', background: 'rgba(11,15,26,.98)', border: '1px solid var(--aura-border-mid, #1b3350)', borderRadius: 16, padding: 14, color: '#fff' }}>
          <div className="row between" style={{ marginBottom: 8 }}>
            <b>AURA companion</b>
            <button className="icon-btn bare" style={{ width: 26, height: 26 }} onClick={() => setOpen(false)} aria-label="Close"><X size={16} /></button>
          </div>
          <div className="row between" style={{ marginBottom: 10 }}>
            <span className="t-sub" style={{ fontSize: 13 }}>Speak first: water, meals, medicine, mood</span>
            <Toggle on={prefs.enabled && !paused} onChange={(v) => savePrefs({ enabled: v, pausedUntil: undefined })} label="Check-ins" />
          </div>
          <button className="btn sm block" onClick={() => { savePrefs({ pausedUntil: new Date(Date.now() + 3_600_000).toISOString() }); setOpen(false); }}><BellOff size={14} /> Mute for 1 hour</button>
          <p className="t-sub" style={{ fontSize: 11.5, marginTop: 10, marginBottom: 0 }}>
            Quiet {prefs.quietStart}–{prefs.quietEnd}. AURA speaks and listens while the app is open. Try: “I drank water”, “I took my tablet”, “open WhatsApp”, “order milk”.
          </p>
          {st.error && <p className="c-red" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>{st.error}</p>}
        </div>
      )}
      <div style={{ position: 'fixed', right: 16, bottom: 'calc(env(safe-area-inset-bottom) + 88px)', zIndex: 60, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button onClick={() => setOpen((o) => !o)} aria-label="Companion settings" title="Companion settings" style={{ width: 32, height: 32, borderRadius: '50%', border: '1px solid var(--aura-border-mid, #1b3350)', background: 'rgba(11,15,26,.9)', color: '#9fb6d1', fontSize: 14, cursor: 'pointer' }}>⚙</button>
        <button
          onClick={() => void talk((path, opts) => navRef.current(path, opts))}
          aria-label={label} title={label}
          style={{ width: 56, height: 56, borderRadius: '50%', border: '1.5px solid #00d1ff', background: busy ? 'linear-gradient(135deg,#00d1ff,#7a5cff)' : 'rgba(11,15,26,.95)', color: busy ? '#031020' : '#00d1ff', display: 'grid', placeItems: 'center', cursor: 'pointer', animation: st.phase === 'listening' ? 'aura-orb 1.4s infinite' : undefined }}
        >
          <Icon size={24} style={st.phase === 'thinking' ? { animation: 'aura-spin 1s linear infinite' } : undefined} />
        </button>
      </div>
    </>
  );
}
