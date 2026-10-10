import { Capacitor } from '@capacitor/core';
import { createStore } from '../state/store';
import { budgetsStore, commitmentsStore, companionPrefsStore, dayLogsStore, doseLogsStore, eventsStore, goalsStore, mealsStore, medicinesStore, moneyPrefsStore, tasksStore, transactionsStore } from '../state/stores';
import { uid } from '../state/store';
import { TARGETS, type DayLog } from '../data/wellness';
import { dosesForDate, doseState, isoDate, fmtTime, type Dose } from '../data/medicine';
import { aura, type ConverseAction } from './aura';
import { browserVoice } from './voice';
import { speakNow, stopSpeakingNow } from './speech';
import { recordDose, parseDoseId } from './medicine';
import { orderDestination } from './orderFlow';
import { shopAssist } from './shopping';
import { startQuickCart } from './extension';
import { AuraPhone } from '../native/phone';
import { AuraScreen } from '../native/screen';
import { moneyByVoice } from './moneyVoice';

/**
 * AURA's voice companion — the part that behaves like a nurse + assistant + listener.
 *  - Simple things ("I drank two glasses of water", "I took my tablet", "open WhatsApp") are understood on the phone,
 *    instantly, with no model call.
 *  - Everything else goes to one fast model call (see ai-service/app/routers/companion.py) that may ask the app to do things.
 *  - It also speaks first: check-ins about water, meals, medicine, sleep and mood, then listens for the answer.
 * It only does what the app itself can do. It does not read messages or contacts and never pays for anything.
 */

export interface CompanionPrefs {
  id: string;
  enabled: boolean;
  quietStart: string; // "22:00"
  quietEnd: string; // "07:00"
  /** ISO time until which check-ins are paused ("mute for an hour"). */
  pausedUntil?: string;
  /** Last time each kind of check-in was spoken (ISO), so restarts don't repeat them. */
  lastAsked: Record<string, string>;
}
export const DEFAULT_COMPANION_PREFS: CompanionPrefs = { id: 'prefs', enabled: true, quietStart: '22:00', quietEnd: '07:00', lastAsked: {} };

export type Phase = 'idle' | 'speaking' | 'listening' | 'thinking';
/** prompt: a check-in question AURA asked on its own; it waits for the user to tap the orb to answer (it never listens by itself). */
export const companionStore = createStore<{ phase: Phase; heard: string; said: string; error: string; prompt: string }>({ phase: 'idle', heard: '', said: '', error: '', prompt: '' });
const setState = (p: Partial<ReturnType<typeof companionStore.get>>) => companionStore.set((s) => ({ ...s, ...p }));

let userName = 'there';
export const setCompanionName = (full: string) => { userName = full.trim().split(/\s+/)[0] || 'there'; };

export const getPrefs = (): CompanionPrefs => ({ ...DEFAULT_COMPANION_PREFS, ...companionPrefsStore.get()[0] });
export const savePrefs = (patch: Partial<CompanionPrefs>) => companionPrefsStore.set([{ ...getPrefs(), ...patch, id: 'prefs' }]);

type Nav = (path: string, opts?: { state?: unknown }) => void;
interface Pending { kind: 'medicine' | 'water' | 'meal' | 'mealdish' | 'sleep' | 'mood'; question: string; data?: Record<string, unknown>; until: number }
let pending: Pending | null = null;
const history: { role: 'user' | 'aura'; text: string }[] = [];
const snoozedDoses = new Map<string, number>();
const doseAsks = new Map<string, number>();
const remember = (role: 'user' | 'aura', text: string) => { history.push({ role, text: text.slice(0, 500) }); if (history.length > 8) history.shift(); };

/* ---------- what the user's day looks like (also sent to the model) ---------- */

const today = () => isoDate(new Date());
const todayLog = (): DayLog | undefined => dayLogsStore.get().find((l) => l.date === today());

function upsertTodayLog(patch: Partial<DayLog>) {
  const t = today();
  dayLogsStore.set((ls) => (ls.some((l) => l.date === t) ? ls.map((l) => (l.date === t ? { ...l, ...patch } : l)) : [...ls, { id: `log_${t}`, date: t, ...patch }]));
}

function addWater(glasses: number): number {
  const total = Math.min(30, (todayLog()?.water ?? 0) + Math.max(1, Math.round(glasses)));
  upsertTodayLog({ water: total });
  return total;
}

function logMeal(name: string, dish?: string) {
  const t = today();
  const existing = mealsStore.get().find((m) => m.date === t && m.name === name);
  if (existing) mealsStore.set((ms) => ms.map((m) => (m.id === existing.id ? { ...m, eaten: true, dish: dish || m.dish } : m)));
  else mealsStore.set((ms) => [...ms, { id: uid('ml'), name, dish: dish || name, kcal: 0, eaten: true, date: t }]);
}

const unresolvedDoses = (now: number): { dose: Dose; state: string }[] => {
  const logged = new Map(doseLogsStore.get().map((l) => [l.id, l]));
  return dosesForDate(medicinesStore.get(), today()).map((d) => ({ dose: d, state: doseState(d, logged.get(d.id), now) })).filter((x) => x.state === 'due' || x.state === 'missed' || x.state === 'upcoming');
};

/** Marks the doses the user is most likely talking about as taken. Returns their names, or [] if no dose is due. */
function markMedicineTaken(nameHint: string | undefined, now = Date.now()): string[] {
  const hint = nameHint?.toLowerCase();
  const fits = (d: Dose) => !hint || d.med.name.toLowerCase().includes(hint) || hint.includes(d.med.name.toLowerCase());
  const open = unresolvedDoses(now).filter((x) => fits(x.dose));
  let pick = open.filter((x) => x.state === 'due' || (x.state === 'upcoming' && x.dose.at - now <= 30 * 60_000));
  if (!pick.length) { const missed = open.filter((x) => x.state === 'missed'); pick = missed.length ? [missed[missed.length - 1]] : []; }
  pick.forEach((x) => recordDose(x.dose.med.id, x.dose.date, x.dose.time, 'taken', now));
  return [...new Set(pick.map((x) => x.dose.med.name))];
}

/**
 * A short sentence about the user's phone habits (most-used apps and when, topics they engage with), from what the phone
 * learned while the user had learning turned on. It names no people and quotes no messages. Cached: reading it must
 * never delay a spoken reply, so a turn uses the last value and starts a refresh for the next one.
 */
let habits = '';
let habitsAt = 0;
function refreshHabits(): void {
  if (!Capacitor.isNativePlatform() || Date.now() - habitsAt < 10 * 60_000) return;
  habitsAt = Date.now();
  AuraScreen.learned().then((l) => { habits = l.habits ?? ''; }).catch(() => { habits = ''; });
}

export function buildCompanionContext(): string {
  refreshHabits();
  const now = Date.now();
  const d = new Date(now);
  const log = todayLog();
  const meds = dosesForDate(medicinesStore.get(), today());
  const logged = new Map(doseLogsStore.get().map((l) => [l.id, l]));
  return JSON.stringify({
    now: `${d.toLocaleDateString('en-IN', { weekday: 'long' })} ${fmtTime(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`)}`,
    name: userName,
    waterGlasses: `${log?.water ?? 0} of ${TARGETS.water}`,
    mealsToday: mealsStore.get().filter((m) => m.date === today()).map((m) => `${m.name}: ${m.dish}${m.eaten ? '' : ' (not eaten)'}`),
    sleepHours: log?.sleepHours, mood: log?.mood, steps: log?.steps,
    medicinesToday: meds.map((m) => `${m.med.name} ${m.med.dose} at ${fmtTime(m.time)}: ${doseState(m, logged.get(m.id), now)}`),
    tasksOpen: tasksStore.get().filter((t) => !t.done).slice(0, 5).map((t) => t.title),
    eventsToday: eventsStore.get().filter((e) => e.date === today()).slice(0, 5).map((e) => `${e.title} ${e.start ?? ''}`),
    habits: habits || undefined,
  });
}

/* ---------- understanding what was said ---------- */

const NUM: Record<string, number> = { a: 1, an: 1, one: 1, ek: 1, two: 2, do: 2, three: 3, teen: 3, four: 4, char: 4, five: 5, paanch: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const numberIn = (t: string): number | undefined => {
  const d = t.match(/\d+(?:\.\d+)?/);
  if (d) return Number(d[0]);
  for (const w of t.split(/\W+/)) if (NUM[w] !== undefined) return NUM[w];
  return undefined;
};
const YES = /^(yes|yeah|yep|yup|sure|done|ok(?:ay)?|i did|did|already|of course|haan|ha|han|ho gaya|kar liya|le liya|piya|khaa liya|i have|i took it|took it)\b/i;
const NO = /^(no|nope|nah|not yet|not really|later|nahi|abhi nahi|i didn'?t|haven'?t)\b/i;
const MOODS: [RegExp, string][] = [
  [/\b(great|happy|excited|fantastic|awesome|amazing)\b/, 'Great'], [/\b(good|fine|well|nice)\b/, 'Good'], [/\b(okay|ok|alright|so-?so|average)\b/, 'Okay'],
  [/\b(low|sad|down|tired|lonely|depressed|exhausted|thaka)\w*/, 'Low'], [/\b(stressed|anxious|worried|tense|overwhelmed|nervous)\b/, 'Stressed'],
];
const moodIn = (t: string) => MOODS.find(([re]) => re.test(t))?.[1];
const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

interface Handled { say?: string; passToModel?: boolean }

/* ---------- shopping by voice ---------- */

/** The shopping assistant asked something ("Which one should I use?") and is waiting for the answer. */
let shoppingPending = false;

/** Text as it should be spoken: "₹67" -> "67 rupees", no dates in brackets, no dashes. */
const speakable = (text: string) => text
  .replace(/₹\s?([\d,]+(?:\.\d+)?)/g, '$1 rupees')
  .replace(/\s*\(\d{4}-\d{2}-\d{2}\)/g, '')
  .replace(/\s+—\s+/g, ', ')
  .replace(/\s+x(\d+)\b/g, ' times $1');

/**
 * One spoken turn with the shopping assistant: it understands the order against the user's history, compares what
 * it really knows, asks before a new purchase, and starts the cart only once decided. null = not a shopping turn.
 */
async function shopByVoice(text: string): Promise<string | null> {
  try {
    const r = await shopAssist(text);
    if (!r.handled) { shoppingPending = false; return null; }
    shoppingPending = !!r.pending;
    if (r.cartOrder?.items?.length) void startQuickCart({ ...r.cartOrder });
    return speakable(r.say ?? '');
  } catch {
    shoppingPending = false;
    return null;
  }
}

function answerPending(t: string, p: Pending, now: number): Handled | null {
  const yes = YES.test(t);
  const no = NO.test(t);
  switch (p.kind) {
    case 'medicine': {
      const ids = (p.data?.doseIds as string[]) ?? [];
      if (yes) {
        const names = ids.map((id) => parseDoseId(id)).filter((x): x is NonNullable<typeof x> => !!x);
        names.forEach((x) => recordDose(x.medId, x.date, x.time, 'taken', now));
        return { say: 'Good. I\'ve marked it as taken. Keep it up!' };
      }
      if (no) { ids.forEach((id) => snoozedDoses.set(id, now + 15 * 60_000)); return { say: 'Okay. Please take it soon — I\'ll remind you again in a few minutes.' }; }
      return null;
    }
    case 'water': {
      const n = numberIn(t);
      if (yes || n) { const total = addWater(yes && !n ? 1 : (n ?? 1)); return { say: total >= TARGETS.water ? `Wonderful — that's ${total} glasses, you've hit your water goal today!` : `Nice. That's ${total} of ${TARGETS.water} glasses so far.` }; }
      if (no) return { say: 'Alright. Try to have a glass in the next little while — your body will thank you.' };
      return null;
    }
    case 'meal': {
      const meal = String(p.data?.meal ?? 'Lunch');
      if (yes) { logMeal(meal); pending = { kind: 'mealdish', question: 'What did you have?', data: { meal }, until: now + 120_000 }; return { say: 'Good. What did you have?' }; }
      if (no) return { say: `Please try to eat something soon — even something light. Should I help you order some food?` };
      return null;
    }
    case 'mealdish': { logMeal(String(p.data?.meal ?? 'Lunch'), t.slice(0, 80)); return { say: 'Sounds good. Thanks for telling me.' }; }
    case 'sleep': {
      const h = numberIn(t);
      if (h && h > 0 && h <= 14) { upsertTodayLog({ sleepHours: h }); return { say: h < 6 ? `${h} hours is a bit short. Try to wind down earlier tonight and I'll remind you.` : h >= 7 ? `${h} hours — that's healthy. Great.` : `${h} hours. A little more rest tonight would help.` }; }
      return { passToModel: true };
    }
    case 'mood': {
      const m = moodIn(t);
      if (m) { upsertTodayLog({ mood: m }); return m === 'Great' || m === 'Good' ? { say: 'I\'m glad to hear that.' } : { passToModel: true }; }
      return { passToModel: true };
    }
  }
}

/** Things that need no model: logging water/meals/medicine, opening apps, dialing, ordering, quieting down. */
async function understandLocally(raw: string, nav: Nav, now: number): Promise<Handled | null> {
  const t = raw.toLowerCase().trim().replace(/[.!?]+$/, '');

  if (/^(stop|quiet|be quiet|shut up|cancel|never ?mind|chup|ruko)$/.test(t)) { stopSpeakingNow(); return { say: '' }; }
  if (/(mute|pause|stop).*(check.?ins?|reminders?|talking|asking)/.test(t) || /^(leave me alone|not now)$/.test(t)) {
    const hours = /(\d+)\s*hours?/.exec(t)?.[1];
    savePrefs({ pausedUntil: new Date(now + (hours ? Number(hours) : 1) * 3_600_000).toISOString() });
    return { say: `Okay, I'll stay quiet for ${hours ?? 'one'} hour${hours && Number(hours) > 1 ? 's' : ''}. Tap me any time you want to talk.` };
  }
  if (/(turn|switch) (off|on) (the )?(companion|check.?ins?)/.test(t)) {
    const on = /on/.test(t.split('(')[0]) && !/\boff\b/.test(t);
    savePrefs({ enabled: on, pausedUntil: undefined });
    return { say: on ? 'Check-ins are back on.' : 'Okay, I\'ve turned check-ins off. You can turn them back on from my panel.' };
  }

  const moneyAnswer = moneyByVoice(t, {
    now: new Date(), transactions: transactionsStore.get(), commitments: commitmentsStore.get(), goals: goalsStore.get(), budgets: budgetsStore.get(), prefs: moneyPrefsStore.get()[0],
  });
  if (moneyAnswer !== null) return { say: moneyAnswer };

  const open = t.match(/^(?:please )?(?:open|launch|kholo|chalu karo)\s+(?:the )?(.+?)(?: app)?$/);
  if (open && !/^(my |the )?(tasks?|calendar|wellness|shopping|chat|dashboard)\b/.test(open[1])) {
    return { say: await openApp(open[1]) };
  }
  const dial = t.match(/^(?:call|dial|phone)\s+([\d\s+-]{5,})$/);
  if (dial) {
    if (!Capacitor.isNativePlatform()) return { say: 'I can open the dialer only in the Android app.' };
    await AuraPhone.dial({ number: dial[1] }).catch(() => undefined);
    return { say: 'Opening the dialer. Press call when you\'re ready.' };
  }

  const dest = orderDestination(raw);
  if (dest === '/shopping') {
    // by voice, the whole exchange stays spoken: the assistant asks, the user answers, the cart starts
    const spoken = await shopByVoice(raw);
    if (spoken !== null) return { say: spoken };
  }
  if (dest) { nav(dest, { state: { ask: raw } }); return { say: dest === '/shopping' ? 'Let me set that up in shopping.' : 'Let me open your medicines.' }; }

  if (/\b(drank|drink|had|finished|downed|piya|pee)\b/.test(t) && /\b(glass(?:es)?|cups?|bottles?|water|paani|pani)\b/.test(t)) {
    const n = numberIn(t) ?? 1;
    const total = addWater(/bottle/.test(t) ? n * 4 : n);
    return { say: total >= TARGETS.water ? `Lovely — ${total} glasses. You've reached your water goal today!` : `Nice. That's ${total} of ${TARGETS.water} glasses today.` };
  }
  const meal = MEALS.find((m) => new RegExp(`\\b${m}\\b`).test(t));
  if (meal && /\b(had|ate|eaten|finished|khaa)\w*\b/.test(t)) {
    const dish = t.match(/\b(?:had|ate|eaten)\s+(.+?)\s+(?:for|at)\s+(?:my\s+)?\w+$/)?.[1];
    logMeal(cap(meal), dish);
    return { say: `Got it — ${meal} noted${dish ? ` (${dish})` : ''}. Thanks for telling me.` };
  }
  const namedMed = medicinesStore.get().map((m) => m.name.toLowerCase()).find((n) => t.includes(n));
  const tookWord = /\b(took|taken|swallowed|le li|had)\b/.test(t);
  const medWord = /\b(medicine|medicines|meds?|medication|tablets?|pills?|capsules?|dose|syrup)\b/.test(t);
  if (tookWord && (medWord || namedMed)) {
    const done = markMedicineTaken(namedMed, now);
    return { say: done.length ? `Good. I've marked ${done.join(' and ')} as taken.` : 'I don\'t see a dose due right now, so I haven\'t logged anything. Which medicine did you take?' };
  }
  const mood = t.match(/\bi(?: am|'m| feel|’m)\s+(.*)/)?.[1];
  if (mood && moodIn(mood)) upsertTodayLog({ mood: moodIn(mood) }); // logged; the model still answers kindly
  return null;
}

/* ---------- phone abilities ---------- */

async function openApp(name: string): Promise<string> {
  if (!Capacitor.isNativePlatform()) return 'I can open other apps only from the Android app.';
  try {
    const r = await AuraPhone.openApp({ name });
    if (r.opened) return `Opening ${r.label ?? name}.`;
    return r.suggestions?.length ? `I couldn't find ${name}. Did you mean ${r.suggestions.join(' or ')}?` : `I couldn't find an app called ${name}.`;
  } catch { return `I couldn't open ${name}.`; }
}

async function runActions(actions: ConverseAction[], nav: Nav, now: number): Promise<string | undefined> {
  let override: string | undefined;
  for (const a of actions.slice(0, 3)) {
    const args = a.args ?? {};
    if (a.type === 'open_app' && typeof args.name === 'string') { const m = await openApp(args.name); if (!m.startsWith('Opening')) override = m; }
    else if (a.type === 'log_water') addWater(Math.min(10, Number(args.glasses) || 1));
    else if (a.type === 'log_meal') logMeal(MEALS.includes(String(args.name).toLowerCase()) ? cap(String(args.name).toLowerCase()) : 'Snack', typeof args.dish === 'string' ? args.dish.slice(0, 80) : undefined);
    else if (a.type === 'took_medicine') markMedicineTaken(typeof args.name === 'string' ? args.name : undefined, now);
    else if (a.type === 'set_mood' && ['Great', 'Good', 'Okay', 'Low', 'Stressed'].includes(String(args.mood))) upsertTodayLog({ mood: String(args.mood) });
    else if (a.type === 'navigate' && typeof args.path === 'string' && args.path.startsWith('/')) nav(args.path);
    else if (a.type === 'order' && typeof args.text === 'string') nav('/shopping', { state: { ask: args.text } });
  }
  return override;
}

/* ---------- one conversational turn ---------- */

/** Works out what to say (and does what was asked). Local understanding first; the model only when needed. */
export async function handleUtterance(text: string, nav: Nav): Promise<string> {
  const now = Date.now();
  const t = text.trim();
  if (!t) return '';
  remember('user', t);

  // an answer to the shopping assistant's question ("Zepto", "the cheaper one", "yes")
  if (shoppingPending) {
    const spoken = await shopByVoice(t);
    if (spoken !== null) { remember('aura', spoken); return spoken; }
  }

  if (pending && pending.until > now) {
    const p = pending;
    pending = null;
    const r = answerPending(t.toLowerCase().replace(/[.!?]+$/, ''), p, now);
    if (r?.say !== undefined) { remember('aura', r.say); return r.say; }
    pending = null;
    return converse(t, nav, now, p.question);
  }
  pending = null;

  const local = await understandLocally(t, nav, now);
  if (local?.say !== undefined) { remember('aura', local.say); return local.say; }
  return converse(t, nav, now);
}

async function converse(text: string, nav: Nav, now: number, pendingQuestion?: string): Promise<string> {
  const r = await aura.converse(text, { context: buildCompanionContext(), history: history.slice(0, -1), pending: pendingQuestion });
  const override = await runActions(r.actions, nav, now);
  const say = override ?? r.say;
  remember('aura', say);
  return say;
}

/* ---------- listening and speaking ---------- */

export async function say(text: string): Promise<void> {
  if (!text) return;
  setState({ phase: 'speaking', said: text });
  await speakNow(text);
  await new Promise((r) => setTimeout(r, 350)); // let the speaker's tail die before the mic opens
}

/** Listens once. Resolves with what was heard, or '' on silence. */
export function listenOnce(timeoutMs = 9000): Promise<string> {
  if (!browserVoice.supported) return Promise.resolve('');
  setState({ phase: 'listening', heard: '' });
  return new Promise<string>((resolve) => {
    let finalText = '';
    let stop: (() => void) | undefined;
    const timer = window.setTimeout(() => stop?.(), timeoutMs);
    stop = browserVoice.listen(
      (t, final) => { setState({ heard: t }); if (final) finalText = t; },
      () => { window.clearTimeout(timer); resolve(finalText); },
    );
  });
}

let busy = false;
export const isBusy = () => busy;

/** Replies to what was heard and, while AURA is asking something and the user keeps answering, carries on (max 3 turns). */
async function loop(first: string, nav: Nav) {
  let heard = first;
  let turnsLeft = 3;
  while (heard && turnsLeft-- > 0) {
    setState({ phase: 'thinking', heard });
    let reply: string;
    try { reply = await handleUtterance(heard, nav); } catch { reply = 'Sorry, I had trouble with that. Could you say it again?'; setState({ error: 'AURA could not reach its brain.' }); }
    if (!reply) break;
    await say(reply);
    heard = /\?\s*$/.test(reply) || pending || shoppingPending ? await listenOnce() : '';
  }
}

async function conversation(first: string, nav: Nav, listenFirst: boolean) {
  busy = true;
  try {
    await say(first);
    await loop(listenFirst ? await listenOnce() : '', nav);
  } finally {
    busy = false;
    setState({ phase: 'idle' });
  }
}

/** Push-to-talk: the user tapped the orb. Tapping again while it is busy stops it. */
export async function talk(nav: Nav) {
  if (busy) { stopSpeakingNow(); setState({ phase: 'idle' }); return; }
  busy = true;
  setState({ prompt: '' });
  try {
    const heard = await listenOnce(12_000);
    if (!heard) { await say(browserVoice.supported ? "I didn't catch that. Tap me and try again." : 'Speech input is not available here.'); return; }
    await loop(heard, nav);
  } finally {
    busy = false;
    setState({ phase: 'idle' });
  }
}


/**
 * A command spoken after "Hey Aura", already transcribed by the background service. Same brain as a tap on the orb,
 * but nothing is shown or spoken here: the service's overlay does that, over whatever app the user is in.
 * expectAnswer keeps the overlay listening (AURA asked something); openApp is set when the answer lives on a screen
 * of the app (so it is opened after the reply), which is the only time the app comes forward.
 */
export async function answerWake(text: string, nav: Nav): Promise<{ say: string; expectAnswer: boolean; openApp: boolean }> {
  let navigated = false;
  const say = await handleUtterance(text, (path, opts) => { navigated = true; nav(path, opts); });
  return { say, expectAnswer: /\?\s*$/.test(say) || !!pending || shoppingPending, openApp: navigated };
}


/* ---------- speaking first: check-ins ---------- */

type Kind = 'morning' | 'water' | 'breakfast' | 'lunch' | 'dinner' | 'medicine' | 'evening';

const inQuiet = (d: Date, p: CompanionPrefs) => {
  const m = d.getHours() * 60 + d.getMinutes();
  const [qs, qe] = [p.quietStart, p.quietEnd].map((x) => { const [h, mi] = x.split(':').map(Number); return h * 60 + mi; });
  return qs > qe ? m >= qs || m < qe : m >= qs && m < qe;
};

/** Which check-in, if any, is due right now. Never more than one, and never too close to the last one. */
export function dueCheckIn(now = Date.now()): { kind: Kind; question: string; data?: Record<string, unknown> } | null {
  const prefs = getPrefs();
  const d = new Date(now);
  if (!prefs.enabled || inQuiet(d, prefs) || (prefs.pausedUntil && new Date(prefs.pausedUntil).getTime() > now)) return null;
  const asked = (k: string) => (prefs.lastAsked[k] ? new Date(prefs.lastAsked[k]).getTime() : 0);
  const sinceAny = now - Math.max(0, ...Object.values(prefs.lastAsked).map((v) => new Date(v).getTime()));
  const hour = d.getHours() + d.getMinutes() / 60;
  const sameDay = (k: string) => asked(k) >= new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const n = userName;

  // Medicine matters most: ask when a dose is due, every 10+ minutes, up to 3 times.
  const due = unresolvedDoses(now).filter((x) => x.state === 'due' && (snoozedDoses.get(x.dose.id) ?? 0) <= now && (doseAsks.get(x.dose.id) ?? 0) < 3);
  if (due.length && now - asked('medicine') >= 10 * 60_000) {
    const names = [...new Set(due.map((x) => x.dose.med.name))].join(' and ');
    return { kind: 'medicine', question: `${n}, it's time for your ${names}. Did you take it?`, data: { doseIds: due.map((x) => x.dose.id) } };
  }
  if (sinceAny < 25 * 60_000) return null;

  const log = todayLog();
  const ate = (m: string) => mealsStore.get().some((x) => x.date === today() && x.name === m && x.eaten);
  if (hour >= 6 && hour < 11 && !sameDay('morning')) return { kind: 'morning', question: `Good morning ${n}! How did you sleep last night?` };
  if (hour >= 8.5 && hour < 11 && !ate('Breakfast') && now - asked('breakfast') > 90 * 60_000) return { kind: 'breakfast', question: `${n}, have you had your breakfast yet?`, data: { meal: 'Breakfast' } };
  if (hour >= 13 && hour < 15.5 && !ate('Lunch') && now - asked('lunch') > 90 * 60_000) return { kind: 'lunch', question: `${n}, have you had lunch yet?`, data: { meal: 'Lunch' } };
  if (hour >= 20 && hour < 22 && !ate('Dinner') && now - asked('dinner') > 90 * 60_000) return { kind: 'dinner', question: `${n}, have you had your dinner yet?`, data: { meal: 'Dinner' } };
  if (hour >= 9 && hour < 21 && (log?.water ?? 0) < TARGETS.water && now - asked('water') > 100 * 60_000) return { kind: 'water', question: `${n}, you've had ${log?.water ?? 0} of ${TARGETS.water} glasses of water today. Shall we have a glass now?` };
  if (hour >= 20.5 && hour < 22 && !sameDay('evening')) return { kind: 'evening', question: `How was your day, ${n}? How are you feeling?` };
  return null;
}

/** Speaks a check-in. It does not listen: the question waits on screen until the user taps the mic to answer. */
export async function runCheckIn(c: NonNullable<ReturnType<typeof dueCheckIn>>, nav: Nav) {
  if (busy) return;
  savePrefs({ lastAsked: { ...getPrefs().lastAsked, [c.kind]: new Date().toISOString() } });
  const k = c.kind;
  if (k === 'medicine') for (const id of (c.data?.doseIds as string[]) ?? []) doseAsks.set(id, (doseAsks.get(id) ?? 0) + 1);
  pending = {
    kind: k === 'medicine' ? 'medicine' : k === 'water' ? 'water' : k === 'morning' ? 'sleep' : k === 'evening' ? 'mood' : 'meal',
    question: c.question, data: c.data, until: Date.now() + 3 * 60_000,
  };
  remember('aura', c.question);
  // AURA speaks first, but never opens the microphone on its own: the question stays on screen and the user taps the
  // orb to answer (within PENDING time, the answer is understood as the reply to this question)
  await conversation(c.question, nav, false);
  setState({ prompt: c.question });
  window.setTimeout(() => {
    if (companionStore.get().prompt === c.question) setState({ prompt: '' });
    if (pending && pending.question === c.question) pending = null; // unanswered: don't treat a later remark as the answer
  }, 3 * 60_000);
}

export const resetCompanionSession = () => { shoppingPending = false; pending = null; history.length = 0; snoozedDoses.clear(); doseAsks.clear(); };
