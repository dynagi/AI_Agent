import { useMemo, useRef, useState, type FormEvent } from 'react';
import {
  FileText, Users, Search, Bell, Sparkles, Database, StickyNote, Link2, File, Image, Video, Mic, Star, Trash2, PenLine, Paperclip, Save,
  Briefcase, User, Lightbulb, Folder, Plane, IndianRupee, HeartPulse, GraduationCap, Shapes, Globe, Camera, Type, ArrowRight,
} from 'lucide-react';
import { Hud, IconBox, PageHero, NeonButton, NeonTabs, FilterDropdown, Bar, FuturisticModal, HudInput, SyncStatus, toast, type Tone } from '../components/aura';
import { AICommandPanel, domainAsk } from '../components/ai';
import { MemoryCard, memoryMeta } from '../components/memory';
import { memoryCategories, type Memory as Mem, type MemoryCategory, type MemoryType } from '../data/memories';
import { formatWhen } from '../data/transactions';
import { memoriesStore } from '../state/stores';
import { uid } from '../state/store';
import { usePageSearch, matches } from '../state/search';
import { browserVoice } from '../services/voice';
import PhoneLearningCard from '../components/aura/PhoneLearningCard';

const TABS = ['All Memories', 'Notes', 'Links', 'Files', 'Images', 'Videos', 'Voice', 'Favorites', 'Trash'] as const;
type Tab = (typeof TABS)[number];
const tabIcons = { 'All Memories': Database, Notes: StickyNote, Links: Link2, Files: File, Images: Image, Videos: Video, Voice: Mic, Favorites: Star, Trash: Trash2 };
const tabTypes: Partial<Record<Tab, MemoryType[]>> = { Notes: ['Note', 'Idea'], Links: ['Link'], Files: ['File', 'Document'], Images: ['Image', 'Travel'], Videos: ['Video'], Voice: ['Voice'] };
const catMeta: Record<MemoryCategory, [typeof Briefcase, Tone]> = {
  'Work / Career': [Briefcase, 'violet'], Personal: [User, 'amber'], Ideas: [Lightbulb, 'magenta'], Projects: [Folder, 'blue'], Travel: [Plane, 'teal'],
  Finance: [IndianRupee, 'amber'], 'Health & Wellness': [HeartPulse, 'teal'], Learning: [GraduationCap, 'violet'], Others: [Shapes, 'pink'],
};
const readAsDataUrl = (f: File) => new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error); r.readAsDataURL(f); });

function classify(text: string): { type: MemoryType; category: MemoryCategory } {
  const t = text.toLowerCase();
  const type: MemoryType = /^https?:\/\//.test(t) || /www\./.test(t) ? 'Link' : /idea/.test(t) ? 'Idea' : 'Note';
  const category: MemoryCategory = /trip|flight|hotel|travel/.test(t) ? 'Travel' : /₹|save|invest|budget|money/.test(t) ? 'Finance' : /idea|hackathon/.test(t) ? 'Ideas'
    : /project|client|meeting|work/.test(t) ? 'Work / Career' : /paper|course|learn/.test(t) ? 'Learning' : /gym|health|sleep/.test(t) ? 'Health & Wellness' : 'Personal';
  return { type, category };
}

export default function Memory() {
  const mems = memoriesStore.use();
  const q = usePageSearch();
  const [tab, setTab] = useState<Tab>('All Memories');
  const [cat, setCat] = useState<MemoryCategory | null>(null);
  const [capture, setCapture] = useState('');
  const [captureType, setCaptureType] = useState<MemoryType | null>(null);
  const [listening, setListening] = useState(false);
  const [editing, setEditing] = useState<Mem | null>(null);
  const [period, setPeriod] = useState<'This Month' | 'Last Month'>('This Month');
  const fileRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => mems.filter((m) =>
    (tab === 'Trash' ? m.deleted : !m.deleted) && (tab !== 'Favorites' || m.favorite) && (!tabTypes[tab] || tabTypes[tab]!.includes(m.type))
    && (!cat || m.category === cat) && matches(q, m.title, m.body, m.category, m.type, ...(m.bullets ?? []), ...(m.checks ?? []))), [mems, tab, cat, q]);
  const live = mems.filter((m) => !m.deleted);
  const counts = useMemo(() => {
    const c = Object.fromEntries(memoryCategories.map((k) => [k, 0])) as Record<MemoryCategory, number>;
    live.forEach((m) => { c[m.category] += 1; });
    return c;
  }, [live]);
  const monthKey = (d: Date) => d.getFullYear() * 12 + d.getMonth();
  const nowKey = monthKey(new Date());
  const savedThis = live.filter((m) => monthKey(new Date(m.ts)) === nowKey).length;
  const savedLast = live.filter((m) => monthKey(new Date(m.ts)) === nowKey - 1).length;
  const usedCats = memoryCategories.filter((c) => counts[c] > 0).length;
  const topCat = [...memoryCategories].sort((a, b) => counts[b] - counts[a])[0];
  const topShare = live.length ? Math.round((counts[topCat] / live.length) * 100) : 0;

  const patch = (id: string, p: Partial<Mem>) => memoriesStore.set((ms) => ms.map((m) => (m.id === id ? { ...m, ...p } : m)));
  const addMem = (m: Omit<Mem, 'id'>) => memoriesStore.set((ms) => [{ ...m, id: uid('mem') }, ...ms]);

  const save = (e?: FormEvent) => {
    e?.preventDefault();
    const text = capture.trim();
    if (!text) { inputRef.current?.focus(); return; }
    const c = classify(text);
    const type = captureType ?? c.type;
    addMem({ title: text.length > 50 ? `${text.slice(0, 48)}…` : text, body: text, type, category: c.category, ts: new Date().toISOString(), favorite: false });
    setCapture(''); setCaptureType(null);
    toast(`Saved. AURA filed it under ${c.category} as a ${type}.`);
  };
  const onFile = async (f: File | undefined, kind: 'File' | 'Image') => {
    if (!f) return;
    // Files themselves are not uploaded yet: only their details are saved. Small images keep an inline preview.
    const preview = kind === 'Image' && f.size <= 400 * 1024 ? await readAsDataUrl(f).catch(() => undefined) : undefined;
    addMem({ title: f.name, body: `${(f.size / 1024).toFixed(0)} KB · file contents are not uploaded, only this reference is saved`, type: kind === 'Image' ? 'Image' : 'File', category: 'Others', ts: new Date().toISOString(), favorite: false, image: preview });
    toast(`${kind} “${f.name}” noted in your memory.`);
  };
  const voice = () => {
    if (listening) return;
    if (!browserVoice.supported) { toast('Voice capture isn’t supported here — type your note instead.'); setCaptureType('Voice'); inputRef.current?.focus(); return; }
    setListening(true);
    browserVoice.listen((t) => setCapture(t), () => { setListening(false); setCaptureType('Voice'); });
  };

  const ai = domainAsk('memory', () => JSON.stringify(live.slice(0, 60).map((m) => ({ title: m.title, type: m.type, category: m.category, saved: m.ts, text: m.body.slice(0, 300), favorite: m.favorite }))));

  const weekAgo = Date.now() - 7 * 86_400_000;
  const timeline = [...live].sort((a, b) => b.ts.localeCompare(a.ts)).filter((m) => new Date(m.ts).getTime() >= weekAgo).slice(0, 8);

  return (
    <div className="module">
      <div className="main">
        <PageHero title={<>Remember <span className="grad">Smarter</span><br />with <span className="grad">AURA</span></>} lead="Capture, organize, and recall everything that matters." image="/aura/hero-memory.jpg" imageWidth="30%" quote="Your Memories. Better Organized. Always With You."
          feats={[
            { icon: FileText, title: 'Save anything', sub: 'Notes, links, files, images', tone: 'teal' }, { icon: Users, title: 'AI organization', sub: 'Auto-categorize', tone: 'violet' },
            { icon: Search, title: 'Smart search', sub: 'Find in seconds', tone: 'cyan' }, { icon: Bell, title: 'Reminders', sub: 'Never forget', tone: 'teal' }, { icon: Sparkles, title: 'Insights', sub: 'Personalized suggestions', tone: 'teal' },
          ]} />

        <NeonTabs wrap tabs={TABS} value={tab} onChange={(t) => { setTab(t); setCat(null); }} icons={tabIcons} />

        <form className="hud row" onSubmit={save} style={{ padding: '10px 12px' }}>
          <PenLine size={20} className="c-cyan" />
          <input ref={inputRef} style={{ flex: 1, minWidth: 0, background: 'none', border: 0, outline: 0, fontSize: 15, color: '#fff' }} value={capture} onChange={(e) => setCapture(e.target.value)}
            placeholder={listening ? 'Listening…' : captureType ? `Quick capture a ${captureType.toLowerCase()}…` : 'Quick capture... (notes, links, ideas, tasks, anything)'} aria-label="Quick capture" />
          {captureType && <button type="button" className="tag blue" onClick={() => setCaptureType(null)} aria-label="Clear type">{captureType} ×</button>}
          <button type="button" className="icon-btn bare" aria-label="Attach a file" onClick={() => fileRef.current?.click()}><Paperclip size={18} /></button>
          <button type="button" className="icon-btn bare" aria-label="Add an image" onClick={() => imgRef.current?.click()}><Image size={18} /></button>
          <button type="button" className={`icon-btn bare ${listening ? 'c-cyan' : ''}`} aria-label="Capture by voice" onClick={voice}><Mic size={18} /></button>
          <NeonButton variant="ai" type="submit" icon={Save}>Save</NeonButton>
          <input ref={fileRef} type="file" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => void onFile(e.target.files?.[0], 'File')} />
          <input ref={imgRef} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => void onFile(e.target.files?.[0], 'Image')} />
        </form>

        <div className="grid auto-stack" style={{ gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)' }}>
          <Hud corners>
            <div className="row between" style={{ marginBottom: 12 }}>
              <h2 className="section-title" style={{ fontSize: 20 }}>{tab === 'All Memories' ? 'Recent Memories' : tab}{cat && ` · ${cat}`} <span className="t-sub" style={{ fontSize: 13 }}>({visible.length})</span></h2>
              {tab === 'Trash' && visible.length > 0 && <button className="c-red" style={{ background: 'none', border: 0 }} onClick={() => { memoriesStore.set((ms) => ms.filter((m) => !m.deleted)); toast('Trash emptied.'); }}>Empty trash</button>}
              {cat && <button className="c-blue" style={{ background: 'none', border: 0 }} onClick={() => setCat(null)}>Clear category</button>}
            </div>
            <div className="grid g3" style={{ gap: 12 }}>
              {visible.map((m) => (
                <MemoryCard key={m.id} m={m}
                  onFavorite={() => patch(m.id, { favorite: !m.favorite })}
                  onDelete={() => { if (m.deleted) { memoriesStore.set((ms) => ms.filter((x) => x.id !== m.id)); toast('Deleted permanently.'); } else { patch(m.id, { deleted: true }); toast('Moved to Trash.'); } }}
                  onRestore={() => { patch(m.id, { deleted: false }); toast('Restored.'); }}
                  onEdit={() => setEditing(m)}
                  onCopy={() => { navigator.clipboard?.writeText(`${m.title}\n${m.body}`).catch(() => undefined); toast('Copied.'); }} />
              ))}
            </div>
            {!visible.length && <div className="empty">{tab === 'Trash' ? 'Trash is empty.' : `Nothing here${q ? ` matching “${q}”` : ''} yet.`}</div>}
          </Hud>
          <Hud corners title={<span className="section-title" style={{ fontSize: 20 }}>Memory Categories</span>}>
            <div className="list">
              {memoryCategories.map((c) => {
                const [I, tone] = catMeta[c];
                return (
                  <button key={c} className="li" style={{ background: cat === c ? 'rgba(0,175,255,0.1)' : 'none', border: 0, width: '100%', textAlign: 'left', padding: '8px 4px', borderRadius: 3 }} aria-pressed={cat === c} onClick={() => { setCat(cat === c ? null : c); setTab('All Memories'); }}>
                    <IconBox icon={I} tone={tone} size="sm" /><span className="grow">{c}</span><span className="mono">{counts[c]}</span>
                  </button>
                );
              })}
            </div>
          </Hud>
        </div>

        <Hud corners title={<span className="section-title" style={{ fontSize: 20 }}>This Week Timeline</span>}>
          <div className="row" style={{ overflowX: 'auto', gap: 10, paddingBottom: 4 }}>
            {timeline.map((m) => {
              const meta = memoryMeta[m.type];
              return (
                <button key={m.id} className="tile row" style={{ minWidth: 210, gap: 10, textAlign: 'left' }} onClick={() => setEditing(m)}>
                  <IconBox icon={meta.icon} tone={meta.tone} />
                  <div style={{ minWidth: 0 }}><b style={{ fontSize: 13 }}>{formatWhen(m.ts).split(',')[0]}</b><div className="t-mute">{formatWhen(m.ts).split(',')[1] ?? ''}</div><div className="ellipsis" style={{ fontSize: 12, maxWidth: 130 }}>{m.title}</div></div>
                  <ArrowRight size={14} className="t-mute" />
                </button>
              );
            })}
            {!timeline.length && <div className="empty">Nothing saved in the last 7 days.</div>}
          </div>
        </Hud>
        <SyncStatus stores={[memoriesStore]} />
      </div>

      <div className="rail">
        <AICommandPanel title="Ask AURA about your memories" prompts={['What ideas did I save recently?', 'Summarize what I saved this week', 'Find my travel notes']}
          onAsk={ai} cta="Talk to AURA" ctaIcon={Mic} placeholder="Ask about anything you saved…" />
        <Hud corners title={<span className="section-title" style={{ fontSize: 20 }}>Quick Save</span>}>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 8 }}>
            {([[StickyNote, 'Note', 'amber', 'Note'], [Link2, 'Link', 'teal', 'Link'], [File, 'File', 'violet', 'File'], [Image, 'Image', 'blue', 'Image'], [Mic, 'Voice', 'violet', 'Voice'], [Globe, 'Web Clip', 'blue', 'Link'], [Camera, 'Screenshot', 'cyan', 'Image'], [Type, 'Text', 'pink', 'Note']] as const).map(([I, l, tone, type]) => (
              <button key={l} className="tile stack" style={{ alignItems: 'center', gap: 5, padding: 8 }} onClick={() => {
                if (l === 'File') fileRef.current?.click(); else if (l === 'Image' || l === 'Screenshot') imgRef.current?.click(); else if (l === 'Voice') voice();
                else { setCaptureType(type as MemoryType); inputRef.current?.focus(); }
              }}><IconBox icon={I} tone={tone as Tone} size="sm" /><span style={{ fontSize: 11 }}>{l}</span></button>
            ))}
          </div>
        </Hud>
        <Hud corners>
          <div className="row between" style={{ marginBottom: 8 }}><h3 className="section-title" style={{ fontSize: 20 }}>Memory Insights</h3><FilterDropdown value={period} options={['This Month', 'Last Month'] as const} onChange={setPeriod} align="right" /></div>
          <div className="list">
            {([[Database, period === 'This Month' ? savedThis : savedLast, 'Memories saved'], [Shapes, usedCats, 'Categories used'], [Star, live.filter((m) => m.favorite).length, 'Favorites']] as const).map(([I, v, l]) => (
              <div className="li" key={l}><IconBox icon={I} tone="green" size="sm" /><div className="grow"><b style={{ fontSize: 17 }}>{v}</b><div className="t-sub">{l}</div></div></div>
            ))}
            {live.length > 0 && <div className="li"><IconBox icon={Briefcase} tone="green" size="sm" /><div className="grow"><div className="t-sub">Most active category</div><b>{topCat}</b><div style={{ marginTop: 4 }}><Bar value={topShare} tone="blue" /></div></div><span>{topShare}%</span></div>}
          </div>
        </Hud>
        <PhoneLearningCard />
      </div>

      {editing && (
        <FuturisticModal title="Edit Memory" icon={PenLine} onClose={() => setEditing(null)}>
          <form className="stack" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); patch(editing.id, { title: editing.title, body: editing.body, category: editing.category }); setEditing(null); toast('Memory updated.'); }}>
            <HudInput label="Title" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} autoFocus />
            <div className="field"><label htmlFor="mem-body">Content</label><textarea id="mem-body" className="hud-textarea" rows={4} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} /></div>
            <div className="field"><label htmlFor="mem-cat">Category</label><select id="mem-cat" className="select" style={{ height: 44 }} value={editing.category} onChange={(e) => setEditing({ ...editing, category: e.target.value as MemoryCategory })}>{memoryCategories.map((c) => <option key={c}>{c}</option>)}</select></div>
            <div className="row" style={{ justifyContent: 'flex-end' }}><NeonButton type="button" onClick={() => setEditing(null)}>Cancel</NeonButton><NeonButton type="submit" variant="primary">Save</NeonButton></div>
          </form>
        </FuturisticModal>
      )}
    </div>
  );
}
