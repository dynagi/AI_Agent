import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { toast } from '../aura';
import { AuraScreen, type VisualMatch } from '../../native/screen';
import { API_URL } from '../../services/api';
import { isSupabaseConfigured, supabase } from '../../services/supabaseClient';
import { useUser } from '../../state/user';

const isNative = Capacitor.isNativePlatform();

/**
 * Mounted once in the app shell (Android app only). Gives the phone the AURA server address and the user's current
 * session token, so "Hey Aura, find this" and the screen assistant can call the server while AURA is in the
 * background, and keeps the token fresh. It also brings the product matches from "find this" into Shopping.
 */
export default function ScreenSync() {
  const user = useUser();
  const nav = useNavigate();
  const navRef = useRef(nav);
  navRef.current = nav;
  const shown = useRef(0);

  // the session token, now and whenever Supabase refreshes it
  useEffect(() => {
    if (!isNative || !user.signedIn || !isSupabaseConfigured) return;
    const send = (token?: string) => { if (token) void AuraScreen.configure({ apiBase: API_URL, token }).catch(() => undefined); };
    void supabase.auth.getSession().then(({ data }) => send(data.session?.access_token));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => send(session?.access_token));
    return () => sub.subscription.unsubscribe();
  }, [user.signedIn]);

  // a product found on screen: open it in Shopping (live while the app runs, and once on launch / resume)
  useEffect(() => {
    if (!isNative || !user.signedIn) return;
    const show = (v: VisualMatch | undefined) => {
      if (!v || !v.query || v.at <= shown.current) return;
      shown.current = v.at;
      navRef.current('/shopping', { state: { search: v.query } });
      toast(`🔎 ${v.summary || v.query}`);
    };
    const take = () => AuraScreen.takeVisual().then((r) => show(r.visual)).catch(() => undefined);
    void take();
    const live = AuraScreen.addListener('visualSearch', show);
    const onVisible = () => { if (document.visibilityState === 'visible') void take(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { document.removeEventListener('visibilitychange', onVisible); void live.then((h) => h.remove()); };
  }, [user.signedIn]);

  return null;
}
