import { useEffect, useMemo, useState } from 'react';
import { Pill, Trash2, Bell, BellOff, ShoppingBag, Share2, Undo2, PackageCheck, X } from 'lucide-react';
import { Hud, IconBox, NeonButton, FuturisticModal, HudInput, Bar, toast, type Tone } from '../aura';
import { doseLogsStore, medicinesStore, medOrdersStore } from '../../state/stores';
import { uid } from '../../state/store';
import {
  PHARMACIES, adherence, daysLeft, doseState, dosesForDate, fmtTime, isLow, isoDate,
  type Dose, type DoseState, type Medicine, type PharmacyId,
} from '../../data/medicine';
import { isNative, orderFromPharmacy, receiveOrder, recordDose, shareList, undoDose } from '../../services/medicine';
import { AuraMedicine } from '../../native/medicine';

const STATE_UI: Record<DoseState, { label: string; tone: Tone }> = {
  taken: { label: 'Taken', tone: 'green' },
  skipped: { label: 'Skipped', tone: 'amber' },
  due: { label: 'Due now', tone: 'cyan' },
  upcoming: { label: 'Upcoming', tone: 'violet' },
  missed: { label: 'Missed', tone: 'red' },
};

/** Re-renders every `ms` so dose states (upcoming → due → missed) move with the clock without a refresh. */
function useNow(ms = 15_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), ms); return () => window.clearInterval(t); }, [ms]);
  return now;
}

const EMPTY_FORM = { name: '', dose: '', times: '08:00', perDose: '1', stock: '30', refillDays: '3', endDate: '' };

export default function MedicineTab() {
  const meds = medicinesStore.use();
  const logs = doseLogsStore.use();
  const orders = medOrdersStore.use();
  const now = useNow();
  const today = isoDate(new Date(now));
  const [form, setForm] = useState<typeof EMPTY_FORM | null>(null);
  const [orderFor, setOrderFor] = useState<Medicine[] | null>(null);
  const [receiving, setReceiving] = useState<string | null>(null);
  const [units, setUnits] = useState('30');
  const [notif, setNotif] = useState<boolean | null>(null);

  const refreshNotif = () => {
    if (isNative) void AuraMedicine.notificationsEnabled().then((r) => setNotif(r.enabled)).catch(() => undefined);
    else setNotif('Notification' in window ? Notification.permission === 'granted' : false);
  };
  useEffect(() => {
    refreshNotif();
    document.addEventListener('visibilitychange', refreshNotif);
    return () => document.removeEventListener('visibilitychange', refreshNotif);
  }, []);
  const enableNotif = async () => {
    if (isNative) await AuraMedicine.requestNotifications().catch(() => undefined);
    else if ('Notification' in window) await Notification.requestPermission();
    refreshNotif();
  };

  const logById = useMemo(() => new Map(logs.map((l) => [l.id, l])), [logs]);
  const doses = useMemo(() => dosesForDate(meds, today), [meds, today]);
  const rows = doses.map((d) => ({ dose: d, state: doseState(d, logById.get(d.id), now) }));
  const taken = rows.filter((r) => r.state === 'taken').length;
  const week = adherence(meds, logs, today, now, 7);
  const low = meds.filter(isLow);
  const placed = orders.filter((o) => o.status === 'placed');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    const times = [...new Set(form.times.split(/[,\s]+/).filter((t) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(t)).map((t) => t.padStart(5, '0')))].sort();
    if (!form.name.trim()) return toast('Enter the medicine name.');
    if (!times.length) return toast('Enter at least one time like 08:00 or 08:00, 20:00.');
    medicinesStore.set((ms) => [...ms, {
      id: uid('md'), name: form.name.trim(), dose: form.dose.trim(), times, startDate: today, endDate: form.endDate || undefined,
      stock: Math.max(0, Number(form.stock) || 0), perDose: Math.max(1, Number(form.perDose) || 1), refillDays: Math.max(0, Number(form.refillDays) || 0), active: true,
    }]);
    setForm(null);
    toast(`💊 ${form.name.trim()} added — reminders are set.`);
  };

  const order = async (pharmacy: PharmacyId) => {
    if (!orderFor) return;
    try {
      const opened = await orderFromPharmacy(pharmacy, orderFor);
      toast(opened === 'app' ? 'Opened the pharmacy app — medicine names are copied to paste. Pay there.' : 'Opened the pharmacy site — medicine names are copied to paste. Pay there.');
      setOrderFor(null);
    } catch { toast('Could not open that pharmacy.'); }
  };

  const doseRow = ({ dose, state }: { dose: Dose; state: DoseState }) => {
    const ui = STATE_UI[state];
    const resolved = state === 'taken' || state === 'skipped';
    return (
      <div className="li" key={dose.id}>
        <div style={{ width: 62, fontSize: 13.5, flexShrink: 0 }}>{fmtTime(dose.time)}</div>
        <IconBox icon={Pill} tone={ui.tone} size="sm" />
        <div className="grow">
          <div className="t-title" style={{ fontSize: 15 }}>{dose.med.name}</div>
          <div className="t-sub">{[dose.med.dose, `${dose.med.perDose} ${dose.med.perDose === 1 ? 'unit' : 'units'}`].filter(Boolean).join(' · ')}</div>
        </div>
        <span className="tag" style={{ color: `var(--aura-${ui.tone === 'cyan' ? 'primary' : ui.tone})` }} aria-live="polite">{ui.label}</span>
        {resolved ? (
          <button className="icon-btn bare" onClick={() => undoDose(dose)} aria-label={`Undo ${dose.med.name}`} title="Undo"><Undo2 size={16} /></button>
        ) : (
          <>
            <NeonButton size="sm" variant="primary" onClick={() => { recordDose(dose.med.id, dose.date, dose.time, 'taken'); toast(`✅ ${dose.med.name} taken`); }}>Taken</NeonButton>
            <button className="icon-btn bare" onClick={() => recordDose(dose.med.id, dose.date, dose.time, 'skipped')} aria-label={`Skip ${dose.med.name}`} title="Skip"><X size={16} /></button>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      {notif === false && (
        <button className="tile row" style={{ gap: 10, width: '100%', textAlign: 'left' }} onClick={() => void enableNotif()}>
          <BellOff size={20} /><span style={{ flex: 1 }}>Reminders are off. Tap to allow notifications so AURA can remind you when a dose is due.</span>
        </button>
      )}

      <div className="grid g2" style={{ gap: 16 }}>
        <Hud corners title="Today" sub={doses.length ? `${taken} of ${doses.length} doses taken` : 'No doses scheduled today'} icon={notif ? Bell : Pill}>
          <Bar value={doses.length ? (taken / doses.length) * 100 : 0} tone="green" />
        </Hud>
        <Hud corners title="Last 7 days" sub={week.pct === null ? 'Not enough data yet' : `${week.taken} taken · ${week.missed} missed or skipped`}>
          <div className="mono" style={{ fontSize: 30 }}>{week.pct === null ? '—' : `${week.pct}%`}</div>
          <div className="t-sub">on-time adherence</div>
        </Hud>
      </div>

      <Hud corners title="Today's doses" sub="Updates live as each dose comes due." action="Add medicine" onAction={() => setForm(EMPTY_FORM)}>
        {rows.length ? <div className="stack" style={{ gap: 4 }}>{rows.map(doseRow)}</div> : <div className="empty">No doses today. Add a medicine to get reminders.</div>}
      </Hud>

      {placed.length > 0 && (
        <Hud corners title="Orders on the way" sub="Confirm when they arrive to update your stock.">
          {placed.map((o) => (
            <div className="li" key={o.id}>
              <IconBox icon={PackageCheck} tone="cyan" size="sm" />
              <div className="grow"><div className="t-title" style={{ fontSize: 15 }}>{o.names.join(', ')}</div><div className="t-sub">via {PHARMACIES.find((p) => p.id === o.pharmacy)?.label ?? 'another app'} · {new Date(o.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div></div>
              <NeonButton size="sm" onClick={() => { setReceiving(o.id); setUnits('30'); }}>Received</NeonButton>
              <button className="icon-btn bare" onClick={() => medOrdersStore.set((os) => os.filter((x) => x.id !== o.id))} aria-label="Dismiss order"><X size={16} /></button>
            </div>
          ))}
        </Hud>
      )}

      <Hud corners title="My medicines" sub="Stock drops each time you mark a dose taken." action={low.length ? `Order ${low.length} low` : undefined} onAction={low.length ? () => setOrderFor(low) : undefined}>
        {meds.length ? meds.map((m) => {
          const left = daysLeft(m);
          return (
            <div className="li" key={m.id}>
              <IconBox icon={Pill} tone={isLow(m) ? 'red' : 'green'} size="sm" />
              <div className="grow">
                <div className="t-title" style={{ fontSize: 15 }}>{m.name} {m.dose && <span className="t-sub">{m.dose}</span>}</div>
                <div className="t-sub">{m.times.map(fmtTime).join(', ')} · {m.stock} left{Number.isFinite(left) ? ` (~${left} day${left === 1 ? '' : 's'})` : ''}</div>
                <Bar value={Number.isFinite(left) ? Math.min(100, (left / Math.max(1, m.refillDays * 3)) * 100) : 100} tone={isLow(m) ? 'red' : 'green'} />
              </div>
              {isLow(m) && <span className="tag" style={{ color: 'var(--aura-red)' }}>Running low</span>}
              <NeonButton size="sm" icon={ShoppingBag} onClick={() => setOrderFor([m])}>Order</NeonButton>
              <button className="icon-btn bare" onClick={() => { medicinesStore.set((ms) => ms.filter((x) => x.id !== m.id)); toast(`${m.name} removed.`); }} aria-label={`Remove ${m.name}`}><Trash2 size={16} /></button>
            </div>
          );
        }) : <div className="empty">No medicines yet.</div>}
      </Hud>

      <p className="t-sub" style={{ margin: 0 }}>AURA only reminds you and tracks what you report. It does not give medical advice, and it never pays for an order. Prescription medicines need a valid prescription from the pharmacy.</p>

      {form && (
        <FuturisticModal title="Add medicine" icon={Pill} onClose={() => setForm(null)}>
          <form className="stack" style={{ gap: 12 }} onSubmit={submit}>
            <HudInput label="Medicine" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Metformin" autoFocus />
            <HudInput label="Strength (optional)" value={form.dose} onChange={(e) => setForm({ ...form, dose: e.target.value })} placeholder="e.g. 500 mg" />
            <HudInput label="Times each day (24h, comma separated)" value={form.times} onChange={(e) => setForm({ ...form, times: e.target.value })} placeholder="08:00, 20:00" />
            <div className="grid g2" style={{ gap: 12 }}>
              <HudInput label="Units per dose" type="number" min={1} value={form.perDose} onChange={(e) => setForm({ ...form, perDose: e.target.value })} />
              <HudInput label="Units in stock" type="number" min={0} value={form.stock} onChange={(e) => setForm({ ...form, stock: e.target.value })} />
              <HudInput label="Warn when days left ≤" type="number" min={0} value={form.refillDays} onChange={(e) => setForm({ ...form, refillDays: e.target.value })} />
              <HudInput label="Last day (optional)" type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
            </div>
            <div className="row" style={{ justifyContent: 'flex-end' }}><NeonButton type="button" onClick={() => setForm(null)}>Cancel</NeonButton><NeonButton type="submit" variant="primary">Add</NeonButton></div>
          </form>
        </FuturisticModal>
      )}

      {orderFor && (
        <FuturisticModal title="Order medicine" icon={ShoppingBag} onClose={() => setOrderFor(null)}>
          <div className="stack" style={{ gap: 10 }}>
            <div className="t-sub">{orderFor.map((m) => m.name).join(', ')} — pick where to order. The app opens with the names copied; you review and pay there.</div>
            {PHARMACIES.map((p) => <NeonButton key={p.id} block onClick={() => void order(p.id)}>{p.label}</NeonButton>)}
            <NeonButton block icon={Share2} onClick={() => { void shareList(orderFor).then(() => setOrderFor(null)).catch(() => toast('Could not share.')); }}>Send list to any app…</NeonButton>
          </div>
        </FuturisticModal>
      )}

      {receiving && (
        <FuturisticModal title="Order received" icon={PackageCheck} onClose={() => setReceiving(null)}>
          <form className="stack" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); receiveOrder(receiving, Math.max(0, Number(units) || 0)); setReceiving(null); toast('Stock updated.'); }}>
            <HudInput label="Units received per medicine" type="number" min={0} value={units} onChange={(e) => setUnits(e.target.value)} autoFocus />
            <div className="row" style={{ justifyContent: 'flex-end' }}><NeonButton type="button" onClick={() => setReceiving(null)}>Cancel</NeonButton><NeonButton type="submit" variant="primary">Add to stock</NeonButton></div>
          </form>
        </FuturisticModal>
      )}
    </div>
  );
}
