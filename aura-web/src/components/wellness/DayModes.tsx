import { Sun, Moon, Smile } from 'lucide-react';
import { FuturisticModal, NeonButton } from '../aura';
import type { PlanItem, DayLog } from '../../data/wellness';

export function MorningMode({ todayLog, plan, onClose }: { todayLog?: DayLog; plan: PlanItem[]; onClose: () => void }) {
  const sorted = [...plan].sort((a, b) => a.time.localeCompare(b.time));
  return (
    <FuturisticModal title="Good morning" icon={Sun} tone="amber" onClose={onClose}>
      <p className="t-sub" style={{ marginBottom: 4 }}>
        {todayLog?.sleepHours ? `You slept ${todayLog.sleepHours}h last night.` : "No sleep logged yet last night — log it from Quick Actions when you're ready."}
      </p>
      <div className="stack" style={{ gap: 8, marginTop: 14 }}>
        <b style={{ fontSize: 13.5 }}>Today's plan</b>
        {sorted.length ? sorted.map((p) => (
          <div className="li" key={p.id}><span style={{ width: 62, fontSize: 12.5 }} className="t-sub">{p.time}</span><span className="grow t-title" style={{ fontSize: 13.5 }}>{p.title}</span></div>
        )) : <p className="t-mute">Nothing planned yet — add something from the Wellness Plan card.</p>}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}><NeonButton variant="primary" onClick={onClose}>Let's go</NeonButton></div>
    </FuturisticModal>
  );
}

const CHECK_MOODS = ['Great', 'Good', 'Okay', 'Low', 'Sleepy'] as const;

export function WindDownMode({ mood, onSetMood, wins, onClose, onBreathe }: { mood: string | null; onSetMood: (m: string) => void; wins: string[]; onClose: () => void; onBreathe: () => void }) {
  return (
    <FuturisticModal title="Wind down" icon={Moon} tone="violet" onClose={onClose}>
      <p className="t-sub" style={{ marginBottom: 10 }}>How was today?</p>
      <div className="seg" style={{ marginBottom: 16 }}>{CHECK_MOODS.map((m) => <button key={m} className={`chip ${mood === m ? 'active' : ''}`} onClick={() => onSetMood(m)}>{m}</button>)}</div>
      <b style={{ fontSize: 13.5 }}>Today's little wins</b>
      <div className="stack" style={{ gap: 4, marginTop: 8, marginBottom: 16 }}>
        {wins.length ? wins.map((w) => <div key={w} className="t-sub" style={{ fontSize: 13 }}>✓ {w}</div>) : <div className="t-mute">Every day counts, even the quiet ones.</div>}
      </div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <NeonButton icon={Smile} onClick={onBreathe}>Start wind-down breathing</NeonButton>
        <NeonButton variant="primary" onClick={onClose}>Done</NeonButton>
      </div>
    </FuturisticModal>
  );
}
