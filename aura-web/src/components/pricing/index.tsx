import { Check, Crown } from 'lucide-react';
import { IconBox, toneHex } from '../ui';
import { NeonButton } from '../aura';
import type { PricingPlan } from '../../data/pricingPlans';

export function PricingCard({ plan, yearly, current, onChoose }: { plan: PricingPlan; yearly: boolean; current: boolean; onChoose: () => void }) {
  const price = yearly ? plan.monthly * 10 : plan.monthly;
  const glow = plan.popular ? 'glow-violet' : plan.id === 'team' ? 'glow-cyan' : '';
  return (
    <article className={`hud ${glow} stack`} style={{ gap: 14, transform: plan.popular ? 'translateY(-6px)' : undefined, ['--bd' as string]: plan.popular ? undefined : plan.id === 'team' ? `${toneHex.teal}aa` : 'var(--aura-border-hi)' }}>
      <div className="row" style={{ gap: 14 }}>
        <IconBox icon={plan.icon} tone={plan.tone} size="lg" />
        <div>
          <div className="row"><b style={{ fontSize: 22 }}>{plan.name}</b>{plan.popular && <span className="tag violet" style={{ background: 'rgba(139,92,255,0.35)', color: '#fff' }}>Most Popular</span>}</div>
          <div className="t-sub" style={{ fontSize: 14 }}>{plan.tagline}</div>
        </div>
      </div>
      <div style={{ borderBottom: '1px solid var(--aura-border)', paddingBottom: 12 }}>
        <span className="price">₹{price.toLocaleString('en-IN')}</span> <span className={plan.id === 'team' ? 'c-green' : 't-sub'} style={{ fontSize: 17 }}>/ {yearly ? 'year' : 'month'}</span>
        {yearly && plan.monthly > 0 && <div className="c-green" style={{ fontSize: 12 }}>2 months free vs monthly</div>}
      </div>
      <ul className="stack" style={{ gap: 9, margin: 0, padding: 0, listStyle: 'none' }}>
        {plan.features.map((f) => <li key={f} className="row" style={{ fontSize: 14 }}><Check size={17} className="c-green" /> {f}</li>)}
      </ul>
      <NeonButton block size="lg" variant={plan.popular ? 'ai' : current ? 'default' : 'primary'} disabled={current} onClick={onChoose} style={{ marginTop: 'auto' }} aria-label={current ? `${plan.name} is your current plan` : `${plan.cta}`}>
        {plan.popular && <Crown size={17} className="c-amber" />} {current ? 'Current Plan' : plan.cta}
      </NeonButton>
    </article>
  );
}
