import { Capacitor } from '@capacitor/core';
import { uid } from '../state/store';
import { doseLogsStore, medicinesStore, medOrdersStore } from '../state/stores';
import { AuraMedicine } from '../native/medicine';
import { PHARMACIES, fmtTime, type Dose, type Medicine, type Pharmacy, type PharmacyId } from '../data/medicine';

export const isNative = Capacitor.isNativePlatform();

/** Splits "medId__2026-10-03__08:00" back into its parts (medId itself never contains "__"). */
export function parseDoseId(id: string): { medId: string; date: string; time: string } | null {
  const [medId, date, time] = id.split('__');
  return medId && date && time ? { medId, date, time } : null;
}

/** Logs a dose. Marking it taken uses up stock; calling it twice for the same dose is a no-op, so a notification tap and an in-app tap can't double-count. */
export function recordDose(medId: string, date: string, time: string, status: 'taken' | 'skipped', at = Date.now()) {
  const id = `${medId}__${date}__${time}`;
  if (doseLogsStore.get().some((l) => l.id === id)) return;
  doseLogsStore.set((ls) => [...ls, { id, medId, date, time, status, at: new Date(at).toISOString() }]);
  if (status === 'taken') adjustStock(medId, -1);
}

/** Takes a logged dose back (tapped by mistake) and returns the stock. */
export function undoDose(dose: Dose) {
  const log = doseLogsStore.get().find((l) => l.id === dose.id);
  if (!log) return;
  doseLogsStore.set((ls) => ls.filter((l) => l.id !== dose.id));
  if (log.status === 'taken') adjustStock(dose.med.id, +1);
}

function adjustStock(medId: string, sign: 1 | -1) {
  medicinesStore.set((ms) => ms.map((m) => (m.id === medId ? { ...m, stock: Math.max(0, m.stock + sign * m.perDose) } : m)));
}

export const reminderText = (m: Medicine, time: string) => ({
  title: `Time for ${m.name}`,
  body: `${m.dose ? `${m.dose} · ` : ''}${m.perDose} ${m.perDose === 1 ? 'unit' : 'units'} · ${fmtTime(time)}`,
});

/**
 * Hands the shopping list to a pharmacy app. Opens its installed app (or site) and copies the names to the clipboard,
 * since pharmacy apps have no way to pre-fill a multi-item cart. Nothing is ordered or paid for here.
 */
export async function orderFromPharmacy(pharmacyId: PharmacyId, meds: Medicine[]): Promise<'app' | 'web'> {
  const pharmacy = PHARMACIES.find((p) => p.id === pharmacyId) as Pharmacy;
  const list = meds.map((m) => `${m.name}${m.dose ? ` ${m.dose}` : ''}`).join(', ');
  const url = pharmacy.url(encodeURIComponent(meds.length === 1 ? meds[0].name : ''));
  let opened: 'app' | 'web' = 'web';
  if (isNative) opened = (await AuraMedicine.openPharmacy({ pkg: pharmacy.pkg, url, copy: list })).opened;
  else { window.open(url, '_blank', 'noopener'); void navigator.clipboard?.writeText(list).catch(() => undefined); }
  logOrder(meds, pharmacyId);
  return opened;
}

export async function shareList(meds: Medicine[]) {
  const text = `Medicines to order:\n${meds.map((m) => `• ${m.name}${m.dose ? ` ${m.dose}` : ''}`).join('\n')}`;
  if (isNative) await AuraMedicine.shareText({ text });
  else if (navigator.share) await navigator.share({ text });
  else await navigator.clipboard?.writeText(text);
  logOrder(meds, 'other');
}

function logOrder(meds: Medicine[], pharmacy: PharmacyId | 'other') {
  medOrdersStore.set((os) => [...os, { id: uid('mo'), medIds: meds.map((m) => m.id), names: meds.map((m) => m.name), pharmacy, at: new Date().toISOString(), status: 'placed' }]);
}

/** The user confirms the delivery arrived: closes the order and adds the units to stock. */
export function receiveOrder(orderId: string, unitsPerMedicine: number) {
  const order = medOrdersStore.get().find((o) => o.id === orderId);
  if (!order) return;
  medOrdersStore.set((os) => os.map((o) => (o.id === orderId ? { ...o, status: 'received' } : o)));
  medicinesStore.set((ms) => ms.map((m) => (order.medIds.includes(m.id) ? { ...m, stock: m.stock + unitsPerMedicine } : m)));
}
