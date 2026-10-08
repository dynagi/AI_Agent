/**
 * Google Calendar REST client. Uses the Google access token forwarded by
 * the frontend (obtained via Supabase's Google OAuth sign-in with Calendar
 * scopes) — the backend never stores Google credentials itself.
 */

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';

export class GoogleCalendarError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function googleFetch(accessToken: string, path: string, init?: RequestInit) {
  const res = await fetch(`${CALENDAR_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new GoogleCalendarError(res.status, `Google Calendar request failed (${res.status}): ${detail}`);
  }
  return res.json();
}

export function listEvents(accessToken: string, params: { timeMin?: string; timeMax?: string; maxResults?: number }) {
  const query = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    timeMin: params.timeMin ?? new Date().toISOString(),
    ...(params.timeMax ? { timeMax: params.timeMax } : {}),
    maxResults: String(params.maxResults ?? 50),
  });
  return googleFetch(accessToken, `/calendars/primary/events?${query.toString()}`);
}

export function createEvent(
  accessToken: string,
  event: { summary: string; description?: string; start: string; end: string; timeZone?: string },
) {
  return googleFetch(accessToken, '/calendars/primary/events', {
    method: 'POST',
    body: JSON.stringify({
      summary: event.summary,
      description: event.description,
      start: { dateTime: event.start, timeZone: event.timeZone ?? 'UTC' },
      end: { dateTime: event.end, timeZone: event.timeZone ?? 'UTC' },
    }),
  });
}

export function deleteEvent(accessToken: string, eventId: string) {
  return googleFetch(accessToken, `/calendars/primary/events/${eventId}`, { method: 'DELETE' });
}
