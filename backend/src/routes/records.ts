import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { getSupabaseForUser } from '../services/supabase.js';
import { ApiError } from '../middleware/errorHandler.js';

export const recordsRouter = Router();
recordsRouter.use(requireAuth);

/** Everything the user has stored, for data export. */
recordsRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const { data, error } = await getSupabaseForUser(req.accessToken!).from('app_records').select('collection, id, data, updated_at').order('collection').order('updated_at');
    if (error) throw new ApiError(400, error.message);
    res.json({ data: data ?? [] });
  } catch (err) {
    next(err);
  }
});

/** Deletes every record the user has stored (RLS limits this to their own rows). */
recordsRouter.delete('/', async (req: AuthedRequest, res, next) => {
  try {
    const { error } = await getSupabaseForUser(req.accessToken!).from('app_records').delete().neq('id', '');
    if (error) throw new ApiError(400, error.message);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

const collectionSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/i);

recordsRouter.get('/:collection', async (req: AuthedRequest, res, next) => {
  try {
    const collection = collectionSchema.parse(req.params.collection);
    const { data, error } = await getSupabaseForUser(req.accessToken!)
      .from('app_records')
      .select('id, data')
      .eq('collection', collection)
      .order('updated_at', { ascending: true });
    if (error) throw new ApiError(400, error.message);
    res.json({ data: (data ?? []).map((r) => ({ ...(r.data as object), id: r.id })) });
  } catch (err) {
    next(err);
  }
});

recordsRouter.put('/:collection/:id', async (req: AuthedRequest, res, next) => {
  try {
    const collection = collectionSchema.parse(req.params.collection);
    const id = z.string().min(1).max(128).parse(req.params.id);
    const body = z.record(z.unknown()).parse(req.body);
    const { error } = await getSupabaseForUser(req.accessToken!)
      .from('app_records')
      .upsert(
        { collection, id, data: body, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,collection,id' },
      );
    if (error) throw new ApiError(400, error.message);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

recordsRouter.delete('/:collection/:id', async (req: AuthedRequest, res, next) => {
  try {
    const collection = collectionSchema.parse(req.params.collection);
    const { error } = await getSupabaseForUser(req.accessToken!)
      .from('app_records')
      .delete()
      .eq('collection', collection)
      .eq('id', req.params.id);
    if (error) throw new ApiError(400, error.message);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
