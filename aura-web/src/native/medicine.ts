import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface ReminderDose { id: string; title: string; body: string; at: number }
export interface DoseAction { id: string; action: 'taken' | 'snooze'; at: number }

export interface AuraMedicinePlugin {
  /** Replaces every scheduled reminder with this set. */
  scheduleReminders(options: { doses: ReminderDose[] }): Promise<void>;
  /** Taken/Snooze taps made on notifications while the app was closed. Returned once, then cleared. */
  drainActions(): Promise<{ actions: DoseAction[] }>;
  notificationsEnabled(): Promise<{ enabled: boolean }>;
  requestNotifications(): Promise<{ enabled: boolean }>;
  /** Opens the pharmacy's installed app (by package) or, if absent, its website. Copies `copy` to the clipboard first. */
  openPharmacy(options: { pkg: string; url: string; copy?: string }): Promise<{ opened: 'app' | 'web' }>;
  /** Same as openPharmacy, for any app (food apps etc.). */
  openApp(options: { pkg: string; url: string; copy?: string }): Promise<{ opened: 'app' | 'web' }>;
  /** Android share sheet, so the list can go to any installed app. */
  shareText(options: { text: string }): Promise<void>;
  addListener(eventName: 'doseAction', listenerFunc: (data: DoseAction) => void): Promise<PluginListenerHandle>;
}

/** Native counterpart: android/app/src/main/java/com/aura/app/AuraMedicinePlugin.java. Rejects on web. */
export const AuraMedicine = registerPlugin<AuraMedicinePlugin>('AuraMedicine');
