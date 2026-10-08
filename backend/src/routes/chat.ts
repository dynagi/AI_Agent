import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { aiClient, AiServiceError } from '../services/aiClient.js';
import { ApiError } from '../middleware/errorHandler.js';

export const chatRouter = Router();

const chatSchema = z.object({
  message: z.string().min(1).max(4000),
  conversationId: z.string().optional(),
});

chatRouter.post('/', requireAuth, async (req: AuthedRequest, res, next) => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(new ApiError(400, parsed.error.issues.map((i) => i.message).join(', ')));
  }

  try {
    const result = await aiClient.chat({
      message: parsed.data.message,
      conversationId: parsed.data.conversationId,
      userId: req.userId ?? 'anonymous',
    });
    res.json(result);
  } catch (err) {
    if (err instanceof AiServiceError) {
      return res.status(503).json({
        error: 'AURA AI reasoning is temporarily unavailable. Your saved tasks and calendar are still accessible.',
      });
    }
    next(err);
  }
});

const converseSchema = z.object({
  message: z.string().min(1).max(1500),
  context: z.string().max(6000).optional(),
  history: z.array(z.object({ role: z.enum(['user', 'aura']), text: z.string().max(600) })).max(8).optional(),
  pending: z.string().max(300).optional(),
});

/** Fast single-call voice companion reply (see ai-service/app/routers/companion.py). */
chatRouter.post('/converse', requireAuth, async (req: AuthedRequest, res, next) => {
  const parsed = converseSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(new ApiError(400, parsed.error.issues.map((i) => i.message).join(', ')));
  }
  try {
    res.json(await aiClient.converse(parsed.data));
  } catch (err) {
    if (err instanceof AiServiceError) {
      return res.status(503).json({ error: 'AURA is temporarily unavailable.' });
    }
    next(err);
  }
});

const planSchema = z.object({ goal: z.string().min(1).max(2000) });

chatRouter.post('/plan', requireAuth, async (req: AuthedRequest, res, next) => {
  const parsed = planSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(new ApiError(400, parsed.error.issues.map((i) => i.message).join(', ')));
  }
  try {
    res.json(await aiClient.plan({ goal: parsed.data.goal, userId: req.userId ?? 'anonymous' }));
  } catch (err) {
    if (err instanceof AiServiceError) {
      return res.status(503).json({ error: 'AURA planning is temporarily unavailable.' });
    }
    next(err);
  }
});
