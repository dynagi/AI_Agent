import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { aura } from '../services/aura';
import { toast } from './ui';
import { FuturisticModal, NeonButton } from './aura';

/** Explicit-approval gate for consequential actions (Autonomy Level 4). */
export default function ApprovalModal({ action, details, onApproved, onClose }: { action: string; details: string[]; onApproved?: () => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const approve = async () => {
    setBusy(true);
    try {
      const res = await aura.approve(action, { details });
      onApproved?.();
      toast(res.message);
    } catch {
      toast('Could not record your approval. Nothing was changed.');
    } finally {
      setBusy(false);
      onClose();
    }
  };
  return (
    <FuturisticModal title="Approval required" icon={ShieldAlert} tone="amber" onClose={onClose}>
      <p style={{ marginBottom: 12 }}>AURA wants to: <b>{action}</b></p>
      <ul className="t-sub" style={{ margin: '0 0 14px', paddingLeft: 18, lineHeight: 1.8 }}>
        {details.map((d) => <li key={d}>{d}</li>)}
      </ul>
      <p className="t-mute" style={{ marginBottom: 18 }}>Nothing is executed until you approve. AURA never reports an external action as done unless a provider confirms it.</p>
      <div className="row wrap" style={{ justifyContent: 'flex-end' }}>
        <NeonButton variant="danger" onClick={onClose}>Reject</NeonButton>
        <NeonButton onClick={onClose}>Modify</NeonButton>
        <NeonButton variant="primary" onClick={approve} disabled={busy}>{busy ? <span className="spinner" /> : 'Approve'}</NeonButton>
      </div>
    </FuturisticModal>
  );
}
