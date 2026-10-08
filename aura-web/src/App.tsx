import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { isSupabaseConfigured, supabase } from './services/supabaseClient';
import { AuraShell } from './components/aura';
import { Splash, Login, Signup, Personalize } from './screens/Auth';
import Home from './screens/Home';

// Heavier / secondary screens are code-split.
const Chat = lazy(() => import('./screens/Chat'));
const Voice = lazy(() => import('./screens/Voice'));
const Decisions = lazy(() => import('./screens/Decisions'));
const Tasks = lazy(() => import('./screens/Tasks'));
const TaskBoard = lazy(() => import('./screens/TaskBoard'));
const Calendar = lazy(() => import('./screens/Calendar'));
const AgentHub = lazy(() => import('./screens/Agents').then((m) => ({ default: m.AgentHub })));
const AgentDetail = lazy(() => import('./screens/Agents').then((m) => ({ default: m.AgentDetail })));
const Collaboration = lazy(() => import('./screens/Agents').then((m) => ({ default: m.Collaboration })));
const Shopping = lazy(() => import('./screens/Shopping'));
const Travel = lazy(() => import('./screens/Travel'));
const Finance = lazy(() => import('./screens/Finance'));
const Wellness = lazy(() => import('./screens/Wellness'));
const Research = lazy(() => import('./screens/Research'));
const Memory = lazy(() => import('./screens/Memory'));
const AutomationHub = lazy(() => import('./screens/AutomationHub'));
const Automations = lazy(() => import('./screens/Automations'));
const Integrations = lazy(() => import('./screens/Integrations'));
const Analytics = lazy(() => import('./screens/Meta').then((m) => ({ default: m.Analytics })));
const ThankYou = lazy(() => import('./screens/Meta').then((m) => ({ default: m.ThankYou })));
const Pricing = lazy(() => import('./screens/Pricing'));
const Qa = lazy(() => import('./screens/Qa'));

function S({ children }: { children: ReactNode }) {
  return <Suspense fallback={<Loading />}>{children}</Suspense>;
}

function Loading() {
  return <div className="row t-sub" style={{ padding: 24 }}><span className="spinner" /> <span className="hud-label">Loading module…</span></div>;
}

/** Sends signed-out visitors to the login screen. Skipped when Supabase isn't configured so the UI stays browsable. */
function RequireAuth({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'in' | 'out'>(isSupabaseConfigured ? 'checking' : 'in');
  useEffect(() => {
    if (!isSupabaseConfigured) return;
    void supabase.auth.getSession().then(({ data }) => setState(data.session ? 'in' : 'out'));
    const { data } = supabase.auth.onAuthStateChange((_e, session) => setState(session ? 'in' : 'out'));
    return () => data.subscription.unsubscribe();
  }, []);
  if (state === 'checking') return <Loading />;
  return state === 'in' ? <>{children}</> : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Splash />} />
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/onboarding" element={<Personalize />} />
      <Route element={<RequireAuth><AuraShell /></RequireAuth>}>
        <Route path="/dashboard" element={<Home />} />
        <Route path="/chat" element={<S><Chat /></S>} />
        <Route path="/voice" element={<S><Voice /></S>} />
        <Route path="/agents" element={<S><AgentHub /></S>} />
        <Route path="/agents/:id" element={<S><AgentDetail /></S>} />
        <Route path="/collaboration" element={<S><Collaboration /></S>} />
        <Route path="/decisions" element={<S><Decisions /></S>} />
        <Route path="/tasks" element={<S><Tasks /></S>} />
        <Route path="/tasks/board" element={<S><TaskBoard /></S>} />
        <Route path="/calendar" element={<S><Calendar /></S>} />
        <Route path="/shopping" element={<S><Shopping /></S>} />
        <Route path="/travel" element={<S><Travel /></S>} />
        <Route path="/finance" element={<S><Finance /></S>} />
        <Route path="/wellness" element={<S><Wellness /></S>} />
        <Route path="/research" element={<S><Research /></S>} />
        <Route path="/memory" element={<S><Memory /></S>} />
        <Route path="/automation-hub" element={<S><AutomationHub /></S>} />
        <Route path="/automations" element={<S><Automations /></S>} />
        <Route path="/integrations" element={<S><Integrations /></S>} />
        <Route path="/settings" element={<S><Integrations settingsFirst /></S>} />
        <Route path="/analytics" element={<S><Analytics /></S>} />
        <Route path="/pricing" element={<S><Pricing /></S>} />
        <Route path="/qa" element={<S><Qa /></S>} />
        <Route path="/faq" element={<Navigate to="/qa" replace />} />
        <Route path="/thank-you" element={<S><ThankYou /></S>} />
        <Route path="/home" element={<Navigate to="/dashboard" replace />} />
        <Route path="/agents/collaboration" element={<Navigate to="/collaboration" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
      <Route path="/setup" element={<Navigate to="/onboarding" replace />} />
    </Routes>
  );
}
