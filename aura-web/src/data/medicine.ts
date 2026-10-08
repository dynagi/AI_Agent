/** Self-reported medicine schedule and dose tracking. AURA gives reminders only — it does not give medical advice. */

export interface Medicine {
  id: string;
  name: string;
  /** Free text, e.g. "500 mg". */
  dose: string;
  /** Local times of day, "HH:MM" (24h). */
  times: string[];
  startDate: string;
  /** Last day to take it (inclusive); empty = ongoing. */
  endDate?: string;
  /** Units (tablets etc.) left at home. Drops by `perDose` each time a dose is marked taken. */
  stock: number;
  perDose: number;
  /** Flag as "running low" when this many days of stock remain. */
  refillDays: number;
  active: boolean;
  note?: string;
}

export interface DoseLog { id: string; medId: string; date: string; time: string; status: 'taken' | 'skipped'; /** ISO timestamp of the tap. */ at: string }

export type PharmacyId = '1mg' | 'pharmeasy' | 'apollo' | 'netmeds';
export interface MedOrder { id: string; medIds: string[]; names: string[]; pharmacy: PharmacyId | 'other'; at: string; status: 'placed' | 'received' }

export interface Pharmacy { id: PharmacyId; label: string; /** Android package, used to open the installed app directly. */ pkg: string; url: (q: string) => string }
export const PHARMACIES: Pharmacy[] = [
  { id: '1mg', label: 'Tata 1mg', pkg: 'com.aranoah.healthkart.plus', url: (q) => `https://www.1mg.com/search/all?name=${q}` },
  { id: 'pharmeasy', label: 'PharmEasy', pkg: 'com.phonegenie.pharmeasy', url: (q) => `https://pharmeasy.in/search/all?name=${q}` },
  { id: 'apollo', label: 'Apollo 24|7', pkg: 'com.apollo.patientapp', url: (q) => `https://www.apollopharmacy.in/search-medicines/${q}` },
  { id: 'netmeds', label: 'Netmeds', pkg: 'com.NetmedsMarketplace.Netmeds', url: (q) => `https://www.netmeds.com/catalogsearch/result/${q}/all` },
];

/** A dose's state changes with the clock: upcoming → due (for DUE_WINDOW_MIN) → missed, unless the user logs it. */
export type DoseState = 'taken' | 'skipped' | 'due' | 'upcoming' | 'missed';
export const DUE_WINDOW_MIN = 60;

export interface Dose { id: string; med: Medicine; date: string; time: string; /** Epoch ms the dose is scheduled for. */ at: number }

export const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const doseId = (medId: string, date: string, time: string) => `${medId}__${date}__${time}`;
const toMs = (date: string, time: string) => new Date(`${date}T${time}:00`).getTime();

export function dosesForDate(meds: Medicine[], date: string): Dose[] {
  return meds
    .filter((m) => m.active && m.startDate <= date && (!m.endDate || date <= m.endDate))
    .flatMap((med) => med.times.map((time) => ({ id: doseId(med.id, date, time), med, date, time, at: toMs(date, time) })))
    .sort((a, b) => a.at - b.at);
}

/** Doses scheduled in (from, until], across date boundaries — used to program native alarms. */
export function dosesBetween(meds: Medicine[], from: number, until: number): Dose[] {
  const out: Dose[] = [];
  const d = new Date(from); d.setHours(0, 0, 0, 0);
  for (; d.getTime() <= until; d.setDate(d.getDate() + 1)) {
    out.push(...dosesForDate(meds, isoDate(d)).filter((x) => x.at > from && x.at <= until));
  }
  return out;
}

export function doseState(dose: Dose, log: DoseLog | undefined, now: number): DoseState {
  if (log) return log.status;
  if (now < dose.at) return 'upcoming';
  return now < dose.at + DUE_WINDOW_MIN * 60_000 ? 'due' : 'missed';
}

export const daysLeft = (m: Medicine) => {
  const perDay = m.perDose * m.times.length;
  return perDay > 0 ? Math.floor(m.stock / perDay) : Infinity;
};
export const isLow = (m: Medicine) => m.active && daysLeft(m) <= m.refillDays;

/** Share of resolved (taken + missed) doses over the last `days` days (today excluded until its doses pass) that were taken. */
export function adherence(meds: Medicine[], logs: DoseLog[], today: string, now: number, days = 7): { pct: number | null; taken: number; missed: number } {
  const byId = new Map(logs.map((l) => [l.id, l]));
  let taken = 0, missed = 0;
  const d = new Date(`${today}T00:00:00`);
  for (let i = 0; i < days; i++, d.setDate(d.getDate() - 1)) {
    for (const dose of dosesForDate(meds, isoDate(d))) {
      const s = doseState(dose, byId.get(dose.id), now);
      if (s === 'taken') taken++;
      else if (s === 'missed' || s === 'skipped') missed++;
    }
  }
  return { pct: taken + missed ? Math.round((taken / (taken + missed)) * 100) : null, taken, missed };
}

export const fmtTime = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
