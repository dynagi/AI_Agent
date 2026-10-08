import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { User, Download, Mic, Sparkles, Globe, Calendar, Settings, Lock, UserX, LogOut, Plane, ShoppingCart, BookOpen, Brain, RefreshCw, Trash2, ShieldCheck } from 'lucide-react';
import { Hud, IconBox, PageHero, AppLogo, FuturisticModal, NeonButton, SyncStatus, toast, type Tone } from '../components/aura';
import { signInWithGoogle, signOut } from '../services/auth';
import { apiGet, apiSend } from '../services/api';
import { googleStatusStore, syncGoogleCalendar } from '../services/googleCalendar';
import { preferencesStore, profileStore, resetAllStores, type Preferences } from '../state/stores';
import { GENDER_OPTIONS, useGender, useUser } from '../state/user';

/* =================== INTEGRATIONS & SETTINGS =================== */

const STYLES: Preferences['responseStyle'][] = ['Balanced', 'Concise', 'Detailed'];

const builtIn: { icon: typeof Plane; tone: Tone; name: string; what: string }[] = [
  { icon: ShoppingCart, tone: 'amber', name: 'Google Shopping', what: 'Live price comparison across stores (via SerpAPI)' },
  { icon: Plane, tone: 'blue', name: 'Google Flights & Hotels', what: 'Live fares and stays (via SerpAPI)' },
  { icon: BookOpen, tone: 'violet', name: 'arXiv', what: 'Research paper search' },
  { icon: Brain, tone: 'cyan', name: 'AURA AI', what: 'Reasoning by the configured language model' },
  { icon: Mic, tone: 'magenta', name: 'Voice', what: 'Spoken replies by the configured voice provider' },
];

export default function Integrations({ settingsFirst = false }: { settingsFirst?: boolean }) {
  const nav = useNavigate();
  const user = useUser();
  const prefs = preferencesStore.use()[0];
  const gender = useGender();
  const profile = profileStore.use()[0];
  const setGender = (value: string) => {
    profileStore.set([{ id: 'me', goals: profile?.goals ?? [], routine: profile?.routine ?? {}, preferences: { ...(profile?.preferences ?? {}), Gender: value } }]);
    toast(value === 'Female' ? 'Saved. The Period Tracker is now available in Wellness.' : 'Saved.');
  };
  const google = googleStatusStore.use();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { void syncGoogleCalendar(); }, []);

  const setStyle = (responseStyle: Preferences['responseStyle']) => {
    preferencesStore.set([{ id: 'prefs', responseStyle }]);
    toast(`AURA will reply in a ${responseStyle.toLowerCase()} style.`);
  };

  const exportData = async () => {
    setBusy(true);
    try {
      const res = await apiGet<{ data: { collection: string; id: string; data: unknown }[] }>('/records');
      const out: Record<string, unknown[]> = {};
      for (const r of res.data) (out[r.collection] ??= []).push({ ...(r.data as object), id: r.id });
      const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), account: user.email, collections: out }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `aura-data-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast(`Exported ${res.data.length} records.`);
    } catch (e) {
      toast(e instanceof Error && /bearer|401/i.test(e.message) ? 'Sign in to export your data.' : 'Export failed. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const deleteData = async () => {
    setBusy(true);
    try {
      await apiSend('DELETE', '/records');
      resetAllStores();
      setConfirmDelete(false);
      toast('All of your saved AURA data was deleted.');
    } catch {
      toast('Could not delete your data. Nothing was changed.');
    } finally {
      setBusy(false);
    }
  };

  const logOut = async () => { await signOut(); resetAllStores(); nav('/login'); };

  const privacy = (
    <Hud title="Privacy & Data" icon={ShieldCheck} sub="You own your data. Export or erase it at any time.">
      <div className="list">
        <button className="li" style={{ background: 'none', border: 0, width: '100%', textAlign: 'left' }} onClick={() => void exportData()} disabled={busy}>
          <IconBox icon={Download} tone="violet" size="sm" /><div className="grow"><div className="t-title">Export my data</div><div className="t-sub">Download everything AURA has saved for you (JSON)</div></div>›
        </button>
        <button className="li" style={{ background: 'none', border: 0, width: '100%', textAlign: 'left' }} onClick={() => setConfirmDelete(true)}>
          <IconBox icon={UserX} tone="red" size="sm" /><div className="grow"><div className="t-title">Delete all my data</div><div className="t-sub">Permanently erase tasks, events, finances, chats and more</div></div>›
        </button>
      </div>
    </Hud>
  );

  const account = (
    <Hud title="Account" icon={Lock} sub="Signed in with Supabase Auth.">
      {user.signedIn ? (
        <div className="list">
          <div className="li"><div className="avatar" style={{ width: 40, height: 40 }}>{user.initials}</div><div className="grow"><div className="t-title">{user.name}</div><div className="t-sub">{user.email}</div></div><span className="tag blue">{user.plan}</span></div>
          <button className="li" style={{ background: 'none', border: 0, width: '100%', textAlign: 'left' }} onClick={() => void logOut()}><IconBox icon={LogOut} tone="blue" size="sm" /><div className="grow"><div className="t-title">Sign out</div></div>›</button>
        </div>
      ) : (
        <div className="stack" style={{ gap: 10 }}><span className="t-sub">You're not signed in. Sign in to save and sync your data.</span><NeonButton variant="primary" onClick={() => nav('/login')}>Sign in</NeonButton></div>
      )}
    </Hud>
  );

  const appPrefs = (
    <Hud title="Preferences" icon={Settings} sub="Customize how AURA responds.">
      <div className="list">
        <div className="li"><User size={16} className="c-cyan" /><span className="grow">Gender<div className="t-mute">Only used to show or hide features such as the Period Tracker.</div></span>
          <select className="select" value={gender} onChange={(e) => setGender(e.target.value)} aria-label="Gender">{GENDER_OPTIONS.map((g) => <option key={g}>{g}</option>)}</select>
        </div>
        <div className="li"><Sparkles size={16} className="c-cyan" /><span className="grow">Response style</span>
          <div className="row">{STYLES.map((s) => <button key={s} className={`chip ${(prefs?.responseStyle ?? 'Balanced') === s ? 'active' : ''}`} onClick={() => setStyle(s)}>{s}</button>)}</div>
        </div>
      </div>
    </Hud>
  );

  return (
    <>
      <PageHero title={settingsFirst ? 'Settings &' : 'Integrations &'} accent={settingsFirst ? 'Control Center' : 'Settings'} lead="See what AURA is connected to, and control your account and data. Least privilege, always revocable." quote="One AI. All your apps. A more organized you." />
      {settingsFirst && <div className="grid g2">{account}{appPrefs}</div>}
      <div className="with-rail">
        <Hud title="Connected Apps" icon={Globe} sub="Accounts you have linked to AURA.">
          <div className="tile row">
            <AppLogo name="Google Calendar" size={48} />
            <div style={{ flex: 1 }}>
              <div className="t-title">Google Calendar</div>
              <span className={google.state === 'connected' ? 'c-green' : 't-mute'} style={{ fontSize: 12 }}>
                {google.state === 'connected' ? '● Connected' : google.state === 'syncing' ? 'Checking…' : google.state === 'error' ? `Error: ${google.message}` : 'Not connected'}
              </span>
              <div className="row wrap" style={{ marginTop: 6 }}>{['calendar.events', 'calendar.readonly'].map((s) => <span className="tag cyan mono" key={s}>{s}</span>)}</div>
            </div>
            <div className="stack" style={{ gap: 6 }}>
              {google.state !== 'connected' && <NeonButton size="sm" variant="primary" icon={Calendar} onClick={() => void signInWithGoogle().catch((e) => toast(e instanceof Error ? e.message : 'Google sign-in failed.'))}>Connect</NeonButton>}
              {google.state === 'connected' && <NeonButton size="sm" icon={RefreshCw} onClick={() => void syncGoogleCalendar().then(() => toast('Google Calendar synced.'))}>Sync now</NeonButton>}
            </div>
          </div>
          <p className="t-mute" style={{ marginTop: 10 }}>To revoke access, remove AURA from your Google Account's third-party access page.</p>
        </Hud>
        <Hud title="Built-in Data Sources" icon={Settings} sub="Managed on the server — no setup needed.">
          <div className="list">
            {builtIn.map((b) => (
              <div className="li" key={b.name}><IconBox icon={b.icon} tone={b.tone} size="sm" /><div className="grow"><div className="t-title">{b.name}</div><div className="t-sub">{b.what}</div></div></div>
            ))}
          </div>
        </Hud>
      </div>
      {!settingsFirst && <div className="grid g3">{account}{privacy}{appPrefs}</div>}
      {settingsFirst && <div className="grid g2">{privacy}</div>}
      <SyncStatus stores={[preferencesStore, profileStore]} />

      {confirmDelete && (
        <FuturisticModal title="Delete all my data?" icon={Trash2} tone="amber" onClose={() => !busy && setConfirmDelete(false)}>
          <p style={{ marginBottom: 12 }}>This permanently erases everything AURA has saved for you: tasks, events, finances, memories, chats, decisions and settings.</p>
          <p className="t-mute" style={{ marginBottom: 18 }}>Your sign-in account itself is not deleted. This cannot be undone — consider exporting first.</p>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <NeonButton onClick={() => setConfirmDelete(false)} disabled={busy}>Cancel</NeonButton>
            <NeonButton variant="danger" onClick={() => void deleteData()} disabled={busy}>{busy ? <span className="spinner" /> : 'Delete everything'}</NeonButton>
          </div>
        </FuturisticModal>
      )}
    </>
  );
}
