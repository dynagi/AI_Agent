import { useMemo, useState } from 'react';
import { Droplets, CalendarClock, Plus, Trash2, ShoppingBag, X, Sparkles, Lightbulb, Lock, Unlock, TrendingUp } from 'lucide-react';
import { Hud, IconBox, NeonButton, FuturisticModal, HudInput, Toggle, toast } from '../aura';
import { Companion } from './Companion';
import SuppliesModal from './SuppliesModal';
import { addDays, cycleStats, dayDiff, forecast, iso, phaseInfo, phaseOf, type ForecastPeriod, type Phase } from '../../data/cycle';
import { DEFAULT_PERIOD_PREFS, type Flow, type PeriodEntry, type PeriodPrefs } from '../../data/wellness';
import { periodPrefsStore, periodStore } from '../../state/stores';
import { uid } from '../../state/store';

const FLOWS: Flow[] = ['Light', 'Medium', 'Heavy'];
const DOW = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const HORIZONS = [3, 6, 12] as const;
const SYMPTOM_TAGS = ['Cramps', 'Bloating', 'Headache', 'Fatigue', 'Low mood'];
const fmt = (d: string, o: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }) => new Date(`${d}T00:00:00`).toLocaleDateString('en-US', o);

/** Ring showing the four phases of an average cycle with a marker for today. */
function PhaseRing({ cycleLen, periodLen, day }: { cycleLen: number; periodLen: number; day?: number }) {
  const size = 190, r = 74, C = 2 * Math.PI * r;
  const counts = new Map<Phase, number>();
  const order: Phase[] = [];
  for (let d = 1; d <= cycleLen; d++) { const p = phaseOf(d, periodLen, cycleLen); if (!counts.has(p)) order.push(p); counts.set(p, (counts.get(p) ?? 0) + 1); }
  let acc = 0;
  const arcs = order.map((p) => { const len = (counts.get(p) ?? 0) / cycleLen; const a = { p, len, start: acc }; acc += len; return a; });
  const cur = day ? Math.min(day, cycleLen) : undefined;
  const ang = cur ? ((cur - 0.5) / cycleLen) * 2 * Math.PI - Math.PI / 2 : 0;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label="Cycle phases">
      {arcs.map((a) => <circle key={a.p} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={phaseInfo[a.p].color} strokeWidth="16" strokeDasharray={`${Math.max(0, a.len * C - 3)} ${C}`} strokeDashoffset={-a.start * C} transform={`rotate(-90 ${size / 2} ${size / 2})`} opacity={0.85} />)}
      {cur && <circle cx={size / 2 + r * Math.cos(ang)} cy={size / 2 + r * Math.sin(ang)} r="9" fill="#fff" stroke="#031020" strokeWidth="3" style={{ filter: 'drop-shadow(0 0 6px #fff)' }} />}
      <text x="50%" y="46%" textAnchor="middle" fill="#fff" fontSize="30" fontWeight="700">{day ? `Day ${day}` : '—'}</text>
      <text x="50%" y="60%" textAnchor="middle" fill="#9fb6d1" fontSize="12">of ~{cycleLen}-day cycle</text>
    </svg>
  );
}

function MonthGrid({ entries, fc, periodLen, today }: { entries: PeriodEntry[]; fc: ForecastPeriod[]; periodLen: number; today: string }) {
  const [offset, setOffset] = useState(0);
  const base = new Date(); base.setDate(1); base.setMonth(base.getMonth() + offset);
  const y = base.getFullYear(); const m = base.getMonth();
  const first = (new Date(y, m, 1).getDay() + 6) % 7;
  const total = new Date(y, m + 1, 0).getDate();
  const logged = useMemo(() => {
    const s = new Set<string>();
    for (const e of entries) {
      const end = e.end ?? (dayDiff(e.start, today) < periodLen ? today : addDays(e.start, periodLen - 1));
      for (let d = e.start; d <= end; d = addDays(d, 1)) s.add(d);
    }
    return s;
  }, [entries, periodLen, today]);
  const predicted = useMemo(() => { const s = new Set<string>(); fc.forEach((f) => { for (let d = f.start; d <= f.end; d = addDays(d, 1)) s.add(d); }); return s; }, [fc]);
  const ovulation = useMemo(() => new Set(fc.map((f) => f.ovulation)), [fc]);
  const cells = [...Array(first).fill(null), ...Array.from({ length: total }, (_, i) => iso(new Date(y, m, i + 1)))];
  return (
    <div>
      <div className="row between" style={{ marginBottom: 8 }}>
        <button type="button" className="icon-btn" style={{ width: 28, height: 28 }} onClick={() => setOffset((o) => o - 1)} aria-label="Previous month">‹</button>
        <b>{base.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</b>
        <button type="button" className="icon-btn" style={{ width: 28, height: 28 }} onClick={() => setOffset((o) => o + 1)} aria-label="Next month">›</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0,1fr))', gap: 4, textAlign: 'center', fontSize: 12 }}>
        {DOW.map((d) => <span key={d} className="t-sub">{d}</span>)}
        {cells.map((c, i) => c === null ? <span key={i} /> : (
          <span key={c} title={logged.has(c) ? 'Period day' : predicted.has(c) ? 'Predicted period' : ovulation.has(c) ? 'Estimated ovulation' : undefined}
            style={{ padding: '7px 0', borderRadius: 6, background: logged.has(c) ? 'rgba(255,79,216,0.5)' : undefined, border: logged.has(c) ? '1.5px solid transparent' : predicted.has(c) ? '1.5px dashed #FF4FD8' : ovulation.has(c) ? '1.5px dashed #00E5A8' : c === today ? '1.5px solid var(--aura-cyan)' : '1.5px solid transparent' }}>{Number(c.slice(8))}</span>
        ))}
      </div>
      <div className="row wrap" style={{ gap: 14, marginTop: 10, fontSize: 12 }}>
        <span className="row" style={{ gap: 6 }}><span style={{ width: 12, height: 12, borderRadius: 3, background: 'rgba(255,79,216,0.5)' }} /> Logged</span>
        <span className="row" style={{ gap: 6 }}><span style={{ width: 12, height: 12, borderRadius: 3, border: '1.5px dashed #FF4FD8' }} /> Predicted period</span>
        <span className="row" style={{ gap: 6 }}><span style={{ width: 12, height: 12, borderRadius: 3, border: '1.5px dashed #00E5A8' }} /> Est. ovulation</span>
      </div>
    </div>
  );
}

export default function PeriodTab() {
  const periods = periodStore.use();
  const prefsList = periodPrefsStore.use();
  const prefs: PeriodPrefs = { ...DEFAULT_PERIOD_PREFS, ...prefsList[0] };
  const today = iso(new Date());
  const cycle = useMemo(() => cycleStats(periods, today), [periods, today]);
  const [months, setMonths] = useState<(typeof HORIZONS)[number]>(6);
  const fc = useMemo(() => forecast(cycle, months, today), [cycle, months, today]);
  const [dialog, setDialog] = useState<'log' | 'supplies' | null>(null);
  const [form, setForm] = useState<{ start: string; end: string; flow: Flow; note: string }>({ start: today, end: '', flow: 'Medium', note: '' });
  const [craving, setCraving] = useState('');
  const [revealed, setRevealed] = useState(false);

  const daysToNext = cycle.next ? dayDiff(today, cycle.next) : undefined;
  const day = cycle.cycleDay && cycle.cycleDay <= cycle.cycleLen + 14 ? cycle.cycleDay : undefined;
  const phase: Phase | undefined = day ? phaseOf(Math.min(day, cycle.cycleLen), cycle.periodLen, cycle.cycleLen) : undefined;
  const reminderDay = cycle.next ? addDays(cycle.next, -1) : undefined;
  const setPrefs = (p: Partial<PeriodPrefs>) => periodPrefsStore.set([{ ...prefs, ...p, id: 'prefs' }]);

  // Estimates only — "you've logged...", never a diagnosis or a certainty claim.
  const insights = useMemo(() => {
    const cycleGaps = cycle.sorted.slice(1).map((e, i) => dayDiff(cycle.sorted[i].start, e.start)).filter((n) => n >= 15 && n <= 60);
    const flows = cycle.sorted.map((e) => e.flow).filter((f): f is Flow => !!f);
    const flowCounts = flows.reduce<Record<string, number>>((acc, f) => ({ ...acc, [f]: (acc[f] ?? 0) + 1 }), {});
    const dominantFlow = Object.entries(flowCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
    const lines: string[] = [];
    if (cycleGaps.length >= 2) lines.push(`Your logged cycles have varied between about ${Math.min(...cycleGaps)}–${Math.max(...cycleGaps)} days.`);
    if (dominantFlow) lines.push(`Your most frequently logged flow is ${dominantFlow}.`);
    const notes = cycle.sorted.map((e) => e.note?.toLowerCase() ?? '');
    for (const tag of SYMPTOM_TAGS) {
      const count = notes.filter((n) => n.includes(tag.toLowerCase())).length;
      if (count >= 3) lines.push(`You've logged ${tag.toLowerCase()} on ${count} recent cycle entries.`);
    }
    return lines;
  }, [cycle.sorted]);

  const savePeriod = (e: React.FormEvent) => {
    e.preventDefault();
    const start = form.start || today;
    if (start > today) return toast('The start date cannot be in the future.');
    if (form.end && form.end < start) return toast('The end date must be on or after the start date.');
    periodStore.set((ps) => [...ps, { id: uid('pd'), start, end: form.end || undefined, flow: form.flow, note: form.note.trim() || undefined }]);
    setDialog(null);
    setForm({ start: today, end: '', flow: 'Medium', note: '' });
    toast('Period logged. Your predictions were updated.');
  };
  const addCraving = () => {
    const c = craving.trim();
    if (!c) return;
    if (prefs.cravings.some((x) => x.toLowerCase() === c.toLowerCase())) { setCraving(''); return; }
    setPrefs({ cravings: [...prefs.cravings, c] });
    setCraving('');
  };

  if (prefs.privateMode && !revealed) {
    return (
      <Hud corners title="Period Care" icon={Lock}>
        <div className="stack" style={{ alignItems: 'center', gap: 12, padding: '24px 0' }}>
          <Companion mood="calm" />
          <p className="t-sub" style={{ textAlign: 'center', maxWidth: 360 }}>Private Period Mode is on — your cycle details are hidden until you reveal them.</p>
          <NeonButton icon={Unlock} variant="primary" onClick={() => setRevealed(true)}>Show my cycle</NeonButton>
          <button className="link c-blue" style={{ background: 'none', border: 0, fontSize: 12.5 }} onClick={() => setPrefs({ privateMode: false })}>Turn off Private Mode</button>
        </div>
      </Hud>
    );
  }

  return (
    <div className="grid g2">
      <Hud corners title={<span className="row" style={{ gap: 8 }}>🌸 Your cycle</span>} icon={Droplets} action="Log period" onAction={() => { setForm({ start: today, end: '', flow: 'Medium', note: '' }); setDialog('log'); }}>
        <div className="row wrap" style={{ gap: 18, alignItems: 'center' }}>
          <PhaseRing cycleLen={cycle.cycleLen} periodLen={cycle.periodLen} day={day} />
          <div style={{ flex: 1, minWidth: 220 }}>
            {phase ? (
              <>
                <span className="tag" style={{ color: phaseInfo[phase].color, borderColor: `${phaseInfo[phase].color}88` }}>{cycle.ongoing ? 'Period in progress' : `${phase} phase`}</span>
                <p className="t-sub" style={{ margin: '8px 0' }}>{phaseInfo[phase].blurb}</p>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  {cycle.ongoing && <NeonButton size="sm" icon={CalendarClock} onClick={() => { periodStore.set((ps) => ps.map((p) => (p.id === cycle.ongoing!.id ? { ...p, end: today } : p))); toast('Period marked as ended today.'); }}>Mark ended today</NeonButton>}
                </div>
              </>
            ) : <p className="t-sub">Log your latest period to see your current phase and predictions.</p>}
            <div className="grid g2" style={{ gap: 8, marginTop: 10 }}>
              <div className="tile"><b style={{ fontSize: 19 }}>{cycle.next ? fmt(cycle.next) : '—'}</b><div className="t-sub" style={{ fontSize: 12 }}>{daysToNext === undefined ? 'Next period' : daysToNext > 0 ? `Next period in ~${daysToNext} day${daysToNext > 1 ? 's' : ''}` : daysToNext === 0 ? 'Expected today' : `Expected ${-daysToNext} day${-daysToNext > 1 ? 's' : ''} ago`}</div></div>
              <div className="tile"><b style={{ fontSize: 19 }}>{cycle.cycleLen} / {cycle.periodLen} days</b><div className="t-sub" style={{ fontSize: 12 }}>{cycle.learned ? 'Avg cycle / period' : 'Defaults until 3 periods are logged'}</div></div>
            </div>
          </div>
        </div>
        {phase && (
          <div style={{ marginTop: 14 }}>
            <div className="row" style={{ gap: 8, marginBottom: 6 }}><Lightbulb size={16} className="c-amber" /><b>Suggestions for this phase</b></div>
            <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8 }} className="t-sub">{phaseInfo[phase].tips.map((t) => <li key={t}>{t}</li>)}</ul>
          </div>
        )}
        <p className="t-mute" style={{ marginTop: 12 }}>Estimates are based only on what you log — they are not medical advice or a method of contraception. Your entries are private to your account. If your cycle changes suddenly or you have concerns, please talk to a doctor.</p>
      </Hud>

      <Hud corners title="Forecast" icon={CalendarClock} action={<span className="row" style={{ gap: 4 }}>{HORIZONS.map((h) => <button key={h} type="button" className={`chip ${months === h ? 'active' : ''}`} style={{ padding: '4px 10px' }} onClick={(e) => { e.stopPropagation(); setMonths(h); }} aria-pressed={months === h}>{h} mo</button>)}</span>}>
        {fc.length ? (
          <div className="list" style={{ maxHeight: 250, overflowY: 'auto' }}>
            {fc.map((f, i) => {
              const inDays = dayDiff(today, f.start);
              return (
                <div className="li" key={f.start}>
                  <span className="icon-box sm" style={{ fontWeight: 700 }}>{i + 1}</span>
                  <div className="grow"><div className="t-title">{fmt(f.start)} – {fmt(f.end)}</div><div className="t-sub">{inDays > 0 ? `in ~${inDays} days` : inDays === 0 ? 'today' : 'just started'} · est. ovulation ~{fmt(f.ovulation)}</div></div>
                </div>
              );
            })}
          </div>
        ) : <div className="empty">Log a period to see your forecast.</div>}
        {fc.length > 0 && <p className="t-mute" style={{ marginTop: 8 }}>{fc.length} predicted period{fc.length > 1 ? 's' : ''} over the next {months} months, assuming a steady {cycle.cycleLen}-day cycle. Predictions further ahead are less certain; browse later months on the calendar below. They sharpen as you log more.</p>}
      </Hud>

      <Hud corners title="Calendar" icon={CalendarClock}>
        <MonthGrid entries={periods} fc={forecast(cycle, 24, today)} periodLen={cycle.periodLen} today={today} />
      </Hud>

      {insights.length > 0 && (
        <Hud corners title="Your cycle insights" icon={TrendingUp}>
          <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8 }} className="t-sub">{insights.map((l) => <li key={l}>{l}</li>)}</ul>
          <p className="t-mute" style={{ marginTop: 8 }}>Patterns in your self-reported data, not medical conclusions. If anything here concerns you, it may be worth discussing with a healthcare professional.</p>
        </Hud>
      )}

      <Hud corners title="Supplies & cravings" icon={ShoppingBag} action="Preview prices" onAction={() => setDialog('supplies')}>
        <p className="t-sub" style={{ marginBottom: 12 }}>The day before your period is expected, AURA finds the lowest live prices for your usual products and cravings and <b style={{ color: '#fff' }}>asks for your approval</b> before adding anything to your cart. It never orders on its own.</p>
        <div className="list">
          <div className="li"><span className="grow">Automatically prepare the day before</span><Toggle on={prefs.autoPrepare} onChange={(v) => setPrefs({ autoPrepare: v })} label="Prepare supplies the day before" /></div>
          <div className="li"><span className="grow row" style={{ gap: 6 }}><Lock size={14} /> Private Period Mode</span><Toggle on={!!prefs.privateMode} onChange={(v) => setPrefs({ privateMode: v })} label="Hide cycle details behind a reveal tap" /></div>
        </div>
        <div className="form-grid" style={{ marginTop: 10 }}>
          <HudInput label="Usual product" value={prefs.padQuery} onChange={(e) => setPrefs({ padQuery: e.target.value })} placeholder="e.g. Whisper Ultra pads XL" />
          <HudInput label="Quantity (packs)" type="number" min={1} max={10} value={String(prefs.padQty)} onChange={(e) => setPrefs({ padQty: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })} />
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <label htmlFor="craving">Cravings to add to the cart</label>
          <div className="row" style={{ gap: 8 }}>
            <div className="input" style={{ flex: 1 }}><input id="craving" value={craving} onChange={(e) => setCraving(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCraving(); } }} placeholder="e.g. dark chocolate, ice cream" /></div>
            <NeonButton onClick={addCraving} icon={Plus} disabled={!craving.trim()}>Add</NeonButton>
          </div>
          <div className="row wrap" style={{ gap: 8, marginTop: 8 }}>
            {prefs.cravings.map((c) => <span key={c} className="chip active" style={{ gap: 6 }}>{c}<button type="button" className="icon-btn bare" style={{ width: 18, height: 18 }} onClick={() => setPrefs({ cravings: prefs.cravings.filter((x) => x !== c) })} aria-label={`Remove ${c}`}><X size={12} /></button></span>)}
            {!prefs.cravings.length && <span className="t-mute">No cravings added yet.</span>}
          </div>
        </div>
        <div className="tile row" style={{ marginTop: 12, gap: 10 }}>
          <Sparkles size={18} className="c-cyan" />
          <span style={{ fontSize: 13 }}>{!prefs.autoPrepare ? 'Automatic preparation is off. You can still preview prices any time.' : reminderDay ? `Next reminder: ${fmt(reminderDay, { weekday: 'long', month: 'short', day: 'numeric' })}. Open AURA that day (or up to 2 days after) to review your cart.` : 'Log a period to schedule the next reminder.'}</span>
        </div>
      </Hud>

      <Hud corners title="History" className="w-plan">
        <div className="list">
          {[...cycle.sorted].reverse().map((p, i, arr) => {
            const prev = arr[i + 1];
            const len = p.end ? dayDiff(p.start, p.end) + 1 : undefined;
            const gap = prev ? dayDiff(prev.start, p.start) : undefined;
            return (
              <div className="li" key={p.id}>
                <IconBox icon={Droplets} tone="magenta" size="sm" />
                <div className="grow">
                  <div className="t-title">{fmt(p.start, { month: 'short', day: 'numeric', year: 'numeric' })}{p.end ? ` – ${fmt(p.end)}` : ' – ongoing'}</div>
                  <div className="t-sub">{[len ? `${len} day${len > 1 ? 's' : ''}` : '', p.flow ? `${p.flow} flow` : '', gap ? `${gap}-day cycle` : '', p.note].filter(Boolean).join(' · ')}</div>
                </div>
                <button className="icon-btn bare" style={{ width: 26, height: 26 }} onClick={() => periodStore.set((ps) => ps.filter((x) => x.id !== p.id))} aria-label="Delete entry"><Trash2 size={14} /></button>
              </div>
            );
          })}
        </div>
        {!periods.length && <div className="empty">No periods logged yet. Use “Log period” to start tracking.</div>}
      </Hud>

      {dialog === 'log' && (
        <FuturisticModal title="Log period" icon={Droplets} onClose={() => setDialog(null)}>
          <form className="stack" style={{ gap: 12 }} onSubmit={savePeriod}>
            <HudInput label="Start date" type="date" max={today} value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} autoFocus />
            <HudInput label="End date (leave empty if ongoing)" type="date" max={today} value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} />
            <div className="field"><label>Flow</label><div className="seg">{FLOWS.map((f) => <button type="button" key={f} className={`chip ${form.flow === f ? 'active' : ''}`} onClick={() => setForm({ ...form, flow: f })}>{f}</button>)}</div></div>
            <div className="field">
              <label>How are you feeling? (optional, adds to notes)</label>
              <div className="row wrap" style={{ gap: 6 }}>
                {SYMPTOM_TAGS.map((tag) => {
                  const on = form.note.toLowerCase().includes(tag.toLowerCase());
                  return (
                    <button type="button" key={tag} className={`chip ${on ? 'active' : ''}`} onClick={() => {
                      const parts = form.note.split(',').map((s) => s.trim()).filter(Boolean);
                      const next = on ? parts.filter((p) => p.toLowerCase() !== tag.toLowerCase()) : [...parts, tag];
                      setForm({ ...form, note: next.join(', ') });
                    }}>{tag}</button>
                  );
                })}
              </div>
            </div>
            <HudInput label="Notes (optional)" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="e.g. cramps, headache" />
            <div className="row" style={{ justifyContent: 'flex-end' }}><NeonButton type="button" onClick={() => setDialog(null)}>Cancel</NeonButton><NeonButton type="submit" variant="primary">Save</NeonButton></div>
          </form>
        </FuturisticModal>
      )}
      {dialog === 'supplies' && <SuppliesModal prefs={prefs} intro="These are the lowest live prices for your usual product and cravings right now. Nothing is added until you approve." onDone={() => setDialog(null)} />}
    </div>
  );
}
