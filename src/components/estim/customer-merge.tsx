import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { mergeCandidates, mentionedContacts } from '@/lib/customer-links';
import { useWorkspace } from './workspace-provider';
import { useEstim } from './store-provider';
import { ConfirmDialog } from './confirm-dialog';

// Real mode: customers that are probably the same person (e.g. one wrote by e-mail, the other on
// WhatsApp). Merging keeps each conversation on its own channel; replies still go where they came from.
export function CustomerMerge({ customerId }: { customerId: string }) {
  const { data } = useWorkspace();
  const { actions } = useEstim();
  const [pending, setPending] = useState<{ id: string; name: string } | null>(null);
  const candidates = useMemo(() => {
    if (!data?.company) return [];
    const own = mentionedContacts(data.company.signature ?? '');
    return mergeCandidates({
      customerId,
      customers: data.customers.map(c => ({ id: c.id, name: c.name, phone: c.phone, email: c.email })),
      threads: data.threads.map(t => ({ id: t.id, customer_id: t.customer_id })),
      messages: data.messages.map(m => ({ thread_id: m.thread_id, from: m.from, text: m.text })),
      own: { phones: own.phones, emails: [...own.emails, data.company.reply_to_email ?? '', data.company.inbound_address ?? ''] },
    });
  }, [data, customerId]);
  if (!candidates.length) return null;
  return <div className="merge-hints mt12">
    {candidates.map(c => <div className="merge-hint" key={c.id}>
      <span className="small"><b>Kan vara samma kund: {c.name}</b><span className="muted"> · {c.reason}</span></span>
      <Button variant="prototype" className="btn btn-ghost btn-xs" onClick={() => setPending({ id: c.id, name: c.name })}>Slå ihop</Button>
    </div>)}
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={open => { if (!open) setPending(null); }}
      title={`Slå ihop med ${pending?.name ?? 'kunden'}?`}
      description="Kundernas ärenden samlas under en kund. Varje ärende behåller sin kanal, så svar går fortfarande dit kunden skrev ifrån. Saknade kontaktuppgifter fylls i från den andra kunden."
      confirmLabel="Slå ihop"
      onConfirm={() => { if (pending) actions.mergeCustomers(customerId, pending.id); setPending(null); }}
    />
  </div>;
}
