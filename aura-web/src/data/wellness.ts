import { Flame, Dumbbell, Utensils, GlassWater, Footprints, Moon, Heart, Scale, Activity, Droplet, Wind, Brain, type LucideIcon } from 'lucide-react';
import type { Tone } from '../components/ui';

/** Self-reported entries only. AURA does not diagnose medical conditions. Icons are stored by key. */
export const wellnessIcons = { flame: Flame, dumbbell: Dumbbell, utensils: Utensils, water: GlassWater, walk: Footprints, moon: Moon, heart: Heart, scale: Scale, activity: Activity, droplet: Droplet, wind: Wind, mind: Brain } satisfies Record<string, LucideIcon>;
export type WellnessIcon = keyof typeof wellnessIcons;
export const wellnessIcon = (key: string): LucideIcon => wellnessIcons[key as WellnessIcon] ?? Activity;

export type PlanArea = 'Mindfulness' | 'Fitness' | 'Nutrition' | 'Sleep';
export interface PlanItem { id: string; time: string; title: string; sub: string; icon: WellnessIcon; tone: Tone; area: PlanArea; /** ISO date this routine was last completed; "done today" is derived from it. */ doneOn?: string }

export interface Metric { id: string; name: string; value: string; status: string; icon: WellnessIcon; tone: Tone; good: boolean }

/** One day of self-reported numbers, keyed by date (id is "log_" + the ISO date). */
export interface DayLog { id: string; date: string; steps?: number; calories?: number; sleepHours?: number; water?: number; mood?: string; workoutMin?: number }

/** A meal logged for a specific date. */
export interface Meal { id: string; name: string; dish: string; kcal: number; eaten: boolean; date: string }

/** A habit and the ISO dates it was completed on. */
export interface Habit { id: string; name: string; done: string[] }

/** One logged period. `end` is empty while it is ongoing. All values are self-reported. */
export type Flow = 'Light' | 'Medium' | 'Heavy';
export interface PeriodEntry { id: string; start: string; end?: string; flow?: Flow; note?: string }

/** Supplies and cravings used to prepare a cart the day before a predicted period. Nothing is ordered without approval. */
export interface PeriodPrefs { id: string; padQuery: string; padQty: number; cravings: string[]; autoPrepare: boolean; /** The predicted start date this reminder was last handled for. */ preparedFor?: string; /** Hides cycle detail behind a reveal tap; off by default. */ privateMode?: boolean }
export const DEFAULT_PERIOD_PREFS: PeriodPrefs = { id: 'prefs', padQuery: 'sanitary pads', padQty: 1, cravings: [], autoPrepare: true };

/** Daily reference targets used to scale the weekly chart. */
export const TARGETS = { steps: 10000, calories: 2000, sleepHours: 8, water: 8 } as const;
