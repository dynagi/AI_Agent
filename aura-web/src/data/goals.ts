import { Home, Plane, Car, Target, GraduationCap, type LucideIcon } from 'lucide-react';
import type { Tone } from '../components/ui';

export type GoalIcon = 'home' | 'plane' | 'car' | 'target' | 'education';
/** `by` (YYYY-MM-DD) is when the user wants it done; the money plan turns it into a monthly amount. */
export interface Goal { id: string; name: string; icon: GoalIcon; tone: Tone; saved: number; target: number; by?: string }

export const goalIcons: Record<GoalIcon, LucideIcon> = { home: Home, plane: Plane, car: Car, target: Target, education: GraduationCap };
