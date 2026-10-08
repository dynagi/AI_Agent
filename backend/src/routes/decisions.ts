import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { aiClient, AiServiceError } from '../services/aiClient.js';
import { ApiError } from '../middleware/errorHandler.js';
import { createResourceRouter } from './resource.js';

export const decisionsRouter = Router();

decisionsRouter.use('/', createResourceRouter('decision_sessions'));

const decideSchema = z.object({
  situation: z.string().min(1),
  context: z.record(z.unknown()).optional(),
});

decisionsRouter.post('/evaluate', requireAuth, async (req: AuthedRequest, res, next) => {
  const parsed = decideSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(new ApiError(400, parsed.error.issues.map((i) => i.message).join(', ')));
  }
  try {
    const result = await aiClient.decide({
      situation: parsed.data.situation,
      context: parsed.data.context,
      userId: req.userId ?? 'anonymous',
    });
    res.json(result);
  } catch (err) {
    if (err instanceof AiServiceError) {
      return res.status(503).json({ error: 'Decision engine is temporarily unavailable.' });
    }
    next(err);
  }
});
