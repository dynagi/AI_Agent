import { Hud, Ring, Bar, type Tone } from '../aura';
import { Companion, moodFromSignals } from './Companion';
import type { Vibe, XPResult, Quest } from '../../data/wellnessWorld';

/** "Today's Vibe" hero — a playful self-reported summary, never a medical score. */
export function VibeCard({ vibe, mood }: { vibe: Vibe; mood: string | null }) {
  const companionMood = moodFromSignals({ mood, score: vibe.score, hasData: vibe.hasData });
  return (
    <Hud corners className="fade-in" title={<span className="section-title" style={{ fontSize: 20 }}>✨ Today's Vibe</span>}>
      {!vibe.hasData ? (
        <div className="stack" style={{ alignItems: 'center', gap: 10, padding: '14px 0' }}>
          <Companion mood="calm" size={52} />
          <div className="t-title" style={{ fontSize: 15, textAlign: 'center' }}>Your wellness story starts here</div>
          <div className="t-sub" style={{ textAlign: 'center', maxWidth: 320 }}>Log a glass of water, a meal, or how you're feeling — AURA will start building today's picture.</div>
        </div>
      ) : (
        <div className="row wrap" style={{ gap: 20, alignItems: 'center' }}>
          <Ring value={vibe.score} label={vibe.score} sub={vibe.label} tone={vibe.score >= 65 ? 'green' : vibe.score >= 40 ? 'cyan' : 'violet'} />
          <div style={{ flex: 1, minWidth: 220 }}>
            <Companion mood={companionMood} message={companionLine(companionMood)} />
            <div className="stack" style={{ gap: 7, marginTop: 12 }}>
              {vibe.bars.map((b) => (
                <div className="vibe-bar-row" key={b.key}>
                  <span className="t-sub">{b.label}</span>
                  <Bar value={b.pct} tone={barTone(b.key)} />
                  <span className="mono t-sub" style={{ textAlign: 'right' }}>{b.pct}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Hud>
  );
}

const barTone = (key: string): Tone => ({ sleep: 'violet', movement: 'green', hydration: 'blue', mind: 'magenta', nutrition: 'cyan' }[key] as Tone) ?? 'cyan';

function companionLine(mood: ReturnType<typeof moodFromSignals>): string {
  switch (mood) {
    case 'celebrating': return "You're glowing today. Let's make today count.";
    case 'happy': return "You're doing pretty well today.";
    case 'energetic': return "Good momentum — keep it going.";
    case 'supportive': return "Be gentle with yourself today. I'm here.";
    case 'sleepy': return "A small step now still counts.";
    default: return "Let's make today count.";
  }
}

/** Level/XP bar — entirely derived from existing stores, nothing new is persisted for it. */
export function XPCard({ xp }: { xp: XPResult }) {
  const pct = Math.round((xp.intoLevel / xp.levelTarget) * 100);
  return (
    <Hud corners title={<span className="section-title" style={{ fontSize: 20 }}>🌿 {xp.title}</span>} sub={`Level ${xp.level}`}>
      <Bar value={pct} tone="green" />
      <div className="row between t-sub" style={{ marginTop: 6, fontSize: 12 }}>
        <span>{xp.intoLevel} / {xp.levelTarget} XP</span>
        <span>{xp.xp.toLocaleString('en-IN')} XP total</span>
      </div>
    </Hud>
  );
}

const QUEST_TAB_HINT: Record<Quest['goto'], string> = { Nutrition: 'Log Water', Mindfulness: 'Start a session', 'Wellness Plan': 'Open plan', 'Habit Tracker': 'Open habits' };

export function QuestsCard({ quests, onGoto }: { quests: Quest[]; onGoto: (tab: Quest['goto']) => void }) {
  return (
    <Hud corners title={<span className="section-title" style={{ fontSize: 20 }}>🎯 Daily Quests</span>}>
      <div className="stack" style={{ gap: 8 }}>
        {quests.map((q) => (
          <button key={q.id} type="button" className={`quest-card ${q.done ? 'done' : ''}`} onClick={() => onGoto(q.goto)}>
            <span className="quest-emoji">{q.done ? '✅' : q.icon}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <div className="t-title" style={{ fontSize: 13.5 }}>{q.title}</div>
              <div className="t-sub" style={{ fontSize: 12 }}>{q.done ? 'Completed today' : q.detail}</div>
            </span>
            {!q.done && <span className="tag green" style={{ flexShrink: 0 }}>+{q.xp} XP · {QUEST_TAB_HINT[q.goto]}</span>}
          </button>
        ))}
      </div>
    </Hud>
  );
}

/** A quiet, always-visible strip of the day's six wellness moments — an at-a-glance journey, not a new tracker. */
export function JourneyStrip({ bars }: { bars: Vibe['bars'] }) {
  const steps: { icon: string; label: string; pct: number }[] = [
    { icon: '💧', label: 'Hydration', pct: bars.find((b) => b.key === 'hydration')?.pct ?? 0 },
    { icon: '🏃', label: 'Movement', pct: bars.find((b) => b.key === 'movement')?.pct ?? 0 },
    { icon: '🍎', label: 'Nutrition', pct: bars.find((b) => b.key === 'nutrition')?.pct ?? 0 },
    { icon: '🧘', label: 'Mindfulness', pct: bars.find((b) => b.key === 'mind')?.pct ?? 0 },
    { icon: '🌙', label: 'Sleep', pct: bars.find((b) => b.key === 'sleep')?.pct ?? 0 },
  ];
  return (
    <div className="row wrap" style={{ gap: 8, justifyContent: 'center' }}>
      {steps.map((s, i) => (
        <span key={s.label} className="row" style={{ gap: 8 }}>
          <span className={`tag ${s.pct >= 100 ? 'green' : s.pct > 0 ? 'blue' : ''}`} style={{ fontSize: 12 }}>{s.icon} {s.label}</span>
          {i < steps.length - 1 && <span className="t-mute">→</span>}
        </span>
      ))}
    </div>
  );
}
