import { useEffect, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import {
  Brain, Network, Crosshair, ShieldCheck, SlidersHorizontal, TrendingUp, User, Lock, Eye, EyeOff, Mail, Phone, Zap, Check,
  Briefcase, HeartPulse, BarChart3, Plane, BookOpen, Leaf, ShoppingCart, Users, MoreHorizontal, Clock, Sun,
  Laptop, Moon, Building2, Dumbbell, Utensils, Settings2, ArrowLeft, ArrowRight, Target, Globe, Github, Apple,
} from 'lucide-react';
import { AuraAvatar, AuraLogo, AppLogo, HudInput, IconBox, NeonButton, Wave } from '../components/aura';
import { staggerContainer, staggerItem, EASE } from '../components/motion';
import { signInWithGoogle, signInWithEmail, signUpWithEmail, getSession, AuthNotConfiguredError } from '../services/auth';
import { profileStore } from '../state/stores';

function Stage({ children }: { children: ReactNode }) {
  const reduceMotion = useReducedMotion();
  return (
    <div className="auth-wrap">
      <div className="space-bg" />
      <motion.div initial={reduceMotion ? false : { opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: EASE }}>
        {children}
      </motion.div>
    </div>
  );
}

function PasswordToggle({ show, onToggle }: { show: boolean; onToggle: () => void }) {
  return (
    <button type="button" aria-label={show ? 'Hide password' : 'Show password'} onClick={onToggle}>
      {show ? <EyeOff size={19} /> : <Eye size={19} />}
    </button>
  );
}

function Social({ providers, onError }: { providers: ('google' | 'apple' | 'microsoft' | 'github')[]; onError?: (msg: string) => void }) {
  const handleClick = async (provider: 'google' | 'apple' | 'microsoft' | 'github') => {
    if (provider !== 'google') {
      onError?.(`${provider[0].toUpperCase()}${provider.slice(1)} sign-in isn't wired up yet — use Google or email.`);
      return;
    }
    try {
      await signInWithGoogle();
    } catch (err) {
      onError?.(err instanceof AuthNotConfiguredError ? err.message : 'Google sign-in failed. Please try again.');
    }
  };
  const glyph = {
    google: <span style={{ font: '800 24px Inter', background: 'conic-gradient(from -45deg, #ea4335 0 25%, #fbbc05 0 50%, #34a853 0 75%, #4285f4 0)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>G</span>,
    apple: <Apple size={24} color="#fff" fill="#fff" />,
    microsoft: (
      <span style={{ display: 'grid', gridTemplateColumns: '11px 11px', gap: 2 }}>
        <i style={{ width: 11, height: 11, background: '#f25022' }} /><i style={{ width: 11, height: 11, background: '#7fba00' }} />
        <i style={{ width: 11, height: 11, background: '#00a4ef' }} /><i style={{ width: 11, height: 11, background: '#ffb900' }} />
      </span>
    ),
    github: <Github size={24} color="#fff" />,
  };
  return (
    <>
      <div className="divider">Or continue with</div>
      <div className="social">
        {providers.map((p) => <button key={p} type="button" className="icon-btn" aria-label={`Continue with ${p}`} onClick={() => handleClick(p)}>{glyph[p]}</button>)}
      </div>
    </>
  );
}

/* =================== 1. LANDING / BOOT =================== */

const bootLines = ['AI Systems', 'Agents', 'Memory', 'Interfaces', 'Online'];
const featLeft = [
  { icon: Brain, label: 'Understands your world' },
  { icon: Network, label: 'Multi-agent intelligence' },
  { icon: Crosshair, label: 'Smart decisions' },
];
const featRight = [
  { icon: ShieldCheck, label: 'Privacy by design' },
  { icon: SlidersHorizontal, label: 'Works across apps' },
  { icon: TrendingUp, label: 'Evolves with you' },
];

function FeatTile({ icon: Icon, label }: { icon: typeof Brain; label: string }) {
  return (
    <div className="tile feat-tile">
      <Icon size={34} className="c-cyan" style={{ filter: 'drop-shadow(0 0 8px var(--aura-cyan))' }} strokeWidth={1.4} />
      <div>{label}</div>
    </div>
  );
}

const BRAND = ['A', 'U', 'R', 'A'];
const letterIn = { hidden: { opacity: 0, y: 24, filter: 'blur(6px)' }, show: { opacity: 1, y: 0, filter: 'blur(0px)' } };

/** The saved session survives app restarts, so a signed-in user skips the splash/login screens. */
function useSkipIfSignedIn() {
  const nav = useNavigate();
  useEffect(() => {
    let live = true;
    void getSession().then((s) => { if (live && s) nav('/dashboard', { replace: true }); }).catch(() => undefined);
    return () => { live = false; };
  }, [nav]);
}

export function Splash() {
  const nav = useNavigate();
  useSkipIfSignedIn();
  const reduceMotion = useReducedMotion();
  const [booted, setBooted] = useState(0);
  useEffect(() => {
    if (booted >= bootLines.length) return;
    const t = setTimeout(() => setBooted((b) => b + 1), 380);
    return () => clearTimeout(t);
  }, [booted]);
  const ready = booted >= bootLines.length;

  return (
    <Stage>
      <div className="landing">
        <div className="landing-top">
          <motion.div className="hud corners landing-side" aria-live="polite" initial={reduceMotion ? false : { opacity: 0, x: -24 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.5, ease: EASE }}>
            <div className="hud-label" style={{ marginBottom: 10 }}>Initializing AURA Core…</div>
            {bootLines.map((l, i) => (
              <motion.div
                key={l} className="row between mono" style={{ padding: '3px 0', fontSize: 11.5, textTransform: 'uppercase', color: i < booted ? '#fff' : 'var(--aura-muted)' }}
                animate={i === booted - 1 && !reduceMotion ? { x: [0, 3, 0] } : undefined} transition={{ duration: 0.3 }}
              >
                {l}
                {i < booted ? <Check size={14} className="c-cyan" /> : <span className="spinner" style={{ width: 11, height: 11 }} />}
              </motion.div>
            ))}
            <div style={{ height: 3, borderRadius: 2, background: 'rgba(25,230,255,0.12)', marginTop: 10, overflow: 'hidden' }}>
              <motion.div style={{ height: '100%', background: 'var(--aura-cyan)', boxShadow: '0 0 8px var(--aura-cyan)' }} animate={{ width: `${(booted / bootLines.length) * 100}%` }} transition={{ duration: 0.35, ease: EASE }} />
            </div>
          </motion.div>
          <div style={{ textAlign: 'center', flex: 1 }}>
            <motion.h1
              className="brand-name" style={{ fontSize: 'clamp(64px, 10vw, 118px)', letterSpacing: 12, display: 'inline-flex' }}
              initial={reduceMotion ? false : 'hidden'} animate="show" variants={{ show: { transition: { staggerChildren: 0.12 } } }}
            >
              {BRAND.map((ch, i) => <motion.span key={i} variants={letterIn} transition={{ duration: 0.5, ease: EASE }}>{ch}</motion.span>)}
            </motion.h1>
            <motion.div style={{ letterSpacing: 9, fontSize: 'clamp(15px, 1.8vw, 22px)', marginTop: 12 }} initial={reduceMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.55, duration: 0.5 }}>YOUR AI CO-PILOT</motion.div>
            <motion.div className="t-sub" style={{ letterSpacing: 5, marginTop: 16, fontSize: 12.5 }} initial={reduceMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.7, duration: 0.5 }}>THINK • PLAN • DECIDE • ACT • WITH YOU</motion.div>
            <motion.div style={{ width: 44, height: 2, margin: '16px auto 0', background: 'var(--aura-cyan)', boxShadow: '0 0 10px var(--aura-cyan)' }} initial={reduceMotion ? false : { scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ delay: 0.85, duration: 0.4 }} />
          </div>
          <motion.div className="hud corners landing-side" initial={reduceMotion ? false : { opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.5, ease: EASE }}>
            <div className="hud-label" style={{ marginBottom: 8 }}>User-centric AI ecosystem</div>
            <div style={{ width: 70, height: 70, borderRadius: '50%', margin: '4px auto 8px', background: 'radial-gradient(circle at 35% 35%, #3fa9ff, #07306e 60%, #020a1a)', boxShadow: '0 0 20px rgba(0,175,255,0.6)', display: 'grid', placeItems: 'center' }}><Globe size={40} strokeWidth={1} color="#9fe6ff" /></div>
            {['Understand', 'Reason', 'Coordinate', 'Decide', 'Assist', 'Evolve'].map((x) => (
              <div key={x} className="mono" style={{ padding: '2px 0', color: 'var(--aura-text-2)', fontSize: 11, textTransform: 'uppercase' }}>▫ {x}</div>
            ))}
          </motion.div>
        </div>

        <motion.div className="landing-core" initial={false} animate={ready ? 'show' : 'hidden'} variants={staggerContainer}>
          <motion.div className="landing-feats" variants={staggerItem}>{featLeft.map((f) => <FeatTile key={f.label} {...f} />)}</motion.div>
          <motion.div
            className="landing-entity"
            initial={reduceMotion ? false : { opacity: 0, scale: 0.9 }}
            animate={ready ? { opacity: 1, scale: 1, filter: ['drop-shadow(0 0 0px rgba(0,217,255,0))', 'drop-shadow(0 0 28px rgba(0,217,255,0.55))', 'drop-shadow(0 0 14px rgba(0,217,255,0.3))'] } : { opacity: 0.35, scale: 0.96 }}
            transition={{ duration: 0.8, ease: EASE }}
          >
            <AuraAvatar art="core" size={420} height={520} square state={ready ? 'idle' : 'thinking'} rings={false} />
            <div className="landing-beam" aria-hidden />
            <div className="landing-pad" aria-hidden />
          </motion.div>
          <motion.div className="landing-feats" variants={staggerItem}>{featRight.map((f) => <FeatTile key={f.label} {...f} />)}</motion.div>
        </motion.div>

        <div style={{ textAlign: 'center' }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(22px, 3vw, 34px)', letterSpacing: 3, fontWeight: 700 }}>MORE THAN AN ASSISTANT</h2>
          <p className="t-sub" style={{ letterSpacing: 3, marginTop: 10, fontSize: 13, lineHeight: 1.7 }}>A PERSONAL AI ECOSYSTEM THAT UNDERSTANDS,<br />PLANS, AND ACTS WITH YOU.</p>
        </div>
        <motion.div animate={ready && !reduceMotion ? { scale: [1, 1.05, 1] } : { scale: 1 }} transition={{ duration: 0.5, ease: EASE }}>
          <NeonButton variant="primary" size="lg" hex display chevron disabled={!ready} style={{ minWidth: 'min(420px, 90vw)', height: 64, fontSize: 20 }} onClick={() => nav('/signup')}>
            {ready ? 'GET STARTED' : 'INITIALIZING…'}
          </NeonButton>
        </motion.div>
        <div className="stack" style={{ alignItems: 'center', gap: 10 }}>
          <div className="row" aria-hidden>{[0, 1, 2, 3, 4].map((i) => <span key={i} className={`dot ${i < booted ? 'cyan' : 'off'}`} style={{ width: 10, height: 10, transition: 'background 0.3s' }} />)}</div>
          <span className="t-sub" style={{ letterSpacing: 4, fontSize: 11 }}>YOUR JOURNEY BEGINS</span>
          <Link to="/login" className="t-sub" style={{ marginTop: 4 }}>Already have an account? <span className="c-cyan">Log in</span></Link>
        </div>
      </div>
    </Stage>
  );
}

/* =================== 2. LOGIN =================== */

export function Login() {
  const nav = useNavigate();
  useSkipIfSignedIn();
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [show, setShow] = useState(false);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !pw) return setErr('Enter your username/email and password.');
    setErr('');
    setBusy(true);
    try {
      await signInWithEmail(email, pw);
      nav('/dashboard');
    } catch (err) {
      setErr(err instanceof AuthNotConfiguredError ? err.message : err instanceof Error ? err.message : 'Login failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stage>
      <div className="login-stage">
        <img src="/aura/login-robot.jpg" alt="" />
        <form className="auth-card" onSubmit={submit} noValidate>
          <span className="edge-light top" aria-hidden />
          <span className="edge-light bottom" aria-hidden />
          <div style={{ textAlign: 'center' }}>
            <svg width="44" height="36" viewBox="0 0 44 36" aria-hidden style={{ filter: 'drop-shadow(0 0 8px var(--aura-primary))' }}>
              <path d="M3 3 H41 L22 33 Z" fill="none" stroke="#00afff" strokeWidth="3" strokeLinejoin="round" /><path d="M13 9 H31 L22 23 Z" fill="none" stroke="#19e6ff" strokeWidth="2" />
            </svg>
            <h1 className="auth-title" style={{ marginTop: 6 }}>WELCOME BACK</h1>
            <p className="t-sub" style={{ fontSize: 15, marginTop: 4 }}>Log in to continue your journey</p>
          </div>
          <HudInput icon={User} placeholder="Username or Email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" aria-label="Username or Email" />
          <HudInput icon={Lock} placeholder="Password" type={show ? 'text' : 'password'} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" aria-label="Password" trailing={<PasswordToggle show={show} onToggle={() => setShow((s) => !s)} />} />
          <div className="row between">
            <label className="row t-sub" style={{ cursor: 'pointer', fontSize: 13.5 }}><input type="checkbox" className="check" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember me</label>
            <a className="c-blue" style={{ fontSize: 13.5 }} href="#forgot">Forgot Password?</a>
          </div>
          {err && <div className="tag red" role="alert" style={{ padding: 8 }}>{err}</div>}
          <NeonButton variant="primary" size="lg" hex display chevron block disabled={busy} type="submit">{busy ? <span className="spinner" /> : 'LOGIN'}</NeonButton>
          <Social providers={['google', 'microsoft', 'github']} onError={setErr} />
          <p className="t-sub" style={{ textAlign: 'center', fontSize: 14 }}>Don't have an account? <Link to="/signup" className="c-blue" style={{ fontWeight: 600 }}>Sign Up</Link></p>
        </form>
      </div>
    </Stage>
  );
}

/* =================== 3. SIGN UP =================== */

export function Signup() {
  const nav = useNavigate();
  const [f, setF] = useState({ name: '', email: '', phone: '', pw: '', confirm: '' });
  const [show, setShow] = useState({ pw: false, confirm: false });
  const [agree, setAgree] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!f.name.trim() || !/\S+@\S+\.\S+/.test(f.email)) return setErr('Enter your full name and a valid email.');
    if (f.pw.length < 8) return setErr('Password must be at least 8 characters.');
    if (f.pw !== f.confirm) return setErr('Passwords do not match.');
    if (!agree) return setErr('Please accept the Terms of Service and Privacy Policy.');
    setErr('');
    setBusy(true);
    try {
      await signUpWithEmail(f.email, f.pw, f.name);
      nav('/onboarding');
    } catch (err_) {
      setErr(err_ instanceof AuthNotConfiguredError ? err_.message : err_ instanceof Error ? err_.message : 'Sign up failed.');
    } finally {
      setBusy(false);
    }
  };
  const feats = [
    { icon: Brain, t: 'Personalized Intelligence', s: 'Learns your preferences' },
    { icon: Network, t: 'Multi-Agent System', s: 'Works across all your needs' },
    { icon: Zap, t: 'Smart Decisions', s: 'Plans, compares and suggests' },
    { icon: ShieldCheck, t: 'Complete Privacy', s: 'You are always in control' },
  ];
  return (
    <Stage>
      <div style={{ width: 'min(1180px, 100%)' }} className="stack">
        <div className="row between wrap">
          <AuraLogo size={30} />
          <span className="t-sub" style={{ fontSize: 15 }}>Already have an account? <Link to="/login" className="c-blue" style={{ fontWeight: 600, fontSize: 17 }}>Login</Link></span>
        </div>
        <div className="auth-grid" style={{ alignItems: 'end' }}>
          <div className="auth-side" style={{ position: 'relative', minHeight: 660 }}>
            <img src="/aura/signup-android.jpg" alt="" style={{ position: 'absolute', left: 0, right: 0, top: 0, width: '100%', height: 'calc(100% - 110px)', objectFit: 'cover', objectPosition: 'top', maskImage: 'linear-gradient(180deg, #000 72%, transparent)', WebkitMaskImage: 'linear-gradient(180deg, #000 72%, transparent)' }} />
            <div className="hud corners" style={{ position: 'absolute', left: 0, bottom: 0, width: 'min(380px, 100%)' }}>
              <div className="hud-label" style={{ fontSize: 13, letterSpacing: 2.5 }}>More than an assistant</div>
              <div className="hud-label" style={{ color: 'var(--aura-text-2)', letterSpacing: 1.5, marginTop: 6, fontSize: 10.5 }}>AURA understands, plans and acts with you.</div>
              <div style={{ width: 30, height: 2, background: 'var(--aura-cyan)', margin: '10px 0' }} />
              <div className="list">
                {feats.map((i) => (
                  <div className="li" key={i.t}><IconBox icon={i.icon} size="sm" round /><div><div className="t-title">{i.t}</div><div className="t-sub">{i.s}</div></div></div>
                ))}
              </div>
            </div>
          </div>
          <div className="stack">
            <div>
              <h1 style={{ fontSize: 34 }}>Create Your Account</h1>
              <p className="t-sub" style={{ fontSize: 17, marginTop: 4 }}>Begin your journey with AURA</p>
            </div>
            <form className="auth-card stack" onSubmit={submit} noValidate style={{ gap: 14, padding: 26 }}>
              <HudInput label="Full Name" icon={User} placeholder="Enter your full name" value={f.name} onChange={set('name')} autoComplete="name" />
              <HudInput label="Email" icon={Mail} type="email" placeholder="Enter your email address" value={f.email} onChange={set('email')} autoComplete="email" />
              <div className="field">
                <label htmlFor="su-phone"><Phone size={14} /> Phone Number</label>
                <div className="input">
                  <Phone size={19} />
                  <select aria-label="Country code" style={{ flex: '0 0 auto', width: 64 }}><option>+91</option><option>+1</option><option>+44</option></select>
                  <span className="sep" />
                  <input id="su-phone" type="tel" placeholder="Enter your phone number" value={f.phone} onChange={set('phone')} autoComplete="tel" />
                </div>
              </div>
              <HudInput label="Password" icon={Lock} type={show.pw ? 'text' : 'password'} placeholder="Create a strong password" value={f.pw} onChange={set('pw')} autoComplete="new-password" trailing={<PasswordToggle show={show.pw} onToggle={() => setShow((s) => ({ ...s, pw: !s.pw }))} />} />
              <HudInput label="Confirm Password" icon={Lock} type={show.confirm ? 'text' : 'password'} placeholder="Confirm your password" value={f.confirm} onChange={set('confirm')} autoComplete="new-password" trailing={<PasswordToggle show={show.confirm} onToggle={() => setShow((s) => ({ ...s, confirm: !s.confirm }))} />} />
              <label className="row t-sub" style={{ cursor: 'pointer', fontSize: 13.5 }}>
                <input type="checkbox" className="check" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                <span>I agree to the <a className="c-blue" href="#terms">Terms of Service</a> and <a className="c-blue" href="#privacy">Privacy Policy</a></span>
              </label>
              {err && <div className="tag red" style={{ padding: 8, whiteSpace: 'normal' }} role="alert">{err}</div>}
              <NeonButton variant="primary" size="lg" hex display chevron block type="submit" disabled={busy}>{busy ? <span className="spinner" /> : 'SIGN UP'}</NeonButton>
              <Social providers={['google', 'apple', 'microsoft']} onError={setErr} />
            </form>
          </div>
        </div>
      </div>
    </Stage>
  );
}

/* =================== 4. ONBOARDING / PERSONALIZATION =================== */

const goals: { label: string; icon: typeof Brain }[] = [
  { label: 'Career Growth', icon: Briefcase },
  { label: 'Health & Fitness', icon: HeartPulse },
  { label: 'Financial Stability', icon: BarChart3 },
  { label: 'Travel & Explore', icon: Plane },
  { label: 'Learn New Skills', icon: BookOpen },
  { label: 'Better Productivity', icon: Zap },
  { label: 'Personal Wellbeing', icon: Leaf },
  { label: 'Shopping & Essentials', icon: ShoppingCart },
  { label: 'Social & Relationships', icon: Users },
  { label: 'Other (Custom)', icon: MoreHorizontal },
];

const routine_: { icon: typeof Brain; label: string; opts: string[] }[] = [
  { icon: Sun, label: 'Wake up time', opts: ['07:00 AM', '06:00 AM', '08:00 AM'] },
  { icon: Laptop, label: 'Work / Study hours', opts: ['09:00 AM – 06:00 PM', '10:00 AM – 07:00 PM', 'Flexible'] },
  { icon: Moon, label: 'Sleep time', opts: ['11:30 PM', '10:30 PM', '12:30 AM'] },
  { icon: Building2, label: 'Preferred work mode', opts: ['Office', 'Remote', 'Hybrid'] },
  { icon: Dumbbell, label: 'Exercise / Wellness', opts: ['3-4 times a week', 'Daily', 'Rarely'] },
  { icon: Utensils, label: 'Food preference', opts: ['Mostly Vegetarian', 'Vegetarian', 'Non-Vegetarian', 'Vegan'] },
];

const prefs: [string, string[]][] = [
  ['Gender', ['Prefer not to say', 'Female', 'Male', 'Non-binary']],
  ['Communication Style', ['Friendly & Professional', 'Concise', 'Detailed']],
  ['Response Detail Level', ['Balanced', 'Brief', 'In-depth']],
  ['Decision Style', ['Suggest with Explanation', 'Suggest Only', 'Prepare for Approval']],
  ['Language', ['English', 'Hindi', 'Marathi']],
];

export function Personalize() {
  const nav = useNavigate();
  const [sel, setSel] = useState<string[]>(['Career Growth', 'Financial Stability', 'Better Productivity']);
  const [routineVals, setRoutineVals] = useState<Record<string, string>>({});
  const [prefVals, setPrefVals] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const finish = async () => {
    setSaving(true);
    try {
      const routine = Object.fromEntries(routine_.map((r) => [r.label, routineVals[r.label] ?? r.opts[0]]));
      const preferences = Object.fromEntries(prefs.map(([label, opts]) => [label, prefVals[label] ?? opts[0]]));
      profileStore.set([{ id: 'me', goals: sel, routine, preferences }]);
    } finally {
      setSaving(false);
      nav('/dashboard');
    }
  };
  const toggleGoal = (g: string) => setSel((s) => (s.includes(g) ? s.filter((x) => x !== g) : [...s, g]));

  return (
    <Stage>
      <div style={{ width: 'min(1180px, 100%)' }} className="stack">
        <div className="row between wrap" style={{ gap: 16 }}>
          <AuraLogo size={28} />
          <div className="stepper" aria-label="Setup progress, step 4 of 4">
            {['Account', 'Profile', 'Preferences', 'AI Setup'].map((s, i) => (
              <div key={s} className="row" style={{ gap: 0 }}>
                <div className={`step ${i < 3 ? 'done' : 'cur'}`}><b>{i + 1}</b><span className="hide-sm">{s}</span></div>
                {i < 3 && <div className="step-line" />}
              </div>
            ))}
          </div>
          <NeonButton size="sm" onClick={() => nav('/dashboard')}>Skip Setup <ArrowRight size={14} /></NeonButton>
        </div>

        <div className="hero" style={{ minHeight: 330, alignItems: 'stretch' }}>
          <img className="hero-bg" src="/aura/onboard-android.jpg" alt="" style={{ width: '62%' }} />
          <div style={{ flex: 1, maxWidth: 480, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <div className="hud-label" style={{ color: 'var(--aura-text-2)', fontSize: 12, letterSpacing: 3 }}>Step 4 of 4</div>
            <h1 style={{ fontSize: 'clamp(32px, 3.6vw, 48px)', marginTop: 6 }}>Let's Personalize<br /><span className="grad-cyan">AURA</span> for You</h1>
            <p className="lead">Tell AURA about your preferences, goals and daily routine so it can understand you better and make smarter decisions.</p>
            <div className="tile row" style={{ marginTop: 18, maxWidth: 380, padding: '14px 16px' }}>
              <span style={{ flex: 1, fontSize: 15 }}>“The more you share,<br />the smarter I become.”</span>
              <Wave bars={12} idle />
            </div>
          </div>
        </div>

        <div className="hud corners">
          <div className="hud-head">
            <IconBox icon={Target} round />
            <h3 style={{ fontSize: 19 }}>What are your key goals? <span className="t-sub" style={{ fontWeight: 400 }}>(Select multiple)</span></h3>
            <span className="t-sub hide-sm" style={{ marginLeft: 'auto' }}>You can change this anytime</span>
          </div>
          <div className="grid g5" style={{ gap: 12 }}>
            {goals.map((g) => {
              const on = sel.includes(g.label);
              return (
                <button key={g.label} className={`chip ${on ? 'active' : ''}`} style={{ padding: '16px 14px', justifyContent: 'flex-start', gap: 12, fontSize: 13.5, color: '#fff' }} onClick={() => toggleGoal(g.label)} aria-pressed={on}>
                  <g.icon size={22} className="c-blue" /> <span style={{ whiteSpace: 'normal', textAlign: 'left' }}>{g.label}</span>
                  {on && <span className="goal-check"><Check size={13} /></span>}
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid g2">
          <div className="stack">
            <div className="hud corners">
              <div className="hud-head"><IconBox icon={Clock} round /><div><h3>Your Daily Routine</h3><div className="sub">Help AURA understand your typical day</div></div></div>
              <div className="list">
                {routine_.map((r) => (
                  <div className="li" key={r.label}>
                    <r.icon size={20} className="c-cyan" />
                    <label className="grow" htmlFor={`rt-${r.label}`}>{r.label}</label>
                    <select id={`rt-${r.label}`} className="select" style={{ minWidth: 150 }} value={routineVals[r.label] ?? r.opts[0]} onChange={(e) => setRoutineVals((v) => ({ ...v, [r.label]: e.target.value }))}>{r.opts.map((o) => <option key={o}>{o}</option>)}</select>
                  </div>
                ))}
              </div>
            </div>
            <div className="hud corners">
              <div className="hud-head"><IconBox icon={Settings2} round /><div><h3>Personal Preferences</h3><div className="sub">Customize how AURA works with you</div></div></div>
              <div className="list">
                {prefs.map(([label, opts]) => (
                  <div className="li" key={label}>
                    <label className="grow" htmlFor={`pf-${label}`}>{label}</label>
                    <select id={`pf-${label}`} className="select" style={{ minWidth: 'min(220px, 50vw)' }} value={prefVals[label] ?? opts[0]} onChange={(e) => setPrefVals((v) => ({ ...v, [label]: e.target.value }))}>{opts.map((o) => <option key={o}>{o}</option>)}</select>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="stack">
            <div className="hud corners">
              <div className="hud-head"><IconBox icon={Network} tone="blue" round /><div><h3>Connect Your Apps</h3><div className="sub">Link Google so AURA can see your real calendar.</div></div></div>
              <div className="list">
                <div className="li">
                  <AppLogo name="Google Calendar" size={36} />
                  <div className="grow"><div className="t-title">Google Calendar</div><div className="t-sub">Sync meetings and events</div></div>
                  <button type="button" className="btn sm" onClick={() => void signInWithGoogle().catch(() => undefined)}>Connect</button>
                </div>
              </div>
              <p className="t-mute" style={{ marginTop: 8 }}>You can connect or revoke access any time in Integrations. Nothing is shared until you connect.</p>
            </div>
          </div>
        </div>

        <div className="row between wrap" style={{ gap: 14 }}>
          <NeonButton size="lg" onClick={() => nav('/signup')}><ArrowLeft size={18} /> Back</NeonButton>
          <div className="row hide-sm" aria-hidden><span className="dot off" /><span className="dot off" /><span className="dot cyan" /></div>
          <NeonButton variant="primary" size="lg" hex chevron onClick={() => void finish()} disabled={saving} style={{ minWidth: 'min(380px, 100%)' }}>Continue to Command Center</NeonButton>
        </div>
      </div>
    </Stage>
  );
}
