import { useEffect, useMemo, useState } from 'react';
import { Pill } from 'lucide-react';
import { IconBox } from '../aura';
import { doseLogsStore, medicinesStore } from '../../state/stores';
import { dosesBetween, doseState, fmtTime } from '../../data/medicine';

const untilText = (ms: number) => {
  const min = Math.max(0, Math.round(ms / 60_000));
  return min < 60 ? `in ${min} min` : `in ${Math.floor(min / 60)}h ${min % 60}m`;
};

/** Overview shortcut: the dose that is due now, or the next one coming up. Renders nothing when no doses are pending. */
export default function NextDoseCard({ onOpen }: { onOpen: () => void }) {
  const meds = medicinesStore.use();
  const logs = doseLogsStore.use();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 15_000); return () => window.clearInterval(t); }, []);

  const next = useMemo(() => {
    const logged = new Map(logs.map((l) => [l.id, l]));
    // Look back one hour so a dose that is "due now" still shows.
    return dosesBetween(meds, now - 3_600_000, now + 48 * 3_600_000).find((d) => {
      const s = doseState(d, logged.get(d.id), now);
      return s === 'due' || s === 'upcoming';
    });
  }, [meds, logs, now]);

  if (!next) return null;
  const due = next.at <= now;
  return (
    <button className="tile row" style={{ gap: 12, width: '100%', textAlign: 'left' }} onClick={onOpen}>
      <IconBox icon={Pill} tone={due ? 'cyan' : 'violet'} />
      <span style={{ flex: 1 }}>
        <span className="t-title" style={{ display: 'block' }}>{due ? 'Due now' : 'Next dose'}: {next.med.name}</span>
        <span className="t-sub">{fmtTime(next.time)}{due ? '' : ` · ${untilText(next.at - now)}`} · tap to log it</span>
      </span>
    </button>
  );
}
