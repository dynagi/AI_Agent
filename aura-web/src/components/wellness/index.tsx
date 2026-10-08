import { IconBox } from '../ui';
import { wellnessIcon, type Meal, type Metric, type PlanItem } from '../../data/wellness';

/** Timeline row in "Today's Wellness Plan". `done` is derived from the day, so routines reset each morning. */
export function PlanRow({ item, done, last, onToggle }: { item: PlanItem; done: boolean; last: boolean; onToggle: () => void }) {
  return (
    <div className="row" style={{ alignItems: 'stretch', gap: 12 }}>
      <div style={{ width: 62, paddingTop: 10, fontSize: 13.5, flexShrink: 0 }}>{item.time}</div>
      <div className="stack" style={{ gap: 0, alignItems: 'center', width: 10 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', marginTop: 14, background: done ? 'var(--aura-green)' : 'var(--aura-primary)', boxShadow: `0 0 8px ${done ? 'var(--aura-green)' : 'var(--aura-primary)'}` }} />
        {!last && <span style={{ flex: 1, width: 1.5, background: 'var(--aura-border-mid)' }} />}
      </div>
      <div className="li grow" style={{ padding: '6px 0 12px' }}>
        <IconBox icon={wellnessIcon(item.icon)} tone={item.tone} />
        <div className="grow"><div className="t-title">{item.title}</div><div className="t-sub">{item.sub}</div></div>
        <input type="checkbox" className="check" style={{ width: 24, height: 24, borderRadius: '50%' }} checked={done} onChange={onToggle} aria-label={`Mark ${item.title} done`} />
      </div>
    </div>
  );
}

export function MetricRow({ m, onRemove }: { m: Metric; onRemove?: () => void }) {
  return (
    <div className="li">
      <IconBox icon={wellnessIcon(m.icon)} tone={m.tone} size="sm" />
      <div className="grow"><div style={{ fontSize: 14 }}>{m.name}</div><div className="t-sub">{m.value}</div></div>
      {m.status && <span className="tag" style={{ color: 'var(--aura-green)', borderColor: 'transparent', background: 'rgba(0,229,168,0.1)' }}>{m.status}</span>}
      {onRemove && <button className="icon-btn bare" style={{ width: 24, height: 24 }} onClick={onRemove} aria-label={`Remove ${m.name}`}>×</button>}
    </div>
  );
}

export function MealRow({ meal, onToggle, onRemove }: { meal: Meal; onToggle: () => void; onRemove: () => void }) {
  return (
    <div className="li">
      <div className="grow"><div className="t-title" style={{ fontSize: 15 }}>{meal.name}</div><div className="t-sub" style={{ fontSize: 13.5 }}>{meal.dish}</div><div className="t-sub">{meal.kcal} kcal</div></div>
      <input type="checkbox" className="check" style={{ width: 24, height: 24, borderRadius: '50%' }} checked={meal.eaten} onChange={onToggle} aria-label={`Ate ${meal.name}`} />
      <button className="icon-btn bare" style={{ width: 24, height: 24 }} onClick={onRemove} aria-label={`Remove ${meal.name}`}>×</button>
    </div>
  );
}
