import { useState } from 'react';
import { ArrowRight, Clock, Pencil, Trash2, Play, Copy, Plus, Wand2, Zap, ListChecks, ShieldCheck, Check } from 'lucide-react';
import { IconBox, MoreMenu, Toggle, CategoryBadge, type Tone } from '../ui';
import { AppLogo, FuturisticModal, NeonButton, HudInput } from '../aura';
import { autoIcon, type AutoCategory, type AutoTemplate, type Automation } from '../../data/automations';
import { aura } from '../../services/aura';

const tagTone = (t: string): Tone => (/(Finance|Tracking)/.test(t) ? 'green' : /(Health|Fitness)/.test(t) ? 'red' : /(Shopping|Lifestyle)/.test(t) ? 'magenta' : /(Travel|Planning)/.test(t) ? 'cyan' : 'blue');

function actionsFor(a: Automation, h: { onEdit: () => void; onRun: () => void; onDuplicate: () => void; onDelete: () => void }) {
  return [
    { label: 'Run now', icon: Play, onSelect: h.onRun },
    { label: 'Edit', icon: Pencil, onSelect: h.onEdit },
    { label: 'Duplicate', icon: Copy, onSelect: h.onDuplicate },
    { label: 'Delete', icon: Trash2, danger: true, onSelect: h.onDelete },
  ].filter((x) => a.active || x.label !== 'Run now');
}

/** AutomationCard — `flow` = featured app→app card (ref 26); default = grid card (ref 27) */
export function AutomationCard({ a, flow, onToggle, onEdit, onRun, onDuplicate, onDelete }: {
  a: Automation; flow?: boolean; onToggle: (v: boolean) => void; onEdit: () => void; onRun: () => void; onDuplicate: () => void; onDelete: () => void;
}) {
  const menu = actionsFor(a, { onEdit, onRun, onDuplicate, onDelete });
  if (flow) {
    return (
      <article className="tile stack" style={{ gap: 10, padding: 16 }}>
        <div className="flow"><AppLogo name={a.from ?? 'AURA'} size={42} /><ArrowRight className="arrow" size={20} /><AppLogo name={a.to ?? 'AURA'} size={42} /></div>
        <h4 style={{ margin: 0, fontSize: 17 }}>{a.name}</h4>
        <p className="t-sub" style={{ margin: 0, fontSize: 13 }}>{a.description}</p>
        <div className="row wrap" style={{ gap: 6 }}>{a.tags.map((t) => <span key={t} className="tag blue">{t}</span>)}</div>
        <div className="row between" style={{ marginTop: 'auto' }}>
          <span className="row" style={{ gap: 8 }}><Toggle on={a.active} onChange={onToggle} label={`${a.name} active`} /> <span style={{ fontSize: 13 }}>{a.active ? 'Active' : 'Paused'}</span></span>
          <MoreMenu items={menu} label={`Actions for ${a.name}`} />
        </div>
      </article>
    );
  }
  return (
    <article className="tile stack" style={{ gap: 8, padding: 14 }}>
      <div className="row between"><IconBox icon={autoIcon(a.icon)} tone={a.tone} /><Toggle on={a.active} onChange={onToggle} label={`${a.name} active`} /></div>
      <h4 style={{ margin: 0, fontSize: 16.5 }}>{a.name}</h4>
      <p className="t-sub" style={{ margin: 0, fontSize: 13 }}>{a.description}</p>
      <div className="row wrap" style={{ gap: 6 }}>{a.tags.map((t) => <CategoryBadge key={t} label={t} tone={tagTone(t)} />)}</div>
      <div className="row between t-sub" style={{ marginTop: 'auto', fontSize: 12.5 }}>
        <span className="row" style={{ gap: 5 }}><Clock size={13} /> {a.schedule}</span>
        <MoreMenu items={menu} label={`Actions for ${a.name}`} vertical />
      </div>
    </article>
  );
}

export function TemplateCard({ t, compact, onUse }: { t: AutoTemplate; compact?: boolean; onUse: () => void }) {
  return (
    <article className={compact ? 'tile row' : 'tile stack'} style={{ gap: compact ? 12 : 8, padding: 12, alignItems: compact ? 'flex-start' : undefined }}>
      <IconBox icon={autoIcon(t.icon)} tone={t.tone} size={compact ? 'md' : 'lg'} />
      <div className="stack" style={{ gap: 6, flex: 1 }}>
        <b style={{ fontSize: 14 }}>{t.name}</b>
        <span className="t-sub" style={{ fontSize: 12.5 }}>{t.description}</span>
        {!compact && <div className="row wrap" style={{ gap: 6 }}>{t.tags.map((x) => <span key={x} className="tag blue">{x}</span>)}</div>}
        <NeonButton size="sm" icon={compact ? undefined : Plus} onClick={onUse} style={{ alignSelf: compact ? 'flex-start' : 'center' }}>{compact ? 'Use Template' : 'Add Automation'}</NeonButton>
      </div>
    </article>
  );
}

/* ---------- Creation wizard ---------- */

export interface Draft { name: string; description: string; category: AutoCategory; trigger: string; steps: string[]; schedule: string; needsApproval: boolean }

/** Keyword-based fallback used when the AI planner is unavailable. */
export function draftFromText(text: string): Draft {
  const t = text.toLowerCase();
  const trigger = /when(ever)? i (get|receive) (an? )?email/.test(t) ? 'New email received (Gmail)'
    : /travel itinerary|new trip|add a new trip/.test(t) ? 'New travel itinerary detected'
      : /every (day|morning)|daily/.test(t) ? 'Every day at 8:00 AM'
        : /week/.test(t) ? 'Every Sunday at 10:00 AM' : 'When I ask AURA';
  const steps: string[] = [];
  if (/task/.test(t)) steps.push('Create a task in Tasks');
  if (/calendar/.test(t)) steps.push('Add to Google Calendar');
  if (/slack/.test(t)) steps.push('Notify me on Slack');
  if (/shopping list|shopping/.test(t)) steps.push('Create a shopping list');
  if (/remind/.test(t)) steps.push('Schedule reminders');
  if (/summar/.test(t)) steps.push('Summarize with AURA');
  if (/notion|note/.test(t)) steps.push('Save to Notion');
  if (!steps.length) steps.push('Ask AURA to handle it', 'Send me a summary');
  const category: AutoCategory = /travel|trip/.test(t) ? 'Travel' : /email|slack/.test(t) ? 'Communication' : /shop|order/.test(t) ? 'Shopping' : /expense|budget/.test(t) ? 'Finance' : 'Custom';
  const needsApproval = /(buy|order|book|pay|send)/.test(t);
  return {
    name: text.length > 36 ? `${text.slice(0, 34).replace(/^"|"$/g, '')}…` : text.replace(/^"|"$/g, ''),
    description: text.replace(/^"|"$/g, ''), category, trigger, steps,
    schedule: trigger.startsWith('Every') ? `Runs ${trigger.replace('Every day at', 'daily •').replace('Every Sunday at', 'weekly • Sunday')}` : trigger === 'When I ask AURA' ? 'Runs on request' : 'Runs on event',
    needsApproval,
  };
}

/** Builds a workflow draft: the AI planner proposes the steps; trigger/category come from the wording. Falls back to keywords if the planner is down. */
export async function buildDraft(text: string): Promise<Draft> {
  const base = draftFromText(text);
  try {
    const tasks = await aura.plan(`Automation workflow: ${text}`);
    const steps = tasks.map((t) => t.title).filter(Boolean).slice(0, 8);
    return steps.length ? { ...base, steps } : base;
  } catch {
    return base;
  }
}

export function AutomationWizard({ initial, onCreate, onClose, title = 'Create Automation' }: { initial?: Draft; onCreate: (d: Draft) => void; onClose: () => void; title?: string }) {
  const [step, setStep] = useState(initial ? 1 : 0);
  const [text, setText] = useState(initial?.description ?? '');
  const [d, setD] = useState<Draft | null>(initial ?? null);
  const [building, setBuilding] = useState(false);
  const steps = ['Describe', 'Trigger & actions', 'Review'];
  return (
    <FuturisticModal title={title} icon={Wand2} onClose={onClose}>
      <ol className="row" style={{ listStyle: 'none', padding: 0, margin: '0 0 14px', gap: 8 }} aria-label="Wizard progress">
        {steps.map((s, i) => <li key={s} className={`chip ${i === step ? 'active' : ''}`} aria-current={i === step ? 'step' : undefined}>{i < step ? <Check size={13} /> : i + 1}. {s}</li>)}
      </ol>
      {step === 0 && (
        <div className="stack" style={{ gap: 12 }}>
          <label htmlFor="wz-text" className="t-sub">Describe what you want to automate in plain language.</label>
          <textarea id="wz-text" className="hud-textarea" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder='e.g. "When I receive an email from my manager, add it to my tasks and notify me on Slack"' autoFocus />
          <div className="row" style={{ justifyContent: 'flex-end' }}><NeonButton variant="primary" disabled={!text.trim() || building} onClick={() => { setBuilding(true); void buildDraft(text).then((draft) => { setD(draft); setStep(1); }).finally(() => setBuilding(false)); }}>{building ? <span className="spinner" /> : 'Build with AURA'}</NeonButton></div>
        </div>
      )}
      {step === 1 && d && (
        <div className="stack" style={{ gap: 12 }}>
          <HudInput label="Name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
          <div className="tile"><div className="row" style={{ gap: 8 }}><Zap size={16} className="c-amber" /><b>Trigger</b></div>
            <select className="select" style={{ marginTop: 8, width: '100%', height: 40 }} value={d.trigger} onChange={(e) => setD({ ...d, trigger: e.target.value })} aria-label="Trigger">
              {['New email received (Gmail)', 'New travel itinerary detected', 'Every day at 8:00 AM', 'Every Sunday at 10:00 AM', 'When I ask AURA', d.trigger].filter((v, i, a) => a.indexOf(v) === i).map((o) => <option key={o}>{o}</option>)}
            </select>
          </div>
          <div className="tile"><div className="row" style={{ gap: 8 }}><ListChecks size={16} className="c-cyan" /><b>Actions</b></div>
            <ol style={{ margin: '8px 0 0', paddingLeft: 20 }}>{d.steps.map((s, i) => (
              <li key={s + i} className="row between" style={{ padding: '3px 0' }}><span>{s}</span><button className="icon-btn bare" style={{ width: 24, height: 24 }} aria-label={`Remove ${s}`} onClick={() => setD({ ...d, steps: d.steps.filter((_, j) => j !== i) })}><Trash2 size={13} /></button></li>
            ))}</ol>
          </div>
          <label className="row t-sub" style={{ cursor: 'pointer' }}><input type="checkbox" className="check" checked={d.needsApproval} onChange={(e) => setD({ ...d, needsApproval: e.target.checked })} /> <ShieldCheck size={15} /> Ask for my approval before it acts</label>
          <div className="row between"><NeonButton onClick={() => setStep(0)}>Back</NeonButton><NeonButton variant="primary" disabled={!d.steps.length} onClick={() => setStep(2)}>Review</NeonButton></div>
        </div>
      )}
      {step === 2 && d && (
        <div className="stack" style={{ gap: 12 }}>
          <div className="tile"><b>{d.name}</b><div className="t-sub" style={{ margin: '6px 0' }}>When: {d.trigger}</div><ol style={{ margin: 0, paddingLeft: 20 }} className="t-sub">{d.steps.map((s) => <li key={s}>{s}</li>)}</ol>
            <div className="t-mute" style={{ marginTop: 8 }}>{d.needsApproval ? 'Approval gate ON — AURA will ask before acting.' : 'Runs automatically within your permission scopes.'}</div></div>
          <p className="t-mute">It will be created <b>paused</b>. Turn it on when you're ready.</p>
          <div className="row between"><NeonButton onClick={() => setStep(1)}>Back</NeonButton><NeonButton variant="primary" icon={Check} onClick={() => onCreate(d)}>Create Automation</NeonButton></div>
        </div>
      )}
    </FuturisticModal>
  );
}
