import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useWorkspace } from './workspace-provider';

// Saves immediately; embedded inside the AI permissions card on the settings page.
export function CompanyAutoReply({ embedded = false }: { embedded?: boolean }) {
  const workspace = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const serverEnabled = workspace.data?.company?.whatsapp_auto_reply ?? false;
  const enabled = optimistic ?? serverEnabled;
  async function toggle() {
    const next = !serverEnabled;
    setBusy(true); setOptimistic(next); setError('');
    try {
      await workspace.mutate({ kind: 'whatsapp-auto', enabled: next });
      await workspace.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Ändringen kunde inte sparas. Försök igen.'); }
    finally { setOptimistic(null); setBusy(false); }
  }
  const row = <><div className="kop"><b className="grow">AI svarar själv på alla WhatsApp-meddelanden</b><Button type="button" variant="prototype" role="switch" aria-label="AI svarar själv på alla WhatsApp-meddelanden" aria-checked={enabled} disabled={busy||!workspace.data?.company} className={`toggle ${enabled?'on':''}`} onClick={()=>void toggle()}/></div>{error&&<div className="flag" role="alert">{error}</div>}</>;
  return embedded ? row : <section className="card">{row}</section>;
}