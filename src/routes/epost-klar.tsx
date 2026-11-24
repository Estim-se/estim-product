import { useEffect, useRef, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { PrototypePageShell } from '@/components/estim/prototype-page-shell';
import { TopHeader } from '@/components/estim/top-header';
import { finishEmailConnect, readConnectReturn } from '@/lib/email-client';

// Landing page after the mailbox login at Google/Microsoft. A top-level path on purpose: /kanaler has no <Outlet/>,
// so a child route under it would never render.
export const Route = createFileRoute('/epost-klar')({
  head: () => ({ meta: [
    { title: 'estim · Anslut e-post' },
    { name: 'description', content: 'Slutför anslutningen av din brevlåda till estim.' },
    { property: 'og:title', content: 'estim · Anslut e-post' },
    { property: 'og:description', content: 'Slutför anslutningen av din brevlåda till estim.' },
    { property: 'og:type', content: 'website' },
    { name: 'twitter:card', content: 'summary_large_image' },
  ] }),
  component: () => <PrototypePageShell><EmailDone /></PrototypePageShell>,
});

function EmailDone() {
  const navigate = useNavigate();
  const [message, setMessage] = useState('Kopplar din brevlåda…');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // React strict mode runs effects twice; the code is single-use
    started.current = true;
    const back = readConnectReturn(window.location.search);
    window.history.replaceState(null, '', window.location.pathname); // never leave the one-time code in the address bar or history
    if (back.kind === 'error') { setMessage('Anslutningen avbröts. Försök igen från Kanaler.'); return; }
    let alive = true;
    const done = (email: string) => { setMessage(`Klart! ${email} är ansluten.`); setTimeout(() => void navigate({ to: '/kanaler' }), 1500); };
    const fail = (e: unknown) => { if (alive) setMessage(e instanceof Error ? e.message : 'Något gick fel. Försök igen.'); };
    if (back.kind === 'nylas') {
      finishEmailConnect(back.state, back.code).then(r => { if ('email' in r) done(r.email); }).catch(fail);
      return () => { alive = false; };
    }
    // Unipile confirms the account to our server on its own; ask until it has (about a minute at most).
    const deadline = Date.now() + 60_000;
    const poll = (): void => {
      finishEmailConnect(back.state).then(r => {
        if (!alive) return;
        if ('email' in r) { done(r.email); return; }
        if (Date.now() > deadline) { setMessage('Anslutningen tar längre tid än vanligt. Titta på Kanaler om en stund.'); return; }
        setTimeout(poll, 2000);
      }).catch(fail);
    };
    poll();
    return () => { alive = false; };
  }, [navigate]);

  return <><TopHeader title="E-post" subtitle="Ansluter din brevlåda." /><p className="mt24">{message}</p></>;
}
