import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AudioLines, CalendarDays, Plane, Target, Volume2, VolumeX, ChevronRight, Mic, Wallet, ShoppingCart,
  X, Send, Sun, Radar, Workflow, Grid2x2, HelpCircle, SquareCheck, Keyboard, Settings, Lightbulb, Cpu,
} from 'lucide-react';
import { AuraAvatar, Hud, Wave, StatusBadge, VoiceVisualizer, NeonButton, Toggle, type AuraState } from '../components/aura';
import { browserVoice, serverVoice } from '../services/voice';
import { handleUtterance } from '../services/companion';
import { requestOverlayPermission, setWakeEnabled, wakeStore, wakeSupported } from '../services/wake';
import { useUser } from '../state/user';

const commands = [
  [CalendarDays, 'Plan my day'], [CalendarDays, "What's on my calendar?"], [Wallet, 'Review my budget'], [ShoppingCart, 'Find the best price for wireless earbuds'],
  [Plane, 'Plan a weekend trip'], [Target, 'Help me focus'],
] as const;

const understands = [[Sun, 'Natural Conversation'], [Radar, 'Context Awareness'], [Workflow, 'Multi-Agent Actions'], [Grid2x2, 'App Integration'], [HelpCircle, 'Follow-up Questions']] as const;

const suggested = [
  [CalendarDays, 'Plan my day'], [Plane, 'Find travel options'], [SquareCheck, 'What tasks are due today?'], [Target, 'What should I focus on?'],
] as const;

interface Line { who: 'You' | 'AURA'; text: string; t: string }

export default function Voice() {
  const nav = useNavigate();
  const user = useUser();
  const [state, setState] = useState<AuraState>('idle');
  const wake = wakeStore.use();
  const [muted, setMuted] = useState(false);
  const [draft, setDraft] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState('');
  const mutedRef = useRef(false);
  mutedRef.current = muted;
  const stopRef = useRef<(() => void) | null>(null);
  const started = useRef(Date.now());
  const stamp = () => {
    const s = Math.floor((Date.now() - started.current) / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  const turn = useRef(0);
  const respond = async (text: string) => {
    const mine = ++turn.current; // a newer command replaces this one: its reply is shown but not spoken
    serverVoice.stop();
    setState('thinking');
    setError('');
    try {
      // Same fast brain as the companion orb: simple things are understood on the phone, the rest takes one short model call.
      const reply = await handleUtterance(text, (path, opts) => nav(path, opts));
      if (mine !== turn.current) return; // a newer command replaced this one
      if (!reply) { setState('idle'); return; }
      setLines((l) => [...l, { who: 'AURA', text: reply, t: stamp() }]);
      if (mutedRef.current) { setState('idle'); return; }
      setState('speaking');
      await serverVoice.speak(reply);
      if (mine === turn.current) setState('idle');
    } catch (e) {
      if (mine !== turn.current) return;
      setState('idle');
      setError(e instanceof Error && /bearer|401/i.test(e.message) ? 'Sign in to talk to AURA.' : 'AURA could not respond right now. Please try again.');
    }
  };

  const commit = (text: string) => {
    if (!text.trim()) return;
    stopRef.current?.();
    setLines((l) => [...l, { who: 'You', text, t: stamp() }]);
    setDraft('');
    void respond(text);
  };

  const toggleListen = () => {
    if (state === 'listening') { stopRef.current?.(); if (!browserVoice.supported) setState('idle'); return; }
    setState('listening');
    setDraft('');
    if (!browserVoice.supported) return; // fallback: type into the field and press Send
    let finalText = '';
    stopRef.current = browserVoice.listen(
      (t, final) => { setDraft(t); if (final) finalText = t; },
      () => { stopRef.current = null; if (finalText) commit(finalText); else setState('idle'); },
    );
  };

  const cancel = () => { stopRef.current?.(); serverVoice.stop(); setState('idle'); setDraft(''); };
  const listening = state === 'listening';
  const status = { listening: "I'm listening…", thinking: 'Thinking…', speaking: 'Speaking…' } as Partial<Record<AuraState, string>>;

  return (
    <>
      <div className="row between wrap">
        <div className="tile row" style={{ ['--c' as string]: '14px', padding: '12px 28px', gap: 16, ['--shape' as string]: 'polygon(20px 0, calc(100% - 20px) 0, 100% 50%, calc(100% - 20px) 100%, 20px 100%, 0 50%)' }}>
          <AudioLines size={22} className="c-cyan" />
          <h1 style={{ fontFamily: 'var(--font-display)', letterSpacing: 3, fontSize: 20 }}>VOICE MODE</h1>
          <AudioLines size={22} className="c-cyan" />
        </div>
        <div className="row">
                    <button className="icon-btn" aria-label="Voice settings" onClick={() => nav('/settings')}><Settings size={18} /></button>
        </div>
      </div>

      {wakeSupported && (
        <div className="tile row" style={{ gap: 12, margin: '12px 0', padding: '12px 16px', alignItems: 'center' }}>
          <Mic size={20} className="c-cyan" />
          <div className="grow">
            <b>"Hey Aura" wake word</b>
            <div className="t-sub" style={{ fontSize: 12 }}>
              {wake.error || (wake.enabled
                ? 'On. Say "Hey Aura" from any screen, pause, then your command. A small panel answers; the app stays closed.'
                : 'Off. Turn on to call AURA by voice without opening the app (listens on this phone only).')}
            </div>
            {wake.enabled && wake.surface === null && (
              <button className="link c-blue" style={{ background: 'none', border: 0, padding: 0, fontSize: 12, textAlign: 'left' }} onClick={requestOverlayPermission}>
                The panel can't appear over other apps yet: allow "Display over other apps" (or turn on AURA in Accessibility). Until then it answers by voice only.
              </button>
            )}
          </div>
          <Toggle on={wake.enabled} label="Hey Aura wake word" onChange={(v) => void setWakeEnabled(v)} />
        </div>
      )}
      <div className="voice-grid">
        <div className="stack">
          <Hud corners title={<span className="hud-label" style={{ fontSize: 13 }}>Voice Commands</span>} icon={AudioLines}>
            <div className="list">
              {commands.map(([I, t]) => (
                <button key={t} className="li" style={{ background: 'none', border: 0, width: '100%', textAlign: 'left', fontSize: 14.5 }} onClick={() => commit(t)}>
                  <I size={18} className="c-cyan" /> “{t}”
                </button>
              ))}
            </div>
          </Hud>
          <Hud corners title={<span className="hud-label" style={{ fontSize: 13 }}>AURA Understands</span>}>
            <div className="list">
              {understands.map(([I, t]) => <div className="li" key={t} style={{ fontSize: 14.5 }}><I size={20} className="c-cyan" /> {t}</div>)}
            </div>
          </Hud>
        </div>

        <div className="voice-center">
          <AuraAvatar art="voice" size={380} height={460} square state={state} />
          <div className="hud corners mic-hex">
            <div className="row" style={{ justifyContent: 'center', gap: 12 }}>
              <Wave bars={10} idle={!listening && state !== 'speaking'} />
              <button className={`mic-btn ${listening ? 'live' : ''}`} onClick={toggleListen} aria-pressed={listening} aria-label={listening ? 'Stop listening' : 'Tap to speak'}>
                <Mic size={38} />
              </button>
              <Wave bars={10} idle={!listening && state !== 'speaking'} />
            </div>
            <div style={{ fontSize: 22, marginTop: 10, fontWeight: 600 }}>{listening ? 'Listening…' : 'Tap to Speak'}</div>
            <div className="t-sub" aria-live="polite">{status[state] ?? "I'm listening..."}</div>
            {listening && (
              <div className="input" style={{ marginTop: 12, height: 42 }}>
                <input placeholder={browserVoice.supported ? 'Speak now…' : 'Type your command'} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && commit(draft)} autoFocus={!browserVoice.supported} aria-label="Transcript" />
              </div>
            )}
          </div>
          <div className="row voice-actions" style={{ gap: 14 }}>
            <NeonButton variant="danger" onClick={cancel}><X size={22} /> Cancel</NeonButton>
            <NeonButton onClick={() => { if (!muted) serverVoice.stop(); setMuted((m) => !m); }} aria-pressed={muted}>{muted ? <VolumeX size={20} /> : <Volume2 size={20} />} {muted ? 'Muted' : 'Mute'}</NeonButton>
            <NeonButton onClick={() => nav('/chat')}><Keyboard size={20} /> Text</NeonButton>
            <NeonButton variant="success" onClick={() => commit(draft)} disabled={!draft}><Send size={20} /> Send</NeonButton>
          </div>
        </div>

        <div className="stack">
          <Hud corners title={<span className="row hud-label" style={{ fontSize: 13 }}><span className="dot cyan pulse" /> Real-time Listening</span>}>
            <VoiceVisualizer active={listening || state === 'speaking'} label={listening ? 'Listening…' : state === 'speaking' ? 'Speaking…' : 'Standby'} />
          </Hud>
          <Hud corners title={<span className="hud-label" style={{ fontSize: 13 }}>Speech</span>}>
            <div className="list">
              <div className="li"><Mic size={18} className="c-cyan" /><span className="grow">Speech-to-text</span><span className="t-sub">{browserVoice.supported ? 'Browser' : 'Unavailable here'}</span></div>
              <div className="li"><Cpu size={18} className="c-cyan" /><span className="grow">Text-to-speech</span><span className="t-sub">Server voice</span></div>
              {wakeSupported && (
                <div className="li"><Mic size={18} className="c-cyan" />
                  <span className="grow">"Hey Aura" wake word<br /><span className="t-sub" style={{ fontSize: 11.5 }}>
                    {wake.error || (wake.enabled ? 'Listening on this phone (offline). Shows a notification; uses some battery.' : 'Say "Hey Aura" from any screen, without opening the app.')}
                  </span></span>
                  <Toggle on={wake.enabled} label="Hey Aura wake word" onChange={(v) => void setWakeEnabled(v)} />
                </div>
              )}
              <button className="li" style={{ background: 'none', border: 0, width: '100%' }} onClick={() => nav('/settings')}><Settings size={18} className="c-cyan" /><span className="grow" style={{ textAlign: 'left' }}>Voice settings</span><ChevronRight size={14} /></button>
            </div>
            {!browserVoice.supported && <div className="t-mute" style={{ marginTop: 6 }}>This browser can't transcribe speech — type your command after tapping the mic.</div>}
          </Hud>
          <Hud corners title={<span className="hud-label" style={{ fontSize: 13 }}>Live Transcription</span>}>
            <div className="stack" style={{ gap: 14, maxHeight: 280, overflowY: 'auto' }}>
              {!lines.length && <div className="empty">Your conversation will appear here.</div>}
              {lines.map((l, i) => (
                <div className="row" key={i} style={{ alignItems: 'flex-start' }}>
                  {l.who === 'You' ? <div className="avatar" style={{ width: 32, height: 32, fontSize: 12 }}>{user.initials}</div> : <span className="icon-box sm round c-cyan" style={{ fontWeight: 800 }}>A</span>}
                  <div style={{ flex: 1 }}>
                    <div className="row between"><span className={l.who === 'AURA' ? 'c-cyan' : 't-sub'} style={{ fontSize: 12 }}>{l.who}</span><span className="t-mute mono">{l.t}</span></div>
                    <div style={{ fontSize: 13.5 }}>{l.text}</div>
                  </div>
                </div>
              ))}
            </div>
          </Hud>
        </div>
      </div>

      <Hud corners title={<span className="row hud-label" style={{ fontSize: 13 }}><Lightbulb size={16} /> Suggested Voice Commands</span>}>
        <div className="grid g4" style={{ gap: 10 }}>
          {suggested.map(([I, t]) => <button key={t} className="chip" style={{ padding: '13px 14px', fontSize: 13.5 }} onClick={() => commit(t)}><I size={17} /> {t}</button>)}
        </div>
      </Hud>
      {error && <div className="tag red" role="alert" style={{ padding: '8px 12px' }}>{error}</div>}
      <StatusBadge status={state === 'idle' ? 'online' : 'active'} label={state === 'idle' ? 'Ready' : state === 'thinking' ? 'AURA is thinking' : state === 'speaking' ? 'AURA is speaking' : 'Listening'} />
    </>
  );
}
