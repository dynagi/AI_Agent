import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Brain, FileText, Scale, Sun, Play, Radar, CheckCircle2, SlidersHorizontal, Bookmark, MessageSquare, X, Info, GripVertical, Sparkles, History } from 'lucide-react';
import { Hud, IconBox, NeonButton, StatusBadge, SyncStatus, toast, type Tone } from '../components/aura';
import ApprovalModal from '../components/ApprovalModal';
import { agentById } from '../data/agents';
import { aura, type DecisionOption } from '../services/aura';
import { buildUserContext } from '../state/context';
import { useUser } from '../state/user';
import { createRecordStore, uid } from '../state/store';

interface DecisionRecord {
  id: string; situation: string; priorities: string[]; options: DecisionOption[]; recommendation: string; agents: string[];
  status: 'open' | 'approved' | 'rejected' | 'saved'; chosen?: number; ts: string;
}
/** Decision sessions, persisted per user. */
const decisionsStore = createRecordStore<DecisionRecord>('decisions');

const stages = [['Analyze', Brain], ['Plan', FileText], ['Compare', Scale], ['Recommend', Sun], ['Execute', Play]] as const;
const goalTone = ['#FFC857', '#00AFFF', '#00E5A8', '#19E6FF', '#FF4FD8'];
const DEFAULT_PRIORITIES = ['Stay within budget', 'Save time', 'Minimise risk', 'Keep things comfortable', 'Be well prepared'];
const riskTone = (r: string): Tone => (/high/i.test(r) ? 'red' : /med/i.test(r) ? 'amber' : 'green');

export default function Decisions() {
  const nav = useNavigate();
  const user = useUser();
  const history = decisionsStore.use();
  const [situation, setSituation] = useState('');
  const [priorities, setPriorities] = useState(DEFAULT_PRIORITIES);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'error'; error: string }>({ status: 'idle', error: '' });
  const [approve, setApprove] = useState(false);

  const current = history.find((d) => d.id === currentId) ?? null;
  const stage = !current ? 0 : current.status === 'approved' ? 4 : current.chosen !== undefined ? 3 : 2;
  const patch = (id: string, p: Partial<DecisionRecord>) => decisionsStore.set((ds) => ds.map((d) => (d.id === id ? { ...d, ...p } : d)));
  const move = (from: number, to: number) => setPriorities((gs) => { const c = [...gs]; const [m] = c.splice(from, 1); c.splice(to, 0, m); return c; });

  const analyze = async (e: FormEvent) => {
    e.preventDefault();
    const text = situation.trim();
    if (!text) return;
    setState({ status: 'loading', error: '' });
    try {
      const res = await aura.decide(`${text}\n\nMy priorities, most important first: ${priorities.map((p, i) => `${i + 1}. ${p}`).join('; ')}.`, JSON.parse(buildUserContext()));
      const rec: DecisionRecord = { id: uid('dec'), situation: text, priorities, options: res.options, recommendation: res.recommendation, agents: res.agentsConsulted ?? [], status: 'open', ts: new Date().toISOString() };
      decisionsStore.set((ds) => [rec, ...ds]);
      setCurrentId(rec.id);
      setSituation('');
      setState({ status: 'idle', error: '' });
    } catch (err) {
      setState({ status: 'error', error: err instanceof Error && /bearer|401/i.test(err.message) ? 'Sign in to use the Decision Center.' : 'The decision engine is temporarily unavailable. Please try again.' });
    }
  };

  const chosenOption = current && current.chosen !== undefined ? current.options[current.chosen] : null;

  return (
    <>
      <div className="tabs" aria-label="Decision stage">
        {stages.map(([l, I], i) => (
          <div key={l} className={`chip ${i === stage ? 'active' : ''}`} style={{ flex: 1, flexDirection: 'column', padding: 12, minWidth: 96, opacity: i <= stage ? 1 : 0.55, fontSize: 14 }} aria-current={i === stage ? 'step' : undefined}>
            <I size={24} /> {l}
          </div>
        ))}
      </div>

      <div className="hero" style={{ minHeight: 220 }}>
        <img className="hero-bg" src="/aura/decision-android.jpg" alt="" style={{ width: '52%' }} />
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 'clamp(34px, 4vw, 52px)' }}>Decision Center</h1>
          <p style={{ fontSize: 20, color: 'var(--aura-text-2)', marginTop: 4 }}>From complexity to clarity.</p>
          <p className="lead" style={{ fontSize: 14.5 }}>Describe a decision. AURA consults its agents, lays out options with trade-offs, and recommends a path — you decide.</p>
        </div>
      </div>

      <div className="grid auto-stack" style={{ gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)' }}>
        <Hud corners title="Your Situation" icon={Radar}>
          <form className="stack" style={{ gap: 12 }} onSubmit={(e) => void analyze(e)}>
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <div className="avatar" style={{ width: 52, height: 52 }}>{user.initials}</div>
              <textarea className="hud-textarea" rows={4} style={{ flex: 1 }} value={situation} onChange={(e) => setSituation(e.target.value)} aria-label="Describe your situation"
                placeholder="e.g. I have a job interview in Bengaluru next Friday but a work deadline the day before. Should I fly or take the train?" />
            </div>
            {state.status === 'error' && <div className="tag red" role="alert" style={{ padding: 8, whiteSpace: 'normal' }}>{state.error}</div>}
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="t-mute">AURA also sees a summary of your tasks, calendar and spending.</span>
              <NeonButton variant="ai" type="submit" icon={Sparkles} disabled={!situation.trim() || state.status === 'loading'}>{state.status === 'loading' ? <span className="spinner" /> : 'Analyze options'}</NeonButton>
            </div>
          </form>
        </Hud>
        <Hud corners title="Priority Goals" action="Drag to reorder">
          <ol className="stack" style={{ gap: 8, listStyle: 'none', margin: 0, padding: 0 }}>
            {priorities.map((g, i) => (
              <li key={g} className="tile row" draggable onDragStart={(e) => e.dataTransfer.setData('i', String(i))} onDragOver={(e) => e.preventDefault()} onDrop={(e) => move(Number(e.dataTransfer.getData('i')), i)} style={{ cursor: 'grab', padding: 9 }}>
                <span style={{ width: 28, height: 28, borderRadius: '50%', display: 'grid', placeItems: 'center', border: `1.5px solid ${goalTone[i]}`, color: goalTone[i], boxShadow: `0 0 8px ${goalTone[i]}66`, fontWeight: 700, fontSize: 13 }}>{i + 1}</span>
                <span style={{ fontSize: 13.5, flex: 1 }}>{g}</span>
                <span className="row" style={{ gap: 2 }}>
                  <button type="button" className="icon-btn bare" style={{ width: 22, height: 22 }} disabled={i === 0} onClick={() => move(i, i - 1)} aria-label={`Move ${g} up`}>▲</button>
                  <button type="button" className="icon-btn bare" style={{ width: 22, height: 22 }} disabled={i === priorities.length - 1} onClick={() => move(i, i + 1)} aria-label={`Move ${g} down`}>▼</button>
                </span>
                <GripVertical size={14} className="t-mute hide-sm" />
              </li>
            ))}
          </ol>
        </Hud>
      </div>

      {state.status === 'loading' && <Hud corners><div className="empty"><span className="spinner" /> AURA is consulting its agents and weighing your options…</div></Hud>}

      {current && (
        <>
          <Hud corners title="Agents Consulted" icon={Brain} sub="High-level activity only — never private model reasoning." action="View Details" onAction={() => nav('/collaboration')}>
            <div className="grid g5" style={{ gap: 10 }}>
              {current.agents.map((id) => {
                const a = agentById(id);
                if (!a) return null;
                return (
                  <div className="tile" key={id}>
                    <div className="row between"><IconBox icon={a.icon} tone={a.tone} size="lg" round /><StatusBadge status="completed" label="" /></div>
                    <div className="t-title" style={{ marginTop: 10 }}>{a.name}</div>
                    <div className="t-sub">{a.purpose}</div>
                  </div>
                );
              })}
              {!current.agents.length && <div className="empty">No specialist agents were needed for this decision.</div>}
            </div>
          </Hud>

          <Hud corners title="Options & Trade-offs" icon={Scale}>
            <p className="t-sub" style={{ marginBottom: 10 }}>“{current.situation}”</p>
            <div className="grid g3">
              {current.options.map((o, i) => {
                const on = current.chosen === i;
                return (
                  <div key={o.title + i} className="hud" style={{ padding: 16, filter: on ? 'drop-shadow(0 0 16px rgba(0,229,168,0.6))' : undefined }}>
                    <div className="row between"><span className="t-mute mono">Option {i + 1}</span><span className={`tag ${riskTone(o.risk)}`}>Risk: {o.risk}</span></div>
                    <div className="t-title" style={{ fontSize: 17, marginTop: 10 }}>{o.title}</div>
                    <div className="t-sub" style={{ margin: '8px 0 12px', lineHeight: 1.55 }}>{o.tradeoffs}</div>
                    <NeonButton block variant={on ? 'primary' : 'default'} disabled={current.status === 'approved'} onClick={() => patch(current.id, { chosen: on ? undefined : i, status: 'open' })} aria-pressed={on}>{on ? 'Selected ✓' : 'Select This Option'}</NeonButton>
                  </div>
                );
              })}
            </div>
            {!current.options.length && <div className="empty">The engine did not return any options. Try describing the decision in more detail.</div>}
          </Hud>

          <Hud corners>
            <div className="row wrap" style={{ gap: 20, alignItems: 'flex-start' }}>
              <span className="icon-box lg round c-cyan" style={{ fontFamily: 'var(--font-display)', fontSize: 22 }}>A</span>
              <div style={{ flex: 1, minWidth: 260 }}>
                <div className="t-title" style={{ fontSize: 17 }}>AURA's Analysis</div>
                <p className="t-sub" style={{ fontSize: 14.5, marginTop: 6, lineHeight: 1.6, whiteSpace: 'pre-line' }}>{current.recommendation || 'No recommendation was provided.'}</p>
                <div className="row t-mute" style={{ marginTop: 8 }}><Info size={12} /> This is decision support, not a certainty. The final choice is yours, and nothing is executed without your approval.</div>
              </div>
              <div className="stack" style={{ gap: 6 }}>
                <span className="t-sub">Your priorities</span>
                {current.priorities.map((p, i) => <span key={p} className="row" style={{ fontSize: 13 }}><CheckCircle2 size={14} className="c-green" /> {i + 1}. {p}</span>)}
              </div>
            </div>
            <div className="row wrap" style={{ marginTop: 18, justifyContent: 'space-between', gap: 12 }}>
              <div className="row wrap">
                <NeonButton icon={SlidersHorizontal} onClick={() => nav(`/chat?q=${encodeURIComponent(`Help me adjust this decision: ${current.situation}`)}`)}>Modify</NeonButton>
                <NeonButton icon={MessageSquare} onClick={() => nav(`/chat?q=${encodeURIComponent(`Explain the trade-offs of: ${chosenOption?.title ?? current.options[0]?.title ?? current.situation}`)}`)}>Ask AURA</NeonButton>
                <NeonButton variant="danger" icon={X} onClick={() => { patch(current.id, { status: 'rejected', chosen: undefined }); toast('Rejected. AURA will not act on this decision.'); }}>Reject</NeonButton>
              </div>
              <div className="row wrap">
                <NeonButton variant="primary" size="lg" hex chevron disabled={!chosenOption || current.status === 'approved'} onClick={() => setApprove(true)} title={chosenOption ? undefined : 'Select an option first'}>Approve Selected Option</NeonButton>
                <NeonButton icon={Bookmark} onClick={() => { patch(current.id, { status: 'saved' }); toast('Saved for later.'); }}>Save for Later</NeonButton>
              </div>
            </div>
            {current.status !== 'open' && <div className="t-sub" style={{ marginTop: 10 }}>Status: <b style={{ color: '#fff' }}>{current.status}</b></div>}
          </Hud>
        </>
      )}

      <Hud corners title="Past Decisions" icon={History}>
        <div className="list">
          {history.map((d) => (
            <button key={d.id} className="li" style={{ background: 'none', border: 0, width: '100%', textAlign: 'left' }} onClick={() => setCurrentId(d.id)} aria-pressed={d.id === currentId}>
              <div className="grow"><div className="t-title ellipsis">{d.situation}</div><div className="t-sub">{new Date(d.ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · {d.options.length} options</div></div>
              <span className={`tag ${d.status === 'approved' ? 'green' : d.status === 'rejected' ? 'red' : 'blue'}`}>{d.status}</span>
            </button>
          ))}
          {!history.length && <div className="empty">No decisions yet. Describe one above to get started.</div>}
        </div>
        <SyncStatus stores={[decisionsStore]} />
      </Hud>

      {approve && current && chosenOption && (
        <ApprovalModal
          action={`Proceed with: ${chosenOption.title}`}
          details={[chosenOption.title, `Risk: ${chosenOption.risk}`, chosenOption.tradeoffs, `Decision ID: ${current.id}`]}
          onApproved={() => patch(current.id, { status: 'approved' })}
          onClose={() => setApprove(false)}
        />
      )}
    </>
  );
}
