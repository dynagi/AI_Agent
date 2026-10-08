/**
 * Client-side API boundary. The UI talks only to `aura`; the Node backend
 * (fronting Supabase and the Python AI runtime) implements it. No API keys
 * live in the frontend.
 */
import { apiGet, apiSend } from './api';
import { recordAgentActivity } from '../state/agentActivity';
import { preferencesStore } from '../state/stores';
import { startQuickCart, type CartJob } from './extension';

export type StepStatus = 'done' | 'processing' | 'pending';
export interface PlanStep { label: string; status: StepStatus }

export interface ChatReply {
  /** The assistant's reply text. */
  text: string;
  /** Agents the coordinator consulted for this message. */
  agents: string[];
  /** Structured per-agent output (e.g. shopping forecast, travel offers). */
  agentData: Record<string, Record<string, unknown>>;
  /** Set when the shopping agent turned the message into a cart job; it has already been started. */
  cartOrder?: CartJob;
}

export interface PlanTask { title: string; agent?: string | null; dependencies?: string[] }
export interface DecisionOption { title: string; tradeoffs: string; risk: string }
export interface Decision { options: DecisionOption[]; recommendation: string; agentsConsulted?: string[] }

export interface ConverseAction { type: string; args: Record<string, unknown> }
export interface ConverseReply { say: string; actions: ConverseAction[] }

export const aura = {
  /** Fast single-call companion reply (short, spoken style) that may also ask the app to do things. See ai-service/app/routers/companion.py. */
  async converse(message: string, opts: { context?: string; history?: { role: 'user' | 'aura'; text: string }[]; pending?: string } = {}): Promise<ConverseReply> {
    const res = await apiSend<{ say: string; do: ConverseAction[] }>('POST', '/chat/converse', { message, ...opts });
    return { say: res.say, actions: res.do ?? [] };
  },

  /** `context` is a short summary of the user's own data for the domain being discussed. */
  async chat(message: string, context?: string): Promise<ChatReply> {
    const style = preferencesStore.get()[0]?.responseStyle;
    const styleNote = style && style !== 'Balanced' ? `\n\n(Reply style: ${style.toLowerCase()}.)` : '';
    const res = await apiSend<{ reply: string; agentsConsulted: string[]; agentData?: Record<string, Record<string, unknown>> }>('POST', '/chat', {
      message: (context ? `${message}\n\nContext from the user's data:\n${context}` : message) + styleNote,
    });
    if (res.agentsConsulted.length) recordAgentActivity(res.agentsConsulted, message.slice(0, 80));
    const agentData = res.agentData ?? {};
    // A shopping command ("order milk and eggs from Zepto", "get my usual groceries") runs hands-free:
    // the cart agent starts right away and stops at the cart.
    const order = agentData.shopping?.cartOrder as Omit<CartJob, 'logged'> | undefined;
    const cartOrder = order?.items?.length
      // not "logged": what actually lands in the cart is recorded as the order when the job finishes
      ? { store: order.store, startUrl: order.startUrl, androidPackage: order.androidPackage, appLabel: order.appLabel,
          items: order.items, syncHistory: order.syncHistory, resolved: order.resolved }
      : undefined;
    if (cartOrder) void startQuickCart(cartOrder);
    return { text: res.reply, agents: res.agentsConsulted, agentData, cartOrder };
  },

  async plan(goal: string): Promise<PlanTask[]> {
    const res = await apiSend<{ tasks: PlanTask[] }>('POST', '/chat/plan', { goal });
    return res.tasks;
  },

  async decide(situation: string, context?: Record<string, unknown>): Promise<Decision> {
    return apiSend<Decision>('POST', '/decisions/evaluate', { situation, context });
  },

  /** Records the user's approval. No provider integration executes it, so it never claims success. */
  async approve(action: string, payload: Record<string, unknown> = {}): Promise<{ verified: boolean; message: string }> {
    await apiSend('POST', '/approvals', { action, payload, status: 'approved' });
    return { verified: false, message: 'Approval recorded. No provider is connected for this action, so nothing was executed.' };
  },

  health: () => apiGet<{ status: string; dependencies: Record<string, string> }>('/health'),
};
