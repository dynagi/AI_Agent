import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { aiClient, AiServiceError } from '../services/aiClient.js';
import { ApiError } from '../middleware/errorHandler.js';
import { env } from '../config/env.js';
import { createResourceRouter } from './resource.js';

export const travelRouter = Router();

// Outside production, ?demoUser=USER_000123 reads a synthetic demo history instead of the caller's own.
function predictionUserId(req: AuthedRequest): string {
  const demo = req.query.demoUser;
  if (env.nodeEnv !== 'production' && typeof demo === 'string' && /^USER_\d{6}$/.test(demo)) return demo;
  return req.userId ?? 'anonymous';
}

// Next-trip forecast from the travel model (top-3 destinations/apps/types, rough timing and spend).
travelRouter.get('/predictions', requireAuth, async (req: AuthedRequest, res, next) => {
  const asOf = typeof req.query.asOf === 'string' ? req.query.asOf : undefined;
  try {
    res.json({ data: await aiClient.travelPredictions({ userId: predictionUserId(req), asOf }) });
  } catch (err) {
    if (err instanceof AiServiceError) {
      return res.status(503).json({ error: 'Travel predictions are temporarily unavailable.' });
    }
    next(err);
  }
});

const travelEventSchema = z.object({
  action: z.enum(['search', 'flight_view', 'hotel_view', 'price_check', 'wishlist', 'booking', 'cancel']),
  timestamp: z.string().datetime({ offset: true }).optional(),
  destination: z.string().max(80).optional(),
  origin: z.string().max(80).optional(),
  app: z.string().max(40).optional(),
  travel_type: z.enum(['business', 'leisure', 'family', 'solo', 'weekend', 'holiday']).optional(),
  booking_type: z.enum(['flight+hotel', 'train+hotel', 'flight', 'train', 'hotel']).optional(),
  departure_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  trip_duration_days: z.number().int().min(0).max(90).optional(),
  flight_price: z.number().min(0).optional(),
  train_price: z.number().min(0).optional(),
  hotel_price: z.number().min(0).optional(),
  booking_amount: z.number().min(0).optional(),
  is_international: z.boolean().optional(),
});

// Record a travel action so the model learns this user's habits; call it from search/booking flows.
travelRouter.post('/events', requireAuth, async (req: AuthedRequest, res, next) => {
  const parsed = travelEventSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(new ApiError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')));
  }
  try {
    const result = await aiClient.logTravelEvent({ ...parsed.data, userId: req.userId ?? 'anonymous' });
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof AiServiceError) {
      return res.status(503).json({ error: 'Could not record the travel event right now.' });
    }
    next(err);
  }
});

// Registered before the generic /:id resource router below.
travelRouter.get('/flights', requireAuth, async (req, res, next) => {
  const { origin, destination, departureDate, adults } = req.query;
  if (typeof origin !== 'string' || typeof destination !== 'string' || typeof departureDate !== 'string') {
    return next(new ApiError(400, 'origin, destination, and departureDate query params are required'));
  }
  try {
    const results = await aiClient.searchFlights({
      origin,
      destination,
      departureDate,
      adults: adults ? Number(adults) : undefined,
    });
    res.json({ data: results, sortedBy: 'price_ascending' });
  } catch (err) {
    if (err instanceof AiServiceError) {
      return res.status(503).json({ error: 'Flight search is temporarily unavailable.' });
    }
    next(err);
  }
});

travelRouter.get('/hotels', requireAuth, async (req, res, next) => {
  const { destination, checkInDate, checkOutDate, adults } = req.query;
  if (typeof destination !== 'string' || typeof checkInDate !== 'string' || typeof checkOutDate !== 'string') {
    return next(new ApiError(400, 'destination, checkInDate, and checkOutDate query params are required'));
  }
  try {
    const results = await aiClient.searchHotels({
      destination,
      checkInDate,
      checkOutDate,
      adults: adults ? Number(adults) : undefined,
    });
    res.json({ data: results, sortedBy: 'price_ascending' });
  } catch (err) {
    if (err instanceof AiServiceError) {
      return res.status(503).json({ error: 'Hotel search is temporarily unavailable.' });
    }
    next(err);
  }
});

// Also registered before the generic /:id resource router, same reason as above.
travelRouter.post('/suggestions', requireAuth, async (req, res, next) => {
  const items = req.body?.items;
  if (!Array.isArray(items)) {
    return next(new ApiError(400, '"items" array is required'));
  }
  try {
    const ranked = await aiClient.rankTravel(items);
    res.json(ranked);
  } catch (err) {
    if (err instanceof AiServiceError) {
      return res.status(503).json({ error: 'Suggestions are temporarily unavailable.' });
    }
    next(err);
  }
});

travelRouter.use('/', createResourceRouter('travel'));
