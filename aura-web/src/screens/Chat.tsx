import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CalendarCheck, ShoppingCart, Plane, Wallet, ChevronRight, Mic, Send, Search, Volume2, Trash2, Target } from 'lucide-react';
import { AuraAvatar, Hud, Wave, ChatMessage, SyncStatus, AgentAvatar } from '../components/aura';
import { aura } from '../services/aura';
import { serverVoice } from '../services/voice';
import { orderDestination } from '../services/orderFlow';
import { buildUserContext } from '../state/context';
import { agentById } from '../data/agents';
import { useUser } from '../state/user';
import { createRecordStore, uid } from '../state/store';

interface ChatRecord { id: string; role: 'user' | 'aura' | 'error'; text: string; ts: string; agents?: string[] }
/** Conversation history, persisted per user. */
const chatStore = createRecordStore<ChatRecord>('chat');

const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };

const suggestions = [
  { icon: CalendarCheck, t: 'Plan my day' },
  { icon: Wallet, t: 'Review my budget this month' },
  { icon: ShoppingCart, t: 'Find the best laptop under 60000' },
  { icon: Plane, t: 'Plan a 3 day trip to Goa' },
  { icon: Target, t: 'What should I focus on this week?' },
  { icon: Search, t: 'Find recent papers on agentic AI' },
];

export default function Chat() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const user = useUser();
  const history = chatStore.use();
  const [pending, setPending] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [speaking, setSpeaking] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const handledQ = useRef(false);
  const busy = pending !== null;

  const intro = useMemo(() => `${greeting()}, ${user.name}! 👋\nI can look at your tasks, calendar and spending, compare live prices, and plan trips. What would you like to do?`, [user.name]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [history, pending]);

  const send = async (text: string) => {
    const msg = text.trim();
    if (!msg || busy) return;
    // "order milk" etc. is handled by the shopping assistant (store choice, variants, cart fill), not the general chat model.
    const dest = orderDestination(msg);
    if (dest) { nav(dest, { state: { ask: msg } }); return; }
    chatStore.set((h) => [...h, { id: uid('cm'), role: 'user', text: msg, ts: new Date().toISOString() }]);
    setPending(msg);
    try {
      const reply = await aura.chat(msg, buildUserContext());
      chatStore.set((h) => [...h, { id: uid('cm'), role: 'aura', text: reply.text, ts: new Date().toISOString(), agents: reply.agents }]);
    } catch (e) {
      const needsLogin = e instanceof Error && /bearer|401/i.test(e.message);
      chatStore.set((h) => [...h, { id: uid('cm'), role: 'error', ts: new Date().toISOString(), text: needsLogin ? 'Please sign in to chat with AURA.' : 'AURA AI reasoning is temporarily unavailable. Your saved tasks and calendar are still accessible.' }]);
    } finally {
      setPending(null);
    }
  };

  useEffect(() => {
    const q = params.get('q');
    if (q && !handledQ.current) {
      handledQ.current = true;
      setParams({}, { replace: true });
      void send(q);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (e: FormEvent) => { e.preventDefault(); const t = input; setInput(''); void send(t); };
  const listen = async (m: ChatRecord) => {
    if (speaking === m.id) { serverVoice.stop(); setSpeaking(null); return; }
    setSpeaking(m.id);
    await serverVoice.speak(m.text);
    setSpeaking((s) => (s === m.id ? null : s));
  };

  return (
    <>
      <div className="row between wrap">
        <div>
          <h1 style={{ fontSize: 32 }}>AI Chat</h1>
          <p className="t-sub" style={{ fontSize: 15 }}>Talk, Plan, Decide, and Do with AURA</p>
        </div>
        <div className="row">
          <div className="tile row hide-sm" style={{ padding: '6px 14px' }}>
            <span className="dot pulse cyan" />
            <div><div className="hud-label" style={{ color: '#fff', fontSize: 9.5 }}>{busy ? 'AURA is thinking' : 'AURA Online'}</div><Wave bars={12} idle={!busy} /></div>
          </div>
                    <button className="icon-btn" aria-label="Clear conversation" title="Clear conversation" disabled={!history.length} onClick={() => chatStore.set([])}><Trash2 size={18} /></button>
                  </div>
      </div>

      <div className="stack" style={{ gap: 18, flex: 1 }} aria-live="polite">
        <ChatMessage role="aura">
          <div className="hud" style={{ whiteSpace: 'pre-line', display: 'inline-block', fontSize: 15 }}>{intro}</div>
          {!history.length && (
            <div className="hud" style={{ marginTop: 12 }}>
              <div style={{ marginBottom: 12, fontWeight: 600 }}>Here are some things you can ask me:</div>
              <div className="grid g2" style={{ gap: 8 }}>
                {suggestions.map((s) => (
                  <button key={s.t} className="chip" style={{ justifyContent: 'flex-start', padding: '11px 12px', fontSize: 13.5 }} onClick={() => void send(s.t)}>
                    <s.icon size={17} /> <span style={{ flex: 1, textAlign: 'left' }}>{s.t}</span> <ChevronRight size={15} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </ChatMessage>

        {history.map((m) => {
          if (m.role === 'user') return <ChatMessage key={m.id} role="user" time={clock(m.ts)}>{m.text}</ChatMessage>;
          if (m.role === 'error') return <ChatMessage key={m.id} role="aura" time={clock(m.ts)}><div className="hud tag red" style={{ whiteSpace: 'pre-line', display: 'inline-block', fontSize: 15 }} role="alert">{m.text}</div></ChatMessage>;
          return (
            <ChatMessage key={m.id} role="aura" time={clock(m.ts)}>
              <div className="hud" style={{ whiteSpace: 'pre-line', display: 'inline-block', fontSize: 15 }}>
                {m.text}
                <div className="row wrap" style={{ marginTop: 12, gap: 8 }}>
                  <button className="btn sm" onClick={() => void listen(m)} aria-pressed={speaking === m.id}><Volume2 size={14} /> {speaking === m.id ? 'Stop' : 'Listen'}</button>
                  {(m.agents ?? []).map((id) => {
                    const a = agentById(id);
                    return a ? <span key={id} className="tag" style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}><AgentAvatar tone={a.tone} size={16} /> {a.name}</span> : null;
                  })}
                </div>
              </div>
            </ChatMessage>
          );
        })}

        {busy && (
          <ChatMessage role="aura">
            <Hud corners>
              <div className="row wrap" style={{ gap: 18, alignItems: 'center' }}>
                <AuraAvatar art="android" size={90} state="thinking" float={false} />
                <div>
                  <div className="row t-sub"><span className="spinner" /> AURA is consulting the right agents…</div>
                  <div className="t-mute" style={{ marginTop: 4 }}>Looking at: “{pending}”</div>
                </div>
              </div>
            </Hud>
          </ChatMessage>
        )}
        <SyncStatus stores={[chatStore]} />
        <div ref={endRef} />
      </div>

      <form className="hud corners row" onSubmit={submit} style={{ position: 'sticky', bottom: 12, gap: 12, padding: 12, zIndex: 5 }}>
        <div className="input" style={{ flex: 1, height: 54 }}>
          <input placeholder="Ask AURA anything..." value={input} onChange={(e) => setInput(e.target.value)} aria-label="Message AURA" style={{ fontSize: 15 }} />
          <button type="button" aria-label="Dictate" onClick={() => nav('/voice')}><Mic size={19} /></button>
        </div>
        <button type="button" className="mic-btn" style={{ width: 58, height: 58 }} aria-label="Voice mode" onClick={() => nav('/voice')}><Mic size={24} /></button>
        <button className="icon-btn" aria-label="Send message" disabled={busy || !input.trim()} style={{ width: 50, height: 50 }}>{busy ? <span className="spinner" /> : <Send size={20} />}</button>
      </form>
    </>
  );
}


