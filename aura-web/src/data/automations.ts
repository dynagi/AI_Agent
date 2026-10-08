import { Mail, Calendar, FileText, ShoppingCart, Plane, IndianRupee, Dumbbell, FolderOpen, Sun, Link2, Wallet, Sparkles, type LucideIcon } from 'lucide-react';
import type { Tone } from '../components/ui';

export type AutoCategory = 'Productivity' | 'Communication' | 'Lifestyle' | 'Finance' | 'Travel' | 'Shopping' | 'Custom';

/** Icons are stored by key so automations stay JSON-serializable. */
export const autoIcons = { mail: Mail, calendar: Calendar, file: FileText, cart: ShoppingCart, plane: Plane, rupee: IndianRupee, dumbbell: Dumbbell, folder: FolderOpen, sun: Sun, link: Link2, wallet: Wallet, spark: Sparkles } satisfies Record<string, LucideIcon>;
export type AutoIcon = keyof typeof autoIcons;
export const autoIcon = (key: string): LucideIcon => autoIcons[key as AutoIcon] ?? Sparkles;

export interface Automation {
  id: string;
  name: string;
  description: string;
  icon: AutoIcon;
  tone: Tone;
  tags: string[];
  category: AutoCategory;
  schedule: string;
  active: boolean;
  /** app → app flow for featured cards */
  from?: string;
  to?: string;
  featured?: boolean;
  /** ISO timestamp of the last time the user ran it. */
  lastRunAt?: string;
  trigger?: string;
  steps?: string[];
  needsApproval?: boolean;
}

export interface AutoTemplate { id: string; name: string; description: string; icon: AutoIcon; tone: Tone; tags: string[]; category: AutoCategory; schedule: string }

export const recommendedAutomations: AutoTemplate[] = [
  { id: 't1', name: 'Auto Backup Files', description: 'Backup your important files to Google Drive every day.', icon: 'folder', tone: 'blue', tags: ['File Management', 'Cloud'], category: 'Productivity', schedule: 'Runs daily • 11:00 PM' },
  { id: 't2', name: 'Meeting Summarizer', description: 'Summarize meeting notes and send to your email.', icon: 'file', tone: 'violet', tags: ['Productivity', 'Communication'], category: 'Communication', schedule: 'Runs on event' },
  { id: 't3', name: 'News Digest', description: 'Get daily AI-curated news based on your interests.', icon: 'file', tone: 'magenta', tags: ['Information', 'AI'], category: 'Lifestyle', schedule: 'Runs daily • 8:00 AM' },
  { id: 't4', name: 'Health Check-in', description: 'Log your health data and get weekly insights.', icon: 'dumbbell', tone: 'pink', tags: ['Health', 'Lifestyle'], category: 'Lifestyle', schedule: 'Runs weekly • Sunday 9:00 AM' },
];

export const automationTemplates: AutoTemplate[] = [
  { id: 'tp1', name: 'Morning Routine', description: 'Get weather, news, and tasks every morning.', icon: 'sun', tone: 'amber', tags: ['Lifestyle'], category: 'Lifestyle', schedule: 'Runs daily • 7:00 AM' },
  { id: 'tp2', name: 'Content Creator', description: 'Summarize, create drafts and schedule posts.', icon: 'file', tone: 'pink', tags: ['Communication'], category: 'Communication', schedule: 'Runs on request' },
  { id: 'tp3', name: 'Study Buddy', description: 'Organize study plan and track progress.', icon: 'file', tone: 'violet', tags: ['Productivity'], category: 'Productivity', schedule: 'Runs daily • 6:00 PM' },
  { id: 'tp4', name: 'Health Tracker', description: 'Log health data and get personalized tips.', icon: 'dumbbell', tone: 'pink', tags: ['Lifestyle'], category: 'Lifestyle', schedule: 'Runs daily • 9:00 PM' },
  { id: 'tp5', name: 'Bill Reminders', description: 'Remind me 3 days before any bill is due.', icon: 'wallet', tone: 'green', tags: ['Finance'], category: 'Finance', schedule: 'Runs daily • 9:00 AM' },
];
