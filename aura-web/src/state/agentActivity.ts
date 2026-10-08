import { useMemo } from 'react';
import { createStore } from './store';
import { agents, type Agent, type AgentStatus } from '../data/agents';

export interface ActivityEntry { agent: string; text: string; time: string }
interface AgentLive { status: AgentStatus; task: string; lastActivity: string }

/** Live agent activity for this session, fed by real chat/decision responses. */
export const agentLiveStore = createStore<Record<string, AgentLive>>({});
export const activityStore = createStore<ActivityEntry[]>([]);

const clock = () => new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

export function recordAgentActivity(agentIds: string[], text: string, status: AgentStatus = 'completed') {
  const time = clock();
  agentLiveStore.set((s) => ({ ...s, ...Object.fromEntries(agentIds.map((id) => [id, { status, task: text, lastActivity: time }])) }));
  activityStore.set((a) => [...agentIds.map((agent) => ({ agent, text, time })), ...a].slice(0, 50));
}

export function useAgents(): Agent[] {
  const live = agentLiveStore.use();
  return useMemo(() => agents.map((a) => (live[a.id] ? { ...a, ...live[a.id] } : a)), [live]);
}
