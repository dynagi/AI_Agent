import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { env } from '../config/env.js';
import { aiClient, AiServiceError } from '../services/aiClient.js';
import { ApiError } from '../middleware/errorHandler.js';
import { createResourceRouter } from './resource.js';

export const shoppingRouter = Router();

// Must be registered before the generic /:id resource router below,
// otherwise GET /:id would match "search" as an id.
shoppingRouter.get('/search', requireAuth, async (req, res, next) => {
  const query = req.query.q;
  if (typeof query !== 'string' || query.trim().length === 0) {
    return next(new ApiError(400, 'Query parameter "q" is required'));
  }
  try {
    const results = await aiClient.searchShopping(query);
    res.json({ data: results, sortedBy: 'price_ascending' });
  } catch (err) {
    if (err instanceof AiServiceError) {
      return res.status(503).json({ error: 'Price comparison is temporarily unavailable.' });
    }
    next(err);
  }
});

// Also must come before the generic /:id router, for the same reason as /search.
shoppingRouter.post('/suggestions', requireAuth, async (req, res, next) => {
  const products = req.body?.products;
  if (!Array.isArray(products)) {
    return next(new ApiError(400, '"products" array is required'));
  }
  try {
    const ranked = await aiClient.rankShopping(products);
    res.json(ranked);
  } catch (err) {
    if (err instanceof AiServiceError) {
      return res.status(503).json({ error: 'Suggestions are temporarily unavailable.' });
    }
    next(err);
  }
});

// Outside production, ?demoUser=USER_000123 reads a synthetic demo history instead of the caller's own.
function predictionUserId(req: AuthedRequest): string {
  const demo = req.query.demoUser;
  if (env.nodeEnv !== 'production' && typeof demo === 'string' && /^USER_d{6}$/.test(demo)) return demo;
  return req.userId ?? 'anonymous';
}

// What the user will likely buy in the next 7 days (items, store, timing, rough cost) from the shopping model.
shoppingRouter.get('/predictions', requireAuth, async (req: AuthedRequest, res, next) => {
  const asOf = typeof req.query.asOf === 'string' ? req.query.asOf : undefined;
  try {
    res.json({ data: await aiClient.shoppingPredictions({ userId: predictionUserId(req), asOf }) });
  } catch (err) {
    if (err instanceof AiServiceError) {
      return res.status(503).json({ error: 'Shopping predictions are temporarily unavailable.' });
    }
    next(err);
  }
});

const shoppingEventSchema = z.object({
  action: z.enum(['search', 'view', 'wishlist', 'add_to_cart', 'order', 'cancel', 'not_interested']),
  name: z.string().min(1).max(120),
  timestamp: z.string().datetime({ offset: true }).optional(),
  category: z.string().max(40).optional(),
  app: z.string().max(40).optional(),
  qty: z.number().min(0).max(100).optional(),
  price: z.number().min(0).optional(),
  source: z.enum(['app', 'agent_command', 'cart_agent']).optional(),
});
const shoppingEventsSchema = z.object({ events: z.array(shoppingEventSchema).min(1).max(100) });

// Record shopping actions (search, cart adds, orders...) so predictions and the model learn this user's habits.
shoppingRouter.post('/events', requireAuth, async (req: AuthedRequest, res, next) => {
  const parsed = shoppingEventsSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(new ApiError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')));
  }
  try {
    res.status(201).json(await aiClient.logShoppingEvents({ userId: req.userId ?? 'anonymous', events: parsed.data.events }));
  } catch (err) {
    if (err instanceof AiServiceError) {
      return res.status(503).json({ error: 'Could not record shopping activity right now.' });
    }
    next(err);
  }
});

// One turn with the shopping assistant: it understands the request against the user's history, shows the real
// options, asks when it should, and only returns a cart job once the user (or their rules) decided.
const assistSchema = z.object({
  message: z.string().min(1).max(1500),
  installedStores: z.array(z.string().max(60)).max(40).optional(),
});
shoppingRouter.post('/assist', requireAuth, async (req: AuthedRequest, res, next) => {
  const parsed = assistSchema.safeParse(req.body);
  if (!parsed.success) return next(new ApiError(400, parsed.error.issues.map((i) => i.message).join(', ')));
  try {
    res.json(await aiClient.shoppingAssist({ userId: req.userId ?? 'anonymous', ...parsed.data }));
  } catch (err) {
    if (err instanceof AiServiceError) return res.status(503).json({ error: 'The shopping assistant is temporarily unavailable.' });
    next(err);
  }
});

// The user's purchase rules (what needs a confirmation, what may be ordered automatically).
const policySchema = z.object({
  require_confirmation_for_new_product: z.boolean(),
  require_confirmation_above: z.number().min(0).max(10_000_000),
  max_price_deviation_percent: z.number().min(0).max(1000),
  allow_auto_repeat_orders: z.boolean(),
  auto_order_rules: z.array(z.object({
    item: z.string().min(1).max(80),
    provider: z.string().max(60).nullish(),
    max_price: z.number().min(0).nullish(),
    max_qty: z.number().int().min(1).max(50),
  })).max(50),
  min_provider_confidence: z.number().min(0).max(1),
});
shoppingRouter.get('/policy', requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    res.json({ data: await aiClient.shoppingPolicy(req.userId ?? 'anonymous') });
  } catch (err) {
    if (err instanceof AiServiceError) return res.status(503).json({ error: 'Shopping rules are temporarily unavailable.' });
    next(err);
  }
});
shoppingRouter.put('/policy', requireAuth, async (req: AuthedRequest, res, next) => {
  const parsed = policySchema.safeParse(req.body);
  if (!parsed.success) return next(new ApiError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')));
  try {
    res.json({ data: await aiClient.saveShoppingPolicy(req.userId ?? 'anonymous', parsed.data) });
  } catch (err) {
    if (err instanceof AiServiceError) return res.status(503).json({ error: 'Could not save your shopping rules.' });
    next(err);
  }
});

// What AURA has learnt about the user's shopping (usual products, stores, rhythm, price-vs-speed), with confidence.
shoppingRouter.get('/preferences', requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    res.json({ data: await aiClient.shoppingPreferences(req.userId ?? 'anonymous') });
  } catch (err) {
    if (err instanceof AiServiceError) return res.status(503).json({ error: 'Shopping preferences are temporarily unavailable.' });
    next(err);
  }
});

shoppingRouter.get('/model', requireAuth, async (_req, res, next) => {
  try {
    res.json({ data: await aiClient.shoppingModel() });
  } catch (err) {
    if (err instanceof AiServiceError) return res.status(503).json({ error: 'Model status unavailable.' });
    next(err);
  }
});

// Cart agent: the phone app sends a snapshot of the store page it is driving and gets the next action.
shoppingRouter.get('/agent/store', requireAuth, async (req, res, next) => {
  const name = req.query.name;
  if (typeof name !== 'string' || !name.trim()) return next(new ApiError(400, 'Query parameter "name" is required'));
  try {
    res.json({ data: await aiClient.cartAgentStore(name) });
  } catch (err) {
    if (err instanceof AiServiceError) return res.status(503).json({ error: 'Cart agent is temporarily unavailable.' });
    next(err);
  }
});

const stepSchema = z.object({
  mode: z.enum(['web', 'app']).default('web'),
  appPackage: z.string().max(200).nullish(),
  phase: z.enum(['history', 'cart']).default('cart'),
  resolved: z.boolean().default(true),
  ordersRead: z.number().int().min(0).max(100).default(0),
  ordersKnown: z.number().int().min(0).max(100).default(0),
  historyLimit: z.number().int().min(1).max(40).default(8),
  store: z.string().min(1).max(60),
  items: z.array(z.object({
    name: z.string().min(1).max(120),
    qty: z.number().int().min(1).max(50),
    status: z.enum(['pending', 'added', 'failed']),
    note: z.string().max(200).nullish(),
    hint: z.string().max(200).nullish(),
  })).max(30),
  url: z.string().max(2000),
  title: z.string().max(300).default(''),
  elements: z.array(z.record(z.unknown())).max(250).default([]),
  pageText: z.string().max(4000).default(''),
  history: z.array(z.record(z.unknown())).max(40).default([]),
  step: z.number().int().min(0).max(1000).default(0),
});

shoppingRouter.post('/agent/step', requireAuth, async (req: AuthedRequest, res, next) => {
  const parsed = stepSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(new ApiError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')));
  }
  try {
    // userId comes from the verified session (orders read from the store app are saved to this user's history)
    res.json(await aiClient.cartAgentStep({ ...parsed.data, userId: req.userId ?? 'anonymous' }));
  } catch (err) {
    if (err instanceof AiServiceError) return res.status(503).json({ error: 'Cart agent is temporarily unavailable.' });
    next(err);
  }
});

shoppingRouter.use('/', createResourceRouter('shopping'));
