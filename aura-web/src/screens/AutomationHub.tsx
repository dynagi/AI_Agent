import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Workflow, Zap, Link2, Clock, Sparkles, Star, ArrowRight, LayoutGrid, MessageSquare, Heart, IndianRupee, Plane, ShoppingCart, Wand2, BarChart3, Timer, Box, Bot,
} from 'lucide-react';
import { Hud, IconBox, PageHero, NeonButton, NeonTabs, Toggle, SyncStatus, type Tone } from '../components/aura';
import { AICommandPanel, type AIReply } from '../components/ai';
import { AutomationCard, TemplateCard, AutomationWizard, buildDraft, type Draft } from '../components/automations';
import { recommendedAutomations, autoIcon, type AutoCategory, type Automation } from '../data/automations';
import { formatWhen } from '../data/transactions';
import { automationsStore, runsStore } from '../state/stores';
import { automationActions as act } from '../state/automationActions';
import { usePageSearch, matches } from '../state/search';

const CATS = ['All Automations', 'Productivity', 'Communication', 'Lifestyle', 'Finance', 'Travel', 'Shopping', 'Custom'] as const;
const catIcons = { 'All Automations': LayoutGrid, Productivity: Zap, Communication: MessageSquare, Lifestyle: Heart, Finance: IndianRupee, Travel: Plane, Shopping: ShoppingCart, Custom: Wand2 };

export default function AutomationHub() {
  const nav = useNavigate();
  const autos = automationsStore.use();
  const q = usePageSearch();
  const [cat, setCat] = useState<(typeof CATS)[number]>('All Automations');
  const [wizard, setWizard] = useState<{ draft?: Draft; edit?: Automation } | null>(null);
  const [trigger, setTrigger] = useState<{ prompt: string; id: number } | null>(null);

  const inCat = (c: AutoCategory, tags: string[]) => cat === 'All Automations' || c === cat || tags.includes(cat);
  const featured = autos.filter((a) => a.active && inCat(a.category, a.tags) && matches(q, a.name, a.description, ...a.tags));
  const added = new Set(autos.map((a) => a.name));
  const recommended = recommendedAutomations.filter((t) => inCat(t.category, t.tags) && matches(q, t.name, t.description));
  const runs = runsStore.use();
  const mine = autos.slice(0, 5);
  const stats = useMemo(() => ({ total: autos.length, active: autos.filter((a) => a.active).length, apps: new Set(autos.flatMap((a) => [a.from, a.to]).filter(Boolean)).size, runs: runs.length }), [autos, runs]);

  const handlers = (a: Automation) => ({
    onToggle: (v: boolean) => act.toggle(a, v), onRun: () => act.run(a), onDuplicate: () => act.duplicate(a), onDelete: () => act.remove(a),
    onEdit: () => setWizard({ draft: act.toDraft(a), edit: a }),
  });

  const ai = async (p: string): Promise<AIReply> => {
    const d = await buildDraft(p);
    return {
      text: `Here's the workflow I'd build. It will be created paused so you can review it first.${d.needsApproval ? ' It includes an approval gate because it can act on your behalf.' : ''}`,
      preview: [`Name: ${d.name}`, `When: ${d.trigger}`, ...d.steps.map((s, i) => `${i + 1}. ${s}`)],
      actions: [
        { label: 'Create automation', variant: 'primary', run: () => { act.fromDraft(d); return `“${d.name}” created (paused). Turn it on in My Automations.`; } },
        { label: 'Edit in wizard', run: () => { setWizard({ draft: d }); return 'Opened the wizard so you can adjust the steps.'; } },
        { label: 'Cancel', run: () => 'Okay — nothing was created.' },
      ],
    };
  };

  return (
    <div className="module">
      <div className="main">
        <PageHero title={<span className="grad-cyan" style={{ background: 'linear-gradient(90deg,#fff,#cfe8ff 45%,#b18cff)', WebkitBackgroundClip: 'text', backgroundClip: 'text' }}>Automation Hub</span>}
          lead="Let AURA handle the repetitive, so you can focus on what matters." image="/aura/hero-automation-hub.jpg" imageWidth="22%" quote="Automate the routine. Amplify your life."
          feats={[
            { icon: Workflow, title: 'Create Workflows', sub: 'Automate your day' }, { icon: Zap, title: 'Smart Triggers', sub: 'When this happens…', tone: 'amber' },
            { icon: Link2, title: 'Connect Apps', sub: 'All your tools, one flow', tone: 'violet' }, { icon: Clock, title: 'Save Time', sub: 'Do more, effortlessly', tone: 'violet' },
          ]} />

        <NeonTabs tabs={CATS} value={cat} onChange={setCat} icons={catIcons} />

        <Hud corners>
          <div className="row between" style={{ marginBottom: 14 }}>
            <h2 className="section-title row" style={{ fontSize: 20 }}><Sparkles size={20} className="c-violet" /> Active Automations</h2>
            <button className="c-blue row" style={{ background: 'none', border: 0 }} onClick={() => nav('/automations')}>View All <ArrowRight size={14} /></button>
          </div>
          <div className="grid g4" style={{ gap: 12 }}>{featured.map((a) => <AutomationCard key={a.id} a={a} flow={!!(a.from || a.to)} {...handlers(a)} />)}</div>
          {!featured.length && <div className="empty">No active automations in {cat}. Add one from the recommendations below and turn it on.</div>}
        </Hud>

        <Hud corners>
          <div className="row between" style={{ marginBottom: 14 }}>
            <h2 className="section-title row" style={{ fontSize: 20 }}><Star size={20} className="c-blue" /> Recommended Automations</h2>
            <button className="c-blue row" style={{ background: 'none', border: 0 }} onClick={() => nav('/automations?tab=Templates')}>View All <ArrowRight size={14} /></button>
          </div>
          <div className="grid g4" style={{ gap: 12 }}>
            {recommended.map((t) => added.has(t.name)
              ? <div key={t.id} className="tile stack" style={{ gap: 8, padding: 12, opacity: 0.7 }}><IconBox icon={autoIcon(t.icon)} tone={t.tone} size="lg" /><b>{t.name}</b><span className="tag green" style={{ alignSelf: 'flex-start' }}>Added</span></div>
              : <TemplateCard key={t.id} t={t} onUse={() => act.fromTemplate(t)} />)}
          </div>
          {!recommended.length && <div className="empty">Nothing recommended in {cat} right now.</div>}
        </Hud>

        <Hud corners glow="violet">
          <div className="row between wrap" style={{ gap: 14 }}>
            <div className="row" style={{ gap: 16 }}><IconBox icon={Bot} tone="magenta" size="lg" /><div><b style={{ fontSize: 18 }}>Turn your ideas into automations</b><div className="t-sub">Tell AURA what you want to automate. It's that simple.</div></div></div>
            <NeonButton variant="ai" onClick={() => setWizard({})}>Try It Now <ArrowRight size={16} /></NeonButton>
          </div>
        </Hud>
        <SyncStatus stores={[automationsStore, runsStore]} />
      </div>

      <div className="rail">
        <AICommandPanel title="Create New Automation" badge={null} icon={Zap} description="Describe what you want to automate, and AURA will build it for you." textarea
          placeholder='e.g. "When I receive an email from my manager, add it to my tasks and notify me on Slack"'
          prompts={['When I receive an email from my manager, add it to my tasks and notify me on Slack']}
          onAsk={ai} cta="Create with AURA" ctaIcon={Sparkles} trigger={trigger} />
        <Hud corners title={<span className="section-title" style={{ fontSize: 20 }}>My Automations</span>} action="View All" onAction={() => nav('/automations')}>
          <div className="list">
            {mine.map((a) => (
              <div className="li" key={a.id}>
                <IconBox icon={autoIcon(a.icon)} tone={a.tone as Tone} />
                <div className="grow"><div className="t-title">{a.name}</div><div className="t-sub">Last run: {a.lastRunAt ? formatWhen(a.lastRunAt) : 'Never'}</div></div>
                <Toggle on={a.active} onChange={(v) => act.toggle(a, v)} label={`${a.name} active`} />
              </div>
            ))}
            {!mine.length && <div className="empty">No automations yet.</div>}
          </div>
          <button className="t-mute" style={{ background: 'none', border: 0, marginTop: 6 }} onClick={() => setTrigger({ prompt: 'Every morning summarize my emails and add follow-ups as tasks', id: Date.now() })}>Try an example →</button>
        </Hud>
        <Hud corners title={<span className="row section-title" style={{ fontSize: 18 }}><BarChart3 size={18} className="c-blue" /> Automation Stats</span>}>
          <div className="grid g2" style={{ gap: 8 }}>
            {([[Timer, stats.total, 'Total Automations'], [Zap, stats.active, 'Active'], [Box, stats.apps, 'Apps Connected'], [Clock, stats.runs, 'Runs']] as const).map(([I, v, l]) => (
              <div key={l} className="tile row" style={{ gap: 10 }}><I size={20} className="c-cyan" /><div><b style={{ fontSize: 19 }}>{v}</b><div className="t-sub" style={{ fontSize: 11.5 }}>{l}</div></div></div>
            ))}
          </div>
        </Hud>
      </div>

      {wizard && (
        <AutomationWizard initial={wizard.draft} title={wizard.edit ? `Edit ${wizard.edit.name}` : 'Create Automation'} onClose={() => setWizard(null)}
          onCreate={(d) => { act.fromDraft(d, wizard.edit); setWizard(null); }} />
      )}
    </div>
  );
}
