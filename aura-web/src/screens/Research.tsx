import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Search, FileText, Lightbulb, BarChart3, PenLine, Folder, StickyNote, ListTree, Download, Quote, CalendarDays, MessagesSquare, Mic,
  ArrowRight, Plus, Trash2, Pencil, BookOpen, BookMarked, ExternalLink,
} from 'lucide-react';
import { Hud, IconBox, PageHero, NeonButton, NeonTabs, FilterDropdown, MoreMenu, FuturisticModal, HudInput, SyncStatus, toast, type Tone } from '../components/aura';
import { AICommandPanel, domainAsk, type AIReply } from '../components/ai';
import { ResearchPaperCard, citation } from '../components/research';
import type { Paper, ResearchProject } from '../data/research';
import { savedPapersStore, projectsStore, memoriesStore } from '../state/stores';
import { uid } from '../state/store';
import { aura } from '../services/aura';
import { apiGet } from '../services/api';
import { usePageSearch } from '../state/search';

const TABS = ['Literature Search', 'My Research', 'Paper Summarizer', 'Idea Generator', 'Citation & Writing', 'Data Analysis'] as const;
type Tab = (typeof TABS)[number];
const tabIcons = { 'Literature Search': Search, 'My Research': Folder, 'Paper Summarizer': FileText, 'Idea Generator': Lightbulb, 'Citation & Writing': Quote, 'Data Analysis': BarChart3 };
const YEARS = ['Any time', 'Last 5 Years', 'Last 2 Years'] as const;
const TOPICS = ['Generative AI', 'Machine Learning', 'Cyber Security', 'Data Engineering', 'Healthcare AI', 'Climate Change', 'Robotics', 'Quantum Computing', 'NLP'];

interface ApiPaper { title: string; summary: string; authors: string[]; link: string; published: string }
const toPaper = (p: ApiPaper): Paper => ({
  id: p.link || p.title, title: p.title.replace(/\s+/g, ' '), source: 'arXiv', year: Number(p.published.slice(0, 4)) || 0, field: '', openAccess: true,
  summary: p.summary.replace(/\s+/g, ' '), tags: [], keyPoints: [], authors: p.authors, link: p.link,
});

const projectTones: ResearchProject['tone'][] = ['violet', 'blue', 'teal', 'magenta', 'cyan'];
const updatedLabel = (iso: string) => `Updated ${new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

export default function Research() {
  const hq = usePageSearch();
  const saved = savedPapersStore.use();
  const projects = projectsStore.use();
  const [tab, setTab] = useState<Tab>('Literature Search');
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState('');
  const [years, setYears] = useState<(typeof YEARS)[number]>('Any time');
  const [summaries, setSummaries] = useState(true);
  const [found, setFound] = useState<Paper[]>([]);
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'error'; error: string }>({ status: 'idle', error: '' });
  const [summary, setSummary] = useState<{ paper: Paper; text: string; loading: boolean } | null>(null);
  const [projDialog, setProjDialog] = useState<ResearchProject | 'new' | null>(null);
  const [projName, setProjName] = useState('');
  const [trigger, setTrigger] = useState<{ prompt: string; id: number } | null>(null);
  const seq = useRef(0);

  const search = async (term: string) => {
    const t = term.trim();
    if (!t) return [];
    const mine = ++seq.current;
    setApplied(t);
    setQuery(t);
    setTab('Literature Search');
    setState({ status: 'loading', error: '' });
    try {
      const res = await apiGet<{ data: ApiPaper[] }>('/research/search', { q: t });
      const papers = res.data.map(toPaper);
      if (mine === seq.current) { setFound(papers); setState({ status: 'idle', error: '' }); }
      return papers;
    } catch (e) {
      if (mine === seq.current) { setFound([]); setState({ status: 'error', error: e instanceof Error ? e.message : 'Search failed' }); }
      return [];
    }
  };
  const runSearch = (e?: FormEvent) => { e?.preventDefault(); void search(query); };

  useEffect(() => {
    if (hq.trim().length > 2) { const id = setTimeout(() => void search(hq), 500); return () => clearTimeout(id); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hq]);

  const minYear = years === 'Last 5 Years' ? new Date().getFullYear() - 4 : years === 'Last 2 Years' ? new Date().getFullYear() - 1 : 0;
  const savedIds = useMemo(() => new Set(saved.map((p) => p.id)), [saved]);
  const list = (tab === 'My Research' ? saved : found).filter((p) => p.year >= minYear);

  const toggleSave = (p: Paper) => {
    const on = savedIds.has(p.id);
    savedPapersStore.set((s) => (on ? s.filter((x) => x.id !== p.id) : [...s, p]));
    toast(on ? 'Removed from saved papers.' : `Saved “${p.title.slice(0, 40)}…”`);
  };
  const cite = (p: Paper) => { navigator.clipboard?.writeText(citation(p)).catch(() => undefined); toast('Citation copied to clipboard.'); };
  const addToProject = (p: Paper) => {
    const target = projects[projects.length - 1];
    if (!target) { toast('Create a research project first, then add papers to it.'); setProjName(''); setProjDialog('new'); return; }
    if (!savedIds.has(p.id)) savedPapersStore.set((s) => [...s, p]);
    projectsStore.set((ps) => ps.map((x) => (x.id === target.id ? { ...x, paperIds: [...new Set([...x.paperIds, p.id])], updated: new Date().toISOString() } : x)));
    toast(`Added to “${target.name}”.`);
  };

  const openSummary = async (paper: Paper) => {
    setSummary({ paper, text: '', loading: true });
    try {
      const r = await aura.chat(`Summarize this research paper in 3-4 short bullet points of key takeaways. Title: ${paper.title}. Abstract: ${paper.summary}`);
      setSummary({ paper, text: r.text, loading: false });
    } catch {
      setSummary({ paper, text: 'AURA could not generate a summary right now. The abstract is shown above.', loading: false });
    }
  };

  const chat = domainAsk('research', () => JSON.stringify({
    lastSearch: applied,
    results: found.slice(0, 8).map((p) => ({ title: p.title, year: p.year, abstract: p.summary.slice(0, 300) })),
    savedPapers: saved.slice(0, 12).map((p) => p.title),
  }));
  const ai = async (p: string): Promise<AIReply> => {
    const m = p.match(/^(?:find|search(?: for)?|latest papers on|papers on|look up)\s+(?:the\s+)?(?:latest\s+)?(?:papers?\s+)?(?:on|about)?\s*(.+)/i);
    if (m) {
      const papers = await search(m[1]);
      return papers.length
        ? { text: `Found ${papers.length} papers on “${m[1]}” on arXiv. The most recent is “${[...papers].sort((a, b) => b.year - a.year)[0].title}”. They're listed on the left.` }
        : { text: `I couldn't find papers for “${m[1]}”. Try different keywords.` };
    }
    return chat(p);
  };

  const tools: [typeof FileText, string, Tone, string][] = [
    [FileText, 'Paper Summarizer', 'blue', 'Summarize the top paper in my results'], [Quote, 'Citation Generator', 'red', 'Format citations for my saved papers'], [CalendarDays, 'Research Planner', 'teal', 'Help me write a research proposal'],
    [MessagesSquare, 'Concept Q&A', 'green', 'Explain this concept simply'], [BarChart3, 'Data Analysis', 'violet', 'Suggest a data analysis plan'], [Lightbulb, 'Idea Brainstormer', 'magenta', 'Generate research ideas'],
  ];
  const papersInProjects = new Set(projects.flatMap((p) => p.paperIds)).size;

  return (
    <div className="module">
      <div className="main">
        <PageHero title={<>Research <span className="grad">Smarter</span><br />with <span className="grad">AURA</span></>} lead="Discover, analyze, and create research with the power of AI." image="/aura/hero-research.jpg" imageWidth="24%" quote="From curiosity to discovery, AURA is with you."
          feats={[
            { icon: Search, title: 'Find papers', sub: 'Live from arXiv' }, { icon: FileText, title: 'Summarize', sub: 'Get key insights instantly', tone: 'violet' },
            { icon: Lightbulb, title: 'Generate ideas', sub: 'For your next project', tone: 'amber' }, { icon: BarChart3, title: 'Analyze data', sub: 'With AI tools' }, { icon: PenLine, title: 'Write & cite', sub: 'In your style', tone: 'violet' },
          ]} />

        <NeonTabs wrap tabs={TABS} value={tab} onChange={(t) => { setTab(t); if (t === 'Paper Summarizer') setTrigger({ prompt: 'Summarize the top paper in my results', id: Date.now() }); if (t === 'Idea Generator') setTrigger({ prompt: 'Generate research ideas', id: Date.now() }); if (t === 'Citation & Writing') setTrigger({ prompt: 'Help me write a research proposal', id: Date.now() }); if (t === 'Data Analysis') setTrigger({ prompt: 'Suggest a data analysis plan', id: Date.now() }); }} icons={tabIcons} />

        <Hud corners>
          <h2 className="section-title" style={{ fontSize: 20, marginBottom: 12 }}>{tab === 'My Research' ? `My Saved Papers (${saved.length})` : 'Search Research Papers'}</h2>
          <form className="row" onSubmit={runSearch} role="search">
            <div className="input" style={{ flex: 1 }}><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search arXiv by topic, title or author…" aria-label="Search research papers" /></div>
            <NeonButton variant="ai" type="submit" disabled={state.status === 'loading' || !query.trim()}>{state.status === 'loading' ? <span className="spinner" /> : <Search size={17} />} Search</NeonButton>
          </form>
          <div className="row wrap" style={{ margin: '12px 0' }}>
            <FilterDropdown value={years} options={YEARS} onChange={setYears} />
            <label className="row t-sub" style={{ cursor: 'pointer' }}><input type="checkbox" className="check" checked={summaries} onChange={(e) => setSummaries(e.target.checked)} /> Show abstracts</label>
          </div>
          <div className="t-sub" style={{ marginBottom: 8 }}>Quick Topics</div>
          <div className="row wrap" style={{ gap: 8 }}>
            {TOPICS.map((t) => <button key={t} className={`chip ${applied === t ? 'active' : ''}`} onClick={() => void search(t)}>{t}</button>)}
            {applied && <button className="chip" onClick={() => { setApplied(''); setQuery(''); setFound([]); }}>Clear</button>}
          </div>
        </Hud>

        <Hud corners>
          <div className="row between" style={{ marginBottom: 12 }}>
            <h2 className="section-title" style={{ fontSize: 20 }}>{tab === 'My Research' ? 'Saved papers' : applied ? `Results for “${applied}” (${list.length})` : 'Search to find papers'}</h2>
            <button className="c-blue row" style={{ background: 'none', border: 0 }} onClick={() => setTab(tab === 'My Research' ? 'Literature Search' : 'My Research')}>{tab === 'My Research' ? 'Search' : 'Saved'} <ArrowRight size={14} /></button>
          </div>
          {state.status === 'loading' && <div className="empty"><span className="spinner" /> Searching arXiv…</div>}
          {state.status === 'error' && <div className="tag red" role="alert" style={{ padding: 10, whiteSpace: 'normal' }}>{/bearer|401/i.test(state.error) ? 'Sign in to search papers.' : state.error}</div>}
          <div className="grid g3" style={{ gap: 12 }}>
            {list.map((p) => <ResearchPaperCard key={p.id} p={p} saved={savedIds.has(p.id)} showSummary={summaries} onSummary={() => void openSummary(p)} onSave={() => toggleSave(p)} onCite={() => cite(p)} onAddToProject={() => addToProject(p)} />)}
          </div>
          {state.status === 'idle' && !list.length && <div className="empty">{tab === 'My Research' ? 'No saved papers yet — tap Save on any paper.' : applied ? 'No papers match these filters.' : 'Enter a topic above or pick a quick topic. Results come live from arXiv — always verify sources before citing.'}</div>}
        </Hud>

        <div className="grid g2">
          <Hud corners title="Research Insights">
            <div className="grid g3" style={{ gap: 8 }}>
              {([[BookOpen, saved.length, 'Papers Saved', 'blue'], [Folder, projects.length, 'Research Projects', 'magenta'], [BookMarked, papersInProjects, 'Papers in Projects', 'amber']] as const).map(([I, v, l, tone]) => (
                <div className="tile" key={l} style={{ padding: 10 }}><IconBox icon={I} tone={tone as Tone} size="sm" /><b style={{ fontSize: 18, display: 'block', marginTop: 6 }}>{v}</b><div className="t-sub" style={{ fontSize: 11.5 }}>{l}</div></div>
              ))}
            </div>
          </Hud>
          <Hud corners title="Research Tools">
            <div className="grid g3" style={{ gap: 8 }}>
              {tools.map(([I, l, tone, prompt]) => <button key={l} className="tile stack" style={{ alignItems: 'center', gap: 6, textAlign: 'center', padding: 10 }} onClick={() => setTrigger({ prompt, id: Date.now() })}><IconBox icon={I} tone={tone} size="sm" /><span style={{ fontSize: 11.5 }}>{l}</span></button>)}
            </div>
          </Hud>
        </div>
        <SyncStatus stores={[savedPapersStore, projectsStore]} />
      </div>

      <div className="rail">
        <AICommandPanel title="AI Research Assistant" header={<p className="t-sub" style={{ marginBottom: 10, fontSize: 14 }}>Ask me anything about research:</p>}
          prompts={['Find latest papers on retrieval augmented generation', 'Summarize the top paper in my results', 'Explain this concept simply', 'Help me write a research proposal']} promptStyle="boxes"
          onAsk={ai} cta="Talk to AURA" ctaIcon={Mic} placeholder="Ask a research question…" trigger={trigger} />
        <Hud corners title="My Research Projects" action="New" onAction={() => { setProjName(''); setProjDialog('new'); }}>
          <div className="list">
            {projects.map((p) => (
              <div className="li" key={p.id}>
                <IconBox icon={Folder} tone={p.tone} size="lg" />
                <div className="grow"><div className="t-title">{p.name}</div><div className="t-sub">{p.paperIds.length} papers • {updatedLabel(p.updated)}</div></div>
                <MoreMenu items={[
                  { label: 'Rename', icon: Pencil, onSelect: () => { setProjName(p.name); setProjDialog(p); } },
                  { label: 'Delete', icon: Trash2, danger: true, onSelect: () => { projectsStore.set((ps) => ps.filter((x) => x.id !== p.id)); toast(`Deleted “${p.name}”.`); } },
                ]} />
              </div>
            ))}
            {!projects.length && <div className="empty">No projects yet.</div>}
          </div>
          <NeonButton variant="ai" block icon={Plus} style={{ marginTop: 10 }} onClick={() => { setProjName(''); setProjDialog('new'); }}>New Research Project</NeonButton>
        </Hud>
        <Hud corners title="Quick Actions">
          <div className="grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 8 }}>
            {([
              [StickyNote, 'New Note', () => { memoriesStore.set((ms) => [{ id: uid('mem'), title: 'Research note', body: applied ? `Notes on: ${applied}` : 'Research note', type: 'Note', category: 'Learning', ts: new Date().toISOString(), favorite: false }, ...ms]); toast('Note added to Memory.'); }],
              [ListTree, 'Create Outline', () => setTrigger({ prompt: 'Help me write a research proposal', id: Date.now() })],
              [Download, 'Export Citations', () => { navigator.clipboard?.writeText(saved.map(citation).join('\n')).catch(() => undefined); toast(saved.length ? `${saved.length} citations copied.` : 'Save papers first to export citations.'); }],
            ] as const).map(([I, l, fn]) => <button key={l} className="stack" style={{ background: 'none', border: 0, alignItems: 'center', gap: 6, textAlign: 'center' }} onClick={fn}><IconBox icon={I} tone="blue" size="lg" /><span style={{ fontSize: 11.5 }}>{l}</span></button>)}
          </div>
        </Hud>
      </div>

      {summary && (
        <FuturisticModal title="AI Summary" icon={FileText} onClose={() => setSummary(null)}>
          <b>{summary.paper.title}</b>
          <div className="t-sub" style={{ margin: '4px 0 10px' }}>{summary.paper.source} • {summary.paper.year}{summary.paper.authors.length ? ` • ${summary.paper.authors.slice(0, 3).join(', ')}${summary.paper.authors.length > 3 ? ' et al.' : ''}` : ''}</div>
          {summary.loading ? <div className="row t-sub"><span className="spinner" /> AURA is reading the abstract…</div> : <p style={{ marginBottom: 10, whiteSpace: 'pre-line' }}>{summary.text}</p>}
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
            {summary.paper.link && <a className="btn" href={summary.paper.link} target="_blank" rel="noopener noreferrer">Open paper <ExternalLink size={13} /></a>}
            <NeonButton icon={Quote} onClick={() => cite(summary.paper)}>Copy citation</NeonButton>
            <NeonButton variant="primary" onClick={() => { toggleSave(summary.paper); setSummary(null); }}>{savedIds.has(summary.paper.id) ? 'Unsave' : 'Save paper'}</NeonButton>
          </div>
        </FuturisticModal>
      )}
      {projDialog && (
        <FuturisticModal title={projDialog === 'new' ? 'New Research Project' : 'Rename Project'} icon={Folder} onClose={() => setProjDialog(null)}>
          <form className="stack" style={{ gap: 12 }} onSubmit={(e) => {
            e.preventDefault();
            if (!projName.trim()) return;
            if (projDialog === 'new') projectsStore.set((ps) => [...ps, { id: uid('rp'), name: projName.trim(), paperIds: [], updated: new Date().toISOString(), tone: projectTones[ps.length % projectTones.length] }]);
            else projectsStore.set((ps) => ps.map((x) => (x.id === projDialog.id ? { ...x, name: projName.trim() } : x)));
            toast(projDialog === 'new' ? `Project “${projName}” created.` : 'Project renamed.');
            setProjDialog(null);
          }}>
            <HudInput label="Project name" value={projName} onChange={(e) => setProjName(e.target.value)} autoFocus />
            <div className="row" style={{ justifyContent: 'flex-end' }}><NeonButton type="button" onClick={() => setProjDialog(null)}>Cancel</NeonButton><NeonButton type="submit" variant="primary">Save</NeonButton></div>
          </form>
        </FuturisticModal>
      )}
    </div>
  );
}
