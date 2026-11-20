import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { disconnectEmail, getEmailConnection, startEmailConnect, type EmailConnection } from '@/lib/email-client';
import { Icon } from './icon';

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
  return <div className="card chcard">
    <div className="top"><span className="chi"><Icon name="mail" /></span><div className="grow"><h3>E-post</h3></div>
    {active && <span className="chip chip-sage"><span className="dot" />Ansluten</span>}
    {expired && <span className="chip chip-pink">Har gått ut</span>}
    {connection !== undefined && !active && !expired && <span className="chip chip-line">Inte ansluten</span>}</div>
    <p>estim läser bara mejl som skickats till den här adressen och svarar i samma mejltråd. Inget skickas utan att ni godkänner det.</p>
    {connection === undefined && <p className="mt8">Läser status…</p>}
    {active && <div className="row wrap small"><span className="chi sm"><Icon name="mail" /></span><span className="min-w-0 break-all">{connection.email}</span><span className="chip chip-line">{providerName}</span></div>}
    {expired && <p>Anslutningen har gått ut. Anslut igen.</p>}
    {isOwner && connection !== undefined && (active
      ? (confirming
        ? <div className="price-warn col gap-3" role="group" aria-label="Bekräfta frånkoppling"><p className="break-words">Koppla från {connection.email}? Nya mejl kommer inte längre in och svar kan inte skickas. Befintliga ärenden finns kvar.</p><div className="row wrap"><Button variant="prototype" className="btn btn-sm chip-pink border border-foreground" disabled={busy} onClick={disconnect}>Koppla från</Button><Button variant="prototype" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setConfirming(false)}>Avbryt</Button></div></div>
        : <div><Button variant="prototype" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setConfirming(true)}>Koppla från</Button></div>)
      : <div className="row wrap mt12"><Button variant="prototype" className="btn btn-ghost" disabled={busy} onClick={() => connect('google')}>Google</Button><Button variant="prototype" className="btn btn-ghost" disabled={busy} onClick={() => connect('microsoft')}>Microsoft 365</Button></div>)}
    {!isOwner && !active && connection !== undefined && <p className="muted small mt12">Be en ägare koppla e-post.</p>}
    {error && <p className="mt12" role="alert">{error}</p>}
  </div>;
}
