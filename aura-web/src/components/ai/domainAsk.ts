import { aura } from '../../services/aura';
import type { AIHandler } from './AICommandPanel';

/** Builds an AI panel handler that asks the real backend, sending a short summary of the user's own data as context. */
export const domainAsk = (domain: string, context: () => string): AIHandler => async (prompt) => {
  const reply = await aura.chat(`[${domain}] ${prompt}`, context());
  return { text: reply.text };
};
