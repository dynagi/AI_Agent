import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Timer, CalendarCheck, Rocket, Wand2, Bot, LayoutTemplate, Workflow, History, Plus, Sparkles,
  Eye, Settings, ArrowRight, CheckCircle2, ShieldAlert, Zap,
} from 'lucide-react';
import { Hud, IconBox, PageHero, NeonButton, NeonTabs, DataTable, SyncStatus, type Tone } from '../components/aura';
import { AutomationCard, TemplateCard, AutomationWizard, draftFromText, type Draft } from '../components/automations';
import { automationTemplates, autoIcon, type Automation } from '../data/automations';
import { automationsStore, runsStore, type RunLog } from '../state/stores';
import { automationActions as act } from '../state/automationActions';
import { usePageSearch, matches } from '../state/search';

const TABS = ['My Automations', 'Templates', 'Workflows', 'History'] as const;
type Tab = (typeof TABS)[number];
const EXAMPLE = 'Whenever I get a travel itinerary, add it to my calendar and create a shopping list for the trip.';

export default function Automations() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const autos = automationsStore.use();
  const runs = runsStore.use();
  const q = usePageSearch();
  const [tab, setTab] = useState<Tab>((TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'My Automations');
  const [wizard, setWizard] = useState<{ draft?: Draft; edit?: Automation } | null>(null);

  const mine = autos.filter((a) => matches(q, a.name, a.description, ...a.tags));
  const templates = automationTemplates.filter((t) => matches(q, t.name, t.description));
  const workflows = autos.filter((a) => (a.steps?.length ?? 0) > 0 || a.featured);

  const handlers = (a: Automation) => ({
    onToggle: (v: boolean) => act.toggle(a, v), onRun: () => act.run(a), onDuplicate: () => act.duplicate(a), onDelete: () => act.remove(a),
    onEdit: () => setWizard({ draft: act.toDraft(a), edit: a }),
  });

  return (
    <div className="module">
      <div className="main">
        <PageHero title={<span className="grad">Automations</span>} lead="Let AURA handle the repetitive, so you can focus on what matters." image="/aura/hero-automations.jpg" imageWidth="22%" quote="Small automations create big freedom."
          feats={[
            { icon: Timer, title: 'Save time', sub: 'Automate daily tasks' }, { icon: CalendarCheck, title: 'Stay organized', sub: 'Reduce manual work' },
            { icon: Rocket, title: 'Boost productivity', sub: 'Work smarter, not harder' }, { icon: Wand2, title: 'Custom workflows', sub: 'Built for your needs' },
          ]} />

        <div className="row between wrap">
          <NeonTabs tabs={TABS} value={tab} onChange={setTab} icons={{ 'My Automations': Bot, Templates: LayoutTemplate, Workflows: Workflow, History }} />
          <NeonButton variant="primary" icon={Plus} onClick={() => setWizard({})}>Create Automation</NeonButton>
        </div>

        {tab === 'My Automations' && (
          <Hud corners>
            <div className="row" style={{ marginBottom: 14 }}><h2 className="section-title" style={{ fontSize: 20 }}>My Automations</h2><span className="tag blue">{mine.length} automations</span></div>
            <div className="grid g4" style={{ gap: 12 }}>{mine.map((a) => <AutomationCard key={a.id} a={a} {...handlers(a)} />)}</div>
            {!mine.length && <div className="empty">No automations{q ? ` match “${q}”` : ' yet'}. Create one or start from a template.</div>}
          </Hud>
        )}
        {tab === 'Templates' && (
          <Hud corners title={<span className="section-title" style={{ fontSize: 20 }}>All Templates</span>}>
            <div className="grid g3" style={{ gap: 12 }}>{templates.map((t) => <TemplateCard key={t.id} t={t} onUse={() => { act.fromTemplate(t); setTab('My Automations'); }} />)}</div>
          </Hud>
        )}
        {tab === 'Workflows' && (
          <Hud corners title={<span className="section-title" style={{ fontSize: 20 }}>Workflows</span>} sub="Trigger → steps → approval gates. Multi-agent workflows run through the Coordinator.">
            <div className="stack" style={{ gap: 10 }}>
              {workflows.map((a) => (
                <div key={a.id} className="tile">
                  <div className="row between"><b className="row"><IconBox icon={autoIcon(a.icon)} tone={a.tone as Tone} size="sm" /> {a.name}</b><span className={`tag ${a.active ? 'green' : 'amber'}`}>{a.active ? 'Active' : 'Paused'}</span></div>
                  <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>
                    <span className="chip"><Zap size={13} className="c-amber" /> {a.trigger ?? (a.from ? `New in ${a.from}` : a.schedule)}</span>
                    {(a.steps ?? [a.description]).map((s) => <span key={s} className="row" style={{ gap: 6 }}><ArrowRight size={14} className="t-mute" /><span className="chip">{s}</span></span>)}
                    {a.needsApproval && <span className="row" style={{ gap: 6 }}><ArrowRight size={14} className="t-mute" /><span className="chip c-amber"><ShieldAlert size={13} /> Your approval</span></span>}
                  </div>
                </div>
              ))}
            </div>
          </Hud>
        )}
        {tab === 'History' && (
          <Hud corners title={<span className="section-title" style={{ fontSize: 20 }}>Run History</span>}>
            <DataTable<RunLog> caption="Automation run history" rows={runs} rowKey={(r) => r.id} columns={[
              { key: 'n', header: 'Automation', render: (r) => <b>{r.name}</b> },
              { key: 'w', header: 'When', render: (r) => <span className="t-sub">{r.when}</span> },
              { key: 'r', header: 'Prepared actions', render: (r) => <span className="t-sub" style={{ whiteSpace: 'pre-line' }}>{r.summary ?? '—'}</span> },
              { key: 's', header: 'Status', render: (r) => <span className={`tag ${r.status === 'Completed' ? 'green' : r.status === 'Failed' ? 'red' : 'amber'}`}>{r.status}</span>, align: 'right' },
            ]} />
          </Hud>
        )}

        <Hud corners>
          <div className="row between" style={{ marginBottom: 12 }}>
            <h2 className="section-title" style={{ fontSize: 20 }}>Automation Templates</h2>
            <button className="c-blue row" style={{ background: 'none', border: 0 }} onClick={() => setTab('Templates')}>View All Templates <ArrowRight size={14} /></button>
          </div>
          <div className="grid g4" style={{ gap: 12 }}>{automationTemplates.slice(0, 4).map((t) => <TemplateCard key={t.id} t={t} compact onUse={() => act.fromTemplate(t)} />)}</div>
        </Hud>
        <SyncStatus stores={[automationsStore, runsStore]} />
      </div>

      <div className="rail">
        <Hud corners glow="violet">
          <h3 className="row" style={{ fontSize: 18, marginBottom: 12 }}><Sparkles size={22} className="c-cyan" /> Featured Automation</h3>
          <div className="tile">
            <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}><IconBox icon={Bot} tone="violet" size="lg" /><div><b style={{ fontSize: 15 }}>AI Agent Automation</b> <span className="tag violet">Beta</span><div className="t-sub" style={{ fontSize: 12.5 }}>Create complex, multi-step automations using natural language.</div></div></div>
            <div className="tile" style={{ marginTop: 10, fontSize: 13.5 }}><CheckCircle2 size={14} className="c-green" /> “{EXAMPLE}”</div>
          </div>
          <NeonButton variant="ai" block icon={Sparkles} style={{ marginTop: 12 }} onClick={() => setWizard({ draft: draftFromText(EXAMPLE) })}>Try with AURA</NeonButton>
        </Hud>
        <Hud corners title={<span className="section-title" style={{ fontSize: 18 }}>Recent Runs</span>} action="View All" onAction={() => setTab('History')}>
          <div className="list">
            {runs.slice(0, 5).map((r) => {
              const I = Workflow;
              return <div className="li" key={r.id}><IconBox icon={I} tone="blue" size="sm" /><div className="grow"><div className="t-title" style={{ fontSize: 13.5 }}>{r.name}</div><div className="t-mute">{r.when}</div></div><span className={`tag ${r.status === 'Completed' ? 'green' : 'amber'}`}>{r.status}</span></div>;
            })}
            {!runs.length && <div className="empty">No runs yet.</div>}
          </div>
        </Hud>
        <Hud corners title={<span className="section-title" style={{ fontSize: 18 }}>Quick Actions</span>}>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 8 }}>
            {([[Plus, 'New Automation', () => setWizard({})], [LayoutTemplate, 'Browse Templates', () => setTab('Templates')], [Eye, 'View Logs', () => setTab('History')], [Settings, 'Settings', () => nav('/settings')]] as const).map(([I, l, fn]) => (
              <button key={l} className="stack" style={{ background: 'none', border: 0, alignItems: 'center', gap: 6, textAlign: 'center' }} onClick={fn}><IconBox icon={I} tone="blue" size="lg" /><span style={{ fontSize: 11.5 }}>{l}</span></button>
            ))}
          </div>
        </Hud>
      </div>

      {wizard && (
        <AutomationWizard initial={wizard.draft} title={wizard.edit ? `Edit ${wizard.edit.name}` : 'Create Automation'} onClose={() => setWizard(null)}
          onCreate={(d) => { act.fromDraft(d, wizard.edit); setWizard(null); setTab('My Automations'); }} />
      )}
    </div>
  );
}
