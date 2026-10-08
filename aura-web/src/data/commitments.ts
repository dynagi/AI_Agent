/**
 * Things that happen on a schedule: salary coming in, rent, EMIs, bills, subscriptions, insurance, SIPs. The money plan
 * (services/moneyPlan.ts) works out the future from these plus the user's own spending history.
 */
export type CommitmentKind = 'income' | 'rent' | 'emi' | 'bill' | 'subscription' | 'insurance' | 'investment' | 'other';
export type Frequency = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

export interface Commitment {
  id: string;
  name: string;
  kind: CommitmentKind;
  /** Always positive; `kind === 'income'` is money in, everything else is money out. */
  amount: number;
  frequency: Frequency;
  /** Day of the month (1-31; a short month uses its last day). For weekly: the weekday, 0 = Sunday. */
  day: number;
  /** Quarterly / yearly: the month (0-11) it falls in (quarterly: the first of the three-month cycle). */
  month?: number;
  /** ISO dates (YYYY-MM-DD). An EMI that ends, a lease that starts later. */
  startsOn?: string;
  endsOn?: string;
  /** Needs rather than wants: counts towards the emergency-fund target and is never suggested to be cut. */
  essential: boolean;
}

export const kindLabel: Record<CommitmentKind, string> = {
  income: 'Income', rent: 'Rent', emi: 'EMI / loan', bill: 'Bill', subscription: 'Subscription', insurance: 'Insurance', investment: 'SIP / investment', other: 'Other',
};

/** Starting points offered when adding a commitment. */
export const commitmentTemplates: { label: string; kind: CommitmentKind; name: string; day: number; essential: boolean }[] = [
  { label: 'Salary', kind: 'income', name: 'Salary', day: 1, essential: true },
  { label: 'Rent', kind: 'rent', name: 'Rent', day: 1, essential: true },
  { label: 'EMI', kind: 'emi', name: 'Loan EMI', day: 5, essential: true },
  { label: 'Electricity', kind: 'bill', name: 'Electricity', day: 12, essential: true },
  { label: 'Internet', kind: 'bill', name: 'Internet', day: 10, essential: true },
  { label: 'Insurance', kind: 'insurance', name: 'Insurance premium', day: 15, essential: true },
  { label: 'SIP', kind: 'investment', name: 'Mutual fund SIP', day: 7, essential: false },
  { label: 'Subscription', kind: 'subscription', name: 'Subscription', day: 20, essential: false },
];

/** The user's own money settings. */
export interface MoneyPrefs {
  id: string;
  /** "My balance is ₹X as of now": the balance is this plus every transaction after `at`. Without it, all transactions are summed. */
  anchor?: { amount: number; at: string };
  /** Cash to keep untouched. Default: about 10% of a month's income. */
  buffer?: number;
  /** Share of income to save (0-1). */
  savingsRate: number;
  /** How many months of essentials the emergency fund should cover. */
  emergencyMonths: number;
}

export const DEFAULT_MONEY_PREFS: MoneyPrefs = { id: 'prefs', savingsRate: 0.2, emergencyMonths: 6 };
