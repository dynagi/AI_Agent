import type { Habit } from '../../data/wellness';

/** Grows a plant per habit based on this week's completions. Missing a day never "kills" it — worst case it just waits. */
const STAGES = ['🌰', '🌱', '🌿', '🌷', '🌳'];

function stageFor(doneThisWeek: number): string {
  if (doneThisWeek <= 0) return STAGES[0];
  if (doneThisWeek <= 2) return STAGES[1];
  if (doneThisWeek <= 4) return STAGES[2];
  if (doneThisWeek <= 6) return STAGES[3];
  return STAGES[4];
}

export default function Garden({ habits, weekDays }: { habits: Habit[]; weekDays: string[] }) {
  if (!habits.length) {
    return <p className="t-sub" style={{ textAlign: 'center', padding: '8px 0' }}>🌱 Your garden could use a little attention — add a habit below to plant your first seed.</p>;
  }
  const doneCounts = habits.map((h) => weekDays.filter((d) => h.done.includes(d)).length);
  const allQuiet = doneCounts.every((c) => c === 0);
  return (
    <div>
      <div className="garden-row">
        {habits.map((h, i) => (
          <div className="garden-plant" key={h.id} title={`${h.name}: ${doneCounts[i]}/7 this week`}>
            <span className="stage">{stageFor(doneCounts[i])}</span>
            <span className="ellipsis" style={{ maxWidth: 80 }}>{h.name}</span>
          </div>
        ))}
      </div>
      {allQuiet && <p className="t-mute" style={{ textAlign: 'center', marginTop: -6, marginBottom: 10 }}>Your garden could use a little attention today 🌱</p>}
    </div>
  );
}
