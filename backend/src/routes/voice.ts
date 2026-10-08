import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { voiceService } from '../services/voice.js';
import { ApiError } from '../middleware/errorHandler.js';

export const voiceRouter = Router();

const ttsSchema = z.object({
  text: z.string().min(1).max(2000),
  voiceId: z.string().optional(),
});

voiceRouter.post('/speak', requireAuth, async (req, res, next) => {
  const parsed = ttsSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(new ApiError(400, parsed.error.issues.map((i) => i.message).join(', ')));
  }
  try {
    const audio = await voiceService.textToSpeech(parsed.data.text, parsed.data.voiceId);
    res.setHeader('Content-Type', voiceService.contentType);
    res.send(audio);
  } catch (err) {
    next(new ApiError(503, err instanceof Error ? err.message : 'Voice synthesis unavailable'));
  }
});
