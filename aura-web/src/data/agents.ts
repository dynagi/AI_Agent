/** Static agent registry (identity, purpose, capabilities, permission scope). Live status comes from state/agentActivity. */
import {
  Plane, ShoppingCart, CalendarCheck, BookOpen, IndianRupee, Heart, MessageCircle, BrainCircuit, Utensils, Shield,
  Network, ListTodo, type LucideIcon,
} from 'lucide-react';
import type { Tone } from '../components/ui';

export type AgentStatus = 'active' | 'analyzing' | 'idle' | 'standby' | 'learning' | 'completed';

export interface Agent {
  id: string;
  name: string;
  icon: LucideIcon;
  tone: Tone;
  status: AgentStatus;
  purpose: string;
  task: string;
  capabilities: string[];
  tools: string[];
  permission: 'Suggest' | 'Prepare' | 'Restricted Execute' | 'Explicit Approval';
  lastActivity: string;
}

export const agents: Agent[] = [
  { id: 'core', name: 'Core Coordinator', icon: Network, tone: 'cyan', status: 'idle', purpose: 'Orchestrates, plans and coordinates all agents', task: 'Waiting for a request', capabilities: ['Orchestration', 'Planning', 'Conflict resolution'], tools: ['Event Bus', 'Decision Engine'], permission: 'Prepare', lastActivity: '—' },
  { id: 'travel', name: 'Travel Agent', icon: Plane, tone: 'blue', status: 'idle', purpose: 'Plans, compares, and books your travel itineraries', task: 'Waiting for a request', capabilities: ['Flight Search & Booking', 'Hotel Recommendations', 'Cost Comparison', 'Itinerary Planning', 'Visa & Travel Document Info', 'Real-time Travel Updates'], tools: ['Google Flights', 'Google Hotels'], permission: 'Explicit Approval', lastActivity: '—' },
  { id: 'productivity', name: 'Productivity Agent', icon: CalendarCheck, tone: 'teal', status: 'idle', purpose: 'Manages your tasks, schedule and focus', task: 'Waiting for a request', capabilities: ['Task breakdown', 'Focus blocks', 'Prioritization'], tools: ['Google Calendar'], permission: 'Prepare', lastActivity: '—' },
  { id: 'research', name: 'Research Agent', icon: BookOpen, tone: 'violet', status: 'idle', purpose: 'Finds and analyzes information', task: 'Waiting for a request', capabilities: ['Paper discovery', 'Summaries', 'Citations'], tools: ['arXiv'], permission: 'Suggest', lastActivity: '—' },
  { id: 'finance', name: 'Finance Agent', icon: IndianRupee, tone: 'green', status: 'idle', purpose: 'Monitors budget and expenses', task: 'Waiting for a request', capabilities: ['Budget tracking', 'Bill reminders', 'Spending insights'], tools: ['Manual ledger'], permission: 'Explicit Approval', lastActivity: '—' },
  { id: 'shopping', name: 'Shopping Agent', icon: ShoppingCart, tone: 'amber', status: 'idle', purpose: 'Tracks orders and reorders essentials', task: 'Waiting for a request', capabilities: ['Price comparison', 'Unit price normalization', 'Reorder tracking'], tools: ['Google Shopping'], permission: 'Explicit Approval', lastActivity: '—' },
  { id: 'wellness', name: 'Wellness Agent', icon: Heart, tone: 'magenta', status: 'idle', purpose: 'Tracks routines and suggests rest', task: 'Waiting for a request', capabilities: ['Routines', 'Hydration', 'Sleep'], tools: ['Manual logs'], permission: 'Suggest', lastActivity: '—' },
  { id: 'communication', name: 'Communication Agent', icon: MessageCircle, tone: 'blue', status: 'idle', purpose: 'Drafts and manages messages', task: 'Waiting for a request', capabilities: ['Email drafting', 'Summaries', 'Follow-ups'], tools: [], permission: 'Explicit Approval', lastActivity: '—' },
  { id: 'memory', name: 'Memory Agent', icon: BrainCircuit, tone: 'cyan', status: 'idle', purpose: 'Remembers your preferences and context', task: 'Waiting for a request', capabilities: ['Recall', 'Categorization'], tools: ['Supabase'], permission: 'Prepare', lastActivity: '—' },
  { id: 'food', name: 'Food Agent', icon: Utensils, tone: 'red', status: 'idle', purpose: 'Finds best food options and orders for you', task: 'Waiting for a request', capabilities: ['Menu search', 'Diet preferences'], tools: [], permission: 'Explicit Approval', lastActivity: '—' },
  { id: 'calendar', name: 'Calendar Agent', icon: ListTodo, tone: 'teal', status: 'idle', purpose: 'Detects conflicts and protects focus time', task: 'Waiting for a request', capabilities: ['Conflict detection', 'Travel buffers'], tools: ['Google Calendar'], permission: 'Prepare', lastActivity: '—' },
  { id: 'security', name: 'Security Agent', icon: Shield, tone: 'violet', status: 'idle', purpose: 'Keeps your data safe and private', task: 'Waiting for a request', capabilities: ['Scope audit', 'Anomaly alerts'], tools: ['Audit log'], permission: 'Suggest', lastActivity: '—' },
];

export const agentById = (id: string) => agents.find((a) => a.id === id);

export const statusTone: Record<AgentStatus, 'green' | 'amber' | 'cyan' | 'violet' | 'off'> = {
  active: 'green', analyzing: 'amber', idle: 'off', standby: 'amber', learning: 'violet', completed: 'cyan',
};
