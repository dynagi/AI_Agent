import { automationsStore, runsStore, type RunLog } from './stores';
import { uid } from './store';
import { toast } from '../components/ui';
import type { Automation, AutoTemplate } from '../data/automations';
import type { Draft } from '../components/automations';
import { aura } from '../services/aura';

const stamp = () => new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).replace(',', '').replace(/,(?= \d+:)/, ' •');

/** Shared automation commands used by Automation Hub + Automations. */
export const automationActions = {
  toggle(a: Automation, active: boolean) {
    automationsStore.set((as) => as.map((x) => (x.id === a.id ? { ...x, active } : x)));
    toast(`${a.name} ${active ? 'activated' : 'paused'}.`);
  },
  /** There is no external execution engine yet: a run asks AURA to prepare the actions and logs them for review. Nothing is sent or changed elsewhere. */
  async run(a: Automation) {
    toast(`Preparing “${a.name}”…`);
    let status: RunLog['status'] = 'Awaiting approval';
    let summary = '';
    try {
      const steps = a.steps?.length ? a.steps.join('; ') : a.description;
      summary = (await aura.chat(`Prepare the exact actions for my automation "${a.name}". Trigger: ${a.trigger ?? a.schedule}. Steps: ${steps}. List what you would do; do not claim anything was executed.`)).text;
    } catch {
      status = 'Failed';
      summary = 'AURA could not prepare this run. Try again later.';
    }
    runsStore.set((rs) => [{ id: uid('rn'), name: a.name, when: stamp(), status, summary }, ...rs].slice(0, 30));
    automationsStore.set((as) => as.map((x) => (x.id === a.id ? { ...x, lastRunAt: new Date().toISOString() } : x)));
    toast(status === 'Failed' ? `${a.name} could not be prepared.` : `${a.name}: actions prepared for your review. Nothing was executed.`);
  },
  duplicate(a: Automation) {
    automationsStore.set((as) => [...as, { ...a, id: uid('au'), name: `${a.name} (copy)`, active: false, featured: false }]);
    toast('Duplicated as a paused copy.');
  },
  remove(a: Automation) {
    automationsStore.set((as) => as.filter((x) => x.id !== a.id));
    toast(`Deleted “${a.name}”.`);
  },
  fromTemplate(t: AutoTemplate) {
    automationsStore.set((as) => [...as, { id: uid('au'), name: t.name, description: t.description, icon: t.icon, tone: t.tone, tags: t.tags, category: t.category, schedule: t.schedule, active: false }]);
    toast(`“${t.name}” added (paused). Turn it on when you're ready.`);
  },
  fromDraft(d: Draft, existing?: Automation) {
    if (existing) {
      automationsStore.set((as) => as.map((x) => (x.id === existing.id ? { ...x, name: d.name, description: d.description, trigger: d.trigger, steps: d.steps, needsApproval: d.needsApproval, schedule: d.schedule } : x)));
      toast('Automation updated.');
      return;
    }
    automationsStore.set((as) => [...as, {
      id: uid('au'), name: d.name, description: d.description, icon: 'spark', tone: 'cyan', tags: [d.category, d.needsApproval ? 'Approval gate' : 'Auto'],
      category: d.category, schedule: d.schedule, active: false, trigger: d.trigger, steps: d.steps, needsApproval: d.needsApproval,
    }]);
    toast(`“${d.name}” created (paused).`);
  },
  toDraft(a: Automation): Draft {
    return { name: a.name, description: a.description, category: a.category, trigger: a.trigger ?? (a.schedule.startsWith('Runs daily') ? 'Every day at 8:00 AM' : 'When I ask AURA'), steps: a.steps ?? [a.description], schedule: a.schedule, needsApproval: !!a.needsApproval };
  },
};
