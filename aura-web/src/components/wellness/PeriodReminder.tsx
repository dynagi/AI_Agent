import { useEffect, useRef, useState } from 'react';
import { cycleStats, dayDiff, iso } from '../../data/cycle';
import { DEFAULT_PERIOD_PREFS } from '../../data/wellness';
import { periodPrefsStore, periodStore } from '../../state/stores';
import { useShowPeriodTracker } from '../../state/user';
import SuppliesModal from './SuppliesModal';

/**
 * Mounted once in the app shell. The day before a predicted period (and up to two days after, if the app was not opened),
 * it prepares a supplies cart and asks for approval. It only runs for users who enabled the Period Tracker, once per cycle.
 */
export default function PeriodReminder() {
  const enabled = useShowPeriodTracker();
  const periods = periodStore.use();
  const periodsMeta = periodStore.useMeta();
  const prefsList = periodPrefsStore.use();
  const prefsMeta = periodPrefsStore.useMeta();
  const [ask, setAsk] = useState<{ next: string; lead: number } | null>(null);
  const asked = useRef(false);
  const prefs = { ...DEFAULT_PERIOD_PREFS, ...prefsList[0] };

  useEffect(() => {
    if (!enabled || asked.current || !prefs.autoPrepare || periodsMeta.status !== 'ready' || prefsMeta.status !== 'ready' || !periods.length) return;
    const today = iso(new Date());
    const c = cycleStats(periods, today);
    if (!c.next || c.ongoing) return;
    const lead = dayDiff(today, c.next);
    if (lead <= 1 && lead >= -2 && prefs.preparedFor !== c.next) { asked.current = true; setAsk({ next: c.next, lead }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, periods, periodsMeta.status, prefsMeta.status, prefs.autoPrepare, prefs.preparedFor]);

  if (!ask) return null;
  const when = ask.lead === 1 ? 'tomorrow' : ask.lead === 0 ? 'today' : `${-ask.lead} day${ask.lead === -1 ? '' : 's'} ago (estimated)`;
  return (
    <SuppliesModal
      prefs={prefs}
      intro={`Your period is expected ${when} (${new Date(`${ask.next}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}). Here are the lowest live prices for your usual supplies and cravings. Choose what to add to your cart.`}
      onDone={() => {
        periodPrefsStore.set([{ ...prefs, id: 'prefs', preparedFor: ask.next }]);
        setAsk(null);
      }}
    />
  );
}
