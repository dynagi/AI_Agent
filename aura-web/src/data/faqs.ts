export interface Faq { q: string; a: string }
export const faqs: Faq[] = [
  { q: 'What is AURA?', a: 'AURA (Autonomous User Reasoning Assistant) is a personal AI co-pilot. It understands your situation, consults specialized agents, explains trade-offs, and acts only with your authorization.' },
  { q: 'Is my data safe?', a: 'Yes. Data is protected with row-level security, scoped integration tokens and audit logs. Agents only see the context their role needs, and you can export or delete your data anytime.' },
  { q: 'Which apps can AURA connect to?', a: 'Google Calendar, Gmail, Drive, Maps, MakeMyTrip, IRCTC, Uber, Ola, Swiggy, Zomato, Amazon, Flipkart, Slack, Notion and more — through official APIs, deep links and authorized handoffs.' },
  { q: 'Is there a free plan?', a: 'Yes. The Free plan includes basic AI chat, one personal assistant agent, simple task automation and up to 3 connected apps.' },
  { q: 'Can I upgrade later?', a: 'Anytime. Upgrade or downgrade from Plans & Pricing — your data, agents and settings carry over.' },
  { q: 'How is AURA different from other AI tools?', a: 'Most assistants execute single commands. AURA reasons across your calendar, budget, tasks and preferences, coordinates multiple agents, shows options with trade-offs, and asks before consequential actions.' },
];
