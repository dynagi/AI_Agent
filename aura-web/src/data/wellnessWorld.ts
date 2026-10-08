/**
 * Pure derivation helpers for the "AURA Wellness World" layer (Today's
 * Vibe, XP, Daily Quests, Achievements, Personal Records). Everything here
 * is computed from the existing wellness stores — nothing is duplicated or
 * persisted separately, per the "derive, don't duplicate" rule. All of it
 * is a playful self-reported summary, never a medical measurement.
 */
import { addDays } from './cycle';
import { TARGETS, type DayLog, type Habit, type Meal } from './wellness';

/** A mindfulness session completion — the one thing not already captured by
 * an existing store, since finishing a Breathing session today just closes
 * a modal. Kept minimal on purpose (type + date + duration only). */
export interface WellnessEvent { id: string; type: 'mindfulness'; date: string; minutes: number }

const MOOD_SCORE: Record<string, number> = { Great: 100, Good: 80, Okay: 60, Low: 35, Stressed: 30 };

export interface VibeBar { key: string; label: string; pct: number }
export interface Vibe { hasData: boolean; score: number; label: string; bars: VibeBar[] }

export function computeVibe(opts: { todayLog?: DayLog; mood: string | null; kcalEaten: number; planDoneToday: number; planTotal: number }): Vibe {
  const { todayLog, mood, kcalEaten, planDoneToday, planTotal } = opts;
  const sleepPct = todayLog?.sleepHours ? Math.min(100, Math.round((todayLog.sleepHours / TARGETS.sleepHours) * 100)) : 0;
  const movePct = todayLog?.steps
    ? Math.min(100, Math.round((todayLog.steps / TARGETS.steps) * 100))
    : todayLog?.workoutMin ? Math.min(100, Math.round((todayLog.workoutMin / 30) * 100)) : 0;
  const waterPct = todayLog?.water ? Math.min(100, Math.round((todayLog.water / TARGETS.water) * 100)) : 0;
  const mindPct = mood ? (MOOD_SCORE[mood] ?? 60) : planTotal ? Math.round((planDoneToday / planTotal) * 100) : 0;
  const nutritionPct = kcalEaten ? Math.min(100, Math.round((kcalEaten / TARGETS.calories) * 100)) : 0;

  const hasData = Boolean(todayLog?.sleepHours || todayLog?.steps || todayLog?.water || todayLog?.workoutMin || kcalEaten || mood || planDoneToday);
  const bars: VibeBar[] = [
    { key: 'sleep', label: 'Sleep', pct: sleepPct },
    { key: 'movement', label: 'Movement', pct: movePct },
    { key: 'hydration', label: 'Hydration', pct: waterPct },
    { key: 'mind', label: 'Mind', pct: mindPct },
    { key: 'nutrition', label: 'Nutrition', pct: nutritionPct },
  ];
  const score = hasData ? Math.round(bars.reduce((s, b) => s + b.pct, 0) / bars.length) : 0;
  const label = !hasData ? '—' : score >= 80 ? 'Feeling Balanced' : score >= 60 ? 'Steady & Well' : score >= 40 ? 'Finding Your Rhythm' : 'Just Getting Started';
  return { hasData, score, label, bars };
}

/** Longest run of consecutive ISO dates in an unsorted list (used for habit streaks). */
export function longestStreak(dates: string[]): number {
  const sorted = [...new Set(dates)].sort();
  let best = 0, cur = 0, prev: string | null = null;
  for (const d of sorted) {
    cur = prev && addDays(prev, 1) === d ? cur + 1 : 1;
    best = Math.max(best, cur);
    prev = d;
  }
  return best;
}

const LEVEL_XP = 300;
const LEVEL_TITLES = ['Seedling', 'Wellness Explorer', 'Mindful Wanderer', 'Balance Keeper', 'Vitality Champion', 'AURA Sage'];

export interface XPResult { xp: number; level: number; title: string; intoLevel: number; levelTarget: number }

/** XP earned across all history — derived from logs/habits/meals/events, never stored separately. */
export function computeXP(opts: { logs: DayLog[]; habits: Habit[]; meals: Meal[]; events: WellnessEvent[]; planDoneToday: number }): XPResult {
  const { logs, habits, meals, events, planDoneToday } = opts;
  let xp = 0;
  for (const l of logs) {
    if ((l.water ?? 0) >= TARGETS.water) xp += 10;
    if ((l.steps ?? 0) >= TARGETS.steps) xp += 10;
    if ((l.sleepHours ?? 0) >= TARGETS.sleepHours) xp += 10;
    if ((l.workoutMin ?? 0) > 0) xp += 10;
  }
  for (const h of habits) xp += h.done.length * 10;
  xp += meals.filter((m) => m.eaten).length * 5;
  xp += events.filter((e) => e.type === 'mindfulness').length * 15;
  xp += planDoneToday * 5;

  const levelIndex = Math.floor(xp / LEVEL_XP);
  return { xp, level: levelIndex + 1, title: LEVEL_TITLES[Math.min(levelIndex, LEVEL_TITLES.length - 1)], intoLevel: xp % LEVEL_XP, levelTarget: LEVEL_XP };
}

export interface Quest { id: string; icon: string; title: string; detail: string; xp: number; done: boolean; goto: 'Nutrition' | 'Mindfulness' | 'Wellness Plan' | 'Habit Tracker' }

/** Deterministic, local, from today's data only — no backend needed. */
export function computeQuests(opts: { water: number; meditatedToday: boolean; planDoneToday: number; planTotal: number; habitsDoneToday: number; habitsTotal: number }): Quest[] {
  const { water, meditatedToday, planDoneToday, planTotal, habitsDoneToday, habitsTotal } = opts;
  return [
    { id: 'hydration', icon: '💧', title: 'Hydration Hero', detail: `Drink ${TARGETS.water} glasses today`, xp: 20, done: water >= TARGETS.water, goto: 'Nutrition' },
    { id: 'mind', icon: '🧘', title: 'Mind Reset', detail: 'Complete one breathing or meditation session', xp: 20, done: meditatedToday, goto: 'Mindfulness' },
    { id: 'plan', icon: '🎯', title: planTotal ? 'Plan Progress' : 'Start Your Plan', detail: planTotal ? `Finish all ${planTotal} of today's plan items` : 'Add a routine to your Wellness Plan', xp: 30, done: planTotal > 0 && planDoneToday >= planTotal, goto: 'Wellness Plan' },
    { id: 'habits', icon: '🌱', title: habitsTotal ? 'Tend Your Garden' : 'Plant a Habit', detail: habitsTotal ? 'Check off every habit today' : 'Add your first habit to track', xp: 20, done: habitsTotal > 0 && habitsDoneToday >= habitsTotal, goto: 'Habit Tracker' },
  ];
}

export interface Achievement { id: string; icon: string; title: string; unlocked: boolean; hint: string }

export function computeAchievements(opts: { logs: DayLog[]; habits: Habit[]; meals: Meal[]; events: WellnessEvent[] }): Achievement[] {
  const { logs, habits, meals, events } = opts;
  const waterDays = logs.filter((l) => (l.water ?? 0) >= TARGETS.water).length;
  const sleepDays = logs.filter((l) => (l.sleepHours ?? 0) >= TARGETS.sleepHours).length;
  const stepDays = logs.filter((l) => (l.steps ?? 0) >= TARGETS.steps).length;
  const meditations = events.filter((e) => e.type === 'mindfulness').length;
  const mealsLogged = meals.filter((m) => m.eaten).length;
  const streak = Math.max(0, ...habits.map((h) => longestStreak(h.done)), 0);
  return [
    { id: 'water', icon: '💧', title: 'Water Wizard', unlocked: waterDays >= 5, hint: `${Math.min(waterDays, 5)}/5 days at your water target` },
    { id: 'sleep', icon: '🌙', title: 'Sleep Guardian', unlocked: sleepDays >= 5, hint: `${Math.min(sleepDays, 5)}/5 nights at your sleep target` },
    { id: 'zen', icon: '🧘', title: 'Zen Apprentice', unlocked: meditations >= 5, hint: `${Math.min(meditations, 5)}/5 mindfulness sessions` },
    { id: 'move', icon: '🏃', title: 'Movement Explorer', unlocked: stepDays >= 5, hint: `${Math.min(stepDays, 5)}/5 days at your step target` },
    { id: 'fuel', icon: '🥗', title: 'Fuel Master', unlocked: mealsLogged >= 10, hint: `${Math.min(mealsLogged, 10)}/10 meals logged` },
    { id: 'consistency', icon: '🌱', title: 'Consistency Builder', unlocked: streak >= 5, hint: streak ? `Best streak: ${streak} days` : 'Build a 5-day habit streak' },
  ];
}

export interface Records { longestHabitStreak: number; mostSteps?: number; longestMeditationMin?: number; bestSleepHours?: number }

export function computeRecords(opts: { logs: DayLog[]; habits: Habit[]; events: WellnessEvent[] }): Records {
  const { logs, habits, events } = opts;
  const max = (xs: (number | undefined)[]) => xs.reduce<number | undefined>((m, v) => (v ? Math.max(m ?? 0, v) : m), undefined);
  return {
    longestHabitStreak: Math.max(0, ...habits.map((h) => longestStreak(h.done)), 0),
    mostSteps: max(logs.map((l) => l.steps)),
    longestMeditationMin: max(events.filter((e) => e.type === 'mindfulness').map((e) => e.minutes)),
    bestSleepHours: max(logs.map((l) => l.sleepHours)),
  };
}
