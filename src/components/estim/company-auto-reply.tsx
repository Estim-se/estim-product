import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useWorkspace } from './workspace-provider';

// Saves immediately; embedded inside the AI permissions card on the settings page.
export function CompanyAutoReply({ embedded = false }: { embedded?: boolean }) {
  const workspace = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const enabled = workspace.data?.company?.whatsapp_auto_reply ?? false;
  async function toggle() {
    setBusy(true); setError('');
    try {
      await workspace.mutate({ kind: 'whatsapp-auto', enabled: !enabled });
      await workspace.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Ändringen kunde inte sparas. Försök igen.'); }
    finally { setBusy(false); }
  }
  const row = <><div className="kop"><b className="grow">AI svarar själv på alla WhatsApp-meddelanden</b><Button type="button" variant="prototype" role="switch" aria-label="AI svarar själv på alla WhatsApp-meddelanden" aria-checked={enabled} disabled={busy||!workspace.data?.company} className={`toggle ${enabled?'on':''}`} onClick={()=>void toggle()}/></div>{error&&<div className="flag" role="alert">{error}</div>}</>;
  return embedded ? row : <section className="card">{row}</section>;
}