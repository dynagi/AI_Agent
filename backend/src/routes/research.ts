import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { aiClient, AiServiceError } from '../services/aiClient.js';
import { ApiError } from '../middleware/errorHandler.js';
import { createResourceRouter } from './resource.js';

export const researchRouter = Router();

// Registered before the generic /:id resource router below.
researchRouter.get('/search', requireAuth, async (req, res, next) => {
  const query = req.query.q;
  if (typeof query !== 'string' || query.trim().length === 0) {
    return next(new ApiError(400, 'Query parameter "q" is required'));
  }
  try {
    const results = await aiClient.searchResearch(query);
    res.json({ data: results });
  } catch (err) {
    if (err instanceof AiServiceError) {
      return res.status(503).json({ error: 'Research search is temporarily unavailable.' });
    }
    next(err);
  }
});

researchRouter.use('/', createResourceRouter('research'));
