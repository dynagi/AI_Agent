import type { NextFunction, Request, Response } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';
import { ApiError } from './errorHandler.js';

export interface AuthedRequest extends Request {
  userId?: string;
  accessToken?: string;
}

const CACHE_MS = 5 * 60 * 1000;
const verified = new Map<string, { userId: string; until: number }>();
let authClient: SupabaseClient | null = null;

/** Resolves the Supabase user id for a token (cached briefly so every request isn't a round trip). */
async function userIdFor(token: string): Promise<string | null> {
  const hit = verified.get(token);
  if (hit && hit.until > Date.now()) return hit.userId;
  authClient ??= createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data.user) return null;
  if (verified.size > 5000) verified.clear();
  verified.set(token, { userId: data.user.id, until: Date.now() + CACHE_MS });
  return data.user.id;
}

/**
 * Extracts the Supabase-issued JWT from the Authorization header and, when Supabase is configured,
 * verifies it and sets req.userId (the AI service keys each user's history and predictions on it).
 * Row Level Security still applies to every per-user Supabase query.
 */
export async function requireAuth(req: AuthedRequest, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return next(new ApiError(401, 'Missing bearer token'));
  }
  const token = header.slice('Bearer '.length);
  req.accessToken = token;
  if (!env.supabaseUrl || !env.supabaseAnonKey) return next(); // local dev without Supabase: anonymous
  try {
    const userId = await userIdFor(token);
    if (!userId) return next(new ApiError(401, 'Invalid or expired session'));
    req.userId = userId;
    next();
  } catch {
    next(new ApiError(503, 'Could not verify your session right now.'));
  }
}
