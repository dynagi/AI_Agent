import { useEffect, useRef } from 'react';
import { toast } from '../aura';
import { AuraMedicine } from '../../native/medicine';
import { doseLogsStore, medicinesStore } from '../../state/stores';
import { dosesBetween } from '../../data/medicine';
import { isNative, parseDoseId, recordDose, reminderText } from '../../services/medicine';

const HORIZON_MS = 48 * 3_600_000;
const REFRESH_MS = 45_000;

/**
 * Mounted once in the app shell. Keeps reminders and dose logs live:
 *  - re-arms native alarms (next 48h of untaken doses) whenever the schedule or logs change;
 *  - applies Taken taps made on notifications, live while open and queued ones on launch/resume;
 *  - re-reads dose logs every REFRESH_MS and on resume so another device's taps show up;
 *  - on web, falls back to browser notifications while the tab is open.
 */
export default function MedicineSync() {
  const meds = medicinesStore.use();
  const logs = doseLogsStore.use();
  // Read both statuses on every render: a short-circuiting && would skip a hook and crash React.
  const medsReady = medicinesStore.useMeta().status === 'ready';
  const logsReady = doseLogsStore.useMeta().status === 'ready';
  const loaded = medsReady && logsReady;
  const timer = useRef<number>();

  // Arm reminders for every dose in the next 48h that has not been logged.
  useEffect(() => {
    if (!loaded) return;
    const now = Date.now();
    const logged = new Set(logs.map((l) => l.id));
    const upcoming = dosesBetween(meds, now, now + HORIZON_MS).filter((d) => !logged.has(d.id));
    if (isNative) {
      void AuraMedicine.scheduleReminders({ doses: upcoming.map((d) => ({ id: d.id, at: d.at, ...reminderText(d.med, d.time) })) }).catch(() => undefined);
      return;
    }
    window.clearTimeout(timer.current);
    const next = upcoming[0];
    if (next && 'Notification' in window && Notification.permission === 'granted') {
      timer.current = window.setTimeout(() => new Notification(reminderText(next.med, next.time).title, { body: reminderText(next.med, next.time).body }), Math.min(next.at - now, 2_147_000_000));
    }
    return () => window.clearTimeout(timer.current);
  }, [meds, logs, loaded]);

  // Notification button taps.
  useEffect(() => {
    if (!isNative || !loaded) return;
    const apply = (id: string, at: number) => {
      const p = parseDoseId(id);
      if (!p) return;
      const med = medicinesStore.get().find((m) => m.id === p.medId);
      recordDose(p.medId, p.date, p.time, 'taken', at);
      if (med) toast(`✅ ${med.name} marked taken`);
    };
    const drain = () => AuraMedicine.drainActions().then(({ actions }) => actions.filter((a) => a.action === 'taken').forEach((a) => apply(a.id, a.at))).catch(() => undefined);
    void drain();
    const live = AuraMedicine.addListener('doseAction', (a) => { if (a.action === 'taken') apply(a.id, a.at); });
    const onVisible = () => { if (document.visibilityState === 'visible') { void drain(); void doseLogsStore.reload(); } };
    document.addEventListener('visibilitychange', onVisible);
    return () => { document.removeEventListener('visibilitychange', onVisible); void live.then((h) => h.remove()); };
  }, [loaded]);

  // Cross-device refresh.
  useEffect(() => {
    if (!loaded) return;
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') void doseLogsStore.reload(); }, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [loaded]);

  return null;
}
