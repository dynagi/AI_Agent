import { CloudOff, Loader2 } from 'lucide-react';
import type { createRecordStore } from '../../state/store';

type AnyRecordStore = Pick<ReturnType<typeof createRecordStore<{ id: string }>>, 'useMeta' | 'reload'>;

/** Shows loading / error state for one or more persisted stores. Renders nothing when everything is in sync. */
export default function SyncStatus({ stores }: { stores: AnyRecordStore[] }) {
  const metas = stores.map((s) => s.useMeta());
  const error = metas.find((m) => m.status === 'error');
  const loading = metas.some((m) => m.status === 'loading');
  if (error) {
    const needsLogin = /bearer|sign in|401|jwt/i.test(error.error);
    return (
      <div className="tag amber" role="alert" style={{ padding: '8px 12px', whiteSpace: 'normal', display: 'flex', gap: 8, alignItems: 'center' }}>
        <CloudOff size={16} />
        <span style={{ flex: 1 }}>{needsLogin ? 'Sign in to load and save your data.' : error.error}</span>
        <button className="btn sm" onClick={() => stores.forEach((s) => void s.reload())}>Retry</button>
      </div>
    );
  }
  if (loading) return <div className="row t-sub" style={{ fontSize: 13 }}><Loader2 size={14} className="spin" /> Loading your data…</div>;
  return null;
}
