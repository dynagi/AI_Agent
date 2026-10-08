import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { aiClient, AiServiceError } from '../services/aiClient.js';
import { ApiError } from '../middleware/errorHandler.js';

/**
 * Screen agent: the phone app posts what is on screen (and, for visual search or hard screens, a downscaled
 * screenshot) and gets back one action to perform, or the products seen in the screenshot with live prices.
 * The server never acts on the phone and does not store screens or screenshots.
 */
export const screenRouter = Router();

// A downscaled JPEG of a phone screen is a few hundred KB; base64 inflates it by a third. express.json allows 2 MB.
const MAX_IMAGE_CHARS = 1_400_000;

const stepSchema = z.object({
  goal: z.string().min(1).max(500),
  app: z.string().max(80).default(''),
  elements: z.array(z.record(z.unknown())).max(250).default([]),
  pageText: z.string().max(4000).default(''),
  history: z.array(z.record(z.unknown())).max(40).default([]),
  step: z.number().int().min(0).max(1000).default(0),
  screenshot: z.string().max(MAX_IMAGE_CHARS).nullish(),
});

screenRouter.post('/step', requireAuth, async (req, res, next) => {
  const parsed = stepSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(new ApiError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')));
  }
  try {
    res.json(await aiClient.screenStep(parsed.data));
  } catch (err) {
    if (err instanceof AiServiceError) return res.status(503).json({ error: 'The screen assistant is temporarily unavailable.' });
    next(err);
  }
});

const visualSchema = z.object({
  image: z.string().min(100).max(MAX_IMAGE_CHARS),
  hint: z.string().max(300).default(''),
  maxResults: z.number().int().min(1).max(12).default(6),
});

screenRouter.post('/visual-search', requireAuth, async (req, res, next) => {
  const parsed = visualSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(new ApiError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')));
  }
  try {
    res.json(await aiClient.screenVisualSearch(parsed.data));
  } catch (err) {
    if (err instanceof AiServiceError) return res.status(503).json({ error: 'Visual search is temporarily unavailable.' });
    next(err);
  }
});
