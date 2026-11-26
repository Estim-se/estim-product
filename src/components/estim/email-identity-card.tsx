import { useEffect, useMemo, useState } from 'react';
import type { Thread } from '@/data/inbox';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from './confirm-dialog';
import { useEstim } from './store-provider';
import { useWorkspace } from './workspace-provider';

const HEADINGS = {
  form: 'Godkänn avsändare (formulärmejl)',
  unverified: 'Overifierad avsändare',
  no_reply: 'Avsändare saknar e-post',
} as const;

const DESCRIPTIONS = {
  form: 'Uppgifterna kommer från ett formulärmejl. Kontrollera dem innan du kopplar till en kund eller svarar.',
  unverified: 'Avsändaren kunde inte verifieras. Kontrollera att mejlet är äkta innan du godkänner uppgifterna.',
  no_reply: 'Mejlet kom från en no-reply-adress utan kundmejl. Fyll i eller kontrollera kunduppgifterna nedan.',
} as const;

/**
 * Steps 8–9 (D17/D18): renders only for real-mode threads that have a quarantined `pendingSender`
 * suggestion ("Godkänn avsändare") or a `suggestedMergeThreadId` 1-click merge hint ("Slå ihop tråd").
 * Ordinary threads render nothing here so existing inbox layout stays unchanged.
 */
export function EmailIdentityCard({ thread: t }: { thread: Thread }) {
  const { state, actions } = useEstim();
  const { mode, data } = useWorkspace();
  const pending = t.pendingSender ?? null;
  const [name, setName] = useState(pending?.name ?? '');
  const [email, setEmail] = useState(pending?.email ?? '');
  const [phone, setPhone] = useState(pending?.phone ?? '');
  const [confirmMerge, setConfirmMerge] = useState(false);

  useEffect(() => {
    setName(pending?.name ?? '');
    setEmail(pending?.email ?? '');
    setPhone(pending?.phone ?? '');
  }, [t.id, pending?.name, pending?.email, pending?.phone]);

  const matchingCustomer = useMemo(() => {
    if (!pending || !data?.customers?.length) return null;
    const targetEmail = email.trim().toLowerCase();
    if (!targetEmail) return null;
    return data.customers.find(
      c => c.id !== t.customerId && (c.email ?? '').trim().toLowerCase() === targetEmail,
    ) ?? null;
  }, [pending, data?.customers, email, t.customerId]);

  const mergeTarget = useMemo(() => {
    if (!t.suggestedMergeThreadId || t.suggestedMergeThreadId === t.id) return null;
    return state.threads.find(x => x.id === t.suggestedMergeThreadId) ?? null;
  }, [t.suggestedMergeThreadId, t.id, state.threads]);

  if (mode !== 'real' || (!pending && !mergeTarget)) return null;

  return (
    <>
      {pending && (
        <div className="card">
          <h3>{HEADINGS[pending.source]}</h3>
          <p className="small muted mt8">{DESCRIPTIONS[pending.source]}</p>
          <div className="mt8" style={{ display: 'grid', gap: 8 }}>
            <input
              className="input"
              aria-label="Föreslaget namn"
              placeholder="Namn"
              value={name}
              onChange={e => setName(e.target.value)}
            />
            <input
              className="input"
              aria-label="Föreslagen e-post"
              type="email"
              placeholder="E-post"
              value={email}
              onChange={e => setEmail(e.target.value)}
            />
            <input
              className="input"
              aria-label="Föreslaget telefonnummer"
              placeholder="Telefon"
              value={phone}
              onChange={e => setPhone(e.target.value)}
            />
          </div>
          <div className="row wrap mt12" style={{ gap: 8 }}>
            <Button
              variant="prototype"
              className="btn btn-primary btn-xs"
              onClick={() => actions.approveEmailSender(t.id, { name, email, phone })}
            >
              Godkänn avsändare
            </Button>
            {matchingCustomer && (
              <Button
                variant="prototype"
                className="btn btn-ghost btn-xs"
                onClick={() => actions.approveEmailSender(t.id, { name, email, phone, useCustomerId: matchingCustomer.id })}
              >
                Koppla till {matchingCustomer.name}
              </Button>
            )}
          </div>
        </div>
      )}

      {mergeTarget && (
        <div className="card">
          <h3>Möjlig fortsättning</h3>
          <p className="small muted mt8">
            Samma avsändare har redan en öppen tråd: <b>{mergeTarget.job}</b>
          </p>
          <div className="mt12">
            <Button
              variant="prototype"
              className="btn btn-ghost btn-xs"
              onClick={() => setConfirmMerge(true)}
            >
              Slå ihop med befintlig tråd
            </Button>
          </div>
          <ConfirmDialog
            open={confirmMerge}
            onOpenChange={setConfirmMerge}
            title={`Slå ihop med "${mergeTarget.job}"?`}
            description="Meddelandena i den här tråden flyttas till den befintliga tråden och den här tråden tas bort."
            confirmLabel="Slå ihop"
            onConfirm={() => {
              setConfirmMerge(false);
              actions.mergeEmailThread(t.id, mergeTarget.id);
            }}
          />
        </div>
      )}
    </>
  );
}
