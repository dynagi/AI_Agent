import { isSupabaseConfigured, supabase } from './supabaseClient';

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
].join(' ');

export class AuthNotConfiguredError extends Error {
  constructor() {
    super('Sign-in is unavailable: Supabase is not configured (set VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).');
  }
}

/**
 * Redirects to Google's consent screen. On return, Supabase stores the
 * session — including Google's access token (session.provider_token) and
 * refresh token (session.provider_refresh_token) — which the Calendar
 * integration forwards to the backend via the X-Google-Access-Token header.
 */
export async function signInWithGoogle(redirectTo = `${window.location.origin}/dashboard`) {
  if (!isSupabaseConfigured) throw new AuthNotConfiguredError();
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo,
      scopes: GOOGLE_SCOPES,
      queryParams: { access_type: 'offline', prompt: 'consent' },
    },
  });
  if (error) throw error;
}

export async function signInWithEmail(email: string, password: string) {
  if (!isSupabaseConfigured) throw new AuthNotConfiguredError();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signUpWithEmail(email: string, password: string, name?: string) {
  if (!isSupabaseConfigured) throw new AuthNotConfiguredError();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: name ? { full_name: name } : undefined },
  });
  if (error) throw error;
  return data;
}

export async function signOut() {
  if (!isSupabaseConfigured) return;
  await supabase.auth.signOut();
}

export async function getSession() {
  if (!isSupabaseConfigured) return null;
  const { data } = await supabase.auth.getSession();
  return data.session;
}

/** The Google access token, present only after a Google OAuth sign-in. Used for Calendar API calls. */
export async function getGoogleAccessToken(): Promise<string | null> {
  const session = await getSession();
  return session?.provider_token ?? null;
}
