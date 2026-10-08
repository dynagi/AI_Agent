import { FileText, Bookmark, Quote, Share2, FolderPlus, ExternalLink } from 'lucide-react';
import { MoreMenu } from '../ui';
import type { Paper } from '../../data/research';

export function ResearchPaperCard({ p, saved, showSummary, onSummary, onSave, onCite, onAddToProject }: {
  p: Paper; saved: boolean; showSummary: boolean; onSummary: () => void; onSave: () => void; onCite: () => void; onAddToProject: () => void;
}) {
  return (
    <article className="tile stack" style={{ gap: 8 }}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
        <span aria-hidden style={{ width: 54, height: 64, flexShrink: 0, borderRadius: 3, background: 'linear-gradient(180deg,#f5f7fb,#dfe5ee)', display: 'grid', placeItems: 'center', color: '#344256' }}><FileText size={26} /></span>
        <div style={{ minWidth: 0 }}>
          <h4 style={{ margin: 0, fontSize: 14.5, lineHeight: 1.3 }}>{p.title}</h4>
          <div className="t-sub" style={{ marginTop: 3 }}>{p.source} • {p.year}{p.openAccess && <span className="c-green"> • Open Access</span>}</div>
          {p.authors.length > 0 && <div className="t-mute ellipsis" style={{ fontSize: 11.5 }}>{p.authors.slice(0, 3).join(', ')}{p.authors.length > 3 ? ' et al.' : ''}</div>}
        </div>
      </div>
      {showSummary && <p className="t-sub" style={{ fontSize: 12.5, margin: 0, display: '-webkit-box', WebkitLineClamp: 5, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{p.summary}</p>}
      <div className="row wrap" style={{ gap: 6 }}>{p.tags.slice(0, 3).map((t) => <span key={t} className="tag blue">{t}</span>)}</div>
      <div className="row between" style={{ marginTop: 'auto', borderTop: '1px solid var(--aura-border)', paddingTop: 8 }}>
        <button className="btn sm ghost" onClick={onSummary}><FileText size={14} /> Summary</button>
        <button className="btn sm ghost" onClick={onSave} aria-pressed={saved}><Bookmark size={14} fill={saved ? 'currentColor' : 'none'} /> {saved ? 'Saved' : 'Save'}</button>
        <MoreMenu items={[
          { label: 'Copy citation', icon: Quote, onSelect: onCite },
          { label: 'Add to project', icon: FolderPlus, onSelect: onAddToProject },
          ...(p.link ? [{ label: 'Open paper', icon: ExternalLink, onSelect: () => { window.open(p.link, '_blank', 'noopener,noreferrer'); } }] : []),
          { label: 'Copy title', icon: Share2, onSelect: () => navigator.clipboard?.writeText(p.title) },
        ]} />
      </div>
    </article>
  );
}

export const citation = (p: Paper) => `${p.authors.length ? `${p.authors.slice(0, 3).join(", ")}${p.authors.length > 3 ? " et al." : ""}. ` : ""}${p.title}. ${p.source}, ${p.year}.${p.link ? ` ${p.link}` : ""}`;
