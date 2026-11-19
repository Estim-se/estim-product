import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { disconnectEmail, getEmailConnection, startEmailConnect, type EmailConnection } from '@/lib/email-client';

// Real-mode card on the Kanaler page: connect, see status, disconnect the company mailbox.
export function EmailChannelCard({ isOwner }: { isOwner: boolean }) {
  const [connection, setConnection] = useState<EmailConnection | undefined>(undefined); // undefined = loading
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let alive = true;
    getEmailConnection().then(c => { if (alive) setConnection(c); }).catch(() => { if (alive) { setConnection(null); setError('Kunde inte läsa e-poststatus.'); } });
    return () => { alive = false; };
  }, []);

  async function connect(provider?: 'google' | 'microsoft') {
    setBusy(true); setError('');
    try { const { url } = await startEmailConnect(provider); window.location.assign(url); }
    catch (e) { setError(e instanceof Error ? e.message : 'Något gick fel. Försök igen.'); setBusy(false); }
  }
  async function disconnect() {
    setBusy(true); setError('');
    try { await disconnectEmail(); setConnection(null); setConfirming(false); }
    catch (e) { setError(e instanceof Error ? e.message : 'Något gick fel. Försök igen.'); }
    finally { setBusy(false); }
  }

  const active = connection?.status === 'active', expired = connection?.status === 'expired';
  const providerName = connection?.provider === 'google' ? 'Google' : connection?.provider === 'imap' ? 'Annan e-postleverantör' : 'Microsoft 365';
  return <div className="mt24">
    <h2>E-post</h2>
    <p className="muted small mt8">estim läser bara mejl som skickats till den här adressen och svarar i samma mejltråd. Inget skickas utan att ni godkänner det.</p>
    {connection === undefined && <p className="mt8">Läser status…</p>}
    {active && <><p className="mt8">Ansluten: {connection.email} · {providerName}</p><span className="chip chip-line mt12">Ansluten</span></>}
    {expired && <><p className="mt8">Anslutningen har gått ut. Anslut igen.</p><span className="chip chip-line mt12">Har gått ut</span></>}
    {connection !== undefined && !active && !expired && <span className="chip chip-line mt12">Inte ansluten</span>}
    {isOwner && connection !== undefined && (active
      ? (confirming
        ? <p className="mt12">Koppla från {connection.email}? <Button variant="prototype" disabled={busy} onClick={disconnect}>Ja, koppla från</Button> <Button variant="prototype" disabled={busy} onClick={() => setConfirming(false)}>Avbryt</Button></p>
        : <p className="mt12"><Button variant="prototype" disabled={busy} onClick={() => setConfirming(true)}>Koppla från</Button></p>)
      : <p className="mt12"><Button variant="prototype" disabled={busy} onClick={() => connect()}>Anslut e-post (alla leverantörer)</Button> <Button variant="prototype" disabled={busy} onClick={() => connect('google')}>Google</Button> <Button variant="prototype" disabled={busy} onClick={() => connect('microsoft')}>Microsoft 365</Button></p>)}
    {!isOwner && !active && connection !== undefined && <p className="muted small mt12">Be en ägare koppla e-post.</p>}
    {error && <p className="mt12" role="alert">{error}</p>}
  </div>;
}
