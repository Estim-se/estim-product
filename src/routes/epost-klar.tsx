import { useEffect, useRef, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { PrototypePageShell } from '@/components/estim/prototype-page-shell';
import { TopHeader } from '@/components/estim/top-header';
import { finishEmailConnect } from '@/lib/email-client';

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
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code'), state = params.get('state'), error = params.get('error');
    window.history.replaceState(null, '', window.location.pathname); // never leave the one-time code in the address bar or history
    if (error || !code || !state) { setMessage('Anslutningen avbröts. Försök igen från Kanaler.'); return; }
    finishEmailConnect(code, state)
      .then(result => { setMessage(`Klart! ${result.email} är ansluten.`); setTimeout(() => void navigate({ to: '/kanaler' }), 1500); })
      .catch(e => setMessage(e instanceof Error ? e.message : 'Något gick fel. Försök igen.'));
  }, [navigate]);

  return <><TopHeader title="E-post" subtitle="Ansluter din brevlåda." /><p className="mt24">{message}</p></>;
}
