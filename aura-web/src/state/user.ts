import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { isSupabaseConfigured, supabase } from '../services/supabaseClient';
import { planStore, profileStore } from './stores';
import { resetAllStores } from './stores';

export interface AppUser { signedIn: boolean; name: string; initials: string; email: string; avatar?: string; plan: string }

const PLAN_LABEL = { free: 'Free Plan', pro: 'Pro Plan', team: 'Team Plan' } as const;

function fromSession(session: Session | null, plan: keyof typeof PLAN_LABEL): AppUser {
  const u = session?.user;
  const meta = (u?.user_metadata ?? {}) as { full_name?: string; name?: string; avatar_url?: string };
  const name = meta.full_name || meta.name || u?.email?.split('@')[0] || 'Guest';
  return { signedIn: !!u, name, initials: name.charAt(0).toUpperCase(), email: u?.email ?? '', avatar: meta.avatar_url, plan: PLAN_LABEL[plan] };
}

export const GENDER_OPTIONS = ['Prefer not to say', 'Female', 'Male', 'Non-binary'] as const;

/** Gender the user chose themselves in Settings/onboarding. Never guessed from a name. */
export function useGender(): string {
  return profileStore.use()[0]?.preferences?.Gender ?? 'Prefer not to say';
}

/** The period tracker is only shown to users who told AURA they are female. */
export const useShowPeriodTracker = () => useGender() === 'Female';

/** The signed-in user, taken from the Supabase session. Reloads/clears stores when the account changes. */
export function useUser(): AppUser {
  const plan = planStore.use();
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => {
    if (!isSupabaseConfigured) return;
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === 'SIGNED_OUT') resetAllStores();
    });
    return () => data.subscription.unsubscribe();
  }, []);
  return fromSession(session, plan);
}
