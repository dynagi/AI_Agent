/**
 * A small, subtle AURA companion face — not a mascot that takes over the
 * screen, just a friendly presence in the corner of a few cards. Pure CSS/
 * SVG, no animation dependency, and it respects prefers-reduced-motion via
 * the .aura-companion-blink rule in aura-theme.css.
 */
export type CompanionMood = 'happy' | 'calm' | 'sleepy' | 'energetic' | 'celebrating' | 'supportive';

const MOOD_COLOR: Record<CompanionMood, string> = {
  happy: '#00E5A8', calm: '#00AFFF', sleepy: '#8B5CFF', energetic: '#FF4FD8', celebrating: '#FFC857', supportive: '#00AFFF',
};

function Face({ mood, size }: { mood: CompanionMood; size: number }) {
  const color = MOOD_COLOR[mood];
  const eyeY = mood === 'sleepy' ? 0 : -1;
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden style={{ filter: `drop-shadow(0 0 6px ${color}88)` }}>
      <circle cx="24" cy="24" r="21" fill="rgba(6,14,26,0.85)" stroke={color} strokeWidth="1.6" />
      {mood === 'sleepy' ? (
        <><path d="M15 21q3-2 6 0" stroke={color} strokeWidth="2" fill="none" strokeLinecap="round" /><path d="M27 21q3-2 6 0" stroke={color} strokeWidth="2" fill="none" strokeLinecap="round" /></>
      ) : (
        <><circle cx="17.5" cy={21 + eyeY} r="2.4" fill={color} className="aura-companion-blink" /><circle cx="30.5" cy={21 + eyeY} r="2.4" fill={color} className="aura-companion-blink" /></>
      )}
      {mood === 'celebrating' ? (
        <path d="M15 28q9 8 18 0" stroke={color} strokeWidth="2.2" fill="none" strokeLinecap="round" />
      ) : mood === 'energetic' ? (
        <path d="M16 27q8 7 16 0" stroke={color} strokeWidth="2.2" fill="none" strokeLinecap="round" />
      ) : (
        <path d="M17 28q7 4 14 0" stroke={color} strokeWidth="2" fill="none" strokeLinecap="round" />
      )}
    </svg>
  );
}

export function Companion({ mood, message, size = 44 }: { mood: CompanionMood; message?: string; size?: number }) {
  return (
    <div className="row" style={{ gap: 10, alignItems: 'center' }}>
      <Face mood={mood} size={size} />
      {message && <span className="t-sub" style={{ fontSize: 13, fontStyle: 'italic' }}>{message}</span>}
    </div>
  );
}

/** Picks a companion mood from the same signals Today's Vibe uses, so the face matches the numbers. */
export function moodFromSignals(opts: { mood: string | null; score: number; hasData: boolean }): CompanionMood {
  if (opts.mood === 'Stressed' || opts.mood === 'Low') return 'supportive';
  if (!opts.hasData) return 'calm';
  if (opts.score >= 85) return 'celebrating';
  if (opts.score >= 65) return 'happy';
  if (opts.score >= 40) return 'energetic';
  return 'sleepy';
}
