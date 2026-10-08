import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Workflow, MessageSquare, MoreHorizontal, Activity, ChevronLeft, Target, ListChecks, MessageCircle, Network, ChevronDown, Search, Hotel, Scale, Route, FileText, Sparkles,
  CheckCircle2, Clock3,
} from 'lucide-react';
import {
  Hud, IconBox, AgentNetwork, AgentAvatar, AppLogo, Toggle, NeonButton, NeonTabs, StatusBadge, SyncStatus, toast, toneHex, type StatusKind,
} from '../components/aura';
import { agentById, type Agent } from '../data/agents';
import { useAgents, activityStore } from '../state/agentActivity';
import { agentSettingsStore } from '../state/stores';

const permissionTone = { Suggest: 'cyan', Prepare: 'blue', 'Restricted Execute': 'amber', 'Explicit Approval': 'red' } as const;
const LEVELS = ['Suggest', 'Prepare', 'Restricted Execute', 'Explicit Approval'] as const;
const defaultLevel = (a: Agent) => (a.permission === 'Explicit Approval' ? 4 : a.permission === 'Restricted Execute' ? 3 : a.permission === 'Prepare' ? 2 : 1);

/** Agents shown in the hub grid (the coordinator and calendar helper are internal). */
function useHubAgents() {
  const all = useAgents();
  return useMemo(() => all.filter((a) => !['core', 'calendar'].includes(a.id)), [all]);
}

/* =================== AGENT HUB =================== */

function SelectedAgent({ a }: { a: Agent }) {
  const nav = useNavigate();
  const [tab, setTab] = useState<'Overview' | 'Capabilities' | 'Integrations'>('Overview');
  return (
    <Hud corners title="Selected Agent" icon={Workflow}>
      <div className="tile row" style={{ gap: 14, padding: 10, alignItems: 'stretch' }}>
        <div className="hud-frame" style={{ width: 120, height: 124, flexShrink: 0 }}><img src="/aura/travel-android.jpg" alt="" /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row between"><span className="row"><IconBox icon={a.icon} tone={a.tone} size="sm" /><span className="t-title" style={{ fontSize: 17 }}>{a.name}</span></span></div>
          <StatusBadge status={a.status as StatusKind} />
          <div className="t-sub" style={{ margin: '4px 0 10px' }}>{a.purpose}</div>
          <div className="row">
            <NeonButton size="sm" variant="primary" icon={MessageSquare} onClick={() => nav(`/chat?q=${encodeURIComponent(`${a.name}: what can you help me with?`)}`)}>Chat with Agent</NeonButton>
            <button className="icon-btn" style={{ width: 34, height: 34 }} aria-label="Open agent details" onClick={() => nav(`/agents/${a.id}`)}><MoreHorizontal size={16} /></button>
          </div>
        </div>
      </div>
      <div style={{ margin: '14px 0 10px' }}><NeonTabs tabs={['Overview', 'Capabilities', 'Integrations'] as const} value={tab} onChange={setTab} stretch /></div>
      {tab === 'Overview' && (
        <>
          <div className="t-title" style={{ fontSize: 16, marginBottom: 4 }}>About</div>
          <p className="t-sub" style={{ fontSize: 13.5, lineHeight: 1.6 }}>{a.purpose}. Current task: {a.task}.</p>
          <div className="row between" style={{ marginTop: 10 }}><span className="t-sub">Permission level</span><span className={`tag ${permissionTone[a.permission]}`}>{a.permission}</span></div>
        </>
      )}
      {tab === 'Capabilities' && <div className="row wrap">{a.capabilities.map((c) => <span key={c} className="tag blue">{c}</span>)}</div>}
      <div className="t-title" style={{ fontSize: 16, margin: '14px 0 10px' }}>Data sources</div>
      <div className="row wrap" style={{ gap: 14 }}>
        {a.tools.length ? a.tools.map((t) => <div key={t} className="stack" style={{ alignItems: 'center', gap: 5 }}><AppLogo name={t} size={38} /><span style={{ fontSize: 11 }}>{t}</span></div>) : <span className="t-mute">No external data sources — this agent reasons over your own data.</span>}
        {tab === 'Integrations' && <span className="t-mute">Manage connections in Integrations.</span>}
      </div>
    </Hud>
  );
}

export function AgentHub() {
  const nav = useNavigate();
  const list = useHubAgents();
  const activity = activityStore.use();
  const [sel, setSel] = useState('travel');
  const a = list.find((x) => x.id === sel) ?? list[0];
  const working = list.filter((x) => x.status !== 'idle');
  const mine = activity.filter((f) => f.agent === a.id).slice(0, 5);

  return (
    <>
      <div className="with-rail" style={{ gridTemplateColumns: 'minmax(0,1fr) 380px' }}>
        <Hud corners style={{ paddingBottom: 8 }}>
          <div className="row between wrap" style={{ alignItems: 'flex-start', gap: 12 }}>
            <div style={{ maxWidth: 540 }}>
              <h1 style={{ fontSize: 40 }}>Agent Hub</h1>
              <p style={{ fontSize: 18, marginTop: 2 }}>A Team of Specialized AI Agents Working for You</p>
              <p className="t-sub" style={{ marginTop: 8, fontSize: 14 }}>AURA coordinates specialized agents to understand your needs, compare options and prepare actions — you approve anything consequential.</p>
            </div>
            <div className="stack" style={{ gap: 8 }}>
              <div className="tile row" style={{ padding: '8px 14px' }}><IconBox icon={Workflow} tone="blue" size="sm" round /><div><b style={{ fontSize: 22 }}>{list.length}</b><div className="hud-label" style={{ color: 'var(--aura-text-2)', fontSize: 9 }}>Agents available</div></div></div>
              <div className="tile row" style={{ padding: '8px 14px' }}><IconBox icon={Activity} tone="violet" size="sm" round /><div><b style={{ fontSize: 22 }}>{working.length}</b><div className="hud-label" style={{ color: 'var(--aura-text-2)', fontSize: 9 }}>Worked this session</div></div></div>
            </div>
          </div>
          <AgentNetwork agents={list} selected={a.id} onSelect={setSel} coreLabel={`Coordinates ${list.length} agents`} />
        </Hud>
        <div className="stack">
          <SelectedAgent a={a} />
          <Hud corners title="Recent Activity" action="View All" onAction={() => nav(`/agents/${a.id}`)}>
            <div className="list">
              {mine.map((f, i) => <div className="li" key={`${f.text}${i}`}><Activity size={16} className="c-cyan" /><span className="grow ellipsis" style={{ fontSize: 13 }}>{f.text}</span><span className="t-mute mono">{f.time}</span></div>)}
              {!mine.length && <div className="empty">No activity from {a.name} yet. Ask AURA something in Chat.</div>}
            </div>
          </Hud>
        </div>
      </div>

      <div className="grid auto-stack" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
        <Hud corners title="Agent Collaboration" icon={Network}>
          <div className="row wrap" style={{ gap: 10, padding: '6px 0', position: 'relative' }}>
            {list.map((g) => (
              <button key={g.id} onClick={() => setSel(g.id)} aria-label={`Select ${g.name}`} aria-pressed={a.id === g.id} style={{ background: 'none', border: 0, padding: 0, transform: a.id === g.id ? 'scale(1.12)' : undefined, transition: 'transform .2s' }}>
                <IconBox icon={g.icon} tone={g.tone} round />
              </button>
            ))}
          </div>
        </Hud>
        <Hud corners title="Agents Working" icon={Activity}>
          <div className="stack" style={{ gap: 12 }}>
            {working.map((t) => (
              <div key={t.id} className="row">
                <t.icon size={15} style={{ color: toneHex[t.tone] }} />
                <span className="grow ellipsis" style={{ fontSize: 13, flex: 1 }}><b>{t.name}</b> — {t.task}</span>
                <StatusBadge status={t.status as StatusKind} />
              </div>
            ))}
            {!working.length && <div className="empty">No agent has been asked to work yet.</div>}
          </div>
        </Hud>
      </div>
      <SyncStatus stores={[agentSettingsStore]} />
    </>
  );
}

/* =================== AGENT DETAIL =================== */

const capIcons = [Search, Hotel, Scale, Route, FileText, Sparkles];
const steps: [string, string, string][] = [
  ['Understand Your Needs', 'I read your request and the relevant context from your own data.', '#19E6FF'],
  ['Gather Options', 'I look up live information from my data sources where available.', '#00E5A8'],
  ['Compare & Recommend', 'I weigh price, convenience and your preferences and explain the trade-offs.', '#8B5CFF'],
  ['Prepare a Plan', 'I draft the plan or actions so you can review them.', '#FFC857'],
  ['Act With Your Approval', 'Anything consequential waits for your explicit approval.', '#FF4FD8'],
];

export function AgentDetail() {
  const { id = 'travel' } = useParams();
  const nav = useNavigate();
  const all = useAgents();
  const a = all.find((x) => x.id === id) ?? all.find((x) => x.id === 'travel')!;
  const settings = agentSettingsStore.use();
  const activity = activityStore.use();
  const saved = settings.find((s) => s.id === a.id);
  const enabled = saved?.enabled ?? true;
  const autonomy = saved?.autonomy ?? defaultLevel(a);
  const [tab, setTab] = useState<'Overview' | 'Capabilities' | 'Integrations' | 'Recent Activity' | 'Settings'>('Overview');
  const c = toneHex[a.tone];
  const mine = activity.filter((f) => f.agent === a.id);
  const save = (patch: Partial<{ enabled: boolean; autonomy: number }>) =>
    agentSettingsStore.set((ss) => (ss.some((s) => s.id === a.id) ? ss.map((s) => (s.id === a.id ? { ...s, ...patch } : s)) : [...ss, { id: a.id, enabled, autonomy, ...patch }]));

  return (
    <>
      <div className="grid auto-stack" style={{ gridTemplateColumns: 'minmax(0,1.45fr) minmax(0,1fr) minmax(0,1fr)' }}>
        <Hud corners style={{ paddingTop: 14 }}>
          <Link to="/agents" className="btn sm" style={{ marginBottom: 10 }}><ChevronLeft size={15} /> Back to Agent Hub</Link>
          <div className="row" style={{ gap: 18, alignItems: 'stretch' }}>
            <div className="hud-frame hide-sm" style={{ width: 190, height: 170, flexShrink: 0 }}><img src="/aura/travel-android.jpg" alt="" /></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="row wrap"><IconBox icon={a.icon} tone={a.tone} size="lg" /><h1 style={{ fontSize: 32 }}>{a.name}</h1><span className={`tag ${enabled ? 'green' : 'amber'}`}><CheckCircle2 size={12} /> {enabled ? 'Enabled' : 'Disabled'}</span></div>
              <p style={{ margin: '8px 0', fontSize: 15 }}>{a.purpose}.</p>
              <p className="t-sub" style={{ fontSize: 13.5, lineHeight: 1.55 }}>I never act on your behalf without the permission level you set for me.</p>
              <div className="row wrap" style={{ marginTop: 12 }}>
                <NeonButton variant="primary" icon={MessageSquare} onClick={() => nav(`/chat?q=${encodeURIComponent(`${a.name}: what can you help me with?`)}`)}>Chat with {a.name}</NeonButton>
                <button className="icon-btn" aria-label="More actions" onClick={() => setTab('Settings')}><MoreHorizontal size={18} /></button>
              </div>
            </div>
          </div>
        </Hud>
        <Hud corners title="Key Capabilities">
          <div className="grid g2" style={{ gap: 8 }}>
            {a.capabilities.slice(0, 6).map((cap, i) => { const I = capIcons[i % capIcons.length]; return <div key={cap} className="tile row" style={{ fontSize: 13, padding: 10 }}><I size={19} style={{ color: c, flexShrink: 0 }} /> {cap}</div>; })}
          </div>
        </Hud>
        <Hud corners title="This Session">
          <div className="grid g2" style={{ gap: 8 }}>
            <div className="tile row" style={{ padding: 9 }}><Activity size={20} className="c-cyan" /><div><b style={{ fontSize: 18 }}>{mine.length}</b><div className="t-sub" style={{ fontSize: 11.5 }}>Requests handled</div></div></div>
            <div className="tile row" style={{ padding: 9 }}><Clock3 size={20} className="c-cyan" /><div><b style={{ fontSize: 18 }}>{a.lastActivity}</b><div className="t-sub" style={{ fontSize: 11.5 }}>Last active</div></div></div>
          </div>
          <div className="row between" style={{ marginTop: 12 }}><span className="t-sub">Permission level</span><span className={`tag ${permissionTone[LEVELS[autonomy - 1]]}`}>{LEVELS[autonomy - 1]}</span></div>
        </Hud>
      </div>

      <NeonTabs tabs={['Overview', 'Capabilities', 'Integrations', 'Recent Activity', 'Settings'] as const} value={tab} onChange={setTab} stretch />

      {tab === 'Settings' ? (
        <Hud corners title="Agent Controls" sub="Saved to your account.">
          <div className="list">
            <div className="li"><span className="grow">Enable agent</span><Toggle on={enabled} onChange={(v) => save({ enabled: v })} label="Enable agent" /></div>
            <div className="li" style={{ flexWrap: 'wrap' }}>
              <span className="grow">Autonomy level</span>
              <div className="row wrap">
                {LEVELS.map((l, i) => (
                  <button key={l} className={`chip ${autonomy === i + 1 ? 'active' : ''}`} onClick={() => { save({ autonomy: i + 1 }); toast(`Autonomy set to Level ${i + 1} — ${l}`); }}>L{i + 1} · {l}</button>
                ))}
              </div>
            </div>
          </div>
        </Hud>
      ) : tab === 'Capabilities' || tab === 'Integrations' ? (
        <Hud corners title={tab}>
          <div className="row wrap" style={{ gap: 10 }}>
            {(tab === 'Capabilities' ? a.capabilities : a.tools).map((x) => tab === 'Integrations'
              ? <div key={x} className="tile row"><AppLogo name={x} size={34} /><div><b>{x}</b></div></div>
              : <span key={x} className="tag blue" style={{ padding: '6px 10px', fontSize: 13 }}>{x}</span>)}
            {tab === 'Integrations' && !a.tools.length && <div className="empty">No external data sources for this agent.</div>}
          </div>
        </Hud>
      ) : tab === 'Recent Activity' ? (
        <Hud corners title="Recent Activity">
          <div className="list">
            {mine.map((f, i) => <div className="li" key={`${f.text}${i}`}><Activity size={15} className="c-cyan" /><span className="grow ellipsis" style={{ fontSize: 13 }}>{f.text}</span><span className="t-mute">{f.time}</span></div>)}
            {!mine.length && <div className="empty">No activity yet.</div>}
          </div>
        </Hud>
      ) : (
        <div className="grid g2">
          <Hud corners title="How I Work" icon={Target}>
            <div className="stack" style={{ gap: 14 }}>
              {steps.map(([t, s, col], i) => (
                <div className="row" key={t} style={{ alignItems: 'flex-start' }}>
                  <span style={{ width: 32, height: 32, flexShrink: 0, borderRadius: '50%', display: 'grid', placeItems: 'center', border: `2px solid ${col}`, color: '#fff', fontWeight: 700, boxShadow: `0 0 10px ${col}88` }}>{i + 1}</span>
                  <div><div className="t-title">{t}</div><div className="t-sub">{s}</div></div>
                </div>
              ))}
            </div>
          </Hud>
          <Hud corners title="Current Task" icon={ListChecks} action="Open chat" onAction={() => nav('/chat')}>
            <div className="tile"><div className="t-title" style={{ fontSize: 14 }}>{a.task}</div><div className="t-sub">Status: {a.status}</div></div>
          </Hud>
        </div>
      )}
      <SyncStatus stores={[agentSettingsStore]} />
    </>
  );
}

/* =================== COLLABORATION =================== */

export function Collaboration() {
  const nav = useNavigate();
  const all = useAgents();
  const feed = activityStore.use();
  const [view, setView] = useState<'Collaboration View' | 'Task Flow' | 'Communication'>('Collaboration View');
  const [filter, setFilter] = useState('All Agents');
  const netAgents = all.filter((x) => !['core', 'calendar', 'security'].includes(x.id));
  const shownFeed = feed.filter((f) => filter === 'All Agents' || agentById(f.agent)?.name === filter);
  const consulted = [...new Set(feed.map((f) => f.agent))];
  const latest = feed[0];

  return (
    <>
      <div className="with-rail" style={{ gridTemplateColumns: 'minmax(0,1fr) 400px' }}>
        <Hud corners>
          <div className="row between wrap" style={{ gap: 12 }}>
            <div><h1 style={{ fontSize: 36 }}>Agent Collaboration</h1><p className="t-sub" style={{ fontSize: 16 }}>Specialized agents working together on your requests.</p></div>
            <NeonTabs tabs={['Collaboration View', 'Task Flow', 'Communication'] as const} value={view} onChange={setView} icons={{ 'Collaboration View': Network, 'Task Flow': ListChecks, Communication: MessageCircle }} />
          </div>
          {view === 'Collaboration View' && <AgentNetwork agents={netAgents} coreLabel="Coordinates your agents" onSelect={(id) => nav(`/agents/${id}`)} />}
          {view === 'Task Flow' && (
            <div className="stack" style={{ gap: 10, marginTop: 16 }}>
              {latest ? <div className="tile"><b>Latest request:</b> {latest.text}</div> : <div className="empty">No requests yet. Ask AURA something in Chat and the agents it consults will appear here.</div>}
              {consulted.map((id) => { const ag = agentById(id); if (!ag) return null; return <div key={id} className="tile row"><IconBox icon={ag.icon} tone={ag.tone} size="sm" /><div className="grow" style={{ flex: 1 }}><div className="t-title">{ag.name}</div><div className="t-sub">{ag.purpose}</div></div><StatusBadge status="completed" /></div>; })}
            </div>
          )}
          {view === 'Communication' && (
            <div className="list" style={{ marginTop: 16 }}>
              {feed.map((f, i) => { const ag = agentById(f.agent); if (!ag) return null; return <div className="li" key={i}><AgentAvatar tone={ag.tone} size={36} /><div className="grow"><div className="t-title">{ag.name} → AURA Core</div><div className="t-sub">{f.text}</div></div><span className="t-mute mono">{f.time}</span></div>; })}
              {!feed.length && <div className="empty">No agent messages yet.</div>}
            </div>
          )}
          <p className="t-mute" style={{ textAlign: 'center', marginTop: 6 }}>Shows high-level agent activity only — never private model reasoning.</p>
        </Hud>
        <div className="stack">
          <Hud corners title="Agent Message Feed" action={<span className="row">{filter} <ChevronDown size={12} /></span>} onAction={() => {
            const names = ['All Agents', ...new Set(feed.map((f) => agentById(f.agent)?.name ?? f.agent))];
            setFilter((cur) => names[(names.indexOf(cur) + 1) % names.length]);
          }}>
            <div className="list" aria-live="polite">
              {shownFeed.map((f, i) => {
                const ag = agentById(f.agent);
                if (!ag) return null;
                return <div className="li fade-in" key={`${f.text}${i}`}><IconBox icon={ag.icon} tone={ag.tone} size="sm" /><div className="grow"><div className="t-title">{ag.name}</div><div className="t-sub">{f.text}</div></div><span className="t-mute mono">{f.time}</span></div>;
              })}
              {shownFeed.length === 0 && <div className="empty">No messages yet.</div>}
            </div>
          </Hud>
          <Hud corners title="This Session">
            <div className="grid g2" style={{ gap: 8 }}>
              <div className="tile"><b style={{ fontSize: 20 }}>{feed.length}</b><div className="t-sub">Agent contributions</div></div>
              <div className="tile"><b style={{ fontSize: 20 }}>{consulted.length}</b><div className="t-sub">Agents consulted</div></div>
            </div>
          </Hud>
        </div>
      </div>
    </>
  );
}
