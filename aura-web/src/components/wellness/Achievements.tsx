import { Hud } from '../aura';
import type { Achievement, Records } from '../../data/wellnessWorld';

export function AchievementsCard({ achievements }: { achievements: Achievement[] }) {
  return (
    <Hud corners title={<span className="section-title" style={{ fontSize: 20 }}>🏅 Achievements</span>}>
      <div className="badge-grid">
        {achievements.map((a) => (
          <div key={a.id} className={`badge-tile ${a.unlocked ? '' : 'locked'}`} title={a.hint}>
            <span className="emoji">{a.icon}</span>
            <b style={{ fontSize: 11.5 }}>{a.title}</b>
            <span className="t-mute" style={{ fontSize: 10 }}>{a.hint}</span>
          </div>
        ))}
      </div>
    </Hud>
  );
}

export function RecordsCard({ records }: { records: Records }) {
  const rows: { label: string; value: string }[] = [
    { label: 'Longest habit streak', value: records.longestHabitStreak ? `${records.longestHabitStreak} days` : '—' },
    { label: 'Most active day', value: records.mostSteps ? `${records.mostSteps.toLocaleString('en-IN')} steps` : '—' },
    { label: 'Longest mindfulness session', value: records.longestMeditationMin ? `${records.longestMeditationMin} min` : '—' },
    { label: 'Best sleep', value: records.bestSleepHours ? `${records.bestSleepHours}h` : '—' },
  ];
  return (
    <Hud corners title={<span className="section-title" style={{ fontSize: 20 }}>🏆 Your Records</span>}>
      <div className="list">
        {rows.map((r) => (
          <div className="li" key={r.label}><span className="grow t-sub">{r.label}</span><b className="mono">{r.value}</b></div>
        ))}
      </div>
      <p className="t-mute" style={{ marginTop: 8 }}>Personal bests from your own history — nothing here is compared with other users.</p>
    </Hud>
  );
}
