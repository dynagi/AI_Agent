import { apiGet } from './api';
import { createStore } from '../state/store';
import type { CalendarEvent } from '../data/events';

interface GoogleEvent {
  id: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

/** Events fetched live from the user's Google Calendar (read-only in the UI). */
export const googleEventsStore = createStore<CalendarEvent[]>([]);
export const googleStatusStore = createStore<{ state: 'idle' | 'syncing' | 'connected' | 'not_connected' | 'error'; message: string }>({ state: 'idle', message: '' });

const localISO = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const clock = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

function toEvent(g: GoogleEvent): CalendarEvent | null {
  const s = g.start?.dateTime ?? g.start?.date;
  if (!s) return null;
  if (g.start?.dateTime) {
    const start = new Date(g.start.dateTime);
    const end = g.end?.dateTime ? new Date(g.end.dateTime) : undefined;
    return { id: `g_${g.id}`, title: g.summary || '(No title)', date: localISO(start), start: clock(start), end: end ? clock(end) : undefined, kind: 'event', notes: g.description, source: 'google' };
  }
  return { id: `g_${g.id}`, title: g.summary || '(No title)', date: s, start: 'All Day', kind: 'event', notes: g.description, source: 'google' };
}

/** Loads the next ~90 days (and the last 30) of Google Calendar events. */
export async function syncGoogleCalendar() {
  googleStatusStore.set({ state: 'syncing', message: '' });
  try {
    const min = new Date(); min.setDate(min.getDate() - 30);
    const max = new Date(); max.setDate(max.getDate() + 90);
    const res = await apiGet<{ items?: GoogleEvent[] }>('/calendar/google/events', { timeMin: min.toISOString(), timeMax: max.toISOString(), maxResults: 250 });
    googleEventsStore.set((res.items ?? []).map(toEvent).filter((e): e is CalendarEvent => e !== null));
    googleStatusStore.set({ state: 'connected', message: '' });
  } catch (e) {
    const status = (e as { status?: number }).status;
    const message = e instanceof Error ? e.message : 'Google Calendar sync failed';
    googleStatusStore.set(status === 428 || status === 401 ? { state: 'not_connected', message } : { state: 'error', message });
  }
}
