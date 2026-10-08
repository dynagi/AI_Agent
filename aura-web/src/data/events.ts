import { Users, Dumbbell, Laptop, BookOpen, Plane, HeartPulse, Trophy, Clapperboard, FileText, Cake, Timer, type LucideIcon } from 'lucide-react';
import type { Tone } from '../components/ui';

export type EventKind = 'meeting' | 'fitness' | 'work' | 'learning' | 'travel' | 'health' | 'event' | 'personal' | 'focus';

export interface CalendarEvent {
  id: string;
  title: string;
  /** yyyy-mm-dd */
  date: string;
  start: string; // "10:00 AM" or "All Day"
  end?: string;
  kind: EventKind;
  notes?: string;
  /** Set for read-only events synced from Google Calendar. */
  source?: 'google';
}

export const kindMeta: Record<EventKind, { tone: Tone; icon: LucideIcon; label: string }> = {
  meeting: { tone: 'violet', icon: Users, label: 'Meeting' },
  fitness: { tone: 'green', icon: Dumbbell, label: 'Fitness' },
  work: { tone: 'blue', icon: Laptop, label: 'Work' },
  learning: { tone: 'magenta', icon: BookOpen, label: 'Learning' },
  travel: { tone: 'red', icon: Plane, label: 'Travel' },
  health: { tone: 'teal', icon: HeartPulse, label: 'Health' },
  event: { tone: 'violet', icon: Trophy, label: 'Event' },
  personal: { tone: 'blue', icon: Clapperboard, label: 'Personal' },
  focus: { tone: 'cyan', icon: Timer, label: 'Focus' },
};
// Presentation / birthday use distinct icons but reuse kinds
export const titleIcon: Record<string, LucideIcon> = { Presentation: FileText, Birthday: Cake };


/** Today as yyyy-mm-dd in the user's local timezone. */
export const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
