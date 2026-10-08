import { Router } from 'express';
import { aiClient } from '../services/aiClient.js';
import { isSupabaseConfigured } from '../services/supabase.js';

export const healthRouter = Router();

healthRouter.get('/', async (_req, res) => {
  let aiStatus: 'ok' | 'unreachable' = 'unreachable';
  try {
    await aiClient.health();
    aiStatus = 'ok';
  } catch {
    aiStatus = 'unreachable';
  }

  res.json({
    status: 'ok',
    service: 'aura-node-backend',
    time: new Date().toISOString(),
    dependencies: {
      supabase: isSupabaseConfigured() ? 'configured' : 'not_configured',
      pythonAi: aiStatus,
    },
  });
});
