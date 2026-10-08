import { isSupabaseConfigured, supabase } from './supabaseClient';

export const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function authHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...extra };
  if (isSupabaseConfigured) {
    const { data } = await supabase.auth.getSession();
    if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`;
    if (data.session?.provider_token) headers['X-Google-Access-Token'] = data.session.provider_token;
  }
  return headers;
}

/** The signed-in user's session token, for native code that calls the backend itself (the cart agent). */
export async function accessToken(): Promise<string | undefined> {
  if (!isSupabaseConfigured) return undefined;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token;
}

/** Status 0 = the server couldn't be reached (offline, asleep and waking up, or no network). */
export const OFFLINE_MESSAGE = "AURA's server isn't answering. It may be waking up; try again in a minute.";
export const isOffline = (e: unknown) => e instanceof ApiError && e.status === 0;

// A request still running after SLOW_MS gets a quick check that the server is there at all: if it isn't (a
// switched-off PC, a free host that is asleep), the request is dropped at once instead of hanging. A server that is
// there may take up to MAX_MS (AI answers can be slow).
const SLOW_MS = 8_000;
const PROBE_MS = 5_000;
const MAX_MS = 60_000;

/** Whether the server answers its health check within `ms`. */
export async function serverUp(ms = PROBE_MS): Promise<boolean> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${API_URL}/health`, { signal: ctl.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** Starts waking the server (a free host sleeps when idle and needs about a minute). Fire and forget. */
export function wakeServer(): void {
  void serverUp(90_000);
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = await authHeaders(init.body ? { 'Content-Type': 'application/json' } : undefined);
  const ctl = new AbortController();
  let gaveUp = '';
  const slow = setTimeout(() => {
    void serverUp().then((up) => { if (!up) { gaveUp = OFFLINE_MESSAGE; ctl.abort(); } });
  }, SLOW_MS);
  const cap = setTimeout(() => { gaveUp = 'AURA took too long to answer. Please try again.'; ctl.abort(); }, MAX_MS);
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { ...init, signal: ctl.signal, headers: { ...headers, ...(init.headers as object) } });
  } catch {
    throw new ApiError(0, gaveUp || OFFLINE_MESSAGE);
  } finally {
    clearTimeout(slow);
    clearTimeout(cap);
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch { /* non-JSON error body */ }
    throw new ApiError(res.status, message);
  }
  return res;
}

export async function apiGet<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== '') qs.set(k, String(v));
  const res = await request(`${path}${qs.size ? `?${qs}` : ''}`);
  return res.json() as Promise<T>;
}

export async function apiSend<T = void>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await request(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export async function apiBlob(path: string, body: unknown): Promise<Blob> {
  const res = await request(path, { method: 'POST', body: JSON.stringify(body) });
  return res.blob();
}
