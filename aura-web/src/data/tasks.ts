import type { Tone } from '../components/ui';

export type Priority = 'High' | 'Medium' | 'Low';
export type TaskDay = 'today' | 'tomorrow' | 'later';

export interface TaskItem {
  id: string;
  title: string;
  categories: string[];
  priority: Priority;
  day: TaskDay;
  /** ISO date (yyyy-mm-dd) */
  date: string;
  start?: string; // "11:00 AM"
  end?: string;
  flagged: boolean;
  done: boolean;
  notes?: string;
}

export const categoryTone: Record<string, Tone> = {
  Work: 'blue', Meeting: 'blue', Hackathon: 'violet', Health: 'green', Learning: 'violet', Travel: 'cyan', Personal: 'magenta', Errand: 'amber', Finance: 'green',
};
export const priorityTone: Record<Priority, Tone> = { High: 'red', Medium: 'amber', Low: 'blue' };
export const allCategories = ['Work', 'Meeting', 'Hackathon', 'Health', 'Learning', 'Travel', 'Personal', 'Errand', 'Finance'] as const;

const isoIn = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

/** Which section a task date falls in, computed from today so it never goes stale. */
export const dayOf = (date: string): TaskDay => (date <= isoIn(0) ? 'today' : date === isoIn(1) ? 'tomorrow' : 'later');
