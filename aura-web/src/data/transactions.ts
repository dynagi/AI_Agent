export type TxCategory = 'Shopping' | 'Food & Dining' | 'Income' | 'Travel' | 'Bills & Utilities' | 'Subscriptions' | 'Others';

/** `ts` is an ISO timestamp; negative amounts are expenses. */
export interface Transaction { id: string; merchant: string; logo: string; ts: string; category: TxCategory; amount: number }

export const txTone: Record<TxCategory, 'violet' | 'red' | 'green' | 'blue' | 'amber' | 'magenta' | 'cyan'> = {
  Shopping: 'violet', 'Food & Dining': 'red', Income: 'green', Travel: 'blue', 'Bills & Utilities': 'amber', Subscriptions: 'magenta', Others: 'cyan',
};

export const txColor: Record<TxCategory, string> = {
  'Food & Dining': '#00E5A8', Shopping: '#00AFFF', Travel: '#FF7A45', 'Bills & Utilities': '#FFC857', Subscriptions: '#FF4FD8', Others: '#8B5CFF', Income: '#22C55E',
};

export function formatWhen(ts: string): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(ts).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
}
