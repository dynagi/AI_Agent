import { useState, type FormEvent } from 'react';
import { Zap, ShieldCheck, Star, LayoutGrid, Building2, ChevronRight, Brain, BarChart3, Lock, Headphones, Crown, Check, Mail, User } from 'lucide-react';
import { Hud, IconBox, NeonButton, NeonTabs, PageHero, FuturisticModal, HudInput, DataTable, toast, type Tone } from '../components/aura';
import { PricingCard } from '../components/pricing';
import { pricingPlans, planMatrix, type PlanId } from '../data/pricingPlans';
import { planStore } from '../state/stores';
import { useUser } from '../state/user';
import { apiSend } from '../services/api';
import { uid } from '../state/store';

const why: { icon: typeof Zap; t: string; s: string; tone: Tone }[] = [
  { icon: Brain, t: 'More Powerful Agents', s: 'Specialized AI agents for every area of your life.', tone: 'violet' },
  { icon: Zap, t: 'Unlimited Automations', s: 'Let AURA work for you 24/7.', tone: 'red' },
  { icon: BarChart3, t: 'Deeper Insights', s: 'Get personalized analytics and recommendations.', tone: 'teal' },
  { icon: Lock, t: 'Priority Access', s: 'Be the first to try new features and updates.', tone: 'violet' },
  { icon: Headphones, t: 'Dedicated Support', s: "We're always here when you need us.", tone: 'magenta' },
];

export default function Pricing() {
  const current = planStore.use();
  const user = useUser();
  const [billing, setBilling] = useState<'Monthly' | 'Yearly'>('Monthly');
  const [choose, setChoose] = useState<PlanId | null>(null);
  const [busy, setBusy] = useState(false);
  const [compare, setCompare] = useState(false);
  const [sales, setSales] = useState(false);
  const [lead, setLead] = useState({ name: '', email: '', size: '10-50' });
  const yearly = billing === 'Yearly';
  const plan = pricingPlans.find((p) => p.id === choose);

  /** There is no payment provider yet, so this records interest instead of changing the plan. */
  const confirm = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      await apiSend('PUT', `/records/plan_interest/${plan.id}`, { plan: plan.id, billing, requestedAt: new Date().toISOString() });
      toast(plan.id === 'free' ? 'You are on the Free plan.' : `Thanks! Paid plans aren't open yet — we've saved your interest in ${plan.name}. You were not charged.`);
      setChoose(null);
    } catch {
      toast('Could not save your request. Please sign in and try again.');
    } finally {
      setBusy(false);
    }
  };

  const submitLead = async (e: FormEvent) => {
    e.preventDefault();
    if (!/\S+@\S+\.\S+/.test(lead.email)) { toast('Enter a valid work email.'); return; }
    try {
      await apiSend('PUT', `/records/sales_leads/${uid('lead')}`, { ...lead, requestedAt: new Date().toISOString() });
      setSales(false);
      toast('Request saved. Thanks — we will reach out at the email you gave.');
    } catch {
      toast('Could not save your request. Please sign in and try again.');
    }
  };

  return (
    <>
      <PageHero
        title={<>Plans &amp; <span className="grad">Pricing</span></>}
        lead="Choose the plan that fits your lifestyle."
        image="/aura/hero-pricing.jpg" imageWidth="36%"
        quote="A Smarter You for Every Journey."
        feats={[
          { icon: Zap, title: 'Flexible plans', sub: 'Upgrade or downgrade anytime' },
          { icon: ShieldCheck, title: 'Your data, your control', sub: 'Secure and private by design' },
          { icon: Star, title: 'More value, more possibilities', sub: 'Unlock advanced AI agents', tone: 'amber' },
        ]}
      >
        <div style={{ marginTop: 18 }}><NeonTabs tabs={['Monthly', 'Yearly'] as const} value={billing} onChange={setBilling} /></div>
      </PageHero>

      <div className="module">
        <div className="main">
          <div className="grid g3" style={{ alignItems: 'stretch' }}>
            {pricingPlans.map((p) => <PricingCard key={p.id} plan={p} yearly={yearly} current={current === p.id} onChoose={() => setChoose(p.id)} />)}
          </div>
        </div>
        <div className="rail">
          <button className="hud row" style={{ textAlign: 'left', gap: 14 }} onClick={() => setCompare(true)}>
            <IconBox icon={LayoutGrid} tone="blue" size="lg" />
            <div style={{ flex: 1 }}><b style={{ fontSize: 16 }}>Plan Comparison</b><div className="t-sub">See what's included in each plan.</div></div>
            <ChevronRight />
          </button>
          <Hud>
            <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}><IconBox icon={Building2} tone="blue" size="lg" /><div><b style={{ fontSize: 16 }}>Need a Custom Plan?</b><div className="t-sub">For businesses, educators, or large teams.</div></div></div>
            <NeonButton block style={{ marginTop: 14 }} onClick={() => setSales(true)}>Contact Sales</NeonButton>
          </Hud>
        </div>
      </div>

      <Hud corners>
        <h2 style={{ fontSize: 24, marginBottom: 16 }}>Why Upgrade to AURA Pro?</h2>
        <div className="grid g5">
          {why.map((w) => (
            <div className="row" key={w.t} style={{ alignItems: 'flex-start', gap: 14 }}>
              <IconBox icon={w.icon} tone={w.tone} size="lg" />
              <div><b style={{ fontSize: 14.5 }}>{w.t}</b><div className="t-sub">{w.s}</div></div>
            </div>
          ))}
        </div>
      </Hud>

      {plan && (
        <FuturisticModal title={plan.id === 'free' ? 'Free plan' : `Interested in ${plan.name}`} icon={Crown} tone="violet" onClose={() => !busy && setChoose(null)}>
          <div className="tile" style={{ marginBottom: 14 }}>
            <div className="row between"><b style={{ fontSize: 18 }}>{plan.name}</b><b className="c-cyan" style={{ fontSize: 18 }}>₹{(yearly ? plan.monthly * 10 : plan.monthly).toLocaleString('en-IN')} / {yearly ? 'year' : 'month'}</b></div>
            <ul style={{ margin: '10px 0 0', padding: 0, listStyle: 'none' }} className="stack">{plan.features.slice(0, 4).map((f) => <li key={f} className="row t-sub"><Check size={14} className="c-green" /> {f}</li>)}</ul>
          </div>
          <div className="row" style={{ marginBottom: 14 }}><span className="t-sub">Billing:</span><NeonTabs tabs={['Monthly', 'Yearly'] as const} value={billing} onChange={setBilling} /></div>
          <p className="t-mute" style={{ marginBottom: 16 }}>Paid plans aren't available yet and no payment provider is connected, so nothing is charged. Confirming saves your interest.</p>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <NeonButton onClick={() => setChoose(null)} disabled={busy}>Cancel</NeonButton>
            <NeonButton variant="ai" onClick={() => void confirm()} disabled={busy}>{busy ? <span className="spinner" /> : <><Check size={16} /> {plan.id === 'free' ? 'OK' : 'Notify me'}</>}</NeonButton>
          </div>
        </FuturisticModal>
      )}

      {compare && (
        <FuturisticModal title="Plan Comparison" icon={LayoutGrid} onClose={() => setCompare(false)}>
          <DataTable caption="Plan comparison" rowKey={(r) => r.feature} rows={planMatrix} columns={[
            { key: 'f', header: 'Feature', render: (r) => r.feature },
            { key: 'free', header: 'Free', render: (r) => r.free, align: 'center' },
            { key: 'pro', header: 'Pro', render: (r) => <b className="c-violet">{r.pro}</b>, align: 'center' },
            { key: 'team', header: 'Team', render: (r) => r.team, align: 'center' },
          ]} />
        </FuturisticModal>
      )}

      {sales && (
        <FuturisticModal title="Contact Sales" icon={Building2} onClose={() => setSales(false)}>
          <form className="stack" style={{ gap: 12 }} onSubmit={(e) => void submitLead(e)}>
            <HudInput label="Name" icon={User} value={lead.name || user.name} onChange={(e) => setLead({ ...lead, name: e.target.value })} />
            <HudInput label="Work email" icon={Mail} type="email" value={lead.email} onChange={(e) => setLead({ ...lead, email: e.target.value })} placeholder="you@company.com" autoFocus />
            <div className="field"><label htmlFor="team-size">Team size</label>
              <select id="team-size" className="select" style={{ height: 44 }} value={lead.size} onChange={(e) => setLead({ ...lead, size: e.target.value })}>{['2-9', '10-50', '51-200', '200+'].map((o) => <option key={o}>{o}</option>)}</select>
            </div>
            <div className="row" style={{ justifyContent: 'flex-end' }}><NeonButton type="button" onClick={() => setSales(false)}>Cancel</NeonButton><NeonButton type="submit" variant="primary">Send request</NeonButton></div>
          </form>
        </FuturisticModal>
      )}
    </>
  );
}
