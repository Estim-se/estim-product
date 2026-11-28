import { useState } from 'react';
import { useServerFn } from '@tanstack/react-start';
import { saveWhatsAppChannel } from '@/lib/channel.functions';
import { receiveMessageUrl } from '@/lib/channel-rules';
import { Button } from '@/components/ui/button';
import { TopHeader } from './top-header';
import { useWorkspace } from './workspace-provider';
import { EmailChannelCard } from './email-channel-card';
import { Icon } from './icon';

export function RealChannels() {
  const workspace = useWorkspace();
  const [number, setNumber] = useState(workspace.data?.channels?.find(c => c.type === 'wa')?.phone_number_id ?? '');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [endpoint, setEndpoint] = useState(receiveMessageUrl);
  const [advanced, setAdvanced] = useState(false);
  const save = useServerFn(saveWhatsAppChannel);
  const connected = Boolean(workspace.data?.whatsAppSendingConnected && workspace.data.channels?.some(c => c.type === 'wa' && c.phone_number_id));
  return <><TopHeader title={`Kanaler · ${workspace.data?.company?.name ?? ''}`} subtitle="Anslut de kanaler där du vill ha kontakt med dina kunder. Alla meddelanden samlas i samma inkorg." /><div className="grid2 fadein channels-grid"><EmailChannelCard isOwner={workspace.data?.role==='ägare'}/><section className="card chcard">
    <div className="top"><span className="chi"><Icon name="wa" /></span><div className="grow"><h3>WhatsApp</h3></div><span className={`chip ${connected ? 'chip-sage' : 'chip-line'}`}>{connected && <span className="dot" />}{connected ? 'Ansluten' : 'Inte ansluten'}</span></div>
    <p>Kundens WhatsApp-meddelanden samlas i inkorgen och svar skickas i samma chatt. Fria svar inom 24 timmar från kundens senaste meddelande.</p>
    <div className="row"><Button variant="prototype" className="btn btn-ghost" aria-expanded={advanced} aria-controls="whatsapp-advanced" onClick={() => setAdvanced(!advanced)}>Anslut WhatsApp</Button></div>
    {advanced && <div id="whatsapp-advanced" className="col settings-column small">
    <div className="col gap-2"><label className="field">Adress för inkommande meddelanden<input className="input" type="url" value={endpoint} onChange={e => setEndpoint(e.target.value)} /></label></div>
    <form onSubmit={async e => { e.preventDefault(); setBusy(true); setMessage('');
      try { await save({ data: { phone_number_id: number } }); await workspace.refresh(); setMessage('WhatsApp-numret är sparat.'); }
      catch (error) { setMessage(error instanceof Error ? error.message : 'Kunde inte spara WhatsApp-numret.'); } finally { setBusy(false); } }}>
      <label className="field">WhatsApp-ID<input className="input" inputMode="numeric" pattern="[0-9]{1,100}" required maxLength={100} value={number} onChange={e => setNumber(e.target.value)} /></label>
      <p className="mt8">Ditt WhatsApp-ID hittar du i Meta Business. Det är inte ett telefonnummer.</p>
      <div className="row wrap mt12"><Button variant="prototype" className="btn btn-ghost" type="submit" disabled={busy}>{busy ? 'Sparar…' : 'Spara'}</Button><Button variant="prototype" className="btn btn-ghost" type="button" onClick={() => setAdvanced(false)}>Stäng</Button></div>
    </form></div>}{message && <p className="mt12" role="status">{message}</p>}
  </section></div></>;
}