import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';
import { createEvent, deleteEvent, GoogleCalendarError, listEvents } from '../services/googleCalendar.js';
import { createResourceRouter } from './resource.js';

export const calendarRouter = Router();

/**
 * Google requires its own access token (not the Supabase JWT). The
 * frontend forwards the Google provider token — obtained from the
 * Supabase session after signInWithOAuth({ provider: 'google', scopes:
 * 'calendar...' }) — via this header.
 */
function requireGoogleToken(req: AuthedRequest): string {
  const token = req.headers['x-google-access-token'];
  if (typeof token !== 'string' || !token) {
    throw new ApiError(428, 'Google Calendar is not connected. Sign in with Google and grant Calendar access.');
  }
  return token;
}

calendarRouter.get('/google/events', requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const token = requireGoogleToken(req);
    const { timeMin, timeMax, maxResults } = req.query;
    const data = await listEvents(token, {
      timeMin: typeof timeMin === 'string' ? timeMin : undefined,
      timeMax: typeof timeMax === 'string' ? timeMax : undefined,
      maxResults: maxResults ? Number(maxResults) : undefined,
    });
    res.json(data);
  } catch (err) {
    if (err instanceof GoogleCalendarError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

const createEventSchema = z.object({
  summary: z.string().min(1),
  description: z.string().optional(),
  start: z.string(),
  end: z.string(),
  timeZone: z.string().optional(),
});

calendarRouter.post('/google/events', requireAuth, async (req: AuthedRequest, res, next) => {
  const parsed = createEventSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(new ApiError(400, parsed.error.issues.map((i) => i.message).join(', ')));
  }
  try {
    const token = requireGoogleToken(req);
    const data = await createEvent(token, parsed.data);
    res.status(201).json(data);
  } catch (err) {
    if (err instanceof GoogleCalendarError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

calendarRouter.delete('/google/events/:eventId', requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const token = requireGoogleToken(req);
    await deleteEvent(token, req.params.eventId);
    res.status(204).send();
  } catch (err) {
    if (err instanceof GoogleCalendarError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Local AURA calendar records (conflict analysis, focus blocks, etc.) —
// separate from live Google events above.
calendarRouter.use('/', createResourceRouter('calendar'));
