import { env } from '../config/env.js';

/**
 * Thin client for the internal Python AI service. Node stays the public
 * boundary; the AI service is never exposed directly to the frontend.
 */
async function callAi<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${env.pythonAiUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AiServiceError(`AI service ${path} failed with ${res.status}: ${text}`);
  }

  return (await res.json()) as T;
}

async function getAi<T>(path: string, params: Record<string, string | number>): Promise<T> {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) query.set(k, String(v));
  const res = await fetch(`${env.pythonAiUrl}${path}?${query.toString()}`);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AiServiceError(`AI service ${path} failed with ${res.status}: ${text}`);
  }

  return (await res.json()) as T;
}

export class AiServiceError extends Error {}

export const aiClient = {
  chat: (payload: { message: string; userId: string; conversationId?: string }) =>
    callAi<{ reply: string; agentsConsulted: string[] }>('/ai/chat', payload),

  converse: (payload: { message: string; context?: string; history?: { role: 'user' | 'aura'; text: string }[]; pending?: string }) =>
    callAi<{ say: string; do: { type: string; args: Record<string, unknown> }[] }>('/ai/converse', payload),

  plan: (payload: { goal: string; userId: string }) =>
    callAi<{ tasks: unknown[] }>('/ai/plan', payload),

  decide: (payload: { situation: string; userId: string; context?: Record<string, unknown> }) =>
    callAi<{ options: unknown[]; recommendation: string }>('/ai/decide', payload),

  searchShopping: (query: string, maxResults = 20) =>
    getAi<unknown[]>('/ai/shopping/search', { q: query, max_results: maxResults }),

  shoppingPredictions: (params: { userId: string; asOf?: string }) =>
    getAi<Record<string, unknown>>('/ai/shopping/predict', {
      userId: params.userId,
      ...(params.asOf ? { asOf: params.asOf } : {}),
    }),

  logShoppingEvents: (payload: { userId: string; events: Record<string, unknown>[] }) =>
    callAi<{ stored: number; storedIn: string }>('/ai/shopping/events', payload),

  shoppingAssist: (payload: { userId: string; message: string; installedStores?: string[] }) =>
    callAi<Record<string, unknown>>('/ai/shopping/assist', payload),

  shoppingPolicy: (userId: string) => getAi<Record<string, unknown>>('/ai/shopping/policy', { userId }),

  saveShoppingPolicy: async (userId: string, policy: unknown) => {
    const res = await fetch(`${env.pythonAiUrl}/ai/shopping/policy?userId=${encodeURIComponent(userId)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(policy),
    });
    if (!res.ok) throw new AiServiceError(`AI service /ai/shopping/policy failed with ${res.status}: ${await res.text().catch(() => '')}`);
    return (await res.json()) as Record<string, unknown>;
  },

  shoppingPreferences: (userId: string) => getAi<Record<string, unknown>>('/ai/shopping/preferences', { userId }),

  shoppingModel: () => getAi<Record<string, unknown>>('/ai/shopping/model', {}),

  cartAgentStore: (name: string) =>
    getAi<{ key: string | null; name: string; startUrl: string; known: boolean }>('/ai/shopping/browse/store', { name }),

  cartAgentStep: (payload: Record<string, unknown>) =>
    callAi<Record<string, unknown>>('/ai/shopping/browse/step', payload),

  screenStep: (payload: Record<string, unknown>) =>
    callAi<Record<string, unknown>>('/ai/screen/step', payload),

  screenVisualSearch: (payload: { image: string; hint?: string; maxResults?: number }) =>
    callAi<Record<string, unknown>>('/ai/screen/visual-search', payload),

  rankShopping: (products: unknown[]) =>
    callAi<{ data: unknown[]; modelStatus: string }>('/ai/shopping/suggestions', { products }),

  searchFlights: (params: { origin: string; destination: string; departureDate: string; adults?: number }) =>
    getAi<unknown[]>('/ai/travel/flights', {
      origin: params.origin,
      destination: params.destination,
      departureDate: params.departureDate,
      adults: params.adults ?? 1,
    }),

  searchHotels: (params: { destination: string; checkInDate: string; checkOutDate: string; adults?: number }) =>
    getAi<unknown[]>('/ai/travel/hotels', {
      destination: params.destination,
      checkInDate: params.checkInDate,
      checkOutDate: params.checkOutDate,
      adults: params.adults ?? 2,
    }),

  rankTravel: (items: unknown[]) =>
    callAi<{ data: unknown[]; modelStatus: string }>('/ai/travel/suggestions', { items }),

  travelPredictions: (params: { userId: string; asOf?: string }) =>
    getAi<Record<string, unknown>>('/ai/travel/predict', {
      userId: params.userId,
      ...(params.asOf ? { asOf: params.asOf } : {}),
    }),

  logTravelEvent: (payload: Record<string, unknown> & { userId: string; action: string }) =>
    callAi<{ stored: boolean; storedIn: string }>('/ai/travel/events', payload),

  searchResearch: (query: string, maxResults = 10) =>
    getAi<unknown[]>('/ai/research/search', { q: query, max_results: maxResults }),

  health: async () => {
    // short limit: /health must answer fast even while the AI service is busy or still starting
    const res = await fetch(`${env.pythonAiUrl}/ai/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new AiServiceError('AI service health check failed');
    return res.json();
  },
};
