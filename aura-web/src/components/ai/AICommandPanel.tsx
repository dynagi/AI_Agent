import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Sparkles, Mic, Send, X, Check, RotateCcw, type LucideIcon } from 'lucide-react';
import { browserVoice } from '../../services/voice';
import { toast } from '../ui';

/* ---------- Types ---------- */

export interface AIAction {
  label: string;
  variant?: 'primary' | 'default' | 'danger';
  /** Runs the change. Return a message to show as AURA's follow-up, or a full reply (with its own buttons) to ask the next question. */
  run?: () => string | AIReply | void | Promise<string | AIReply | void>;
}
export interface AIReply {
  text: string;
  /** Preview of the exact changes an action will make (shown before confirmation). */
  preview?: string[];
  actions?: AIAction[];
}
export type AIHandler = (prompt: string) => AIReply | Promise<AIReply>;

/** Standard confirm / cancel pair for anything that modifies data. */
export function confirmActions(confirmLabel: string, run: () => string | void): AIAction[] {
  return [
    { label: confirmLabel, variant: 'primary', run },
    { label: 'Cancel', variant: 'default', run: () => 'Okay — nothing was changed.' },
  ];
}

interface Msg { id: number; role: 'user' | 'aura'; text: string; reply?: AIReply; resolved?: boolean; streaming?: boolean }

/* ---------- Streaming text ---------- */
function useStream(full: string, active: boolean, onDone: () => void) {
  const [n, setN] = useState(active ? 0 : full.length);
  useEffect(() => {
    if (!active) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { setN(full.length); onDone(); return; }
    const t = setInterval(() => setN((x) => {
      if (x >= full.length) { clearInterval(t); onDone(); return x; }
      return Math.min(full.length, x + 3);
    }), 18);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, full]);
  return full.slice(0, n);
}

function AuraMessage({ m, onAction, onStreamed }: { m: Msg; onAction: (m: Msg, a: AIAction) => void; onStreamed: (id: number) => void }) {
  const shown = useStream(m.text, !!m.streaming, () => onStreamed(m.id));
  return (
    <div className="ai-msg aura">
      <span className="ai-dot" aria-hidden><Sparkles size={12} /></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p>{shown}{m.streaming && <span className="caret" aria-hidden />}</p>
        {!m.streaming && m.reply?.preview && (
          <ul className="ai-preview">{m.reply.preview.map((p) => <li key={p}>{p}</li>)}</ul>
        )}
        {!m.streaming && m.reply?.actions && !m.resolved && (
          <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
            {m.reply.actions.map((a) => (
              <button key={a.label} className={`btn sm ${a.variant === 'primary' ? 'primary' : a.variant === 'danger' ? 'danger' : ''}`} onClick={() => onAction(m, a)}>
                {a.variant === 'primary' ? <Check size={13} /> : a.label === 'Cancel' ? <X size={13} /> : null} {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- Panel ---------- */

export default function AICommandPanel({
  title, badge = 'Beta', icon: Icon = Sparkles, description, prompts, promptStyle = 'list', onAsk,
  cta = 'Talk to AURA', ctaIcon: CtaIcon = Mic, placeholder = 'Ask AURA…', textarea, header, footer, initialOpen = false, trigger,
}: {
  title: string;
  badge?: string | null;
  icon?: LucideIcon;
  description?: ReactNode;
  prompts: string[];
  /** 'list' = quoted lines (Wellness/Memory); 'boxes' = bordered prompt tiles (Travel/Research); 'bullets' = shopping style */
  promptStyle?: 'list' | 'boxes' | 'bullets';
  onAsk: AIHandler;
  cta?: string;
  ctaIcon?: LucideIcon;
  placeholder?: string;
  /** Show a multi-line composer inline (Automation Hub) */
  textarea?: boolean;
  header?: ReactNode;
  footer?: ReactNode;
  initialOpen?: boolean;
  /** Send a prompt programmatically (e.g. from a Quick Action). Change `id` to re-trigger. */
  trigger?: { prompt: string; id: number } | null;
}) {
  const [open, setOpen] = useState(initialOpen || !!textarea);
  const [input, setInput] = useState('');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [thinking, setThinking] = useState(false);
  const [listening, setListening] = useState(false);
  const idRef = useRef(1);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' }); }, [msgs, thinking]);

  const ask = async (text: string) => {
    const q = text.trim();
    if (!q || thinking) return;
    setOpen(true);
    setInput('');
    setMsgs((m) => [...m, { id: idRef.current++, role: 'user', text: q }]);
    setThinking(true);
    try {
      const [reply] = await Promise.all([Promise.resolve(onAsk(q)), new Promise((r) => setTimeout(r, 650))]);
      setMsgs((m) => [...m, { id: idRef.current++, role: 'aura', text: reply.text, reply, streaming: true }]);
    } catch {
      setMsgs((m) => [...m, { id: idRef.current++, role: 'aura', text: 'AURA reasoning is temporarily unavailable. Nothing was changed.' }]);
    } finally {
      setThinking(false);
    }
  };

  const onAction = async (m: Msg, a: AIAction) => {
    // show the tap as the user's answer straight away; the reply may take a moment (it can be a server call)
    setMsgs((ms) => [...ms.map((x) => (x.id === m.id ? { ...x, resolved: true } : x)), { id: idRef.current++, role: 'user', text: a.label }]);
    let result: string | AIReply | void;
    try { result = await a.run?.(); } catch (e) { result = e instanceof Error ? e.message : 'That did not work. Please try again.'; }
    const reply = typeof result === 'object' ? result : undefined;
    const text = reply ? reply.text : typeof result === 'string' ? result : undefined;
    if (text) setMsgs((ms) => [...ms, { id: idRef.current++, role: 'aura' as const, text, reply, streaming: true }]);
    if (typeof result === 'string' && a.variant === 'primary') toast(result);
  };

  const voice = () => {
    if (listening) { stopRef.current?.(); return; }
    if (!browserVoice.supported) { toast('Voice input is not supported in this browser — type instead.'); inputRef.current?.focus(); return; }
    setOpen(true);
    setListening(true);
    let final = '';
    stopRef.current = browserVoice.listen((t, f) => { setInput(t); if (f) final = t; }, () => { setListening(false); if (final) void ask(final); });
  };

  const submit = (e: FormEvent) => { e.preventDefault(); void ask(input); };

  useEffect(() => {
    if (trigger) void ask(trigger.prompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger?.id]);

  return (
    <section className="hud corners glow-violet ai-panel" aria-label={title}>
      <div className="row" style={{ marginBottom: 10, alignItems: 'flex-start' }}>
        <Icon size={24} className="c-cyan" style={{ filter: 'drop-shadow(0 0 6px var(--aura-cyan))', flexShrink: 0 }} />
        <h3 style={{ fontSize: 18, fontWeight: 600, flex: 1 }}>{title} {badge && <span className="tag violet" style={{ verticalAlign: 'middle' }}>{badge}</span>}</h3>
        {msgs.length > 0 && <button className="icon-btn bare" style={{ width: 26, height: 26 }} onClick={() => setMsgs([])} aria-label="Clear conversation" title="Clear conversation"><RotateCcw size={14} /></button>}
      </div>
      {header}
      {description && <p className="t-sub" style={{ fontSize: 14, marginBottom: 12 }}>{description}</p>}

      {msgs.length === 0 && !textarea && (
        <div className={`ai-prompts ${promptStyle}`}>
          {prompts.map((p) => (
            <button key={p} onClick={() => void ask(p)}>{promptStyle === 'bullets' ? '• ' : ''}“{p}”</button>
          ))}
        </div>
      )}

      {msgs.length > 0 && (
        <div className="ai-log" ref={logRef} aria-live="polite">
          {msgs.map((m) => m.role === 'user'
            ? <div key={m.id} className="ai-msg user"><p>{m.text}</p></div>
            : <AuraMessage key={m.id} m={m} onAction={onAction} onStreamed={(id) => setMsgs((ms) => ms.map((x) => (x.id === id ? { ...x, streaming: false } : x)))} />)}
          {thinking && <div className="ai-msg aura"><span className="ai-dot"><Sparkles size={12} /></span><span className="typing" aria-label="AURA is thinking"><i /><i /><i /></span></div>}
        </div>
      )}

      {textarea && (
        <form onSubmit={submit} style={{ marginBottom: 12 }}>
          <textarea ref={inputRef} className="hud-textarea" rows={3} value={input} onChange={(e) => setInput(e.target.value)} placeholder={placeholder} aria-label={placeholder}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(input); } }} />
        </form>
      )}

      {open && !textarea && (
        <form className="input" onSubmit={submit} style={{ marginBottom: 12, height: 46 }}>
          <input ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} placeholder={listening ? 'Listening…' : placeholder} aria-label={placeholder} />
          <button type="button" onClick={voice} aria-label={listening ? 'Stop voice input' : 'Voice input'} className={listening ? 'c-cyan' : ''}><Mic size={17} /></button>
          <button aria-label="Send" disabled={!input.trim() || thinking}><Send size={17} className="c-cyan" /></button>
        </form>
      )}

      <button className="btn ai lg block" onClick={() => { if (textarea) void ask(input || prompts[0]); else if (!open) { setOpen(true); setTimeout(() => inputRef.current?.focus(), 30); } else voice(); }}>
        <CtaIcon size={18} /> {open && !textarea ? (listening ? 'Listening… tap to stop' : cta) : cta}
      </button>
      {footer}
    </section>
  );
}
