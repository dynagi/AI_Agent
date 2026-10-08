import { Router } from 'express';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { getSupabaseForUser } from '../services/supabase.js';
import { ApiError } from '../middleware/errorHandler.js';

/**
 * Builds a REST router backed by a Supabase table, using the caller's JWT
 * so Row Level Security applies. Covers list/create/update/delete for
 * domain resources (tasks, decisions, memory, etc.) that don't yet need
 * bespoke business logic.
 */
export function createResourceRouter(table: string): Router {
  const router = Router();

  router.use(requireAuth);

  router.get('/', async (req: AuthedRequest, res, next) => {
    try {
      const supabase = getSupabaseForUser(req.accessToken!);
      const { data, error } = await supabase.from(table).select('*').order('created_at', { ascending: false });
      if (error) throw new ApiError(400, error.message);
      res.json({ data: data ?? [] });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', async (req: AuthedRequest, res, next) => {
    try {
      const supabase = getSupabaseForUser(req.accessToken!);
      const { data, error } = await supabase.from(table).select('*').eq('id', req.params.id).single();
      if (error) throw new ApiError(404, 'Not found');
      res.json({ data });
    } catch (err) {
      next(err);
    }
  });

  router.post('/', async (req: AuthedRequest, res, next) => {
    try {
      const supabase = getSupabaseForUser(req.accessToken!);
      const { data, error } = await supabase.from(table).insert(req.body).select().single();
      if (error) throw new ApiError(400, error.message);
      res.status(201).json({ data });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id', async (req: AuthedRequest, res, next) => {
    try {
      const supabase = getSupabaseForUser(req.accessToken!);
      const { data, error } = await supabase.from(table).update(req.body).eq('id', req.params.id).select().single();
      if (error) throw new ApiError(400, error.message);
      res.json({ data });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', async (req: AuthedRequest, res, next) => {
    try {
      const supabase = getSupabaseForUser(req.accessToken!);
      const { error } = await supabase.from(table).delete().eq('id', req.params.id);
      if (error) throw new ApiError(400, error.message);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
