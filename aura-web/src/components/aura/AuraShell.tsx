import { useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  Home, MessageSquare, Mic, Workflow, Scale, SquareCheck, CalendarDays, ShoppingBag, Plane, Wallet, Heart, Search,
  BrainCircuit, RefreshCcw, LayoutGrid, Settings, Bell, Crown, Menu, ChevronDown, BarChart3, HelpCircle, Network,
  type LucideIcon,
} from 'lucide-react';
import { ToastHost } from '../ui';
import { pageVariants } from '../motion';
import { SearchProvider, useSearchCtx } from '../../state/search';
import { useUser } from '../../state/user';
import PeriodReminder from '../wellness/PeriodReminder';
import MedicineSync from '../wellness/MedicineSync';
import CompanionHost from './CompanionHost';
import ScreenSync from './ScreenSync';

export interface NavItem { to: string; label: string; icon: LucideIcon }

export const navItems: NavItem[] = [
  { to: '/dashboard', label: 'Home', icon: Home },
  { to: '/chat', label: 'AI Chat', icon: MessageSquare },
  { to: '/voice', label: 'Voice', icon: Mic },
  { to: '/agents', label: 'Agents', icon: Workflow },
  { to: '/decisions', label: 'Decisions', icon: Scale },
  { to: '/tasks', label: 'Tasks', icon: SquareCheck },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays },
  { to: '/shopping', label: 'Shopping', icon: ShoppingBag },
  { to: '/travel', label: 'Travel', icon: Plane },
  { to: '/finance', label: 'Finance', icon: Wallet },
  { to: '/wellness', label: 'Wellness', icon: Heart },
  { to: '/research', label: 'Research', icon: Search },
  { to: '/memory', label: 'Memory', icon: BrainCircuit },
  { to: '/automations', label: 'Automations', icon: RefreshCcw },
  { to: '/integrations', label: 'Integrations', icon: LayoutGrid },
  { to: '/settings', label: 'Settings', icon: Settings },
];

const extraItems: NavItem[] = [
  { to: '/collaboration', label: 'Agent Collaboration', icon: Network },
  { to: '/agents/travel', label: 'Travel Agent', icon: Plane },
  { to: '/analytics', label: 'Analytics & Insights', icon: BarChart3 },
  { to: '/pricing', label: 'Plans & Pricing', icon: Crown },
  { to: '/qa', label: 'Q&A / Ask Anything', icon: HelpCircle },
  { to: '/automation-hub', label: 'Automation Hub', icon: RefreshCcw },
  { to: '/tasks/board', label: 'Task Board (agent view)', icon: SquareCheck },
  { to: '/thank-you', label: 'Thank You', icon: Heart },
];

const placeholders: Record<string, string> = {
  '/agents': 'Search agents, tasks, or capabilities...',
  '/tasks': 'Search tasks, ask AURA, or type naturally...',
  '/shopping': 'Search for products, or ask AURA to buy anything...',
  '/travel': 'Search destinations, flights, hotels, or ask AURA to plan a trip...',
  '/finance': 'Search expenses, budgets, investments, or ask AURA anything...',
  '/wellness': 'Search workouts, meditation, meals, health tips, or ask AURA anything...',
  '/research': 'Search papers, topics, tools, or ask AURA anything...',
  '/memory': 'Search your memories, notes, photos, files, or ask AURA anything...',
  '/automations': 'Search automations, workflows, or ask AURA to create one...',
  '/calendar': 'Search events, tasks, or ask AURA anything...',
  '/integrations': 'Search agents, tasks, integrations, or settings...',
  '/settings': 'Search agents, tasks, integrations, or settings...',
  '/analytics': 'Search insights, reports, or ask AURA anything...',
  '/qa': 'Search anything...',
  '/pricing': 'Search plans, features, or ask AURA anything...',
  '/automation-hub': 'Search automations, workflows, or ask AURA to create one...',
};

export function AuraLogo({ size = 32 }: { size?: number }) {
  return (
    <div className="brand">
      <div className="brand-name" style={{ fontSize: size }}>AURA</div>
      <div className="brand-sub">Your AI Co-Pilot</div>
    </div>
  );
}

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function AuraSidebar({ open }: { open: boolean }) {
  const nav = useNavigate();
  const loc = useLocation();
  return (
    <aside className={`sidebar ${open ? 'open' : ''}`} aria-label="Primary">
      <AuraLogo />
      <nav className="nav">
        {navItems.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} end={to !== '/agents' && to !== '/tasks'} className={({ isActive }) => (isActive || (to === '/automations' && loc.pathname === '/automation-hub') ? 'active' : '')}>
            {({ isActive }) => (<>{(isActive || (to === '/automations' && loc.pathname === '/automation-hub')) && <span className="edge" aria-hidden />}<Icon size={19} /> {label}</>)}
          </NavLink>
        ))}
      </nav>
      <div className="pro-card">
        <b><Crown size={17} className="c-amber" style={{ filter: 'drop-shadow(0 0 5px var(--aura-warning))' }} /> AURA PRO</b>
        Unlock advanced agents and automation.
        <button className="btn primary sm block" style={{ marginTop: 10 }} onClick={() => nav('/pricing')}>View plans</button>
      </div>
    </aside>
  );
}

export function AuraTopbar({ onMenu, onPalette }: { onMenu: () => void; onPalette: () => void }) {
  const now = useClock();
  const user = useUser();
  const nav = useNavigate();
  const loc = useLocation();
  const { query: q, setQuery: setQ, local } = useSearchCtx();
  const base = '/' + (loc.pathname.split('/')[1] ?? '');
  useEffect(() => { setQ(''); }, [loc.pathname, setQ]);
  return (
    <header className="topbar">
      <button className="icon-btn menu-btn" aria-label="Open navigation" onClick={onMenu}><Menu size={18} /></button>
      <form className="search" role="search" onSubmit={(e) => { e.preventDefault(); if (!q.trim() || local > 0) return; nav(`/chat?q=${encodeURIComponent(q)}`); setQ(''); }}>
        <Search size={18} />
        <input placeholder={placeholders[base] ?? 'Search agents, tasks, or ask AURA anything...'} value={q} onChange={(e) => setQ(e.target.value)} aria-label={local > 0 ? 'Search this page, or ask AURA' : 'Search or ask AURA'} />
        <button type="button" className="kbd" onClick={onPalette} aria-label="Open command palette">Ctrl + K</button>
      </form>
      <div className="topbar-right">
        <div className="clock">
          {now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
          <br />
          <b>{now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</b>
        </div>
        <button className="icon-btn bare" aria-label="Notifications" onClick={() => nav('/chat?q=' + encodeURIComponent('What needs my attention today?'))}>
          <Bell size={21} />
        </button>
        <button className="user-chip" style={{ background: 'none', border: 0 }} onClick={() => nav('/settings')} aria-label="Account settings">
          <div className="avatar">{user.avatar ? <img src={user.avatar} alt="" referrerPolicy="no-referrer" /> : user.initials}</div>
          <div className="who" style={{ lineHeight: 1.3, textAlign: 'left' }}>
            <div className="t-title">{user.name}</div>
            <div className="t-sub">{user.plan}</div>
          </div>
          <ChevronDown size={16} className="who" />
        </button>
      </div>
    </header>
  );
}

function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const nav = useNavigate();
  const items = useMemo(() => [...navItems, ...extraItems].filter((i) => i.label.toLowerCase().includes(q.toLowerCase())), [q]);
  const go = (to: string) => { nav(to); onClose(); };
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="hud corners palette" role="dialog" aria-modal="true" aria-label="Command palette" onClick={(e) => e.stopPropagation()}>
        <div className="input" style={{ marginBottom: 10 }}>
          <Search size={18} />
          <input
            autoFocus placeholder="Jump to a screen or ask AURA…" value={q}
            onChange={(e) => { setQ(e.target.value); setSel(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setSel((s) => Math.min(s + 1, items.length - 1));
              if (e.key === 'ArrowUp') setSel((s) => Math.max(s - 1, 0));
              if (e.key === 'Enter') go(items[sel]?.to ?? `/chat?q=${encodeURIComponent(q)}`);
              if (e.key === 'Escape') onClose();
            }}
          />
          <span className="kbd">Esc</span>
        </div>
        <div className="list" style={{ maxHeight: 380, overflowY: 'auto' }}>
          {items.map((i, idx) => (
            <div key={i.to} className={`li ${idx === sel ? 'sel' : ''}`} onClick={() => go(i.to)} onMouseEnter={() => setSel(idx)}>
              <i.icon size={18} className="c-cyan" />
              <span className="t-title">{i.label}</span>
              <span className="t-mute mono" style={{ marginLeft: 'auto' }}>{i.to}</span>
            </div>
          ))}
          {items.length === 0 && (
            <div className="li sel" onClick={() => go(`/chat?q=${encodeURIComponent(q)}`)}><MessageSquare size={18} className="c-cyan" /> Ask AURA: “{q}”</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AuraShell() {
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    setOpen(false);
    window.scrollTo({ top: 0 });
  }, [loc.pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(true); }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <SearchProvider>
    <div className="shell">
      <div className="space-bg" />
      <div className="app-frame" aria-hidden><i /><i /><i /><i /></div>
      {open && <div className="scrim" onClick={() => setOpen(false)} />}
      <AuraSidebar open={open} />
      <div className="main">
        <AuraTopbar onMenu={() => setOpen(true)} onPalette={() => setPalette(true)} />
        <main className="content" id="main">
          <AnimatePresence mode="wait">
            <motion.div
              key={loc.pathname}
              variants={pageVariants}
              initial={reduceMotion ? false : 'initial'}
              animate="animate"
              exit="exit"
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      <nav className="bottom-nav" aria-label="Mobile">
        <NavLink to="/dashboard"><Home size={21} /> Home</NavLink>
        <NavLink to="/chat"><MessageSquare size={21} /> Chat</NavLink>
        <NavLink to="/voice" className="voice-fab"><Mic size={24} /> Voice</NavLink>
        <NavLink to="/agents"><Workflow size={21} /> Agents</NavLink>
        <button onClick={() => setOpen(true)}><LayoutGrid size={21} /> More</button>
      </nav>
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
      <PeriodReminder />
      <MedicineSync />
      <CompanionHost />
      <ScreenSync />
      <ToastHost />
    </div>
    </SearchProvider>
  );
}
