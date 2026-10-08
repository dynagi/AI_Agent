import { User, Crown, Users, type LucideIcon } from 'lucide-react';
import type { Tone } from '../components/ui';

export type PlanId = 'free' | 'pro' | 'team';

export interface PricingPlan { id: PlanId; name: string; tagline: string; monthly: number; icon: LucideIcon; tone: Tone; features: string[]; cta: string; popular?: boolean }

export const pricingPlans: PricingPlan[] = [
  { id: 'free', name: 'Free', tagline: 'Get started with AURA', monthly: 0, icon: User, tone: 'blue', cta: 'Current Plan',
    features: ['Basic AI chat', '1 personal assistant agent', 'Simple task automation', 'Connect up to 3 apps', 'Standard response speed', 'Community support'] },
  { id: 'pro', name: 'Pro', tagline: 'Unlock the full power of AURA', monthly: 499, icon: Crown, tone: 'amber', cta: 'Upgrade to Pro', popular: true,
    features: ['Advanced AI agents (10+)', 'Unlimited tasks & automations', 'Connect unlimited apps', 'Personalized insights & recommendations', 'Priority response speed', 'Early access to new features', 'Priority support'] },
  { id: 'team', name: 'Team', tagline: 'For families, friends or teams', monthly: 1499, icon: Users, tone: 'teal', cta: 'Get Team Plan',
    features: ['All Pro features', 'Up to 5 team members', 'Shared agents & tasks', 'Collaborative planning', 'Team insights & analytics', 'Admin controls', 'Dedicated support'] },
];

/** Feature matrix for the Plan Comparison modal */
export const planMatrix: { feature: string; free: string; pro: string; team: string }[] = [
  { feature: 'AI agents', free: '1', pro: '10+', team: '10+ shared' },
  { feature: 'Tasks & automations', free: 'Simple', pro: 'Unlimited', team: 'Unlimited' },
  { feature: 'Connected apps', free: '3', pro: 'Unlimited', team: 'Unlimited' },
  { feature: 'Personalized insights', free: '—', pro: '✓', team: '✓ + team analytics' },
  { feature: 'Response speed', free: 'Standard', pro: 'Priority', team: 'Priority' },
  { feature: 'Members', free: '1', pro: '1', team: 'Up to 5' },
  { feature: 'Admin controls', free: '—', pro: '—', team: '✓' },
  { feature: 'Support', free: 'Community', pro: 'Priority', team: 'Dedicated' },
];
