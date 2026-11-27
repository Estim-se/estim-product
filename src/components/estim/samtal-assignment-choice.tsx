// Unmounted A9 exception view. Host it in the existing quotation review only after shared UI approval.
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Check, LoaderCircle } from 'lucide-react';
export type AssignmentOption = { id: string; job: string; address: string | null };
export function SamtalAssignmentChoice({ options, onConfirm }: { options: AssignmentOption[]; onConfirm: (assignmentId: string | null, requestId: string) => Promise<boolean> }) {
  const [selected, setSelected] = useState<string | undefined>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [done, setDone] = useState(false);
  const [request, setRequest] = useState<string | null>(null);
  const submit = async () => {
    if (selected === undefined || busy) return;
    const id = request ?? crypto.randomUUID(); setRequest(id); setBusy(true); setError(false);
    try { const ok = await onConfirm(selected === 'new' ? null : selected, id); if (ok) setDone(true); else setError(true); }
    catch { setError(true); } finally { setBusy(false); }
  };
  if (done) return <p role="status" className="text-foreground">Uppdraget är valt.</p>;
  return <fieldset disabled={busy} className="space-y-3 border-0 min-w-0">
    <legend className="font-semibold text-foreground">Vilket uppdrag gäller samtalet?</legend>
    {[...options.map(o => ({ id: o.id, label: [o.job, o.address].filter(Boolean).join(' – ') })), { id: 'new', label: 'Nytt uppdrag' }].map(o =>
      <label key={o.id} className="flex items-start gap-2 text-foreground break-words"><input type="radio" name="samtal-assignment" checked={selected === o.id} value={o.id} onChange={() => { setSelected(o.id); setRequest(null); }} /><span className="min-w-0">{o.label}</span></label>)}
    {error && <p role="alert" className="text-destructive">Valet kunde inte sparas. Uppdatera och försök igen.</p>}
    <Button type="button" disabled={selected === undefined || busy} onClick={() => void submit()}>{busy ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <Check aria-hidden="true" />}Bekräfta uppdrag</Button>
  </fieldset>;
}
