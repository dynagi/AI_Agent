/**
 * Shared motion vocabulary for the whole app. Everything here is deliberately
 * restrained — "premium/subtle cinematic", not maximal: gentle rises, soft
 * spring presses, no bouncing or spinning. All durations/easings live here
 * so the whole app reads as one consistent motion language, and every
 * Framer Motion usage goes through `useReducedMotion()` (from
 * `framer-motion` itself) at the call site so `prefers-reduced-motion`
 * degrades everything to an instant, no-motion state automatically.
 */
import type { Transition, Variants } from 'framer-motion';

export const EASE: Transition['ease'] = [0.16, 1, 0.3, 1]; // "expo-out" — fast start, soft landing

export const spring: Transition = { type: 'spring', stiffness: 380, damping: 32, mass: 0.7 };

/** A section/card rising gently into place. Used by Hud and other shared containers. */
export const revealUp: Variants = {
  hidden: { opacity: 0, y: 18 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE } },
};

/** Staggers its direct motion children (see PageHero). */
export const staggerContainer: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08, delayChildren: 0.04 } },
};

export const staggerItem: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE } },
};

/** Route-level page transition (see AuraShell). */
export const pageVariants: Variants = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.32, ease: EASE } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.18, ease: EASE } },
};

/** Modal / dialog entrance (see FuturisticModal). */
export const modalPop: Variants = {
  hidden: { opacity: 0, scale: 0.95, y: 8 },
  show: { opacity: 1, scale: 1, y: 0, transition: spring },
};

export const backdropFade: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.2 } },
};

/** Slide-in panel (see Drawer). */
export const drawerSlide: Variants = {
  hidden: { x: '100%' },
  show: { x: 0, transition: spring },
};

/** Toast enter/exit. */
export const toastMotion: Variants = {
  hidden: { opacity: 0, y: 14, scale: 0.98 },
  show: { opacity: 1, y: 0, scale: 1, transition: spring },
  exit: { opacity: 0, y: 8, scale: 0.98, transition: { duration: 0.15 } },
};

/** Hover/press feedback for buttons and clickable tiles. */
export const pressable = { whileHover: { scale: 1.025 }, whileTap: { scale: 0.975 }, transition: spring };
export const liftable = { whileHover: { y: -3 }, whileTap: { y: 0, scale: 0.98 }, transition: spring };
