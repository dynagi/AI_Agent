import { ChevronRight, Plus } from 'lucide-react';
import { CategoryBadge, IconBox, Bar, toneHex } from '../ui';
import { AppLogo } from '../aura';
import { txTone, formatWhen, type Transaction } from '../../data/transactions';
import { budgetMeta, type Budget } from '../../data/budgets';
import { goalIcons, type Goal } from '../../data/goals';

export const inr = (n: number) => `₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;

export function TransactionRow({ tx, hide }: { tx: Transaction; hide?: boolean }) {
  const income = tx.amount > 0;
  return (
    <div className="li">
      <AppLogo name={tx.logo} size={36} />
      <div className="grow"><div className="t-title">{tx.merchant}</div><div className="t-sub">{formatWhen(tx.ts)}</div></div>
      <span className="hide-sm"><CategoryBadge label={tx.category} tone={txTone[tx.category]} /></span>
      <b style={{ color: income ? 'var(--aura-green)' : '#ff6f9a', minWidth: 92, textAlign: 'right', fontSize: 16 }}>{hide ? '••••' : `${income ? '+ ' : '- '}${inr(tx.amount)}`}</b>
    </div>
  );
}

export function BudgetCard({ b, spent, hide, onEdit }: { b: Budget; spent: number; hide?: boolean; onEdit: () => void }) {
  const { icon: Icon, tone } = budgetMeta[b.category];
  const pct = Math.round((spent / b.limit) * 100);
  return (
    <button className="li" onClick={onEdit} style={{ background: 'none', border: 0, width: '100%', textAlign: 'left' }} aria-label={`${b.category} budget, ${pct}% used. Edit`}>
      <Icon size={22} style={{ color: toneHex[tone], flexShrink: 0 }} />
      <span style={{ width: 120, fontSize: 14 }}>{b.category}</span>
      <div className="grow">
        <div className="row between" style={{ fontSize: 13, marginBottom: 4 }}><span style={{ color: toneHex[tone] }}>{hide ? '••••' : `${inr(spent)} / ${inr(b.limit)}`}</span><span>{pct}%</span></div>
        <Bar value={pct} tone={pct > 90 ? 'red' : tone} />
      </div>
      <ChevronRight size={16} className="t-sub" />
    </button>
  );
}

export function GoalCard({ g, hide, onContribute }: { g: Goal; hide?: boolean; onContribute: () => void }) {
  const pct = Math.round((g.saved / g.target) * 100);
  return (
    <div className="row">
      <IconBox icon={goalIcons[g.icon]} tone={g.tone} size="lg" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="t-title">{g.name}</div>
        <div className="row between t-sub" style={{ fontSize: 12.5, margin: '2px 0 6px' }}><span>{hide ? '••••' : `${inr(g.saved)} / ${inr(g.target)}`}</span><span style={{ color: '#fff' }}>{pct}%</span></div>
        <Bar value={pct} tone={g.tone} />
      </div>
      <button className="icon-btn" style={{ width: 30, height: 30 }} onClick={onContribute} aria-label={`Add money to ${g.name}`}><Plus size={14} /></button>
    </div>
  );
}
